# Feature: Durable State Machine Runtime

**Spec ID:** 2026-05-08-durable-state-machine-runtime
**Created:** 2026-05-08
**Status:** Draft
**Owner:** peterstorm

## Summary

Extract a reusable, durable, event-sourced state-machine runtime into `packages/framework`, layered as a generic kernel, a DAG executor, a pluggable queue layer, and a cron scheduler. The runtime gives library consumers crash-safe checkpoint/resume, event-sourced replay, per-node retries, human-in-the-loop pauses, and DAG parallelism without forcing them to hand-roll the loop. Existing `runDag(dag, input, ctx)` callers keep working unchanged; opt-in durability is available via new options.

---

## User Scenarios

The "users" of this library are application authors (ai-summary, reclaw, future workflows) who consume the framework's APIs. Scenarios are framed accordingly.

### US1: [P1] Existing DAG callers keep working unchanged

**As a** consumer of the current `runDag(dag, input, ctx)` API
**I want to** keep calling `runDag` with the same signature and get the same behavior
**So that** the refactor is non-breaking and I migrate to durability on my own schedule

**Why this priority:** Backwards compatibility is a hard constraint. A breaking change blocks every downstream consumer.

**Acceptance Scenarios:**
- Given an existing call `runDag(dag, input, ctx)` with no options, When the runtime executes, Then output, error semantics, wave parallelism, and ordering match the pre-refactor behavior.
- Given an existing call where one node fails, When `runDag` returns, Then it returns a `Result` failure with the same error shape consumers receive today.
- Given an existing test suite for the ai-summary executor, When run against the new implementation, Then all tests pass with no source modifications.

### US2: [P1] Build a durable workflow on the kernel

**As a** consumer building a custom (non-DAG) workflow
**I want to** define a `Machine<S, E, C>` (pure transition, terminal predicate, progress, retry caps) and an `Executor<S, C, E>` (side-effect dispatcher) and hand both to `runStateMachine` along with a `JobLike`
**So that** I get a crash-safe loop without writing the loop myself

**Why this priority:** This is the core kernel; every other layer is built on it.

**Acceptance Scenarios:**
- Given a `Machine` and `Executor`, When `runStateMachine(job, machine, executor)` is called, Then the runtime drives the machine to a terminal state, checkpointing after each successful transition.
- Given an executor throws an unexpected error, When the runtime catches it, Then the error is wrapped into an `ERROR` event delivered to the machine's transition function (no direct rethrow before transition).
- Given the machine transitions to a failed terminal state, When the runtime observes that state, Then the runtime MUST NOT checkpoint the failed state and MUST throw so the queue layer can retry.
- Given a process crash mid-run, When a fresh process picks up the job, Then execution resumes from the last successfully checkpointed state, not from the start.

### US3: [P1] DAG executor as a state machine

**As a** consumer of `runDag`
**I want to** opt into checkpointing, per-node retries, and human-in-the-loop pauses by passing options
**So that** long-running DAGs survive crashes and support review gates without being rewritten

**Why this priority:** The DAG layer is the primary consumer of the kernel and the migration target for ai-summary's executor.

**Acceptance Scenarios:**
- Given a DAG with retry limits and a node that fails transiently, When the node fails fewer times than its limit, Then the runtime retries the node within the same wave with exponential backoff (default 1s/2s/4s plus jitter).
- Given a DAG with a node that fails more times than its limit, When retries are exhausted, Then the DAG transitions to a `failed` state carrying the original error.
- Given a node declares `humanReview`, When that node completes, Then the DAG transitions to `awaiting-human` and waits for an external `human-responded` event.
- Given a wave contains multiple human-review nodes, When the wave finishes, Then the runtime presents reviews sequentially in node-id order (one at a time, next begins only after the prior is resolved).
- Given a human responds with `reroute` to a node in the current or an earlier wave, When the event is processed, Then the DAG resumes from that target wave.
- Given a human responds with `reroute` to a node in a later wave, When the event is processed, Then the DAG transitions to `failed` with an `invalid-reroute` error.
- Given an `abort` event arrives in any non-terminal state, When processed, Then the DAG transitions to `failed` with an `aborted` error and the reason is preserved.

### US4: [P2] Pluggable queue backend

**As a** consumer who wants durability
**I want to** plug in BullMQ for production and an in-memory adapter for tests, both behind the same `QueueBackend` interface
**So that** my domain code is unaware of the backend and tests need no Redis

