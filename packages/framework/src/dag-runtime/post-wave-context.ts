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
import type { FrameworkError } from "../types/errors.js";
import type { NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { FreshnessIndex } from "../types/freshness.js";
import type { Witness } from "../types/witness.js";
import { emit } from "./emit.js";

export interface PostWaveContext {
  readonly waveNodeIds: readonly NodeId[];
  readonly nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>;
  readonly nodeCtx: ValidatedNodeContext;
  readonly machineCtx: DagMachineContext;
  readonly dagId: DagId;
  readonly nowFn: () => number;
  readonly freshnessIndex: FreshnessIndex;
  readonly witnessAccumulator?: Map<string, Witness>;
  /**
   * Run-scoped set of nodes whose freshness bookkeeping has already completed
   * in THIS process. Owned by the executor (built once per run, beside
   * `witnessAccumulator`) and read by the freshness step to decide what a wave
   * retry still owes.
   *
   * It exists because "output already present" is NOT the same fact as "witness
   * already recorded": a node carried across a wave retry via `partialOutputs`
   * has produced its output but may never have had its write witness recorded.
   * Conflating the two would let a retry close the wave while silently dropping
   * a write witness (ADR-0025 fail-closed freshness).
   */
  readonly witnessedNodeIds: ReadonlySet<NodeId>;
}

/**
 * Build THE one node-error emission both post-wave steps use. Freshness and
 * routing previously each closed over an identical copy; each call site differs
 * only in the node it blames, the typed error, and the display text.
 */
export const nodeErrorEmitter = (
  ctx: PostWaveContext,
): ((nodeId: NodeId, error: string, frameworkError: FrameworkError) => void) => {
  const { nodeCtx, nodeMap, dagId, nowFn } = ctx;
  return (nodeId, error, frameworkError) => {
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId,
      nodeId,
      sideEffects: nodeMap.get(nodeId)?.sideEffects,
      timestamp: new Date(nowFn()),
      error,
      frameworkError,
    });
  };
};
