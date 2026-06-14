import { describe, it, expect } from "bun:test";
import { gitSha } from "@fuguejs/framework";
import type { NodeContext, DagId } from "@fuguejs/framework";
import { createRouter } from "../../http/router.js";
import type { RouterDeps } from "../../http/router.js";
import type { RunDagDeps } from "../../http/handlers/run-dag.js";
import { initConcurrency } from "../../domain/concurrency.js";
import { initCircuit } from "../../domain/circuit-breaker.js";
import type { CircuitState } from "../../domain/circuit-breaker.js";
import type { HostState } from "../../domain/host-state.js";
import { freeze } from "../../domain/registry.js";
import { createInMemoryTokenStore } from "../../adapters/token-store.js";
import { hashToken } from "../../domain/auth.js";
import type { TokenStorePort } from "../../ports.js";

const ADMIN_TOKEN = "admin-secret-token-long-enough";
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const SHA = gitSha("a".repeat(40));

const readyState = (): HostState => ({
  phase: "ready",
  registry: freeze([], SHA, Date.now()),
  lastSyncAt: Date.now(),
  lastSyncSha: SHA,
});

const makeRouterDeps = (tokenStore: TokenStorePort): RouterDeps => {
  let concurrency = initConcurrency(50, 10);
  const circuits = new Map<DagId, CircuitState>();
  return {
    getHostState: readyState,
    getConcurrency: () => concurrency,
    setConcurrency: (s) => { concurrency = s; },
    circuit: {
      get: (id) => circuits.get(id) ?? initCircuit(Date.now()),
      set: (id, s) => { circuits.set(id, s); },
    },
    circuitConfig: { threshold: 5, windowMs: 60_000 },
    createContext: (() =>
      Promise.resolve({
        ctx: { runId: "r" } as unknown as NodeContext,
        origin: { kind: "agent", agentClientId: "r" },
      })) as unknown as RunDagDeps["createContext"],
    executeDag: (async () => ({ ok: true, value: {} })) as RunDagDeps["executeDag"],
    clock: Date.now,
    adminToken: ADMIN_TOKEN,
    tokenStore,
    adminHandlerDeps: { tokenStore, clock: Date.now, generateRandomBytes: () => new Uint8Array(32) },
    logger: noopLogger,
  };
};

describe("createRouter — Bot Framework /teams/messages mount (ADR-0060)", () => {
  it("dispatches to the bot handler WITHOUT a fugue team token (own JWT auth)", async () => {
    const calls: { authHeader: string | undefined; activity: unknown }[] = [];
    const deps: RouterDeps = {
      ...makeRouterDeps(createInMemoryTokenStore()),
      teamsBot: async (input) => { calls.push(input); return { status: 200, body: { ok: true } }; },
    };
    const app = createRouter(deps);

    // No Authorization header at all — the team-token middleware would 401, but
    // this route is mounted before it and delegates auth to the bot handler.
    const res = await app.request("/teams/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "conversationUpdate" }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.activity as { type: string }).type).toBe("conversationUpdate");
  });

  it("is absent (404) when no bot handler is wired", async () => {
    const app = createRouter(makeRouterDeps(createInMemoryTokenStore()));
    const res = await app.request("/teams/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ type: "conversationUpdate" }),
    });
    // Falls through to the custom-route catch-all → no DAG at this route → 404.
    expect(res.status).toBe(404);
  });
});

