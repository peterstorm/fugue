import { describe, expect, it } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { z } from "zod";
import { ok, err } from "../types/result.js";
import type { NodeContext, NodeDef } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import type { HumanAction } from "../dag-runtime/types.js";
import { runDag } from "../executor/run-dag.js";
import { topoSort } from "../shared/topo.js";
import { createTransformNode } from "../nodes/transform.js";
import { RecordingObserver, NoopObserver } from "../observer/observer.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { N } from "./_id-helpers.js";

const mkCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null,
  clock: null,
  logger: { warn: () => {}, error: () => {} },
  ...overrides,
});

/**
 * A node that fails `failuresBeforeSuccess` times with a RETRIABLE crash and
 * then succeeds. Four retry tests hand-rolled a 15–25 line `NodeDef` that
 * differed only in the failure count, message, output and backoff — so the
 * retriability that makes the test meaningful was restated four times and could
 * drift in one of them.
 */
const makeFlakyNode = (opts: {
  readonly failuresBeforeSuccess: number;
  readonly message: string;
  readonly output: unknown;
  readonly backoffMs?: readonly [number, ...number[]];
  readonly onRun: () => void;
}): NodeDef<unknown, unknown> => {
  let attempts = 0;
  return {
    id: N("flaky"),
    kind: "transform",
    inputSchema: z.any(),
    outputSchema: z.any(),
    requires: [],
    sideEffects: { kind: "none" },
    confidence: { mode: "none" },
    run: async () => {
      opts.onRun();
      attempts += 1;
      return attempts <= opts.failuresBeforeSuccess
        ? err({ kind: "node-crash" as const, nodeId: "flaky" as NodeId, retriability: "retriable" as const, message: opts.message })
        : ok(opts.output);
    },
    ...(opts.backoffMs ? { retry: { backoffMs: opts.backoffMs } } : {}),
  };
};