**Why this priority:** Required to deliver checkpoint/resume in real deployments and to keep the test suite hermetic.

**Acceptance Scenarios:**
- Given the BullMQ adapter, When a worker processes a job, Then the worker exposes a `JobLike` whose `updateData` and `updateProgress` map to BullMQ equivalents.
- Given the in-memory adapter, When tests run, Then no Redis connection is opened and the public surface matches `QueueBackend` exactly.
- Given a job exhausts its queue-level retry attempts, When the dead-letter handler fires, Then the configured `DeadLetterNotifier` receives the formatted message and recipient list derived from the job data.
- Given a `MarkerStore` is provided, When a marker is set with TTL N, Then `exists` returns true within the window and false (or eventually false) after expiry.

### US5: [P2] Cron scheduler with dependencies and catch-up

**As a** consumer with periodic tasks that depend on each other
**I want to** declare tasks with cron, validity window, and dependencies and have the scheduler reconcile timers and catch up after restart
**So that** missed runs are recovered correctly without duplicate execution

**Why this priority:** Required for reclaw-style scheduled workflows and any future periodic ai-summary tasks.

**Acceptance Scenarios:**
- Given a registry containing a cyclic dependency chain, When `hasCycle(taskId, registry)` runs, Then it returns true (and the scheduler refuses to arm the cycle).
- Given an active set of timers and a new desired registry, When `diffRegistry(active, desired)` runs, Then it returns disjoint `add`, `remove`, and `update` lists that fully reconcile active to desired.
- Given a task fired but did not complete, When `decideCatchUp` evaluates after restart, Then it returns `skip` (the in-flight worker handles it).
- Given a task fired and completed within the validity window but its dependents did not fire, When `decideCatchUp` evaluates, Then it returns `enqueue-dependents` listing the unfired dependent ids.
- Given a task did not fire within its validity window, When `decideCatchUp` evaluates, Then it returns `enqueue-standalone`.

### US6: [P2] Event-sourced replay

**As a** consumer debugging a failed run
**I want to** rebuild the state of any job by replaying its persisted event log from the last checkpoint
**So that** I can reproduce, audit, or time-travel-debug without re-running side effects

**Why this priority:** Differentiates this runtime from the current in-memory executor; required by the brainstorm's durability goal.

**Acceptance Scenarios:**
- Given a successful transition, When the runtime checkpoints, Then it MUST also append the triggering event to a per-job event log.
- Given a job's last checkpoint and its event log, When replay is invoked, Then applying events in order through the pure transition function yields the latest known state without invoking the executor.
- Given a failed transition (terminal failed state), When the runtime processes it, Then the failed state is NOT checkpointed but the event that caused it MAY still be appended to the event log for diagnostics.

### US7: [P3] Trace observability

**As a** consumer monitoring runs in production
**I want to** receive a trace event after every transition (state, duration, outcome)
**So that** I can ship spans/metrics without instrumenting the loop myself

**Why this priority:** Useful for production but not required for correctness.

**Acceptance Scenarios:**
- Given an `onTrace` hook, When a transition completes, Then the hook fires exactly once with `{ state, timestamp, durationMs, outcome }`.
- Given the executor takes T ms, When the trace fires, Then `durationMs` is within +/- 50ms of T.
- Given a transition produces no state change (retry/noop), When the trace fires, Then `outcome` is `"retry"` (or `"skipped"` where applicable).

---

## Functional Requirements

### Core kernel (Phase 1)

- FR-001: The framework MUST expose a `Machine<S, E, C>` interface comprising a pure `transition`, an `isTerminal` predicate, a `stateProgress` function returning 0-100, and a per-state `maxRetries` map.
- FR-002: The framework MUST expose an `Executor<S, C, E>` type that returns `Promise<E>` (an event), not a state.
- FR-003: The framework MUST expose a `JobLike<S, C>` interface providing read access to `{ state, context }`, an `updateData` checkpoint operation, an `updateProgress` operation, and an `appendEvent` operation for event-sourced log writes.
- FR-004: The framework MUST expose a `runStateMachine(job, machine, executor, opts?)` function that drives the machine to terminal state.
- FR-005: `runStateMachine` MUST checkpoint via `job.updateData` after every successful transition and MUST NOT checkpoint when the resulting state is a terminal failed state.
- FR-006: `runStateMachine` MUST catch exceptions thrown by the executor, classify them via `opts.classifyError` (default: retriable=true), and deliver them to the machine as an `ERROR` event rather than rethrowing before transition.
- FR-007: `runStateMachine` MUST throw after observing a terminal failed state so the queue layer can apply its retry policy.
- FR-008: The framework MUST expose a `Result<T, E>` discriminated union plus `ok` and `err` constructors.
- FR-009: The framework MUST expose an `AsyncMutex` providing FIFO `acquire(): Promise<() => void>` semantics.
- FR-010: The framework MUST expose serialization helpers that round-trip state values containing `Map` and `Set` instances through JSON without information loss.
- FR-011: `runStateMachine` MUST reset transient retry counters at the start of each invocation so a fresh queue attempt does not inherit stale retry counts from a previous attempt.
- FR-012: `runStateMachine` MUST honor an optional `beforeExecute` hook; returning `false` from the hook MUST abort the run with an explicit error.

