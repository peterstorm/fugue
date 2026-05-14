// Phase 4 — HumanInterventionEvent tests
// Verifies that `HumanInterventionEvent` is emitted via the observer for each
// human-action variant, with correct fields (actor, action, context, elapsedMs).

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { N, R, D, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { RecordingObserver } from "../observer/observer.js";
import { ok } from "../types/result.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import { defineDag } from "../executor/define-dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { HumanInterventionEvent } from "../types/events.js";
import type { HumanAction } from "../dag-runtime/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform" as const,
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async (input: unknown) => ok(input),
  requires: [] as const,
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
  ...overrides,
});

const makeDag = (nodeOverrides?: Partial<NodeDef<unknown, unknown>>) =>
  defineDag({
    id: "test-human",
    nodes: {
      review: makeNode("review", {
        humanReview: { prompt: "Approve this?" },
        ...nodeOverrides,
      }),
      final: makeNode("final"),
    },
    edges: [{ from: "review", to: "final" }],
  });

const makeCtx = (observer: RecordingObserver): NodeContext =>
  makeNodeContext({
    runId: R("run-1"),
    dagId: D("test-human"),
    observer,
  });

const findInterventionEvent = (
  events: readonly unknown[],
): HumanInterventionEvent | undefined =>
  (events as any[]).find(
    (e) => e.type === "human-intervention",
  ) as HumanInterventionEvent | undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 4 — HumanInterventionEvent", () => {
  test("approve emits human-intervention with kind=approve and actor=unknown", async () => {
    const dag = makeDag();
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.type).toBe("human-intervention");
    expect(evt!.action.kind).toBe("approve");
    expect(evt!.actor).toBe("unknown");
    expect(evt!.nodeId).toBe(N("review"));
    expect(evt!.runId).toBe(R("run-1"));
    expect(evt!.dagId).toBe(D("test-human"));
  });

  test("approve with actor populates actor field", async () => {
    const dag = makeDag();
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const, actor: "alice" }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.actor).toBe("alice");
  });

  test("approve-with-edit captures originalOutput, replacedOutput, and diff", async () => {
    const dag = defineDag({
      id: "test-human",
      nodes: {
        review: makeNode("review", {
          humanReview: { prompt: "Approve this?" },
          run: async () => ok({ data: "original" }),
        }),
        final: makeNode("final"),
      },
      edges: [{ from: "review", to: "final" }],
    });
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, null, ctx, {
      onHumanReview: async () => ({
        action: "approve-with-edit" as const,
        newOutput: { data: "edited" },
      }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.action.kind).toBe("approve-with-edit");
    if (evt!.action.kind === "approve-with-edit") {
      expect(evt!.action.originalOutput).toEqual({ data: "original" });
      expect(evt!.action.replacedOutput).toEqual({ data: "edited" });
      expect(evt!.action.diff.length).toBeGreaterThan(0);
      // diff should contain a replace op for /data
      expect(evt!.action.diff).toContainEqual({
        op: "replace",
        path: "/data",
        value: "edited",
      });
    }
  });

  test("reject captures reason", async () => {
    const dag = makeDag();
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({
        action: "reject" as const,
        reason: "bad output",
      }),
    });

    // Reject causes a failed run
    expect(result.ok).toBe(false);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.action.kind).toBe("reject");
    if (evt!.action.kind === "reject") {
      expect(evt!.action.reason).toBe("bad output");
    }
  });

  test("reroute captures targetNodeId", async () => {
    const dag = defineDag({
      id: "test-human",
      nodes: {
        a: makeNode("a"),
        review: makeNode("review", {
          humanReview: { prompt: "Approve this?" },
        }),
      },
      edges: [{ from: "a", to: "review" }],
      outputNodeId: "review",
    });
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    let callCount = 0;
    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async (): Promise<HumanAction> => {
        callCount++;
        if (callCount === 1) {
          return { action: "reroute", targetNodeId: N("a") };
        }
        return { action: "approve" };
      },
    });

    expect(result.ok).toBe(true);
    // Should have two intervention events: reroute then approve
    const interventions = observer.events.filter(
      (e) => e.type === "human-intervention",
    ) as HumanInterventionEvent[];
    expect(interventions.length).toBe(2);
    const rerouteEvt = interventions[0]!;
    expect(rerouteEvt.action.kind).toBe("reroute");
    if (rerouteEvt.action.kind === "reroute") {
      expect(rerouteEvt.action.targetNodeId).toBe(N("a"));
    }
  });

  test("context.nodeSideEffects reflects node declaration", async () => {
    const dag = makeDag({
      sideEffects: { kind: "writes", resource: "postgres:orders" },
    });
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.context.nodeSideEffects).toBe("writes");
  });

  test("context.nodeConfidence is populated when node has confidence mode=value", async () => {
    const dag = makeDag({
      confidence: {
        mode: "value" as const,
        extract: () => ({ bucket: "high" as const, source: "heuristic" as const }),
      },
    });
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.context.nodeConfidence).toEqual({
      bucket: "high",
      source: "heuristic",
    });
  });

  test("context.nodeConfidence is null when node has confidence mode=none", async () => {
    const dag = makeDag(); // default: NO_CONFIDENCE = { mode: "none" }
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.context.nodeConfidence).toBeNull();
  });

  test("elapsedMsSinceAwait is a non-negative number", async () => {
    const dag = makeDag();
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(typeof evt!.elapsedMsSinceAwait).toBe("number");
    expect(evt!.elapsedMsSinceAwait).toBeGreaterThanOrEqual(0);
  });

  test("timestamp is a Date instance", async () => {
    const dag = makeDag();
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.timestamp).toBeInstanceOf(Date);
  });

  test("I8: priorWitnesses context contains witnesses from earlier waves", async () => {
    const dag = defineDag({
      id: "test-witnesses",
      nodes: {
        reader: makeNode("reader", {
          sideEffects: { kind: "reads", resource: "postgres:orders" },
          extractWitness: (output: unknown) => ({
            kind: "version" as const,
            resource: "postgres:orders",
            value: String((output as { version: number }).version),
          }),
          run: async () => ok({ version: 42 }),
        }),
        review: makeNode("review", {
          humanReview: { prompt: "Approve?" },
        }),
      },
      edges: [{ from: "reader", to: "review" }],
    });
    const observer = new RecordingObserver();
    const ctx = makeNodeContext({
      runId: R("run-1"),
      dagId: D("test-witnesses"),
      observer,
    });

    const result = await runDagStateful(dag, null, ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.context.priorWitnesses).toContainEqual({
      kind: "version",
      resource: "postgres:orders",
      value: "42",
    });
  });

  test("I9: retrying-hook path emits HumanInterventionEvent", async () => {
    const dag = defineDag({
      id: "test-hook-retry",
      nodes: {
        review: makeNode("review", {
          humanReview: { prompt: "Approve this?" },
        }),
        final: makeNode("final"),
      },
      edges: [{ from: "review", to: "final" }],
    });
    const observer = new RecordingObserver();
    const ctx = makeNodeContext({
      runId: R("run-1"),
      dagId: D("test-hook-retry"),
      observer,
    });

    let hookCallCount = 0;
    const onHumanReview = async () => {
      hookCallCount++;
      if (hookCallCount === 1) throw new Error("hook crash");
      return { action: "approve" as const, actor: "bob" };
    };

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview,
      retryLimits: { review: 3 },
      random: () => 0, // eliminate jitter delay
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.actor).toBe("bob");
  });

  test("S15: confidence extraction failure emits event with null confidence", async () => {
    const dag = makeDag({
      confidence: {
        mode: "value" as const,
        extract: () => {
          throw new Error("extract boom");
        },
      },
    });
    const observer = new RecordingObserver();
    const ctx = makeCtx(observer);

    const result = await runDagStateful(dag, "hello", ctx, {
      onHumanReview: async () => ({ action: "approve" as const }),
    });

    expect(result.ok).toBe(true);
    const evt = findInterventionEvent(observer.events);
    expect(evt).toBeDefined();
    expect(evt!.context.nodeConfidence).toBeNull();
  });
});
