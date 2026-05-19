// DAG runtime layer barrel export

// Types
export type {
  DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanAction,
  DagTopology, DagRetryState, DagHumanGateConfig, DagRoutingState,
} from "./types.js";

// Pure transition
export { dagTransition } from "./transition.js";

// Transition helpers (exported for testing / extension)
export {
  handleWaveDone,
  advanceToNextWave,
  collectHumanReviewQueue,
  waveNodes,
  waveIndexOf,
} from "./wave-resolution.js";
export { handleNodeFailed, computeBackoffMs, getRetryLimit } from "./retry-policy.js";
export { handleHumanResponse } from "./human-resolution.js";

// Machine compiler
export { compileDagToMachine } from "./machine.js";

// Re-export topoSort for consumers building custom static analyses (returns Result on cycle)
export { topoSort } from "../shared/topo.js";

// DAG executor closure
export { buildDagExecutor } from "./executor.js";

// runDagStateful orchestrator — re-exported via executor/run-dag.ts and advanced.ts.
// Direct imports from this file remain valid for internal use.
export { runDagStateful } from "./run-dag-stateful.js";
export type { DagRunOpts } from "./run-dag-stateful.js";

// Freshness witness contract (Phase 3)
export { checkFreshness, InMemoryFreshnessIndex } from "./freshness-check.js";
export type { FreshnessIndex, FreshnessConflict, FreshnessCheckResult, WriteEntry } from "./freshness-check.js";

// Routing decision logic (ADR 0015)
export {
  decideRoute,
  evaluatePredicate,
  type Decision,
} from "./routing.js";

// Topology helpers
export {
  expandActive,
  outgoingOf,
  seedInitialActiveSet,
} from "./topology.js";