### DAG layer (Phase 2)

- FR-020: The framework MUST expose `DagDef`, `NodeDef`, `EdgeDef`, `DagPhase`, `DagEvent`, `DagMachineContext`, and `HumanAction` types.
- FR-021: The framework MUST expose a pure `dagTransition(phase, event, context)` function with no I/O.
- FR-022: The framework MUST expose a `topoSort(dag)` function returning `string[][]` (waves) and detecting cycles by returning a failure `Result`.
- FR-023: The framework MUST expose a `runDag(dag, input, ctx, opts?)` function that compiles a `DagDef` into a `Machine` and runs it via `runStateMachine`.
- FR-024: `runDag` MUST be backwards compatible: calling it with the legacy `(dag, input, ctx)` signature MUST yield identical observable behavior to the pre-refactor implementation.
- FR-025: `runDag` MUST validate node inputs against `inputSchema` and node outputs against `outputSchema` at node boundaries using the supplied Zod schemas.
- FR-026: The DAG transition MUST treat a node failure as retriable when the node's attempt count is at or below its retry limit (per-node `retryLimits` overriding `defaultRetryLimit`).
- FR-027: The DAG runner MUST apply exponential backoff with jitter between retries, defaulting to 1s/2s/4s + jitter, and configurable per-node via `NodeDef.retry`.
- FR-028: When a wave completes containing one or more `humanReview` nodes, the DAG transition MUST enter `awaiting-human` for each such node sequentially in ascending node-id order; the next review MUST NOT start until the prior is resolved.
- FR-029: A `human-responded` event with action `approve` or `approve-with-edit` MUST advance the DAG to the next wave (or to `succeeded` if the reviewed wave is the last); `approve-with-edit` MUST replace the reviewed node's output in the outputs map.
- FR-029a: When `onHumanReview` throws, the framework MUST treat this as a hook crash (NOT a node failure). The node's output and prompt are preserved across hook retries. The framework SHALL retry the hook using exponential backoff and jitter (same backoff parameters as node retry — see FR-027). Hook retry attempts consume from the same per-node retry counter as node execution retries; if the node already consumed N retries during execution, at most `retryLimit - N` hook retry attempts remain. When the counter is exhausted, the DAG MUST transition to terminal `failed` with `node-crash` carrying the nodeId and the latest hook error message. Hook retries MUST NOT re-execute the node.
- FR-030: A `human-responded` event with action `reject` MUST transition the DAG to `failed` with a `rejected` error carrying the supplied reason and node id.
- FR-031: A `human-responded` event with action `reroute` to a node in the current or an earlier wave MUST transition the DAG back to `running` at that target wave with `completed` reset.
- FR-032: A `human-responded` event with action `reroute` to a node in a later wave (forward reroute) MUST transition the DAG to `failed` with an `invalid-reroute` error.
- FR-033: An `abort` event from any non-terminal state MUST transition the DAG to `failed` with an `aborted` error preserving the supplied reason.
- FR-034: The framework MUST NOT impose a human-review timeout in the core; callers control timeouts by emitting `abort` externally.

### Queue layer (Phase 3)

