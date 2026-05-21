import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { HostEnv } from "../../http/router.js";
import { createRunDagHandler } from "../../http/handlers/run-dag.js";
import type { RunDagDeps } from "../../http/handlers/run-dag.js";
import { errorHandler } from "../../http/middleware/error-handler.js";
import type { HostState } from "../../domain/host-state.js";
import type { ConcurrencyState } from "../../domain/concurrency.js";
import { initConcurrency, withDagLimit } from "../../domain/concurrency.js";
import type { CircuitState } from "../../domain/circuit-breaker.js";
import { initCircuit } from "../../domain/circuit-breaker.js";
import { emptyRegistry, withDag } from "../../domain/registry.js";
import type { RegisteredDag } from "../../domain/registry.js";
import type { DagId, NodeContext, Result } from "@fugue/framework";
import { ok, err } from "@fugue/framework";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFakeDag = (id: string, opts?: {
  inputSchema?: z.ZodType;
  timeout?: number;
  maxConcurrency?: number;
  healthy?: boolean;
  disabledReason?: string;
}): RegisteredDag => ({
  id: id as DagId,
  team: "test-team",
  route: `/dags/${id}/run`,
  dag: { id: id as any, nodes: [], edges: [] } as any,
  inputSchema: opts?.inputSchema ?? z.object({ text: z.string() }),
  config: {
    route: `/dags/${id}/run`,
    timeout: opts?.timeout ?? 30_000,
    maxConcurrency: opts?.maxConcurrency ?? 10,
  },
  meta: { description: "", version: "0.0.0" },
  loadedAt: Date.now(),
  sha: "abc123",
  status: (opts?.healthy === false)
    ? { kind: "disabled", reason: opts?.disabledReason ?? "unknown" }
    : { kind: "healthy" },
});

const fakeNodeContext = (dagId: string): NodeContext => ({
  runId: "run-123" as any,
  dagId: dagId as any,
  logger: { warn: () => {}, error: () => {} },
  tracer: { startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {}, recordException: () => {} }) } as any,
  observer: { observe: () => {} } as any,
  cache: null,
  llm: null,
  prompts: null,
  judgeLlm: null,
});

interface TestState {
  concurrency: ConcurrencyState;
  circuits: Map<string, CircuitState>;
  hostState: HostState;
}

const createTestApp = (state: TestState, executeDag?: RunDagDeps["executeDag"]) => {
  const deps: RunDagDeps = {
    getConcurrency: () => state.concurrency,
    setConcurrency: (s) => { state.concurrency = s; },
    getCircuit: (dagId) => state.circuits.get(dagId) ?? initCircuit(Date.now()),
    setCircuit: (dagId, s) => { state.circuits.set(dagId, s); },
    createContext: (registered, signal) => ({ ...fakeNodeContext(registered.id as string), signal }),
    executeDag: executeDag ?? (async () => ok({ result: "success" })) as any,
    clock: Date.now,
  };

  const app = new Hono<HostEnv>();
  app.onError(errorHandler);

  app.use("*", async (c, next) => {
    c.set("hostState", state.hostState);
    await next();
  });

  const handler = createRunDagHandler(deps);
  app.post("/dags/:id/run", handler);
  return app;
};

