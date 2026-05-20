# Plan Alignment Report: Durable State Machine Runtime

**Spec:** `.claude/specs/2026-05-08-durable-state-machine-runtime/spec.md`
**Plan:** `.claude/plans/2026-05-08-durable-state-machine-runtime.md`
**Generated:** 2026-05-08

---

## Summary

The plan covers the in-scope spec surface comprehensively. All four phases (kernel, DAG layer, queue layer, scheduler) are decomposed with concrete files, interface signatures, and tests. Open Questions 1–3 from the spec are explicitly resolved in AD-3, AD-4, AD-5. Backwards compatibility is preserved via a shim (AD-2/AD-7).

A small number of minor gaps were found around: (1) explicit `Result<T,E>` constructor exports (FR-008), (2) the `topoSort` cycle-failure-as-`Result` contract (FR-022), (3) the legacy-test-suite pass requirement under SC-001 not yet bound to the shim's no-`jobLike` no-HITL no-retryLimits path with eval-judge / `onBackground` parity verification, and (4) the `MarkerStore` TTL expiry semantics (FR-043 / US4 acceptance — "eventually false after expiry") only partially specified.

Out-of-scope items (Phase 5 consumer migration, reclaw migration, conditional branching, HITL timeout, forward reroutes) were not flagged.

---

## Gaps

### Gap 1: FR-008 — `Result<T,E>` discriminated union and `ok`/`err` constructors not explicitly listed as exports

**Spec requirement:** "The framework MUST expose a `Result<T, E>` discriminated union plus `ok` and `err` constructors."

**Plan coverage:** The plan references `Result<O, FrameworkError>` in `runDagStateful`'s return type and `ok`/`err` in the legacy data-flow diagram, but does not enumerate where `Result`, `ok`, and `err` live as exports. NFR-021 lists `Result` among required exports — Phase 5's `index.ts` re-export step does not call out `Result`/`ok`/`err` explicitly.

**Severity:** Low (very likely already exists in `packages/framework`, but plan should confirm or define the file).

**Suggested fix:** Add a one-line note to Phase 5 listing `Result`, `ok`, `err` as part of the public re-export set, or add a `state-machine/result.ts` (or confirm reuse of an existing `types/result.ts`) under Phase 1.

---

### Gap 2: FR-022 — `topoSort` cycle detection returning a failure `Result` not addressed

**Spec requirement:** "The framework MUST expose a `topoSort(dag)` function returning `string[][]` (waves) and detecting cycles by returning a failure `Result`."

**Plan coverage:** Plan says `executor/topo.ts` is "UNCHANGED (reused by both paths)" but does not state whether the existing `topoSort` already returns a `Result` on cycle, nor whether the public-export surface (NFR-021) exposes it as a public API of `packages/framework`.

**Severity:** Low.

**Suggested fix:** In Phase 2a or Phase 5, verify and (if needed) wrap `topoSort` to return `Result<string[][], FrameworkError>` on cycle detection, and re-export from the package barrel.

---

### Gap 3: SC-001 — eval-judge background path / `onBackground` / `RunOptions.resume` parity not test-gated

**Spec criterion:** "100% of pre-refactor ai-summary executor tests pass against the new `runDag` implementation with zero source modifications to those tests."

