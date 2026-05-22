/**
 * Bearer token authentication middleware — team-scoped.
 *
 * Two-path resolution:
 * 1. Admin token (env var) — constant-time check, no Redis, full access
 * 2. Team token — hash → Redis lookup → scoped access to team's DAGs
 *
 * Health/readiness probes are excluded (registered before this middleware in the router).
 *
 * Sets `authIdentity` on Hono context for downstream authorization checks.
 *
 * Added post-spec for multi-tenant team isolation.
 * Design decision documented in ADR-0033 trust model.
 */

import type { Context, Next } from "hono";
import type { AuthIdentity } from "../../domain/auth.js";
import { hashToken } from "../../domain/auth.js";
import type { TokenGrant } from "../../domain/auth.js";
import type { TokenStorePort } from "../../ports.js";
import { errorResponse } from "../response.js";

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

export interface AuthMiddlewareDeps {
  /** The admin token from ADMIN_TOKEN env var */
  readonly adminToken: string;
  /** Token store for resolving team tokens */
  readonly tokenStore: TokenStorePort;
  /** Optional logger for diagnosing auth failures */
  readonly logger?: import("../../ports.js").LogPort;
}

// ---------------------------------------------------------------------------
// Hono env extension for auth identity
// ---------------------------------------------------------------------------

export type AuthEnv = {
  Variables: {
    authIdentity: AuthIdentity;
  };
};

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates a Hono middleware that resolves bearer tokens to AuthIdentity.
 *
 * Resolution order:
 * 1. Missing/malformed header → 401
 * 2. Admin token match (constant-time) → identity = admin
 * 3. Hash token → Redis lookup → identity = team
 * 4. Not found → 401
 */
export const createAuthMiddleware = (deps: AuthMiddlewareDeps) => {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return errorResponse(c, 401, "unauthorized", "Missing Authorization header", {
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return errorResponse(c, 401, "unauthorized", "Authorization header must use Bearer scheme", {
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }

    const token = authHeader.slice(7); // "Bearer ".length

    if (token.length === 0) {
      return errorResponse(c, 401, "unauthorized", "Empty bearer token", {
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }

    // Path 1: Admin token (constant-time, no Redis)
    if (constantTimeEqual(token, deps.adminToken)) {
      c.set("authIdentity", { kind: "admin" } satisfies AuthIdentity);
      await next();
      return;
    }

    // Path 2: Team token — hash and look up in store
    let grant: TokenGrant | null;
    try {
      const hash = await hashToken(token);
      const resolveResult = await deps.tokenStore.resolve(hash);
      if (!resolveResult.ok) {
        // Redis/infrastructure failure — surface as 503 not 401
        return errorResponse(c, 503, "auth-service-unavailable",
          "Authentication service temporarily unavailable");
      }
      grant = resolveResult.value;
    } catch (e) {
      // Log the actual error server-side for diagnostics
      deps.logger?.error("[auth-middleware] Token resolution failed unexpectedly", {
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      // crypto.subtle or unexpected failure — surface as 503
      return errorResponse(c, 503, "auth-service-unavailable",
        "Authentication service temporarily unavailable");
    }

    if (!grant) {
      return errorResponse(c, 401, "unauthorized", "Invalid bearer token", {
        headers: { "WWW-Authenticate": "Bearer error=\"invalid_token\"" },
      });
    }

    c.set("authIdentity", {
      kind: "team",
      team: grant.team,
      label: grant.label,
    } satisfies AuthIdentity);

    await next();
  };
};
