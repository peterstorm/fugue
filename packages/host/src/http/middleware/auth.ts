/**
 * Bearer token authentication middleware — team-scoped + user (OIDC) inbound.
 *
 * Three-path resolution, in the ACTUAL code order (admin → JWT → team):
 * 1. Admin token (env var) — constant-time check, no Redis, full access.
 * 2. fugue-platform OIDC JWT — entered only for a token that is NOT `fug_`-shaped
 *    AND is JWT-shaped, with a verifier configured. Signature verified via the
 *    INJECTED JWKS verifier, then pure claim validation (iss=realm,
 *    aud=fugue-host, exp>now). On success the identity is
 *    `{ kind: "user", sub, azp, canRunDag }` (FR-W3-006/007) — `canRunDag`
 *    carries the wiring site's REQUIRED `authorizeUserRun` policy
 *    (`RealmJwtDeps`), the inbound run-gate decision for this user. FAIL
 *    CLOSED — never falls through to the team path on failure.
 * 3. Team token (`fug_`-shaped) — hash → Redis lookup → scoped access.
 *
 * DISCRIMINATING JWT vs OPAQUE (fail-safe ordering):
 *   - The admin path is tried FIRST and is byte-unchanged. The admin token is an
 *     arbitrary high-entropy string, never JWT-shaped.
 *   - A token is treated as a JWT only if it is NOT the admin token, does NOT
 *     have the `fug_` team-token shape (`isTeamTokenShape`), AND matches the JWT
 *     compact-serialization shape: three non-empty base64url segments separated
 *     by dots (`a.b.c`). The `fug_` exclusion is enforced in code (not merely
 *     implied by today's token alphabet), so a `fug_` token is ALWAYS resolved by
 *     the team store, never the JWT path (review I5). This is a structural
 *     pre-filter only — the signature verifier remains authoritative; a
 *     structurally-JWT token still 401s unless the signature AND claims pass.
 *
 * Health/readiness probes are excluded (registered before this middleware in the router).
 * Sets `authIdentity` on Hono context for downstream authorization checks.
 *
 * Trust model: admin token (env) is root of trust; team tokens are hashed and
 * resolved via Redis; user JWTs are verified against the realm JWKS (injected).
 * See packages/host/docs/auth.md for full design.
 */

import type { Context, Next } from "hono";
import type { AuthIdentity, AuthenticatedUser, SignatureVerifiedClaims, Team, VerifyRealmJwt, JwtVerifyError } from "../../domain/auth.js";
import { hashToken, isTeamTokenShape, markSubjectToken } from "../../domain/auth.js";
import type { TokenGrant } from "../../domain/auth.js";
import { validateRealmJwtClaims, describeAuthError } from "../../domain/jwt-validation.js";
import type { TokenStorePort } from "../../ports.js";
import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { errorResponse } from "../response.js";

// ---------------------------------------------------------------------------
// Realm JWT verifier port (signature verification — INJECTED, never hardcoded)
// ---------------------------------------------------------------------------
// The port and its error type are DOMAIN types: the pure claim validator
// (`domain/jwt-validation.ts`) consumes the port, and adapters implement it, so
// the middleware shell imports them rather than owning them. They live in
// `domain/auth.ts` and are re-exported here because every dep bundle that wires
// the realm-JWT path names the verifier and its error together.
export type { JwtVerifyError, VerifyRealmJwt } from "../../domain/auth.js";

// ---------------------------------------------------------------------------
// Constant-time string comparison (timing-attack resistant)
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison. Iterates full max-length regardless
 * of content, preventing both prefix and length timing side-channels.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length; // length difference contributes to result
  for (let i = 0; i < maxLen; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
};

// ---------------------------------------------------------------------------
// Middleware deps
// ---------------------------------------------------------------------------

/**
 * Everything the JWT inbound path needs, grouped as ONE optional unit so a
 * verifier-without-policy (or policy-without-verifier) is UNREPRESENTABLE —
 * the same pairing move as the framework's `MintingAuthority`. The previous
 * shape (three independent optionals) admitted a half-wired state that had to
 * be caught at request time with a 503; grouping deletes that branch.
 */