describe("topoSort", () => {
  it("sorts linear DAG into sequential waves", () => {
    const dag = defineDagFromArray({
      id: "linear",
      nodes: [
        createTransformNode({ id: N("A"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
        createTransformNode({ id: N("B"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
        createTransformNode({ id: N("C"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
      ],
      edges: [
        { from: DAG_INPUT, to: "A" },
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    });
    const result = topoSort(dag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // @ts-expect-error — branded ID test fixture
      expect(result.value).toEqual([["A"], ["B"], ["C"]]);
    }
  });

  it("parallel DAG has A and B in same wave", () => {
    const dag = defineDagFromArray({
      id: "parallel",
      nodes: [
        createTransformNode({ id: N("A"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
        createTransformNode({ id: N("B"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
        createTransformNode({ id: N("C"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
      ],
      edges: [
        { from: DAG_INPUT, to: "A" },
        { from: DAG_INPUT, to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "C" },
      ],
    });
    const result = topoSort(dag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0].sort()).toEqual([N("A"), N("B")]);
      expect(result.value[1]).toEqual([N("C")]);
    }
  });

  it("detects cycles", () => {
    const dag = defineDagFromArray({
      id: "cycle",
      nodes: [
        createTransformNode({ id: N("A"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
        createTransformNode({ id: N("B"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    });
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
    const dag = defineDagFromArray({
      id: "linear",
      nodes: ([
        createTransformNode({
          id: N("A"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => { log.push("A"); return ok({ value: i.value + 1 }); },
        }),
        createTransformNode({
          id: N("B"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => { log.push("B"); return ok({ value: i.value * 2 }); },
        }),
        createTransformNode({
          id: N("C"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => { log.push("C"); return ok({ value: i.value + 10 }); },
        }),
      ]),
      edges: [
        { from: DAG_INPUT, to: "A" },
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    });

    const result = await runDag(dag, { value: 1 }, mkCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: 14 }); // (1+1)*2+10
    }
    expect(log).toEqual(["A", "B", "C"]);
  });

  it("input validation failure returns Err(validation)", async () => {
    const dag = defineDagFromArray({
      id: "val",
      nodes: ([
        createTransformNode({
          id: N("A"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.any(),
          transform: (i) => ok(i),
        }),
      ]),
      edges: [{ from: DAG_INPUT, to: "A" }],
    });
    const result = await runDag(dag, { value: "not a number" }, mkCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("output validation failure returns Err(validation)", async () => {
    const dag = defineDagFromArray({
      id: "val",
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.any(),
          outputSchema: z.object({ value: z.number() }),
          transform: (_i) => ok({ value: "wrong" } as any),
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "A" }],
    });
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
    }
  });

  it("node returning Err stops execution", async () => {
    const log: string[] = [];
    const dag = defineDagFromArray({
      id: "err",
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (_i) => { log.push("A"); return err({ kind: "node-crash" as const, nodeId: "A" as NodeId, retriability: "retriable" as const, message: "boom" }); },
        }),
        createTransformNode({
          id: N("B"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (i) => { log.push("B"); return ok(i); },
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    });
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    expect(log).toEqual(["A"]);
  });

  it("resume skips checkpointed nodes and re-runs failed node", async () => {
    const log: string[] = [];

    const dag = defineDagFromArray({
      id: "resume-test",
      nodes: ([
        createTransformNode({
          id: N("A"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => { log.push("A"); return ok({ value: i.value + 1 }); },
        }),
        createTransformNode({
          id: N("B"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => { log.push("B"); return ok({ value: i.value * 2 }); },
        }),
        createTransformNode({
          id: N("C"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => { log.push("C"); return ok({ value: i.value + 10 }); },
        }),
      ]),
      edges: [
        { from: DAG_INPUT, to: "A" },
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    });

    // Simulate: A and B completed, C failed. Resume with checkpoint for A and B.
    const checkpoint = new Map<string, unknown>([
      ["A", { value: 2 }],
      ["B", { value: 4 }],
    ]);

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "resume-run-1" as RunId, dagId: "resume-test" as DagId });

    const result = await runDag(dag, undefined, ctx, {
      resume: { runId: "resume-run-1" as RunId, checkpoint },
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

    const dag = defineDagFromArray({
      id: "schema-evolved",
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.unknown(),
          // Current schema requires `value: number` AND a new field `version: 2`.
          outputSchema: z.object({ value: z.number(), version: z.literal(2) }),
          transform: () => { log.push("A"); return ok({ value: 1, version: 2 as const }); },
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "A" }],
    });

    // Old checkpoint persisted under previous schema (no `version` field).
    const stale = new Map<string, unknown>([["A", { value: 99 }]]);

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "stale-run" as RunId, dagId: "schema-evolved" as DagId });

    const result = await runDag(dag, undefined, ctx, {
      resume: { runId: "stale-run" as RunId, checkpoint: stale },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      if (result.error.kind === "validation") {
        expect(result.error.nodeId).toBe(N("A"));
      }
    }
    // Stale value must NOT be silently passed through.
    expect(log).toEqual([]);

    const errs = observer.events.filter((e) => e.type === "node-error");
    expect(errs.length).toBe(1);
    expect((errs[0] as any).nodeId).toBe("A");
  });

  it("observability: full run emits correct event sequence", async () => {
    const dag = defineDagFromArray({
      id: "obs-test",
      nodes: ([
        createTransformNode({
          id: N("A"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => ok({ value: i.value + 1 }),
        }),
        createTransformNode({
          id: N("B"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => ok({ value: i.value * 2 }),
        }),
      ]),
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    });

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "obs-run-1" as RunId, dagId: "obs-test" as DagId });

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
    const dag = defineDagFromArray({
      id: "err-obs",
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (_i) => ok({ v: 1 }),
        }),
        createTransformNode({
          id: N("B"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (_i) => err({ kind: "node-crash" as const, nodeId: "B" as NodeId, retriability: "retriable" as const, message: "boom" }),
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    });

    const observer = new RecordingObserver();
    const ctx = mkCtx({ observer, runId: "err-run" as RunId, dagId: "err-obs" as DagId });
    const result = await runDag(dag, {}, ctx);
    expect(result.ok).toBe(false);

    const runEnd = observer.events.find((e) => e.type === "run-end");
    expect(runEnd).toBeDefined();
    expect((runEnd as any)!.status).toBe("error");
  });

  it("checkpointer: writeCheckpoint called for each successful node", async () => {
    const checkpoints: Array<{ runId: string; nodeId: string; output: unknown }> = [];
    const dag = defineDagFromArray({
      id: "ckpt-test",
      nodes: ([
        createTransformNode({
          id: N("A"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => ok({ value: i.value + 1 }),
        }),
        createTransformNode({
          id: N("B"),
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          transform: (i: { value: number }) => ok({ value: i.value * 2 }),
        }),
      ]),
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    });

    const cache = {
      get: async () => ({ hit: false } as const),
      set: async () => ok(undefined),
    };
    const checkpointWriter = {
      write: async (runId: string, nodeId: string, output: unknown) => {
        checkpoints.push({ runId, nodeId, output });
      },
    };
    const ctx = mkCtx({ cache, checkpointWriter, runId: "ckpt-run" as RunId });
    const result = await runDag(dag, { value: 1 }, ctx);
    expect(result.ok).toBe(true);

    expect(checkpoints).toEqual([
      { runId: "ckpt-run" as RunId, nodeId: "A" as NodeId, output: { value: 2 } },
      { runId: "ckpt-run" as RunId, nodeId: "B" as NodeId, output: { value: 4 } },
    ]);
  });

  it("cycle detection returns Err(cycle-detected)", async () => {
    const dag = defineDagFromArray({
      id: "cycle",
      nodes: [
        createTransformNode({ id: N("A"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
        createTransformNode({ id: N("B"), inputSchema: z.any(), outputSchema: z.any(), transform: (i) => ok(i) }),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    });
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cycle-detected");
    }
  });

  it("guardrail node in DAG passes data through with warnings to downstream nodes", async () => {
    const { createGuardrailNode } = await import("../nodes/guardrail.js");

    const guardrail = createGuardrailNode({
      id: N("guard"),
      inputSchema: z.any(),
      outputSchema: z.any(),
      validate: (input: unknown) => ({
        kind: "validated" as const,
        value: input,
        passed: false,
        warnings: ["test warning"],
        checks: [{ dimension: "test", passed: false, detail: "failed check" }],
      }),
    });

    const dag = defineDagFromArray({
      id: "guardrail-test",
      nodes: [
        createTransformNode({ id: N("source"), inputSchema: z.any(), outputSchema: z.any(), transform: () => ok({ data: 42 }) }),
        guardrail,
        createTransformNode({
          id: N("consumer"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (input: unknown) => ok({ received: (input as { passed: boolean; value: unknown }).passed, value: (input as { passed: boolean; value: unknown }).value }),
        }),
      ],
      edges: [
        { from: DAG_INPUT, to: "source" },
        { from: "source", to: "guard" },
        { from: "guard", to: "consumer" },
      ],
    });

    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as any).received).toBe(false);
      expect((result.value as any).value).toEqual({ data: 42 });
    }
  });

  // Wave 2 §2.4: checkpoint write failures must NOT be silently swallowed.
  // Previously the failure was warn-and-continue; on the next crash-resume the
  // node would re-execute, breaking the idempotency contract the checkpoint is
  // supposed to provide. Now the legacy path surfaces err(checkpoint-write-failed).
  it("checkpoint write failure surfaces as err(checkpoint-write-failed)", async () => {
    const failingCheckpointWriter = {
      write: async () => { throw new Error("Redis timeout"); },
    };
    const dag = defineDagFromArray({
      id: "checkpoint-fail",
      nodes: [
        createTransformNode({ id: N("A"), inputSchema: z.any(), outputSchema: z.any(), transform: () => ok(42) }),
      ],
      edges: [{ from: DAG_INPUT, to: "A" }],
    });
    const result = await runDag(dag, {}, mkCtx({ checkpointWriter: failingCheckpointWriter }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind === "checkpoint-write-failed") {
        expect(result.error.nodeId).toBe(N("A"));
        expect(result.error.message).toContain("Redis timeout");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// runDag routing (Wave 7 §7.3 — single-path runtime)
//
// Pre-§7.3 these tests asserted incompatibility between `resume` and the
// state-machine path. Post-§7.3 there is only one path: every runDag call
// flows through runDagStateful. `resume` is a checkpoint replay layered on
// top of any other opt; the previous "incompatible" errors are gone by
// design (ADR-0021).
// ---------------------------------------------------------------------------

describe("runDag routing (single-path — Wave 7 §7.3)", () => {
  const mkSimpleDag = (id = "simple"): DagDef =>
    defineDagFromArray({
      id,
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (i) => ok(i),
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "A" }],
    });

  it("resume replays checkpoint values: A is skipped, B runs", async () => {
    const log: string[] = [];
    const dag = defineDagFromArray({
      id: "resume-only",
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (_i) => { log.push("A"); return ok(42); },
        }),
        createTransformNode({
          id: N("B"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (i) => { log.push("B"); return ok(i); },
        }),
      ],
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    });
    const checkpoint = new Map<string, unknown>([["A", 10]]);
    const result = await runDag(dag, {}, mkCtx(), {
      resume: { runId: "r2" as RunId, checkpoint },
    });
    expect(result.ok).toBe(true);
    expect(log).toEqual(["B"]);
  });

  it("onBackground is supported (ADR-0018, single-path runtime)", async () => {
    let backgroundCalled = false;
    const dag = mkSimpleDag("onbg");
    const result = await runDag(dag, { value: 1 }, mkCtx(), {
      onBackground: (_p) => { backgroundCalled = true; },
    });
    expect(result.ok).toBe(true);
    expect(backgroundCalled).toBe(true);
  });

  // Shared: a DAG with a single humanReview node, used to exercise the new
  // node-config-driven routing and validation rules.
  const mkHitlDag = (id: string): DagDef =>
    defineDagFromArray({
      id,
      nodes: [
        // @ts-expect-error — branded ID test fixture
        {
          id: "reviewed",
          kind: "transform",
          inputSchema: z.any(),
          outputSchema: z.any(),
          requires: [],
      sideEffects: { kind: "none" },
  confidence: { mode: "none" },
          run: async (_input, _ctx) => ok({ result: "needs-review" }),
          humanReview: { prompt: "Please review" },
        } as NodeDef<unknown, unknown>,
      ],
      edges: [{ from: DAG_INPUT, to: "reviewed" }],
    });

  const noopReview = async (_req: { nodeId: string; output: unknown; prompt: string }): Promise<HumanAction> =>
    ({ kind: "approve" });

  it("DAG with humanReview node + onHumanReview hook routes through state-machine path", async () => {
    const dag = mkHitlDag("hitl-dag");

    let hookCalled = false;
    const onHumanReview = async (_req: {
      nodeId: string;
      output: unknown;
      prompt: string;
    }): Promise<HumanAction> => {
      hookCalled = true;
      return { kind: "approve" };
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
      expect(result.error.nodeId).toBe(N("__executor__"));
      expect(result.error.message).toContain("declares humanReview");
      expect(result.error.message).toContain("reviewed");
    } else {
      throw new Error("expected node-crash error");
    }
  });

  it("onHumanReview hook supplied but no node declares humanReview succeeds (hook ignored)", async () => {
    const dag = mkSimpleDag("hook-without-node");
    const result = await runDag(dag, {}, mkCtx(), { onHumanReview: noopReview });
    expect(result.ok).toBe(true);
  });

  it("resume + humanReview compose: A's checkpoint replays, reviewed node still gates", async () => {
    const log: string[] = [];
    const dag = defineDagFromArray({
      id: "resume-hr",
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (_i) => { log.push("A"); return ok(1); },
        }),
        // @ts-expect-error — branded ID test fixture
        {
          id: "reviewed",
          kind: "transform",
          inputSchema: z.any(),
          outputSchema: z.any(),
          requires: [],
      sideEffects: { kind: "none" },
  confidence: { mode: "none" },
          run: async (_input, _ctx) => { log.push("reviewed"); return ok({ result: "needs-review" }); },
          humanReview: { prompt: "Please review" },
        } as NodeDef<unknown, unknown>,
      ],
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "reviewed" }],
    });
    const checkpoint = new Map<string, unknown>([["A", 99]]);
    const result = await runDag(dag, {}, mkCtx(), {
      resume: { runId: "r1" as RunId, checkpoint },
      onHumanReview: noopReview,
    });
    expect(result.ok).toBe(true);
    expect(log).toEqual(["reviewed"]); // A skipped via checkpoint
  });

  it("resume + retryLimits compose: checkpoint replay applies alongside per-call retry overrides", async () => {
    let attempts = 0;
    const dag = defineDagFromArray({
      id: "resume-rl",
      nodes: [
        createTransformNode({
          id: N("A"),
          inputSchema: z.any(),
          outputSchema: z.any(),
          transform: (_i) => ok("A"),
        }),
        // @ts-expect-error — branded ID test fixture
        {
          id: "flaky",
          kind: "transform",
          inputSchema: z.any(),
          outputSchema: z.any(),
          requires: [],
      sideEffects: { kind: "none" },
  confidence: { mode: "none" },
          run: async () => {
            attempts += 1;
            if (attempts < 2) {
              return err({ kind: "node-crash" as const, nodeId: "flaky" as NodeId, retriability: "retriable" as const, message: "transient" });
            }
            return ok("done");
          },
          retry: { backoffMs: [1] },
        } as NodeDef<unknown, unknown>,
      ],
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "flaky" }],
    });
    const checkpoint = new Map<string, unknown>([["A", "cached-A"]]);
    const result = await runDag(dag, {}, mkCtx(), {
      resume: { runId: "r1" as RunId, checkpoint },
      retryLimits: { flaky: 2 },
    });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2); // flaky retried once
  });

  it("onBackground on state-machine path: caller resolves before background promise; promise resolves later", async () => {
    // codex finding #3: SM path now supports onBackground for parity with the
    // legacy fast path. Caller-bound timeouts (HTTP request signal) no longer
    // block on judges + span finalization.
    const dag = mkSimpleDag("onbg-jl");
    let bgCaptured: Promise<any> | undefined;
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
    const flakyNode = makeFlakyNode({
      failuresBeforeSuccess: 1,
      message: "transient",
      output: "ok",
      backoffMs: [1],
      onRun: () => { callCount += 1; },
    });
    const dag = defineDagFromArray({
      id: "default-retry-dag",
      nodes: [flakyNode],
      edges: [{ from: DAG_INPUT, to: "flaky" }],
      defaultRetryLimit: 2,
    });
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it("DagDef.retryLimits routes to state-machine path even without opts.retryLimits", async () => {
    let callCount = 0;
    const flakyNode = makeFlakyNode({
      failuresBeforeSuccess: 1,
      message: "transient",
      output: "ok",
      backoffMs: [1],
      onRun: () => { callCount += 1; },
    });
    const dag = defineDagFromArray({
      id: "retry-limits-dag",
      nodes: [flakyNode],
      edges: [{ from: DAG_INPUT, to: "flaky" }],
      retryLimits: { flaky: 2 },
    });
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it("DagDef.retryLimits = {} (empty) does NOT route to state-machine path", async () => {
    // Empty retryLimits is meaningless; should stay on legacy fast path.
    let callCount = 0;
    // Never succeeds, and declares no retry config of its own.
    const flakyNode = makeFlakyNode({
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      message: "fail",
      output: null,
      onRun: () => { callCount += 1; },
    });
    const dag = defineDagFromArray({
      id: "empty-retry-limits-dag",
      nodes: [flakyNode],
      edges: [{ from: DAG_INPUT, to: "flaky" }],
      retryLimits: {},
    });
    const result = await runDag(dag, {}, mkCtx());
    expect(result.ok).toBe(false);
    // Legacy path = single attempt, no retry
    expect(callCount).toBe(1);
  });

  it("retryLimits triggers state-machine path and is forwarded — node retries on failure", async () => {
    let callCount = 0;
    const flakyNode = makeFlakyNode({
      failuresBeforeSuccess: 2,
      message: "transient failure",
      output: "recovered",
      backoffMs: [1, 1, 1],
      onRun: () => { callCount += 1; },
    });
    const dag = defineDagFromArray({
      id: "retry-dag",
      nodes: [flakyNode],
      edges: [{ from: DAG_INPUT, to: "flaky" }],
    });

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
