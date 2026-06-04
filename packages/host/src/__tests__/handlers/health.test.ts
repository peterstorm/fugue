/**
 * Unit tests for health and readiness handlers.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { gitSha, dagId } from "@fuguejs/framework";
import type { DagDef } from "@fuguejs/framework";
import { z } from "zod";
import { healthHandler, readinessHandler } from "../../http/handlers/health.js";
import type { HostState } from "../../domain/host-state.js";
import { freeze } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";

type HostEnv = {
  Variables: {
    hostState: HostState;
    authIdentity: { kind: "admin" };
  };
};

const makeApp = (state: HostState) => {
  const app = new Hono<HostEnv>();
  app.use("*", async (c, next) => {
    c.set("hostState", state);
    await next();
  });
  app.get("/health", healthHandler);
  app.get("/readiness", readinessHandler);
  return app;
};

const readyState = (): HostState => ({
  phase: "ready",
  registry: freeze([], gitSha("abc123"), 1000),
  lastSyncAt: 1000,
  lastSyncSha: gitSha("abc123"),
});

const bootingState = (): HostState => ({
  phase: "booting",
  startedAt: 0,
});

const drainingState = (): HostState => ({
  phase: "draining",
  registry: freeze([], gitSha("abc123"), 1000),
  drainStartedAt: 2000,
  inflightCount: 3,
});

const stoppedState = (): HostState => ({
  phase: "stopped",
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("healthHandler", () => {
  it("always returns 200", async () => {
    const app = makeApp(bootingState());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("returns 200 even when host is stopped", async () => {
    const app = makeApp(stoppedState());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("readinessHandler", () => {
  it("returns 200 when host is ready", async () => {
    const app = makeApp(readyState());
    const res = await app.request("/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
  });

  it("returns 503 when host is booting", async () => {
    const app = makeApp(bootingState());
    const res = await app.request("/readiness");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.phase).toBe("booting");
  });

  it("returns 503 when host is draining", async () => {
    const app = makeApp(drainingState());
    const res = await app.request("/readiness");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.phase).toBe("draining");
  });

  it("returns 503 when host is stopped", async () => {
    const app = makeApp(stoppedState());
    const res = await app.request("/readiness");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
  });

  it("includes dag count when ready", async () => {
    const dag: RegisteredDag = {
      id: dagId("my-dag"),
      team: "eng",
      route: "/dags/my-dag/run",
      dag: { id: "my-dag", nodes: [], edges: [] } as unknown as DagDef,
      inputSchema: z.any(),
      config: { timeout: 30000, maxConcurrency: 10 },
      meta: { description: "test", version: "1.0.0" },
      loadedAt: 1000,
      sha: gitSha("abc123"),
      status: { kind: "healthy" },
      prompts: new Map(),
      modulePath: "/tmp/dags/eng/my-dag/dag.ts",
    };
    const registry = freeze([dag], gitSha("abc123"), 1000);
    const state: HostState = {
      phase: "ready",
      registry,
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc123"),
    };
    const app = makeApp(state);
    const res = await app.request("/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dagCount).toBe(1);
  });
});