export interface RealmJwtDeps {
  /**
   * Realm JWT signature verifier (INJECTED — JWKS-backed in production, fake in
   * tests). The ONLY producer of `SignatureVerifiedClaims`.
   */
  readonly verify: VerifyRealmJwt;
  /** The fugue-platform realm issuer the JWT must declare (FR-W3-006). */
  readonly expectedIss: string;
  /** The audience this host must appear in — `fugue-host` (FR-W3-006). */
  readonly expectedAud: string;
  /**
   * AUTHORIZATION policy for user-initiated runs: may `user` run/see DAGs
   * owned by `dagTeam`? REQUIRED, not optional — wiring a verifier without
   * deciding this policy would silently activate a latent any-user-runs-any-DAG
   * grant (consuming the team's concurrency permits, LLM budget, and circuit
   * headroom; the broker's scope gate only protects downstream Graph/Dynamics
   * hops, not DAG execution). Making it a required member of the SAME group as
   * the verifier forces the decision at the wiring site, in types. The
   * middleware captures it onto the `user` identity's `canRunDag`, which
   * `canAccessDag` delegates to.
   */
  readonly authorizeUserRun: (user: AuthenticatedUser, dagTeam: Team) => boolean;
}

export interface AuthMiddlewareDeps {
  /** The admin token from ADMIN_TOKEN env var */
  readonly adminToken: string;
  /** Token store for resolving team tokens */
  readonly tokenStore: TokenStorePort;
  /** Optional logger for diagnosing auth failures */
  readonly logger?: import("../../ports.js").LogPort;
  /**
   * The JWT inbound path: verifier + iss/aud policy as one inseparable group.
   * When omitted, the JWT path is disabled and a JWT-shaped token simply falls
   * through to a 401 (no signature can be verified → fail closed).
   */
  readonly realmJwt?: RealmJwtDeps;
  /**
   * Injected clock returning UNIX SECONDS, for `exp` checks (purity/testability).
   * When omitted, the wall clock (`Date.now()/1000`) is used.
   */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// JWT compact-serialization shape detector (structural pre-filter only)
// ---------------------------------------------------------------------------

/** One base64url segment: non-empty, only the base64url alphabet (no padding). */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * True iff `token` looks like a JWT compact serialization: exactly three
 * non-empty base64url segments separated by dots (`header.payload.signature`).
 * This is a STRUCTURAL gate only — it decides which resolution path to try, not
 * whether the token is trusted. The injected signature verifier is authoritative.
 */
export const isJwtShape = (token: string): boolean => {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0 && BASE64URL_SEGMENT.test(p));
};

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

// Both Hono context shapes live in `env.js`; re-exported here for the
// middleware's own test call sites.
export type { AuthEnv } from "../env.js";

/**
 * The shared bearer-challenge 401. ONE encoding (round-38 cs-18) of the
 * status + `WWW-Authenticate` pair the header-shape rejections all owe the
 * caller: a challenge omitted from one of them would leave a client unable to
 * tell it should retry with credentials.
 */
const bearerChallenge = (c: Context, message: string): Response =>
  errorResponse(c, 401, "unauthorized", message, {
    headers: { "WWW-Authenticate": "Bearer" },
  });

/**
 * THE one 503 for an auth INFRASTRUCTURE failure (verifier throw, JWKS outage,
 * key rotation). Sharing it keeps the client-facing text uniformly free of the
 * server-side reason — which is logged, never returned — so no site can start
 * leaking why authentication is unavailable.
 */
const authServiceUnavailable = (c: Context): Response =>
  errorResponse(c, 503, "auth-service-unavailable",
    "Authentication service temporarily unavailable");

/**
 * THE one 401 for a token that was PRESENT but did not verify. Distinct from
 * `bearerChallenge` (header-shape problems, plain `Bearer` challenge): a
 * presented-but-invalid token owes the `invalid_token` error code so a client
 * knows to re-authenticate rather than merely add credentials.
 */
