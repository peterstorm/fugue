// Pure DAG transition function — no I/O, no side effects.
// Covers retry logic, sequential HITL, approve/reject/reroute/abort via the
// wave-resolution / retry-policy / human-resolution helpers.
//
// Uses ts-pattern for exhaustive matching on both DagPhase and DagEvent.
// Adding a new DagPhase.kind or DagEvent.type without handling it here is a
// compile error via `.exhaustive()`.

import { match, P } from "ts-pattern";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import { handleWaveDone } from "./wave-resolution.js";
import { handleNodeFailed, handleHookCrash } from "./retry-policy.js";
import { handleHumanResponse } from "./human-resolution.js";
import { EXECUTOR_NODE_ID } from "./types.js";

type TransitionResult = { state: DagPhase; context: DagMachineContext };
const stay = (phase: DagPhase, ctx: DagMachineContext): TransitionResult => ({ state: phase, context: ctx });

const executorCrash = (event: { error: string; retriable: boolean }, ctx: DagMachineContext): TransitionResult => ({
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
});

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
): TransitionResult =>
  match([phase, event] as const)
    // ─── FR-033: abort from any non-terminal state ──────────────────────
    .with([{ kind: P.not(P.union("succeeded", "failed")) }, { type: "abort" }], ([, e]) => ({
      state: { kind: "failed" as const, error: { kind: "aborted" as const, reason: e.reason } },
      context: ctx,
    }))
    .with([{ kind: P.union("succeeded", "failed") }, { type: "abort" }], ([p]) => stay(p, ctx))

    // ─── pending ────────────────────────────────────────────────────────
    .with([{ kind: "pending" }, { type: "start" }], () => ({
      state: { kind: "running" as const, wave: 0 },
      context: ctx,
    }))
    .with([{ kind: "pending" }, P._], ([p]) => stay(p, ctx))

    // ─── running ────────────────────────────────────────────────────────
    .with([{ kind: "running" }, { type: "wave-done" }], ([, e]) => {
      const r = handleWaveDone(e.wave, e.outputs, ctx, e.routingDecisions);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "running" }, { type: "node-failed" }], ([p, e]) => {
      const r = handleNodeFailed(p.wave, e.nodeId, e.error, ctx, e.partialOutputs, e.coFailedNodeIds);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "running" }, { type: "executor-error" }], ([, e]) => executorCrash(e, ctx))
    .with([{ kind: "running" }, P._], ([p]) => stay(p, ctx))

    // ─── retrying ───────────────────────────────────────────────────────
    .with([{ kind: "retrying" }, { type: "wave-done" }], ([, e]) => {
      const r = handleWaveDone(e.wave, e.outputs, ctx, e.routingDecisions);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "retrying" }, { type: "node-failed" }], ([p, e]) => {
      const r = handleNodeFailed(p.wave, e.nodeId, e.error, ctx, e.partialOutputs, e.coFailedNodeIds);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "retrying" }, { type: "executor-error" }], ([, e]) => executorCrash(e, ctx))
    .with([{ kind: "retrying" }, P._], ([p]) => stay(p, ctx))

    // ─── awaiting-human ─────────────────────────────────────────────────
    .with([{ kind: "awaiting-human" }, { type: "human-responded" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const r = handleHumanResponse(p, e.action, ctx);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "awaiting-human" }, { type: "node-failed" }], ([p, e]) => {
      // FR-029a: hook crash retry. Guard: ignore events for a different node.
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const r = handleHookCrash(p.nodeId, p.output, p.prompt, e.error, ctx, p.pendingReviews, p.wave);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "awaiting-human" }, { type: "executor-error" }], ([p, e]) => {
      const syntheticError = {
        kind: "node-crash" as const,
        nodeId: p.nodeId,
        retriability: e.retriable ? "retriable" as const : "non-retriable" as const,
        message: e.error,
      };
      const r = handleHookCrash(p.nodeId, p.output, p.prompt, syntheticError, ctx, p.pendingReviews, p.wave);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "awaiting-human" }, P._], ([p]) => stay(p, ctx))

    // ─── retrying-hook ──────────────────────────────────────────────────
    .with([{ kind: "retrying-hook" }, { type: "human-responded" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const awaitingState: Extract<DagPhase, { kind: "awaiting-human" }> = {
        kind: "awaiting-human",
        nodeId: p.nodeId,
        output: p.output,
        prompt: p.prompt,
        pendingReviews: p.pendingReviews,
        wave: p.wave,
      };
      const r = handleHumanResponse(awaitingState, e.action, ctx);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "retrying-hook" }, { type: "node-failed" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const r = handleHookCrash(p.nodeId, p.output, p.prompt, e.error, ctx, p.pendingReviews, p.wave);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "retrying-hook" }, { type: "executor-error" }], ([p, e]) => {
      const syntheticError = {
        kind: "node-crash" as const,
        nodeId: p.nodeId,
        retriability: e.retriable ? "retriable" as const : "non-retriable" as const,
        message: e.error,
      };
      const r = handleHookCrash(p.nodeId, p.output, p.prompt, syntheticError, ctx, p.pendingReviews, p.wave);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "retrying-hook" }, P._], ([p]) => stay(p, ctx))

    // ─── terminal states ────────────────────────────────────────────────
    .with([{ kind: "succeeded" }, P._], ([p]) => stay(p, ctx))
    .with([{ kind: "failed" }, P._], ([p]) => stay(p, ctx))

    .exhaustive();
