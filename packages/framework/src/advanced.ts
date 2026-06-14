// @fuguejs/framework/advanced — kernel-mode entrypoints + transition
// primitives for callers building custom machines on top of the framework.
//
// Most consumers should import from `@fuguejs/framework` (which re-exports
// `runDag` as the single recommended entry point). The advanced surface here
// is intentionally a separate path so the main barrel stays minimal and
// signposted: reaching for these is a deliberate decision, not an accident
// from a wildcard import.

export { runDagAsWorkerJob, runResumableDagJob } from "./executor/run-dag.js";
export type { BackgroundResult, StatefulOutcome, WorkerJobOutcome } from "./executor/run-dag.js";

export { compileDagToMachine } from "./dag-runtime/machine.js";
export { buildDagExecutor } from "./dag-runtime/executor.js";
export { dagTransition } from "./dag-runtime/transition.js";

// Persistence bridge (ADR-0060): a durable host wiring a DAG run onto its own
// store (not BullMQ job-data) needs `stripNonPersistable` to seed the initial
// serializable checkpoint envelope. `wrapDagJobLike` re-injects the live
// DAG-derived fields on read, so the persisted context carries plain data only.
export { stripNonPersistable, wrapDagJobLike } from "./dag-runtime/persistence.js";
export type { PersistedDagContext, WrappedDagJobLike } from "./dag-runtime/persistence.js";

/**
 * Topological sort into parallel-executable waves. Returns `Result` on cycle.
 * Use when building custom schedulers or static DAG analyses.
 */
export { topoSort } from "./shared/topo.js";
