/**
 * Bot Framework ports (ADR-0060). The in-Teams review transport needs three
 * seams, each injected so the notifier + inbound handler are testable with no
 * Azure Bot, no network, no live JWKS:
 *
 *  - ConversationStorePort — where to post (the conversation reference captured
 *    when the bot is added to a team/channel; proactive messaging needs it).
 *  - BotConnectorPort      — how to post (the Bot Framework connector + token).
 *  - VerifyBotToken        — proof the inbound activity really came from the Bot
 *    Framework service (the security boundary on the bot endpoint).
 */

import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../../domain/host-error.js";

/**
 * The serializable subset of a Bot Framework conversation reference needed to
 * post a proactive activity back to a conversation. Captured from an inbound
 * activity (`serviceUrl` + `conversation.id`) and persisted.
 */
export interface ConversationReference {
  readonly serviceUrl: string;
  readonly conversationId: string;
  /** Channel id (e.g. "msteams") — informational, carried for completeness. */
  readonly channelId?: string;
  /** The bot's own account id on the channel, if known. */
  readonly botId?: string;
}

/**
 * Stores the conversation reference(s) the bot can post reviews to. A DEFAULT
 * reference (the channel the bot was added to) is kept for back-compat and as the
 * fallback channel; PER-TEAM references (FR-041) let the notifier deliver one
 * team's review cards to that team's OWN channel.
 *
 * Per-team routing is a CONFIDENTIALITY measure — it decides WHERE a card is
 * delivered so a team's output-under-review is not posted into another team's
 * channel. It is NOT the control that prevents acting on another team's runs:
 * that is the authorization gate (`canAccessDag`) on the inbound button-click
 * path (`messages-handler.ts`), which refuses a non-member's click regardless of
 * which channel the card reached. A team without its own reference falls back to
 * the default channel.
 *
 * Wiring: `saveTeamReference` is called from `handleBotActivity` on
 * `conversationUpdate` when the activity's `channelData.team.aadGroupId` maps to
 * a fugue team via `HITL_TEAM_CHANNELS`; `getTeamReference` is read by
 * `createBotFrameworkNotifier` to pick the team channel before falling back to
 * the default.
 */
export interface ConversationStorePort {
  saveDefaultReference(ref: ConversationReference): Promise<Result<void, HostError>>;
  getDefaultReference(): Promise<Result<ConversationReference | null, HostError>>;
  /**
   * Persist the conversation reference for a specific team's channel (FR-041) so
   * the notifier can route that team's cards there (confidentiality routing).
   */
  saveTeamReference(team: string, ref: ConversationReference): Promise<Result<void, HostError>>;
  /**
   * Fetch a team's conversation reference, or `ok(null)` when the team has none
   * (the notifier then falls back to the default channel). Used for confidentiality
   * routing, not authorization (FR-041).
   */
  getTeamReference(team: string): Promise<Result<ConversationReference | null, HostError>>;
}

/** Posts a Bot Framework activity to a conversation (handles auth + transport). */
export interface BotConnectorPort {
  sendToConversation(ref: ConversationReference, activity: unknown): Promise<Result<void, HostError>>;
}

/** A client fault (bad/expired/foreign token) vs an infra fault (JWKS fetch failed). */
export type BotAuthError =
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Verifies the inbound `Authorization` header on the bot endpoint is a valid
 * Bot Framework service token (JWKS-backed in production; a fake in tests). The
 * ONLY trust boundary for inbound activities — it must fail closed.
 */
export type VerifyBotToken = (authHeader: string | undefined) => Promise<Result<void, BotAuthError>>;
