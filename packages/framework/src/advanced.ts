// @ai-summary/framework/advanced — kernel-mode entrypoints + transition
// primitives for callers building custom machines on top of the framework.
//
// Most consumers should import from `@ai-summary/framework` (which re-exports
// `runDag` as the single recommended entry point). The advanced surface here
// is intentionally a separate path so the main barrel stays minimal and
// signposted: reaching for these is a deliberate decision, not an accident
// from a wildcard import.

export { runDagStateful, runDagAsWorkerJob } from "./dag-runtime/run-dag-stateful.js";
export type { DagRunOpts, BackgroundResult } from "./dag-runtime/run-dag-stateful.js";

export { compileDagToMachine } from "./dag-runtime/machine.js";
export { buildDagExecutor } from "./dag-runtime/executor.js";
export { dagTransition } from "./dag-runtime/transition.js";

// Internal topology helper. Re-exported here for callers building custom
// schedulers / static analyses on top of a DagDef. Not on the main barrel —
// most consumers never need it.
export { topoSort } from "./shared/topo.js";
