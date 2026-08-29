// Regression suite for the 2026-05-11 framework review remediation pass 2.
// Each describe block maps to a Wave-N fix in
// docs/plans/2026-05-11-framework-review-remediation-pass-2.md.

import { describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { z } from "zod";

import { runStateMachine } from "../state-machine/runner.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import type { Machine } from "../state-machine/types.js";

import { createInMemoryBackend } from "../queue/in-memory.js";

import { dagTransition } from "../dag-runtime/transition.js";
import { handleNodeFailed } from "../dag-runtime/retry-policy.js";
import { computeOutgoingByNode, computeUnconditionalAdj } from "../dag-runtime/topology.js";
import type { DagMachineContext } from "../dag-runtime/types.js";

import { defineDag } from "../executor/define-dag.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";

import { createTransformNode } from "../nodes/transform.js";
import { createGuardrailNode } from "../nodes/guardrail.js";

import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import { dagFingerprint } from "../checkpoint/fingerprint.js";

import { InMemoryCache } from "../cache/cache.js";
import { ratio } from "../observer/policy.js";

import { applyJitter } from "../shared/jitter.js";
import { diffRegistry } from "../scheduler/diff.js";
import type { TaskRegistry } from "../scheduler/types.js";

import { ok } from "../types/result.js";
import { NoopObserver } from "../observer/observer.js";
import type { NodeContext } from "../types/node.js";
import { DAG_INPUT } from "../types/ids.js";

import fc from "fast-check";
import { N, R } from "./_id-helpers.js";
import { testRuntimeContext } from "./_context-factories.js";

const makeBaseCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  logger: { warn: () => {}, error: () => {} },
  cache: null,
  llm: null, http: null, clock: null, budget: null,
  prompts: null,
  judgeLlm: null,
  ...overrides,
});

// ===========================================================================
// Wave 1.1 — `onTrace` exception isolation
// ===========================================================================

describe("Wave 1.1 — onTrace exceptions do not escape the kernel loop", () => {
  type S = { kind: "pending" } | { kind: "running" } | { kind: "succeeded" };
  type E = { type: "START" } | { type: "DONE" } | { type: "ERROR"; retriable: boolean; message: string };

  const machine: Machine<S, E, null> = {
    transition(state, event, context) {
      if (state.kind === "pending" && event.type === "START") {
        return { state: { kind: "running" }, context };
      }
      if (state.kind === "running" && event.type === "DONE") {
        return { state: { kind: "succeeded" }, context };
      }
      return { state, context };
    },
    isTerminal: (s) => s.kind === "succeeded",
    isFailed: () => false,
    stateProgress: (s) => (s.kind === "succeeded" ? 100 : 0),
    stateKey: (s) => JSON.stringify(s),
  };

  it("a throwing onTrace is caught; run still reaches terminal-succeeded", async () => {
    const job = createInMemoryJob<S, null>({ state: { kind: "pending" }, context: null });
    const events: readonly E[] = [{ type: "START" }, { type: "DONE" }] as const;
    let i = 0;
    const executor = async (): Promise<E> => {
      const e = events[i]!;
      i++;
      return e;
    };

    const errors: string[] = [];
    const testLogger = {
      warn: (msg: string) => { errors.push(msg); },
      error: (msg: string) => { errors.push(msg); },
    };

    const result = await runStateMachine(job, machine, executor, {
      errorEventOf: (c): E => ({ type: "ERROR", retriable: c.retriable, message: c.message }),
      onTrace: () => {
        throw new Error("simulated onTrace failure");
      },
      logger: testLogger,
    });
    expect(result.state).toEqual({ kind: "succeeded" });
    expect(errors.some((e) => e.includes("onTrace threw"))).toBe(true);
  });

  it("a throwing trace logger cannot replace an already-persisted transition", async () => {
    const job = createInMemoryJob<S, null>({ state: { kind: "pending" }, context: null });
    const events: readonly E[] = [{ type: "START" }, { type: "DONE" }] as const;
    let index = 0;

    const result = await runStateMachine(
      job,
      machine,
      async () => events[index++]!,
      {
        errorEventOf: (classified): E => ({
          type: "ERROR",
          retriable: classified.retriable,
          message: classified.message,
        }),
        onTrace: () => { throw new Error("trace failed"); },
        logger: {
          warn: () => {},
          error: () => { throw new Error("logger failed"); },
        },
      },
    );

    expect(result.state).toEqual({ kind: "succeeded" });
    expect(job.data.state).toEqual({ kind: "succeeded" });
  });
});

