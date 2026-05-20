# ADR 0006: `JobLike` shape — minimal, append-only event log, no read API in core

**Status:** Accepted
**Date:** 2026-05-09
**Spec ref:** FR-003, FR-005, FR-006, SC-004 (`.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`)
**Related:** ADR 0003 (event sourcing via Redis Streams).

## Context

The kernel runner (`runStateMachine`) needs a backend-agnostic handle to read its starting snapshot, write checkpoints, write progress hints, and append to an event log. That handle — `JobLike<S, C>` — is the seam the BullMQ adapter, the in-memory adapter, and any future backend implement. Every call site of the runner takes one, every test fakes one, and every adapter must produce one.

A separate concern is **replay**: rebuilding `{state, context}` by folding the event log through the pure `transition`. Replay is required for the SC-004 equivalence test (a replayed run reconstructs the same state as the live runtime across 5 DAG shapes). It's also the foundation for resume-from-crash and post-mortem debugging.

The question is whether the read-side (event-log iteration for replay) belongs on `JobLike` or somewhere else. The forces:

- The runner itself never reads events — it only appends them after each successful transition (FR-005, FR-006). Adding a read API to `JobLike` would put a method on the type that the runner cannot call.
- Read-side access patterns differ from write-side. Writes are one-shot per transition. Reads stream a range, may need a cursor, may want batch sizing, and (in BullMQ/Redis Streams) map to `XRANGE` with pagination — not a single `XADD`.
- Test ergonomics matter. A small `JobLike` is trivial to fake. A large one bleeds adapter detail into every test.
- The "did we append?" invariant of FR-006/SC-004 should be visible in the type signature, not buried inside an `updateData` side-effect.

## Options Considered

1. **Minimal write-side `JobLike`; replay via separate `EventLogReader` interface.**
   - Pros:
     - Runner type matches its actual capability (write-only) — no surface a caller cannot use correctly.
     - In-memory adapter is ~30 LOC; backend conformance tests stay small.
     - `EventLogReader` can evolve independently (cursor-based iteration, batch size, fan-out) without touching the kernel.
     - Adapters that only need writes (e.g., a future fire-and-forget event sink) don't have to implement reads.
     - Append invariant stays explicit: every call site that mutates state appends an event in the same code path.
   - Cons:
     - Two interfaces to wire up at the adapter layer instead of one (e.g., BullMQ adapter ships `adaptBullMQJob` *and* `createRedisStreamReader`).
     - Replay code must take both `EventLogReader` and the initial snapshot as arguments — slightly more plumbing at call sites.

2. **`JobLike.readEvents()` (or `iterateEvents()`) on the same type.**
   - Pros:
     - Single interface; one adapter constructor produces everything you need.
     - "Read-your-own-writes" feels natural — the same handle that wrote an event reads it back.
   - Cons:
     - Couples the runner to a feature it never uses; tests that fake `JobLike` for unit-testing `runStateMachine` must still stub a method the runner doesn't call.
     - Streaming/cursor semantics leak into the kernel's type surface even though the kernel has no streaming use case.
     - Forces every adapter — including degenerate ones — to implement reads.
     - Conflates two lifetimes: `JobLike` is per-attempt (BullMQ creates a fresh job handle per invocation); event-log reads may span attempts.

3. **Skip `appendEvent`; emit events implicitly inside `updateData`.**
   - Pros:
     - One write call per transition instead of two.
     - No way to forget the append — it's automatic.
   - Cons:
     - Makes the FR-006 / SC-004 "did we append?" invariant implicit. Reviewers reading the runner can't see the append happen.
     - Conflates checkpoint cadence with event-log cadence — if we ever want to coalesce checkpoints (e.g., every N transitions) while keeping the log gap-free, `updateData` and `appendEvent` need separate triggers.
     - The implicit emit would have to know how to derive a typed event from `(prev, next, transitionResult)`, pulling kernel-level concerns into the adapter.
     - Harder to unit-test: tests can't assert "this transition produced one event" without inspecting checkpoint side effects.

## Decision

**Choose option 1: `JobLike` is strictly write-side; replay lives in a separate `replay.ts` helper that takes an `EventLogReader`.**

`JobLike<S, C>` exposes exactly four members:

```ts
interface JobLike<S, C> {
  readonly data: { state: S; context: C };          // snapshot at job start
  updateData(d: { state: S; context: C }): Promise<void>;
  updateProgress(pct: number): Promise<void>;
  appendEvent(event: unknown): Promise<void>;
}
```

Defined in `packages/framework/src/state-machine/types.ts` alongside `Machine`, `Executor`, `RunOptions`, and `TraceEvent`.

`EventLogReader` is a separate, adapter-implemented interface used only by `replay.ts`. The in-memory adapter ships both (`adaptInMemoryJob` and an array-backed reader) under `state-machine/in-memory-job.ts`. The BullMQ adapter ships `adaptBullMQJob` in `queue-bullmq/job.ts` (writes via `XADD`) and `createRedisStreamReader` in `queue-bullmq/event-log.ts` (reads via `XRANGE`).

`replayEvents(events, machine, initial)` is a pure function — it does not take a `JobLike`. The caller is responsible for fetching events via the reader and threading them in. This keeps `replay.ts` independent of any backend.

Invariants the kernel runner enforces against this shape:

- After every successful `transition` whose resulting state is NOT terminal-failed, the runner calls both `updateData` and `appendEvent` (FR-005, FR-006, SC-004). On terminal-failed, both writes are skipped — the runner throws (FR-007) so the queue layer can retry without a partial checkpoint. Both calls are visible in the runner source — no hidden emission.
- The runner never calls a read method on `JobLike` because none exists.

## Consequences

**Positive:**

- The runner's type signature accurately reflects its capability — write-only handle, no read surface to mock or ignore.
- In-memory test fixture is ~30 LOC; backend conformance tests stay small and focused.
- `EventLogReader` is free to evolve independently — pagination, cursors, batch size, consumer-group fan-out — without forcing kernel changes.
- The append step is explicit at the runner call site, making the FR-006 / SC-004 invariant reviewable in code rather than buried in a checkpoint side effect.
- Adapters that don't need reads (hypothetical write-only sinks) don't have to implement them.
- `replay.ts` is a pure helper — it can be unit-tested without spinning up Redis or BullMQ.

**Negative:**

- Two interfaces to implement per adapter (`JobLike` + `EventLogReader`) instead of one. Mitigated by keeping each interface tiny.
- Replay call sites take both an `EventLogReader` and an initial snapshot — slightly more plumbing than passing a single `JobLike`. Acceptable: replay is a coarse-grained operation called from the queue worker on resume, not a hot path.
- A future need to read events *during* a live run (e.g., for in-process introspection) would require a third construct or a JobLike extension. We accept this; the current design intentionally keeps the per-attempt write handle separate from log readers, and the introspection use case is hypothetical.
- Adapters must keep `JobLike` and `EventLogReader` consistent — an event written via `appendEvent` must be readable via the corresponding reader. Backend conformance tests cover this.
