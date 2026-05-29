import { describe, it, expect } from "bun:test";
import { gitSha } from "@fugue/framework";
import type { NodeContext, DagId } from "@fugue/framework";
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
    createContext: () => ({ runId: "r" } as unknown as NodeContext),
    executeDag: (async () => ({ ok: true, value: {} })) as RunDagDeps["executeDag"],
    clock: Date.now,
    adminToken: ADMIN_TOKEN,
    tokenStore,
    adminHandlerDeps: { tokenStore, clock: Date.now, generateRandomBytes: () => new Uint8Array(32) },
    logger: noopLogger,
  };
};

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
