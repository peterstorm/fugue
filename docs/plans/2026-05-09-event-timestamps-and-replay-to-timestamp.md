---

# Plan: Timestamped Events & Wall-Clock-Bounded Replay

**Created:** 2026-05-09
**Status:** Draft
**Goal:** Make the framework's event log idiomatically event-sourced — every event carries a recording timestamp at the protocol level, transport-independent — and use that to enable replay-to-timestamp for forensic queries, debugging, and time-bounded SC-004 verification.

**Touches:**
- `packages/framework/src/state-machine/runner.ts` (`JobLike` interface)
- `packages/framework/src/state-machine/in-memory-job.ts` (in-memory writer)
- `packages/framework/src/state-machine/replay.ts` (fold + new helpers)
- `packages/framework/src/queue-bullmq/job.ts` (BullMQ writer)
- `packages/framework/src/queue-bullmq/event-log.ts` (BullMQ reader)
- `docs/library-ux.md` §4 "What replay actually does", §5.2 "Per-job event log"
- `docs/adr/0003-event-sourcing-redis-streams.md` (clarification + new constraint)
- New ADR: `docs/adr/000X-event-envelope-and-time.md`

---

## Problem

The event log is the system's audit trail (FR-048, ADR-3) and the substrate for replay-equivalence (SC-004). But events themselves carry no time information:

- The `DagEvent` discriminated union has no `timestamp` field on any variant. Events are pure domain payloads.
- `appendEvent(event)` writes only `type` and `payload` fields to the Redis Stream; the millisecond timestamp lives in the server-assigned stream entry ID (`1715200000000-<seq>`), but `EventLogReader.readEvents` discards entry IDs and returns `readonly unknown[]`.
- The in-memory `JobLike` (`state-machine/in-memory-job.ts`) stores events as a plain `unknown[]` array — no entry ID exists at all; there is no fallback timestamp source.

Consequences:

1. **Replay-to-timestamp is impossible.** A request like "what was the state at `2026-05-08T14:30:00Z`" cannot be answered through the public API. `replayEvents` accepts any prefix of the event list, but you have no per-event time information to slice on.
2. **Time-of-recording is transport-coupled.** The Redis Streams entry ID is the only timestamp anywhere in the pipeline, so any backend swap (Postgres outbox, Kafka topic, in-memory) loses it. This contradicts FR-082's intent that adapters be swappable.
3. **Event-log dumps are time-blind.** `await reader.readEvents(...)` then `JSON.stringify(events)` produces a blob with no temporal information, even though the audit trail is the canonical record.
4. **Forensic debugging is awkward.** Today the only way to answer "when did this transition happen?" is to `XRANGE` the raw stream and parse entry IDs by hand — bypassing the framework's reader entirely.

The current design is a corner-cutting hack: "the stream entry ID is the timestamp." That works exactly as long as the storage backend always provides server-assigned timestamped IDs, which is exactly one backend (Redis Streams). It is not the idiomatic event-sourcing pattern.

---

## Non-Goals

- **Causal ordering / vector clocks.** A monotonic millisecond timestamp per event is enough. Multi-writer causal ordering is a future concern (we have one writer per job: the worker holding the BullMQ lease).
- **Sub-millisecond precision.** `Date.now()` resolution is fine. If we ever need ordering for events recorded in the same millisecond, the existing per-stream sequence (`-0`, `-1`) on the Redis side already handles it; we only need it for human-readable replay-to-time queries which are millisecond-coarse anyway.
- **Replaying side effects.** Replay reconstructs machine state, not external effects. Time-bounded replay does not "rewind" emails, charges, etc. (Already documented in §4 "What replay can't do.")
- **Backfilling timestamps for streams older than this change.** The fallback (read entry-ID timestamp on the BullMQ side) makes existing streams *readable* with timestamps; we don't rewrite history.
- **Cross-machine-version replay.** Still out of scope. Adding event versioning is a separate plan.

---

## Idiomatic answer: events get an envelope

In every well-formed event-sourcing system, events are persisted with metadata: timestamp, sequence number, correlation IDs. Domain payloads (the "what happened") are wrapped in an envelope (the "when, where, by whom").

We adopt the simplest version of this:

```ts
// New type in state-machine/types.ts
export interface RecordedEvent<E> {
  /** ms-since-epoch when the event was appended to the durable log. */
  readonly recordedAtMs: number;
  /** The domain event itself — unchanged. */
  readonly event: E;
}
```

Properties:

- `recordedAtMs` is captured by the `JobLike` implementation at `appendEvent` time, *before* any transport write. So it's transport-independent — the same field works for Redis Streams, in-memory arrays, Postgres, Kafka, anything.
- The domain `event` is unchanged. We do not pollute `DagEvent` variants with timestamp fields. The envelope is the protocol-level wrapper; `transition` keeps consuming raw events.
- `RecordedEvent` is generic over the event type, so the user's machine can be any `Machine<S, E, C>`.

