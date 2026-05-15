// Retry-policy helpers — FR-026 (retry budget) + FR-027 (backoff) + FR-029a (hook crash).
// All functions are pure; no I/O.

import type { DagMachineContext } from "./types.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import type { WaveDoneResult } from "./wave-resolution.js";

// ---------------------------------------------------------------------------
// Retry config resolution (FR-026, FR-027)
// ---------------------------------------------------------------------------

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000] as const;

/**
 * Returns the base delay; the DAG executor applies random jitter via
 * `baseDelay * (1 + jitterRatio * Math.random())`.
 */
export const computeBackoffMs = (
  nodeId: NodeId,
  attempt: number,
  dag: DagMachineContext["dag"],
  nodeById?: ReadonlyMap<NodeId, import("../types/node.js").NodeDef<unknown, unknown>>,
): number => {
  const nodeDef = nodeById?.get(nodeId) ?? dag.nodes.find((n) => n.id === nodeId);
  const backoffMs = nodeDef?.retry?.backoffMs ?? DEFAULT_BACKOFF_MS;

  const baseDelay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? backoffMs[backoffMs.length - 1] ?? 1000;
  return baseDelay;
};

/** Get retry limit for a node (per-node override > DAG default > 0). */
export const getRetryLimit = (nodeId: NodeId, ctx: DagMachineContext): number => {
  const perNode = ctx.dag.retryLimits?.[nodeId];
  if (perNode !== undefined) return perNode;
  return ctx.dag.defaultRetryLimit ?? 0;
};

// ---------------------------------------------------------------------------
// handleNodeFailed — FR-026 retry vs exhausted
// ---------------------------------------------------------------------------

export const handleNodeFailed = (
  currentWave: number,
  nodeId: NodeId,
  error: FrameworkError,
  ctx: DagMachineContext,
  partialOutputs?: ReadonlyMap<NodeId, unknown>,
  coFailedNodeIds?: ReadonlyArray<NodeId>,
): WaveDoneResult => {
  // Fast-fail kinds — deterministic failures that won't resolve on re-execution:
  //   - predicate-malformed: predicate shape invalid against upstream output (config error).
  //   - validation: schema mismatch — re-running produces the same shape.
  //   - checkpoint-write-failed: storage backend broken — retrying writes the same way.
  //   - aborted: caller-initiated cancellation; retrying defeats the cancel intent and
  //     converts the terminal error kind into retry-exhausted, hiding the cancellation.
  //   - node-crash with retriability="non-retriable": caller signalled permanent
  //     (tool-loop exhaustion, prompt-defect failures); preserve the retry budget
  //     for genuinely transient kinds.
  // Transition straight to terminal failed with the original error preserved.
  if (
    error.kind === "predicate-malformed" ||
    error.kind === "validation" ||
    error.kind === "checkpoint-write-failed" ||
    error.kind === "aborted" ||
    (error.kind === "node-crash" && error.retriability === "non-retriable")
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
    const nextDelayMs = computeBackoffMs(nodeId, currentAttempts, ctxWithCoFailed.dag, ctxWithCoFailed.nodeById);

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
  nodeId: NodeId,
  output: unknown,
  prompt: string,
  error: FrameworkError,
  ctx: DagMachineContext,
  pendingReviews: readonly NodeId[] = [],
  wave: number = 0,
): WaveDoneResult => {
  const currentAttempts = ctx.retries.get(nodeId) ?? 0;
  const limit = getRetryLimit(nodeId, ctx);

  if (currentAttempts < limit) {
    const newRetries = new Map(ctx.retries);
    newRetries.set(nodeId, currentAttempts + 1);
    const newCtx: DagMachineContext = { ...ctx, retries: newRetries };
    const nextDelayMs = computeBackoffMs(nodeId, currentAttempts, ctx.dag, ctx.nodeById);

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

  // Retry budget exhausted — use `retry-exhausted` (same shape as handleNodeFailed)
  // so consumers have one discriminant for all budget-exhaustion cases.
  const lastError = error.kind === "node-crash" || error.kind === "transient"
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
    context: ctx,
  };
};
