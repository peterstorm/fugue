// DAG runtime layer barrel export — FR-020

// Types
export type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./types.js";

// Pure transition
export { dagTransition } from "./transition.js";

// Transition helpers (exported for testing / extension)
export {
  handleWaveDone,
  handleNodeFailed,
  handleHumanResponse,
  advanceToNextWave,
  collectHumanReviewQueue,
  computeBackoffMs,
  getRetryLimit,
  waveNodes,
  waveIndexOf,
} from "./transition-helpers.js";

// Machine compiler
export { compileDagToMachine } from "./machine.js";

// Gap-2 fix: re-export topoSort (already returns Result on cycle) for consumers who need it
export { topoSort } from "../executor/topo.js";

// DAG executor closure
export { buildDagExecutor } from "./executor.js";

// runDagStateful orchestrator
export { runDagStateful } from "./run-dag-stateful.js";
export type { DagRunOpts } from "./run-dag-stateful.js";

// Conditional-edge runtime helpers (ADR 0015)
export {
  decideRoute,
  expandActive,
  outgoingOf,
  seedInitialActiveSet,
  type Decision,
} from "./conditional.js";
