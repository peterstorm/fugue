/**
 * Unit tests for list-dags handler.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { gitSha, dagId } from "@fugue/framework";
import type { DagDef } from "@fugue/framework";
import { z } from "zod";
import { listDagsHandler } from "../../http/handlers/list-dags.js";
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
  app.get("/dags", listDagsHandler);
  return app;
};

const makeDag = (id: string, healthy = true): RegisteredDag => ({
  id: dagId(id),
  team: "eng",
  route: `/dags/${id}/run`,
  dag: { id, nodes: [], edges: [] } as unknown as DagDef,
  inputSchema: z.any(),
  config: { timeout: 30000, maxConcurrency: 10 },
  meta: { description: `DAG ${id}`, version: "1.0.0" },
  loadedAt: 1000,
  sha: gitSha("abc123"),
  status: healthy ? { kind: "healthy" } : { kind: "disabled", reason: "test" },
  prompts: new Map(),
  modulePath: `/tmp/dags/eng/${id}/dag.ts`,
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("listDagsHandler", () => {
  it("returns 503 when host is booting", async () => {
    const state: HostState = { phase: "booting", startedAt: 0 };
    const app = makeApp(state);
    const res = await app.request("/dags");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("host-unavailable");
  });

  it("returns 503 when host is draining", async () => {
    const state: HostState = {
      phase: "draining",
      registry: freeze([], gitSha("abc"), 1000),
      drainStartedAt: 2000,
      inflightCount: 0,
    };
    const app = makeApp(state);
    const res = await app.request("/dags");
    expect(res.status).toBe(503);
  });

  it("returns empty array when registry has no dags", async () => {
    const state: HostState = {
      phase: "ready",
      registry: freeze([], gitSha("abc"), 1000),
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc"),
    };
    const app = makeApp(state);
    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dags).toEqual([]);
  });

  it("returns dag list with correct fields", async () => {
    const dags = [makeDag("alpha"), makeDag("beta", false)];
    const state: HostState = {
      phase: "ready",
      registry: freeze(dags, gitSha("abc"), 1000),
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc"),
    };
    const app = makeApp(state);
    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dags).toHaveLength(2);

    const alpha = body.dags.find((d: Record<string, unknown>) => d.id === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha.route).toBe("/dags/alpha/run");
    expect(alpha.description).toBe("DAG alpha");
    expect(alpha.version).toBe("1.0.0");
    expect(alpha.healthy).toBe(true);

    const beta = body.dags.find((d: Record<string, unknown>) => d.id === "beta");
    expect(beta).toBeDefined();
    expect(beta.healthy).toBe(false);
  });

  it("returns dags when host is degraded (still serving)", async () => {
    const state: HostState = {
      phase: "degraded",
      registry: freeze([makeDag("gamma")], gitSha("abc"), 1000),
      reason: "sync-failed",
      since: 2000,
      lastSyncSha: gitSha("abc"),
      lastSyncAt: 1000,
    };
    const app = makeApp(state);
    const res = await app.request("/dags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dags).toHaveLength(1);
  });
});
