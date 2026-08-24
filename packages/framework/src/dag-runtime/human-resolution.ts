// Human-resolution helpers — approve / reject / reroute.
// All functions are pure; no I/O, no predicate evaluation.

import { match } from "ts-pattern";
import type { DagPhase, DagMachineContextPersisted, HumanAction } from "./types.js";
import type { NodeId } from "../types/ids.js";
import { freshnessExecutionEpoch } from "../types/witness.js";
import {
  type WaveDoneResult,
  advanceToNextWave,
  waveIndexByNodeId,
  waveIndexOf,
} from "./wave-resolution.js";

// ---------------------------------------------------------------------------
// handleHumanResponse — FR-029..FR-032
// ---------------------------------------------------------------------------

export const handleHumanResponse = (
  currentState: Extract<DagPhase, { kind: "awaiting-human" }>,
  action: HumanAction,
  ctx: DagMachineContextPersisted,
  rerouteActiveSet?: ReadonlySet<NodeId>,
): WaveDoneResult =>
  match(action)
    .with({ kind: "approve" }, () => resolveHumanApproved(currentState, ctx))

    .with({ kind: "approve-with-edit" }, ({ newOutput }) => {
      // Replace the reviewed node's output in the outputs map (FR-029)
      const newOutputs = new Map(ctx.outputs);
      newOutputs.set(currentState.nodeId, newOutput);
      const newCtx: DagMachineContextPersisted = { ...ctx, outputs: newOutputs };
      return resolveHumanApproved(currentState, newCtx);
    })

    // FR-030: reject transitions to failed with `rejected` error
    .with({ kind: "reject" }, ({ reason }): WaveDoneResult => ({
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

    .with({ kind: "reroute" }, ({ targetNodeId }) =>
      handleReroute(currentState, targetNodeId, ctx, rerouteActiveSet),
    )

    .exhaustive();

// ---------------------------------------------------------------------------
// handleReroute — FR-031, FR-032 backward / forward reroute resolution
//
// The active-set computation for reroutes (which requires predicate evaluation)
// is performed by the executor and passed in as `rerouteActiveSet`. The
// transition layer never evaluates predicate closures (ADR-0029).
// ---------------------------------------------------------------------------

const handleReroute = (
  currentState: Extract<DagPhase, { kind: "awaiting-human" }>,
  targetNodeId: NodeId,
  ctx: DagMachineContextPersisted,
  rerouteActiveSet?: ReadonlySet<NodeId>,
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
  const waveByNodeId = waveIndexByNodeId(ctx);
  const beforeTargetWave = (nodeId: NodeId): boolean =>
    (waveByNodeId.get(nodeId) ?? -1) < targetWave;

  const survivingOutputs = new Map(
    [...ctx.outputs].filter(([nodeId]) => beforeTargetWave(nodeId)),
  );

  if (ctx.freshnessExecutionEpoch === Number.MAX_SAFE_INTEGER) {
    return {
      state: {
        kind: "failed",
        error: {
          kind: "node-crash",
          nodeId: currentState.nodeId,
          retriability: "non-retriable",
          message: "freshness execution epoch exhausted; reroute refused",
        },
      },
      context: ctx,
    };
  }

  // The executor precomputes the active set by re-evaluating predicates for
  // prior waves. If not provided (shouldn't happen in normal operation),
  // fall back to the current active set (safe but imprecise).
  const reseededActive = rerouteActiveSet ?? ctx.activeNodeIds;

  const newCtx: DagMachineContextPersisted = {
    ...ctx,
    outputs: survivingOutputs,
    retries: new Map([...ctx.retries].filter(([nodeId]) => beforeTargetWave(nodeId))),
    // Completion proof is valid only for work that survives the reroute.
    // Target/later nodes execute again and therefore owe fresh bookkeeping.
    freshnessCompletedNodeIds: new Set(
      [...ctx.freshnessCompletedNodeIds].filter(beforeTargetWave),
    ),
    // The checkpoint lands before replacement work starts. Bookkeeping retries
    // retain this epoch; another reroute creates a new logical execution.
    freshnessExecutionEpoch: freshnessExecutionEpoch(ctx.freshnessExecutionEpoch + 1),
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
  ctx: DagMachineContextPersisted,
): WaveDoneResult => {
  // If there are more reviews pending in this wave, process the next one
  if (currentState.pendingReviews.length > 0) {
    const nextNodeId = currentState.pendingReviews[0]!;
    const rest = currentState.pendingReviews.slice(1);
    if (!ctx.humanReviewNodeIds.has(nextNodeId)) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            retriability: "retriable",
            nodeId: nextNodeId,
            message: `node '${nextNodeId}' in pendingReviews has no humanReview config`,
          },
        },
        context: ctx,
      };
    }
    const nodeOutput = ctx.outputs.get(nextNodeId);
    const prompt = ctx.humanReviewPrompts.get(nextNodeId) ?? "";

    return {
      state: {
        kind: "awaiting-human",
        nodeId: nextNodeId,
        output: nodeOutput,
        prompt,
        pendingReviews: rest,
        wave: currentState.wave,
      },
      context: ctx,
    };
  }

  // No more reviews — advance to next wave
  return advanceToNextWave(currentState.wave, ctx);
};