- FR-040: The framework MUST expose a `QueueBackend` interface providing `createQueue` and `createWorker` factories.
- FR-041: The framework MUST expose `QueueHandle`, `WorkerHandle`, `MarkerStore`, and `DeadLetterNotifier` interfaces.
- FR-042: `WorkerHandle` MUST expose `onFailed(handler)` and `onError(handler)` lifecycle hooks and a `close()` operation.
- FR-043: `MarkerStore` MUST provide `set(key, ttlSeconds)`, `exists(key)`, and `delete(key)` operations.
- FR-044: The framework MUST expose a generic `attachDeadLetterHandler(worker, notifier, opts)` helper that fires the notifier only when `attempts >= maxAttempts`.
- FR-045: The framework MUST provide a BullMQ adapter implementing `QueueBackend` with no leakage of BullMQ types into core or DAG modules.
- FR-046: The framework MUST provide an in-memory adapter implementing `QueueBackend` with zero external dependencies, suitable for tests.
- FR-047: The BullMQ adapter MUST adapt a BullMQ `Job` to `JobLike` such that `updateData` and `updateProgress` map to BullMQ's equivalents and `appendEvent` writes to a Redis Stream keyed by job id.
- FR-048: Persistence of the event log MUST use Redis Streams via `XADD` for append and MUST be readable via `XRANGE` for replay.

### Scheduler (Phase 4)

- FR-060: The framework MUST expose `TaskConfig`, `TaskRegistry`, and `CatchUpDecision` types.
- FR-061: The framework MUST expose pure functions `hasCycle(taskId, registry)`, `diffRegistry(active, desired)`, and `decideCatchUp(taskId, firedMarker, completedMarker, withinValidityWindow, hasDependents)`.
- FR-062: `diffRegistry` MUST return three disjoint lists (`add`, `remove`, `update`) such that applying them transforms `active` into `desired`.
- FR-063: `decideCatchUp` MUST return `skip` when the task fired but did not complete; `enqueue-dependents` when fired, completed, within validity window, and dependents unfired; `enqueue-standalone` when not fired and within validity window; otherwise a `skip` with an explanatory reason.
- FR-064: The framework MUST expose a `CronScheduler` factory whose `reconcile(registry)` arms/disarms timers per `diffRegistry`, whose `resolveDependents(taskId, triggeredAt)` enqueues dependents after a task completes, and whose `stop()` clears all timers.

### Boundaries and module hygiene

- FR-080: Core kernel modules MUST have zero runtime dependencies on Redis, BullMQ, ioredis, or any queue implementation.
- FR-081: DAG modules MUST depend only on the core kernel.
- FR-082: Queue interface modules MUST have zero runtime dependencies on a specific queue implementation; only the BullMQ adapter module MAY import BullMQ/ioredis.
- FR-083: All public types in core and DAG MUST be JSON-serializable (state and context payloads), with `Map`/`Set` round-tripping handled via the serialization helpers in FR-010.

---

## Non-Functional Requirements

### Reliability

- NFR-001: A process crash mid-run MUST NOT lose progress beyond the most recent successful checkpoint.
- NFR-002: A failed terminal state MUST NOT be persisted as the job's checkpointed state.
- NFR-003: Replaying the persisted event log from the last checkpoint MUST yield the same state as the live runtime would, by construction (transitions are pure).

### Performance

- NFR-010: Pure transition functions MUST execute in O(waves + nodes + edges) per transition; no transition MUST perform I/O.
- NFR-011: Checkpoint write latency overhead MUST NOT exceed one queue-backend round trip per transition (no extra synchronous I/O in the kernel loop).

### Compatibility

- NFR-020: Existing `runDag(dag, input, ctx)` call sites MUST require zero source changes for behavior preservation.
- NFR-021: Public type names introduced in the brainstorm (`Machine`, `Executor`, `JobLike`, `Result`, `DagDef`, `DagPhase`, `DagEvent`, `QueueBackend`, `WorkerHandle`, `MarkerStore`, `DeadLetterNotifier`, `TaskConfig`, `TaskRegistry`, `CatchUpDecision`) MUST be exported from `packages/framework`.

### Testability

- NFR-030: Pure transition functions MUST be testable with no mocks (constructed inputs, asserted outputs).
- NFR-031: The runner MUST be testable with an in-memory `JobLike` and a fake executor (no Redis required).
- NFR-032: BullMQ adapter integration tests MAY require a live Redis but MUST be isolated from non-integration test runs.

---

## Success Criteria

