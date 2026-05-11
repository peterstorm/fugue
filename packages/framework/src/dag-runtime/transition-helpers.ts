// Pure transition helpers — FR-026..FR-033
// All functions are pure; no I/O.

import type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "./types.js";
import type { FrameworkError } from "../types/errors.js";
import { decideRoute, expandActive, seedInitialActiveSet } from "./conditional.js";
import { isConditionalEdge } from "../types/dag.js";

// ---------------------------------------------------------------------------
// Retry config resolution (FR-026, FR-027)
// ---------------------------------------------------------------------------

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000] as const;

/**
 * Returns the base delay; the DAG executor (Phase 3) applies random jitter via
 * `baseDelay * (1 + jitterRatio * Math.random())`.
 */
export const computeBackoffMs = (
  nodeId: string,
  attempt: number,
  dag: DagMachineContext["dag"],
): number => {
  const nodeDef = dag.nodes.find((n) => n.id === nodeId);
  const backoffMs = nodeDef?.retry?.backoffMs ?? DEFAULT_BACKOFF_MS;

  const baseDelay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? backoffMs[backoffMs.length - 1] ?? 1000;
  return baseDelay;
};

/** Get retry limit for a node (per-node override > DAG default > 0). */
export const getRetryLimit = (nodeId: string, ctx: DagMachineContext): number => {
  const perNode = ctx.dag.retryLimits?.[nodeId];
  if (perNode !== undefined) return perNode;
  return ctx.dag.defaultRetryLimit ?? 0;
};

// ---------------------------------------------------------------------------
// Wave helpers
// ---------------------------------------------------------------------------

/** Return the node-ids in a given wave, sorted ascending (for deterministic review order). */
export const waveNodes = (ctx: DagMachineContext, wave: number): readonly string[] =>
  ctx.waves[wave] ?? [];

/** Active subset of a wave (filters out pruned nodes). */
export const activeWaveNodes = (ctx: DagMachineContext, wave: number): readonly string[] =>
  waveNodes(ctx, wave).filter((id) => ctx.activeNodeIds.has(id));

/** The index of the wave that contains a given nodeId, or -1 if not found. */
export const waveIndexOf = (ctx: DagMachineContext, nodeId: string): number =>
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
): readonly string[] => {
  const nodes = activeWaveNodes(ctx, wave);
  return nodes
    .filter((id) => {
      const def = ctx.dag.nodes.find((n) => n.id === id);
      return def?.humanReview !== undefined;
    })
    .sort(); // ascending node-id order per FR-028
};

// ---------------------------------------------------------------------------
// handleWaveDone — FR-026..FR-028, FR-029 entry
// ---------------------------------------------------------------------------

export interface WaveDoneResult {
  readonly state: DagPhase;
  readonly context: DagMachineContext;
}

/**
 * Called when the executor reports `wave-done` from a `running` state.
 *
 * Precedence:
 * 1. Merge new outputs into context.
 * 2. If there are humanReview nodes, enter `awaiting-human` for the first one.
 * 3. Otherwise advance to next wave or `succeeded`.
 */
