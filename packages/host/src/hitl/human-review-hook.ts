/**
 * The host's `onHumanReview` hook (ADR-0060) — the bridge between the framework
 * kernel's human gate and the durable decision/notification stores.
 *
 * On each (re)dispatch for a gate `(runId, nodeId)`:
 *   1. A decision already recorded  → RETURN it (the gate resolves). The hook
 *      does NOT clear it here — consumption is deferred to `makeOnDecisionConsumed`,
 *      which the kernel calls only AFTER the post-gate checkpoint is durable.
 *   2. No decision yet              → mark the gate pending; on the FIRST park
 *      (markPending returned `true`) send the notification; return `pending` so
 *      the run suspends.
 *
 * Read/consume split (the durability fix): if the hook cleared the decision the
 * moment it read it, a worker crash AFTER the clear but BEFORE the kernel
 * persists the advanced state would lose the approval — the durable checkpoint
 * still says `suspended` while the decision is gone, so the resumed run re-parks
 * and a human must decide again. By only READING here and deferring the clear to
 * the post-commit callback, a crash in that window re-reads the same decision on
 * resume (effectively-once consumption).
 *
 * Fail-safe by construction: a decision-store read error returns `pending`
 * (re-park) rather than fabricating an approval — a missing/erroring decision
 * must never be read as "yes". A notification failure does NOT crash the run:
 * the run is already safely parked and can be re-notified out of band; we log
 * and still return `pending`.
 */

import type {
  RunId,
  DagId,
  NodeId,
  HumanReviewOutcome,
} from "@fuguejs/framework";
import type { DecisionStorePort, HumanReviewNotifierPort } from "./ports.js";
import type { LogPort } from "../ports.js";

interface OnHumanReviewDeps {
  readonly decisions: DecisionStorePort;
  readonly notifier: HumanReviewNotifierPort;
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly logger?: LogPort;
}

const logWithoutThrowing = (
  logger: LogPort | undefined,
  level: "warn" | "error",
  message: string,
  data: Record<string, unknown>,
): void => {
  try {
    logger?.[level]?.(message, data);
  } catch {
    // Diagnostics cannot replace a safe pending/committed outcome.
  }
};

/**
 * Build the per-run `onHumanReview` hook the worker passes to
 * `runResumableDagJob`. Closes over the run's id + the decision/notifier stores.
 * READ-ONLY with respect to the decision store's recorded decision: it returns a
 * present decision without consuming it (see `makeOnDecisionConsumed`).
 */
export const makeOnHumanReview = (deps: OnHumanReviewDeps) =>
  async (req: { nodeId: NodeId; output: unknown; prompt: string }): Promise<HumanReviewOutcome> => {
    const { decisions, notifier, runId, dagId, logger } = deps;

    // 1. Decision already in? Resolve the gate by RETURNING it. Consumption
    //    (clear) is deferred to onDecisionConsumed, fired post-checkpoint.
    const decision = await decisions.getDecision(runId, req.nodeId);
    if (decision.ok && decision.value !== null) {
      return decision.value;
    }

    if (!decision.ok) {
      // Fail-safe: an errored decision lookup must NOT be read as approval.
      // Re-park so the run stays safe and a later resume can retry the lookup.
      logWithoutThrowing(logger, "warn", "hitl: decision lookup failed — re-parking", {
        runId,
        nodeId: req.nodeId,
        error: decision.error.kind,
      });
      return { kind: "pending" };
    }

    // 2. No decision yet → park. Notify only on the first park for this gate.
    const pending = await decisions.markPending(runId, req.nodeId);
    if (!pending.ok) {
      // Fail-open: if the pending marker is unwritable (store blip), assume this
      // is the first park and notify, rather than going silent. Surface the
      // store error so a duplicate notification on a later re-park is explained.
      logWithoutThrowing(logger, "warn", "hitl: markPending failed — assuming first park and notifying", {
        runId,
        nodeId: req.nodeId,
        error: pending.error.kind,
      });
    }
    const isFirstPark = pending.ok ? pending.value : true;
    if (isFirstPark) {
      const notified = await notifier.notify({
        runId,
        dagId,
        nodeId: req.nodeId,
        prompt: req.prompt,
        output: req.output,
      });
      if (!notified.ok) {
        // Non-fatal: the run is parked durably regardless. Surface the failure
        // so an operator can re-trigger delivery; do not fail the run.
        logWithoutThrowing(logger, "error", "hitl: review notification failed — run parked without notice", {
          runId,
          nodeId: req.nodeId,
          error: notified.error.kind,
        });
      }
    }
    return { kind: "pending" };
  };

interface OnDecisionConsumedDeps {
  readonly decisions: DecisionStorePort;
  readonly runId: RunId;
  readonly logger?: LogPort;
}

/**
 * Build the `onDecisionConsumed` callback the kernel invokes AFTER the post-gate
 * transition is durably checkpointed (ADR-0060). It clears the consumed decision
 * (and its pending marker) for `(runId, nodeId)`, completing effectively-once
 * consumption: the decision survives until the run has durably advanced past the
 * gate, so a crash mid-resume re-reads it rather than losing the approval.
 *
 * A clear failure is non-fatal: the post-gate state is already durable, so a
 * stale decision lingers harmlessly until its TTL (a DAG node gates once per run
 * except on `reroute`, which re-gates only after this clear has already run). We
 * log and move on.
 */
export const makeOnDecisionConsumed = (deps: OnDecisionConsumedDeps) =>
  async (nodeId: NodeId): Promise<void> => {
    const { decisions, runId, logger } = deps;
    const cleared = await decisions.clear(runId, nodeId);
    if (!cleared.ok) {
      logWithoutThrowing(logger, "warn", "hitl: failed to clear consumed decision (non-fatal, TTL reaps)", {
        runId,
        nodeId,
        error: cleared.error.kind,
      });
    }
  };
