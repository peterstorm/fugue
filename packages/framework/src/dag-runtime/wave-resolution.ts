// Wave-resolution helpers — FR-026..FR-028 wave/HITL bookkeeping.
// All functions are pure; no I/O.

import type { DagPhase, DagMachineContext } from "./types.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import { decideRoute, expandActive } from "./conditional.js";
import { isConditionalEdge } from "../types/dag.js";
import type { NodeId } from "../types/ids.js";

// ---------------------------------------------------------------------------
// Shared result shape returned by every transition helper.
// ---------------------------------------------------------------------------

export interface WaveDoneResult {
  readonly state: DagPhase;
  readonly context: DagMachineContext;
}

// ---------------------------------------------------------------------------
// Wave helpers
// ---------------------------------------------------------------------------

/** Return the node-ids in a given wave, sorted ascending (for deterministic review order). */
export const waveNodes = (ctx: DagMachineContext, wave: number): readonly NodeId[] =>
  ctx.waves[wave] ?? [];

/** Active subset of a wave (filters out pruned nodes). */
export const activeWaveNodes = (ctx: DagMachineContext, wave: number): readonly NodeId[] =>
  waveNodes(ctx, wave).filter((id) => ctx.activeNodeIds.has(id));

/** The index of the wave that contains a given nodeId, or -1 if not found. */
export const waveIndexOf = (ctx: DagMachineContext, nodeId: NodeId): number =>
  ctx.waves.findIndex((w) => w.includes(nodeId));

// ---------------------------------------------------------------------------
// Human-review queue helpers (FR-028)
// ---------------------------------------------------------------------------

/**
 * After a wave completes, collect all humanReview nodes in ascending node-id order.
 * Returns them sorted so we always process them deterministically.
 */
export const collectHumanReviewQueue = (
  ctx: DagMachineContext,
  wave: number,
): readonly NodeId[] => {
  const nodes = activeWaveNodes(ctx, wave);
  return nodes
    .filter((id) => {
      const def = ctx.nodeById.get(id);
      return def?.humanReview !== undefined;
    })
    .sort() as NodeId[]; // ascending node-id order per FR-028
};

// ---------------------------------------------------------------------------
// handleWaveDone — FR-026..FR-028, FR-029 entry
// ---------------------------------------------------------------------------

/**
 * Called when the executor reports `wave-done` from a `running` state.
 *
 * Precedence:
 * 1. Merge new outputs into context.
 * 2. If there are humanReview nodes, enter `awaiting-human` for the first one.
 * 3. Otherwise advance to next wave or `succeeded`.
 *
 * `routingDecisions`, when supplied by the executor, is the per-source-node
 * routing decision computed once during wave execution. The transition reads
 * `chosenTargets` to expand `activeNodeIds` instead of re-evaluating predicates.
 * When omitted (e.g. legacy event-log replays without the field), the
 * transition falls back to recomputing decisions on the fly.
 */
