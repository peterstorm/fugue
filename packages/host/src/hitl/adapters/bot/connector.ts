/**
 * Production BotConnector (ADR-0060) — posts a proactive activity to the Bot
 * Framework connector service over `fetch`, authenticating with an app-only
 * token (client_credentials against the Bot Framework login). The token is
 * cached until shortly before expiry.
 *
 * This is the production wiring (direct `fetch`, no injected transport); the
 * notifier + handler logic is tested against the `BotConnectorPort` with fakes.
 * SC: the app password is the only credential and is read from config, never
 * logged.
 */

import { ok, err, safeErrorMessage } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { z } from "zod";
import type { HostError } from "../../../domain/host-error.js";
import type { LogPort } from "../../../ports.js";
import type { BotConnectorPort, ConversationReference } from "./ports.js";
import { isTrustedBotServiceUrl } from "./trusted-host.js";

interface BotConnectorConfig {
  readonly appId: string;
  readonly appPassword: string;
  /**
   * Token endpoint. Default is the multi-tenant Bot Framework login. For a
   * single-tenant bot, pass `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`.
   */
  readonly tokenUrl?: string;
  /** OAuth scope for the connector token. Default `https://api.botframework.com/.default`. */
  readonly scope?: string;
  /** Wall-clock source (injected for tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const DEFAULT_SCOPE = "https://api.botframework.com/.default";

/** Wire shape of a successful `client_credentials` token response. */
const tokenResponseSchema = z.object({ access_token: z.string(), expires_in: z.number() });

type TokenResponse = z.infer<typeof tokenResponseSchema>;

type TokenGrant = { readonly token: string; readonly expiresAtMs: number };

/** Resolved connector settings the token fetch needs. */
type TokenRequest = {
  readonly tokenUrl: string;
  readonly scope: string;
  readonly appId: string;
  readonly appPassword: string;
};

/**
 * PURE: turn a parsed token response into a cache entry. Refresh 60s early to
 * avoid edge-of-expiry failures, but never skew past the token's own lifetime:
 * a token with `expires_in < 60` (or 0) would otherwise yield an `expiresAtMs`
 * in the past, marking the cache stale on write and forcing a fresh fetch on
 * every call. Cap the early-refresh at half the lifetime so short-lived tokens
 * stay cached for a bounded window.
 */
const grantFrom = (response: TokenResponse, nowMs: number): TokenGrant => {
  const skewSeconds = Math.min(60, response.expires_in / 2);
  return {
    token: response.access_token,
    expiresAtMs: nowMs + (response.expires_in - skewSeconds) * 1000,
  };
};

const notificationFailed = (operation: string): HostError => ({ kind: "notification-failed", operation });

/** Shell: POST the client_credentials grant; the body is wire data and is parsed, never cast. */
const fetchTokenResponse = async (request: TokenRequest): Promise<Result<TokenResponse, HostError>> => {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: request.appId,
    client_secret: request.appPassword,
    scope: request.scope,
  });
  let res: Response;
  try {
    res = await fetch(request.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (e) {
    return err(notificationFailed(`bot token fetch: ${safeErrorMessage(e)}`));
  }
  if (!res.ok) return err(notificationFailed(`bot token endpoint HTTP ${res.status}`));
  let raw: unknown;
  try {
    // A 200 with a malformed/truncated body (proxy error page, reset
    // mid-stream) rejects here; classify it as `notification-failed` like the
    // other token-fetch failures rather than letting it escape as an
    // `onHumanReview` hook crash (which would burn the hook retry budget).
    raw = await res.json();
  } catch (e) {
    return err(notificationFailed(`bot token response not valid JSON: ${safeErrorMessage(e)}`));
  }
  const parsed = tokenResponseSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(notificationFailed("bot token response missing access_token/expires_in"));
};

/** Shell: POST one activity to the conversation with the bearer token attached. */
const postActivity = async (
  ref: ConversationReference,
  activity: unknown,
  token: string,
  logger?: LogPort,
): Promise<Result<void, HostError>> => {
  const url = `${ref.serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(activity),
    });
  } catch (e) {
    return err(notificationFailed(`bot send: ${safeErrorMessage(e)}`));
  }
  if (res.status < 200 || res.status >= 300) {
    logger?.error?.("hitl/bot: proactive send failed", { status: res.status, conversationId: ref.conversationId });
    return err(notificationFailed(`bot send HTTP ${res.status}`));
  }
  return ok(undefined);
};

export const createBotConnector = (config: BotConnectorConfig, logger?: LogPort): BotConnectorPort => {
  const request: TokenRequest = {
    tokenUrl: config.tokenUrl ?? DEFAULT_TOKEN_URL,
    scope: config.scope ?? DEFAULT_SCOPE,
    appId: config.appId,
    appPassword: config.appPassword,
  };
  const now = config.now ?? Date.now;

  let cached: TokenGrant | null = null;

  const getToken = async (): Promise<Result<string, HostError>> => {
    if (cached !== null && now() < cached.expiresAtMs) return ok(cached.token);
    const response = await fetchTokenResponse(request);
    if (!response.ok) return err(response.error);
    cached = grantFrom(response.value, now());
    return ok(cached.token);
  };

  return {
    async sendToConversation(ref: ConversationReference, activity): Promise<Result<void, HostError>> {
      // Defence-in-depth: never attach the app-only bearer token to a request
      // for an untrusted host, even if a bad serviceUrl somehow reached the
      // store (the inbound capture path also allowlists it).
      if (!isTrustedBotServiceUrl(ref.serviceUrl)) {
        logger?.error?.("hitl/bot: refusing proactive send to untrusted serviceUrl", { serviceUrl: ref.serviceUrl });
        return err(notificationFailed(`bot send: untrusted serviceUrl '${ref.serviceUrl}'`));
      }
      const tokenRes = await getToken();
      if (!tokenRes.ok) return err(tokenRes.error);
      return postActivity(ref, activity, tokenRes.value, logger);
    },
  };
};
