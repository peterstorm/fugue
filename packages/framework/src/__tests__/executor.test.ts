import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { NodeContext, NodeDef } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { HumanAction } from "../dag-runtime/types.js";
import { runDag } from "../executor/executor.js";
import { topoSort } from "../executor/topo.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createTransformNode } from "../nodes/transform.js";
import { RecordingObserver, NoopObserver } from "../observer/observer.js";

const mkCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run",
  dagId: "test-dag",
  observer: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: null,
  ...overrides,
});

describe("topoSort", () => {
  it("sorts linear DAG into sequential waves", () => {
    const dag: DagDef = {
      id: "linear",
      nodes: [
        createTransformNode({ id: "A", inputSchema: z.any(), outputSchema: z.any(), deps: [], transform: (i) => ok(i) }),
        createTransformNode({ id: "B", inputSchema: z.any(), outputSchema: z.any(), deps: ["A"], transform: (i) => ok(i) }),
        createTransformNode({ id: "C", inputSchema: z.any(), outputSchema: z.any(), deps: ["B"], transform: (i) => ok(i) }),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    };
    const result = topoSort(dag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([["A"], ["B"], ["C"]]);
    }
  });

  it("parallel DAG has A and B in same wave", () => {
    const dag: DagDef = {
      id: "parallel",
      nodes: [
        createTransformNode({ id: "A", inputSchema: z.any(), outputSchema: z.any(), deps: [], transform: (i) => ok(i) }),
        createTransformNode({ id: "B", inputSchema: z.any(), outputSchema: z.any(), deps: [], transform: (i) => ok(i) }),
        createTransformNode({ id: "C", inputSchema: z.any(), outputSchema: z.any(), deps: ["A", "B"], transform: (i) => ok(i) }),
      ],
      edges: [
        { from: "A", to: "C" },
        { from: "B", to: "C" },
      ],
    };
    const result = topoSort(dag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0].sort()).toEqual(["A", "B"]);
      expect(result.value[1]).toEqual(["C"]);
    }
  });

  it("detects cycles", () => {
    const dag: DagDef = {
      id: "cycle",
      nodes: [
        createTransformNode({ id: "A", inputSchema: z.any(), outputSchema: z.any(), deps: ["B"], transform: (i) => ok(i) }),
        createTransformNode({ id: "B", inputSchema: z.any(), outputSchema: z.any(), deps: ["A"], transform: (i) => ok(i) }),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    };
    const result = topoSort(dag);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cycle-detected");
    }
  });
});

