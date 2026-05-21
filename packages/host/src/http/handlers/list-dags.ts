/**
 * List DAGs handler — returns metadata for all registered DAGs.
 *
 * FR-028: GET /dags returns list of registered DAGs with metadata
 */

import type { Context } from "hono";
import type { HostEnv } from "../router.js";
import { dagListResponse } from "../response.js";
import type { DagListItem } from "../response.js";
import { canServeRequests, getRegistry } from "../../domain/host-state.js";
import { errorResponse } from "../response.js";

/**
 * Returns the list of all registered DAGs with their metadata.
 * Includes both healthy and unhealthy DAGs (unhealthy are flagged).
 * Rejects requests when host cannot serve (booting, draining, stopped).
 */
export const listDagsHandler = (c: Context<HostEnv>): Response => {
  const hostState = c.get("hostState");

  if (!canServeRequests(hostState)) {
    return errorResponse(c, 503, "host-unavailable", `Host is ${hostState.phase} \u2014 not accepting requests`, {
      details: { phase: hostState.phase },
    });
  }

  const registry = getRegistry(hostState);
  if (!registry) {
    return dagListResponse(c, []);
  }

  const dags: DagListItem[] = [];
  for (const [, reg] of registry.dags) {
    dags.push({
      id: reg.id,
      route: reg.route,
      description: reg.meta.description,
      version: reg.meta.version,
      healthy: reg.status.kind === "healthy",
    });
  }

  return dagListResponse(c, dags);
};
