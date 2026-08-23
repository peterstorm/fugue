/**
 * createRealmJwtVerifier — the live, JWKS-backed implementation of the
 * `VerifyRealmJwt` port (`http/middleware/auth.ts`). It verifies a fugue-platform
 * realm JWT's SIGNATURE against the realm's published keys
 * (`jose.createRemoteJWKSet`, keys fetched from the realm, never hardcoded) and,
 * on success, brands the decoded claims with `markSignatureVerified` — the single
 * trust boundary that produces `SignatureVerifiedClaims`.
 *
 * CRYPTOGRAPHIC + STANDARD TEMPORAL VERIFICATION — by design (AD-4 / FR-003).
 * `jose.jwtVerify` verifies the signature/algorithm and also enforces registered
 * temporal claims such as `exp` and `nbf` with the configured clock tolerance.
 * It receives NO `issuer`/`audience` option: realm-specific issuer/audience policy,
 * strict expiry/not-before checks against the injected application clock, and
 * defensive claim parsing remain in pure `validateRealmJwtClaims`
 * (`domain/jwt-validation.ts`). The asymmetric `alg` allowlist is defence in depth
 * against `alg:none`/HS256 confusion; the 60-second tolerance handles normal clock
 * skew at the jose boundary without replacing the stricter pure policy check.
 *
 * FAIL CLOSED (NFR-020 — no bare throws, every failure a typed result):
 *   - valid signature → `ok(SignatureVerifiedClaims)`.
 *   - bad signature / unparsable token / structural fault → `invalid` (→ 401).
 *   - JWKS / metadata fetch failure → `unavailable` (→ 503, retriable) so a
 *     key-rotation window never looks like a forged token.
 * Mirrors the proven Bot Framework verifier (`hitl/adapters/bot/verify.ts`):
 * lazy JWKS init, `classifyRealmJoseError` splits infra vs token faults.
 *
 * `jose` is imported dynamically (matching the Bot verifier) so it loads only
 * when the realm-JWT path is wired.
 *
 * @satisfies FR-003 — verify against the realm's keys; issuer/audience and strict
 *   application-clock claim policy remain in the pure validator.
 * @satisfies AD-4 — `createRemoteJWKSet` → jose signature/temporal verification →
 *   `markSignatureVerified`; the brand attests the cryptographic trust boundary.
 * @satisfies NFR-020 — JWKS-down → `unavailable`, bad-sig → `invalid`; never throws.
 */

import { lazyJwks, type JwksResolver } from "./lazy-jwks.js";
import { ok, err } from "@fuguejs/framework";
import { markSignatureVerified, type RealmJwtClaims } from "../domain/auth.js";
import type { JwtVerifyError, VerifyRealmJwt } from "../http/middleware/auth.js";

/**
 * The realm signs OIDC tokens with an asymmetric algorithm. Pinning an
 * RS/PS/ES allowlist makes "asymmetric only" load-bearing in code
 * (defence-in-depth against an `alg:none`/HS256 confusion attack), rather than
 * trusting the JWKS resolver to never hand back a symmetric key. This is an
 * ALGORITHM gate, not itself a claim check; jose's surrounding `jwtVerify` call
 * separately applies its standard temporal-claim checks.
 * The full RS/PS/ES 256/384/512 set is allowed: all are asymmetric and equally
 * safe against the alg-confusion attack, so the allowlist stays complete rather
 * than carrying an unexplained gap a key-rotation could trip over.
 */
const REALM_TOKEN_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"] as const;

/** Tolerate normal clock skew between this host and the realm (matches the Bot verifier). */
const CLOCK_TOLERANCE = "60s";

interface RealmJwtVerifierConfig {
  /**
   * The realm issuer URL. Its `<issuer>/protocol/openid-connect/certs` JWKS
   * endpoint is where the realm publishes its signing keys (Keycloak convention)
   * — used UNLESS `jwksUri` is given.
   */
  readonly issuer: string;
  /**
   * Optional explicit JWKS endpoint, decoupling the key-fetch URL from the `iss`
   * identity. When set it is used VERBATIM (no `/certs` suffixing). Lets the host
   * fetch keys over an in-cluster route while still trusting tokens whose `iss` is
   * the public route — the keys are realm-wide, not route-specific. Signature
   * verification does not check `iss` here (that stays in `validateRealmJwtClaims`
   * against `expectedIss`), so the split is safe.
   */
  readonly jwksUri?: string;
}

/**
 * Classify a `jose.jwtVerify` failure as an INFRA fault (`unavailable` → 503,
 * retriable) vs a genuine token fault (`invalid` → 401). `createRemoteJWKSet`
 * fetches the JWKS LAZILY inside `jwtVerify`, so a JWKS timeout / network failure
 * surfaces here, NOT at construction — treating it as `invalid` would make a
 * key-rotation/JWKS outage look like a forged token (401 instead of a retriable
 * 503). Conservative: only clear infra signals map to `unavailable`; everything
 * else (signature/structural) fails closed as `invalid`. Pure; exported for tests.
 * Mirrors `classifyJoseError` in the Bot verifier.
 */
