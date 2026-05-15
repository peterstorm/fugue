// emitHumanIntervention — Phase 4: human-intervention observer event
//
// Extracted from executor.ts for readability. Pure event-emission helper
// with no coupling to the executor closure.

import { match } from "ts-pattern";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { NodeId, DagId } from "../types/ids.js";
import type { HumanAction } from "./types.js";
import type { ObserverEvent, HumanActionDetailed } from "../types/events.js";
import type { Observer } from "../observer/observer.js";
import type { Confidence } from "../types/confidence.js";
import type { SideEffectKind } from "../types/side-effects.js";
import type { Witness } from "../types/freshness.js";
import { computeJsonPatch } from "../shared/json-patch.js";
import { dispatchEvent } from "../observer/buffered.js";
import { fwLogger } from "../logger.js";

const emit = (ctx: NodeContext, event: ObserverEvent): void => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};

/**
 * Translate a DAG-layer `HumanAction` into the detailed observer-event
 * shape, then emit `HumanInterventionEvent`. Called in the executor after
 * `callHumanReviewHook` produces a successful `human-responded` event.
 */
export const emitHumanIntervention = (
  phase: { nodeId: NodeId; output: unknown },
  action: HumanAction,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
  awaitStartMs: number,
  capturedWitnesses: readonly Witness[],
): void => {
  const stamp = (): Date => new Date(nowFn());
  const nodeDef = nodeMap.get(phase.nodeId);

  // Build HumanActionDetailed from the DAG-layer HumanAction
  const detailed: HumanActionDetailed = match(action)
    .with({ action: "approve" }, () => ({ kind: "approve" as const }))
    .with({ action: "approve-with-edit" }, (a) => ({
      kind: "approve-with-edit" as const,
      originalOutput: phase.output,
      replacedOutput: a.newOutput,
      diff: computeJsonPatch(phase.output, a.newOutput),
    }))
    .with({ action: "reject" }, (a) => ({ kind: "reject" as const, reason: a.reason }))
    .with({ action: "reroute" }, (a) => ({
      kind: "reroute" as const,
      targetNodeId: a.targetNodeId,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
    }))
    .exhaustive();

  // Extract confidence from the node's output
  let nodeConfidence: Confidence | null = null;
  if (nodeDef && nodeDef.confidence.mode === "value") {
    try {
      nodeConfidence = nodeDef.confidence.extract(phase.output);
    } catch (e) {
      fwLogger().warn(
        `[emitHumanIntervention] confidence.extract failed for node '${phase.nodeId}': ${e instanceof Error ? e.message : e}`,
      );
      nodeConfidence = null;
    }
  }

  // Side-effects kind
  const nodeSideEffects: SideEffectKind = nodeDef?.sideEffects.kind ?? "none";

  emit(nodeCtx, {
    type: "human-intervention",
    runId: nodeCtx.runId,
    dagId,
    nodeId: phase.nodeId,
    action: detailed,
    actor: action.actor ?? "unknown",
    elapsedMsSinceAwait: nowFn() - awaitStartMs,
    context: {
      nodeConfidence,
      nodeSideEffects,
      priorWitnesses: [...capturedWitnesses],
    },
    timestamp: stamp(),
  });
};
