/**
 * Bearer token authentication middleware.
 *
 * - If API_TOKEN is configured, all protected routes require
 *   `Authorization: Bearer <token>` header.
 * - If API_TOKEN is not configured, auth is disabled (dev mode).
 * - Health/readiness probes are never protected (applied before this middleware).
 *
 * Uses constant-time comparison to prevent timing attacks on token validation.
 *
 * @satisfies FR-200 — Protected routes require valid bearer token
 */

import type { Context, Next } from "hono";
import { errorResponse } from "../response.js";

// ---------------------------------------------------------------------------
// Constant-time string comparison (timing-attack resistant)
// ---------------------------------------------------------------------------

/**
 * Compare two strings in constant time. Returns true if they are equal.
 * Uses XOR accumulation so execution time doesn't leak prefix length.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface AuthConfig {
  /** The expected bearer token. If undefined, auth is disabled. */
  readonly token: string | undefined;
}

/**
 * Creates a Hono middleware that enforces bearer token auth.
 *
 * When `config.token` is undefined, the middleware is a no-op passthrough.
 * When configured, it validates the Authorization header and rejects with 401.
 */
export const createAuthMiddleware = (config: AuthConfig) => {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Auth disabled — pass through
    if (config.token === undefined) {
      await next();
      return;
    }

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

    const provided = authHeader.slice(7); // "Bearer ".length

    if (!constantTimeEqual(provided, config.token)) {
      return errorResponse(c, 401, "unauthorized", "Invalid bearer token", {
        headers: { "WWW-Authenticate": "Bearer error=\"invalid_token\"" },
      });
    }

    await next();
  };
};