### Where the timestamp comes from

`appendEvent` stamps `Date.now()` at call time. Rationale:

- It's the closest moment we have to "the event happened" — the runner has just computed the transition and is about to durably persist it.
- It's monotonic-ish in practice (NTP-corrected machine clock); good enough for forensic queries and dashboards. We are not building a coordination primitive.
- For deterministic tests, the writer accepts an optional `now: () => number` injection. Default is `Date.now`.

We do NOT take the timestamp from the executor (where the side effect actually happened). The executor returns events that may be batched or delayed by the runner; making `appendEvent` the timestamp authority gives us a single, well-defined "this is when the log accepted the event" semantic.

---

## Concrete API changes

### 1. `JobLike.appendEvent` — unchanged signature, new contract

```ts
// state-machine/runner.ts (or wherever JobLike lives)
interface JobLike<S, E, C> {
  // ... existing methods ...
  appendEvent(event: E): Promise<void>;
}
```

The signature is unchanged — callers (the runner) still pass raw events. The implementation is what changes: every adapter wraps the event in a `RecordedEvent<E>` with `recordedAtMs: now()` before persisting.

### 2. `EventLogReader.readEvents` — return envelopes

```ts
// queue-bullmq/event-log.ts
export interface EventLogReader {
  readEvents(queueName: string, jobId: string): Promise<readonly RecordedEvent<unknown>[]>;
}
```

Breaking change to the return type. Callers that currently expect `readonly unknown[]` get `readonly RecordedEvent<unknown>[]` and must access `.event` to get the domain payload. There are very few such callers (replay, tests, the planned debugging UI) so the migration is mechanical.

### 3. New reader method for server-side time filtering (BullMQ only)

```ts
export interface EventLogReader {
  readEvents(queueName: string, jobId: string): Promise<readonly RecordedEvent<unknown>[]>;
  /**
   * Read only events recorded in the half-open interval [fromMs, toMs).
   * Backends that can push the filter down (Redis: XRANGE with ms-prefixed IDs)
   * should do so. In-memory backends can filter post-fetch.
   */
  readEventsBetween(
    queueName: string,
    jobId: string,
    fromMs: number,
    toMs: number,
  ): Promise<readonly RecordedEvent<unknown>[]>;
}
```

`createRedisStreamReader` implements this with `XRANGE key ${fromMs}-0 ${toMs}-0` — Redis stream entry IDs are ms-prefixed, so we get O(log N + matches) seek. The in-memory reader filters its `events` array.

### 4. New `replayEvents` overload + helpers

```ts
// state-machine/replay.ts

/**
 * Existing fold — accepts envelopes OR raw events, for backward compat
 * during migration. Internally strips envelopes if present.
 */
export const replayEvents: {
  <S, E, C>(events: readonly RecordedEvent<E>[], machine: Machine<S, E, C>, initial: { state: S; context: C }): { state: S; context: C };
  <S, E, C>(events: readonly E[], machine: Machine<S, E, C>, initial: { state: S; context: C }): { state: S; context: C };
};

/**
 * Replay only events recorded strictly before `untilMs`. Returns the
 * machine state as of that wall-clock time.
 */
export const replayEventsUntil = <S, E, C>(
  events: readonly RecordedEvent<E>[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
  untilMs: number,
): { state: S; context: C };

/**
 * Replay events in the half-open interval [fromMs, toMs). Useful for
 * "what changed between two points in time?" — caller folds twice and
 * diffs the results.
 */
export const replayEventsBetween = <S, E, C>(
  events: readonly RecordedEvent<E>[],
  machine: Machine<S, E, C>,
  initial: { state: S; context: C },
  fromMs: number,
  toMs: number,
): { state: S; context: C };
```

`replayEventsUntil` can be implemented as `events.filter(e => e.recordedAtMs < untilMs)` then `replayEvents(...)`. We keep it as a named export because the use case is common enough to deserve a name and because it pairs naturally with the new reader method.

---

## Adapter implementations

### BullMQ writer (`queue-bullmq/job.ts`)

```ts
async appendEvent(event: unknown): Promise<void> {
  const recordedAtMs = now(); // injected for testability
  const envelope: RecordedEvent<unknown> = { recordedAtMs, event };
  const type = typeof (event as any)?.type === "string" ? (event as any).type : "event";
  const payload = JSON.stringify(serializeValue(envelope));
  await redis.xadd(streamKey, "MAXLEN", "~", maxLen, "*", "type", type, "payload", payload);
}
```