describe("createRouter — /admin/* defense-in-depth guard", () => {
  it("serves /health unauthenticated (registered before the auth middleware)", async () => {
    const app = createRouter(makeRouterDeps(createInMemoryTokenStore()));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("returns 403 at the router guard for a VALID team token hitting /admin/*", async () => {
    // A valid, resolvable team token — it authenticates fine, but the router-level
    // guard must still block it from /admin/* (independent of the handler's own check).
    const teamToken = "fug_team_alpha_rawtoken";
    const store = createInMemoryTokenStore();
    await store.store("team-alpha", await hashToken(teamToken), {
      team: "team-alpha",
      label: "Alpha",
      createdAt: 0,
    });
    const app = createRouter(makeRouterDeps(store));

    const res = await app.request("/admin/teams", {
      headers: { Authorization: `Bearer ${teamToken}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  });

  it("lets an admin token through the router guard", async () => {
    const app = createRouter(makeRouterDeps(createInMemoryTokenStore()));
    const res = await app.request("/admin/teams", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).not.toBe(403);
  });

  it("returns 401 for an unauthenticated /admin request (auth runs before the guard)", async () => {
    const app = createRouter(makeRouterDeps(createInMemoryTokenStore()));
    const res = await app.request("/admin/teams");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Custom route overrides (DagRegistration.route / fugue.yaml route)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { dagId } from "@fuguejs/framework";
import type { Registry, RegisteredDag } from "../../domain/registry.js";

const makeRoutedDag = (id: string, route: string): RegisteredDag => ({
  id: dagId(id),
  team: "test-team",
  route,
  dag: { id: dagId(id), nodes: [], edges: [] } as unknown as RegisteredDag["dag"],
  inputSchema: z.object({ query: z.string() }),
  config: { timeout: 5000, maxConcurrency: 10 },
  meta: { description: "test", version: "1.0" },
  loadedAt: Date.now(),
  sha: SHA,
  status: { kind: "healthy" },
  prompts: new Map(),
  modulePath: `/tmp/dags/test-team/${id}/dag.ts`,
});

const stateWith = (registry: Registry): HostState => ({
  phase: "ready",
  registry,
  lastSyncAt: Date.now(),
  lastSyncSha: SHA,
});

describe("createRouter — custom route overrides", () => {
  const routedDeps = (registry: Registry): RouterDeps => ({
    ...makeRouterDeps(createInMemoryTokenStore()),
    getHostState: () => stateWith(registry),
  });

  it("serves a DAG at its registration route override", async () => {
    const registry = freeze([makeRoutedDag("lead-scoring", "/score-leads")], SHA, Date.now());
    const app = createRouter(routedDeps(registry));
    const res = await app.request("/score-leads", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("still serves the same DAG at the default /dags/:id/run route", async () => {
    const registry = freeze([makeRoutedDag("lead-scoring", "/score-leads")], SHA, Date.now());
    const app = createRouter(routedDeps(registry));
    const res = await app.request("/dags/lead-scoring/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(res.status).toBe(200);
  });

  it("404s an unregistered path with a typed error (no handler fall-through)", async () => {
    const registry = freeze([makeRoutedDag("lead-scoring", "/score-leads")], SHA, Date.now());
    const app = createRouter(routedDeps(registry));
    const res = await app.request("/not-a-route", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-found");
  });

  it("custom routes resolve against the CURRENT registry (hot-reload safe)", async () => {
    let registry = freeze([makeRoutedDag("lead-scoring", "/score-leads")], SHA, Date.now());
    const deps: RouterDeps = {
      ...makeRouterDeps(createInMemoryTokenStore()),
      getHostState: () => stateWith(registry),
    };
    const app = createRouter(deps);
    const hit = () => app.request("/score-leads", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect((await hit()).status).toBe(200);
    // Simulate a sync that renames the route — the old path must 404 immediately.
    registry = freeze([makeRoutedDag("lead-scoring", "/score-leads-v2")], SHA, Date.now());
    expect((await hit()).status).toBe(404);
  });

  it("returns 503 for custom-route requests during boot (not 404)", async () => {
    const bootingState: HostState = { phase: "booting", startedAt: Date.now() };
    const deps: RouterDeps = {
      ...makeRouterDeps(createInMemoryTokenStore()),
      getHostState: () => bootingState,
    };
    const app = createRouter(deps);
    const res = await app.request("/score-leads", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    // During boot, custom routes should signal "retry later" (503), not "no such route" (404)
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("host-unavailable");
  });
});
