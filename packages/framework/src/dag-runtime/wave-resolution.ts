// Wave-resolution helpers — wave scheduling, HITL bookkeeping, completion tracking.
// All functions are pure; no I/O.

import type { DagPhase, DagMachineContextPersisted } from "./types.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import { expandActive } from "./topology.js";
import type { NodeId } from "../types/ids.js";

// ---------------------------------------------------------------------------
// Shared result shape returned by every transition helper.
// ---------------------------------------------------------------------------

export interface WaveDoneResult {
  readonly state: DagPhase;
  readonly context: DagMachineContextPersisted;
}

// ---------------------------------------------------------------------------
// Wave helpers
// ---------------------------------------------------------------------------

/** Return the node-ids in a given wave, sorted ascending (for deterministic review order). */
export const waveNodes = (ctx: DagMachineContextPersisted, wave: number): readonly NodeId[] =>
  ctx.waves[wave] ?? [];

/** Active subset of a wave (filters out pruned nodes). */
export const activeWaveNodes = (ctx: DagMachineContextPersisted, wave: number): readonly NodeId[] =>
  waveNodes(ctx, wave).filter((id) => ctx.activeNodeIds.has(id));

/** Build the canonical node → wave lookup used by multi-entry filtering passes. */
export const waveIndexByNodeId = (
  ctx: Pick<DagMachineContextPersisted, "waves">,
): ReadonlyMap<NodeId, number> => {
  const index = new Map<NodeId, number>();
  for (let wave = 0; wave < ctx.waves.length; wave += 1) {
    for (const nodeId of ctx.waves[wave] ?? []) index.set(nodeId, wave);
  }
  return index;
};

/** The index of the wave that contains a given nodeId, or -1 if not found. */
export const waveIndexOf = (ctx: DagMachineContextPersisted, nodeId: NodeId): number =>
  ctx.waves.findIndex((w) => w.includes(nodeId));

// ---------------------------------------------------------------------------
// Human-review queue helpers (FR-028)
// ---------------------------------------------------------------------------

/**
 * After a wave completes, collect all humanReview nodes in ascending node-id order.
 * Returns them sorted so we always process them deterministically.
 */
export const collectHumanReviewQueue = (
  ctx: DagMachineContextPersisted,
  wave: number,
): readonly NodeId[] => {
  const nodes = activeWaveNodes(ctx, wave);
  return nodes
    .filter((id) => ctx.humanReviewNodeIds.has(id))
    .sort() as NodeId[];
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
 * `routingDecisions` is the per-source-node routing decision computed once
 * during wave execution (ADR-0029: mandatory, never re-evaluate predicates).
 * The transition reads `chosenTargets` to expand `activeNodeIds`. Nodes
 * without conditional out-edges simply have no entry — expansion is a no-op.
 */
export const handleWaveDone = (
  wave: number,
  outputs: ReadonlyMap<NodeId, unknown>,
  ctx: DagMachineContextPersisted,
  routingDecisions: ReadonlyMap<NodeId, import("./routing.js").Decision>,
): WaveDoneResult => {
  const newOutputs = new Map(ctx.outputs);
  for (const [k, v] of outputs) newOutputs.set(k, v);

  // Expand `activeNodeIds` along guarded out-edges using the executor's
  // precomputed decisions (ADR-0029: mandatory, never re-evaluate predicates).
  let nextActive = ctx.activeNodeIds;
  for (const nodeId of activeWaveNodes(ctx, wave)) {
    if (!newOutputs.has(nodeId)) continue;
    const provided = routingDecisions.get(nodeId);
    if (provided === undefined) continue;
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
    nextActive = expandActive(ctx.unconditionalAdj, nextActive, provided.chosenTargets);
  }

  const newCtx: DagMachineContextPersisted = {
    ...ctx,
    outputs: newOutputs,
    activeNodeIds: nextActive,
  };

  const reviewQueue = collectHumanReviewQueue(newCtx, wave);

  if (reviewQueue.length > 0) {
    const firstNodeId = reviewQueue[0]!;
    const rest = reviewQueue.slice(1);
    if (!newCtx.humanReviewNodeIds.has(firstNodeId)) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            retriability: "retriable",
            nodeId: firstNodeId,
            message: `node '${firstNodeId}' missing humanReview config`,
          },
        },
        context: newCtx,
      };
    }
    // nodeOutput may be `undefined` when a node returns `ok(undefined)` — this
    // is valid per DagPhase.awaiting-human.output: unknown. The human reviewer
    // receives whatever the node produced, including undefined.
    const nodeOutput = newOutputs.get(firstNodeId);
    const prompt = newCtx.humanReviewPrompts.get(firstNodeId);
    if (prompt === undefined) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            retriability: "retriable",
            nodeId: firstNodeId,
            message: `node '${firstNodeId}' missing humanReview prompt`,
          },
        },
        context: newCtx,
      };
    }

    return {
      state: {
        kind: "awaiting-human",
        nodeId: firstNodeId,
        output: nodeOutput,
        prompt,
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
  ctx: DagMachineContextPersisted,
): WaveDoneResult => {
  const nextWave = currentWave + 1;

  if (nextWave >= ctx.waves.length) {
    // All waves done — pick the output
    if (ctx.outputNodeId !== undefined) {
      // Explicit outputNodeId configured — require it to be present in outputs
      const outputNodeId = ctx.outputNodeId;
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
