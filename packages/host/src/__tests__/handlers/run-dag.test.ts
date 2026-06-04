import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { dagId, gitSha, ok, err } from "@fuguejs/framework";
import type { NodeContext, FrameworkError, DagId } from "@fuguejs/framework";
import { z } from "zod";
import { createRunDagHandler } from "../../http/handlers/run-dag.js";
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
    createContext: () => ({ runId: "test-run-id" } as unknown as NodeContext),
    executeDag: successExecuteDag,
    clock: () => Date.now(),
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

  it("returns 403 when team cannot access DAG", async () => {
    const identity: AuthIdentity = { kind: "team", team: "other-team", label: "other" };
    const app = createTestApp(defaultDeps(), readyState, identity);
    const res = await post(app, "test-dag", { query: "hi" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
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
    // Exercises the setup-guard branch: createContext throwing must clear the timeout timer,
    // mark the circuit, rethrow → 500, and the outer finally must still release the slot.
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
    const app = createTestApp(defaultDeps({ executeDag: timeoutExecute }), makeReadyState(reg));
    const res = await post(app, "slow-dag", { query: "hi" });
    expect(res.status).toBe(408);
    expect((await res.json()).error).toBe("timeout");
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