export const handleWaveDone = (
  wave: number,
  outputs: ReadonlyMap<string, unknown>,
  ctx: DagMachineContext,
): WaveDoneResult => {
  const newOutputs = new Map([...ctx.outputs, ...outputs]);

  // Evaluate guarded out-edges for every active node that completed this wave.
  // Each successful decision expands `activeNodeIds` along the chosen branch
  // plus its unconditional descendants; a guard that throws fails the run.
  let nextActive = ctx.activeNodeIds;
  for (const nodeId of activeWaveNodes(ctx, wave)) {
    if (!newOutputs.has(nodeId)) continue;
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
    nextActive = expandActive(ctx.dag, nextActive, decision.chosenTargets);
  }

  const newCtx: DagMachineContext = {
    ...ctx,
    outputs: newOutputs,
    activeNodeIds: nextActive,
  };

  const reviewQueue = collectHumanReviewQueue(newCtx, wave);

  if (reviewQueue.length > 0) {
    const [firstNodeId, ...rest] = reviewQueue;
    const nodeDef = newCtx.dag.nodes.find((n) => n.id === firstNodeId);
    if (nodeDef === undefined) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            nodeId: firstNodeId ?? "",
            message: `node-not-found: ${firstNodeId}`,
          },
        },
        context: newCtx,
      };
    }
    const nodeOutput = newOutputs.get(firstNodeId!);

    return {
      state: {
        kind: "awaiting-human",
        nodeId: firstNodeId!,
        output: nodeOutput,
        prompt: nodeDef.humanReview!.prompt,
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
    let fallbackNodeId: string | undefined;
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
            nodeId: "",
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

// ---------------------------------------------------------------------------
// handleNodeFailed — FR-026 retry vs exhausted
// ---------------------------------------------------------------------------

export const handleNodeFailed = (
  currentWave: number,
  nodeId: string,
  error: FrameworkError,
  ctx: DagMachineContext,
  partialOutputs?: ReadonlyMap<string, unknown>,
  coFailedNodeIds?: ReadonlyArray<string>,
): WaveDoneResult => {
  // Fast-fail kinds — deterministic failures that won't resolve on re-execution:
  //   - predicate-malformed: predicate shape invalid against upstream output (config error).
  //   - validation: schema mismatch — re-running produces the same shape.
  //   - checkpoint-write-failed: storage backend broken — retrying writes the same way.
  //   - aborted: caller-initiated cancellation; retrying defeats the cancel intent and
  //     converts the terminal error kind into retry-exhausted, hiding the cancellation.
  //   - node-crash with retriable=false: caller signalled permanent (tool-loop exhaustion,
  //     prompt-defect failures); preserve the retry budget for genuinely transient kinds.
  // Transition straight to terminal failed with the original error preserved.
  if (
    error.kind === "predicate-malformed" ||
    error.kind === "validation" ||
    error.kind === "checkpoint-write-failed" ||
    error.kind === "aborted" ||
    (error.kind === "node-crash" && error.retriable === false)
  ) {
    return {
      state: { kind: "failed", error },
      context: ctx,
    };
  }

  // Merge partial outputs from succeeded siblings so they are not re-run on retry.
  const ctxWithPartials: DagMachineContext =
    partialOutputs && partialOutputs.size > 0
      ? { ...ctx, outputs: new Map([...ctx.outputs, ...partialOutputs]) }
      : ctx;

  // Pre-increment retry counters for co-failed siblings so they consume the same
  // retry slot as the primary failure. Without this, siblings see retries.get(id) === 0
  // on their first re-attempt, giving them retryLimit+1 total executions.
  const ctxWithCoFailed: DagMachineContext =
    coFailedNodeIds && coFailedNodeIds.length > 0
      ? (() => {
          const newRetries = new Map(ctxWithPartials.retries);
          for (const sibId of coFailedNodeIds) {
            const current = newRetries.get(sibId) ?? 0;
            const limit = getRetryLimit(sibId, ctxWithPartials);
            newRetries.set(sibId, Math.min(current + 1, limit));
          }
          return { ...ctxWithPartials, retries: newRetries };
        })()
      : ctxWithPartials;

  const currentAttempts = ctxWithCoFailed.retries.get(nodeId) ?? 0;
  const limit = getRetryLimit(nodeId, ctxWithCoFailed);

  if (currentAttempts < limit) {
    // Still within retry budget — increment and retry
    const newRetries = new Map(ctxWithCoFailed.retries);
    newRetries.set(nodeId, currentAttempts + 1);
    const newCtx: DagMachineContext = { ...ctxWithCoFailed, retries: newRetries };
    const nextDelayMs = computeBackoffMs(nodeId, currentAttempts, ctxWithCoFailed.dag);

    return {
      state: {
        kind: "retrying",
        wave: currentWave,
        nodeId,
        attempt: currentAttempts + 1,
        nextDelayMs,
      },
      context: newCtx,
    };
  }

  // Exhausted — fail the DAG with retry-exhausted error kind. Preserve the
  // underlying error's `kind` on `rootErrorKind` so consumers can tell a
  // rate-limit storm (`transient`) from a deterministic failure (`node-crash`)
  // without parsing `lastError`.
  const lastError =
    error.kind === "node-crash" || error.kind === "transient"
      ? error.message
      : JSON.stringify(error);
  return {
    state: {
      kind: "failed",
      error: {
        kind: "retry-exhausted",
        nodeId,
        attempts: currentAttempts + 1,
        lastError,
        rootErrorKind: error.kind,
      },
    },
    context: ctxWithCoFailed,
  };
};

// ---------------------------------------------------------------------------
// handleHookCrash — FR-029a hook-crash retry semantics
// ---------------------------------------------------------------------------

/**
 * Called when the `onHumanReview` hook throws (from `awaiting-human` or `retrying-hook`).
 *
 * The node's output and prompt are preserved. Retries the hook up to the node's retry
 * budget (shared with node retries). Hook retries do NOT re-execute the node.
 *
 * FR-029a: When `onHumanReview` throws, the framework MUST treat this as a hook crash
 * (NOT a node failure). The node's output and prompt are preserved. The framework SHALL
 * retry the hook up to the node's retry budget with exponential backoff and jitter
 * (same parameters as node retry). When the budget is exhausted, the DAG MUST transition
 * to terminal failed with `node-crash` carrying nodeId and the latest hook error message.
 * Hook retries do NOT re-execute the node.
 */
export const handleHookCrash = (
  nodeId: string,
  output: unknown,
  prompt: string,
  error: FrameworkError,
  ctx: DagMachineContext,
  pendingReviews: readonly string[] = [],
  wave: number = 0,
): WaveDoneResult => {
  const currentAttempts = ctx.retries.get(nodeId) ?? 0;
  const limit = getRetryLimit(nodeId, ctx);

  if (currentAttempts < limit) {
    const newRetries = new Map(ctx.retries);
    newRetries.set(nodeId, currentAttempts + 1);
    const newCtx: DagMachineContext = { ...ctx, retries: newRetries };
    const nextDelayMs = computeBackoffMs(nodeId, currentAttempts, ctx.dag);

    return {
      state: {
        kind: "retrying-hook",
        nodeId,
        output,
        prompt,
        attempt: currentAttempts + 1,
        nextDelayMs,
        pendingReviews,
        wave,
      },
      context: newCtx,
    };
  }

  // Retry budget exhausted — terminal failed with node-crash (FR-029a)
  const message = error.kind === "node-crash" ? error.message : JSON.stringify(error);
  return {
    state: {
      kind: "failed",
      error: {
        kind: "node-crash",
        nodeId,
        message,
      },
    },
    context: ctx,
  };
};

// ---------------------------------------------------------------------------
// handleHumanResponse — FR-029..FR-032
// ---------------------------------------------------------------------------

export const handleHumanResponse = (
  currentState: Extract<DagPhase, { kind: "awaiting-human" }>,
  action: HumanAction,
  ctx: DagMachineContext,
): WaveDoneResult => {
  switch (action.action) {
    case "approve":
      return resolveHumanApproved(currentState, ctx);

    case "approve-with-edit": {
      // Replace the reviewed node's output in the outputs map (FR-029)
      const newOutputs = new Map(ctx.outputs);
      newOutputs.set(currentState.nodeId, action.newOutput);
      const newCtx: DagMachineContext = { ...ctx, outputs: newOutputs };
      return resolveHumanApproved(currentState, newCtx);
    }

    case "reject":
      // FR-030: transition to failed with rejected error
      return {
        state: {
          kind: "failed",
          error: {
            kind: "rejected",
            nodeId: currentState.nodeId,
            reason: action.reason,
          },
        },
        context: ctx,
      };

    case "reroute": {
      const targetWave = waveIndexOf(ctx, action.targetNodeId);

      if (targetWave === -1) {
        // Target node not found — treat as invalid-reroute
        return {
          state: {
            kind: "failed",
            error: {
              kind: "invalid-reroute",
              targetNodeId: action.targetNodeId,
              message: `Reroute target node '${action.targetNodeId}' not found in any wave`,
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
              targetNodeId: action.targetNodeId,
              message: `Cannot reroute forward to wave ${targetWave} (current wave ${currentState.wave})`,
            },
          },
          context: ctx,
        };
      }

      // FR-031: backward (or current wave) reroute — reset completed and resume from target wave.
      // Pre-build the nodeId → waveIndex map so the two filters below are O(N)
      // per pass instead of repeating ctx.waves.findIndex per node (O(N²)).
      const waveByNodeId = new Map<string, number>();
      for (let w = 0; w < ctx.waves.length; w++) {
        for (const id of ctx.waves[w]) waveByNodeId.set(id, w);
      }
      const beforeTargetWave = (nodeId: string): boolean =>
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
          reseededActive = expandActive(ctx.dag, reseededActive, decision.chosenTargets);
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
    }

    default: {
      const _exhaustive: never = action;
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            nodeId: currentState.nodeId,
            message: `Unknown human action: ${(action as HumanAction).action}`,
          },
        },
        context: ctx,
      };
    }
  }
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
    const [nextNodeId, ...rest] = currentState.pendingReviews;
    const nodeDef = ctx.dag.nodes.find((n) => n.id === nextNodeId);
    if (nodeDef === undefined) {
      return {
        state: {
          kind: "failed",
          error: {
            kind: "node-crash",
            nodeId: nextNodeId ?? "",
            message: `node-not-found: ${nextNodeId}`,
          },
        },
        context: ctx,
      };
    }
    const nodeOutput = ctx.outputs.get(nextNodeId!);

    return {
      state: {
        kind: "awaiting-human",
        nodeId: nextNodeId!,
        output: nodeOutput,
        prompt: nodeDef.humanReview!.prompt,
        pendingReviews: rest,
        wave: currentState.wave,
      },
      context: ctx,
    };
  }

  // No more reviews — advance to next wave
  return advanceToNextWave(currentState.wave, ctx);
};