const invalidBearerToken = (c: Context): Response =>
  errorResponse(c, 401, "unauthorized", "Invalid bearer token", {
    headers: { "WWW-Authenticate": "Bearer error=\"invalid_token\"" },
  });

/** Parse the `Authorization` header into the bearer token, or the 401 to return. */
const parseBearerToken = (c: Context): Result<string, Response> => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    return err(bearerChallenge(c, "Missing Authorization header"));
  }

  if (!authHeader.startsWith("Bearer ")) {
    return err(bearerChallenge(c, "Authorization header must use Bearer scheme"));
  }

  const token = authHeader.slice(7); // "Bearer ".length

  if (token.length === 0) {
    return err(bearerChallenge(c, "Empty bearer token"));
  }
  return ok(token);
};

/** Verify the token signature via the injected verifier; infra failure → 503, bad token → 401. */
const verifyJwtSignature = async (
  c: Context,
  deps: AuthMiddlewareDeps,
  realmJwt: RealmJwtDeps,
  token: string,
): Promise<Result<SignatureVerifiedClaims, Response>> => {
  let verified: Result<SignatureVerifiedClaims, JwtVerifyError>;
  try {
    verified = await realmJwt.verify(token);
  } catch (e) {
    deps.logger?.error("[auth-middleware] JWT verifier threw unexpectedly", {
      error: e instanceof Error ? e.message : String(e),
    });
    // Verifier infrastructure (JWKS fetch, key rotation) failure → 503.
    return err(authServiceUnavailable(c));
  }

  if (verified.ok) return verified;

  if (verified.error.kind === "unavailable") {
    // JWKS/network failure — infra, not the client's fault → 503. The
    // reason is logged server-side (it never reaches the client): without
    // it, a JWKS outage is a 503 storm with zero diagnostics.
    deps.logger?.error("[auth-middleware] JWT signature verification unavailable", {
      reason: verified.error.reason,
    });
    return err(authServiceUnavailable(c));
  }
  // Bad signature / unparsable token → 401 (never leak the reason to the
  // client; log it server-side, mirroring the claim-validation path).
  deps.logger?.warn("[auth-middleware] JWT signature verification rejected token", {
    reason: verified.error.reason,
  });
  return err(invalidBearerToken(c));
};

/**
 * Path 2: fugue-platform OIDC JWT — first-class inbound mode (FR-W3-006).
 * FAIL CLOSED: a JWT-shaped token that reaches here must be fully verified and
 * validated; it never falls through to the team path on failure.
 */
const resolveJwtIdentity = async (
  c: Context,
  deps: AuthMiddlewareDeps,
  realmJwt: RealmJwtDeps,
  token: string,
): Promise<Result<AuthIdentity, Response>> => {
  const verified = await verifyJwtSignature(c, deps, realmJwt, token);
  if (!verified.ok) return verified;

  // `exp` is UNIX seconds (OIDC). Injected `now` is expected to already be
  // in seconds (pure/testable); the default wall clock is ms → convert.
  const nowSeconds = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const claimsResult = validateRealmJwtClaims(verified.value, {
    expectedIss: realmJwt.expectedIss,
    expectedAud: realmJwt.expectedAud,
    now: nowSeconds,
  });

  if (!claimsResult.ok) {
    // wrong-iss / wrong-aud / expired / malformed → 401. Reason logged
    // server-side only; the client gets a generic message.
    deps.logger?.warn("[auth-middleware] JWT claim validation failed", {
      reason: describeAuthError(claimsResult.error),
    });
    return err(invalidBearerToken(c));
  }

  // Capture the wiring-site authorization policy onto the identity: the
  // branded `AuthenticatedUser` is closed over, so the policy always judges
  // the principal this very token authenticated.
  const user = claimsResult.value;
  // Brand THIS exact compact JWT as the `subject_token` proof (FR-030): the
  // signature of `token` was cryptographically verified above by the injected
  // verifier. This is the SOLE producer site for `SubjectToken`. The raw token
  // is carried host-side on the identity ONLY — it never crosses
  // `InvocationOrigin` (FR-032) and is never put on a handle (NFR-011); the
  // broker resolves it for the user exchange via the run-context side-channel.
  const subjectToken = markSubjectToken(token);
  return ok({
    kind: "user",
    sub: user.sub,
    azp: user.azp,
    canRunDag: (dagTeam: Team) => realmJwt.authorizeUserRun(user, dagTeam),
    subjectToken,
  } satisfies AuthIdentity);
};

