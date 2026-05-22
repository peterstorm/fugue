/**
 * Admin handlers — team token provisioning.
 *
 * All admin routes require admin identity (enforced by router grouping).
 *
 * POST /admin/teams        — provision a new team token
 * GET  /admin/teams        — list provisioned teams
 * DELETE /admin/teams/:team — revoke a team's token
 */

import type { Context } from "hono";
import { formatToken, hashToken } from "../../../domain/auth.js";
import type { TokenGrant } from "../../../domain/auth.js";
import type { AuthIdentity } from "../../../domain/auth.js";
import type { TokenStorePort } from "../../../ports.js";
import { errorResponse } from "../../response.js";

// ── Dependencies ───────────────────────────────────────────────────────────

export interface AdminHandlerDeps {
  readonly tokenStore: TokenStorePort;
  readonly clock: () => number;
  readonly generateRandomBytes: () => Uint8Array;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Guard that checks if the current identity is admin.
 * Returns a 403 response if not. Should not be reachable if router is wired correctly,
 * but defense in depth.
 */
const requireAdmin = (c: Context): Response | null => {
  const identity = c.get("authIdentity") as AuthIdentity | undefined;
  if (!identity || identity.kind !== "admin") {
    return errorResponse(c, 403, "forbidden", "Admin access required");
  }
  return null;
};

// ── POST /admin/teams ──────────────────────────────────────────────────────

/**
 * Provision a new team token.
 *
 * Request body: { team: string, label?: string }
 * Response: { token: string, team: string, label: string }
 *
 * The raw token is returned ONCE in the response. Only the hash is stored.
 */
export const createCreateTeamHandler = (deps: AdminHandlerDeps) => {
  return async (c: Context): Promise<Response> => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    // Parse request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "body-parse-failed", "Request body must be valid JSON");
    }

    if (!body || typeof body !== "object") {
      return errorResponse(c, 400, "input-validation-failed", "Request body must be an object");
    }

    const { team, label } = body as Record<string, unknown>;

    if (!team || typeof team !== "string" || team.trim().length === 0) {
      return errorResponse(c, 400, "input-validation-failed", "\"team\" field is required and must be a non-empty string");
    }

    const teamName = team.trim().toLowerCase();
    const teamLabel = typeof label === "string" && label.trim().length > 0
      ? label.trim()
      : `${teamName} token`;

    // Validate team name format (alphanumeric + hyphens, like DNS labels)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(teamName) && teamName.length > 1) {
      return errorResponse(c, 400, "input-validation-failed",
        "Team name must be lowercase alphanumeric with hyphens (e.g., 'team-a')");
    }
    if (teamName.length === 1 && !/^[a-z0-9]$/.test(teamName)) {
      return errorResponse(c, 400, "input-validation-failed",
        "Team name must be lowercase alphanumeric with hyphens (e.g., 'team-a')");
    }

    // Generate token
    const randomBytes = deps.generateRandomBytes();
    const rawToken = formatToken(randomBytes);
    const hash = await hashToken(rawToken);

    // Build grant
    const grant: TokenGrant = {
      team: teamName,
      label: teamLabel,
      createdAt: deps.clock(),
    };

    // Store in token store
    const storeResult = await deps.tokenStore.store(teamName, hash, grant);
    if (!storeResult.ok) {
      if (storeResult.error.kind === "team-already-exists") {
        return errorResponse(c, 409, "team-already-exists",
          `Team '${teamName}' already has a token. Revoke it first to generate a new one.`);
      }
      return errorResponse(c, 500, "internal-error", "Failed to store team token");
    }

    // Return the raw token (shown once)
    return c.json({
      ok: true,
      token: rawToken,
      team: teamName,
      label: teamLabel,
    }, 201);
  };
};

// ── GET /admin/teams ───────────────────────────────────────────────────────

/**
 * List all provisioned teams.
 * Does NOT return tokens (hashes only exist in Redis).
 */
export const createListTeamsHandler = (deps: AdminHandlerDeps) => {
  return async (c: Context): Promise<Response> => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const teamsResult = await deps.tokenStore.listTeams();
    if (!teamsResult.ok) {
      return errorResponse(c, 500, "internal-error", "Failed to list teams");
    }

    const teams = teamsResult.value;

    return c.json({
      ok: true,
      teams: teams.map((t) => ({
        team: t.team,
        label: t.label,
        createdAt: t.createdAt,
      })),
      count: teams.length,
    }, 200);
  };
};

// ── DELETE /admin/teams/:team ───────────────────────────────────────────────

/**
 * Revoke a team's token. Idempotent.
 * After revocation, the team's existing token immediately stops working.
 */
export const createRevokeTeamHandler = (deps: AdminHandlerDeps) => {
  return async (c: Context): Promise<Response> => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const team = c.req.param("team") ?? "";
    if (team.trim().length === 0) {
      return errorResponse(c, 400, "input-validation-failed", "Team name is required");
    }

    const result = await deps.tokenStore.revoke(team.trim().toLowerCase());
    if (!result.ok) {
      return errorResponse(c, 500, "internal-error", "Failed to revoke team token");
    }

    return c.json({ ok: true, team: team.trim().toLowerCase(), revoked: true }, 200);
  };
};
