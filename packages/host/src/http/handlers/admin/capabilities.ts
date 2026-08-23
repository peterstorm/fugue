/**
 * Admin capability-health diagnostics.
 *
 * WHY THIS IS AN ADMIN ROUTE AND NOT A PROBE
 *
 * `CapabilityHandle.healthCheck()` is implemented by six adapters (pg, oracle,
 * ms-graph, fs, http-auth, and the path-resolving Graph wrapper), and each one
 * performs REAL I/O — a `SELECT 1`, a token re-acquisition, a `stat`. Hanging
 * that off `/health` would put unbounded I/O on the kubelet's LIVENESS path,
 * where a slow-but-working dependency gets the pod restarted: precisely the
 * wrong reaction. `/readiness` is closer semantically but is polled just as
 * often, so it would turn every probe into a fan-out of dependency round-trips.
 *
 * This endpoint is therefore operator-driven: it runs the checks on demand,
 * when someone is actually diagnosing. It is mounted under `/admin/*` because
 * the report names every wired capability and echoes each failure reason —
 * infrastructure topology that should not be readable unauthenticated.
 *
 * (Periodic polling that feeds the host's degraded state remains a separate,
 * unbuilt feature; it needs a poll interval, a cached report and a state
 * transition, none of which this diagnostic invents.)
 */

import type { Context } from "hono";
import type { CapabilityHandle } from "@fuguejs/framework";
import type { HostEnv } from "../../env.js";
import { checkHealth } from "../../../domain/capability-manager.js";

export interface CapabilityHealthHandlerDeps {
  /**
   * The connected capability handles, read at request time rather than captured
   * at wiring time — the host assigns `sortedHandles` during boot, after the
   * router is built.
   */
  readonly getHandles: () => readonly CapabilityHandle[];
}

/**
 * `GET /admin/capabilities/health` — run every declared capability health check
 * and return the aggregated report.
 *
 * `checkHealth` is best-effort and never throws, so a failing dependency is
 * reported as `unhealthy` in the body rather than surfacing as a 5xx: the
 * endpoint answering IS the successful outcome, and `overall` carries the
 * verdict. A caller that wants a non-200 on degradation should branch on
 * `overall`.
 */
export const createCapabilityHealthHandler =
  (deps: CapabilityHealthHandlerDeps) =>
  async (c: Context<HostEnv>): Promise<Response> => {
    const report = await checkHealth(deps.getHandles());
    return c.json(report, 200);
  };
