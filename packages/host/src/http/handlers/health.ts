/**
 * Health and readiness probe handlers for Kubernetes integration.
 *
 * - GET /health — liveness probe (always 200 if process is up)
 * - GET /readiness — readiness probe (200 only when host can serve requests)
 */

import type { Context } from "hono";
import type { HostEnv } from "../env.js";
import { healthResponse, readinessResponse } from "../response.js";
import { canServeRequests, getRegistry } from "../../domain/host-state.js";

/**
 * Liveness probe — returns 200 if the process is alive.
 * Reports "degraded" when the host is in degraded state (e.g., Redis disconnected)
 * so monitoring systems can alert without triggering restarts.
 * Kubernetes uses this to determine if the container should be restarted.
 */
export const healthHandler = (c: Context<HostEnv>): Response => {
  const hostState = c.get("hostState");
  if (hostState.phase === "degraded") {
    return healthResponse(c, "degraded");
  }
  return healthResponse(c, "ok");
};

/**
 * Readiness probe — returns 200 only when the host is in a state
 * that can serve requests (ready, degraded, or syncing with existing registry).
 */
export const readinessHandler = (c: Context<HostEnv>): Response => {
  const hostState = c.get("hostState");

  if (!canServeRequests(hostState)) {
    return readinessResponse(c, false, 0, hostState.phase);
  }

  const registry = getRegistry(hostState);
  if (!registry) {
    return readinessResponse(c, false, 0, hostState.phase);
  }

  return readinessResponse(c, true, registry.dags.size, hostState.phase);
};
