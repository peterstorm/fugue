/**
 * Production Bot Framework token verifier (ADR-0060). Verifies the inbound
 * `Authorization: Bearer <jwt>` on the bot endpoint against the Bot Framework
 * service's JWKS (keys fetched from its OpenID metadata, never hardcoded),
 * enforcing issuer + audience (= the bot's app id). Fails CLOSED: any structural
 * problem, signature failure, or claim mismatch is `invalid`; a JWKS/metadata
 * fetch failure is `unavailable` (→ 503, retriable) so a key-rotation window
 * does not look like a forged token.
 *
 * `jose` is imported dynamically (like ioredis / the LLM SDKs) so it loads only
 * when the bot transport is configured. The handler is unit-tested against a
 * fake `VerifyBotToken`; this live impl is exercised in integration.
 */

import { ok, err } from "@fuguejs/framework";
import type { VerifyBotToken } from "./ports.js";

/** Bot Framework token issuer (channel service tokens). */
const BOT_ISSUER = "https://api.botframework.com";
/** Bot Framework OpenID metadata (yields the jwks_uri). */
const OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";

const bearer = (authHeader: string | undefined): string | null => {
  if (!authHeader) return null;
  const m = /^Bearer (.+)$/i.exec(authHeader.trim());
  return m ? m[1]! : null;
};

export interface BotVerifyConfig {
  /** The bot's Microsoft app id — the audience the inbound token must carry. */
  readonly appId: string;
}

export const createBotTokenVerifier = (config: BotVerifyConfig): VerifyBotToken => {
  // Lazily-initialised remote JWKS set (cached across calls; jose caches keys
  // and refreshes on rotation internally).
  let jwksPromise: Promise<(protectedHeader: unknown, token: unknown) => Promise<unknown>> | null = null;

  const getJwks = async () => {
    if (jwksPromise === null) {
      jwksPromise = (async () => {
        const jose = await import("jose");
        const meta = await fetch(OPENID_CONFIG_URL);
        if (!meta.ok) throw new Error(`openid metadata HTTP ${meta.status}`);
        const { jwks_uri } = (await meta.json()) as { jwks_uri?: string };
        if (typeof jwks_uri !== "string") throw new Error("openid metadata missing jwks_uri");
        return jose.createRemoteJWKSet(new URL(jwks_uri)) as unknown as (p: unknown, t: unknown) => Promise<unknown>;
      })().catch((e) => {
        // Reset so a transient metadata failure can be retried on the next call.
        jwksPromise = null;
        throw e;
      });
    }
    return jwksPromise;
  };

  return async (authHeader) => {
    const token = bearer(authHeader);
    if (token === null) return err({ kind: "invalid", reason: "missing or malformed Authorization bearer token" });

    let jwks: (p: unknown, t: unknown) => Promise<unknown>;
    try {
      jwks = await getJwks();
    } catch (e) {
      return err({ kind: "unavailable", reason: `JWKS unavailable: ${e instanceof Error ? e.message : String(e)}` });
    }

    try {
      const jose = await import("jose");
      await jose.jwtVerify(token, jwks as never, { issuer: BOT_ISSUER, audience: config.appId });
      return ok(undefined);
    } catch (e) {
      return err({ kind: "invalid", reason: e instanceof Error ? e.message : String(e) });
    }
  };
};