// ===========================================================================
// Wave 1.2 — InMemoryQueue surfaces failures with no `onFailed` handler
// ===========================================================================

describe("Wave 1.2 — InMemoryQueue logs to console.error when no handler", () => {
  it("a job that throws on every attempt with no handler logs once per attempt", async () => {
    const backend = createInMemoryBackend();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };

    try {
      const queue = backend.createQueue("q1", { defaultAttempts: 3 });
      backend.createWorker("q1", async () => {
        throw new Error("processing failed");
      });

      await queue.enqueue("job-1", { state: {}, context: {} });
      await queue.drain();

      // Mid-retry routes to onFailed (2 logs, neither handler registered) +
      // final attempt routes to onExhausted (1 log).
      const matched = errors.filter(
        (e) => e.includes("InMemoryQueue") && e.includes("job-1") && e.includes("no handler"),
      );
      expect(matched.length).toBe(3);
    } finally {
      console.error = original;
    }
  });

  it("when both onFailed and onExhausted are registered, no console.error is emitted", async () => {
    const backend = createInMemoryBackend();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };

    try {
      const queue = backend.createQueue("q2", { defaultAttempts: 1 });
      const worker = backend.createWorker("q2", async () => {
        throw new Error("processing failed");
      });
      let handlerCalls = 0;
      // attempts=1, max=1 → routes to onExhausted; register both to cover
      // either branch in case of future drift.
      worker.onFailed(() => { handlerCalls++; });
      worker.onExhausted(() => { handlerCalls++; });

      await queue.enqueue("job-2", { state: {}, context: {} });
      await queue.drain();

      expect(handlerCalls).toBe(1);
      const noHandlerLog = errors.find((e) => e.includes("no handler"));
      expect(noHandlerLog).toBeUndefined();
    } finally {
      console.error = original;
    }
  });
});

// ===========================================================================
// Wave 1.3 + 1.4 — `node-crash` with `retriable: false` fast-fails
// ===========================================================================

describe("Wave 1.4 — handleNodeFailed fast-fails node-crash retriable:false", () => {
  const baseCtx = (): DagMachineContext => {
    const dag = defineDag({
      id: "d",
      nodes: {
        a: createTransformNode({
          id: N("a"),
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          transform: () => ok(null),
        }),
      },
      edges: [{ from: DAG_INPUT, to: "a" }],
      outputNodeId: "a",
      defaultRetryLimit: 5,
    });
    return testRuntimeContext({
      dag,
      waves: [[N("a")]],
      initialInput: null,
      activeNodeIds: new Set([N("a")]),
      outgoingByNode: computeOutgoingByNode(dag),
      unconditionalAdj: computeUnconditionalAdj(dag),
      nodeById: new Map(dag.nodes.map((node) => [node.id, node])),
    });
  };

  it("retriability: non-retriable bypasses the retry budget", () => {
    const ctx = baseCtx();
    const result = handleNodeFailed(0, N("a"), {
      kind: "node-crash",
      nodeId: "a" as NodeId,
      message: "permanent",
      retriability: "non-retriable",
    }, ctx);
    expect(result.state.kind).toBe("failed");
  });

  it("retriability: retriable consumes the retry budget", () => {
    const ctx = baseCtx();
    const result = handleNodeFailed(0, N("a"), {
      kind: "node-crash",
      nodeId: "a" as NodeId,
      message: "transient",
      retriability: "retriable",
    }, ctx);
    expect(result.state.kind).toBe("retrying");
  });
});

