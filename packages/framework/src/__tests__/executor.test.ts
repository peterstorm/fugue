import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { NodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
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
