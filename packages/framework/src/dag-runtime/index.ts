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

// runDagStateful is the internal kernel-mode entry point. It is reachable via
// direct file imports (`dag-runtime/run-dag-stateful.js`) for tests and the
// public wrapper in `executor/run-dag.ts`. It is intentionally NOT re-exported
// from this barrel — the public surface for orchestrator concerns is `runDag`.

// Freshness witness contract
// `checkFreshness` is deliberately NOT exported: it is the batch/forensic form
// of the rule the runtime applies incrementally via `InMemoryFreshnessIndex`,
// kept as the differential oracle for the property test (see its module header).
export { InMemoryFreshnessIndex } from "./freshness-check.js";
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
