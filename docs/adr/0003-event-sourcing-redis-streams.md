# ADR 0003: Event sourcing via Redis Streams; opaque event-log handle

**Status:** Accepted (timestamp-source decision superseded by ADR 0008)
**Date:** 2026-05-09
**Spec ref:** OQ-1, FR-048, SC-003, SC-004 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0001 (boundary lint / single-package layout), ADR 0006 (`JobLike` shape), **ADR 0008** (event envelope + `recordedAtMs`; entry-ID pinning for time-bounded replay).

> **Amendment (ADR 0008):** the original design relied on the Redis Stream entry ID (`{ms}-{seq}` assigned by `XADD *`) as the implicit timestamp source. The reader discarded those IDs and the in-memory backend had no equivalent, so per-event timestamps were unrecoverable from the event log. ADR 0008 replaces this with a `RecordedEvent<E> = { recordedAtMs, event }` envelope captured at the `appendEvent` boundary (transport-independent), and pins the Redis entry ID's ms portion to `recordedAtMs` (`XADD ... ${recordedAtMs}-* …`) so server-side `XRANGE` filtering aligns exactly with envelope time. The stream choice, key shape, `MAXLEN ~ N` trimming, and TTL discussion below remain authoritative; only the timestamp-source paragraph is superseded.

## Context

The durable state-machine runtime is event-sourced: every transition is driven by an event, and crash-resume (SC-003) / replay equivalence (SC-004) both depend on being able to read the full ordered event history for a job and fold it through the pure `transition` function.

That requires a **per-job append-only log** with three properties:

1. **Append on transition.** The runtime calls `appendEvent(event)` from the imperative shell; the call must be cheap and ordered.
2. **Range scan for replay.** A worker resuming a job must read every event since the last checkpoint, in order.
3. **Bounded growth.** Long-lived jobs (HITL flows that sit in `awaiting-human` for hours) must not grow the log unboundedly.

A fourth, structural constraint comes from ADR 0001: the functional core (`state-machine/**`) and DAG runtime (`dag-runtime/**`) MUST NOT import infrastructure. Whichever store we pick, the core sees only an opaque `JobLike` handle — never `ioredis`, never stream semantics.

Spec OQ-1 left the storage substrate, key shape, and retention policy unspecified. This ADR resolves it.

Forces at play:

- BullMQ already requires a Redis connection. Adding a *new* persistence dependency (Postgres, files) widens the operational surface for no current gain.
- The in-memory adapter (used in unit tests and the back-compat `runDag` path) needs the same `appendEvent` shape — so the abstraction has to be cheaper than just "use Redis directly."
- Replay must be deterministic: the read API must return events in append order with no gaps.
- A bounded log is mandatory; an unbounded one is a slow leak in production.

## Options Considered

1. **Per-job Redis Stream keyed `events:{queueName}:{jobId}` (chosen).**
   - Pros:
     - `XADD` gives append-only ordering with server-assigned IDs.
     - `XRANGE` gives ordered range scans for replay — exactly what `transition`-folding needs.
     - `XADD MAXLEN ~ N` caps growth at insert time; no separate trim job.
     - Per-job key isolates blast radius: deleting a finished job's log is `DEL one-key`, scanning one job's history is `XRANGE one-key`, no contention with other jobs.
     - TTL is natural (`EXPIRE` on the per-job key when the job reaches a terminal state).
     - No new dependency — Redis is already in the stack for BullMQ.
   - Cons:
     - Stream entries are field/value maps; we serialize event payloads to JSON inside the `payload` field, which costs one parse per event on replay.
     - Approximate trimming (`MAXLEN ~`) means the cap is "around N", not exactly N. Acceptable for a debugging/replay window.

2. **Single global stream `events:{queueName}` with a `jobId` label per entry.**
   - Pros:
     - One key to monitor; simpler ops dashboard.
     - Consumer groups across all jobs in one place if we ever want a global event tap.
   - Cons:
     - Replay for one job requires a full scan with filter (or a secondary index) — `O(total events)` instead of `O(events for this job)`.
     - Deleting a finished job's history is impossible without rewriting the stream.
     - A hot job becomes a hot key for *all* jobs in the queue.
     - `MAXLEN` is global, so a chatty job evicts a quiet job's history.

3. **Redis Lists (`LPUSH` / `LRANGE`).**
   - Pros:
     - Simpler primitive; no stream-entry encoding.
     - `LTRIM` for bounded retention.
   - Cons:
     - No server-assigned ordered IDs — we'd have to invent them.
     - No consumer-group story if we ever want fan-out replay (e.g., a sidecar that tails events for observability).
     - Streams are the modern, intended primitive for this exact use case; choosing Lists is choosing the legacy path.

4. **Postgres (or another RDBMS) append-only table.**
   - Pros:
     - Strong durability guarantees, transactional with other state if we were already using Postgres.
     - SQL for ad-hoc queries.
   - Cons:
     - New dependency surface (driver, migrations, connection pool, ops). The project does not currently require Postgres.
     - Higher per-append latency than `XADD`.

5. **Append-only files on disk.**
   - Pros: No network hop.
   - Cons: BullMQ workers are horizontally scaled; a per-worker file is invisible to the worker that resumes a job. Not viable for the BullMQ adapter.

