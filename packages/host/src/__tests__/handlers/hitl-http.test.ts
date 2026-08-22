// hitl-http.test.ts — HTTP surface for durable HITL runs (ADR-0060):
// the run-dag async fork (202 vs inline 200 vs 501) and the /runs status +
// approval endpoints. Uses a fake HitlRunService + a minimal Hono app.

import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import { dagId, gitSha, ok, runId as mkRunId } from "@fuguejs/framework";
import type { DagId, NodeId, RunId, NodeContext } from "@fuguejs/framework";
import { z } from "zod";
import { createRunDagHandler } from "../../http/handlers/run-dag.js";
import type { RunDagDeps } from "../../http/handlers/run-dag.js";
import { createGetRunHandler, createApproveRunHandler } from "../../http/handlers/runs.js";
import type { RegisteredDag, Registry } from "../../domain/registry.js";
import { freeze } from "../../domain/registry.js";
import type { HostState } from "../../domain/host-state.js";
import type { AuthIdentity } from "../../domain/auth.js";
import type { HitlRunService } from "../../hitl/service.js";
import type { RunRecord } from "../../hitl/types.js";
import { initConcurrency } from "../../domain/concurrency.js";
import { initCircuit } from "../../domain/circuit-breaker.js";

const sha = gitSha("a".repeat(40));

const makeRegisteredDag = (id: string, hitl: boolean, team = "test-team"): RegisteredDag => ({
  id: dagId(id),
  team,
  route: `/dags/${id}/run`,
  dag: {
    id: dagId(id),
    nodes: hitl ? [{ id: "review", humanReview: { prompt: "ok?" } }] : [{ id: "n1" }],
    edges: [],
  } as unknown as RegisteredDag["dag"],
  inputSchema: z.unknown(),
  config: { timeout: 5000, maxConcurrency: 10 },
  meta: { description: "test", version: "1.0" },
  loadedAt: Date.now(),
  sha,
  status: { kind: "healthy" },
  prompts: new Map(),
  modulePath: `/tmp/dags/${team}/${id}/dag.ts`,
});

const readyState = (dags: RegisteredDag[]): HostState => {
  const registry: Registry = freeze(dags, sha, Date.now());
  return { phase: "ready", registry, lastSyncAt: Date.now(), lastSyncSha: sha };
};

const baseRunDagDeps = (overrides?: Partial<RunDagDeps>): RunDagDeps => {
  let concurrency = initConcurrency(50, 10);
  return {
    getConcurrency: () => concurrency,
    setConcurrency: (s) => { concurrency = s; },
    circuit: { get: () => initCircuit(Date.now()), set: () => {} },
    circuitConfig: { threshold: 5, windowMs: 60_000 },
    createContext: (() => Promise.resolve({ ctx: { runId: "r" } as unknown as NodeContext, origin: { kind: "agent", agentClientId: "d" } })) as unknown as RunDagDeps["createContext"],
    executeDag: (async () => ok({ result: "inline" })) as RunDagDeps["executeDag"],
    clock: () => Date.now(),
    ...overrides,
  };
};

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  runId: mkRunId("run-1"),
  dagId: dagId("hitl-dag"),
  input: {},
  identity: { kind: "admin" },
  status: { kind: "suspended", nodeId: "review" as NodeId, prompt: "ok?" },
  checkpoint: "{}",
  createdAtMs: 1,
  updatedAtMs: 1,
  ...overrides,
});

const fakeHitl = (overrides: Partial<HitlRunService> = {}): HitlRunService => ({
  startRun: mock(async () => ok({ runId: mkRunId("run-1") })),
  processRun: async () => ok(undefined),
  recordDecision: mock(async () => ok(undefined)),
  reconcileActiveRuns: async () => ok([]),
  getRun: async () => ok(record()),
  ...overrides,
});

const app = (deps: RunDagDeps, state: HostState, identity: AuthIdentity = { kind: "admin" }) => {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set("hostState", state);
    (c as unknown as { set: (k: string, v: unknown) => void }).set("authIdentity", identity);
    await next();
  });
  a.post("/dags/:id/run", createRunDagHandler(deps) as unknown as (c: never) => Promise<Response>);
  a.get("/runs/:runId", createGetRunHandler(deps) as unknown as (c: never) => Promise<Response>);
  a.post("/runs/:runId/approve", createApproveRunHandler(deps) as unknown as (c: never) => Promise<Response>);
  return a;
};

const postJson = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ── run-dag async fork ───────────────────────────────────────────────────────