describe("runDag", () => {
  it("linear DAG (A→B→C) runs in order", async () => {
    const log: string[] = [];
    const dag: DagDef = {
      id: "linear",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: [],
          transform: (i: { value: number }) => { log.push("A"); return ok({ value: i.value + 1 }); },
        }),
        createTransformNode({
          id: "B",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: ["A"],
          transform: (i: { value: number }) => { log.push("B"); return ok({ value: i.value * 2 }); },
        }),
        createTransformNode({
          id: "C",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: ["B"],
          transform: (i: { value: number }) => { log.push("C"); return ok({ value: i.value + 10 }); },
        }),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    };

    const result = await runDag(dag, { value: 1 }, mkCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: 14 }); // (1+1)*2+10
    }
    expect(log).toEqual(["A", "B", "C"]);
  });

  it("input validation failure returns Err(validation)", async () => {
    const dag: DagDef = {
      id: "val",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.any(),
          deps: [],
          transform: (i) => ok(i),
        }),
      ],
      edges: [],
    };
    const result = await runDag(dag, { value: "not a number" }, mkCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("output validation failure returns Err(validation)", async () => {
    const dag: DagDef = {
      id: "val",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.any(),
          outputSchema: z.object({ value: z.number() }),
          deps: [],
          transform: (_i) => ok({ value: "wrong" } as any),
        }),
      ],
      edges: [],
    };
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("node returning Err stops execution", async () => {
    const log: string[] = [];
    const dag: DagDef = {
      id: "err",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.any(),
          outputSchema: z.any(),
          deps: [],
          transform: (_i) => { log.push("A"); return err({ kind: "node-crash" as const, nodeId: "A", message: "boom" }); },
        }),
        createTransformNode({
          id: "B",
          inputSchema: z.any(),
          outputSchema: z.any(),
          deps: ["A"],
          transform: (i) => { log.push("B"); return ok(i); },
        }),
      ],
      edges: [{ from: "A", to: "B" }],
    };
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    expect(log).toEqual(["A"]);
  });

  it("resume skips checkpointed nodes and re-runs failed node", async () => {
    const log: string[] = [];

    const dag: DagDef = {
      id: "resume-test",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: [],
          transform: (i: { value: number }) => { log.push("A"); return ok({ value: i.value + 1 }); },
        }),
        createTransformNode({
          id: "B",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: ["A"],
          transform: (i: { value: number }) => { log.push("B"); return ok({ value: i.value * 2 }); },
        }),
        createTransformNode({
          id: "C",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: ["B"],
          transform: (i: { value: number }) => { log.push("C"); return ok({ value: i.value + 10 }); },
        }),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    };

    // Simulate: A and B completed, C failed. Resume with checkpoint for A and B.
    const checkpoint = new Map<string, unknown>([
      ["A", { value: 2 }],
      ["B", { value: 4 }],
    ]);

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "resume-run-1", dagId: "resume-test" });

    const result = await runDag(dag, undefined, ctx, {
      resume: { runId: "resume-run-1", checkpoint },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: 14 }); // 4 + 10
    }

    // A and B should NOT have run
    expect(log).toEqual(["C"]);

    // Verify NodeSkipped events for A and B
    const skipped = observer.events.filter((e) => e.type === "node-skipped");
    expect(skipped.length).toBe(2);
    expect(skipped.map((e) => (e as any).nodeId).sort()).toEqual(["A", "B"]);

    // Verify C ran (node-start + node-end)
    const nodeStarts = observer.events.filter((e) => e.type === "node-start");
    expect(nodeStarts.length).toBe(1);
    expect((nodeStarts[0] as any).nodeId).toBe("C");

    const nodeEnds = observer.events.filter((e) => e.type === "node-end");
    expect(nodeEnds.length).toBe(1);
    expect((nodeEnds[0] as any).nodeId).toBe("C");
  });

  it("checkpoint replay validates cached output against current outputSchema (codex finding #2)", async () => {
    // A deploy may tighten or change a node's outputSchema between writes
    // and resume. The cached value must be re-validated, otherwise stale
    // outputs propagate unchecked into the rest of the DAG (and, in the
    // last-wave case, straight back to the caller).
    const log: string[] = [];

    const dag: DagDef = {
      id: "schema-evolved",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.unknown(),
          // Current schema requires `value: number` AND a new field `version: 2`.
          outputSchema: z.object({ value: z.number(), version: z.literal(2) }),
          deps: [],
          transform: () => { log.push("A"); return ok({ value: 1, version: 2 as const }); },
        }),
      ],
      edges: [],
    };

    // Old checkpoint persisted under previous schema (no `version` field).
    const stale = new Map<string, unknown>([["A", { value: 99 }]]);

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "stale-run", dagId: "schema-evolved" });

    const result = await runDag(dag, undefined, ctx, {
      resume: { runId: "stale-run", checkpoint: stale },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") {
        expect(result.error.nodeId).toBe("A");
      }
    }
    // Stale value must NOT be silently passed through.
    expect(log).toEqual([]);

    const errs = observer.events.filter((e) => e.type === "node-error");
    expect(errs.length).toBe(1);
    expect((errs[0] as any).nodeId).toBe("A");
  });

  it("observability: full run emits correct event sequence", async () => {
    const dag: DagDef = {
      id: "obs-test",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: [],
          transform: (i: { value: number }) => ok({ value: i.value + 1 }),
        }),
        createTransformNode({
          id: "B",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: ["A"],
          transform: (i: { value: number }) => ok({ value: i.value * 2 }),
        }),
      ],
      edges: [{ from: "A", to: "B" }],
    };

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "obs-run-1", dagId: "obs-test" });

    const result = await runDag(dag, { value: 1 }, ctx);
    expect(result.ok).toBe(true);

    const types = observer.events.map((e) => e.type);
    expect(types).toEqual([
      "run-start",
      "node-start", "node-end",   // A
      "node-start", "node-end",   // B
      "run-end",
    ]);

    // RunStart
    expect((observer.events[0] as any).runId).toBe("obs-run-1");
    expect((observer.events[0] as any).dagId).toBe("obs-test");

    // RunEnd
    const runEnd = observer.events[observer.events.length - 1] as any;
    expect(runEnd.status).toBe("ok");
    expect(typeof runEnd.duration).toBe("number");
  });

  it("observability: failed run emits run-end with error status", async () => {
    const dag: DagDef = {
      id: "err-obs",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.any(),
          outputSchema: z.any(),
          deps: [],
          transform: (_i) => ok({ v: 1 }),
        }),
        createTransformNode({
          id: "B",
          inputSchema: z.any(),
          outputSchema: z.any(),
          deps: ["A"],
          transform: (_i) => err({ kind: "node-crash" as const, nodeId: "B", message: "boom" }),
        }),
      ],
      edges: [{ from: "A", to: "B" }],
    };

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "err-run", dagId: "err-obs" });
    const result = await runDag(dag, {}, ctx);
    expect(result.ok).toBe(false);

    const runEnd = observer.events.find((e) => e.type === "run-end");
    expect(runEnd).toBeDefined();
    expect((runEnd as any)!.status).toBe("error");
  });

  it("checkpointer: writeCheckpoint called for each successful node", async () => {
    const checkpoints: Array<{ runId: string; nodeId: string; output: unknown }> = [];
    const dag: DagDef = {
      id: "ckpt-test",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: [],
          transform: (i: { value: number }) => ok({ value: i.value + 1 }),
        }),
        createTransformNode({
          id: "B",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          deps: ["A"],
          transform: (i: { value: number }) => ok({ value: i.value * 2 }),
        }),
      ],
      edges: [{ from: "A", to: "B" }],
    };

    const cache = {
      get: async () => null,
      set: async () => {},
      writeCheckpoint: async (runId: string, nodeId: string, output: unknown) => {
        checkpoints.push({ runId, nodeId, output });
      },
    };
    const ctx = mkCtx({ cache, runId: "ckpt-run" });
    const result = await runDag(dag, { value: 1 }, ctx);
    expect(result.ok).toBe(true);

    expect(checkpoints).toEqual([
      { runId: "ckpt-run", nodeId: "A", output: { value: 2 } },
      { runId: "ckpt-run", nodeId: "B", output: { value: 4 } },
    ]);
  });

  it("cycle detection returns Err(cycle-detected)", async () => {
    const dag: DagDef = {
      id: "cycle",
      nodes: [
        createTransformNode({ id: "A", inputSchema: z.any(), outputSchema: z.any(), deps: ["B"], transform: (i) => ok(i) }),
        createTransformNode({ id: "B", inputSchema: z.any(), outputSchema: z.any(), deps: ["A"], transform: (i) => ok(i) }),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    };
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cycle-detected");
    }
  });

  it("guardrail node in DAG passes data through with warnings to downstream nodes", async () => {
    const { createGuardrailNode } = await import("../nodes/guardrail.js");

    const guardrail = createGuardrailNode({
      id: "guard",
      inputSchema: z.any(),
      outputSchema: z.any(),
      deps: ["source"],
      validate: (input: any) => ({
        kind: "validated" as const,
        value: input,
        passed: false,
        warnings: ["test warning"],
        checks: [{ dimension: "test", passed: false, detail: "failed check" }],
      }),
    });

    const dag: DagDef = {
      id: "guardrail-test",
      nodes: [
        createTransformNode({ id: "source", inputSchema: z.any(), outputSchema: z.any(), deps: [], transform: () => ok({ data: 42 }) }),
        guardrail,
        createTransformNode({
          id: "consumer",
          inputSchema: z.any(),
          outputSchema: z.any(),
          deps: ["guard"],
          transform: (input: any) => ok({ received: input.passed, value: input.value }),
        }),
      ],
      edges: [
        { from: "source", to: "guard" },
        { from: "guard", to: "consumer" },
      ],
    };

    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as any).received).toBe(false);
      expect((result.value as any).value).toEqual({ data: 42 });
    }
  });

  it("checkpoint write failure does not crash DAG execution", async () => {
    const failingCache = {
      get: async () => null,
      set: async () => {},
      writeCheckpoint: async () => { throw new Error("Redis timeout"); },
    };
    const dag: DagDef = {
      id: "checkpoint-fail",
      nodes: [
        createTransformNode({ id: "A", inputSchema: z.any(), outputSchema: z.any(), deps: [], transform: () => ok(42) }),
      ],
      edges: [],
    };
    const result = await runDag(dag, {}, mkCtx({ cache: failingCache }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });
});

