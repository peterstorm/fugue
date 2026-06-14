/**
 * The host's `onHumanReview` hook (ADR-0060) — the bridge between the framework
 * kernel's human gate and the durable decision/notification stores.
 *
 * On each (re)dispatch for a gate `(runId, nodeId)`:
 *   1. A decision already recorded  → clear it and return it (the gate resolves).
 *   2. No decision yet              → mark the gate pending; on the FIRST park
 *      (markPending returned `true`) send the notification; return `pending` so
 *      the run suspends.
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

export interface OnHumanReviewDeps {
  readonly decisions: DecisionStorePort;
  readonly notifier: HumanReviewNotifierPort;
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly logger?: LogPort;
}

/**
 * Build the per-run `onHumanReview` hook the worker passes to
 * `runResumableDagJob`. Closes over the run's id + the decision/notifier stores.
 */
export const makeOnHumanReview = (deps: OnHumanReviewDeps) =>
  async (req: { nodeId: NodeId; output: unknown; prompt: string }): Promise<HumanReviewOutcome> => {
    const { decisions, notifier, runId, dagId, logger } = deps;

    // 1. Decision already in? Resolve the gate.
    const decision = await decisions.getDecision(runId, req.nodeId);
    if (decision.ok && decision.value !== null) {
      const cleared = await decisions.clear(runId, req.nodeId);
      if (!cleared.ok) {
        // Non-fatal: a stale pending marker is harmless (the decision is
        // consumed once via the returned action). Log and proceed.
        logger?.warn?.("hitl: failed to clear resolved review marker", {
          runId,
          nodeId: req.nodeId,
          error: cleared.error.kind,
        });
      }
      return decision.value;
    }

    if (!decision.ok) {
      // Fail-safe: an errored decision lookup must NOT be read as approval.
      // Re-park so the run stays safe and a later resume can retry the lookup.
      logger?.warn?.("hitl: decision lookup failed — re-parking", {
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
      logger?.warn?.("hitl: markPending failed — assuming first park and notifying", {
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
        logger?.error?.("hitl: review notification failed — run parked without notice", {
          runId,
          nodeId: req.nodeId,
          error: notified.error.kind,
        });
      }
    }
    return { kind: "pending" };
  };
