// Pure DAG transition function — FR-021
// Covers FR-026..FR-033 via the wave-resolution / retry-policy / human-resolution helpers.

import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import { handleWaveDone } from "./wave-resolution.js";
import { handleNodeFailed, handleHookCrash } from "./retry-policy.js";
import { handleHumanResponse } from "./human-resolution.js";
import { EXECUTOR_NODE_ID } from "./types.js";

/**
 * Pure DAG state transition. No I/O — all branches produce the next (state, context) pair.
 *
 * FR-021: pure, no side effects.
 * FR-026..FR-033: retry logic, sequential HITL, approve/reject/reroute/abort.
 */
export const dagTransition = (
  phase: DagPhase,
  event: DagEvent,
  ctx: DagMachineContext,
): { state: DagPhase; context: DagMachineContext } => {
  // FR-033: abort from any non-terminal state
  if (event.type === "abort") {
    if (phase.kind !== "succeeded" && phase.kind !== "failed") {
      return {
        state: { kind: "failed", error: { kind: "aborted", reason: event.reason } },
        context: ctx,
      };
    }
    // Already terminal — no-op (stay in current state)
    return { state: phase, context: ctx };
  }

  switch (phase.kind) {
    case "pending": {
      if (event.type === "start") {
        return {
          state: { kind: "running", wave: 0 },
          context: ctx,
        };
      }
      // Unexpected event in pending — stay
      return { state: phase, context: ctx };
    }

    case "running": {
      if (event.type === "wave-done") {
        const result = handleWaveDone(event.wave, event.outputs, ctx, event.routingDecisions);
        return { state: result.state, context: result.context };
      }

      if (event.type === "node-failed") {
        const result = handleNodeFailed(phase.wave, event.nodeId, event.error, ctx, event.partialOutputs, event.coFailedNodeIds);
        return { state: result.state, context: result.context };
      }

      if (event.type === "ERROR") {
        // Executor-level error delivered by the kernel loop via classifyError.
        // The boolean retriability flag from the kernel-classifier is mapped
        // onto the structured `retriability` discriminant on the node-crash
        // error so consumers and queue adapters can distinguish a permanent
        // failure (don't retry the job) from a transient one (queue may retry).
        return {
          state: {
            kind: "failed",
            error: {
              kind: "node-crash",
              nodeId: EXECUTOR_NODE_ID,
              message: event.error,
              retriability: event.retriable ? "retriable" : "non-retriable",
            },
          },
          context: ctx,
        };
      }

      // Ignore other events while running
      return { state: phase, context: ctx };
    }

    case "retrying": {
      if (event.type === "wave-done") {
        // After a retry the executor retried the node and the whole wave completed
        const result = handleWaveDone(event.wave, event.outputs, ctx, event.routingDecisions);
        return { state: result.state, context: result.context };
      }

      if (event.type === "node-failed") {
        // Another failure during retry — also pass partial outputs from siblings
        const result = handleNodeFailed(phase.wave, event.nodeId, event.error, ctx, event.partialOutputs, event.coFailedNodeIds);
        return { state: result.state, context: result.context };
      }

      if (event.type === "ERROR") {
        return {
          state: {
            kind: "failed",
            error: {
              kind: "node-crash",
              nodeId: EXECUTOR_NODE_ID,
              message: event.error,
              retriability: event.retriable ? "retriable" : "non-retriable",
            },
          },
          context: ctx,
        };
      }

      return { state: phase, context: ctx };
    }

    case "awaiting-human": {
      if (event.type === "human-responded" && event.nodeId === phase.nodeId) {
        const result = handleHumanResponse(phase, event.action, ctx);
        return { state: result.state, context: result.context };
      }

      // FR-029a: if the onHumanReview hook throws, executor emits node-failed.
      // Retry the hook (not the node) up to the node's retry budget.
      if (event.type === "node-failed") {
        // Guard: ignore node-failed events for a different node (pure transition must not
        // trust the executor to only emit well-scoped events).
        if (event.nodeId !== phase.nodeId) {
          return { state: phase, context: ctx };
        }
        const result = handleHookCrash(
          phase.nodeId, phase.output, phase.prompt, event.error, ctx,
          phase.pendingReviews, phase.wave,
        );
        return { state: result.state, context: result.context };
      }

      if (event.type === "ERROR") {
        // Wrap the ERROR into a node-crash and apply hook-crash retry logic.
        const syntheticError = {
          kind: "node-crash" as const,
          nodeId: phase.nodeId,
          retriability: event.retriable ? "retriable" as const : "non-retriable" as const,
          message: event.error,
        };
        const result = handleHookCrash(
          phase.nodeId, phase.output, phase.prompt, syntheticError, ctx,
          phase.pendingReviews, phase.wave,
        );
        return { state: result.state, context: result.context };
      }

      // Non-human-responded events are ignored in awaiting-human per FR-028 note:
      // "the next review MUST NOT start until the prior is resolved" — any other event is a no-op.
      return { state: phase, context: ctx };
    }

    case "retrying-hook": {
      // Hook recovered: apply the same human-response logic as awaiting-human.
      if (event.type === "human-responded" && event.nodeId === phase.nodeId) {
        // Reconstruct awaiting-human shape so handleHumanResponse can process it.
        // pendingReviews and wave are preserved from the original awaiting-human phase.
        const awaitingState: Extract<DagPhase, { kind: "awaiting-human" }> = {
          kind: "awaiting-human",
          nodeId: phase.nodeId,
          output: phase.output,
          prompt: phase.prompt,
          pendingReviews: phase.pendingReviews,
          wave: phase.wave,
        };
        const result = handleHumanResponse(awaitingState, event.action, ctx);
        return { state: result.state, context: result.context };
      }

      // Hook crashed again — apply retry budget check (preserving pendingReviews + wave).
      if (event.type === "node-failed") {
        // Guard: ignore node-failed events for a different node.
        if (event.nodeId !== phase.nodeId) {
          return { state: phase, context: ctx };
        }
        const result = handleHookCrash(
          phase.nodeId, phase.output, phase.prompt, event.error, ctx,
          phase.pendingReviews, phase.wave,
        );
        return { state: result.state, context: result.context };
      }

      if (event.type === "ERROR") {
        const syntheticError = {
          kind: "node-crash" as const,
          nodeId: phase.nodeId,
          retriability: event.retriable ? "retriable" as const : "non-retriable" as const,
          message: event.error,
        };
        const result = handleHookCrash(
          phase.nodeId, phase.output, phase.prompt, syntheticError, ctx,
          phase.pendingReviews, phase.wave,
        );
        return { state: result.state, context: result.context };
      }

      return { state: phase, context: ctx };
    }

    case "succeeded":
    case "failed": {
      // Terminal — no further transitions
      return { state: phase, context: ctx };
    }

    default: {
      // Exhaustive check — a new DagPhase.kind without a case branch is a compile error.
      const _exhaustive: never = phase;
      return { state: _exhaustive, context: ctx };
    }
  }
};
