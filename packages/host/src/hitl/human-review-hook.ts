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

import { asNonEmptyString } from "@fuguejs/framework";
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
/**
 * Log a hook failure, then throw it. ONE encoding (round-38 cs-15) of the
 * idiom every failure arm in this module needs: the diagnostic goes to the
 * (possibly broken) logger WITHOUT being able to replace the throw, and the
 * thrown message stays the structured `hitl: <what> for <runId>/<nodeId>[: <detail>]`
 * the kernel's retry path reads.
 */
function logAndThrow(
  logger: LogPort | undefined,
  level: "warn" | "error",
  logMessage: string,
  throwMessage: string,
  context: { readonly runId: RunId; readonly nodeId: NodeId; readonly error?: string },
): never {
  // A function DECLARATION, not an arrow const: TypeScript only propagates a
  // `never` return into control-flow narrowing for declarations and explicitly
  // annotated consts, and every caller here relies on the code after the call
  // being unreachable.
  logWithoutThrowing(logger, level, logMessage, context);
  throw new Error(throwMessage);
}

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
      logAndThrow(
        logger,
        "warn",
        "hitl: decision lookup failed — retrying hook",
        `hitl: decision lookup failed for ${runId}/${req.nodeId}: ${decision.error.kind}`,
        { runId, nodeId: req.nodeId, error: decision.error.kind },
      );
    }

    // 2. No decision yet → establish an actionable pending gate. Delivery state
    // is durable: a failed notification remains `notification-required`, while
    // a committed success deduplicates ordinary re-parks.
    const pending = await decisions.preparePending(runId, req.nodeId);
    if (!pending.ok) {
      logAndThrow(
        logger,
        "error",
        "hitl: preparePending failed — refusing unresolvable notification",
        `hitl: preparePending failed for ${runId}/${req.nodeId}: ${pending.error.kind}`,
        { runId, nodeId: req.nodeId, error: pending.error.kind },
      );
    }
    if (pending.value.kind === "notification-required") {
      const prompt = asNonEmptyString(req.prompt);
      if (prompt === undefined) {
        logAndThrow(
          logger,
          "error",
          "hitl: blank review prompt — refusing invalid notification",
          `hitl: blank review prompt for ${runId}/${req.nodeId}`,
          { runId, nodeId: req.nodeId },
        );
      }
      const delivered = await notifier.notify({
        runId,
        dagId,
        ownerTeam,
        nodeId: req.nodeId,
        prompt,
        output: req.output,
      });
      if (!delivered.ok) {
        logAndThrow(
          logger,
          "error",
          "hitl: review notification failed — retrying hook",
          `hitl: review notification failed for ${runId}/${req.nodeId}: ${delivered.error.kind}`,
          { runId, nodeId: req.nodeId, error: delivered.error.kind },
        );
      }

      const committed = await decisions.markNotified(runId, req.nodeId, pending.value.marker);
      if (!committed.ok || !committed.value) {
        const detail = committed.ok ? "pending marker changed" : committed.error.kind;
        logAndThrow(
          logger,
          "error",
          "hitl: notification delivered but delivery state was not committed — retrying hook",
          `hitl: notification state commit failed for ${runId}/${req.nodeId}: ${detail}`,
          { runId, nodeId: req.nodeId, error: detail },
        );
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
 * A clear failure fails the run closed. The post-gate state is already durable,
 * but a reroute may revisit the same `(runId,nodeId)` before TTL; continuing
 * would let that stale authorization auto-resolve a new gate instance.
 */
export const makeOnDecisionConsumed = (deps: OnDecisionConsumedDeps) =>
  async (nodeId: NodeId): Promise<void> => {
    const { decisions, runId, logger } = deps;
    const cleared = await decisions.clear(runId, nodeId);
    if (!cleared.ok) {
      logAndThrow(
        logger,
        "error",
        "hitl: failed to clear consumed decision — failing run closed",
        `hitl: consumed decision cleanup failed for ${runId}/${nodeId}: ${cleared.error.kind}`,
        { runId, nodeId, error: cleared.error.kind },
      );
    }
  };
