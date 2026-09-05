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
import type { Capability, NodeContext, NodeDef, ValidatedNodeContext } from "../types/node.js";
import type { FreshnessIndex } from "../types/freshness.js";
import type { Witness } from "../types/witness.js";
import { emit } from "./emit.js";
import { bestEffort } from "./best-effort.js";

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
 * Exactly what a `node-error` emission needs. Narrower than `PostWaveContext`
 * (and asking only for a `NodeContext`, not a validated one) so callers outside
 * the post-wave pipeline — the executor's human-review gate — can use the same
 * emitter instead of hand-rolling a third copy of the event shape.
 */
export interface NodeErrorContext {
  readonly nodeCtx: NodeContext;
  readonly nodeMap: ReadonlyMap<
    NodeId,
    NodeDef<unknown, unknown, FrameworkError, readonly Capability[]>
  >;
  readonly dagId: DagId;
  readonly nowFn: () => number;
}

/**
 * Build THE one node-error emission. Freshness and routing previously each
 * closed over an identical copy; the executor's human-review gate closed over a
 * third that had already drifted (it carried a `stack` the others did not), so
 * `stack` is a parameter here rather than a reason to keep a separate copy.
 *
 * Fenced with `bestEffort`: `new Date(nowFn())` is evaluated as an ARGUMENT, so
 * a hostile clock throws before `emit`/`dispatchEvent` is entered. Every caller
 * is on a path where the typed error it is about to return is the authoritative
 * outcome — and the executor's is a `catch` handler, where an escaping throw
 * would replace the failure it is reporting (`best-effort.ts`).
 */
export const nodeErrorEmitter = (
  ctx: NodeErrorContext,
): ((
  nodeId: NodeId,
  error: string,
  frameworkError: FrameworkError,
  stack?: string,
) => void) => {
  const { nodeCtx, nodeMap, dagId, nowFn } = ctx;
  return (nodeId, error, frameworkError, stack) => {
    bestEffort("nodeErrorEmitter", "node-error emission", () =>
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId,
        nodeId,
        sideEffects: nodeMap.get(nodeId)?.sideEffects,
        timestamp: new Date(nowFn()),
        error,
        ...(stack !== undefined ? { stack } : {}),
        frameworkError,
      }),
    );
  };
};
