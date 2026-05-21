import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { HostEnv } from "../../http/router.js";
import { healthHandler, readinessHandler } from "../../http/handlers/health.js";
import type { HostState } from "../../domain/host-state.js";
import type { ConcurrencyState } from "../../domain/concurrency.js";
import { emptyRegistry, withDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { initConcurrency } from "../../domain/concurrency.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFakeDag = (id: string): RegisteredDag => ({
  id: id as any,
  team: "test-team",
  route: `/dags/${id}/run`,
  dag: { id: id as any, nodes: [], edges: [] } as any,
  inputSchema: z.object({}),
  config: {},
  loadedAt: Date.now(),
  sha: "abc123",
  healthy: true,
});

const createApp = (hostState: HostState, concurrency?: ConcurrencyState) => {
  const app = new Hono<HostEnv>();
  const conc = concurrency ?? initConcurrency();

  app.use("*", async (c, next) => {
    c.set("hostState", hostState);
    c.set("concurrency", conc);
    await next();
  });

  app.get("/health", healthHandler);
  app.get("/readiness", readinessHandler);
  return app;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with status ok regardless of host state", async () => {
    const app = createApp({ phase: "booting", startedAt: Date.now() });
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("returns 200 even when host is draining", async () => {
    const registry = emptyRegistry();
    const app = createApp({
      phase: "draining",
      registry,
      drainStartedAt: Date.now(),
      inflightCount: 5,
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("returns 200 when host is stopped", async () => {
    const app = createApp({ phase: "stopped" });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("GET /readiness", () => {
  it("returns 200 with ready=true when host is ready", async () => {
    const registry = withDag(emptyRegistry(), makeFakeDag("dag-1"));
    const app = createApp({
      phase: "ready",
      registry,
      lastSyncAt: Date.now(),
      lastSyncSha: "abc123",
    });

    const res = await app.request("/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.dagCount).toBe(1);
    expect(body.phase).toBe("ready");
  });

  it("returns 200 with ready=true when host is degraded (still serves)", async () => {
    const registry = withDag(emptyRegistry(), makeFakeDag("dag-1"));
    const app = createApp({
      phase: "degraded",
      registry,
      reason: "sync-failed",
      since: Date.now(),
    });

    const res = await app.request("/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.phase).toBe("degraded");
  });

  it("returns 200 with ready=true when host is syncing (existing registry)", async () => {
    const registry = withDag(emptyRegistry(), makeFakeDag("dag-1"));
    const app = createApp({
      phase: "syncing",
      registry,
      syncStartedAt: Date.now(),
    });

    const res = await app.request("/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
  });

  it("returns 503 with ready=false when host is booting", async () => {
    const app = createApp({ phase: "booting", startedAt: Date.now() });

    const res = await app.request("/readiness");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.phase).toBe("booting");
    expect(body.dagCount).toBe(0);
  });

  it("returns 503 with ready=false when host is stopped", async () => {
    const app = createApp({ phase: "stopped" });

    const res = await app.request("/readiness");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.phase).toBe("stopped");
  });

  it("returns 503 with ready=false when host is draining", async () => {
    const registry = emptyRegistry();
    const app = createApp({
      phase: "draining",
      registry,
      drainStartedAt: Date.now(),
      inflightCount: 3,
    });

    const res = await app.request("/readiness");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.phase).toBe("draining");
  });
});
