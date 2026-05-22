/**
 * Hono router — wires routes, middleware, and handlers.
 *
 * The router is parameterized by shared state injected via Hono's
 * context variables. This keeps handlers testable without mocks.
 *
 * Route protection:
 * - /health, /readiness — unauthenticated (k8s probes)
 * - /admin/* — requires admin token
 * - /dags/* — requires any valid token (team or admin), authorization checked per-DAG
 */

import { Hono } from "hono";
import type { HostState } from "../domain/host-state.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { ErrorHandlerLogger } from "./middleware/error-handler.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import type { AuthMiddlewareDeps } from "./middleware/auth.js";
import { healthHandler, readinessHandler } from "./handlers/health.js";
import { listDagsHandler } from "./handlers/list-dags.js";
import { createRunDagHandler } from "./handlers/run-dag.js";
import type { RunDagDeps } from "./handlers/run-dag.js";
import { createCreateTeamHandler, createListTeamsHandler, createRevokeTeamHandler } from "./handlers/admin/teams.js";
import type { AdminHandlerDeps } from "./handlers/admin/teams.js";

// ---------------------------------------------------------------------------
// Shared environment type for Hono context variables
// ---------------------------------------------------------------------------

export type HostEnv = {
  Variables: {
    hostState: HostState;
    authIdentity: import("../domain/auth.js").AuthIdentity;
  };
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface RouterDeps extends RunDagDeps, AuthMiddlewareDeps {
  readonly getHostState: () => HostState;
  readonly logger: ErrorHandlerLogger;
  readonly adminHandlerDeps: AdminHandlerDeps;
}

/**
 * Creates the Hono app with all routes wired up.
 *
 * Dependencies are injected via closure — no global state.
 * The host lifecycle (startup) calls this once and passes
 * mutable references to state containers.
 */
export const createRouter = (deps: RouterDeps): Hono<HostEnv> => {
  const app = new Hono<HostEnv>();

  // ── Global error handler ─────────────────────────────────────────────────
  app.onError(createErrorHandler(deps.logger));

  // ── Inject shared state into context ─────────────────────────────────────
  app.use("*", async (c, next) => {
    c.set("hostState", deps.getHostState());
    await next();
  });

  // ── Health routes (no auth, no concurrency guard) ────────────────────────
  app.get("/health", healthHandler);
  app.get("/readiness", readinessHandler);

  // ── Auth middleware (applied to all routes below) ────────────────────────
  app.use("*", createAuthMiddleware(deps));

  // ── Admin routes (admin identity enforced inside handlers) ───────────────
  const createTeam = createCreateTeamHandler(deps.adminHandlerDeps);
  const listTeams = createListTeamsHandler(deps.adminHandlerDeps);
  const revokeTeam = createRevokeTeamHandler(deps.adminHandlerDeps);

  app.post("/admin/teams", createTeam);
  app.get("/admin/teams", listTeams);
  app.delete("/admin/teams/:team", revokeTeam);

  // ── DAG routes (authenticated — authorization checked per-DAG) ───────────
  app.get("/dags", listDagsHandler);

  // POST /dags/:id/run
  const runDagHandler = createRunDagHandler(deps);
  app.post("/dags/:id/run", runDagHandler);

  return app;
};
