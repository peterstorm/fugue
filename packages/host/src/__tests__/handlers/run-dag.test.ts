import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
  dagId,
  gitSha,
  ok,
  err,
  runDag,
  runId,
  defineDagFromArray,
  createFetchNode,
  makeNodeContext,
  DAG_INPUT,
} from "@fuguejs/framework";
import type { NodeContext, FrameworkError, DagId, Capability, CapabilityBroker, InvocationOrigin } from "@fuguejs/framework";
import { z } from "zod";
import { createRunDagHandler } from "../../http/handlers/run-dag.js";
import { settleBeforeDeadline } from "../../adapters/settle-before-deadline.js";
import type { RunDagDeps } from "../../http/handlers/run-dag.js";
import type { RegisteredDag } from "../../domain/registry.js";
import type { HostState } from "../../domain/host-state.js";
import type { Registry } from "../../domain/registry.js";
import { freeze } from "../../domain/registry.js";
import { initConcurrency, acquire, withDagLimit } from "../../domain/concurrency.js";
import type { ConcurrencyState } from "../../domain/concurrency.js";
import { initCircuit } from "../../domain/circuit-breaker.js";
import type { CircuitState } from "../../domain/circuit-breaker.js";
import type { AuthIdentity } from "../../domain/auth.js";
import type { HitlRunService } from "../../hitl/service.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const sha = gitSha("a".repeat(40));

const makeDag = (id: string, team = "test-team"): RegisteredDag => ({
  id: dagId(id),
  team,
  route: `/dags/${id}/run`,
  dag: { id: dagId(id), nodes: [], edges: [] } as unknown as RegisteredDag["dag"],
  inputSchema: z.object({ query: z.string() }),
  config: { timeout: 5000, maxConcurrency: 10 },
  meta: { description: "test", version: "1.0" },
  loadedAt: Date.now(),
  sha,
  status: { kind: "healthy" },
  prompts: new Map(),
  modulePath: `/tmp/dags/test-team/${id}/dag.ts`,
});

const makeDisabledDag = (id: string): RegisteredDag => ({
  ...makeDag(id),
  status: { kind: "disabled", reason: "circuit open" },
});

const makeHitlDag = (id: string): RegisteredDag => ({
  ...makeDag(id),
  dag: {
    id: dagId(id),
    nodes: [{ humanReview: { prompt: "Approve?" } }],
    edges: [],
  } as unknown as RegisteredDag["dag"],
});

const makeReadyState = (registry: Registry): HostState => ({
  phase: "ready",
  registry,
  lastSyncAt: Date.now(),
  lastSyncSha: sha,
});

const makeBootingState = (): HostState => ({ phase: "booting", startedAt: Date.now() });

const successExecuteDag = (async () => ok({ result: "success" })) as RunDagDeps["executeDag"];
const failExecuteDag = (async () => err({ kind: "node-crash", message: "boom", nodeId: "n", retriability: "non-retriable" } as unknown as FrameworkError)) as RunDagDeps["executeDag"];

const defaultDeps = (overrides?: Partial<RunDagDeps>): RunDagDeps => {
  let concurrency = initConcurrency(50, 10);
  const circuits = new Map<DagId, CircuitState>();

  return {
    getConcurrency: () => concurrency,
    setConcurrency: (s) => { concurrency = s; },
    circuit: {
      get: (id) => circuits.get(id) ?? initCircuit(Date.now()),
      set: (id, s) => { circuits.set(id, s); },
    },
    circuitConfig: { threshold: 5, windowMs: 60_000 },
    createContext: ((_registered, requestedRunId) =>
      Promise.resolve({
        ctx: { runId: requestedRunId } as unknown as NodeContext,
        origin: { kind: "agent", agentClientId: "test-dag" },
      })) as unknown as RunDagDeps["createContext"],
    executeDag: successExecuteDag,
    clock: () => Date.now(),
    newRunId: () => runId("test-run-id"),
    ...overrides,
  };
};

const createTestApp = (
  deps: RunDagDeps,
  hostState: HostState,
  identity: AuthIdentity = { kind: "admin" },
) => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set("hostState", hostState);
    (c as unknown as { set: (k: string, v: unknown) => void }).set("authIdentity", identity);
    await next();
  });
  app.post("/dags/:id/run", createRunDagHandler(deps) as unknown as (c: unknown) => Promise<Response>);
  return app;
};

