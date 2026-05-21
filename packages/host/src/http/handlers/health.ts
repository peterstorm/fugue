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
import { canServeRequests, getRegistry } from "../../domain/host-state.js";

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

  if (canServeRequests(hostState)) {
    const registry = getRegistry(hostState)!;
    return readinessResponse(c, true, registry.dags.size, hostState.phase);
  }

  return readinessResponse(c, false, 0, hostState.phase);
};
