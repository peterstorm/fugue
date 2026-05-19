// reroute.ts — pure helpers for human-review reroute active-set computation.
//
// Extracted from executor.ts for locality. These are pure functions (no I/O)
// that precompute the active-node set after a reroute action, so the pure
// transition layer never needs to evaluate predicates.

import type { DagMachineContext, DagEvent } from "./types.js";
import type { NodeId } from "../types/ids.js";
import { isConditionalEdge } from "../types/dag.js";
import { decideRoute, expandActive, seedInitialActiveSet } from "./conditional.js";

// ---------------------------------------------------------------------------
// computeRerouteActiveSet — precompute the active-node set for reroute actions.
// Called by the executor so the pure transition never evaluates predicates.
// ---------------------------------------------------------------------------

export const computeRerouteActiveSet = (
  targetNodeId: NodeId,
  machineCtx: DagMachineContext,
): ReadonlySet<NodeId> | undefined => {
  const targetWave = machineCtx.waves.findIndex((w) => w.includes(targetNodeId));
  if (targetWave === -1 || targetWave > (machineCtx.waves.length - 1)) return undefined;

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
        // On malformed predicate, return undefined — the transition will
        // fall back to its current active set (safe but imprecise).
        return undefined;
      }
      reseededActive = expandActive(machineCtx.unconditionalAdj, reseededActive, decision.chosenTargets);
    }
  }
  return reseededActive;
};

/**
 * Enrich a human-responded event with `rerouteActiveSet` for reroute actions.
 * Called by the executor after receiving a successful human-responded event.
 */
export const enrichHumanRespondedEvent = (
  event: DagEvent,
  machineCtx: DagMachineContext,
): DagEvent => {
  if (event.type !== "human-responded") return event;
  if (event.action.action !== "reroute") return event;
  const rerouteActiveSet = computeRerouteActiveSet(event.action.targetNodeId, machineCtx);
  return { ...event, rerouteActiveSet };
};
