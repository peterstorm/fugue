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
import { createAuthMiddleware } from "./middleware/auth.js";
import type { AuthMiddlewareDeps } from "./middleware/auth.js";
import { healthHandler, readinessHandler } from "./handlers/health.js";
import { listDagsHandler } from "./handlers/list-dags.js";
import { createManifestHandler } from "./handlers/manifest.js";
import { createRunDagHandler } from "./handlers/run-dag.js";
import type { RunDagDeps } from "./handlers/run-dag.js";
import { createCreateTeamHandler, createListTeamsHandler, createRevokeTeamHandler } from "./handlers/admin/teams.js";
import type { AdminHandlerDeps } from "./handlers/admin/teams.js";
import type { LogPort } from "../ports.js";
import { errorResponse } from "./response.js";

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
  readonly logger: LogPort;
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

  // ── Admin route guard (defense-in-depth at router level) ─────────────────
  app.use("/admin/*", async (c, next) => {
    const identity = c.get("authIdentity");
    if (!identity || identity.kind !== "admin") {
      return errorResponse(c, 403, "forbidden", "Admin access required");
    }
    await next();
  });

  // ── Admin routes ─────────────────────────────────────────────────────────
  const createTeam = createCreateTeamHandler(deps.adminHandlerDeps);
  const listTeams = createListTeamsHandler(deps.adminHandlerDeps);
  const revokeTeam = createRevokeTeamHandler(deps.adminHandlerDeps);

  app.post("/admin/teams", createTeam);
  app.get("/admin/teams", listTeams);
  app.delete("/admin/teams/:team", revokeTeam);

  // ── DAG routes (authenticated — authorization checked per-DAG) ───────────
  app.get("/dags", listDagsHandler);

  // GET /dags/:id/manifest — registered before the param-less /run route so
  // both bind cleanly; auth + team-isolation is enforced inside the handler.
  app.get("/dags/:id/manifest", createManifestHandler({ logger: deps.logger }));

  // POST /dags/:id/run
  const runDagHandler = createRunDagHandler(deps);
  app.post("/dags/:id/run", runDagHandler);

  // ── Custom route overrides (DagRegistration.route / fugue.yaml route) ────
  // Registered as a POST fallback so hot-reloaded DAGs (whose routes change
  // between syncs) resolve against the CURRENT registry on every request —
  // static mounts would leak stale routes after a sync removes/renames a DAG.
  // The resolver maps the request path back to the owning DAG id and reuses
  // the same run handler (auth, team isolation, concurrency, circuit).
  const routeOf = (c: { get: (k: "hostState") => HostState; req: { path: string } }): string => {
    const state = c.get("hostState");
    const registry = "registry" in state ? state.registry : undefined;
    if (!registry) return "";
    for (const dag of registry.dags.values()) {
      if (dag.route === c.req.path) return dag.id;
    }
    return "";
  };
  const runDagByRouteHandler = createRunDagHandler(deps, (c) => routeOf(c));
  app.post("*", async (c) => {
    if (routeOf(c) === "") {
      return errorResponse(c, 404, "not-found", `No DAG is registered at route '${c.req.path}'`);
    }
    return runDagByRouteHandler(c);
  });

  return app;
};