describe("POST /dags/:id/run — HITL fork (ADR-0060)", () => {
  it("a HITL DAG with the engine wired enqueues and returns 202 + runId", async () => {
    const hitl = fakeHitl();
    const state = readyState([makeRegisteredDag("hitl-dag", true)]);
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/dags/hitl-dag/run", {});
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.status).toBe("queued");
    expect(body.data.runId).toBe("run-1");
    expect(hitl.startRun).toHaveBeenCalledTimes(1);
  });

  it("a HITL DAG with no engine wired is refused 501", async () => {
    const state = readyState([makeRegisteredDag("hitl-dag", true)]);
    const res = await postJson(app(baseRunDagDeps(), state), "/dags/hitl-dag/run", {});
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("hitl-not-configured");
  });

  it("a non-HITL DAG still runs inline (200), even with the engine wired", async () => {
    const hitl = fakeHitl();
    const state = readyState([makeRegisteredDag("plain", false)]);
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/dags/plain/run", {});
    expect(res.status).toBe(200);
    expect(hitl.startRun).toHaveBeenCalledTimes(0);
  });
});

// ── GET /runs/:runId ─────────────────────────────────────────────────────────

describe("GET /runs/:runId", () => {
  const state = readyState([makeRegisteredDag("hitl-dag", true)]);

  it("returns the suspended status view with the review gate", async () => {
    const res = await app(baseRunDagDeps({ hitl: fakeHitl() }), state).request("/runs/run-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("suspended");
    expect(body.data.review).toEqual({ nodeId: "review", prompt: "ok?" });
  });

  it("404 for an unknown run", async () => {
    const hitl = fakeHitl({ getRun: async () => ok(null) });
    const res = await app(baseRunDagDeps({ hitl }), state).request("/runs/ghost");
    expect(res.status).toBe(404);
  });

  it("403 when the caller cannot access the run's DAG team", async () => {
    const hitl = fakeHitl();
    const teamState = readyState([makeRegisteredDag("hitl-dag", true, "other-team")]);
    const res = await app(baseRunDagDeps({ hitl }), teamState, { kind: "team", team: "mine", label: "Mine" }).request("/runs/run-1");
    expect(res.status).toBe(403);
  });
});

// ── POST /runs/:runId/approve ────────────────────────────────────────────────

describe("POST /runs/:runId/approve", () => {
  const state = readyState([makeRegisteredDag("hitl-dag", true)]);

  it("records an approve decision for the current gate (202-style 200)", async () => {
    const hitl = fakeHitl();
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/runs/run-1/approve", { decision: "approve" });
    expect(res.status).toBe(200);
    expect(hitl.recordDecision).toHaveBeenCalledTimes(1);
    const call = (hitl.recordDecision as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[1]).toBe("review" as NodeId);
    expect(call[2]).toEqual({ kind: "approve" });
  });

  it("maps reject body to a reject HumanAction", async () => {
    const hitl = fakeHitl();
    await postJson(app(baseRunDagDeps({ hitl }), state), "/runs/run-1/approve", { decision: "reject", reason: "no" });
    const call = (hitl.recordDecision as ReturnType<typeof mock>).mock.calls[0]!;
    expect(call[2]).toEqual({ kind: "reject", reason: "no" });
  });

  it("409 when the run is not awaiting review", async () => {
    const hitl = fakeHitl({ getRun: async () => ok(record({ status: { kind: "running" } })) });
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/runs/run-1/approve", { decision: "approve" });
    expect(res.status).toBe(409);
  });

  it("400 on an invalid decision", async () => {
    const hitl = fakeHitl();
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/runs/run-1/approve", { decision: "maybe" });
    expect(res.status).toBe(400);
    expect(hitl.recordDecision).toHaveBeenCalledTimes(0);
  });

  it("400 when reject is missing a reason", async () => {
    const hitl = fakeHitl();
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/runs/run-1/approve", { decision: "reject" });
    expect(res.status).toBe(400);
  });

  it("400 when reroute carries a malformed targetNodeId (parsed, not cast)", async () => {
    const hitl = fakeHitl();
    // "../evil" has '/' and '.', neither permitted by the id grammar.
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/runs/run-1/approve", { decision: "reroute", targetNodeId: "../evil" });
    expect(res.status).toBe(400);
    expect(hitl.recordDecision).toHaveBeenCalledTimes(0);
  });

  it("404 on a malformed runId in the path without touching the store", async () => {
    const getRun = mock(async () => ok(record()));
    const hitl = fakeHitl({ getRun });
    // "bad.id" routes (period is path-safe) but is not a valid runId.
    const res = await postJson(app(baseRunDagDeps({ hitl }), state), "/runs/bad.id/approve", { decision: "approve" });
    expect(res.status).toBe(404);
    expect(getRun).toHaveBeenCalledTimes(0);
    expect(hitl.recordDecision).toHaveBeenCalledTimes(0);
  });
});
