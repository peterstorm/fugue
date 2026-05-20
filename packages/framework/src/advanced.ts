// @ai-summary/framework/advanced — kernel-mode entrypoints + transition
// primitives for callers building custom machines on top of the framework.
//
// Most consumers should import from `@ai-summary/framework` (which re-exports
// `runDag` as the single recommended entry point). The advanced surface here
// is intentionally a separate path so the main barrel stays minimal and
// signposted: reaching for these is a deliberate decision, not an accident
// from a wildcard import.

export { runDagAsWorkerJob } from "./executor/run-dag.js";
export type { BackgroundResult } from "./executor/run-dag.js";

export { compileDagToMachine } from "./dag-runtime/machine.js";
export { buildDagExecutor } from "./dag-runtime/executor.js";
export { dagTransition } from "./dag-runtime/transition.js";

/**
 * Topological sort into parallel-executable waves. Returns `Result` on cycle.
 * Use when building custom schedulers or static DAG analyses.
 */
export { topoSort } from "./shared/topo.js";
