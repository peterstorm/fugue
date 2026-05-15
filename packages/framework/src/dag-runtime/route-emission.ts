// route-emission — routing-decision computation + observer event emission.
//
// Extracted from executor.ts for clarity and testability. After all nodes
// in a wave succeed, compute routing decisions for source nodes that have
// conditional out-edges, emit route-decided and node-pruned observer events,
// and return the decisions for inclusion in the wave-done DagEvent.

import type { NodeDef, NodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, DagId } from "../types/ids.js";
import type { Confidence } from "../types/confidence.js";
import type { DagMachineContext, DagEvent } from "./types.js";
import type { Decision } from "./conditional.js";
import { decideRoute } from "./conditional.js";
import { isConditionalEdge } from "../types/dag.js";
import { emit } from "./emit.js";

/**
 * Result of the routing-decision phase. Contains the per-source-node
 * decisions for the wave-done event, and an optional early-failure event
 * when a predicate is malformed (short-circuits the wave).
 */
export interface RoutingPhaseResult {
  /** Per-source-node routing decisions. Empty map when no conditional edges fired. */
  readonly decisions: ReadonlyMap<NodeId, Decision>;
  /** When a predicate is malformed or confidence extraction fails, short-circuit wave. */
  readonly earlyFailure?: Extract<DagEvent, { type: "node-failed" }>;
}

/**
 * Compute routing decisions for all wave nodes that have conditional out-edges.
 * For each such node:
 *   1. Extract upstream confidence from the node definition (with error handling)
 *   2. Call `decideRoute` to evaluate predicates
 *   3. Short-circuit on `predicate-malformed` (config error, not transient)
 *   4. Emit `route-decided` observer event with full evidence
 *   5. Emit `node-pruned` for each pruned target
 *
 * Returns the decisions map for the `wave-done` event, or an early failure
 * event for predicate-malformed errors.
 */
export const emitRoutingDecisions = (
  waveNodeIds: readonly NodeId[],
  newOutputs: ReadonlyMap<NodeId, unknown>,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  machineCtx: DagMachineContext,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
): RoutingPhaseResult => {
  const stamp = (): Date => new Date(nowFn());
  const routingDecisions = new Map<NodeId, Decision>();

  for (const nodeId of waveNodeIds) {
    if (!newOutputs.has(nodeId)) continue;
    const outgoing = machineCtx.outgoingByNode.get(nodeId) ?? [];
    if (!outgoing.some(isConditionalEdge)) continue;

    // Extract upstream confidence from the node definition
    const nodeDef = nodeMap.get(nodeId);
    let upstreamConfidence: Confidence | null = null;
    if (nodeDef && nodeDef.confidence.mode === "value") {
      try {
        upstreamConfidence = nodeDef.confidence.extract(newOutputs.get(nodeId));
      } catch (e) {
        const message = `confidence.extract failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`;
        const crashErr: FrameworkError = { kind: "node-crash", nodeId, retriability: "non-retriable", message };
        emit(nodeCtx, {
          type: "node-error",
          runId: nodeCtx.runId,
          dagId,
          nodeId,
          sideEffects: nodeMap.get(nodeId)?.sideEffects,
          timestamp: stamp(),
          error: message,
          frameworkError: crashErr,
        });
        return {
          decisions: routingDecisions,
          earlyFailure: { type: "node-failed", nodeId, error: crashErr },
        };
      }
    }

    const decision = decideRoute(nodeId, newOutputs.get(nodeId), outgoing, upstreamConfidence);
    if (decision.kind === "predicate-malformed") {
      const predErr: FrameworkError = {
        kind: "predicate-malformed",
        nodeId: decision.fromNodeId,
        message: decision.message,
      };
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId,
        nodeId,
        sideEffects: nodeMap.get(nodeId)?.sideEffects,
        timestamp: stamp(),
        error: `predicate-malformed: ${decision.message}`,
        frameworkError: predErr,
      });
      return {
        decisions: routingDecisions,
        earlyFailure: {
          type: "node-failed",
          nodeId,
          error: predErr,
        },
      };
    }
    routingDecisions.set(nodeId, decision);
    emit(nodeCtx, {
      type: "route-decided",
      runId: nodeCtx.runId,
      dagId,
      fromNodeId: nodeId,
      chosenTargets: [...decision.chosenTargets],
      prunedTargets: [...decision.prunedTargets],
      defaultTaken: decision.defaultTaken,
      evidence: {
        upstreamOutput: newOutputs.get(nodeId),
        upstreamConfidence,
        predicateResults: decision.predicateResults,
        decidedAtMs: nowFn(),
      },
      timestamp: stamp(),
    });
    for (const pruned of decision.prunedTargets) {
      emit(nodeCtx, {
        type: "node-pruned",
        runId: nodeCtx.runId,
        dagId,
        nodeId: pruned,
        reason: "branch-not-taken",
        timestamp: stamp(),
      });
    }
  }

  return { decisions: routingDecisions };
};
