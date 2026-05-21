/**
 * List DAGs handler — returns metadata for all registered DAGs.
 *
 * FR-028: GET /dags returns list of registered DAGs with metadata
 */

import type { Context } from "hono";
import type { HostEnv } from "../router.js";
import { dagListResponse } from "../response.js";
import type { DagListItem } from "../response.js";

/**
 * Returns the list of all registered DAGs with their metadata.
 * Includes both healthy and unhealthy DAGs (unhealthy are flagged).
 */
export const listDagsHandler = (c: Context<HostEnv>): Response => {
  const hostState = c.get("hostState");

  // Extract registry from whichever phase we're in
  const registry = (() => {
    switch (hostState.phase) {
      case "ready":
      case "degraded":
      case "syncing":
      case "draining":
        return hostState.registry;
      case "booting":
      case "stopped":
        return undefined;
    }
  })();

  if (!registry) {
    return dagListResponse(c, []);
  }

  const dags: DagListItem[] = [];
  for (const [, reg] of registry.dags) {
    dags.push({
      id: reg.id,
      route: reg.route,
      description: "",
      version: reg.sha,
      healthy: reg.healthy,
    });
  }

  return dagListResponse(c, dags);
};