// ---------------------------------------------------------------------------
// T6 routing / back-compat shim tests
// ---------------------------------------------------------------------------

describe("runDag routing (T6 back-compat shim)", () => {
  const mkSimpleDag = (id = "simple"): DagDef => ({
    id,
    nodes: [
      createTransformNode({
        id: "A",
        inputSchema: z.any(),
        outputSchema: z.any(),
        deps: [],
        transform: (i) => ok(i),
      }),
    ],
    edges: [],
  });

  it("resume + jobLike returns err(node-crash) — not throw", async () => {
    const dag = mkSimpleDag("resume-jl");
    const jobLike = {
      data: { state: { kind: "pending" as const }, context: {} as any },
      updateData: async () => {},
      updateProgress: async () => {},
      appendEvent: async () => {},
    };
    const result = await runDag(dag, {}, mkCtx(), {
      resume: { runId: "r1", checkpoint: new Map() },
      jobLike,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("__executor__");
      expect(result.error.message).toContain("incompatible");
    } else {
      throw new Error("expected node-crash error");
    }
  });

  it("resume-only routes to legacy path (not state-machine)", async () => {
    const log: string[] = [];
    const dag: DagDef = {
      id: "legacy-resume",
      nodes: [
        createTransformNode({
          id: "A",
          inputSchema: z.any(),
          outputSchema: z.any(),
          deps: [],
          transform: (_i) => { log.push("A"); return ok(42); },
        }),
        createTransformNode({
          id: "B",
          inputSchema: z.any(),
          outputSchema: z.any(),
          deps: ["A"],
          transform: (i) => { log.push("B"); return ok(i); },
        }),
      ],
      edges: [{ from: "A", to: "B" }],
    };
    // A is in checkpoint, B is not — legacy path skips A and runs B
    const checkpoint = new Map<string, unknown>([["A", 10]]);
    const result = await runDag(dag, {}, mkCtx(), {
      resume: { runId: "r2", checkpoint },
    });
    expect(result.ok).toBe(true);
    // Only B ran (legacy resume semantics)
    expect(log).toEqual(["B"]);
  });

  it("onBackground-only routes to legacy path", async () => {
    let backgroundCalled = false;
    const dag = mkSimpleDag("onbg");
    const result = await runDag(dag, { value: 1 }, mkCtx(), {
      onBackground: (_p) => { backgroundCalled = true; },
    });
    expect(result.ok).toBe(true);
    // onBackground is a legacy-path feature and must have been invoked
    expect(backgroundCalled).toBe(true);
  });

  // Shared: a DAG with a single humanReview node, used to exercise the new
  // node-config-driven routing and validation rules.
  const mkHitlDag = (id: string): DagDef => ({
    id,
    nodes: [{
      id: "reviewed",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      deps: [],
      run: async (_input, _ctx) => ok({ result: "needs-review" }),
      humanReview: { prompt: "Please review" },
    }] as readonly NodeDef<unknown, unknown, unknown>[],
    edges: [],
  });

  const noopReview = async (_req: { nodeId: string; output: unknown; prompt: string }): Promise<HumanAction> =>
    ({ action: "approve" });

  it("DAG with humanReview node + onHumanReview hook routes through state-machine path", async () => {
    const dag = mkHitlDag("hitl-dag");

    let hookCalled = false;
    const onHumanReview = async (_req: {
      nodeId: string;
      output: unknown;
      prompt: string;
    }): Promise<HumanAction> => {
      hookCalled = true;
      return { action: "approve" };
    };

    const result = await runDag(dag, {}, mkCtx(), { onHumanReview });
    expect(result.ok).toBe(true);
    expect(hookCalled).toBe(true);
  });

  it("DAG with humanReview node but no onHumanReview hook returns validation error", async () => {
    const dag = mkHitlDag("hitl-no-hook");
    const result = await runDag(dag, {}, mkCtx(), {});
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("__executor__");
      expect(result.error.message).toContain("declares humanReview");
      expect(result.error.message).toContain("reviewed");
    } else {
      throw new Error("expected node-crash error");
    }
  });

  it("onHumanReview hook supplied but no node declares humanReview returns validation error", async () => {
    const dag = mkSimpleDag("hook-without-node");
    const result = await runDag(dag, {}, mkCtx(), { onHumanReview: noopReview });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("__executor__");
      expect(result.error.message).toContain("no node declares");
    } else {
      throw new Error("expected node-crash error");
    }
  });

  it("resume + humanReview node returns err(node-crash) with incompatibility message", async () => {
    const dag = mkHitlDag("resume-hr");
    const result = await runDag(dag, {}, mkCtx(), {
      resume: { runId: "r1", checkpoint: new Map() },
      onHumanReview: noopReview,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("__executor__");
      expect(result.error.message).toContain("incompatible");
    } else {
      throw new Error("expected node-crash error");
    }
  });

  it("resume + retryLimits returns err(node-crash) with incompatibility message", async () => {
    const dag = mkSimpleDag("resume-rl");
    const result = await runDag(dag, {}, mkCtx(), {
      resume: { runId: "r1", checkpoint: new Map() },
      retryLimits: { A: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "node-crash") {
      expect(result.error.nodeId).toBe("__executor__");
      expect(result.error.message).toContain("incompatible");
    } else {
      throw new Error("expected node-crash error");
    }
  });

  it("onBackground on state-machine path: caller resolves before background promise; promise resolves later", async () => {
    // codex finding #3: SM path now supports onBackground for parity with the
    // legacy fast path. Caller-bound timeouts (HTTP request signal) no longer
    // block on judges + span finalization.
    const dag = mkSimpleDag("onbg-jl");
    let bgCaptured: Promise<void> | undefined;
    const result = await runDag(dag, {}, mkCtx(), {
      onBackground: (p) => { bgCaptured = p; },
      retryLimits: { A: 2 }, // routes to SM path
    });
    expect(result.ok).toBe(true);
    expect(bgCaptured).toBeDefined();
    await bgCaptured; // resolves cleanly
  });

  it("DagDef.defaultRetryLimit routes to state-machine path even without opts.retryLimits", async () => {
    let callCount = 0;
    const flakyNode: NodeDef<unknown, unknown, unknown> = {
      id: "flaky",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      deps: [],
      run: async (_input, _ctx) => {
        callCount += 1;
        if (callCount < 2) {
          return err({ kind: "node-crash" as const, nodeId: "flaky", message: "transient" });
        }
        return ok("ok");
      },
      retry: { backoffMs: [1] },
    };
    const dag: DagDef = {
      id: "default-retry-dag",
      nodes: [flakyNode],
      edges: [],
      defaultRetryLimit: 2,
    };
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it("DagDef.retryLimits routes to state-machine path even without opts.retryLimits", async () => {
    let callCount = 0;
    const flakyNode: NodeDef<unknown, unknown, unknown> = {
      id: "flaky",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      deps: [],
      run: async (_input, _ctx) => {
        callCount += 1;
        if (callCount < 2) {
          return err({ kind: "node-crash" as const, nodeId: "flaky", message: "transient" });
        }
        return ok("ok");
      },
      retry: { backoffMs: [1] },
    };
    const dag: DagDef = {
      id: "retry-limits-dag",
      nodes: [flakyNode],
      edges: [],
      retryLimits: { flaky: 2 },
    };
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it("DagDef.retryLimits = {} (empty) does NOT route to state-machine path", async () => {
    // Empty retryLimits is meaningless; should stay on legacy fast path.
    let callCount = 0;
    const flakyNode: NodeDef<unknown, unknown, unknown> = {
      id: "flaky",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      deps: [],
      run: async (_input, _ctx) => {
        callCount += 1;
        return err({ kind: "node-crash" as const, nodeId: "flaky", message: "fail" });
      },
    };
    const dag: DagDef = {
      id: "empty-retry-limits-dag",
      nodes: [flakyNode],
      edges: [],
      retryLimits: {},
    };
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    // Legacy path = single attempt, no retry
    expect(callCount).toBe(1);
  });

  it("retryLimits triggers state-machine path and is forwarded — node retries on failure", async () => {
    let callCount = 0;
    const flakyNode: NodeDef<unknown, unknown, unknown> = {
      id: "flaky",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      deps: [],
      run: async (_input, _ctx) => {
        callCount += 1;
        if (callCount < 3) {
          return err({ kind: "node-crash" as const, nodeId: "flaky", message: "transient failure" });
        }
        return ok("recovered");
      },
      retry: { backoffMs: [1, 1, 1] },
    };
    const dag: DagDef = {
      id: "retry-dag",
      nodes: [flakyNode],
      edges: [],
    };

    const result = await runDag(dag, {}, mkCtx(), {
      retryLimits: { flaky: 3 },
    });
    // Should succeed after retries
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("recovered");
    }
    // Called 3 times: 1 initial + 2 retries
    expect(callCount).toBe(3);
  });
});