**Plan coverage:** AD-2 and Phase 3c claim "OTel root span, observer events, eval-judge background path, `RunOptions.resume`/`onBackground` semantics MUST be preserved unchanged" — and the existing `executor.test.ts` / `second-dag.test.ts` are listed as the back-compat oracle. However, Phase 3c also says "punt with explicit error if both [`jobLike` + `resume`] given for now". This may be acceptable, but the plan does not enumerate which existing tests exercise `resume` / `onBackground` and confirm they only hit the legacy fast path (i.e., never trigger the new path's resume-rejection error).

**Severity:** Medium.

**Suggested fix:** Add a Phase 3c sub-task to audit existing test fixtures for any combination of `resume` / `onBackground` with HITL / retryLimits / `jobLike` and confirm the shim routes them to the legacy fast path. If any existing test would route to the new path, plan a path-merge fix.

---

### Gap 4: FR-043 / US4 — `MarkerStore` TTL "eventually false after expiry" semantics not explicitly verified

**Spec requirement:** "Given a `MarkerStore` is provided, When a marker is set with TTL N, Then `exists` returns true within the window and false (or eventually false) after expiry."

**Plan coverage:** Phase 4a tests `set/exists/delete; TTL expiry within window` for the Redis-backed `MarkerStore`, but the in-memory backend (Phase 3b) tests do not enumerate TTL-expiry coverage; `queue-memory/job.ts` is described as "Map-backed" with no mention of how/whether the in-memory `MarkerStore` honors TTL.

**Severity:** Low.

**Suggested fix:** In Phase 3b, add an in-memory `MarkerStore` (or note its absence is intentional) and add a TTL-expiry unit test, or document that the in-memory backend's `MarkerStore` is gated behind a fake timer.

---

### Gap 5: NFR-001 / SC-003 — crash-resume test for in-memory path not covered

**Spec:** NFR-001 ("A process crash mid-run MUST NOT lose progress beyond the most recent successful checkpoint") and SC-003 ("Crash-resume integration test demonstrates that killing a worker mid-DAG and restarting yields the same final output as an uninterrupted run, in 10/10 runs").

**Plan coverage:** Crash-resume test is gated in Phase 4a under the BullMQ/Redis integration suite. There is no equivalent simulated-crash test against the in-memory backend / in-memory `JobLike` to verify the runner's checkpoint-and-resume invariant in unit-test conditions (i.e., simulated failure mid-loop and restart from persisted state).

**Severity:** Low (BullMQ integration test technically satisfies SC-003; but a hermetic equivalent would harden NFR-001 testability per NFR-031).

**Suggested fix:** Add a unit-level "simulated crash + restart" test under `__tests__/state-machine-runner.test.ts` that throws mid-executor, instantiates a fresh runner with the same in-memory `JobLike`, and asserts final state equals an uninterrupted run.

---

## Coverage Table

| ID | Plan Coverage | Notes |
|----|---------------|-------|
| US1 | covered | AD-2, AD-7, Phase 3c shim; existing tests gate (SC-001 oracle) |
| US2 | covered | Phase 1 kernel; runStateMachine, JobLike, Machine/Executor types |
| US3 | covered | Phase 2a + Phase 3a; transition tests cover retry/HITL/reroute/abort branches |
| US4 | partial | TTL behavior on in-memory MarkerStore not enumerated (Gap 4) |
| US5 | covered | Phase 4b scheduler, all four CatchUpDecision cases tested |
| US6 | covered | Phase 1 replay.ts + Phase 4a XRANGE reader + SC-004 5-shape test |
| US7 | covered | AD-4 resolves trace shape; onTrace fires post-transition with FROM/TO |
| FR-001 | covered | state-machine/types.ts Machine interface (transition, isTerminal, stateProgress, maxRetries; +isFailed extension) |
| FR-002 | covered | Executor type returns Promise<E> |
| FR-003 | covered | JobLike with data, updateData, updateProgress, appendEvent |
| FR-004 | covered | runStateMachine signature in Phase 1 |
| FR-005 | covered | "don't-checkpoint-failed invariant" Phase 1 |
| FR-006 | covered | classifyError + errorEventOf wrap to ERROR event |
| FR-007 | covered | Runner throws on terminal-failed (Phase 1, AD-5) |
| FR-008 | gap | Result/ok/err exports not enumerated (Gap 1) |
| FR-009 | covered | mutex.ts AsyncMutex Phase 1 |
| FR-010 | covered | serialize.ts Map/Set helpers Phase 1 |
| FR-011 | covered | "retry-counter reset (FR-011)" Phase 1 |
| FR-012 | covered | "beforeExecute abort (FR-012)" Phase 1 |
| FR-020 | covered | dag-runtime/types.ts Phase 2a |
| FR-021 | covered | transition.ts pure dagTransition Phase 2a |
| FR-022 | partial | topoSort reused unchanged; cycle-as-Result return contract not verified (Gap 2) |
| FR-023 | covered | run-dag-stateful.ts Phase 3a |
| FR-024 | covered | AD-2/AD-7 shim; SC-001 oracle |
| FR-025 | covered | "validates inputs/outputs (FR-025)" Phase 3a |
| FR-026 | covered | Phase 2a transition tests cover retry within/at/over limit |
| FR-027 | covered | "exponential backoff with jitter (FR-027)" Phase 3a |
| FR-028 | covered | "sequential HITL ordering by node-id (FR-028)" Phase 2a tests |
| FR-029 | covered | approve / approve-with-edit branches in transition tests |
| FR-030 | covered | reject branch in transition tests |
| FR-031 | covered | reroute-back branch in transition tests |
| FR-032 | covered | reroute-forward fails (out-of-scope-flagged item, but spec FR is in-scope and covered) |
| FR-033 | covered | abort from any non-terminal state |
| FR-034 | covered | Out-of-scope per spec for HITL timeout (not flagged) |
| FR-040 | covered | queue/types.ts QueueBackend Phase 2b |
| FR-041 | covered | All four interfaces in queue/types.ts |
| FR-042 | covered | WorkerHandle.onFailed/onError/close |
| FR-043 | partial | TTL semantics on in-memory side (Gap 4) |
| FR-044 | covered | attachDeadLetterHandler Phase 2b |
| FR-045 | covered | createBullMQBackend Phase 4a |
| FR-046 | covered | createInMemoryBackend Phase 3b |
| FR-047 | covered | adaptBullMQJob with XADD Phase 4a |
| FR-048 | covered | XADD append + XRANGE replay Phase 4a |
| FR-060 | covered | scheduler/types.ts Phase 4b |
| FR-061 | covered | cycle.ts, diff.ts, catch-up.ts Phase 4b |
| FR-062 | covered | diffRegistry disjoint property test Phase 4b |
| FR-063 | covered | All four CatchUpDecision cases tested |
| FR-064 | covered | createCronScheduler reconcile/resolveDependents/stop |
| FR-080 | covered | Phase 5 import-graph lint (SC-005) |
| FR-081 | covered | Phase 5 import-graph lint |
| FR-082 | covered | Phase 5 import-graph lint |
| FR-083 | covered | FR-010 serialization helpers + JSON-serializable types |
| NFR-001 | partial | Crash-resume test only at integration tier (Gap 5) |
| NFR-002 | covered | "don't-checkpoint-failed invariant" |
| NFR-003 | covered | replayEvents pure-fold + SC-004 5-shape test |
| NFR-010 | covered | Pure transitions, O(waves+nodes+edges) by construction |
| NFR-011 | covered | Single HSET + XADD per transition; AD-4 documents |
| NFR-020 | covered | AD-2, SC-001 oracle |
| NFR-021 | partial | Phase 5 re-export not enumerating Result/ok/err (Gap 1 overlap) |
| NFR-030 | covered | Pure transition tests with no mocks |
| NFR-031 | covered | createInMemoryJob + fake executor |
| NFR-032 | covered | Phase 4a gated under REDIS_URL |
| SC-001 | partial | Eval-judge / onBackground / resume parity not test-audited (Gap 3) |
| SC-002 | covered | Phase 2a "target SC-002 (>=95% line coverage)" |
| SC-003 | covered | Phase 4a crash-resume integration test |
| SC-004 | covered | Phase 4a 5-shape replay equivalence test |
| SC-005 | covered | Phase 5 import-graph lint |
| SC-006 | covered | runner.bench.ts microbenchmark |
| SC-007 | covered | Scheduler 100% branch coverage in tests |
| SC-008 | covered | "100 simulated job lifecycles" property test for dead-letter |