describe("Wave 1.4 — dagTransition propagates ERROR.retriable into failed terminal", () => {
  const baseCtx = (): DagMachineContext => {
    const dag = defineDag({
      id: "d",
      nodes: {
        a: createTransformNode({
          id: N("a"),
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          transform: () => ok(null),
        }),
      },
      edges: [{ from: DAG_INPUT, to: "a" }],
      outputNodeId: "a",
    });
    return testRuntimeContext({
      dag,
      waves: [[N("a")]],
      initialInput: null,
      activeNodeIds: new Set([N("a")]),
      outgoingByNode: computeOutgoingByNode(dag),
      unconditionalAdj: computeUnconditionalAdj(dag),
      nodeById: new Map(dag.nodes.map((node) => [node.id, node])),
    });
  };

  it("retriable: false produces node-crash with retriable: false on the failed terminal", () => {
    const result = dagTransition(
      { kind: "running", wave: 0 },
      { type: "executor-error", retriable: false, error: "boom" },
      baseCtx(),
    );
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed" && result.state.error.kind === "node-crash") {
      expect(result.state.error.retriability).toBe("non-retriable");
    } else {
      throw new Error("expected node-crash with retriable: false");
    }
  });
});

// ===========================================================================
// Wave 2.3 — GuardrailFailed variant on validator throw
// ===========================================================================

describe("Wave 2.3 — GuardrailFailed variant emitted when validator throws", () => {
  it("validator throw produces kind: 'failed' with no `value` field", async () => {
    const ResultSchema = z.any() as unknown as z.ZodType<
      import("../nodes/guardrail.js").GuardrailResult<unknown>
    >;
    const node = createGuardrailNode<{ x: number }, unknown>({
      id: N("g"),
      inputSchema: z.object({ x: z.number() }),
      outputSchema: ResultSchema,
      validate: (_i) => {
        throw new Error("validator exploded");
      },
    });

    const errSink: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errSink.push(String(args[0])); };
    try {
      const result = await node.run({ x: 1 }, makeBaseCtx());
      expect(result.ok).toBe(true);
      if (result.ok && result.value.kind === "failed") {
        expect(result.value.passed).toBe(false);
        expect(result.value.error).toContain("validator exploded");
        // value is not present on the failed variant — compile-time enforced.
        // The runtime shape MUST NOT carry it.
        expect((result.value as { value?: unknown }).value).toBeUndefined();
      } else {
        throw new Error("expected failed guardrail result");
      }
    } finally {
      console.error = origError;
    }
  });
});

// ===========================================================================
// Wave 2.4 — InMemoryCheckpointer enforces expectedDagFingerprint
// ===========================================================================

describe("Wave 2.4 — InMemoryCheckpointer rejects mismatched dagFingerprint at load", () => {
  it("load with mismatched expectedDagFingerprint returns checkpoint-version-mismatch", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("r1"), {
      dagId: "d" as DagId,
      startedAt: new Date(),
      nodeCount: 1,
      dagFingerprint: "fp-a",
    });
    const result = await cp.load(R("r1"), { expectedDagFingerprint: "fp-b" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-version-mismatch");
    }
  });

  it("load with matching expectedDagFingerprint returns the state", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("r2"), {
      dagId: "d" as DagId,
      startedAt: new Date(),
      nodeCount: 1,
      dagFingerprint: "fp-match",
    });
    const result = await cp.load(R("r2"), { expectedDagFingerprint: "fp-match" });
    expect(result.ok).toBe(true);
  });

  it("load without expectedDagFingerprint preserves legacy no-check behavior", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("r3"), {
      dagId: "d" as DagId,
      startedAt: new Date(),
      nodeCount: 1,
    });
    const result = await cp.load(R("r3"));
    expect(result.ok).toBe(true);
  });

  it("dagFingerprint() of two equivalent DAGs is identical (smoke test)", () => {
    const a = defineDag({
      id: "d",
      nodes: {
        n: createTransformNode({
          id: N("n"),
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          transform: () => ok(null),
        }),
      },
      edges: [{ from: DAG_INPUT, to: "n" }],
      outputNodeId: "n",
    });
    const b = defineDag({
      id: "d",
      nodes: {
        n: createTransformNode({
          id: N("n"),
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          transform: () => ok(null),
        }),
      },
      edges: [{ from: DAG_INPUT, to: "n" }],
      outputNodeId: "n",
    });
    expect(dagFingerprint(a)).toBe(dagFingerprint(b));
  });
});

