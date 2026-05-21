/**
 * Health and readiness handlers.
 *
 * SC-002: Health/readiness endpoints
 * - GET /health — liveness probe (always 200 if process is up)
 * - GET /readiness — readiness probe (200 only when host can serve requests)
 */

import type { Context } from "hono";
import type { HostEnv } from "../router.js";
import { healthResponse, readinessResponse } from "../response.js";

/**
 * Liveness probe — always returns 200 if the process is alive.
 * Kubernetes uses this to determine if the container should be restarted.
 */
export const healthHandler = (c: Context<HostEnv>): Response => {
  return healthResponse(c, "ok");
};

/**
 * Readiness probe — returns 200 only when the host is in a state
 * that can serve requests (ready, degraded, or syncing with existing registry).
 */
export const readinessHandler = (c: Context<HostEnv>): Response => {
  const hostState = c.get("hostState");

  switch (hostState.phase) {
    case "ready":
      return readinessResponse(c, true, hostState.registry.dags.size, hostState.phase);

    case "degraded":
      return readinessResponse(c, true, hostState.registry.dags.size, hostState.phase);

    case "syncing":
      return readinessResponse(c, true, hostState.registry.dags.size, hostState.phase);

    case "booting":
    case "draining":
    case "stopped":
      return readinessResponse(c, false, 0, hostState.phase);
  }
};
