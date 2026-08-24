// Pure DAG transition function - no I/O, no side effects.
// Covers retry logic, sequential HITL, approve/reject/reroute/abort via the
// wave-resolution / retry-policy / human-resolution helpers.
//
// Uses ts-pattern for exhaustive matching on both DagPhase and DagEvent.
// Adding a new DagPhase.kind or DagEvent.type without handling it here is a
// compile error via `.exhaustive()`.

import { match, P } from "ts-pattern";
import type { DagPhase, DagEvent, DagMachineContextPersisted, HumanGatePayload } from "./types.js";
import { handleWaveDone } from "./wave-resolution.js";
import { handleNodeFailed, handleHookCrash } from "./retry-policy.js";
import { handleHumanResponse } from "./human-resolution.js";
import { EXECUTOR_NODE_ID } from "./types.js";
import type { Confidence } from "../types/confidence.js";
import type { NodeId } from "../types/ids.js";
import type { Witness } from "../types/witness.js";

type TransitionResult = { state: DagPhase; context: DagMachineContextPersisted };
const stay = (phase: DagPhase, ctx: DagMachineContextPersisted): TransitionResult => ({ state: phase, context: ctx });

// Project any gate-bearing phase onto another gate phase. Because `awaiting-human`,
// `suspended`, and `retrying-hook` all carry the same `HumanGatePayload`, these
// take that shared shape and copy exactly the five payload fields — dropping any
// extra (e.g. `retrying-hook`'s retry bookkeeping) so the rebuilt phase is clean.
const asAwaitingHuman = (p: HumanGatePayload): Extract<DagPhase, { kind: "awaiting-human" }> => ({
  kind: "awaiting-human",
  nodeId: p.nodeId,
  output: p.output,
  prompt: p.prompt,
  pendingReviews: p.pendingReviews,
  wave: p.wave,
});
const asSuspended = (p: HumanGatePayload): Extract<DagPhase, { kind: "suspended" }> => ({
  kind: "suspended",
  nodeId: p.nodeId,
  output: p.output,
  prompt: p.prompt,
  pendingReviews: p.pendingReviews,
  wave: p.wave,
});

/** Merge new confidence values into the context's accumulated map. Pure. */
const mergeConfidence = (
  ctx: DagMachineContextPersisted,
  values: ReadonlyMap<NodeId, Confidence | null> | undefined,
): DagMachineContextPersisted => {
  if (!values || values.size === 0) return ctx;
  const merged = new Map(ctx.confidenceByNode);
  for (const [k, v] of values) merged.set(k, v);
  return { ...ctx, confidenceByNode: merged };
};

/** Replace durable freshness projections when an executor event carries them. */
const mergeFreshnessProgress = (
  ctx: DagMachineContextPersisted,
  values: {
    readonly priorWitnesses?: ReadonlyMap<string, Witness>;
    readonly freshnessCompletedNodeIds?: ReadonlySet<NodeId>;
  },
): DagMachineContextPersisted => {
  if (values.priorWitnesses === undefined && values.freshnessCompletedNodeIds === undefined) {
    return ctx;
  }
  return {
    ...ctx,
    priorWitnesses: values.priorWitnesses === undefined
      ? ctx.priorWitnesses
      : new Map(values.priorWitnesses),
    freshnessCompletedNodeIds: values.freshnessCompletedNodeIds === undefined
      ? ctx.freshnessCompletedNodeIds
      : new Set(values.freshnessCompletedNodeIds),
  };
};

