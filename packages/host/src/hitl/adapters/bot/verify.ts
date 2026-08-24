/**
 * Production Bot Framework token verifier (ADR-0060). Verifies the inbound
 * `Authorization: Bearer <jwt>` on the bot endpoint against the Bot Framework
 * service's JWKS (keys fetched from its OpenID metadata, never hardcoded),
 * enforcing issuer + audience (= the bot's app id) and an explicit asymmetric
 * algorithm allowlist. Fails CLOSED: any structural problem, signature failure,
 * or claim mismatch is `invalid`; a JWKS/metadata fetch failure is `unavailable`
 * (→ 503, retriable) so a key-rotation window does not look like a forged token.
 *
 * `jose` is imported dynamically (like ioredis / the LLM SDKs) so it loads only
 * when the bot transport is configured. The handler is unit-tested against a
 * fake `VerifyBotToken`; `bearer` + `classifyJoseError` are pure and exported so
 * the security-critical parsing/classification is unit-tested directly.
 */

import { lazyJwks, type JwksResolver } from "../../../adapters/lazy-jwks.js";
import { ok, err } from "@fuguejs/framework";
import type { BotAuthError, VerifyBotToken } from "./ports.js";

/** Bot Framework token issuer (channel service tokens). */
const BOT_ISSUER = "https://api.botframework.com";
/** Bot Framework OpenID metadata (yields the jwks_uri). */
const OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
/**
 * Bot Framework signs channel tokens with RS256. Pinning the allowlist makes the
 * asymmetric-only requirement load-bearing in code (defence-in-depth against an
 * HS256/`alg:none` confusion attack), rather than relying solely on the JWKS
 * resolver to never hand back a symmetric key.
 */
const BOT_TOKEN_ALGS = ["RS256"] as const;
/** Tolerate normal clock skew between this host and the Bot Framework service. */
const CLOCK_TOLERANCE = "60s";

/** Extract the bearer token from an `Authorization` header. Pure; exported for tests. */
export const bearer = (authHeader: string | undefined): string | null => {
  if (!authHeader) return null;
  const m = /^Bearer (.+)$/i.exec(authHeader.trim());
  return m ? m[1]! : null;
};

/**
 * Classify a `jose.jwtVerify` failure as an INFRA fault (`unavailable` → 503,
 * retriable) vs a genuine token problem (`invalid` → 401). This matters because
 * `createRemoteJWKSet` fetches the JWKS LAZILY — the network call happens inside
 * `jwtVerify`, so a JWKS timeout / network failure surfaces here, NOT in the
 * metadata fetch. Treating it as `invalid` would make a key-rotation/JWKS outage
 * look like a forged token (and return 401 instead of a retriable 503).
 *
 * Pure; exported for tests. Conservative: only clear infra signals (JWKS timeout,
 * fetch/network failure) map to `unavailable`; signature/claim/structural errors
 * (the default) remain `invalid` so verification still fails closed.
 */
export const classifyJoseError = (e: unknown): BotAuthError["kind"] => {
  const code = (e as { code?: unknown })?.code;
  const name = (e as { name?: unknown })?.name;
  const message = e instanceof Error ? e.message : String(e);
  const isJwksTimeout = code === "ERR_JWKS_TIMEOUT" || name === "JWKSTimeout";
  // Bun/Node `fetch` rejects with a TypeError ("fetch failed") on a network
  // fault; jose lets it propagate out of the lazy JWKS fetch.
  const isFetchFailure = e instanceof TypeError || /fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed? ?out/i.test(message);
  return isJwksTimeout || isFetchFailure ? "unavailable" : "invalid";
};

interface BotVerifyConfig {
  /** The bot's Microsoft app id — the audience the inbound token must carry. */
  readonly appId: string;
}

export const createBotTokenVerifier = (config: BotVerifyConfig): VerifyBotToken => {
  // Lazily-initialised remote JWKS set — single-flight, reset on failure so a
  // transient metadata outage is retried rather than wedging the verifier (see
  // `lazyJwks`). `jose` caches keys and refreshes on rotation internally.
  const getJwks = lazyJwks(async () => {
    const jose = await import("jose");
    const meta = await fetch(OPENID_CONFIG_URL);
    if (!meta.ok) throw new Error(`openid metadata HTTP ${meta.status}`);
    const { jwks_uri } = (await meta.json()) as { jwks_uri?: string };
    if (typeof jwks_uri !== "string") throw new Error("openid metadata missing jwks_uri");
    return jose.createRemoteJWKSet(new URL(jwks_uri)) as unknown as JwksResolver;
  });

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
      await jose.jwtVerify(token, jwks as never, {
        issuer: BOT_ISSUER,
        audience: config.appId,
        algorithms: [...BOT_TOKEN_ALGS],
        clockTolerance: CLOCK_TOLERANCE,
      });
      return ok(undefined);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // A lazy JWKS fetch failure inside jwtVerify is infra (503), not a forged
      // token (401). Everything else fails closed as `invalid`.
      return err({ kind: classifyJoseError(e), reason });
    }
  };
};
