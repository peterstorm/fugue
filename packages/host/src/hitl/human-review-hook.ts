/**
 * The host's `onHumanReview` hook (ADR-0060) — the bridge between the framework
 * kernel's human gate and the durable decision/notification stores.
 *
 * On each (re)dispatch for a gate `(runId, nodeId)`:
 *   1. A decision already recorded  → RETURN it (the gate resolves). The hook
 *      does NOT clear it here — consumption is deferred to `makeOnDecisionConsumed`,
 *      which the kernel calls only AFTER the post-gate checkpoint is durable.
 *   2. No decision yet              → prepare durable pending/notification
 *      state; retry delivery while it is `notification-required`; atomically
 *      mark successful delivery `notified`; only then return `pending`.
 *
 * Read/consume split (the durability fix): if the hook cleared the decision the
 * moment it read it, a worker crash AFTER the clear but BEFORE the kernel
 * persists the advanced state would lose the approval — the durable checkpoint
 * still says `suspended` while the decision is gone, so the resumed run re-parks
 * and a human must decide again. By only READING here and deferring the clear to
 * the post-commit callback, a crash in that window re-reads the same decision on
 * resume (effectively-once consumption).
 *
 * Fail-safe by construction: decision reads, pending-state writes, notification
 * delivery, and delivery-state commits all throw into the kernel's retriable
 * hook path. A missing/erroring decision is never read as approval, and the
 * hook never returns `pending` until the gate is durably actionable and its
 * notification has been delivered. Failed deliveries remain durably retriable.
 */

import type {
  RunId,
  DagId,
  NodeId,
  HumanReviewOutcome,
} from "@fuguejs/framework";
import type { DecisionStorePort, HumanReviewNotifierPort } from "./ports.js";
import type { Team } from "../domain/auth.js";
import type { LogPort } from "../ports.js";
import { logWithoutThrowing } from "./diagnostic-logging.js";

interface OnHumanReviewDeps {
  readonly decisions: DecisionStorePort;
  readonly notifier: HumanReviewNotifierPort;
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly ownerTeam: Team;
  readonly logger?: LogPort;
}

/**
 * Build the per-run `onHumanReview` hook the worker passes to
 * `runResumableDagJob`. Closes over the run's id + the decision/notifier stores.
 * READ-ONLY with respect to the decision store's recorded decision: it returns a
 * present decision without consuming it (see `makeOnDecisionConsumed`).
 */
export const makeOnHumanReview = (deps: OnHumanReviewDeps) =>
  async (req: { nodeId: NodeId; output: unknown; prompt: string }): Promise<HumanReviewOutcome> => {
    const { decisions, notifier, runId, dagId, ownerTeam, logger } = deps;

    // 1. Decision already in? Resolve the gate by RETURNING it. Consumption
    //    (clear) is deferred to onDecisionConsumed, fired post-checkpoint.
    const decision = await decisions.getDecision(runId, req.nodeId);
    if (decision.ok && decision.value !== null) {
      return decision.value;
    }

    if (!decision.ok) {
      // An errored lookup cannot establish either "approved" or "no decision".
      // Throw so the kernel retries the hook without producing `suspended`.
      logWithoutThrowing(logger, "warn", "hitl: decision lookup failed — retrying hook", {
        runId,
        nodeId: req.nodeId,
        error: decision.error.kind,
      });
      throw new Error(`hitl: decision lookup failed for ${runId}/${req.nodeId}: ${decision.error.kind}`);
    }

    // 2. No decision yet → establish an actionable pending gate. Delivery state
    // is durable: a failed notification remains `notification-required`, while
    // a committed success deduplicates ordinary re-parks.
    const pending = await decisions.preparePending(runId, req.nodeId);
    if (!pending.ok) {
      logWithoutThrowing(logger, "error", "hitl: preparePending failed — refusing unresolvable notification", {
        runId,
        nodeId: req.nodeId,
        error: pending.error.kind,
      });
      throw new Error(`hitl: preparePending failed for ${runId}/${req.nodeId}: ${pending.error.kind}`);
    }
    if (pending.value.kind === "notification-required") {
      const delivered = await notifier.notify({
        runId,
        dagId,
        ownerTeam,
        nodeId: req.nodeId,
        prompt: req.prompt,
        output: req.output,
      });
      if (!delivered.ok) {
        logWithoutThrowing(logger, "error", "hitl: review notification failed — retrying hook", {
          runId,
          nodeId: req.nodeId,
          error: delivered.error.kind,
        });
        throw new Error(`hitl: review notification failed for ${runId}/${req.nodeId}: ${delivered.error.kind}`);
      }

      const committed = await decisions.markNotified(runId, req.nodeId, pending.value.marker);
      if (!committed.ok || !committed.value) {
        const detail = committed.ok ? "pending marker changed" : committed.error.kind;
        logWithoutThrowing(logger, "error", "hitl: notification delivered but delivery state was not committed — retrying hook", {
          runId,
          nodeId: req.nodeId,
          error: detail,
        });
        throw new Error(`hitl: notification state commit failed for ${runId}/${req.nodeId}: ${detail}`);
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
