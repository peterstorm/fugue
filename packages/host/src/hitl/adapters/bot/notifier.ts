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
 * a notification is resolved `dagId → owning team` (via the injected
 * `resolveDagTeam`); when that team has its OWN stored conversation reference, the
 * card posts to the TEAM's channel and NOT the default — so a team's
 * output-under-review is not delivered into another team's channel. An unmapped
 * team (or one with no team reference yet) falls back to the default channel,
 * preserving the original behaviour (including the `notification-failed` when no
 * reference exists anywhere). Routing is delivery-only; the action-prevention
 * control is the authz gate on the inbound button click (`canAccessDag`).
 */

import { err } from "@fuguejs/framework";
import type { Result, DagId } from "@fuguejs/framework";
import type { Team } from "../../../domain/auth.js";
import type { HostError } from "../../../domain/host-error.js";
import type { HumanReviewNotifierPort } from "../../ports.js";
import { buildReviewActivity } from "./card.js";
import type { ConversationStorePort, BotConnectorPort, ConversationReference } from "./ports.js";

export const createBotFrameworkNotifier = (deps: {
  readonly connector: BotConnectorPort;
  readonly conversations: ConversationStorePort;
  /**
   * Resolve a notification's `dagId` to its OWNING fugue team (FR-041). Wired from
   * the live registry (the same `lookupDag` the inbound handler uses) — a PURE
   * registry lookup. `undefined` ONLY when the DAG is no longer registered (or the
   * registry is absent); it does NOT consult channel configuration. A resolved
   * team that has no stored conversation reference falls back to the default
   * channel separately, in `notify` below (routing is best-effort delivery, not a
   * security gate).
   */
  readonly resolveDagTeam: (dagId: DagId) => Team | undefined;
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
        operation: `bot proactive send: card build failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // 1. Per-team routing (confidentiality): if the run's DAG resolves to a team
    //    that has its OWN stored reference, post there and NOT the default.
    const team = deps.resolveDagTeam(notification.dagId);
    if (team !== undefined) {
      const teamRefRes = await deps.conversations.getTeamReference(team);
      if (!teamRefRes.ok) return err(teamRefRes.error);
      if (teamRefRes.value !== null) {
        return deps.connector.sendToConversation(teamRefRes.value, activity);
      }
    }

    // 2. Fallback: the default channel (unmapped team, or no team reference yet).
    const refRes = await deps.conversations.getDefaultReference();
    if (!refRes.ok) return err(refRes.error);
    if (refRes.value === null) {
      return err({
        kind: "notification-failed",
        operation: "bot proactive send: no conversation reference (is the Fugue bot installed in a Teams channel?)",
      });
    }
    const ref: ConversationReference = refRes.value;
    return deps.connector.sendToConversation(ref, activity);
  },
});
