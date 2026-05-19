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
import type { Decision } from "./routing.js";
import { decideRoute } from "./routing.js";
import { isConditionalEdge } from "../types/dag.js";
import { emit } from "./emit.js";
import type { PostWaveContext } from "./wave-execution.js";

/**
 * Result of the routing-decision phase. Contains the per-source-node
 * decisions for the wave-done event, and an optional early-failure event
 * when a predicate is malformed (short-circuits the wave).
 */
export interface RoutingPhaseResult {
  /** Per-source-node routing decisions. Empty map when no conditional edges fired. */
  readonly decisions: ReadonlyMap<NodeId, Decision>;
  /** Per-node extracted confidence values for persisting into the transition context. */
  readonly confidenceValues: ReadonlyMap<NodeId, Confidence | null>;
  /** When a predicate is malformed or confidence extraction fails, short-circuit wave. */
  readonly earlyFailure?: Extract<DagEvent, { type: "node-failed" }>;
}

/**
 * Compute routing decisions for all wave nodes that have conditional out-edges.
 *
 * Accepts either:
 *   - `(PostWaveContext, newOutputs)` — new compact signature
 *   - `(waveNodeIds, newOutputs, nodeMap, machineCtx, nodeCtx, dagId, nowFn)` — legacy positional
 */
export function emitRoutingDecisions(
  ctx: PostWaveContext,
  newOutputs: ReadonlyMap<NodeId, unknown>,
): RoutingPhaseResult;
export function emitRoutingDecisions(
  waveNodeIds: readonly NodeId[],
  newOutputs: ReadonlyMap<NodeId, unknown>,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  machineCtx: DagMachineContext,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
): RoutingPhaseResult;
export function emitRoutingDecisions(
  ctxOrWaveNodeIds: PostWaveContext | readonly NodeId[],
  newOutputsArg: ReadonlyMap<NodeId, unknown>,
  nodeMapArg?: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  machineCtxArg?: DagMachineContext,
  nodeCtxArg?: NodeContext,
  dagIdArg?: DagId,
  nowFnArg?: () => number,
): RoutingPhaseResult {
  let waveNodeIds: readonly NodeId[];
  let newOutputs: ReadonlyMap<NodeId, unknown>;
  let nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>;
  let machineCtx: DagMachineContext;
  let nodeCtx: NodeContext;
  let dagId: DagId;
  let nowFn: () => number;

  if (Array.isArray(ctxOrWaveNodeIds)) {
    waveNodeIds = ctxOrWaveNodeIds;
    newOutputs = newOutputsArg;
    nodeMap = nodeMapArg!;
    machineCtx = machineCtxArg!;
    nodeCtx = nodeCtxArg!;
    dagId = dagIdArg!;
    nowFn = nowFnArg!;
  } else {
    const ctx = ctxOrWaveNodeIds as PostWaveContext;
    waveNodeIds = ctx.waveNodeIds;
    newOutputs = newOutputsArg;
    nodeMap = ctx.nodeMap;
    machineCtx = ctx.machineCtx;
    nodeCtx = ctx.nodeCtx;
    dagId = ctx.dagId;
    nowFn = ctx.nowFn;
  }

  const stamp = (): Date => new Date(nowFn());
  const routingDecisions = new Map<NodeId, Decision>();
  const confidenceValues = new Map<NodeId, Confidence | null>();

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
        emit(nodeCtx, {
          type: "node-error",
          runId: nodeCtx.runId,
          dagId,
          nodeId,
          sideEffects: nodeDef.sideEffects,
          timestamp: stamp(),
          error: message,
          frameworkError: schemaErr,
        });
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
};