Single change: wrap in envelope before serializing. Stream-level fields (`type`, `payload`) stay the same. The envelope rides inside `payload`.

### BullMQ reader (`queue-bullmq/event-log.ts`)

```ts
async readEvents(queueName, jobId): Promise<readonly RecordedEvent<unknown>[]> {
  const entries = await redis.xrange(key, "-", "+");
  return entries.map(([entryId, fields]) => parseEnvelope(entryId, fields));
}

async readEventsBetween(queueName, jobId, fromMs, toMs) {
  // XRANGE entry IDs are `${ms}-${seq}`; bounds are inclusive at the protocol level,
  // so we use [fromMs-0, (toMs-1)-MAX] for a half-open semantic.
  const entries = await redis.xrange(key, `${fromMs}-0`, `${toMs - 1}-+`);
  return entries.map(parseEnvelope);
}

function parseEnvelope(entryId: string, fields: string[]): RecordedEvent<unknown> {
  const raw = JSON.parse(fields[fields.indexOf("payload") + 1]);
  const restored = deserializeValue(raw);
  // Forward-compatible: new events are envelopes; old events are bare payloads.
  if (restored && typeof restored === "object" && "recordedAtMs" in restored && "event" in restored) {
    return restored as RecordedEvent<unknown>;
  }
  // Legacy fallback: derive timestamp from stream entry ID.
  const recordedAtMs = parseInt(entryId.split("-")[0], 10);
  return { recordedAtMs, event: restored };
}
```

The fallback path makes existing production streams readable with timestamps without backfill.

### In-memory writer (`state-machine/in-memory-job.ts`)

```ts
class InMemoryJob<S, E, C> {
  readonly events: RecordedEvent<E>[] = [];
  // ...
  async appendEvent(event: E): Promise<void> {
    this.events.push({ recordedAtMs: this.now(), event });
  }
}
```

Tests that previously asserted on `job.events[i]` need to access `job.events[i].event`. Mechanical migration.

### In-memory reader

