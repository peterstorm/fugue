// Human-resolution helpers — approve / reject / reroute.
// All functions are pure; no I/O.

import { match } from "ts-pattern";
import type { DagPhase, DagMachineContext, HumanAction } from "./types.js";
import { decideRoute, expandActive, seedInitialActiveSet } from "./conditional.js";
import { isConditionalEdge } from "../types/dag.js";
import type { NodeId } from "../types/ids.js";
import {
  type WaveDoneResult,
  advanceToNextWave,
  waveIndexOf,
} from "./wave-resolution.js";

// ---------------------------------------------------------------------------
// handleHumanResponse — FR-029..FR-032
// ---------------------------------------------------------------------------

export const handleHumanResponse = (
  currentState: Extract<DagPhase, { kind: "awaiting-human" }>,
  action: HumanAction,
  ctx: DagMachineContext,
): WaveDoneResult =>
  match(action)
    .with({ action: "approve" }, () => resolveHumanApproved(currentState, ctx))

    .with({ action: "approve-with-edit" }, ({ newOutput }) => {
      // Replace the reviewed node's output in the outputs map (FR-029)
      const newOutputs = new Map(ctx.outputs);
      newOutputs.set(currentState.nodeId, newOutput);
      const newCtx: DagMachineContext = { ...ctx, outputs: newOutputs };
      return resolveHumanApproved(currentState, newCtx);
    })

    // FR-030: reject transitions to failed with `rejected` error
    .with({ action: "reject" }, ({ reason }): WaveDoneResult => ({
      state: {
        kind: "failed",
        error: {
          kind: "rejected",
          nodeId: currentState.nodeId,
          reason,
        },
      },
      context: ctx,
    }))

    .with({ action: "reroute" }, ({ targetNodeId }) =>
      handleReroute(currentState, targetNodeId, ctx),
    )

    .exhaustive();

// ---------------------------------------------------------------------------
// handleReroute — FR-031, FR-032 backward / forward reroute resolution
// ---------------------------------------------------------------------------

const handleReroute = (
  currentState: Extract<DagPhase, { kind: "awaiting-human" }>,
  targetNodeId: NodeId,
  ctx: DagMachineContext,
): WaveDoneResult => {
  const targetWave = waveIndexOf(ctx, targetNodeId);

  if (targetWave === -1) {
    // Target node not found — treat as invalid-reroute
    return {
      state: {
        kind: "failed",
        error: {
          kind: "invalid-reroute",
          targetNodeId,
          message: `Reroute target node '${targetNodeId}' not found in any wave`,
        },
      },
      context: ctx,
    };
  }

  if (targetWave > currentState.wave) {
    // FR-032: forward reroute — invalid
    return {
      state: {
        kind: "failed",
        error: {
          kind: "invalid-reroute",
          targetNodeId,
          message: `Cannot reroute forward to wave ${targetWave} (current wave ${currentState.wave})`,
        },
      },
      context: ctx,
    };
  }

  // FR-031: backward (or current wave) reroute — reset completed and resume from target wave.
  // Pre-build the nodeId → waveIndex map so the two filters below are O(N)
  // per pass instead of repeating ctx.waves.findIndex per node (O(N²)).
  const waveByNodeId = new Map<NodeId, number>();
  for (let w = 0; w < ctx.waves.length; w++) {
    for (const id of ctx.waves[w]) waveByNodeId.set(id, w);
  }
  const beforeTargetWave = (nodeId: NodeId): boolean =>
    (waveByNodeId.get(nodeId) ?? -1) < targetWave;

  // Recompute activeNodeIds from the seed and re-expand using outputs that
  // survived the reroute (waves < targetWave). Guard decisions for those
  // earlier nodes are deterministic — same outputs, same guards, same
  // chosen targets — so the active set converges to the pre-reroute value
  // for all nodes in waves < targetWave.
  const survivingOutputs = new Map(
    [...ctx.outputs].filter(([nodeId]) => beforeTargetWave(nodeId)),
  );
  let reseededActive = seedInitialActiveSet(ctx.dag);
  for (let w = 0; w < targetWave; w++) {
    for (const nodeId of ctx.waves[w] ?? []) {
      if (!reseededActive.has(nodeId)) continue;
      if (!survivingOutputs.has(nodeId)) continue;
      const outgoing = ctx.outgoingByNode.get(nodeId) ?? [];
      if (!outgoing.some(isConditionalEdge)) continue;
      const decision = decideRoute(nodeId, survivingOutputs.get(nodeId), outgoing);
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
          context: ctx,
        };
      }
      reseededActive = expandActive(ctx.dag, reseededActive, decision.chosenTargets, ctx.outgoingByNode);
    }
  }

  const newCtx: DagMachineContext = {
    ...ctx,
    outputs: survivingOutputs,
    retries: new Map([...ctx.retries].filter(([nodeId]) => beforeTargetWave(nodeId))),
    activeNodeIds: reseededActive,
  };

  return {
    state: { kind: "running", wave: targetWave },
    context: newCtx,
  };
};

// ---------------------------------------------------------------------------
// resolveHumanApproved — FR-029 helper
// ---------------------------------------------------------------------------

const resolveHumanApproved = (
  currentState: Extract<DagPhase, { kind: "awaiting-human" }>,
  ctx: DagMachineContext,
): WaveDoneResult => {
  // If there are more reviews pending in this wave, process the next one
  if (currentState.pendingReviews.length > 0) {
    const nextNodeId = currentState.pendingReviews[0]!; // length > 0 guarantees defined
    const rest = currentState.pendingReviews.slice(1);
    const nodeDef = ctx.nodeById.get(nextNodeId);
    if (nodeDef === undefined || nodeDef.humanReview === undefined) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            retriability: "retriable",
            nodeId: nextNodeId,
            message: nodeDef === undefined
              ? `node-not-found: ${nextNodeId}`
              : `node '${nextNodeId}' in pendingReviews has no humanReview config`,
          },
        },
        context: ctx,
      };
    }
    const nodeOutput = ctx.outputs.get(nextNodeId);

    return {
      state: {
        kind: "awaiting-human",
        nodeId: nextNodeId,
        output: nodeOutput,
        prompt: nodeDef.humanReview.prompt,
        pendingReviews: rest,
        wave: currentState.wave,
      },
      context: ctx,
    };
  }

  // No more reviews — advance to next wave
  return advanceToNextWave(currentState.wave, ctx);
};
