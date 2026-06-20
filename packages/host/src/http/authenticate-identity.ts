/**
 * Inbound identity authentication (framework-agnostic).
 *
 * A LEAF auth primitive shared by the supervisor's raw `Bun.serve` listener
 * (`supervisor/supervisor.ts`) and the admin tenants handler
 * (`http/handlers/admin/tenants.ts`). It depends only on the domain auth model,
 * the `auth.ts` middleware primitives, and the narrow ports — never on the
 * supervisor orchestration module — so handlers no longer import "sideways/up"
 * into the supervisor factory just to reuse the auth path.
 */

import { ok, err } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { AuthIdentity, Team, SignatureVerifiedClaims } from "../domain/auth.js";
import { hashToken, isTeamTokenShape, markSubjectToken } from "../domain/auth.js";
import { constantTimeEqual, isJwtShape } from "./middleware/auth.js";
import type { RealmJwtDeps, JwtVerifyError } from "./middleware/auth.js";
import { validateRealmJwtClaims } from "../domain/jwt-validation.js";
import type { TokenStorePort, LogPort } from "../ports.js";

/**
 * Authenticate an inbound bearer token to an `AuthIdentity`, REUSING the exact
 * primitives the Hono `auth.ts` middleware uses (constant-time admin compare,
 * JWT-shape pre-filter + injected verifier + claim validation, hashed team-token
 * lookup) — but without a Hono context, because the supervisor's listener is a
 * raw `Bun.serve` fetch handler. Same resolution ORDER and same fail-closed
 * semantics as the middleware:
 *   1. admin token (constant-time) → admin
 *   2. JWT-shaped + verifier configured → verify signature + validate claims → user
 *   3. team token (`fug_`) → hash → store lookup → team
 *   4. otherwise → unauthorized
 *
 * Returns `Result<AuthIdentity, HostError>` so the listener maps the error to a
 * status uniformly. An auth-infrastructure failure (JWKS/store outage) surfaces
 * as `redis-unavailable` (503) — the closest existing 503 host error — mirroring
 * the middleware's "auth-service-unavailable" branch, never a 401 that would
 * imply a bad credential.
 */
export interface AuthDeps {
  readonly adminToken: string;
  readonly tokenStore: TokenStorePort;
  readonly realmJwt?: RealmJwtDeps;
  readonly logger?: LogPort;
  /** UNIX-seconds clock for `exp` checks (testability); defaults to wall clock. */
  readonly now?: () => number;
}

export const authenticateIdentity = async (
  deps: AuthDeps,
  authHeader: string | undefined,
): Promise<Result<AuthIdentity, HostError>> => {
  if (authHeader === undefined || !authHeader.startsWith("Bearer ")) {
    return err({ kind: "unauthorized", reason: "missing or malformed Authorization header" });
  }
  const token = authHeader.slice(7);
  if (token.length === 0) {
    return err({ kind: "unauthorized", reason: "empty bearer token" });
  }

  // Path 1: admin token (constant-time, no I/O).
  if (constantTimeEqual(token, deps.adminToken)) {
    return ok({ kind: "admin" });
  }

  // Path 2: fugue-platform OIDC JWT. Only when a verifier is wired AND the token
  // is JWT-shaped and NOT `fug_`-shaped. FAIL CLOSED — never falls through to the
  // team path on a verification/claim failure.
  if (deps.realmJwt && !isTeamTokenShape(token) && isJwtShape(token)) {
    const realmJwt = deps.realmJwt;
    let verified: Result<SignatureVerifiedClaims, JwtVerifyError>;
    try {
      verified = await realmJwt.verify(token);
    } catch (e) {
      deps.logger?.error("[supervisor] JWT verifier threw unexpectedly", {
        error: e instanceof Error ? e.message : String(e),
      });
      return err({ kind: "redis-unavailable", operation: "jwt-verify" });
    }
    if (!verified.ok) {
      if (verified.error.kind === "unavailable") {
        deps.logger?.error("[supervisor] JWT signature verification unavailable", { reason: verified.error.reason });
        return err({ kind: "redis-unavailable", operation: "jwt-verify" });
      }
      deps.logger?.warn("[supervisor] JWT signature verification rejected token", { reason: verified.error.reason });
      return err({ kind: "unauthorized", reason: "invalid token" });
    }
    const nowSeconds = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
    const claimsResult = validateRealmJwtClaims(verified.value, {
      expectedIss: realmJwt.expectedIss,
      expectedAud: realmJwt.expectedAud,
      now: nowSeconds,
    });
    if (!claimsResult.ok) {
      deps.logger?.warn("[supervisor] JWT claim validation failed");
      return err({ kind: "unauthorized", reason: "invalid token" });
    }
    const user = claimsResult.value;
    const subjectToken = markSubjectToken(token);
    return ok({
      kind: "user",
      sub: user.sub,
      azp: user.azp,
      canRunDag: (dagTeam: Team) => realmJwt.authorizeUserRun(user, dagTeam),
      subjectToken,
    });
  }

  // Path 3: team token — hash and look up.
  try {
    const hash = await hashToken(token);
    const resolveResult = await deps.tokenStore.resolve(hash);
    if (!resolveResult.ok) {
      deps.logger?.error("[supervisor] Token store unavailable", { errorKind: resolveResult.error.kind });
      return err({ kind: "redis-unavailable", operation: "token-resolve" });
    }
    const grant = resolveResult.value;
    if (!grant) {
      return err({ kind: "unauthorized", reason: "invalid token" });
    }
    return ok({ kind: "team", team: grant.team, label: grant.label });
  } catch (e) {
    deps.logger?.error("[supervisor] Token resolution failed unexpectedly", {
      error: e instanceof Error ? e.message : String(e),
    });
    return err({ kind: "redis-unavailable", operation: "token-resolve" });
  }
};
