/**
 * Hono router — wires routes, middleware, and handlers.
 *
 * The router is parameterized by shared state injected via Hono's
 * context variables. This keeps handlers testable without mocks.
 */

import { Hono } from "hono";
import type { HostState } from "../domain/host-state.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { ErrorHandlerLogger } from "./middleware/error-handler.js";
import { healthHandler, readinessHandler } from "./handlers/health.js";
import { listDagsHandler } from "./handlers/list-dags.js";
import { createRunDagHandler } from "./handlers/run-dag.js";
import type { RunDagDeps } from "./handlers/run-dag.js";

// ---------------------------------------------------------------------------
// Shared environment type for Hono context variables
// ---------------------------------------------------------------------------

export type HostEnv = {
  Variables: {
    hostState: HostState;
  };
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface RouterDeps extends RunDagDeps {
  readonly getHostState: () => HostState;
  readonly logger: ErrorHandlerLogger;
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

  // ── Health routes (no concurrency guard) ─────────────────────────────────
  app.get("/health", healthHandler);
  app.get("/readiness", readinessHandler);

  // ── DAG routes ───────────────────────────────────────────────────────────
  app.get("/dags", listDagsHandler);

  // POST /dags/:id/run
  const runDagHandler = createRunDagHandler(deps);
  app.post("/dags/:id/run", runDagHandler);

  return app;
};