If we choose to expose an `EventLogReader` for in-memory jobs (currently we don't — tests read `.events` directly), we add one that implements both methods and filters in-process. Optional for v1.

---

## Migration / backward compat

### Existing Redis streams

The reader's `parseEnvelope` checks for the envelope shape and falls back to entry-ID timestamps for old payloads. So:

- A stream written before this change can be read after the change. Each old event gets a synthesized `RecordedEvent` with `recordedAtMs` derived from its stream entry ID.
- A stream that is partly old and partly new (a job that was running across the deploy) reads cleanly — the reader handles each event independently.
- We do not rewrite or migrate any existing stream data.

### Existing in-memory event arrays

In-memory events have no fallback (no entry ID). All in-memory jobs created after this change use the new envelope. Tests that hold references to pre-change `events: unknown[]` arrays simply won't compile — caught at type-check.

### Caller migration

Two callers of `EventLogReader.readEvents` exist today:

1. The replay path in tests and SC-004 verification → update to access `.event` on each item, or use the new `replayEvents` overload that accepts envelopes directly.
2. Any debugging tooling that reads the stream → update to use `.event` and `.recordedAtMs`.

We do this in a single PR, type-checked in CI. No deprecation cycle needed because the consumer count is small and internal.

---

## Tests

### Unit tests

- `replayEventsUntil` returns the same state as `replayEvents(events.slice(0, k))` when `events[k]` is the first event with `recordedAtMs >= untilMs`.
- `replayEventsBetween(fromMs, toMs)` is equivalent to chaining `replayEventsUntil(toMs)` after `replayEventsUntil(fromMs)`, given the same initial state.
- BullMQ reader: writes against a real Redis (testcontainers), reads back, asserts `recordedAtMs` matches the controlled `now()` injection within ±1ms.
- BullMQ reader, legacy fallback: write a "bare payload" entry (mimicking pre-change format) and assert reader produces an envelope with `recordedAtMs` from the entry ID.
- In-memory: append events with controlled `now()` injection (e.g. `() => 1000, () => 2000, ...`), assert `events[i].recordedAtMs` matches.

### Property tests (`fast-check` / `jqwik`-equivalent for TS)

- For any sequence of events appended with monotonically non-decreasing `now()`, the recorded `recordedAtMs` values are non-decreasing.
- For any `untilMs`, `replayEventsUntil(events, machine, initial, untilMs)` is deterministic — running it twice yields identical state.

### SC-004 update

The replay-equivalence check now uses envelopes. Specifically: append events through a real run, capture both the event log and the final envelope, then `replayEvents(eventLog.map(e => e.event), machine, initialFromCheckpoint)` must yield the same `{state, context}` as the live envelope. The new envelope wrapper does not change the equivalence guarantee — `recordedAtMs` is metadata, not state.

### Integration test: forensic query

A new test in `__tests__/state-machine-replay.test.ts`:

1. Run a 4-wave DAG to completion.
2. Record `t1` after wave 1, `t2` after wave 2.
3. `replayEventsUntil(events, machine, initial, t1)` → state is `running { wave: 1 }` with wave-0 outputs only.
4. `replayEventsUntil(events, machine, initial, t2)` → state is `running { wave: 2 }` with waves 0–1 outputs.
5. `replayEventsBetween(events, machine, initial, t1, t2)` starts from `pending` initial and replays only wave-1 transitions → ends at `running { wave: 2 }` with only wave-1's outputs in `context.outputs` (illustrating what "between" actually means: a *slice* of the history, not a *fast-forward from a checkpoint*).

(That last assertion is a documentation-by-test for an easy-to-misuse helper.)

---

## Documentation updates

### `docs/library-ux.md`

- §4 "What replay actually does" — update the worked replay table to show `recordedAtMs` per event, and replace the "Replay-to-cursor" bullet with "Replay-to-cursor or replay-to-timestamp."
- §4 "What replay can't do today" — remove the "Wall-clock-bounded replay" gap (now solved); leave "Cross-machine-version replay" as the remaining gap.
- §5.2 "Per-job event log" — replace the "no explicit timestamp" subsection with the new envelope contract; keep the note that Redis stream entry IDs still carry time but explain we now also persist it transport-independently.
- §5.2 add a new subsection "Time-bounded reads" documenting `readEventsBetween`.

### New ADR `docs/adr/000X-event-envelope-and-time.md`

- **Context:** Why the prior design (entry-ID-as-timestamp) was insufficient.
- **Decision:** Adopt `RecordedEvent<E>` envelope; timestamp at `appendEvent` write boundary; backward compat via reader fallback.
- **Consequences:** Slight payload-size increase (~30 bytes per event for the JSON envelope wrapper); new public types; legacy streams remain readable.

### Update ADR-3 `docs/adr/0003-event-sourcing-redis-streams.md`

- Add a "Superseded in part by ADR 000X" header note pointing to the new ADR for the timestamp-source decision; keep the rest of ADR-3 (stream choice, MAXLEN, key shape) authoritative.

---

## Rollout order

1. **PR 1: Types + in-memory** — add `RecordedEvent<E>`, update `InMemoryJob` to wrap events, update tests that read `.events` to use `.event`. No Redis changes yet, fully unit-testable.
2. **PR 2: BullMQ writer + reader + fallback** — wrap on `appendEvent`, parse envelopes (with legacy fallback) on `readEvents`, add `readEventsBetween`. Integration test against testcontainers Redis.
3. **PR 3: Replay helpers + SC-004 update** — `replayEventsUntil`, `replayEventsBetween`, the integration forensic-query test. Update SC-004 checker to use envelopes.
4. **PR 4: Docs + ADRs** — update `library-ux.md`, write the new ADR, amend ADR-3.

Each PR is independently mergeable and shipping-quality.

---

## Risks and open questions

### Risks

- **Payload size.** Envelope adds ~30 bytes JSON overhead per event (`{"recordedAtMs":1715200000000,"event":...}`). For a job with 10k events at the `MAXLEN ~ 10000` cap, that's ~300KB extra per stream. Acceptable.
- **Legacy fallback latent bugs.** A future change to the envelope schema (e.g. add `correlationId`) needs to keep the fallback working. The `parseEnvelope` shape check is a single point of vigilance; documenting the invariant in the ADR mitigates this.
- **Clock skew across worker machines.** A job that runs on worker A then resumes on worker B has events whose `recordedAtMs` reflect each machine's clock. NTP keeps this within milliseconds in practice, but timestamps in the same job are not strictly monotonic across hops. We accept this — strictly monotonic ordering is what the stream entry ID sequence is for; `recordedAtMs` is for human-readable forensic queries.

### Open questions

- **Should `RecordedEvent` carry more than just timestamp?** Reasonable additions: `workerId` (which process recorded it), `attemptsMade` (BullMQ retry count at time of recording), `correlationId` (linking to OTel span). v1 ships with timestamp-only; the envelope shape is forward-compatible (new fields can be added; the fallback parser ignores unknown fields).
- **Should we expose an `EventLogReader` for in-memory jobs?** Currently tests reach into `job.events` directly. Adding an in-memory reader makes the read path uniform across backends, which is nicer for shared test helpers. Probably yes, in a follow-up PR.
- **Naming.** `RecordedEvent` vs. `EventEnvelope` vs. `LoggedEvent`. The first emphasizes "this was committed to the log"; the second is more generic. Author preference: `RecordedEvent` because it pairs naturally with `recordedAtMs`.
