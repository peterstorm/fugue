// reroute.ts — pure helpers for human-review reroute active-set computation.
//
// Pure functions (no I/O) that precompute the active-node set after a reroute
// action, so the pure transition layer never needs to evaluate predicates.
//
// Fail-closed: an invalid reroute target or a malformed predicate produces a
// discriminated error instead of silently falling back to the current active
// set. The executor maps the error to a `node-failed` event.

import type { DagMachineContext, DagEvent } from "./types.js";
import type { NodeId } from "../types/ids.js";
import type { FrameworkError } from "../types/errors.js";
import { isConditionalEdge } from "../types/dag.js";
import { decideRoute } from "./routing.js";
import { expandActive, seedInitialActiveSet } from "./topology.js";

export type RerouteResult =
  | { readonly kind: "ok"; readonly activeSet: ReadonlySet<NodeId> }
  | { readonly kind: "invalid-target"; readonly targetNodeId: NodeId }
  | {
      readonly kind: "predicate-malformed";
      readonly nodeId: NodeId;
      readonly message: string;
    };

export const computeRerouteActiveSet = (
  targetNodeId: NodeId,
  machineCtx: DagMachineContext,
): RerouteResult => {
  const targetWave = machineCtx.waves.findIndex((w) => w.includes(targetNodeId));
  if (targetWave === -1 || targetWave > machineCtx.waves.length - 1) {
    return { kind: "invalid-target", targetNodeId };
  }

  const waveByNodeId = new Map<NodeId, number>();
  for (let w = 0; w < machineCtx.waves.length; w++) {
    for (const id of machineCtx.waves[w]) waveByNodeId.set(id, w);
  }
  const beforeTargetWave = (nodeId: NodeId): boolean =>
    (waveByNodeId.get(nodeId) ?? -1) < targetWave;

  const survivingOutputs = new Map(
    [...machineCtx.outputs].filter(([nodeId]) => beforeTargetWave(nodeId)),
  );

  let reseededActive = seedInitialActiveSet(machineCtx.dag);
  for (let w = 0; w < targetWave; w++) {
    for (const nodeId of machineCtx.waves[w] ?? []) {
      if (!reseededActive.has(nodeId)) continue;
      if (!survivingOutputs.has(nodeId)) continue;
      const outgoing = machineCtx.outgoingByNode.get(nodeId) ?? [];
      if (!outgoing.some(isConditionalEdge)) continue;
      const upstreamConfidence = machineCtx.confidenceByNode.get(nodeId) ?? null;
      const decision = decideRoute(nodeId, survivingOutputs.get(nodeId), outgoing, upstreamConfidence);
      if (decision.kind === "predicate-malformed") {
        return {
          kind: "predicate-malformed",
          nodeId,
          message: decision.message,
        };
      }
      reseededActive = expandActive(machineCtx.unconditionalAdj, reseededActive, decision.chosenTargets);
    }
  }
  return { kind: "ok", activeSet: reseededActive };
};

/**
 * Enrich a human-responded event with `rerouteActiveSet` for reroute actions.
 * Returns the original event with the set attached, or a `FrameworkError` if
 * the active-set computation fails. Called by the executor after receiving a
 * successful human-responded event.
 */
export const enrichHumanRespondedEvent = (
  event: DagEvent,
  machineCtx: DagMachineContext,
):
  | { readonly kind: "ok"; readonly event: DagEvent }
  | { readonly kind: "err"; readonly nodeId: NodeId; readonly error: FrameworkError } => {
  if (event.type !== "human-responded") return { kind: "ok", event };
  if (event.action.action !== "reroute") return { kind: "ok", event };
  const result = computeRerouteActiveSet(event.action.targetNodeId, machineCtx);
  if (result.kind === "ok") {
    return { kind: "ok", event: { ...event, rerouteActiveSet: result.activeSet } };
  }
  if (result.kind === "invalid-target") {
    return {
      kind: "err",
      nodeId: event.nodeId,
      error: {
        kind: "node-crash",
        nodeId: event.nodeId,
        retriability: "non-retriable",
        message: `reroute target '${result.targetNodeId}' not found in DAG waves`,
      },
    };
  }
  return {
    kind: "err",
    nodeId: event.nodeId,
    error: {
      kind: "node-crash",
      nodeId: result.nodeId,
      retriability: "non-retriable",
      message: `reroute active-set computation hit malformed predicate on node '${result.nodeId}': ${result.message}`,
    },
  };
};
