import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { HostEnv } from "../../http/router.js";
import { listDagsHandler } from "../../http/handlers/list-dags.js";
import type { HostState } from "../../domain/host-state.js";
import type { ConcurrencyState } from "../../domain/concurrency.js";
import { emptyRegistry, withDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";
import { initConcurrency } from "../../domain/concurrency.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFakeDag = (id: string, opts?: { healthy?: boolean; route?: string }): RegisteredDag => ({
  id: id as any,
  team: "test-team",
  route: opts?.route ?? `/dags/${id}/run`,
  dag: { id: id as any, nodes: [], edges: [] } as any,
  inputSchema: z.object({}),
  config: {},
  loadedAt: Date.now(),
  sha: "abc123",
  healthy: opts?.healthy ?? true,
});

const createApp = (hostState: HostState) => {
  const app = new Hono<HostEnv>();

  app.use("*", async (c, next) => {
    c.set("hostState", hostState);
    c.set("concurrency", initConcurrency());
    await next();
  });

  app.get("/dags", listDagsHandler);
  return app;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /dags", () => {
  it("returns empty list when host is booting", async () => {
    const app = createApp({ phase: "booting", startedAt: Date.now() });
    const res = await app.request("/dags");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dags).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("returns empty list when registry is empty", async () => {
    const app = createApp({
      phase: "ready",
      registry: emptyRegistry(),
      lastSyncAt: Date.now(),
      lastSyncSha: "abc",
    });

    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dags).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("returns all registered DAGs with metadata", async () => {
    let registry = emptyRegistry();
    registry = withDag(registry, makeFakeDag("customer-summary"));
    registry = withDag(registry, makeFakeDag("order-processor", { route: "/custom/orders" }));

    const app = createApp({
      phase: "ready",
      registry,
      lastSyncAt: Date.now(),
      lastSyncSha: "def456",
    });

    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.dags).toHaveLength(2);

    const ids = body.dags.map((d: any) => d.id);
    expect(ids).toContain("customer-summary");
    expect(ids).toContain("order-processor");

    const orderDag = body.dags.find((d: any) => d.id === "order-processor");
    expect(orderDag.route).toBe("/custom/orders");
    expect(orderDag.healthy).toBe(true);
  });

  it("includes unhealthy DAGs with healthy=false", async () => {
    let registry = emptyRegistry();
    registry = withDag(registry, makeFakeDag("healthy-dag"));
    registry = withDag(registry, makeFakeDag("broken-dag", { healthy: false }));

    const app = createApp({
      phase: "ready",
      registry,
      lastSyncAt: Date.now(),
      lastSyncSha: "ghi789",
    });

    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);

    const brokenDag = body.dags.find((d: any) => d.id === "broken-dag");
    expect(brokenDag.healthy).toBe(false);
  });

  it("returns DAGs from degraded state (still has registry)", async () => {
    let registry = emptyRegistry();
    registry = withDag(registry, makeFakeDag("my-dag"));

    const app = createApp({
      phase: "degraded",
      registry,
      reason: "sync-failed",
      since: Date.now(),
    });

    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.dags[0].id).toBe("my-dag");
  });

  it("returns empty list when host is stopped", async () => {
    const app = createApp({ phase: "stopped" });

    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dags).toEqual([]);
    expect(body.count).toBe(0);
  });
});
