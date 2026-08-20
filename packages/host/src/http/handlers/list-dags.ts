/**
 * List DAGs handler — returns metadata for all registered DAGs.
 *
 * FR-023: GET /dags returns list of registered DAGs with metadata.
 *
 * Auth: same team-isolation rules as `POST /dags/:id/run` and
 * `GET /dags/:id/manifest`. A team token sees only DAGs belonging to its
 * team; admin tokens see everything. Without this filter, a team token
 * could enumerate every DAG id deployed by every other team — a stronger
 * leak than a single 403 since it surfaces the whole topology at once.
 */

import type { Context } from "hono";
import type { HostEnv } from "../env.js";
import { dagListResponse, hostUnavailableResponse } from "../response.js";
import type { DagListItem } from "../response.js";
import { getRegistry } from "../../domain/host-state.js";
import { errorResponse } from "../response.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { canAccessDag } from "../../domain/auth.js";

/**
 * Returns the list of registered DAGs visible to the caller. Includes both
 * healthy and unhealthy DAGs (unhealthy are flagged). Rejects requests when
 * host cannot serve (booting, draining, stopped).
 */
export const listDagsHandler = (c: Context<HostEnv>): Response => {
  const hostState = c.get("hostState");

  const unavailable = hostUnavailableResponse(c, hostState);
  if (unavailable) return unavailable;

  const identity = c.get("authIdentity") as AuthIdentity | undefined;
  if (!identity) {
    return errorResponse(c, 401, "unauthorized", "Missing auth identity — middleware not applied");
  }

  const registry = getRegistry(hostState);
  if (!registry) {
    return dagListResponse(c, []);
  }

  const dags: DagListItem[] = [];
  for (const [, reg] of registry.dags) {
    if (!canAccessDag(identity, reg.team)) continue;
    dags.push({
      id: reg.id,
      route: reg.route,
      description: reg.meta.description,
      version: reg.meta.version,
      healthy: reg.status.kind === "healthy",
      team: reg.team,
      ...(reg.meta.owner !== undefined ? { owner: reg.meta.owner } : {}),
    });
  }

  return dagListResponse(c, dags);
};