// ===========================================================================
// Wave 6.2 — `ratio()` accepts an injectable RNG
// ===========================================================================

describe("Wave 6.2 — ratio() accepts an injectable RNG for deterministic tests", () => {
  it("rng returning 0 always flushes for p=0.5", () => {
    const policy = ratio(0.5, () => 0);
    expect(
      policy.shouldFlush({
        runId: "x" as RunId,
        status: "ok",
        totalDuration: 0,
        nodeCount: 0,
        retryCount: 0,
        totalCostUsd: 0,
        freshnessViolationCount: 0,
        humanInterventionCount: 0,
        routeDecisionCount: 0,
      }),
    ).toBe(true);
  });

  it("rng returning 1 never flushes for p=0.5", () => {
    const policy = ratio(0.5, () => 0.99);
    expect(
      policy.shouldFlush({
        runId: "x" as RunId,
        status: "ok",
        totalDuration: 0,
        nodeCount: 0,
        retryCount: 0,
        totalCostUsd: 0,
        freshnessViolationCount: 0,
        humanInterventionCount: 0,
        routeDecisionCount: 0,
      }),
    ).toBe(false);
  });
});

// ===========================================================================
// Wave 6.2 — InMemoryCache accepts an injectable `now`
// ===========================================================================

describe("Wave 6.2 — InMemoryCache accepts an injectable now() seam", () => {
  it("TTL expiry follows the injected clock without real timers", async () => {
    let t = 1000;
    const cache = new InMemoryCache({ now: () => t });
    await cache.set("k", "v", 1); // 1s TTL → expires at t=2000
    expect((await cache.get("k", z.string())).ok ? (await cache.get("k", z.string())) : null).toBeTruthy();

    const beforeExpiry = await cache.get("k", z.string());
    expect(beforeExpiry.ok && beforeExpiry.value).toBe("v");

    t = 2500; // past TTL
    const afterExpiry = await cache.get("k", z.string());
    expect(afterExpiry.ok && afterExpiry.value).toBe(null);
  });

  it("a throwing injected clock is a typed cache-error on set and get, never a raw rejection (round-22 sfh-3)", async () => {
    let broken = true;
    const cache = new InMemoryCache({
      now: () => {
        if (broken) throw new Error("clock boom");
        return 1_000;
      },
    });
    const setRes = await cache.set("k", "v", 1);
    expect(setRes.ok).toBe(false);
    if (!setRes.ok) {
      expect(setRes.error.kind).toBe("cache-error");
      expect((setRes.error as { operation: string }).operation).toBe("set");
    }
    // A stored value read with a throwing clock must also fail typed — the
    // TTL path reads `now()` too (never a raw rejection from the get call).
    broken = false;
    await cache.set("k", "v", 1); // healthy clock: value lands in the store
    broken = true;
    const getRes = await cache.get("k", z.string());
    expect(getRes.ok).toBe(false);
    if (!getRes.ok) {
      expect(getRes.error.kind).toBe("cache-error");
      expect((getRes.error as { operation: string }).operation).toBe("get");
    }
  });

  it("a non-finite injected clock is a typed cache-error on set, never a raw rejection (round-22 sfh-3)", async () => {
    const cache = new InMemoryCache({ now: () => Number.NaN });
    const setRes = await cache.set("k", "v", 1);
    expect(setRes.ok).toBe(false);
    if (!setRes.ok) {
      expect(setRes.error.kind).toBe("cache-error");
      expect((setRes.error as { operation: string }).operation).toBe("set");
    }
  });

  it("a non-finite get clock returns a typed error without evicting the entry", async () => {
    let now = 1_000;
    const cache = new InMemoryCache({ now: () => now });
    expect((await cache.set("k", "v", 10)).ok).toBe(true);

    now = Number.POSITIVE_INFINITY;
    const invalidClock = await cache.get("k", z.string());
    expect(invalidClock.ok).toBe(false);
    if (!invalidClock.ok) {
      expect(invalidClock.error).toMatchObject({ kind: "cache-error", operation: "get" });
    }

    now = 2_000;
    const recovered = await cache.get("k", z.string());
    expect(recovered).toEqual(ok("v"));
  });

  it("a cyclic value is a typed cache-error on set, never a raw rejection (round-22 sfh-3)", async () => {
    const cache = new InMemoryCache({ now: () => 1_000 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const setRes = await cache.set("k", cyclic, 1);
    expect(setRes.ok).toBe(false);
    if (!setRes.ok) {
      expect(setRes.error.kind).toBe("cache-error");
      expect((setRes.error as { operation: string }).operation).toBe("set");
      expect((setRes.error as { message: string }).message).toContain("JSON.stringify");
    }
  });
});

// ===========================================================================
// Wave 7 — resumeCheckpoint stateful schema-mismatch + write-failure
// ===========================================================================

describe("Wave 7 — resumeCheckpoint on the stateful executor", () => {
  it("schema-mismatch on cached output emits node-error and fails the run", async () => {
    const dag = defineDag({
      id: "d",
      nodes: {
        a: createTransformNode({
          id: N("a"),
          inputSchema: z.unknown(),
          // Schema tightened after the checkpoint was written
          outputSchema: z.object({ shape: z.literal("new") }),
          transform: () => ok({ shape: "new" } as const),
        }),
      },
      edges: [{ from: DAG_INPUT, to: "a" }],
      outputNodeId: "a",
    });

    const checkpoint = new Map<string, unknown>([
      ["a", { shape: "old" }], // fails the current `shape: "new"` schema
    ]);

    const result = await runDagStateful(dag, null, makeBaseCtx(), {
      resumeCheckpoint: checkpoint,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["validation", "retry-exhausted"]).toContain(result.error.kind);
    }
  });

  it("valid cached output skips execution and uses the checkpointed value", async () => {
    let ran = 0;
    const dag = defineDag({
      id: "d",
      nodes: {
        a: createTransformNode({
          id: N("a"),
          inputSchema: z.unknown(),
          outputSchema: z.object({ v: z.number() }),
          transform: () => {
            ran++;
            return ok({ v: 1 });
          },
        }),
      },
      edges: [{ from: DAG_INPUT, to: "a" }],
      outputNodeId: "a",
    });

    const checkpoint = new Map<string, unknown>([["a", { v: 42 }]]);
    const result = await runDagStateful(dag, null, makeBaseCtx(), {
      resumeCheckpoint: checkpoint,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ v: 42 });
    expect(ran).toBe(0);
  });
});

// ===========================================================================
// Wave 7 — coFailedNodeIds pre-increment correctness
// ===========================================================================

describe("Wave 7 — handleNodeFailed pre-increments co-failed siblings", () => {
  const ctxWithRetries = (retries: ReadonlyMap<string, number>): DagMachineContext => {
    const dag = defineDag({
      id: "d",
      nodes: {
        a: createTransformNode({
          id: N("a"),
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          transform: () => ok(null),
        }),
        b: createTransformNode({
          id: N("b"),
          inputSchema: z.unknown(),
          outputSchema: z.unknown(),
          transform: () => ok(null),
        }),
      },
      edges: [{ from: DAG_INPUT, to: "a" }, { from: DAG_INPUT, to: "b" }],
      outputNodeId: "a",
      defaultRetryLimit: 2,
    });
    return testRuntimeContext({
      dag,
      waves: [[N("a"), N("b")]],
      retries: new Map([...retries].map(([id, count]) => [N(id), count])),
      initialInput: null,
      activeNodeIds: new Set([N("a"), N("b")]),
      outgoingByNode: computeOutgoingByNode(dag),
      unconditionalAdj: computeUnconditionalAdj(dag),
      nodeById: new Map(dag.nodes.map((node) => [node.id, node])),
    });
  };

  it("two co-failed siblings each consume the retry slot; neither gets retryLimit+1", () => {
    const ctx = ctxWithRetries(new Map());
    const result = handleNodeFailed(
      0,
      N("a"),
      { kind: "transient", nodeId: "a" as NodeId, message: "boom" },
      ctx,
      undefined,
      [N("b")],
    );
    // After: a.retries = 1 (primary), b.retries = 1 (co-failed pre-increment)
    expect(result.context.retries.get(N("a"))).toBe(1);
    expect(result.context.retries.get(N("b"))).toBe(1);
  });

  it("co-failed pre-increment caps at retryLimit", () => {
    const ctx = ctxWithRetries(new Map([["b", 2]]));
    const result = handleNodeFailed(
      0,
      N("a"),
      { kind: "transient", nodeId: "a" as NodeId, message: "boom" },
      ctx,
      undefined,
      [N("b")],
    );
    expect(result.context.retries.get(N("b"))).toBe(2);
  });
});

// ===========================================================================
// Wave 7 — property tests for jitter, diffRegistry, applyJitter range
// ===========================================================================

describe("Wave 7 — property tests", () => {
  it("applyJitter result lies in [base*(1 - ratio), base*(1 + ratio)]", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: Math.fround(0.999), noNaN: true }),
        (base, jitterRatio, rand) => {
          const result = applyJitter(base, jitterRatio, () => rand);
          const lo = base * (1 - jitterRatio);
          const hi = base * (1 + jitterRatio);
          const epsilon = Math.max(1, base * 1e-6);
          return result >= lo - epsilon && result <= hi + epsilon;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("diffRegistry(d, d) is idempotent (no add/remove/update)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 8 }),
            cron: fc.constantFrom("0 * * * *", "*/5 * * * *", "0 0 * * *"),
            validForMs: fc.integer({ min: 1000, max: 600_000 }),
          }),
          { maxLength: 8 },
        ),
        (tasks) => {
          const reg: TaskRegistry = new Map(tasks.map((t) => [t.id, { id: t.id, cron: t.cron, validForMs: t.validForMs }]));
          const diff = diffRegistry(reg, reg);
          return diff.add.length === 0 && diff.remove.length === 0 && diff.update.length === 0;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Wave 7 — input-validation failure emits node-error
// ===========================================================================

describe("Wave 4.1 — input-validation failure emits a node-error event", () => {
  it("a node with a strict input schema and bad upstream value emits node-error", async () => {
    const events: string[] = [];
    const observer = {
      observe(e: unknown) {
        const ev = e as { type?: string; error?: string };
        if (ev.type === "node-start") events.push("node-start");
        else if (ev.type === "node-end") events.push("node-end");
        else if (ev.type === "node-error") events.push(`node-error:${(ev.error ?? "").slice(0, 30)}`);
      },
    };

    const dag = defineDag({
      id: "d",
      nodes: {
        a: createTransformNode({
          id: N("a"),
          inputSchema: z.object({ requiredField: z.string() }),
          outputSchema: z.unknown(),
          transform: () => ok(null),
        }),
      },
      edges: [{ from: DAG_INPUT, to: "a" }],
      outputNodeId: "a",
    });

    const ctx = makeBaseCtx({ observer });
    const result = await runDagStateful(dag, { wrongField: 1 }, ctx);
    expect(result.ok).toBe(false);
    expect(events.some((e) => e.startsWith("node-error:"))).toBe(true);
  });
});

