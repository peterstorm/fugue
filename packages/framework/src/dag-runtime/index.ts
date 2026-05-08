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

// DAG executor closure (Phase 3a)
export { buildDagExecutor } from "./executor.js";

// runDagStateful orchestrator (Phase 3a)
export { runDagStateful } from "./run-dag-stateful.js";
export type { DagRunOpts } from "./run-dag-stateful.js";