const executorCrash = (event: { error: string; retriable: boolean }, ctx: DagMachineContextPersisted): TransitionResult => ({
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
 * Pure DAG state transition. No I/O - all branches produce the next (state, context) pair.
 *
 * FR-021: pure transition function, no side effects.
 * FR-026..FR-033: retry logic, sequential HITL, approve/reject/reroute/abort.
 */
export const dagTransition = (
  phase: DagPhase,
  event: DagEvent,
  ctx: DagMachineContextPersisted,
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
      const updatedCtx = mergeConfidence(
        mergeFreshnessProgress(ctx, e),
        e.confidenceValues,
      );
      const r = handleWaveDone(e.wave, e.outputs, updatedCtx, e.routingDecisions);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "running" }, { type: "node-failed" }], ([p, e]) => {
      const updatedCtx = mergeFreshnessProgress(ctx, e);
      const r = handleNodeFailed(p.wave, e.nodeId, e.error, updatedCtx, e.partialOutputs, e.coFailedNodeIds);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "running" }, { type: "executor-error" }], ([, e]) => executorCrash(e, ctx))
    .with([{ kind: "running" }, P._], ([p]) => stay(p, ctx))

    // ─── retrying ───────────────────────────────────────────────────────
    .with([{ kind: "retrying" }, { type: "wave-done" }], ([, e]) => {
      const updatedCtx = mergeConfidence(
        mergeFreshnessProgress(ctx, e),
        e.confidenceValues,
      );
      const r = handleWaveDone(e.wave, e.outputs, updatedCtx, e.routingDecisions);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "retrying" }, { type: "node-failed" }], ([p, e]) => {
      const updatedCtx = mergeFreshnessProgress(ctx, e);
      const r = handleNodeFailed(p.wave, e.nodeId, e.error, updatedCtx, e.partialOutputs, e.coFailedNodeIds);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "retrying" }, { type: "executor-error" }], ([, e]) => executorCrash(e, ctx))
    .with([{ kind: "retrying" }, P._], ([p]) => stay(p, ctx))

    // ─── awaiting-human ─────────────────────────────────────────────────
    .with([{ kind: "awaiting-human" }, { type: "human-responded" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const rerouteActiveSet = "rerouteActiveSet" in e ? e.rerouteActiveSet : undefined;
      const r = handleHumanResponse(p, e.action, ctx, rerouteActiveSet);
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
    // ADR-0060: hook returned `pending` → park durably. Guard on node id.
    .with([{ kind: "awaiting-human" }, { type: "human-suspend" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      return stay(asSuspended(p), ctx);
    })
    .with([{ kind: "awaiting-human" }, P._], ([p]) => stay(p, ctx))

    // ─── suspended (ADR-0060) ───────────────────────────────────────────
    // On resume the executor re-dispatches the hook, so `suspended` accepts the
    // same events as `awaiting-human`: a decision resolves the gate, another
    // `pending` re-parks, a hook crash retries. The payload is identical to
    // `awaiting-human`, so each branch coerces to that shape and reuses the
    // resolution/retry helpers.
    .with([{ kind: "suspended" }, { type: "human-responded" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const rerouteActiveSet = "rerouteActiveSet" in e ? e.rerouteActiveSet : undefined;
      const r = handleHumanResponse(asAwaitingHuman(p), e.action, ctx, rerouteActiveSet);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "suspended" }, { type: "human-suspend" }], ([p]) => {
      // Resumed but still no decision — stay parked (idempotent re-park). The
      // event nodeId is irrelevant here: a suspended run re-parks unconditionally.
      return stay(p, ctx);
    })
    .with([{ kind: "suspended" }, { type: "node-failed" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const r = handleHookCrash(p.nodeId, p.output, p.prompt, e.error, ctx, p.pendingReviews, p.wave);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "suspended" }, { type: "executor-error" }], ([p, e]) => {
      const syntheticError = {
        kind: "node-crash" as const,
        nodeId: p.nodeId,
        retriability: e.retriable ? "retriable" as const : "non-retriable" as const,
        message: e.error,
      };
      const r = handleHookCrash(p.nodeId, p.output, p.prompt, syntheticError, ctx, p.pendingReviews, p.wave);
      return { state: r.state, context: r.context };
    })
    .with([{ kind: "suspended" }, P._], ([p]) => stay(p, ctx))

    // ─── retrying-hook ──────────────────────────────────────────────────
    .with([{ kind: "retrying-hook" }, { type: "human-responded" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      const rerouteActiveSet = "rerouteActiveSet" in e ? e.rerouteActiveSet : undefined;
      const r = handleHumanResponse(asAwaitingHuman(p), e.action, ctx, rerouteActiveSet);
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
    // ADR-0060: a hook that previously crashed now returns `pending` on retry →
    // park durably rather than continuing the in-process retry loop.
    .with([{ kind: "retrying-hook" }, { type: "human-suspend" }], ([p, e]) => {
      if (e.nodeId !== p.nodeId) return stay(p, ctx);
      return stay(asSuspended(p), ctx);
    })
    .with([{ kind: "retrying-hook" }, P._], ([p]) => stay(p, ctx))

    // ─── terminal states ────────────────────────────────────────────────
    .with([{ kind: "succeeded" }, P._], ([p]) => stay(p, ctx))
    .with([{ kind: "failed" }, P._], ([p]) => stay(p, ctx))

    .exhaustive();