/** Path 3: Team token — hash and look up in store. */
const resolveTeamIdentity = async (
  c: Context,
  deps: AuthMiddlewareDeps,
  token: string,
): Promise<Result<AuthIdentity, Response>> => {
  let grant: TokenGrant | null;
  try {
    const hash = await hashToken(token);
    const resolveResult = await deps.tokenStore.resolve(hash);
    if (!resolveResult.ok) {
      // Redis/infrastructure failure — surface as 503 not 401. Log the typed
      // error server-side first (mirrors the JWT `unavailable` branch above):
      // without it, a token-store outage is a 503 storm with zero diagnostics.
      deps.logger?.error("[auth-middleware] Token store unavailable", {
        errorKind: resolveResult.error.kind,
        error: JSON.stringify(resolveResult.error),
      });
      return err(authServiceUnavailable(c));
    }
    grant = resolveResult.value;
  } catch (e) {
    // Log the actual error server-side for diagnostics
    deps.logger?.error("[auth-middleware] Token resolution failed unexpectedly", {
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
    // crypto.subtle or unexpected failure — surface as 503
    return err(authServiceUnavailable(c));
  }

  if (!grant) {
    return err(invalidBearerToken(c));
  }

  return ok({
    kind: "team",
    team: grant.team,
    label: grant.label,
  } satisfies AuthIdentity);
};

/**
 * Whether the token takes the JWT path. Only entered for a token that (a) a
 * verifier is configured for, (b) does NOT have the `fug_` team-token shape,
 * and (c) matches the JWT compact serialization. The `!isTeamTokenShape` guard
 * makes the documented contract load-bearing rather than incidental (review
 * I5): generated `fug_` tokens are base64url + dot-free so are never
 * JWT-shaped today, but a future `fug_` token containing two dots would
 * otherwise route to the JWT path and 401 instead of the team store.
 */
const jwtPathFor = (deps: AuthMiddlewareDeps, token: string): RealmJwtDeps | undefined =>
  deps.realmJwt && !isTeamTokenShape(token) && isJwtShape(token) ? deps.realmJwt : undefined;

/** Resolve a bearer token to an identity in the fixed order admin → JWT → team. */
const resolveIdentity = async (
  c: Context,
  deps: AuthMiddlewareDeps,
  token: string,
): Promise<Result<AuthIdentity, Response>> => {
  // Path 1: Admin token (constant-time, no Redis)
  if (constantTimeEqual(token, deps.adminToken)) {
    return ok({ kind: "admin" } satisfies AuthIdentity);
  }
  const realmJwt = jwtPathFor(deps, token);
  if (realmJwt) return resolveJwtIdentity(c, deps, realmJwt, token);
  return resolveTeamIdentity(c, deps, token);
};

/**
 * Creates a Hono middleware that resolves bearer tokens to AuthIdentity.
 *
 * Resolution order (admin & team paths byte-unchanged for regression safety):
 * 1. Missing/malformed header → 401
 * 2. Admin token match (constant-time) → identity = admin
 * 3. JWT-shaped token + verifier configured → verify signature, validate claims
 *    → identity = user (or 401 invalid/expired/wrong-aud, 503 verifier infra)
 * 4. Hash token → Redis lookup → identity = team
 * 5. Not found → 401
 */
export const createAuthMiddleware = (deps: AuthMiddlewareDeps) => {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const bearer = parseBearerToken(c);
    if (!bearer.ok) return bearer.error;

    const resolved = await resolveIdentity(c, deps, bearer.value);
    if (!resolved.ok) return resolved.error;

    c.set("authIdentity", resolved.value);
    await next();
  };
};
