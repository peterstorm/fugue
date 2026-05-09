# ADR 0008: Event-log envelope with `recordedAtMs`; entry IDs pinned to envelope time

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** FR-048 (event log), SC-004 (replay equivalence), AD-3 (Redis Streams)
**Related:** ADR 0003 (Redis Streams as event log substrate — superseded in part by this ADR for the timestamp-source decision; stream/key/MAXLEN choices remain authoritative)
**Plan:** `docs/plans/2026-05-09-event-timestamps-and-replay-to-timestamp.md`

## Context

The framework's event log is the audit trail and replay substrate (FR-048, SC-004). Each call to `JobLike.appendEvent(event)` writes one entry to the per-job stream. Until this ADR, events themselves carried no time information:

- The `DagEvent` discriminated union has no `timestamp` field on any variant. Events are pure domain payloads.
- The BullMQ `appendEvent` wrote `XADD events:{queueName}:{jobId} MAXLEN ~ N * type <type> payload <json>`. The `*` told Redis to assign a server-side stream entry ID of the form `{ms}-{seq}` — the only timestamp anywhere in the pipeline.
- `EventLogReader.readEvents` discarded entry IDs and returned `readonly unknown[]` — by the time a caller saw the events, every per-event timestamp had been thrown away.
- The in-memory `JobLike` (`state-machine/in-memory-job.ts`) stored events as a plain `unknown[]` — no entry ID exists at all. There was no fallback timestamp source for non-Redis backends.

Three concrete consequences pushed us to revisit:

1. **Replay-to-timestamp was impossible.** A request like "what was the state at `2026-05-08T14:30:00Z`?" could not be answered through the public API. `replayEvents` accepts any prefix of an event list, but with no per-event timestamp surfaced, there was nothing to slice on.
2. **Time-of-recording was transport-coupled.** The Redis Stream entry ID was the only timestamp anywhere in the pipeline, contradicting FR-082's intent that adapters be swappable. A future Postgres-outbox or Kafka backend would not have that ID format and could not provide the same affordance.
3. **Event-log dumps were time-blind.** `await reader.readEvents(...)` then `JSON.stringify(events)` produced a blob with no temporal information, even though the audit trail is the canonical record.

The previous design was a corner-cutting hack: "the stream entry ID *is* the timestamp." That worked exactly as long as the storage backend always provided server-assigned ms-prefixed IDs — exactly one backend (Redis Streams). It was not the idiomatic event-sourcing pattern.

## Options Considered

1. **Preserve stream entry IDs through the reader** (the cheap fix). Change `EventLogReader.readEvents` to return `Array<{ id, event }>`; parse the ms from `id` for forensic queries.
   - Pros: zero schema change to events; backward compatible with existing streams.
   - Cons: ID format is Redis-Streams-specific (`1715200000000-0`). For other backends (in-memory, Postgres) we would have to *fake* an ID, which is semantically wrong — the entry ID belongs to the *transport*, not the event. Doesn't fix the in-memory case (no IDs to preserve).

2. **Add an `XRANGE`-with-bounds reader variant** (`readEventsBetween`).
   - Pros: pushes filtering server-side; cheap on Redis.
   - Cons: still backend-specific; doesn't help in-memory replays; only solves *server-side filtering*, not the underlying "events have no timestamp" problem.

3. **Wrap events in an envelope at the `appendEvent` boundary** (the idiomatic answer). Define `RecordedEvent<E> = { recordedAtMs, event }`. The `JobLike.appendEvent` implementation captures `now()` and persists the envelope. The reader returns envelopes. The domain `event` is unchanged; `transition` keeps consuming raw events.
   - Pros: transport-independent — the same envelope contract works for Redis Streams, in-memory, Postgres, Kafka, any future backend. Forensic timestamps survive any serialization or transport. Domain types stay clean. Idiomatic event-sourcing.
   - Cons: ~30B per event of JSON overhead. Breaking change to the read-side contract (callers that previously expected `unknown[]` get `RecordedEvent<unknown>[]`). Existing production streams don't have envelopes — need a graceful read path.

We adopt **option 3**, with **option 2 layered on top of it** (server-side filtering uses entry-ID bounds because we *also* pin the entry ID to `recordedAtMs` — see Decision below).

Option 1 is rejected: it solves Redis but doesn't solve the in-memory case or future backends, and conflates transport metadata with audit metadata. Option 2 alone is rejected for the same reason — pushing filtering server-side is useful but doesn't address the underlying "events have no timestamp" problem.