export const handleWaveDone = (
  wave: number,
  outputs: ReadonlyMap<NodeId, unknown>,
  ctx: DagMachineContext,
  routingDecisions?: ReadonlyMap<NodeId, import("./conditional.js").Decision>,
): WaveDoneResult => {
  const newOutputs = new Map(ctx.outputs);
  for (const [k, v] of outputs) newOutputs.set(k, v);

  // Expand `activeNodeIds` along guarded out-edges. Prefer the executor's
  // precomputed decisions to avoid re-evaluating the same predicates twice
  // per wave. Fall back to in-line decideRoute when absent.
  let nextActive = ctx.activeNodeIds;
  for (const nodeId of activeWaveNodes(ctx, wave)) {
    if (!newOutputs.has(nodeId)) continue;
    const provided = routingDecisions?.get(nodeId);
    if (provided !== undefined) {
      if (provided.kind === "predicate-malformed") {
        // Defensive: the executor short-circuits malformed predicates to
        // `node-failed` rather than emitting `wave-done`, so this branch is
        // unreachable in normal operation. Surface it to terminal `failed`
        // anyway in case a hand-crafted event ever carries one through.
        return {
          state: {
            kind: "failed",
            error: {
              kind: "predicate-malformed",
              nodeId: provided.fromNodeId,
              message: provided.message,
            },
          },
          context: { ...ctx, outputs: newOutputs },
        };
      }
      nextActive = expandActive(ctx.dag, nextActive, provided.chosenTargets, ctx.outgoingByNode);
      continue;
    }

    // Fallback: no precomputed decision, evaluate inline.
    const outgoing = ctx.outgoingByNode.get(nodeId) ?? [];
    const hasGuards = outgoing.some(isConditionalEdge);
    if (!hasGuards) continue;
    const decision = decideRoute(nodeId, newOutputs.get(nodeId), outgoing);
    if (decision.kind === "predicate-malformed") {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "predicate-malformed",
            nodeId: decision.fromNodeId,
            message: decision.message,
          },
        },
        context: { ...ctx, outputs: newOutputs },
      };
    }
    nextActive = expandActive(ctx.dag, nextActive, decision.chosenTargets, ctx.outgoingByNode);
  }

  const newCtx: DagMachineContext = {
    ...ctx,
    outputs: newOutputs,
    activeNodeIds: nextActive,
  };

  const reviewQueue = collectHumanReviewQueue(newCtx, wave);

  if (reviewQueue.length > 0) {
    const firstNodeId = reviewQueue[0]!; // length > 0 guarantees defined
    const rest = reviewQueue.slice(1);
    const nodeDef = newCtx.nodeById.get(firstNodeId);
    if (nodeDef === undefined || nodeDef.humanReview === undefined) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            retriability: "retriable",
            nodeId: firstNodeId,
            message: nodeDef === undefined
              ? `node-not-found: ${firstNodeId}`
              : `node '${firstNodeId}' missing humanReview config`,
          },
        },
        context: newCtx,
      };
    }
    const nodeOutput = newOutputs.get(firstNodeId);

    return {
      state: {
        kind: "awaiting-human",
        nodeId: firstNodeId,
        output: nodeOutput,
        prompt: nodeDef.humanReview.prompt,
        pendingReviews: rest,
        wave,
      },
      context: newCtx,
    };
  }

  return advanceToNextWave(wave, newCtx);
};

// ---------------------------------------------------------------------------
// advanceToNextWave — move to next wave or succeed
// ---------------------------------------------------------------------------

export const advanceToNextWave = (
  currentWave: number,
  ctx: DagMachineContext,
): WaveDoneResult => {
  const nextWave = currentWave + 1;

  if (nextWave >= ctx.waves.length) {
    // All waves done — pick the output
    if (ctx.dag.outputNodeId !== undefined) {
      // Explicit outputNodeId configured — require it to be present in outputs
      const outputNodeId = ctx.dag.outputNodeId;
      if (!ctx.outputs.has(outputNodeId)) {
        return {
          state: {
            kind: "failed",
            error: {
              kind: "node-crash",
              retriability: "retriable",
              nodeId: outputNodeId,
              message: `output-missing: outputNodeId '${outputNodeId}' resolved but not found in ctx.outputs`,
            },
          },
          context: ctx,
        };
      }
      return {
        state: { kind: "succeeded", output: ctx.outputs.get(outputNodeId) },
        context: ctx,
      };
    }

    // No outputNodeId configured
    // Fall back to the last active node, walking back through waves so a fully
    // pruned final wave doesn't strand the run.
    let fallbackNodeId: NodeId | undefined;
    for (let w = ctx.waves.length - 1; w >= 0 && !fallbackNodeId; w--) {
      const wave = ctx.waves[w] ?? [];
      for (let i = wave.length - 1; i >= 0; i--) {
        const id = wave[i]!;
        if (ctx.activeNodeIds.has(id) && ctx.outputs.has(id)) {
          fallbackNodeId = id;
          break;
        }
      }
    }
    if (!fallbackNodeId) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            retriability: "retriable",
            nodeId: EXECUTOR_NODE_ID,
            message: "output-missing: outputNodeId unset and no active node produced output",
          },
        },
        context: ctx,
      };
    }
    return {
      state: { kind: "succeeded", output: ctx.outputs.get(fallbackNodeId) },
      context: ctx,
    };
  }

  return {
    state: { kind: "running", wave: nextWave },
    context: ctx,
  };
};
