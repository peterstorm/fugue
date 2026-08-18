/**
 * The per-wave context the post-dispatch pipeline consumes.
 *
 * This is the record `deepening-plan.md` Step 3 introduced to replace 10- and
 * 7-parameter positional calls. It lives in its own leaf rather than in
 * `wave-execution.ts` because both emission modules need it: `wave-execution`
 * imports their emit functions, and they imported this type back, so the module
 * that orchestrates the pipeline was in a cycle with each of its own steps.
 *
 * Nothing here imports a pipeline step, so those cycles cannot return.
 */
import type { DagMachineContext } from "./types.js";

import type { DagId, NodeId } from "../types/ids.js";
import type { NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { FreshnessIndex } from "../types/freshness.js";
import type { Witness } from "../types/witness.js";

export interface PostWaveContext {
  readonly waveNodeIds: readonly NodeId[];
  readonly nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>;
  readonly nodeCtx: ValidatedNodeContext;
  readonly machineCtx: DagMachineContext;
  readonly dagId: DagId;
  readonly nowFn: () => number;
  readonly freshnessIndex: FreshnessIndex;
  readonly witnessAccumulator?: Map<string, Witness>;
  readonly resumeCheckpoint?: Map<string, unknown>;
  readonly priorOutputs: ReadonlyMap<NodeId, unknown>;
}
