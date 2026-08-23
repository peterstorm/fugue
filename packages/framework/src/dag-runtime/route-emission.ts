// route-emission — routing-decision computation + observer event emission.
//
// Extracted from executor.ts for clarity and testability. After all nodes
// in a wave succeed, compute routing decisions for source nodes that have
// conditional out-edges, emit route-decided and node-pruned observer events,
// and return the decisions for inclusion in the wave-done DagEvent.

import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { Confidence } from "../types/confidence.js";
import type { DagEvent } from "./types.js";
import type { Decision } from "./routing.js";
import { decideRoute } from "./routing.js";
import { isConditionalEdge } from "../types/dag.js";
import { emit } from "./emit.js";
import type { PostWaveContext } from "./post-wave-context.js";

/**
 * Result of the routing-decision phase. Contains the per-source-node
 * decisions for the wave-done event, and an optional early-failure event
 * when a predicate is malformed (short-circuits the wave).
 */
interface RoutingPhaseResult {
  /** Per-source-node routing decisions. Empty map when no conditional edges fired. */
  readonly decisions: ReadonlyMap<NodeId, Decision>;
  /** Per-node extracted confidence values for persisting into the transition context. */
  readonly confidenceValues: ReadonlyMap<NodeId, Confidence | null>;
  /** When a predicate is malformed or confidence extraction fails, short-circuit wave. */
  readonly earlyFailure?: Extract<DagEvent, { type: "node-failed" }>;
}

/**
 * Compute routing decisions for all wave nodes that have conditional out-edges.
 * Emits `route-decided` and `node-pruned` observer events for each routing decision.
 */
export function emitRoutingDecisions(
  ctx: PostWaveContext,
  newOutputs: ReadonlyMap<NodeId, unknown>,
): RoutingPhaseResult {
  const { waveNodeIds, nodeMap, nodeCtx, machineCtx, dagId, nowFn } = ctx;
  const stamp = (): Date => new Date(nowFn());
  const routingDecisions = new Map<NodeId, Decision>();
  const confidenceValues = new Map<NodeId, Confidence | null>();

  /**
   * THE one routing-failure emission (round-38 cs-2, replacing three
   * near-copies). Each site differs only in the node it blames, the typed error
   * and the display text.
   */
  const emitNodeError = (
    nodeId: NodeId,
    error: string,
    frameworkError: FrameworkError,
  ): void => {
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId,
      nodeId,
      sideEffects: nodeMap.get(nodeId)?.sideEffects,
      timestamp: stamp(),
      error,
      frameworkError,
    });
  };

  for (const nodeId of waveNodeIds) {
    if (!newOutputs.has(nodeId)) continue;
    const outgoing = machineCtx.outgoingByNode.get(nodeId) ?? [];
    if (!outgoing.some(isConditionalEdge)) continue;

    const output = newOutputs.get(nodeId);

    // Runtime type-safety guard: validate output against the source node's
    // outputSchema before passing it to predicates (which are typed as
    // Predicate<unknown> at runtime due to heterogeneous DAGs). This catches
    // wiring bugs where the wrong node's output reaches a predicate.
    const nodeDef = nodeMap.get(nodeId);
    if (nodeDef) {
      const outputCheck = nodeDef.outputSchema.safeParse(output);
      if (!outputCheck.success) {
        const message = `output schema validation failed before predicate evaluation for node '${nodeId}': ${outputCheck.error.message}`;
        const schemaErr: FrameworkError = { kind: "predicate-malformed", nodeId, message };
        emitNodeError(nodeId, message, schemaErr);
        return {
          decisions: routingDecisions,
          confidenceValues,
          earlyFailure: { type: "node-failed", nodeId, error: schemaErr },
        };
      }
    }

    // Extract upstream confidence from the node definition
    let upstreamConfidence: Confidence | null = null;
    if (nodeDef && nodeDef.confidence.mode === "value") {
      try {
        upstreamConfidence = nodeDef.confidence.extract(newOutputs.get(nodeId));
      } catch (e) {
        const message = `confidence.extract failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`;
        const crashErr: FrameworkError = { kind: "node-crash", nodeId, retriability: "non-retriable", message };
        emitNodeError(nodeId, message, crashErr);
        return {
          decisions: routingDecisions,
          confidenceValues,
          earlyFailure: { type: "node-failed", nodeId, error: crashErr },
        };
      }
    }
    confidenceValues.set(nodeId, upstreamConfidence);

    const decision = decideRoute(nodeId, newOutputs.get(nodeId), outgoing, upstreamConfidence);
    if (decision.kind === "predicate-malformed") {
      const predErr: FrameworkError = {
        kind: "predicate-malformed",
        nodeId: decision.fromNodeId,
        message: decision.message,
      };
      emitNodeError(nodeId, `predicate-malformed: ${decision.message}`, predErr);
      return {
        decisions: routingDecisions,
        confidenceValues,
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

  return { decisions: routingDecisions, confidenceValues };
}
