/**
 * The per-wave context the post-dispatch pipeline consumes.
 *
 * This record replaces the post-dispatch pipeline's former 10- and 7-parameter
 * positional calls. It lives in its own leaf rather than in
 * `wave-execution.ts` because both emission modules need it: `wave-execution`
 * imports their emit functions, and they imported this type back, so the module
 * that orchestrates the pipeline was in a cycle with each of its own steps.
 *
 * Nothing here imports a pipeline step, so those cycles cannot return.
 */
import type { DagMachineContext } from "./types.js";

import type { DagId, NodeId } from "../types/ids.js";
import type { FrameworkError } from "../types/errors.js";
import type { Capability, NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { FreshnessIndex } from "../types/freshness.js";
import type { Witness } from "../types/witness.js";
import { emit } from "./emit.js";

export interface PostWaveContext {
  readonly waveNodeIds: readonly NodeId[];
  readonly nodeMap: ReadonlyMap<
    NodeId,
    NodeDef<unknown, unknown, FrameworkError, readonly Capability[]>
  >;
  readonly nodeCtx: ValidatedNodeContext;
  readonly machineCtx: DagMachineContext;
  readonly dagId: DagId;
  readonly nowFn: () => number;
  readonly freshnessIndex: FreshnessIndex;
  readonly witnessAccumulator?: Map<string, Witness>;
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