const postJson = (app: Hono<HostEnv>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /dags/:id/run", () => {
  describe("DAG lookup (FR-025)", () => {
    it("returns 404 when DAG does not exist", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("other-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/nonexistent/run", { text: "hello" });
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toBe("dag-not-found");
      expect(body.dagId).toBe("nonexistent");
      expect(body.details.available).toContain("other-dag");
    });

    it("returns 404 with empty available list when registry is empty", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: emptyRegistry(),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/missing/run", { text: "hi" });
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.details.available).toEqual([]);
    });

    it("returns 503 when host is booting (unavailable)", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: { phase: "booting", startedAt: Date.now() },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/any/run", { text: "hi" });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("host-unavailable");
    });
  });

  describe("Input validation (FR-023)", () => {
    it("returns 400 when input fails schema validation", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag", {
            inputSchema: z.object({ text: z.string().min(1), count: z.number() }),
          })),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/my-dag/run", { text: "", count: "not-a-number" });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("input-validation-failed");
      expect(body.dagId).toBe("my-dag");
      expect(body.details.issues).toBeDefined();
      expect(body.details.issues.length).toBeGreaterThan(0);
    });

    it("returns 400 when body is not valid JSON", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      const app = createTestApp(state);

      const res = await app.request("/dags/my-dag/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all {{{{",
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("body-parse-failed");
    });
  });

  describe("Circuit breaker (FR-091)", () => {
    it("returns 503 when circuit is open", async () => {
      const circuits = new Map<string, CircuitState>();
      circuits.set("broken-dag", {
        state: "open",
        openedAt: Date.now(),
        reason: "Too many failures",
      });

      const state: TestState = {
        concurrency: initConcurrency(),
        circuits,
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("broken-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/broken-dag/run", { text: "test" });
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.error).toBe("dag-disabled");
      expect(body.dagId).toBe("broken-dag");
    });
  });

  describe("Concurrency (FR-026, FR-027)", () => {
    it("returns 429 with Retry-After when global limit exceeded", async () => {
      const state: TestState = {
        concurrency: initConcurrency(2, 10), // global max = 2
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      // Fill up global concurrency
      state.concurrency = {
        ...state.concurrency,
        global: { current: 2, max: 2 },
      };

      const app = createTestApp(state);
      const res = await postJson(app, "/dags/my-dag/run", { text: "test" });
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body.error).toBe("concurrency-exceeded");
      expect(res.headers.get("Retry-After")).toBe("5");
    });

    it("returns 429 when per-DAG limit exceeded", async () => {
      let conc = initConcurrency(50, 1); // per-dag max = 1
      conc = withDagLimit(conc, "my-dag" as DagId, 1);
      // Simulate one active request for this DAG
      conc = {
        ...conc,
        global: { ...conc.global, current: 1 },
        perDag: new Map([["my-dag" as DagId, { current: 1, max: 1 }]]),
      };

      const state: TestState = {
        concurrency: conc,
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/my-dag/run", { text: "test" });
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body.error).toBe("concurrency-exceeded");
      expect(body.details.scope).toBe("dag");
      expect(res.headers.get("Retry-After")).toBe("5");
    });
  });

  describe("Successful execution (FR-020)", () => {
    it("returns 200 with result data on success", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => ok({ summary: "Generated summary" });
      const app = createTestApp(state, executeDag as any);

      const res = await postJson(app, "/dags/my-dag/run", { text: "hello" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({ summary: "Generated summary" });
      expect(body.runId).toBe("run-123");
      expect(body.durationMs).toBeDefined();
      expect(typeof body.durationMs).toBe("number");
    });

    it("releases concurrency token after successful execution", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => ok({ done: true });
      const app = createTestApp(state, executeDag as any);

      await postJson(app, "/dags/my-dag/run", { text: "hello" });

      // After execution, global count should be back to 0
      expect(state.concurrency.global.current).toBe(0);
    });
  });

  describe("DAG execution failure", () => {
    it("returns 500 when DAG returns an error Result", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => err({
        kind: "node-crash" as const,
        nodeId: "summarize" as any,
        message: "LLM call failed",
        retriability: "retriable" as const,
      });
      const app = createTestApp(state, executeDag as any);

      const res = await postJson(app, "/dags/my-dag/run", { text: "hello" });
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toBe("node-crash");
      expect(body.dagId).toBe("my-dag");
    });

    it("releases concurrency token after failed execution", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => err({
        kind: "node-crash" as const,
        nodeId: "n" as any,
        message: "fail",
        retriability: "retriable" as const,
      });
      const app = createTestApp(state, executeDag as any);

      await postJson(app, "/dags/my-dag/run", { text: "hello" });
      expect(state.concurrency.global.current).toBe(0);
    });

    it("records failure in circuit breaker on error", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => err({
        kind: "node-crash" as const,
        nodeId: "n" as any,
        message: "fail",
        retriability: "retriable" as const,
      });
      const app = createTestApp(state, executeDag as any);

      await postJson(app, "/dags/my-dag/run", { text: "hello" });

      const circuit = state.circuits.get("my-dag");
      expect(circuit).toBeDefined();
      expect(circuit!.state).toBe("closed");
      // @ts-ignore — narrowing
      expect(circuit!.failureCount).toBe(1);
    });

    it("records success in circuit breaker on success", async () => {
      // Start with some failures
      const circuits = new Map<string, CircuitState>();
      circuits.set("my-dag", { state: "closed", failureCount: 3, windowStart: Date.now() });

      const state: TestState = {
        concurrency: initConcurrency(),
        circuits,
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => ok({ result: "good" });
      const app = createTestApp(state, executeDag as any);

      await postJson(app, "/dags/my-dag/run", { text: "hello" });

      const circuit = state.circuits.get("my-dag");
      expect(circuit).toBeDefined();
      expect(circuit!.state).toBe("closed");
      // @ts-ignore
      expect(circuit!.failureCount).toBe(0);
    });
  });

  describe("Disabled DAG", () => {
    it("returns 503 when DAG is disabled", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("disabled-dag", {
            healthy: false,
            disabledReason: "Too many failures",
          })),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/disabled-dag/run", { text: "hello" });
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.error).toBe("dag-disabled");
    });
  });

  describe("Thrown exceptions", () => {
    it("catches thrown errors and returns 500", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => { throw new Error("Unexpected boom"); };
      const app = createTestApp(state, executeDag as any);

      const res = await postJson(app, "/dags/my-dag/run", { text: "hello" });
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toBe("internal-error");
      expect(body.message).toContain("Unhandled error executing DAG");
      expect(body.message).toContain("my-dag");
    });

    it("releases concurrency token even when handler throws", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => { throw new Error("boom"); };
      const app = createTestApp(state, executeDag as any);

      await postJson(app, "/dags/my-dag/run", { text: "hello" });
      expect(state.concurrency.global.current).toBe(0);
    });
  });

  describe("Timeout / AbortError (FR-024)", () => {
    it("returns 408 with correct runId when DAG times out", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("slow-dag", { timeout: 50 })),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      // Simulate a DAG that takes too long — the abort signal fires
      const executeDag = async (_dag: unknown, _input: unknown, ctx: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          };
          if (ctx.signal?.aborted) return onAbort();
          ctx.signal?.addEventListener("abort", onAbort);
        });
      };

      const app = createTestApp(state, executeDag as any);
      const res = await postJson(app, "/dags/slow-dag/run", { text: "hello" });

      expect(res.status).toBe(408);
      const body = await res.json();
      expect(body.error).toBe("timeout");
      expect(body.runId).toBe("run-123"); // From fakeNodeContext
      expect(body.details.timeoutMs).toBe(50);
    });

    it("records failure in circuit breaker on timeout", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("slow-dag", { timeout: 50 })),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async (_dag: unknown, _input: unknown, ctx: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          };
          if (ctx.signal?.aborted) return onAbort();
          ctx.signal?.addEventListener("abort", onAbort);
        });
      };

      const app = createTestApp(state, executeDag as any);
      await postJson(app, "/dags/slow-dag/run", { text: "hello" });

      const circuit = state.circuits.get("slow-dag");
      expect(circuit).toBeDefined();
      if (circuit?.state === "closed") {
        expect(circuit.failureCount).toBeGreaterThan(0);
      }
    });

    it("releases concurrency token after timeout", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("slow-dag", { timeout: 50 })),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async (_dag: unknown, _input: unknown, ctx: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          };
          if (ctx.signal?.aborted) return onAbort();
          ctx.signal?.addEventListener("abort", onAbort);
        });
      };

      const app = createTestApp(state, executeDag as any);
      await postJson(app, "/dags/slow-dag/run", { text: "hello" });

      expect(state.concurrency.global.current).toBe(0);
    });
  });

  describe("Half-open circuit breaker integration", () => {
    it("allows request through half-open circuit and heals on success", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map<string, CircuitState>([
          ["healer-dag", { state: "half-open", testRequestAllowed: true }],
        ]),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("healer-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const app = createTestApp(state);
      const res = await postJson(app, "/dags/healer-dag/run", { text: "hello" });

      expect(res.status).toBe(200);
      // Circuit should now be closed (healed)
      const circuit = state.circuits.get("healer-dag");
      expect(circuit?.state).toBe("closed");
    });

    it("re-opens circuit on failure during half-open", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map<string, CircuitState>([
          ["fragile-dag", { state: "half-open", testRequestAllowed: true }],
        ]),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("fragile-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const executeDag = async () => err({ kind: "node-crash", message: "failed" });
      const app = createTestApp(state, executeDag as any);
      const res = await postJson(app, "/dags/fragile-dag/run", { text: "hello" });

      expect(res.status).toBe(500);
      // Circuit should re-open
      const circuit = state.circuits.get("fragile-dag");
      expect(circuit?.state).toBe("open");
    });

    it("blocks requests when circuit is open and cooldown not elapsed", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map<string, CircuitState>([
          ["blocked-dag", { state: "open", openedAt: Date.now(), reason: "too many failures" }],
        ]),
        hostState: {
          phase: "ready",
          registry: withDag(emptyRegistry(), makeFakeDag("blocked-dag")),
          lastSyncAt: Date.now(),
          lastSyncSha: "sha",
        },
      };

      const app = createTestApp(state);
      const res = await postJson(app, "/dags/blocked-dag/run", { text: "hello" });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("dag-disabled");
    });
  });

  describe("Draining phase rejection (NFR-030)", () => {
    it("returns 503 when host is draining", async () => {
      const state: TestState = {
        concurrency: initConcurrency(),
        circuits: new Map(),
        hostState: {
          phase: "draining",
          registry: withDag(emptyRegistry(), makeFakeDag("my-dag")),
          drainStartedAt: Date.now(),
          inflightCount: 0,
        },
      };
      const app = createTestApp(state);

      const res = await postJson(app, "/dags/my-dag/run", { text: "hello" });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("host-unavailable");
    });
  });
});