- SC-001: 100% of pre-refactor ai-summary executor tests pass against the new `runDag` implementation with zero source modifications to those tests.
- SC-002: Pure DAG transition test coverage reaches >=95% line coverage of `dagTransition` and helpers (retry, human review, reroute, abort branches).
- SC-003: Crash-resume integration test demonstrates that killing a worker mid-DAG and restarting yields the same final output as an uninterrupted run, in 10/10 runs.
- SC-004: Event-log replay test demonstrates that replaying events from the last checkpoint reconstructs the same state as the live runtime, for 5 distinct DAG shapes (linear, fan-out, fan-in, diamond, with-human-review).
- SC-005: Zero references to `bullmq` or `ioredis` modules from any file under the core kernel and DAG layer (verified by import-graph check).
- SC-006: `runStateMachine` overhead (kernel loop time excluding executor) is <2ms per transition (p95) measured against an in-memory `JobLike`.
- SC-007: Scheduler decision functions (`hasCycle`, `diffRegistry`, `decideCatchUp`) reach 100% branch coverage in unit tests.
- SC-008: `attachDeadLetterHandler` invokes the notifier exactly once per job that exhausts its retry attempts, and zero times for jobs that succeed or are still retrying (verified across 100 simulated job lifecycles).

**Measurement approach:** Existing + new unit tests (pure transitions, runner with mocks), integration tests against Redis-backed BullMQ for crash/resume and dead-letter, import-graph linting for boundary checks, microbenchmark for kernel overhead.

---

## Out of Scope

Explicitly NOT part of this spec (deferred to later work):

- Phase 5: migrating ai-summary's `executor.ts` to consume the new `runDag` durability hooks.
- Migrating reclaw's `research-handler.ts`, `worker.ts`, `scheduler.ts`, and queue infrastructure to depend on this library.
- Phase 6: conditional branching primitives (`skipWhen` runtime evaluation, `branchOn` selectors, dynamic DAG restructuring).
- Core-level human-review timeouts (callers handle externally via `abort`).
- Forward reroutes (skipping ahead to a later wave) — explicitly rejected as `invalid-reroute`.
- Parallel multi-review-per-wave UX (multiple human reviews always run sequentially in this version).
- A separate npm package (`@peterstorm/durable-machine`); the work lives inside `packages/framework`.
- A CLI / API for replay-based time-travel debugging (the event log is persisted, but the UX on top of it is future work).

---

## Open Questions

1. Which Redis Stream key shape and retention policy should the BullMQ adapter use for the per-job event log? [NEEDS CLARIFICATION: stream key naming convention, MAXLEN cap, and TTL/trim policy]
2. Should `TraceEvent` include the resulting state (post-transition) in addition to the pre-transition state, or only the pre-transition state as drafted in the design? [NEEDS CLARIFICATION: trace shape — pre-only vs. before/after pair]
3. When the queue backend's retry attempts are exhausted but the in-machine retry budget is not (or vice versa), which authority wins? [NEEDS CLARIFICATION: precedence between queue-level retries and machine-level retry caps]

---

## Dependencies

- Existing `packages/framework` source layout and build pipeline.
- Existing ai-summary executor tests (used as the backwards-compatibility oracle).
- Redis (for the BullMQ adapter and event-sourced log) — only for the BullMQ-backed paths and integration tests.
- Zod (already in use) for node-boundary validation.

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Backwards-compat regression in `runDag` breaks existing callers | High | Reuse the existing test suite as a non-negotiable oracle; gate merge on 100% pass. |
| Checkpoint write per transition becomes a hot path under high node counts | Medium | Keep checkpoint payloads small; profile against representative DAGs; consider batching only if SC-006 fails. |
| Event-log replay diverges from live execution due to non-determinism leaking into transitions | High | Enforce purity of `transition` by construction (no I/O imports); cover replay equivalence in SC-004. |
| BullMQ/Redis types leak into core via inferred generics | Medium | Add an import-graph lint (SC-005); review public API surface for opaque type erasure. |
| Sequential human reviews per wave create UX bottlenecks for large parallel waves | Low | Acceptable for v1; revisit when a real consumer requests parallel review. |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Machine | Pure state-machine definition: transition function, terminal predicate, progress, retry caps. |
| Executor | Side-effect dispatcher: takes a state, performs I/O, returns the resulting event. |
| JobLike | Abstract job handle exposing checkpoint, progress, and event-append operations. |
| Checkpoint | The most recently persisted `{ state, context }` for a job; never a failed terminal state. |
| Event log | Append-only sequence of events applied to a job, persisted per-job (Redis Streams in the BullMQ adapter). |
| Wave | A topological layer of a DAG; all nodes in a wave can run in parallel. |
| Human review | A pause point on a node where execution waits for an external `human-responded` event. |
| Reroute | A human action that returns DAG execution to an earlier (or current) wave. |
| Dead letter | A job that has exhausted its queue-level retry attempts; triggers external notification. |
| Marker | A small, TTL-bounded keyed record used by the scheduler for dedup and dependency resolution. |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial draft | peterstorm |
