/**
 * Unit tests for the manifest handler — GET /dags/:id/manifest.
 *
 * Covers: happy-path manifest assembly, 404 on unknown id, 503 on
 * non-serving phases, team-isolation, and the shape of the JSON payload
 * (it's a contract LLM tooling consumes — needs to be stable).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import {
  gitSha,
  dagId,
  defineLinearDag,
  createFetchNode,
  createTransformNode,
  ok,
} from "@fugue/framework";
import { manifestHandler, buildManifest } from "../../http/handlers/manifest.js";
import type { HostState } from "../../domain/host-state.js";
import { freeze } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";
import type { AuthIdentity } from "../../domain/auth.js";

type HostEnv = {
  Variables: {
    hostState: HostState;
    authIdentity: AuthIdentity;
  };
};

const makeApp = (state: HostState, identity: AuthIdentity) => {
  const app = new Hono<HostEnv>();
  app.use("*", async (c, next) => {
    c.set("hostState", state);
    c.set("authIdentity", identity);
    await next();
  });
  app.get("/dags/:id/manifest", manifestHandler);
  return app;
};

const buildSampleDag = () => {
  const fetchUser = createFetchNode({
    id: "fetch-user",
    inputSchema: z.object({ userId: z.string() }),
    outputSchema: z.object({ name: z.string(), email: z.string() }),
    fetch: async (input) =>
      ok({ name: `u-${input.userId}`, email: `${input.userId}@x.test` }),
  });

  const summarize = createTransformNode({
    id: "summarize",
    inputSchema: z.object({ name: z.string(), email: z.string() }),
    outputSchema: z.object({ summary: z.string() }),
    transform: (input) => ok({ summary: `${input.name} <${input.email}>` }),
  });

  return defineLinearDag({
    id: "manifest-test",
    nodes: [fetchUser, summarize],
  });
};

const makeRegisteredDag = (overrides: Partial<RegisteredDag> = {}): RegisteredDag => {
  const dag = buildSampleDag();
  return {
    id: dagId("manifest-test"),
    team: "eng",
    route: "/dags/manifest-test/run",
    dag,
    inputSchema: z.object({ userId: z.string() }),
    config: { timeout: 30000, maxConcurrency: 10 },
    meta: { description: "Sample manifest DAG", version: "1.2.3" },
    loadedAt: 1000,
    sha: gitSha("abc123"),
    status: { kind: "healthy" },
    prompts: new Map(),
    modulePath: "/tmp/dags/eng/manifest-test/dag.ts",
    ...overrides,
  };
};

const adminIdentity: AuthIdentity = { kind: "admin" };

// ──────────────────────────────────────────────────────────────────────────
// buildManifest (pure) — exercise the shape directly
// ──────────────────────────────────────────────────────────────────────────

describe("buildManifest", () => {
  it("returns a manifest with stable shape", () => {
    const registered = makeRegisteredDag();
    const manifest = buildManifest(registered);

    expect(manifest.id).toBe("manifest-test");
    expect(manifest.route).toBe("/dags/manifest-test/run");
    expect(manifest.description).toBe("Sample manifest DAG");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.team).toBe("eng");
    expect(manifest.healthy).toBe(true);
    expect(manifest.sha).toBe("abc123");
    expect(manifest.loadedAt).toBe(1000);
    expect(manifest.outputNodeId).toBe("summarize");

    expect(manifest.nodes).toHaveLength(2);
    expect(manifest.nodes[0]!.id).toBe("fetch-user");
    expect(manifest.nodes[1]!.id).toBe("summarize");
    expect(manifest.edges).toHaveLength(1);
    expect(manifest.edges[0]).toMatchObject({
      from: "fetch-user",
      to: "summarize",
      kind: "unconditional",
    });
    expect(manifest.waves).toEqual([["fetch-user"], ["summarize"]]);

    expect(manifest.inputSchema).toBeDefined();
    expect((manifest.inputSchema as Record<string, unknown>).type).toBe("object");
    expect(manifest.outputSchema).toBeDefined();
    expect((manifest.outputSchema as Record<string, unknown>).type).toBe("object");
  });

  it("flags unhealthy DAGs", () => {
    const registered = makeRegisteredDag({
      status: { kind: "disabled", reason: "circuit-open" },
    });
    const manifest = buildManifest(registered);
    expect(manifest.healthy).toBe(false);
  });

  it("surfaces loaded prompt names", () => {
    const registered = makeRegisteredDag({
      prompts: new Map([
        ["synthesis", "User: {{name}}"],
        ["synthesis-system", "You are a summarizer."],
      ]),
    });
    const manifest = buildManifest(registered);
    expect(manifest.prompts).toEqual(["synthesis", "synthesis-system"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// manifestHandler (HTTP) — exercise routing, status codes, auth
// ──────────────────────────────────────────────────────────────────────────

describe("manifestHandler", () => {
  it("returns 200 with the manifest body for an existing DAG", async () => {
    const dags = [makeRegisteredDag()];
    const state: HostState = {
      phase: "ready",
      registry: freeze(dags, gitSha("abc123"), 1000),
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc123"),
    };
    const app = makeApp(state, adminIdentity);
    const res = await app.request("/dags/manifest-test/manifest");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("manifest-test");
    expect(body.waves).toEqual([["fetch-user"], ["summarize"]]);
  });

  it("returns 404 when the DAG id is not registered", async () => {
    const dags = [makeRegisteredDag()];
    const state: HostState = {
      phase: "ready",
      registry: freeze(dags, gitSha("abc"), 1000),
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc"),
    };
    const app = makeApp(state, adminIdentity);
    const res = await app.request("/dags/does-not-exist/manifest");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("dag-not-found");
    expect(body.details.available).toContain("manifest-test");
  });

  it("returns 503 when the host can't serve", async () => {
    const state: HostState = { phase: "booting", startedAt: 0 };
    const app = makeApp(state, adminIdentity);
    const res = await app.request("/dags/manifest-test/manifest");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("host-unavailable");
  });

  it("returns 400 on an invalid DAG ID format", async () => {
    const state: HostState = {
      phase: "ready",
      registry: freeze([], gitSha("abc"), 1000),
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc"),
    };
    const app = makeApp(state, adminIdentity);
    // Colons are not allowed in DAG IDs.
    const res = await app.request("/dags/bad:id/manifest");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid-dag-id");
  });

  it("returns 403 when a team token requests another team's DAG", async () => {
    const dags = [makeRegisteredDag({ team: "billing" })];
    const state: HostState = {
      phase: "ready",
      registry: freeze(dags, gitSha("abc"), 1000),
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc"),
    };
    const teamIdentity: AuthIdentity = { kind: "team", team: "eng", tokenId: "tok-eng" };
    const app = makeApp(state, teamIdentity);
    const res = await app.request("/dags/manifest-test/manifest");

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
    expect(body.details.callerTeam).toBe("eng");
    expect(body.details.dagTeam).toBe("billing");
  });

  it("allows a team token to fetch its own DAG's manifest", async () => {
    const dags = [makeRegisteredDag({ team: "eng" })];
    const state: HostState = {
      phase: "ready",
      registry: freeze(dags, gitSha("abc"), 1000),
      lastSyncAt: 1000,
      lastSyncSha: gitSha("abc"),
    };
    const teamIdentity: AuthIdentity = { kind: "team", team: "eng", tokenId: "tok-eng" };
    const app = makeApp(state, teamIdentity);
    const res = await app.request("/dags/manifest-test/manifest");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("manifest-test");
  });
});