export const classifyRealmJoseError = (e: unknown): JwtVerifyError["kind"] => {
  const code = (e as { code?: unknown })?.code;
  const name = (e as { name?: unknown })?.name;
  const message = e instanceof Error ? e.message : String(e);
  const isJwksFault =
    code === "ERR_JWKS_TIMEOUT" ||
    code === "ERR_JWKS_NO_MATCHING_KEY" ||
    name === "JWKSTimeout" ||
    // jose reloads the JWKS before throwing JWKSNoMatchingKey, so post-reload a
    // no-matching-key is a key-rotation window (infra), not a forged token.
    name === "JWKSNoMatchingKey" ||
    // A structurally-broken keyset returned by the realm during a botched key
    // rotation is infra/misconfig, not a forged token.
    code === "ERR_JWKS_INVALID" ||
    name === "JWKSInvalid";
  // When the JWKS endpoint is REACHABLE but does not return 200 (5xx /
  // maintenance HTML / 404 / redirect) OR returns an unparseable body,
  // `createRemoteJWKSet`'s fetch throws a bare `JOSEError`
  // (code "ERR_JOSE_GENERIC") whose ONLY signal is the English message. These
  // are infra faults — a realm outage must surface as a retriable 503, not a
  // 401 forged-token verdict (NFR-020). CAVEAT: matching jose's English message
  // strings is fragile across versions; `jose` should be pinned and the
  // regression tests guard this. (Code/name checks above are the durable path;
  // this message-match is the unavoidable fallback for the bare-JOSEError case.)
  const isJwksFetchMessage =
    /expected 200 ok from the json web key set|failed to parse the json web key set/i.test(message);
  // A lazy JWKS fetch can reject in several runtime shapes: Node/undici reject
  // with a TypeError ("fetch failed"); Bun rejects with a plain Error carrying a
  // `code` ("ConnectionRefused"/"ETIMEDOUT"/"FailedToOpenSocket") and a message
  // ("Unable to connect…"). All of these are INFRA faults, not forged tokens.
  const isBunSocketCode =
    code === "ConnectionRefused" ||
    code === "ConnectionClosed" ||
    code === "FailedToOpenSocket" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT";
  const isFetchFailure =
    e instanceof TypeError ||
    isBunSocketCode ||
    /fetch failed|unable to connect|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed? ?out/i.test(message);
  return isJwksFault || isJwksFetchMessage || isFetchFailure ? "unavailable" : "invalid";
};

/**
 * Build the realm JWKS endpoint URL from the issuer (Keycloak convention:
 * `<issuer>/protocol/openid-connect/certs`). Trailing slashes on the issuer are
 * normalised so the path joins cleanly. Pure; exported for tests.
 */
export const realmJwksUri = (issuer: string): string =>
  `${issuer.replace(/\/+$/, "")}/protocol/openid-connect/certs`;

/**
 * The shape `jose.JWTPayload` provides — the standard claims we re-narrow to
 * `RealmJwtClaims` (after the SIGNATURE passed). `jose` types `payload` loosely
 * (claims are optional); the pure `validateRealmJwtClaims` re-parses every value
 * defensively, so this brand is a SIGNATURE attestation only, not a claim trust.
 */
type JosePayload = Record<string, unknown>;

/**
 * Construct the live realm JWT signature and temporal verifier. The remote JWKS set is created
 * LAZILY on first verify (so construction never touches the network) and cached
 * across calls (jose refreshes keys on rotation internally). The returned
 * `VerifyRealmJwt` NEVER throws — a transport/JWKS fault is `unavailable`, a
 * bad/unparsable token is `invalid`, and only a verified signature yields the
 * `markSignatureVerified` brand.
 */
export const createRealmJwtVerifier = (config: RealmJwtVerifierConfig): VerifyRealmJwt => {
  // An explicit `jwksUri` (e.g. an in-cluster route) wins; else derive from issuer.
  const jwksUri = config.jwksUri ?? realmJwksUri(config.issuer);

  // Lazily-initialised remote JWKS resolver — SAME protocol as the Bot verifier,
  // now literally the same code (see `lazyJwks`). `createRemoteJWKSet` is
  // synchronous here (no metadata fetch — the certs URL is derived directly), so
  // the network call happens lazily inside `jwtVerify` and a JWKS outage surfaces
  // as a verify-time `unavailable`.
  const getJwks = lazyJwks(async () => {
    const jose = await import("jose");
    return jose.createRemoteJWKSet(new URL(jwksUri)) as unknown as JwksResolver;
  });

  return async (token: string) => {
    let jwks: (p: unknown, t: unknown) => Promise<unknown>;
    try {
      jwks = await getJwks();
    } catch (e) {
      return err({
        kind: "unavailable",
        reason: `realm JWKS unavailable: ${e instanceof Error ? e.message : String(e)}`,
      } satisfies JwtVerifyError);
    }

    try {
      const jose = await import("jose");
      // NO `issuer`/`audience` option: those realm-specific policies stay in pure
      // `validateRealmJwtClaims`. jose still enforces standard `exp`/`nbf` semantics
      // here with clock tolerance; the pure validator re-parses and checks them
      // again against its injected strict application clock. The `algorithms`
      // allowlist is an asymmetric-`alg` anti-confusion gate.
      const { payload } = await jose.jwtVerify(token, jwks as never, {
        algorithms: [...REALM_TOKEN_ALGS],
        clockTolerance: CLOCK_TOLERANCE,
      });
      // Signature and jose's standard temporal checks passed. The downstream pure
      // validator re-parses every value and applies realm policy, so passing the raw
      // payload through is safe: the brand attests SIGNATURE, not complete policy.
      return ok(markSignatureVerified(payload as JosePayload as unknown as RealmJwtClaims));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // A lazy JWKS fetch failure inside jwtVerify is infra (503), not a forged
      // token (401). Everything else fails closed as `invalid`.
      return err({ kind: classifyRealmJoseError(e), reason } satisfies JwtVerifyError);
    }
  };
};