## Decision

**Three changes, atomic in spirit, rolled out in three PRs:**

### 1. Envelope at write time

A new type wraps every event committed to the log:

```ts
interface RecordedEvent<E> {
  readonly recordedAtMs: number; // ms since epoch when appendEvent ran
  readonly event: E;             // raw DagEvent (or whatever domain event)
}
```

Captured by every `JobLike.appendEvent` implementation:

- `adaptBullMQJob.appendEvent` calls `now()` (default `Date.now`, injectable for tests via `EventLogOpts.now`), constructs the envelope, `serializeValue` + `JSON.stringify` the envelope into the `payload` field of the `XADD`.
- `createInMemoryJob.appendEvent` does the same, pushing envelopes onto its `events` array.

The runner (`runStateMachine`) is unchanged — it still calls `job.appendEvent(rawEvent)`. The runner does not see envelopes; the boundary is sealed inside the `JobLike` adapter.

### 2. Entry IDs pinned to `recordedAtMs`

The BullMQ writer changes from `XADD … * type <type> payload <json>` to:

```
XADD events:{queueName}:{jobId} MAXLEN ~ N ${recordedAtMs}-* type <type> payload <json>
```

Redis accepts `{ms}-*` as an XADD ID: pin the millisecond portion explicitly, let Redis auto-assign the seq portion (`-0`, `-1`, …) on collision.

This makes the Redis stream entry ID and the envelope's `recordedAtMs` agree by construction. So `XRANGE events:{queueName}:{jobId} ${fromMs}-0 ${toMs - 1}-<MAX_SEQ>` filters by `recordedAtMs` exactly, server-side, in O(log N + matches). The new `EventLogReader.readEventsBetween(queueName, jobId, fromMs, toMs)` exposes this as a typed API.

Monotonic-non-decreasing constraint: each new XADD must produce an ID strictly greater than the previous. `Date.now()` satisfies this in practice (NTP keeps the wall clock from going backwards under normal operation). If a caller injects a `now()` that goes backwards, Redis rejects the XADD with an error; we surface that as the existing `appendEvent` failure path.

### 3. Reader returns envelopes; legacy fallback for pre-envelope entries

`EventLogReader.readEvents` returns `readonly RecordedEvent<unknown>[]`. The reader checks for the envelope shape on every entry; if the payload is a bare event (pre-envelope production data), it synthesizes an envelope with `recordedAtMs` parsed from the Redis Stream entry ID's millisecond prefix.

So:

- **New events** round-trip exactly: `recordedAtMs` written into the envelope, written into the entry ID, read back from the envelope.
- **Pre-existing events in production streams** stay readable: detected as bare payloads, given a synthesized envelope using the (server-assigned) entry-ID timestamp.
- **Mixed streams** (a job that ran across the rollout) read cleanly — each entry is detected independently.

No backfill of historical streams is required.

### 4. Replay helpers

Two new pure helpers in `state-machine/replay.ts`:

```ts
replayEventsUntil(events, machine, initial, untilMs)
// Folds only events with `recordedAtMs < untilMs`. Half-open semantic.

replayEventsBetween(events, machine, initial, fromMs, toMs)
// Folds only events whose `recordedAtMs` is in [fromMs, toMs), starting from `initial`.
// NOT a fast-forward from a checkpoint at fromMs — caller is responsible for
// supplying the right `initial` if they want chained windows.
```

Both validate `RangeError` on non-finite or inverted bounds. The existing `replayEvents` overload is widened to accept `RecordedEvent<unknown>[]` so reader output flows through directly without ceremony — same pattern as `JSON.parse → cast → use`. The pure transition function still consumes raw events; the helper unwraps envelopes internally.

## Consequences

**Positive:**