## Decision

**`JobLike` exposes `appendEvent(event): Promise<void>`. The BullMQ adapter persists events to a per-job Redis Stream keyed `events:{queueName}:{jobId}`, capped via `XADD MAXLEN ~ 10000` (default; configurable through `EventLogOpts.maxLen`). Replay reads via `XRANGE` and folds events through the pure `transition`. The in-memory adapter keeps an array. Core and DAG modules see only the opaque `JobLike` handle.**

Concrete shape:

- `JobLike` (in `packages/framework/src/types/job-like.ts`) declares ONLY `data`, `updateData`, `updateProgress`, and `appendEvent(event: TraceEvent): Promise<void>`. It deliberately does NOT expose any read API — replay reads come from a SEPARATE `EventLogReader` interface (see ADR 0006). No method's signature mentions Redis, streams, or `ioredis`.
- Replay path: `replayEvents()` in `packages/framework/src/state-machine/replay.ts` consumes an `EventLogReader` (the BullMQ implementation lives in `packages/framework/src/queue-bullmq/event-log.ts`; the in-memory equivalent lives alongside the in-memory adapter) and folds events through the pure `transition`. Splitting append from read keeps `JobLike` minimal and lets the imperative shell wire whichever reader matches the adapter at hand.
- BullMQ adapter (`packages/framework/src/queue-bullmq/job.ts`, `adaptBullMQJob`):
  - `appendEvent` serializes the FULL event with `JSON.stringify(event)` into the `payload` field and derives `type` as `typeof eventObj?.type === "string" ? eventObj.type : "event"`. Only two fields are written; there is no separate `ts` field (the timestamp lives inside the serialized payload).
  - When `approximate=true` (the default): `XADD events:{queueName}:{jobId} MAXLEN ~ {maxLen} * type <type> payload <payload>`.
  - When `approximate=false`: `XADD events:{queueName}:{jobId} MAXLEN {maxLen} * type <type> payload <payload>`.
  - The `EventLogReader` in `packages/framework/src/queue-bullmq/event-log.ts` issues `XRANGE events:{queueName}:{jobId} - +` and yields parsed `TraceEvent`s in order.
  - On terminal phase (`completed` / `failed`), the adapter `EXPIRE`s the key with a configurable TTL (default 7 days) so successful jobs don't accumulate indefinitely.
- In-memory adapter (`packages/framework/src/state-machine/in-memory-job.ts`, `createInMemoryJob`): pushes to an in-memory array; the matching in-memory `EventLogReader` yields a snapshot of that array. Used by unit tests and the back-compat `runDag` path.
- `EventLogOpts` (exported from the BullMQ adapter package only):
  - `maxLen: number` — default `10000`.
  - `terminalTtlSeconds: number` — default `604800` (7 days).
- Boundary enforcement: ADR 0001's import-graph lint forbids `state-machine/**` and `dag-runtime/**` from importing `ioredis` or anything in `queue-bullmq/**`. The opaque-handle invariant is mechanical, not just convention.

Key invariants:

- **Append order = transition order.** The runtime appends *after* applying a transition. Replay folds in the same order; SC-004 is the regression guard.
- **`transition` purity.** No I/O in `state-machine/**`. Replay equivalence depends on this; ADR 0001's lint enforces it.
- **One key per `(queueName, jobId)`.** Deleting / inspecting / TTL'ing a single job's history is always a one-key operation.

## Consequences

**Positive:**

- Crash-resume (SC-003) and replay equivalence (SC-004) have a substrate that matches their semantic requirements: ordered append, ordered range scan, server-assigned IDs.
- No new infrastructure dependency. Operators already running BullMQ already run Redis.
- Per-job key isolates failure modes — a chatty job cannot evict a quiet job's history, and a finished job's log is one `DEL` away from cleanup.
- `MAXLEN ~ 10000` default keeps long-lived `awaiting-human` jobs bounded while preserving enough history (~10k events) for post-hoc debugging.
- Core and DAG modules remain backend-agnostic. Swapping to a different log substrate later is a `JobLike` adapter change, not a core rewrite.

**Negative:**

- JSON-encoded payloads in stream-entry fields cost one `JSON.parse` per event on replay. Acceptable; replay is rare and bounded by `MAXLEN`.
- `MAXLEN ~` is approximate — actual stream length may briefly exceed `maxLen`. We accept this for the cheaper insert path; an exact cap would require `MAXLEN =` (slower) or a separate trim job (more moving parts).
- A pathological job that emits more than `maxLen` events between checkpoints would lose the oldest events on replay. The checkpoint cadence is the mitigation: checkpoints capture state so replay only needs events *since* the last checkpoint, which should be well under `maxLen` in any realistic workload. If this assumption breaks for some workload, `EventLogOpts.maxLen` is the per-queue knob.
- Two adapters (BullMQ + in-memory) must stay in sync on the `JobLike` contract AND on the `EventLogReader` contract. Adapter parity tests (in the queue-adapter test suite) are the guard.
- Redis remains a single point of failure for BullMQ-backed deployments. This was already true before this ADR; event sourcing does not worsen it.
