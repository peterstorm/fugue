/**
 * Bot Framework review notifier (ADR-0060) — posts the interactive review card
 * proactively into the Teams conversation the bot was added to. Implements the
 * same `HumanReviewNotifierPort` as the webhook transport, so the engine is
 * unchanged; only delivery + the in-Teams Approve/Reject buttons differ.
 *
 * A notification before the bot has been added anywhere (no stored conversation
 * reference) surfaces `notification-failed` — the review hook treats that as
 * non-fatal (the run stays parked) and logs it.
 *
 * Per-team routing (FR-041, keycloak-entra-wiring — a CONFIDENTIALITY measure):
 * the notification carries the run's immutable owning team. Delivery uses only
 * that team's stored conversation reference. A missing team reference fails
 * closed; it never falls back to a default channel that may belong to another
 * team. The independent action-prevention control remains click-time authz.
 */

import { err, safeErrorMessage } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../../domain/host-error.js";
import type { HumanReviewNotifierPort } from "../../ports.js";
import { buildReviewActivity } from "./card.js";
import type { ConversationStorePort, BotConnectorPort } from "./ports.js";

export const createBotFrameworkNotifier = (deps: {
  readonly connector: BotConnectorPort;
  readonly conversations: ConversationStorePort;
}): HumanReviewNotifierPort => ({
  async notify(notification): Promise<Result<void, HostError>> {
    // The card build runs in the guarded body of notify: `buildReviewActivity`
    // renders the output preview through the TOTAL shared renderer, so a
    // hostile output (null-prototype, throwing toString) resolves to a preview
    // string — but any residual throw still maps to `notification-failed`
    // instead of escaping as a raw rejection (which the review hook would
    // escalate to a retriable node-failed on a PARKED run).
    let activity: unknown;
    try {
      activity = buildReviewActivity(notification);
    } catch (e) {
      return err({
        kind: "notification-failed",
        operation: `bot proactive send: card build failed: ${safeErrorMessage(e)}`, 
      });
    }

    const refRes = await deps.conversations.getTeamReference(notification.ownerTeam);
    if (!refRes.ok) return err(refRes.error);
    if (refRes.value === null) {
      return err({
        kind: "notification-failed",
        operation: `bot proactive send: no conversation reference for owning team '${notification.ownerTeam}'`,
      });
    }
    return deps.connector.sendToConversation(refRes.value, activity);
  },
});