- **Replay-to-timestamp works.** Forensic queries ("what was the state at noon?") become a one-line call: `replayEventsUntil(events, machine, initial, noonMs)`. Server-side filtered variant: `reader.readEventsBetween(queueName, jobId, 0, noonMs)`.
- **Transport-independent timestamps.** A Postgres outbox or Kafka backend implements the same `JobLike.appendEvent` envelope wrap; the reader returns the same `RecordedEvent<unknown>[]` shape. No backend-specific assumptions leak into the replay path.
- **Time-traceable audit dumps.** `JSON.stringify(await reader.readEvents(...))` now produces a blob that includes per-event timestamps. Forensic exports survive transport and persistence.
- **Server-side filtering scales.** For long event streams, `XRANGE` with ms-bounded entry IDs filters in O(log N + matches) instead of transferring the whole log. Important for admin endpoints scanning many jobs.
- **SC-004 unaffected.** The envelope is metadata; `transition` still consumes raw events. Replay equivalence (recorded-events fold == live envelope) holds because the runner persists the state envelope and the event log redundantly — both are derived from the same transitions.
- **No backfill needed.** Legacy streams remain readable via the bare-payload fallback path. Rollout is safe across an in-flight production deploy.

**Negative:**

- **Payload size grows ~30B per event.** Envelope JSON wrapper. For a stream at the `MAXLEN ~ 10000` cap, that's ~300KB per stream. Acceptable; trimming is unaffected.
- **Breaking read-side type contract.** `EventLogReader.readEvents` returns `RecordedEvent<unknown>[]` instead of `unknown[]`. Migration is mechanical — internal callers updated in the same PR. No deprecation cycle (consumer count is small and internal).
- **Monotonicity discipline on `now()`.** If an injected `now()` goes backwards, Redis rejects the `XADD`. This is correct (entry IDs must be strictly increasing), but it means tests that inject controlled clocks must be careful to tick forward only. Documented in the writer's comments.
- **Clock skew across worker hops.** A job that runs on worker A and resumes on worker B will have events whose `recordedAtMs` reflect each machine's clock. NTP keeps this within milliseconds in practice, but timestamps in the same job are not strictly monotonic across hops. Acceptable: strict monotonicity is what the entry-ID seq portion is for; `recordedAtMs` is for human-readable forensic queries, not coordination.
- **Carrying the legacy fallback indefinitely.** As long as any pre-envelope stream might exist in production, the reader needs the bare-payload detection branch. If we ever migrate every stream (or set a hard EOL on retention), we can simplify the reader. Until then it's load-bearing.

## Alternatives considered

1. **Preserve entry IDs through the reader (option 1 above).** Rejected for the in-memory and cross-backend case, and for conflating transport metadata with audit metadata. The envelope is a strict superset of this affordance.

2. **Server-side filter only, no envelope (option 2 alone).** Rejected — solves filtering but not the underlying "events have no timestamp" problem. The envelope was needed regardless; once we have it, server-side filtering is a free additional win.

3. **Embed `recordedAtMs` directly on every `DagEvent` variant.** Rejected. Pollutes the domain types with metadata that isn't part of the domain. The whole point of the envelope is to keep the layers separated: `transition` is pure over domain events; the log layer adds time metadata at the boundary.

4. **Use the existing `TraceEvent.timestamp` for forensic time.** Rejected. `TraceEvent` is the *observation* surface (post-transition observer notification); the *event log* is the *recording* surface (durable XADD). They serve different purposes — observer events can be dropped, recorded events cannot. Conflating them would entangle observability with durability.

5. **Add a `correlationId` / `workerId` to the envelope now.** Deferred. The envelope is forward-compatible (the reader's shape check ignores unknown fields), so we can extend it later without breaking the read path. v1 ships timestamp-only because that's what the immediate gap demands; further metadata can be added per use case.

## Implementation references

- `packages/framework/src/state-machine/types.ts` — `RecordedEvent<E>` definition.
- `packages/framework/src/state-machine/in-memory-job.ts` — in-memory writer; envelope wrap on `appendEvent`; `now` injection.
- `packages/framework/src/queue-bullmq/job.ts` — BullMQ writer; envelope wrap; entry-ID pinning to `recordedAtMs`; `now` injection via `EventLogOpts.now`.
- `packages/framework/src/queue-bullmq/event-log.ts` — `EventLogReader.readEvents` returns envelopes; `readEventsBetween` for server-side filtering; legacy bare-payload fallback path.
- `packages/framework/src/state-machine/replay.ts` — `replayEvents` widened to accept envelopes; `replayEventsUntil` and `replayEventsBetween` helpers.
- `packages/framework/src/__tests__/state-machine-replay.test.ts` — unit + property tests.
- `packages/framework/src/queue-bullmq/__tests__/queue-bullmq-adapter.test.ts` — Redis-backed integration tests including the "Forensic replay-to-timestamp" suite.