const post = (app: ReturnType<typeof createTestApp>, id: string, body: unknown) =>
  app.request(`/dags/${id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ── Tests ──────────────────────────────────────────────────────────────────

describe("run-dag handler", () => {
  const dag = makeDag("test-dag");
  const registry = freeze([dag], sha, Date.now());
  const readyState = makeReadyState(registry);

  it("returns 400 for invalid DagId format", async () => {
    const app = createTestApp(defaultDeps(), readyState);
    const res = await post(app, "invalid:id:with:colons", { query: "hi" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid-dag-id");
  });

  it("returns 503 when host is booting", async () => {
    const app = createTestApp(defaultDeps(), makeBootingState());
    const res = await post(app, "test-dag", { query: "hi" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("host-unavailable");
  });

  it("returns 404 when DAG not found", async () => {
    const app = createTestApp(defaultDeps(), readyState);
    const res = await post(app, "nonexistent-dag", { query: "hi" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("dag-not-found");
  });

  it("returns 503 when DAG is disabled", async () => {
    const disabledDag = makeDisabledDag("disabled-dag");
    const reg = freeze([disabledDag], sha, Date.now());
    const app = createTestApp(defaultDeps(), makeReadyState(reg));
    const res = await post(app, "disabled-dag", { query: "hi" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("dag-disabled");
  });

  it("returns 401 when authIdentity is missing", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set("hostState", readyState);
      await next();
    });
    app.post("/dags/:id/run", createRunDagHandler(defaultDeps()) as unknown as (c: unknown) => Promise<Response>);
    const res = await app.request("/dags/test-dag/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 before invoking either synchronous or HITL execution for another team", async () => {
    const identity: AuthIdentity = { kind: "team", team: "other-team", label: "other" };

    for (const candidate of [makeDag("sync-denied"), makeHitlDag("hitl-denied")]) {
      let executeCalls = 0;
      let startRunCalls = 0;
      let concurrencyWrites = 0;
      const hitl = {
        async startRun() {
          startRunCalls++;
          return ok({ runId: "should-not-run" as never });
        },
      } as HitlRunService;
      const deps = defaultDeps({
        hitl,
        executeDag: (async () => {
          executeCalls++;
          return ok({ unreachable: true });
        }) as RunDagDeps["executeDag"],
        setConcurrency: () => { concurrencyWrites++; },
      });
      const deniedState = makeReadyState(freeze([candidate], sha, Date.now()));
      const res = await post(createTestApp(deps, deniedState, identity), candidate.id, { query: "hi" });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden");
      expect(executeCalls).toBe(0);
      expect(startRunCalls).toBe(0);
      expect(concurrencyWrites).toBe(0);
    }
  });

  it("maps HITL start failures through httpStatusFor without synchronous fallback", async () => {
    const hitlDag = makeHitlDag("hitl-start-failure");
    const hitlState = makeReadyState(freeze([hitlDag], sha, Date.now()));
    let executeCalls = 0;
    const hitl = {
      async startRun() {
        return err({ kind: "redis-unavailable" as const, operation: "create-hitl-run" });
      },
    } as HitlRunService;
    const deps = defaultDeps({
      hitl,
      executeDag: (async () => {
        executeCalls += 1;
        return ok({ unreachable: true });
      }) as RunDagDeps["executeDag"],
    });

    const res = await post(
      createTestApp(deps, hitlState),
      "hitl-start-failure",
      { query: "hi" },
    );
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toBe("redis-unavailable");
    expect(body.ok).toBe(false);
    expect(executeCalls).toBe(0);
  });

  describe("identity threading into the run (FR-W3-007)", () => {
    // The user `sub`/`azp` must reach `createContext` so T8 can build
    // `Invocation.origin`. We capture the identity arg to prove the seam works,
    // and confirm admin/team runs pass their identity through unchanged.
    const runWith = async (identity: AuthIdentity) => {
      const captured: AuthIdentity[] = [];
      const deps = defaultDeps({
        createContext: (async (_reg, _runId, _sig, id: AuthIdentity) => {
          captured.push(id);
          return {
            ctx: { runId: "test-run-id" } as unknown as NodeContext,
            origin: { kind: "agent", agentClientId: "test-dag" },
          };
        }) as unknown as RunDagDeps["createContext"],
      });
      const app = createTestApp(deps, readyState, identity);
      const res = await post(app, "test-dag", { query: "hi" });
      return { res, captured };
    };

    it("threads the user sub/azp into createContext for a user-initiated run", async () => {
      const identity: AuthIdentity = { kind: "user", sub: "user-abc", azp: "fugue-frontend", canRunDag: () => true };
      const { res, captured } = await runWith(identity);
      expect(res.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual(identity);
    });

    it("threads the admin identity through unchanged (no user sub)", async () => {
      const identity: AuthIdentity = { kind: "admin" };
      const { res, captured } = await runWith(identity);
      expect(res.status).toBe(200);
      expect(captured[0]).toEqual({ kind: "admin" });
    });

    it("threads the team identity through unchanged", async () => {
      const identity: AuthIdentity = { kind: "team", team: "test-team", label: "Test" };
      const { res, captured } = await runWith(identity);
      expect(res.status).toBe(200);
      expect(captured[0]).toEqual(identity);
    });
  });

  // ── SC-005: authorization runs BEFORE concurrency acquisition ─────────────
  // A user whose run-authorization policy denies the DAG's team must be refused
  // (403) and must NOT have a concurrency slot acquired — the auth gate
  // short-circuits before `acquire`. We prove the ORDERING by exhausting global
  // concurrency (so the acquire branch would 429 if it were reached) and
  // asserting the response is 403, not 429: the only way to get 403 is for
  // `canAccessDag` to run first. We also assert `setConcurrency` was never
  // called (no slot mutation happened).
  describe("SC-005 — user denial precedes concurrency acquisition", () => {
    it("returns 403 (not 429) for a denied user even when concurrency is exhausted, and never touches the slot counter", async () => {
      const denied: AuthIdentity = {
        kind: "user",
        sub: "outsider",
        azp: "fugue-frontend",
        // Not a member of the DAG's team ("test-team") → denied.
        canRunDag: (dagTeam) => ["some-other-team"].includes(dagTeam),
      };
      let setCalls = 0;
      const deps = defaultDeps({
        // Zero global slots: if acquire were reached, this would be a 429.
        getConcurrency: () => initConcurrency(0, 10),
        setConcurrency: () => { setCalls += 1; },
      });
      const app = createTestApp(deps, readyState, denied);
      const res = await post(app, "test-dag", { query: "hi" });

      // 403 proves the auth gate ran FIRST — a 429 would mean acquire ran before it.
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("forbidden");
      // No slot was acquired or released — the counter was never mutated.
      expect(setCalls).toBe(0);
    });

    it("returns 200 for a member user (positive control — the gate admits members)", async () => {
      const member: AuthIdentity = {
        kind: "user",
        sub: "insider",
        azp: "fugue-frontend",
        canRunDag: (dagTeam) => ["test-team"].includes(dagTeam),
      };
      const app = createTestApp(defaultDeps(), readyState, member);
      const res = await post(app, "test-dag", { query: "hi" });
      expect(res.status).toBe(200);
    });
  });

  it("returns 400 for non-JSON body", async () => {
    const app = createTestApp(defaultDeps(), readyState);
    const res = await app.request("/dags/test-dag/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {{{",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("body-parse-failed");
  });

  it("returns 400 when request JSON parsing throws a hostile non-Error", async () => {
    const hostile = { toString: () => { throw new Error("coercion must not run"); } };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("hostState" as never, readyState as never);
      c.set("authIdentity" as never, { kind: "admin" } as never);
      Object.defineProperty(c.req, "json", {
        value: async () => { throw hostile; },
      });
      await next();
    });
    app.post(
      "/dags/:id/run",
      createRunDagHandler(defaultDeps()) as unknown as (c: unknown) => Promise<Response>,
    );

    const response = await app.request("/dags/test-dag/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "hi" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("body-parse-failed");
    expect(typeof body.details.message).toBe("string");
  });

  it("returns 400 for input validation failure", async () => {
    const app = createTestApp(defaultDeps(), readyState);
    const res = await post(app, "test-dag", { wrong: "field" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("input-validation-failed");
  });

  it("returns 429 when global concurrency exceeded", async () => {
    const deps = defaultDeps({
      getConcurrency: () => initConcurrency(0, 10),
    });
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("global-concurrency-exceeded");
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  it("returns 429 with scope=dag when the per-DAG limit is exhausted (global has headroom)", async () => {
    // Per-DAG limit of 1, already occupied — global (50) still has plenty of room, so the
    // rejection MUST be the per-DAG branch (scope=dag), not the global one tested above.
    let concurrency = withDagLimit(initConcurrency(50, 10), dagId("test-dag"), 1);
    const acq = acquire(concurrency, dagId("test-dag"), Date.now());
    expect(acq.ok).toBe(true);
    if (acq.ok) concurrency = acq.value.state;

    const deps = defaultDeps({
      getConcurrency: () => concurrency,
      setConcurrency: (s) => { concurrency = s; },
    });
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("dag-concurrency-exceeded");
    expect(body.details.scope).toBe("dag");
    expect(res.headers.get("Retry-After")).toBe("5");
    // Global headroom was never touched on the per-DAG rejection.
    expect(concurrency.global.current).toBe(1);
  });

  it("returns 500 and releases the concurrency token when createContext throws", async () => {
    // Exercises the setup-guard branch: createContext throwing must mark the
    // circuit, rethrow → 500, and still release the slot in the outer finally.
    let concurrency = initConcurrency(50, 10);
    const deps = defaultDeps({
      getConcurrency: () => concurrency,
      setConcurrency: (s) => { concurrency = s; },
      createContext: () => { throw new Error("context init blew up"); },
    });
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });

    expect(res.status).toBe(500);
    // The slot acquired before execution must be released — no leak on the setup-throw path.
    expect(concurrency.global.current).toBe(0);
  });

  it("records a circuit failure on the createContext-throws path (opens per-DAG breaker at threshold)", async () => {
    // failureThreshold 1 → breaker opens after the 2nd failure. If the setup-throw branch did
    // NOT call markFailure, the breaker would never open and request 3 would 500 like the rest.
    const base = makeDag("ctx-throw-dag");
    const cbDag: RegisteredDag = { ...base, config: { ...base.config, circuitBreaker: { failureThreshold: 1 } } };
    const reg = freeze([cbDag], sha, Date.now());
    const deps = defaultDeps({ createContext: () => { throw new Error("ctx init failed"); } });
    const app = createTestApp(deps, makeReadyState(reg));

    expect((await post(app, "ctx-throw-dag", { query: "x" })).status).toBe(500); // failure 1
    expect((await post(app, "ctx-throw-dag", { query: "x" })).status).toBe(500); // failure 2 → opens
    const r3 = await post(app, "ctx-throw-dag", { query: "x" });
    expect(r3.status).toBe(503);                                                  // circuit now open
    expect((await r3.json()).error).toBe("dag-disabled");
  });

  it("returns 500 and releases the concurrency token when createContext rejects (async)", async () => {
    // Async sibling of the sync-throw setup-guard test above. The async migration introduced
    // a new failure mode: `await deps.createContext(...)` resolving to a REJECTED promise (how a
    // failing broker surfaces in Wave 4). The setup-guard catch must handle it identically to a
    // sync throw — mark the circuit, return 500, and release the slot.
    let concurrency = initConcurrency(50, 10);
    const deps = defaultDeps({
      getConcurrency: () => concurrency,
      setConcurrency: (s) => { concurrency = s; },
      createContext: () => Promise.reject(new Error("async context init failed")),
    });
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });

    expect(res.status).toBe(500);
    // The slot acquired before execution must be released — no leak on the async-reject path.
    expect(concurrency.global.current).toBe(0);
  });

  it("records a circuit failure on the createContext-rejects (async) path (opens per-DAG breaker at threshold)", async () => {
    // Async sibling of the sync-throw circuit-failure test. A rejected createContext promise must
    // call markFailure exactly like a sync throw, so the breaker opens at the threshold.
    const base = makeDag("ctx-reject-dag");
    const cbDag: RegisteredDag = { ...base, config: { ...base.config, circuitBreaker: { failureThreshold: 1 } } };
    const reg = freeze([cbDag], sha, Date.now());
    const deps = defaultDeps({ createContext: () => Promise.reject(new Error("async ctx init failed")) });
    const app = createTestApp(deps, makeReadyState(reg));

    expect((await post(app, "ctx-reject-dag", { query: "x" })).status).toBe(500); // failure 1
    expect((await post(app, "ctx-reject-dag", { query: "x" })).status).toBe(500); // failure 2 → opens
    const r3 = await post(app, "ctx-reject-dag", { query: "x" });
    expect(r3.status).toBe(503);                                                  // circuit now open
    expect((await r3.json()).error).toBe("dag-disabled");
  });

  it("does not consume the half-open circuit probe when concurrency rejects (no wedge)", async () => {
    // Circuit is half-open with a single probe available; global capacity is exhausted.
    const circuits = new Map<DagId, CircuitState>();
    circuits.set(dagId("test-dag"), { state: "half-open", testRequestAllowed: true });
    let concurrency = initConcurrency(0, 10); // global max 0 → always at capacity
    const deps: RunDagDeps = {
      ...defaultDeps(),
      getConcurrency: () => concurrency,
      setConcurrency: (s) => { concurrency = s; },
      circuit: {
        get: (id) => circuits.get(id) ?? initCircuit(Date.now()),
        set: (id, s) => { circuits.set(id, s); },
      },
    };
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });

    // Rejected for capacity, not the circuit.
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("global-concurrency-exceeded");

    // The probe must be intact — breaker still half-open and willing to test.
    // Before the fix, the probe was consumed here, wedging the breaker forever.
    expect(circuits.get(dagId("test-dag"))).toEqual({ state: "half-open", testRequestAllowed: true });

    // And the concurrency counters are untouched on the 429 path.
    expect(concurrency.global.current).toBe(0);
  });

  it("releases the concurrency token when the circuit denies the request", async () => {
    const circuits = new Map<DagId, CircuitState>();
    circuits.set(dagId("test-dag"), { state: "open", openedAt: Date.now(), reason: { kind: "half-open-test-failed" } });
    let concurrency = initConcurrency(50, 10);
    const deps: RunDagDeps = {
      ...defaultDeps(),
      getConcurrency: () => concurrency,
      setConcurrency: (s) => { concurrency = s; },
      circuit: {
        get: (id) => circuits.get(id) ?? initCircuit(Date.now()),
        set: (id, s) => { circuits.set(id, s); },
      },
    };
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("dag-disabled");
    // The slot acquired before the circuit check must be released — no leak.
    expect(concurrency.global.current).toBe(0);
  });

  it("returns 500 when DAG execution returns error", async () => {
    const deps = defaultDeps({ executeDag: failExecuteDag });
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });
    expect(res.status).toBe(500);
  });

  // ── Framework-error → HTTP status mapping (review I4) ──────────────────────
  const failWith = (error: FrameworkError) =>
    (async () => err(error)) as RunDagDeps["executeDag"];

  it("maps a policy-refusal to 403 (not 500) and does NOT open the circuit", async () => {
    const circuits = new Map<DagId, CircuitState>();
    const deps = defaultDeps({
      executeDag: failWith({ kind: "policy-refusal", scope: "msgraph:mail.send", agentClientId: "agent-x" }),
      circuit: { get: (id) => circuits.get(id) ?? initCircuit(Date.now()), set: (id, s) => { circuits.set(id, s); } },
      circuitConfig: { threshold: 1, windowMs: 60_000 },
    });
    const app = createTestApp(deps, readyState);
    // Fire several refusals — a settled "no" must never accumulate toward opening
    // the breaker (which would deny the DAG to EVERY caller).
    for (let i = 0; i < 5; i++) {
      const res = await post(app, "test-dag", { query: "hi" });
      expect(res.status).toBe(403);
    }
    const sixth = await post(app, "test-dag", { query: "hi" });
    expect(sixth.status).toBe(403); // still 403 — circuit never opened (would be 503)
  });

  it("maps a downstream-denied to 403", async () => {
    const deps = defaultDeps({
      executeDag: failWith({ kind: "downstream-denied", resource: "https://graph.microsoft.com", reason: "FIC mismatch" }),
    });
    const res = await post(createTestApp(deps, readyState), "test-dag", { query: "hi" });
    expect(res.status).toBe(403);
  });

  it("maps an llm-budget-exceeded to 429 with Retry-After", async () => {
    const deps = defaultDeps({
      executeDag: failWith({ kind: "llm-budget-exceeded", runId: "r" as never, nodeId: "n" as never, cause: { kind: "reached", ceiling: { kind: "tokens", limit: 5 }, basis: "settled", observed: 10 } }),
    });
    const res = await post(createTestApp(deps, readyState), "test-dag", { query: "hi" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("maps an infra-unreachable to 503", async () => {
    const deps = defaultDeps({
      executeDag: failWith({ kind: "infra-unreachable", operation: "federation", hop: "entra-wif", message: "down" }),
    });
    const res = await post(createTestApp(deps, readyState), "test-dag", { query: "hi" });
    expect(res.status).toBe(503);
  });

  it("maps a broker refusal through the REAL runDag to 403 and never opens the circuit (I4 end-to-end)", async () => {
    // The handler-level I4 tests above inject bare error kinds via an executeDag
    // fake. This test closes the seam they bypass: a refusing broker driven
    // through the real framework executor (retry machinery included) must still
    // surface 403 + breaker exemption. Before the retry-policy fast-fail fix,
    // the refusal was retried and rewrapped as `retry-exhausted` → 500 + breaker
    // trip, with this exact composition green-tested nowhere.
    const SCOPE = "svc:opA" as Capability;
    const mintCalls: string[] = [];
    const refusingBroker: CapabilityBroker = {
      mintFor: async (inv, requires) => {
        mintCalls.push(inv.nodeId as string);
        return err({ kind: "policy-refusal", scope: requires[0] as string, agentClientId: inv.origin.agentClientId });
      },
      provides: (c) => (c as string).includes(":"),
    };

    const gated = createFetchNode({
      id: "gated" as never,
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      requires: [SCOPE] as unknown as readonly Capability[],
      fetch: async () => ok({ ok: true }), // never reached
    });
    const realDag = defineDagFromArray({
      id: "minting-dag",
      nodes: [gated],
      edges: [{ from: DAG_INPUT, to: "gated" }],
      // Retry budget present — proves the settled refusal is NOT retried even
      // when retries are available (one mintFor call per request, below).
      defaultRetryLimit: 2,
    });

    const registered: RegisteredDag = {
      ...makeDag("minting-dag"),
      dag: realDag as unknown as RegisteredDag["dag"],
    };
    const reg = freeze([registered], sha, Date.now());

    const deps = defaultDeps({
      createContext: (async () => ({
        ctx: makeNodeContext({ runId: "run-mint", dagId: "minting-dag" }),
        origin: { kind: "agent", agentClientId: "minting-dag" },
      })) as unknown as RunDagDeps["createContext"],
      // Mirror host.ts executeDag exactly: real runDag with the boot-selected
      // broker + per-run origin as one MintingAuthority.
      executeDag: (async <I, O>(d: unknown, input: I, ctx: NodeContext, origin: InvocationOrigin) =>
        runDag<I, O>(d as never, input, ctx, {
          minting: {
            broker: refusingBroker,
            origin,
            meterLlm: (_capability, _binding, nodeId) => err({
              kind: "validation",
              nodeId,
              message: "refusing broker unexpectedly delivered an LLM binding",
            }),
          },
          suppressRoutingWarnings: true,
        })) as unknown as RunDagDeps["executeDag"],
      circuitConfig: { threshold: 1, windowMs: 60_000 },
    });
    const app = createTestApp(deps, makeReadyState(reg));

    // Repeated refusals: every one must be a 403 (a settled "no", not a host
    // fault) and must never accumulate toward opening the breaker (would be 503).
    for (let i = 0; i < 4; i++) {
      const res = await post(app, "minting-dag", { query: "hi" });
      expect(res.status).toBe(403);
    }
    // One mintFor call per request — the settled refusal consumed no retries.
    expect(mintCalls).toHaveLength(4);
  });

  it("hard-bounds a context-construction hang and releases concurrency", async () => {
    const base = makeDag("setup-wedged-dag");
    const timedDag: RegisteredDag = { ...base, config: { ...base.config, timeout: 5 } };
    const reg = freeze([timedDag], sha, Date.now());
    let concurrency = initConcurrency(50, 10);
    const deps = defaultDeps({
      getConcurrency: () => concurrency,
      setConcurrency: (next) => { concurrency = next; },
      createContext: (() => new Promise(() => {})) as RunDagDeps["createContext"],
    });

    const response = await Promise.race([
      post(createTestApp(deps, makeReadyState(reg)), "setup-wedged-dag", { query: "hi" }),
      Bun.sleep(250).then(() => { throw new Error("context setup remained wedged"); }),
    ]);

    expect(response.status).toBe(408);
    expect((await response.json()).runId).toBe("test-run-id");
    expect(concurrency.global.current).toBe(0);
  });

  it("warns when successful effects complete after the terminal 408", async () => {
    const base = makeDag("late-success-dag");
    const timedDag: RegisteredDag = { ...base, config: { ...base.config, timeout: 1 } };
    const reg = freeze([timedDag], sha, Date.now());
    let resolveExecution!: (value: ReturnType<typeof ok<{ done: boolean }>>) => void;
    const pending = new Promise<ReturnType<typeof ok<{ done: boolean }>>>((resolve) => {
      resolveExecution = resolve;
    });
    const diagnostics: Array<{
      readonly level: string;
      readonly message: string;
      readonly data?: Record<string, unknown>;
    }> = [];
    const deps = defaultDeps({
      executeDag: (() => pending) as RunDagDeps["executeDag"],
      logger: {
        info(message, data) { diagnostics.push({ level: "info", message, data }); },
        warn(message, data) { diagnostics.push({ level: "warn", message, data }); },
        error(message, data) { diagnostics.push({ level: "error", message, data }); },
      },
    });

    const response = await post(
      createTestApp(deps, makeReadyState(reg)),
      "late-success-dag",
      { query: "hi" },
    );
    expect(response.status).toBe(408);
    resolveExecution(ok({ done: true }));
    await Bun.sleep(5);

    expect(diagnostics).toContainEqual({
      level: "warn",
      message: "host: DAG execution completed after request deadline",
      data: {
        dagId: "late-success-dag",
        runId: "test-run-id",
        consequence: "effects completed after HTTP 408; client retry may duplicate work",
      },
    });
  });

  it("returns 408 when execution exceeds the host timeout (cooperative abort surfaces)", async () => {
    // Tiny per-DAG timeout; execution outlives it and then surfaces the abort the way
    // the framework would (a thrown AbortError once ctx.signal fires). Confirms the
    // 408 branch is actually reachable end-to-end, not just defensively written.
    const base = makeDag("slow-dag");
    const slowDag: RegisteredDag = { ...base, config: { ...base.config, timeout: 1 } };
    const reg = freeze([slowDag], sha, Date.now());
    const timeoutExecute = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as RunDagDeps["executeDag"];
    const diagnostics: Array<{ readonly message: string; readonly data?: Record<string, unknown> }> = [];
    const app = createTestApp(defaultDeps({
      executeDag: timeoutExecute,
      logger: {
        info() {},
        warn() {},
        error(message, data) { diagnostics.push({ message, data }); },
      },
    }), makeReadyState(reg));
    const res = await post(app, "slow-dag", { query: "hi" });
    expect(res.status).toBe(408);
    expect((await res.json()).error).toBe("timeout");

    await Bun.sleep(60);
    expect(diagnostics).toContainEqual({
      message: "host: DAG pipeline rejected after request deadline",
      data: { dagId: "slow-dag", runId: "test-run-id", error: "aborted" },
    });
  });

  it("maps the framework's typed aborted Result to 408 when the host deadline fires", async () => {
    const base = makeDag("typed-timeout-dag");
    const timedDag: RegisteredDag = { ...base, config: { ...base.config, timeout: 5 } };
    const reg = freeze([timedDag], sha, Date.now());
    const executeDag = (async (_dag: unknown, _input: unknown, ctx: NodeContext) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) return resolve();
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return err({ kind: "aborted", reason: "signal" });
    }) as RunDagDeps["executeDag"];

    const response = await post(
      createTestApp(defaultDeps({ executeDag }), makeReadyState(reg)),
      "typed-timeout-dag",
      { query: "hi" },
    );

    expect(response.status).toBe(408);
    expect((await response.json()).error).toBe("timeout");
  });

  it("hard-bounds abort-insensitive execution and releases its concurrency token", async () => {
    const base = makeDag("wedged-dag");
    const timedDag: RegisteredDag = { ...base, config: { ...base.config, timeout: 5 } };
    const reg = freeze([timedDag], sha, Date.now());
    let concurrency = initConcurrency(50, 10);
    const deps = defaultDeps({
      getConcurrency: () => concurrency,
      setConcurrency: (next) => { concurrency = next; },
      executeDag: (() => new Promise(() => {})) as RunDagDeps["executeDag"],
    });

    const response = await Promise.race([
      post(createTestApp(deps, makeReadyState(reg)), "wedged-dag", { query: "hi" }),
      Bun.sleep(250).then(() => { throw new Error("host request remained wedged"); }),
    ]);

    expect(response.status).toBe(408);
    expect(concurrency.global.current).toBe(0);
  });

  it("honors a per-DAG circuitBreaker.failureThreshold (opens sooner than the host default)", async () => {
    // threshold 1 → recordFailure opens once count > 1, i.e. after the 2nd failure.
    const base = makeDag("cb-dag");
    const cbDag: RegisteredDag = { ...base, config: { ...base.config, circuitBreaker: { failureThreshold: 1 } } };
    const reg = freeze([cbDag], sha, Date.now());
    const deps = defaultDeps({ executeDag: failExecuteDag }); // host circuitConfig threshold = 5
    const app = createTestApp(deps, makeReadyState(reg));

    expect((await post(app, "cb-dag", { query: "x" })).status).toBe(500); // failure 1
    expect((await post(app, "cb-dag", { query: "x" })).status).toBe(500); // failure 2 → opens
    const r3 = await post(app, "cb-dag", { query: "x" });
    expect(r3.status).toBe(503);                                          // circuit now open
    expect((await r3.json()).error).toBe("dag-disabled");
  });

  it("uses the host default threshold when the DAG declares no circuitBreaker (no early open)", async () => {
    const reg = freeze([makeDag("plain-dag")], sha, Date.now());
    const deps = defaultDeps({ executeDag: failExecuteDag }); // threshold 5
    const app = createTestApp(deps, makeReadyState(reg));
    // 3 failures < threshold 5 → still 500 each, breaker stays closed.
    for (let i = 0; i < 3; i++) {
      expect((await post(app, "plain-dag", { query: "x" })).status).toBe(500);
    }
  });

  it("returns 200 on successful execution", async () => {
    const okDag = (async () => ok({ answer: "42" })) as RunDagDeps["executeDag"];
    const deps = defaultDeps({ executeDag: okDag });
    const app = createTestApp(deps, readyState);
    const res = await post(app, "test-dag", { query: "hi" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.answer).toBe("42");
  });

  it("releases concurrency token even on failure", async () => {
    let finalConcurrency: ConcurrencyState | undefined;
    const deps = defaultDeps({
      executeDag: failExecuteDag,
      setConcurrency: (s) => { finalConcurrency = s; },
    });
    const app = createTestApp(deps, readyState);
    await post(app, "test-dag", { query: "hi" });
    expect(finalConcurrency!.global.current).toBe(0);
  });

  it("admin identity can access any team's DAG", async () => {
    const identity: AuthIdentity = { kind: "admin" };
    const okDag = (async () => ok({ r: 1 })) as RunDagDeps["executeDag"];
    const app = createTestApp(defaultDeps({ executeDag: okDag }), readyState, identity);
    const res = await post(app, "test-dag", { query: "hi" });
    expect(res.status).toBe(200);
  });

  it("team identity can access own team's DAG", async () => {
    const identity: AuthIdentity = { kind: "team", team: "test-team", label: "t" };
    const okDag = (async () => ok({ r: 1 })) as RunDagDeps["executeDag"];
    const app = createTestApp(defaultDeps({ executeDag: okDag }), readyState, identity);
    const res = await post(app, "test-dag", { query: "hi" });
    expect(res.status).toBe(200);
  });
});

describe("settleBeforeDeadline diagnostics", () => {
  it("reports timeout-cancellation failure without replacing hard settlement", async () => {
    const failures: unknown[] = [];
    const result = await settleBeforeDeadline(
      new Promise<never>(() => {}),
      1,
      () => { throw new Error("abort transport failed"); },
      { onTimeoutCancellationFailure: (error) => failures.push(error) },
    );

    expect(result).toEqual({ kind: "timed-out" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
  });

  it("contains a throwing late-rejection diagnostic", async () => {
    const operation = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late failure")), 10);
    });
    const result = await settleBeforeDeadline(
      operation,
      1,
      () => {},
      { onLateRejection: () => { throw new Error("logger failed"); } },
    );

    expect(result).toEqual({ kind: "timed-out" });
    await expect(Bun.sleep(20)).resolves.toBeUndefined();
  });
});
