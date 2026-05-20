# Brainstorm Summary

**Building:** A durable, event-sourced state-machine runtime inside `packages/framework`, extracted from the patterns currently embedded in ai-summary's executor and informed by reclaw's research-handler. The goal is a reusable kernel that the existing DAG executor (and future workflows) can sit on top of, with pluggable queue/scheduler layers and replayable history.

**Approach:** Layered refactor of `packages/framework` — extract a generic state-machine kernel, rebuild the existing DAG executor on top of it, add pluggable queue + scheduler layers. Functional core / imperative shell. Event-sourced durability via Redis Streams alongside the latest checkpoint.

**Key Constraints:**
- Lives in `packages/framework` (no new package, no `@peterstorm/durable-machine`)
- Backwards compatible: existing `runDag(dag, input, ctx)` API keeps working with no behavior change for current callers
- Functional core: transition functions are pure; all I/O lives in runner/adapters
- Don't checkpoint failed states (critical invariant carried over from current executor)
- Event sourcing: every event persisted via Redis Streams (`XADD`/`XRANGE`); state rebuildable by replay from any checkpoint
- Zero external deps in core types (no Redis/BullMQ leakage into kernel or DAG types)
- Reroutes are backward-only; forward skips rejected with `invalid-reroute`
- Multiple human-review nodes in a wave run sequentially, ordered by node id
- No core-level human-review timeout; callers fire `abort` externally if needed

**In Scope:**
- Phase 1: Core kernel — `Machine<S,E,C>`, `runStateMachine`, `JobLike` (with `appendEvent` + `updateData`), `Result`, `AsyncMutex`, serialization helpers
- Phase 2: DAG layer — `DagDef`, `DagPhase`, `DagEvent` types, `topoSort` (extracted from current code), pure `dagTransition`, `runDag` compiler over the kernel, Zod node-boundary validation
- Phase 3: Queue layer — `QueueBackend`, `WorkerHandle`, `MarkerStore`, `DeadLetterNotifier` interfaces; BullMQ adapter; in-memory adapter; generic dead-letter pattern
- Phase 4: Scheduler — `TaskConfig`, `TaskRegistry`, pure `hasCycle` / `diffRegistry` / `decideCatchUp`, `CronScheduler` with timer reconciliation
- Per-node retry: exponential backoff with jitter, configurable via `NodeDef.retry`; default 1s/2s/4s + jitter
- Event log via Redis Streams alongside checkpoint; replay rebuilds state from last checkpoint forward
- Tests: pure transition tests (no mocks), runner tests with mock executor, integration tests for BullMQ adapter (Redis required)

**Out of Scope:**
- Migrating ai-summary's `executor.ts` to use the new runner (Plan Phase 5 — separate effort)
- Reclaw migration (purely reference for patterns)
- Conditional branching / `skipWhen` / `branchOn` (Plan Phase 6 — deferred)
- Human-review timeout in core
- Forward reroutes
- Parallel multi-review-per-wave UX

**Open Questions:** (none blocking — all resolved in loom inputs)
- Future: replay UX (CLI / API for time-travel debugging) — design when need emerges
