// emitHumanIntervention — human-intervention observer event.
//
// Translates a DAG-layer `HumanAction` into the detailed observer-event shape
// and emits `HumanInterventionEvent`. Called by the executor after
// `callHumanReviewHook` produces a successful `human-responded` event.
//
// Fail-closed: a throwing confidence extractor or a missing `nodeDef` is an
// authoring/framework bug that must surface — return `Err` so the executor
// can convert the human-gate result into a `node-failed` event instead of
// silently producing a misleading observer event.

import { match } from "ts-pattern";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { NodeId, DagId } from "../types/ids.js";
import type { HumanAction } from "./types.js";
import type { HumanActionDetailed } from "../types/events.js";
import type { Confidence } from "../types/confidence.js";
import type { SideEffectKind } from "../types/side-effects.js";
import type { Witness } from "../types/freshness.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import { computeJsonPatch } from "../shared/json-patch.js";
import { fwLogger } from "../logger.js";
import { emit } from "./emit.js";

export const emitHumanIntervention = (
  phase: { nodeId: NodeId; output: unknown },
  action: HumanAction,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
  awaitStartMs: number,
  capturedWitnesses: readonly Witness[],
): Result<void, FrameworkError> => {
  const stamp = (): Date => new Date(nowFn());
  const nodeDef = nodeMap.get(phase.nodeId);

  if (!nodeDef) {
    const msg = `internal: node '${phase.nodeId}' missing from nodeMap during human-intervention emit`;
    fwLogger().error(`[emitHumanIntervention] ${msg}`);
    const fwError: FrameworkError = { kind: "node-crash", nodeId: phase.nodeId, retriability: "non-retriable", message: msg };
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId,
      nodeId: phase.nodeId,
      timestamp: stamp(),
      error: msg,
      frameworkError: fwError,
    });
    return err(fwError);
  }

  const detailed: HumanActionDetailed = match(action)
    .with({ kind: "approve" }, () => ({ kind: "approve" as const }))
    .with({ kind: "approve-with-edit" }, (a) => ({
      kind: "approve-with-edit" as const,
      originalOutput: phase.output,
      replacedOutput: a.newOutput,
      diff: computeJsonPatch(phase.output, a.newOutput),
    }))
    .with({ kind: "reject" }, (a) => ({ kind: "reject" as const, reason: a.reason }))
    .with({ kind: "reroute" }, (a) => ({
      kind: "reroute" as const,
      targetNodeId: a.targetNodeId,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
    }))
    .exhaustive();

  let nodeConfidence: Confidence | null = null;
  if (nodeDef.confidence.mode === "value") {
    try {
      nodeConfidence = nodeDef.confidence.extract(phase.output);
    } catch (e) {
      const msg = `confidence.extract failed for node '${phase.nodeId}': ${e instanceof Error ? e.message : e}`;
      fwLogger().error(`[emitHumanIntervention] ${msg}`);
      const fwError: FrameworkError = { kind: "node-crash", nodeId: phase.nodeId, retriability: "non-retriable", message: msg };
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId,
        nodeId: phase.nodeId,
        sideEffects: nodeDef.sideEffects,
        timestamp: stamp(),
        error: msg,
        frameworkError: fwError,
      });
      return err(fwError);
    }
  }

  const nodeSideEffects: SideEffectKind = nodeDef.sideEffects.kind;

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
  return ok(undefined);
};
