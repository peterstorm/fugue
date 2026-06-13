/**
 * Bot Framework review notifier (ADR-0060) — posts the interactive review card
 * proactively into the Teams conversation the bot was added to. Implements the
 * same `HumanReviewNotifierPort` as the webhook transport, so the engine is
 * unchanged; only delivery + the in-Teams Approve/Reject buttons differ.
 *
 * A notification before the bot has been added anywhere (no stored conversation
 * reference) surfaces `notification-failed` — the review hook treats that as
 * non-fatal (the run stays parked) and logs it.
 */

import { ok, err } from "@fuguejs/framework";
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
    const refRes = await deps.conversations.getDefaultReference();
    if (!refRes.ok) return err(refRes.error);
    if (refRes.value === null) {
      return err({
        kind: "notification-failed",
        operation: "bot proactive send: no conversation reference (is the Fugue bot installed in a Teams channel?)",
      });
    }
    const activity = buildReviewActivity(notification);
    return deps.connector.sendToConversation(refRes.value, activity);
  },
});
