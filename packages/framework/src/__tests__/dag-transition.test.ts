// dag-transition.test.ts — SC-002 (>=95% transition coverage)
// Tests: retry within/at/over limit, sequential HITL by node-id (FR-028),
//        approve / approve-with-edit / reject / reroute-back / reroute-forward-invalid / abort

import { describe, it, expect } from "bun:test";
import type { NodeId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { N, NO_SIDE_EFFECTS, NO_CONFIDENCE } from "./_id-helpers.js";
import { FE, RN, witness } from "./_freshness-helpers.js";
import { dagTransition } from "../dag-runtime/transition.js";
import { computeOutgoingByNode, computeUnconditionalAdj } from "../dag-runtime/topology.js";
import {
  handleWaveDone,
  advanceToNextWave,
  collectHumanReviewQueue,
  waveNodes,
  waveIndexOf,
} from "../dag-runtime/wave-resolution.js";
import { handleNodeFailed, computeBackoffMs, getRetryLimit } from "../dag-runtime/retry-policy.js";
import type { RetryConfigs } from "../dag-runtime/retry-policy.js";
import { handleHumanResponse } from "../dag-runtime/human-resolution.js";
import type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted, HumanAction } from "../dag-runtime/types.js";
import type { DagDef, EdgeDefRawInput } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import { type NodeOverride, brandedOverride } from "./_node-override.js";
import type { FrameworkError } from "../types/errors.js";
import { defineDag, defineDagFromArray } from "../executor/define-dag.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const noop = async () => ({ ok: true as const, value: undefined });

const makeNode = (
  id: string,
  overrides: NodeOverride = {},
): NodeDef<unknown, unknown> => ({
  id: N(id),
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  sideEffects: NO_SIDE_EFFECTS,
  confidence: NO_CONFIDENCE,
  ...brandedOverride(overrides),
});

interface MakeDagOverrides {
  readonly id?: string;
  readonly nodes?: readonly NodeDef<unknown, unknown>[];
  readonly edges?: readonly EdgeDefRawInput[];
  readonly outputNodeId?: string;
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
  readonly evalJudges?: DagDef["evalJudges"];
}

const DEFAULT_NODES: readonly NodeDef<unknown, unknown>[] = [
  makeNode("a"),
  makeNode("b"),
  makeNode("c"),
];
const DEFAULT_EDGES: readonly EdgeDefRawInput[] = [
  { from: DAG_INPUT, to: "a" },
  { from: "a", to: "b" },
  { from: "b", to: "c" },
];

const makeDag = (overrides: MakeDagOverrides = {}): DagDef => {
  // If a test overrides `nodes` but not `edges`, auto-inject $input edges for
  // every node in the custom set (0.2.0: roots must have an incoming edge).
  const nodes = overrides.nodes ?? DEFAULT_NODES;
  const rawEdges =
    overrides.edges !== undefined
      ? overrides.edges
      : overrides.nodes
        ? []
        : DEFAULT_EDGES;
  // Under 0.2.0 every root (node with no incoming edge from another node) must
  // have an explicit { from: DAG_INPUT, to: ... } edge. Auto-inject for any
  // root in the resolved edge set so individual tests don't need to repeat it.
  const toSet = new Set(rawEdges.map((e) => String(e.to)));
  const inputEdges = nodes
    .filter((n) => !toSet.has(String(n.id)))
    .map((n) => ({ from: DAG_INPUT as string, to: String(n.id) }));
  const edges = [...inputEdges, ...rawEdges];
  return defineDag({
    id: overrides.id ?? "test-dag",
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges,
    outputNodeId: overrides.outputNodeId,
    evalJudges: overrides.evalJudges,
    retryLimits: overrides.retryLimits,
    defaultRetryLimit: overrides.defaultRetryLimit,
  });
};

/** Build the retry policy projection used by runtime-context fixtures. */
const retryConfigsFrom = (dag: DagDef): RetryConfigs =>
  new Map(
    dag.nodes
      .filter((n) => n.retry)
      .map((n) => [n.id, { backoffMs: n.retry!.backoffMs ?? [1000, 2000, 4000], jitterRatio: n.retry!.jitterRatio ?? 0.2 }] as const),
  );

const makeCtx = (overrides: Partial<DagMachineContext> = {}): DagMachineContext => {
  const dag = overrides.dag ?? makeDag();
  return {
    dag,
    waves: [[N("a")], [N("b")], [N("c")]],
    outputs: new Map(),
    retries: new Map(),
    initialInput: null,
    activeNodeIds: new Set(dag.nodes.map((n) => n.id)),
    outgoingByNode: computeOutgoingByNode(dag),
    unconditionalAdj: computeUnconditionalAdj(dag),
    incomingByNode: new Map(),
    nodeById: new Map(dag.nodes.map((n) => [n.id, n])),
    retryConfigs: retryConfigsFrom(dag),
    outputNodeId: dag.outputNodeId,
    defaultRetryLimit: dag.defaultRetryLimit,
    retryLimits: dag.retryLimits,
    humanReviewNodeIds: new Set(dag.nodes.filter(n => n.humanReview !== undefined).map(n => n.id)),
    humanReviewPrompts: new Map(dag.nodes.filter(n => n.humanReview !== undefined).map(n => [n.id, n.humanReview!.prompt] as const)),
    edges: dag.edges,
    confidenceByNode: new Map(),
    ...overrides,
    priorWitnesses: overrides.priorWitnesses ?? new Map(),
    freshnessCompletedNodeIds: overrides.freshnessCompletedNodeIds ?? new Set(),
    freshnessExecutionEpoch: overrides.freshnessExecutionEpoch ?? FE(),
  };
};

const nodeFailedError: FrameworkError = {
  kind: "node-crash",
  retriability: "retriable",
  nodeId: "a" as NodeId,
  message: "boom",
};

const running = (wave: number): DagPhase => ({
  kind: "running",
  wave,
});

const awaitingHuman = (
  nodeId: string,
  pendingReviews: string[] = [],
  wave = 0,
): Extract<DagPhase, { kind: "awaiting-human" }> => ({
  kind: "awaiting-human",
  // @ts-expect-error — branded ID test fixture
  nodeId,
  output: { result: "some-output" },
  prompt: "Please review",
  // @ts-expect-error — branded ID test fixture
  pendingReviews,
  wave,
});

// ---------------------------------------------------------------------------
// dagTransition: pending
// ---------------------------------------------------------------------------

describe("dagTransition — pending", () => {
  it("start event => running wave 0", () => {
    const phase: DagPhase = { kind: "pending" };
    const event: DagEvent = { type: "start" };
    const ctx = makeCtx();
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toEqual({ kind: "running", wave: 0 });
    expect(result.context).toBe(ctx);
  });

  it("unexpected event in pending => stay pending", () => {
    const phase: DagPhase = { kind: "pending" };
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map(), routingDecisions: new Map() };
    const ctx = makeCtx();
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toEqual({ kind: "pending" });
  });
});

// ---------------------------------------------------------------------------
// dagTransition: abort from all non-terminal states (FR-033)
// ---------------------------------------------------------------------------

describe("dagTransition — abort (FR-033)", () => {
  const abortEvent: DagEvent = { type: "abort", reason: "user cancelled" };

  it("abort from pending => failed with aborted error", () => {
    const result = dagTransition({ kind: "pending" }, abortEvent, makeCtx());
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "aborted", reason: "user cancelled" } });
  });

  it("abort from running => failed with aborted error", () => {
    const result = dagTransition(running(1), abortEvent, makeCtx());
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "aborted", reason: "user cancelled" } });
  });

  it("abort from retrying => failed with aborted error", () => {
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a" as NodeId, attempt: 1, nextDelayMs: 1000 };
    const result = dagTransition(phase, abortEvent, makeCtx());
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "aborted" } });
  });

  it("abort from awaiting-human => failed with aborted error", () => {
    const result = dagTransition(awaitingHuman("a"), abortEvent, makeCtx());
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "aborted" } });
  });

  it("abort from succeeded => no-op (already terminal)", () => {
    const phase: DagPhase = { kind: "succeeded", output: "done" };
    const result = dagTransition(phase, abortEvent, makeCtx());
    expect(result.state).toEqual({ kind: "succeeded", output: "done" });
  });

  it("abort from failed => no-op (already terminal)", () => {
    const phase: DagPhase = { kind: "failed", error: nodeFailedError };
    const result = dagTransition(phase, abortEvent, makeCtx());
    expect(result.state.kind).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// dagTransition: running
// ---------------------------------------------------------------------------

describe("dagTransition — running", () => {
  it("wave-done without human-review nodes => advance to next wave", () => {
    const ctx = makeCtx();
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map([["a", 42]]) as any, routingDecisions: new Map() };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state).toEqual({ kind: "running", wave: 1 });
    expect(result.context.outputs.get(N("a"))).toBe(42);
  });

  it("folds the executor's latest-witness projection into durable context", () => {
    const ctx = makeCtx();
    const priorWitnesses = new Map([[
      "postgres:orders",
      witness("version", RN("postgres:orders"), "42"),
    ]]);
    const event: DagEvent = {
      type: "wave-done",
      wave: 0,
      outputs: new Map([[N("a"), 42]]),
      routingDecisions: new Map(),
      priorWitnesses,
    };

    const result = dagTransition(running(0), event, ctx);

    expect(result.context.priorWitnesses).not.toBe(priorWitnesses);
    expect(result.context.priorWitnesses.get("postgres:orders")).toEqual(
      witness("version", RN("postgres:orders"), "42"),
    );
  });

  it("folds freshness-completion proof into an immutable durable set", () => {
    const ctx = makeCtx({ freshnessCompletedNodeIds: new Set([N("a")]) });
    const freshnessCompletedNodeIds = new Set([N("a"), N("b")]);
    const event: DagEvent = {
      type: "wave-done",
      wave: 0,
      outputs: new Map([[N("a"), 42]]),
      routingDecisions: new Map(),
      freshnessCompletedNodeIds,
    };

    const result = dagTransition(running(0), event, ctx);

    expect(result.context.freshnessCompletedNodeIds).not.toBe(freshnessCompletedNodeIds);
    expect(result.context.freshnessCompletedNodeIds).toEqual(new Set([N("a"), N("b")]));
    expect(ctx.freshnessCompletedNodeIds).toEqual(new Set([N("a")]));
  });

  it("wave-done on last wave => succeeded", () => {
    const ctx = makeCtx();
    const event: DagEvent = { type: "wave-done", wave: 2, outputs: new Map([["c", "final"]]) as any, routingDecisions: new Map() };
    const result = dagTransition(running(2), event, ctx);
    expect(result.state).toMatchObject({ kind: "succeeded" });
  });

  it("wave-done — last wave uses outputNodeId when specified", () => {
    const dag = makeDag({ outputNodeId: "b" });
    const ctx = makeCtx({
      dag,
      waves: [[N("a")], [N("b")], [N("c")]],
      outputs: new Map([["b", "b-output"]]) as any,
    });
    const event: DagEvent = { type: "wave-done", wave: 2, outputs: new Map([["c", "c-output"]]) as any, routingDecisions: new Map() };
    const result = dagTransition(running(2), event, ctx);
    expect(result.state).toMatchObject({ kind: "succeeded", output: "b-output" });
  });

  it("node-failed within retry limit => retrying", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state.kind).toBe("retrying");
    if (result.state.kind === "retrying") {
      expect(result.state.nodeId).toBe(N("a"));
      expect(result.state.attempt).toBe(1);
    }
  });

  it("node-failed at retry limit (attempts == limit) => failed with retry-exhausted", () => {
    const dag = makeDag({ defaultRetryLimit: 1 });
    const ctx = makeCtx({
      dag,
      retries: new Map([["a", 1]]) as any, // already at limit
    });
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("node-failed over retry limit => failed with retry-exhausted", () => {
    const dag = makeDag({ defaultRetryLimit: 1 });
    const ctx = makeCtx({
      dag,
      retries: new Map([["a", 2]]) as any, // over limit
    });
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("node-failed with no retry limit (defaultRetryLimit=0) => immediately failed", () => {
    const ctx = makeCtx(); // no retryLimits, no defaultRetryLimit => 0
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state.kind).toBe("failed");
  });

  it("per-node retryLimit overrides default", () => {
    const dag = makeDag({ defaultRetryLimit: 0, retryLimits: { a: 3 } });
    const ctx = makeCtx({ dag });
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    // First failure: attempt 0 < limit 3, so should retry
    expect(result.state.kind).toBe("retrying");
  });

  it("ERROR event from running => failed (node-crash)", () => {
    const event: DagEvent = { type: "executor-error", retriable: true, error: "executor blew up" };
    const result = dagTransition(running(0), event, makeCtx());
    expect(result.state.kind).toBe("failed");
  });

  it("other events while running => no-op", () => {
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(running(0), event, makeCtx());
    expect(result.state).toEqual(running(0));
  });
});

// ---------------------------------------------------------------------------
// dagTransition: retrying
// ---------------------------------------------------------------------------

describe("dagTransition — retrying", () => {
  it("wave-done after retry => advance", () => {
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a" as NodeId, attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map([["a", "ok"]]) as any, routingDecisions: new Map() };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state.kind).toBe("running");
  });

  it("node-failed again during retrying => further retry or fail", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) as any });
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a" as NodeId, attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);
    // attempt count in ctx is 1, limit is 2 => 1 < 2 => retry again
    expect(result.state.kind).toBe("retrying");
    if (result.state.kind === "retrying") {
      expect(result.state.attempt).toBe(2);
    }
  });

  it("node-failed during retrying folds partial freshness progress before retry policy", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const originalWitnesses = new Map([[
      "postgres:orders",
      witness("version", RN("postgres:orders"), "41"),
    ]]);
    const ctx = makeCtx({ dag, priorWitnesses: originalWitnesses });
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: N("a"), attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = {
      type: "node-failed",
      nodeId: N("a"),
      error: nodeFailedError,
      priorWitnesses: new Map([[
        "postgres:orders",
        witness("version", RN("postgres:orders"), "42"),
      ]]),
      freshnessCompletedNodeIds: new Set([N("b")]),
    };

    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying");
    expect(result.context.priorWitnesses.get("postgres:orders")?.value).toBe("42");
    expect(result.context.priorWitnesses).not.toBe(event.priorWitnesses);
    expect(result.context.freshnessCompletedNodeIds).toEqual(new Set([N("b")]));
    expect(result.context.freshnessCompletedNodeIds).not.toBe(event.freshnessCompletedNodeIds);
    expect(originalWitnesses.get("postgres:orders")?.value).toBe("41");
  });

  it("node-failed during retrying when exhausted => failed", () => {
    const dag = makeDag({ defaultRetryLimit: 1 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) as any }); // at limit
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a" as NodeId, attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);
    expect(result.state.kind).toBe("failed");
  });

  it("ERROR event during retrying => failed", () => {
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a" as NodeId, attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "executor-error", retriable: false, error: "crash" };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state.kind).toBe("failed");
  });

  it("unrelated events during retrying => no-op", () => {
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a" as NodeId, attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "start" };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state).toEqual(phase);
  });
});

// ---------------------------------------------------------------------------
// dagTransition: awaiting-human — sequential HITL (FR-028)
// ---------------------------------------------------------------------------

describe("dagTransition — awaiting-human (FR-028)", () => {
  it("human-responded for wrong node id => no-op", () => {
    const phase = awaitingHuman("a");
    const event: DagEvent = { type: "human-responded", nodeId: "b" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state).toEqual(phase);
  });

  it("non-human-responded events ignored in awaiting-human", () => {
    const phase = awaitingHuman("a");
    const event: DagEvent = { type: "start" };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state).toEqual(phase);
  });
});

// ---------------------------------------------------------------------------
// dagTransition: approve (FR-029)
// ---------------------------------------------------------------------------

describe("dagTransition — approve (FR-029)", () => {
  it("approve with no pending reviews => advance to next wave", () => {
    const phase = awaitingHuman("a", [], 0);
    const ctx = makeCtx({ outputs: new Map([["a", "a-out"]]) as any });
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("approve with pending review => awaiting-human for next node (sequential order FR-028)", () => {
    const dagWithMultiHitl = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "Review A" } }),
        makeNode("b", { humanReview: { prompt: "Review B" } }),
      ],
      edges: [
        { from: DAG_INPUT, to: "a" },
        { from: DAG_INPUT, to: "b" },
      ],
    });
    const ctx = makeCtx({
      dag: dagWithMultiHitl,
      waves: [[N("a"), N("b")]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]) as any,
    });
    const phase = awaitingHuman("a", ["b"], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "b" as NodeId, pendingReviews: [] });
  });

  it("approve on last wave => succeeded", () => {
    const ctx = makeCtx({ waves: [[N("a")]], outputs: new Map([["a", "output"]]) as any });
    const phase = awaitingHuman("a", [], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);
    expect(result.state.kind).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// dagTransition: approve-with-edit (FR-029)
// ---------------------------------------------------------------------------

describe("dagTransition — approve-with-edit (FR-029)", () => {
  it("approve-with-edit replaces node output and advances", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "original"]]) as any });
    const phase = awaitingHuman("a", [], 0);
    const action: HumanAction = { kind: "approve-with-edit", newOutput: "edited" };
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action };
    const result = dagTransition(phase, event, ctx);
    expect(result.context.outputs.get(N("a"))).toBe(N("edited"));
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("approve-with-edit with pending reviews => updates output + goes to next review", () => {
    const dagWithMultiHitl = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "Review A" } }),
        makeNode("b", { humanReview: { prompt: "Review B" } }),
      ],
      edges: [
        { from: DAG_INPUT, to: "a" },
        { from: DAG_INPUT, to: "b" },
      ],
    });
    const ctx = makeCtx({
      dag: dagWithMultiHitl,
      waves: [[N("a"), N("b")]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]) as any,
    });
    const phase = awaitingHuman("a", ["b"], 0);
    const action: HumanAction = { kind: "approve-with-edit", newOutput: "edited-a" };
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action };
    const result = dagTransition(phase, event, ctx);
    expect(result.context.outputs.get(N("a"))).toBe(N("edited-a"));
    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "b" as NodeId });
  });
});

// ---------------------------------------------------------------------------
// dagTransition: reject (FR-030)
// ---------------------------------------------------------------------------

describe("dagTransition — reject (FR-030)", () => {
  it("reject => failed with rejected error carrying reason and nodeId", () => {
    const phase = awaitingHuman("a", [], 0);
    const action: HumanAction = { kind: "reject", reason: "not good enough" };
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "rejected", nodeId: "a" as NodeId, reason: "not good enough" },
    });
  });
});

// ---------------------------------------------------------------------------
// dagTransition: reroute backward (FR-031)
// ---------------------------------------------------------------------------

describe("dagTransition — reroute backward (FR-031)", () => {
  it("reroute to earlier wave => running at target wave with cleared outputs", () => {
    const ctx = makeCtx({
      waves: [[N("a")], [N("b")], [N("c")]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"], ["c", "c-out"]]) as any,
    });
    // We're awaiting-human after wave 2
    const phase = awaitingHuman("c", [], 2);
    const action = { kind: "reroute" as const, targetNodeId: N("b") };
    const event: DagEvent = { type: "human-responded", nodeId: "c" as NodeId, action, rerouteActiveSet: new Set<NodeId>() };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
    // Outputs from wave 1+ should be cleared
    expect(result.context.outputs.has(N("b"))).toBe(false);
    expect(result.context.outputs.has(N("c"))).toBe(false);
    // Wave 0 outputs preserved
    expect(result.context.outputs.get(N("a"))).toBe(N("a-out"));
    expect(Number(result.context.freshnessExecutionEpoch)).toBe(1);
  });

  it("reroute to current wave => allowed (FR-031 — same wave counts as backward)", () => {
    const ctx = makeCtx({
      waves: [[N("a")], [N("b")], [N("c")]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]) as any,
    });
    const phase = awaitingHuman("b", [], 1); // currently in wave 1
    const action = { kind: "reroute" as const, targetNodeId: N("b") }; // reroute to same wave
    const event: DagEvent = { type: "human-responded", nodeId: "b" as NodeId, action, rerouteActiveSet: new Set<NodeId>() };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
    expect(Number(result.context.freshnessExecutionEpoch)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dagTransition: reroute forward (FR-032) — invalid
// ---------------------------------------------------------------------------

describe("dagTransition — reroute forward invalid (FR-032)", () => {
  it("reroute to later wave => failed with invalid-reroute", () => {
    const ctx = makeCtx({ waves: [[N("a")], [N("b")], [N("c")]] });
    // Awaiting human at wave 0
    const phase = awaitingHuman("a", [], 0);
    const action = { kind: "reroute" as const, targetNodeId: N("c") }; // c is in wave 2
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action, rerouteActiveSet: new Set<NodeId>() };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "invalid-reroute", targetNodeId: "c" },
    });
  });

  it("reroute to unknown node => failed with invalid-reroute", () => {
    const ctx = makeCtx();
    const phase = awaitingHuman("a", [], 0);
    const action = { kind: "reroute" as const, targetNodeId: N("nonexistent") };
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action, rerouteActiveSet: new Set<NodeId>() };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "invalid-reroute", targetNodeId: "nonexistent" },
    });
  });
});

// ---------------------------------------------------------------------------
// dagTransition: terminal states
// ---------------------------------------------------------------------------

describe("dagTransition — terminal no-ops", () => {
  it("any event in succeeded => no-op", () => {
    const phase: DagPhase = { kind: "succeeded", output: 42 };
    const event: DagEvent = { type: "start" };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state).toEqual(phase);
  });

  it("any event in failed => no-op", () => {
    const phase: DagPhase = { kind: "failed", error: nodeFailedError };
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map(), routingDecisions: new Map() };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state).toEqual(phase);
  });
});

// ---------------------------------------------------------------------------
// handleWaveDone — unit tests
// ---------------------------------------------------------------------------

describe("handleWaveDone", () => {
  it("no human-review nodes => advances to next wave", () => {
    const ctx = makeCtx();
    const result = handleWaveDone(0, new Map([["a", 1]]) as any, ctx, new Map());
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
    expect(result.context.outputs.get(N("a"))).toBe(1);
  });

  it("human-review nodes => awaiting-human for first in sorted order", () => {
    const dag = makeDag({
      nodes: [
        makeNode("z", { humanReview: { prompt: "Review Z" } }),
        makeNode("a", { humanReview: { prompt: "Review A" } }),
      ],
      edges: [
        { from: DAG_INPUT, to: "z" },
        { from: DAG_INPUT, to: "a" },
      ],
    });
    const ctx = makeCtx({
      dag,
      waves: [[N("a"), N("z")]],
      outputs: new Map([["a", "a-out"], ["z", "z-out"]]) as any,
    });
    const result = handleWaveDone(0, new Map([["a", "a-out"], ["z", "z-out"]]) as any, ctx, new Map());
    // "a" should come before "z" (sorted ascending)
    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "a" as NodeId });
    if (result.state.kind === "awaiting-human") {
      expect(result.state.pendingReviews).toEqual([N("z")]);
    }
  });

  it("last wave => succeeded", () => {
    const ctx = makeCtx({ waves: [[N("a")]] });
    const result = handleWaveDone(0, new Map([["a", "out"]]) as any, ctx, new Map());
    expect(result.state.kind).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// handleNodeFailed — unit tests
// ---------------------------------------------------------------------------

describe("handleNodeFailed", () => {
  it("attempt 0 < limit 3 => retrying with incremented attempt", () => {
    const dag = makeDag({ defaultRetryLimit: 3 });
    const ctx = makeCtx({ dag });
    const result = handleNodeFailed(0, N("a"), nodeFailedError, ctx);
    expect(result.state.kind).toBe("retrying");
    if (result.state.kind === "retrying") {
      expect(result.state.attempt).toBe(1);
      expect(result.context.retries.get(N("a"))).toBe(1);
    }
  });

  it("attempt 0 with limit 0 => failed immediately with retry-exhausted", () => {
    const ctx = makeCtx(); // defaultRetryLimit = 0
    const result = handleNodeFailed(0, N("a"), nodeFailedError, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("attempt equals limit => failed with retry-exhausted (at limit not within limit)", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 2]]) as any }); // at limit
    const result = handleNodeFailed(0, N("a"), nodeFailedError, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("retry-exhausted carries nodeId, attempts, and lastError from node-crash", () => {
    const ctx = makeCtx(); // defaultRetryLimit = 0
    const result = handleNodeFailed(0, N("a"), nodeFailedError, ctx);
    expect(result.state).toMatchObject({
      kind: "failed",
      error: {
        kind: "retry-exhausted",
        nodeId: "a" as NodeId,
        attempts: 1,
        lastError: "boom",
      },
    });
  });

  it("retry-exhausted stringifies non-node-crash errors", () => {
    const ctx = makeCtx();
    const nonCrashError: FrameworkError = { kind: "rejected", nodeId: "a" as NodeId, reason: "bad output" };
    const result = handleNodeFailed(0, N("a"), nonCrashError, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed" && result.state.error.kind === "retry-exhausted") {
      expect(result.state.error.lastError).toContain("rejected");
    }
  });
});

// ---------------------------------------------------------------------------
// handleHumanResponse — unit tests
// ---------------------------------------------------------------------------

describe("handleHumanResponse", () => {
  it("approve advances wave", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "out"]]) as any });
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { kind: "approve" }, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("approve-with-edit updates output then advances", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "old"]]) as any });
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { kind: "approve-with-edit", newOutput: "new" }, ctx);
    expect(result.context.outputs.get(N("a"))).toBe(N("new"));
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("reject => failed with rejected error", () => {
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { kind: "reject", reason: "bad" }, makeCtx());
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "rejected" } });
  });

  it("reroute backward => running at target wave", () => {
    const ctx = makeCtx({ waves: [[N("a")], [N("b")], [N("c")]], outputs: new Map([["a", "out"], ["b", "b"], ["c", "c"]]) as any });
    const state = awaitingHuman("c", [], 2);
    const result = handleHumanResponse(state, { kind: "reroute", targetNodeId: N("a") }, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 0 });
    expect(result.context.outputs.has(N("a"))).toBe(false); // all cleared from wave 0+
  });

  it("reroute forward => failed with invalid-reroute", () => {
    const ctx = makeCtx({ waves: [[N("a")], [N("b")], [N("c")]] });
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { kind: "reroute", targetNodeId: N("c") }, ctx);
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "invalid-reroute" } });
  });
});

// ---------------------------------------------------------------------------
// advanceToNextWave — unit tests
// ---------------------------------------------------------------------------

describe("advanceToNextWave", () => {
  it("more waves remaining => running next wave", () => {
    const ctx = makeCtx({ waves: [[N("a")], [N("b")]] });
    const result = advanceToNextWave(0, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("no more waves => succeeded", () => {
    const ctx = makeCtx({ waves: [[N("a")]], outputs: new Map([["a", "out"]]) as any });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("succeeded");
  });

  it("uses outputNodeId from dag when succeeding", () => {
    const dag = makeDag({ outputNodeId: "a" });
    const ctx = makeCtx({ dag, waves: [[N("a")]], outputs: new Map([["a", "the-output"]]) as any });
    const result = advanceToNextWave(0, ctx);
    expect(result.state).toMatchObject({ kind: "succeeded", output: "the-output" });
  });

  it("fails when outputNodeId set but output not in ctx.outputs (F3)", () => {
    const dag = makeDag({ outputNodeId: "a" });
    // outputs map is empty — 'a' not present
    const ctx = makeCtx({ dag, waves: [[N("a")]], outputs: new Map() });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
      if (result.state.error.kind === "node-crash") {
        expect(result.state.error.message).toMatch(/output-missing/);
        expect(result.state.error.message).toMatch(/outputNodeId 'a'/);
      }
    }
  });

  it("fails when outputNodeId unset and last wave is empty (F3)", () => {
    // Advancing FROM wave 0 makes nextWave (1) >= waves.length (1), so the run
    // reaches terminal — and the last wave is empty, so there is no node to
    // fall back to for the output.
    const ctx = makeCtx({ waves: [[]], outputs: new Map() });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
    }
  });

  it("falls back to last node (deepest topo) of last wave if no outputNodeId", () => {
    const ctx = makeCtx({ waves: [[N("a"), N("b")]], outputs: new Map([["a", "a-out"], ["b", "b-out"]]) as any });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      // fallback: last node (deepest topo) in last wave = "b"
      expect(result.state.output).toBe("b-out");
    }
  });

  it("fails when outputNodeId unset, last wave non-empty, but fallback node output missing (F11)", () => {
    // last wave has node "a" but outputs map is empty
    const ctx = makeCtx({ waves: [[N("a")]], outputs: new Map() });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
      if (result.state.error.kind === "node-crash") {
        expect(result.state.error.message).toMatch(
          /output-missing: outputNodeId unset and no active node produced output/,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// collectHumanReviewQueue — unit tests
// ---------------------------------------------------------------------------

describe("collectHumanReviewQueue", () => {
  it("no humanReview nodes => empty queue", () => {
    const ctx = makeCtx();
    const queue = collectHumanReviewQueue(ctx, 0);
    expect(queue).toEqual([]);
  });

  it("multiple humanReview nodes => sorted ascending by node-id (FR-028)", () => {
    const dag = makeDag({
      nodes: [
        makeNode("z", { humanReview: { prompt: "Z" } }),
        makeNode("m", { humanReview: { prompt: "M" } }),
        makeNode("a", { humanReview: { prompt: "A" } }),
      ],
      edges: [
        { from: DAG_INPUT, to: "z" },
        { from: DAG_INPUT, to: "m" },
        { from: DAG_INPUT, to: "a" },
      ],
    });
    const ctx = makeCtx({ dag, waves: [[N("z"), N("m"), N("a")]] });
    const queue = collectHumanReviewQueue(ctx, 0);
    expect(queue).toEqual([N("a"), N("m"), N("z")]);
  });

  it("only nodes in the current wave are included", () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "A" } }),
        makeNode("b"),
      ],
      edges: [{ from: DAG_INPUT, to: "a" }, { from: "a", to: "b" }],
    });
    const ctx = makeCtx({ dag, waves: [[N("a")], [N("b")]] });
    // Wave 1 only — "b" has no humanReview
    const queue1 = collectHumanReviewQueue(ctx, 1);
    expect(queue1).toEqual([]);
    // Wave 0 only — "a" has humanReview
    const queue0 = collectHumanReviewQueue(ctx, 0);
    expect(queue0).toEqual([N("a")]);
  });
});

// ---------------------------------------------------------------------------
// computeBackoffMs — unit tests
// ---------------------------------------------------------------------------

describe("computeBackoffMs", () => {
  it("returns base delay (no jitter) when no node retry config", () => {
    const configs: RetryConfigs = new Map();
    const delay = computeBackoffMs(N("a"), 0, configs);
    // Default: [1000, 2000, 4000] — returns base 1000 (executor applies jitter)
    expect(delay).toBe(1000);
  });

  it("returns base delay (no jitter) with node-specific backoff config", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { retry: { backoffMs: [500, 1000], jitterRatio: 0.1 } })],
    });
    const delay = computeBackoffMs(N("a"), 0, retryConfigsFrom(dag));
    expect(delay).toBe(500);
  });

  it("clamps to last backoff value for attempts beyond list length", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { retry: { backoffMs: [100, 200], jitterRatio: 0 } })],
    });
    const delay = computeBackoffMs(N("a"), 10, retryConfigsFrom(dag));
    expect(delay).toBe(200);
  });

  it("advances through backoff list with attempt index", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { retry: { backoffMs: [100, 500, 2000] } })],
    });
    const configs = retryConfigsFrom(dag);
    expect(computeBackoffMs(N("a"), 0, configs)).toBe(100);
    expect(computeBackoffMs(N("a"), 1, configs)).toBe(500);
    expect(computeBackoffMs(N("a"), 2, configs)).toBe(2000);
    expect(computeBackoffMs(N("a"), 5, configs)).toBe(2000); // clamped
  });
});

// ---------------------------------------------------------------------------
// getRetryLimit — unit tests
// ---------------------------------------------------------------------------

describe("getRetryLimit", () => {
  it("returns 0 when no limits configured", () => {
    const ctx = makeCtx();
    expect(getRetryLimit(N("a"), ctx)).toBe(0);
  });

  it("returns defaultRetryLimit when no per-node override", () => {
    const dag = makeDag({ defaultRetryLimit: 3 });
    const ctx = makeCtx({ dag });
    expect(getRetryLimit(N("a"), ctx)).toBe(3);
  });

  it("returns per-node limit overriding default", () => {
    const dag = makeDag({ defaultRetryLimit: 1, retryLimits: { a: 5 } });
    const ctx = makeCtx({ dag });
    expect(getRetryLimit(N("a"), ctx)).toBe(5);
    expect(getRetryLimit(N("b"), ctx)).toBe(1); // no override => default
  });
});

// ---------------------------------------------------------------------------
// waveNodes / waveIndexOf — unit tests
// ---------------------------------------------------------------------------

describe("waveNodes / waveIndexOf", () => {
  const ctx = makeCtx({ waves: [[N("a")], [N("b"), N("c")], [N("d")]] });

  it("waveNodes returns nodes in wave", () => {
    expect(waveNodes(ctx, 1)).toEqual([N("b"), N("c")]);
  });

  it("waveNodes returns empty array for out-of-bounds wave", () => {
    expect(waveNodes(ctx, 99)).toEqual([]);
  });

  it("waveIndexOf finds the correct wave", () => {
    expect(waveIndexOf(ctx, N("b"))).toBe(1);
    expect(waveIndexOf(ctx, N("d"))).toBe(2);
    expect(waveIndexOf(ctx, N("a"))).toBe(0);
  });

  it("waveIndexOf returns -1 for unknown node", () => {
    expect(waveIndexOf(ctx, N("nonexistent"))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// compileDagToMachine — integration smoke tests
// ---------------------------------------------------------------------------

describe("compileDagToMachine", () => {
  it("returns err on cyclic DAG", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const cyclicDag = defineDagFromArray({
      id: "cycle",
      nodes: [makeNode("a"), makeNode("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    const r = compileDagToMachine(cyclicDag, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("cycle-detected");
  });

  it("compiles a valid DAG and returns machine with correct terminal predicates", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const dag = defineDagFromArray({
      id: "linear",
      nodes: [makeNode("a"), makeNode("b")],
      edges: [{ from: DAG_INPUT, to: "a" }, { from: "a", to: "b" }],
    });
    const compiled = compileDagToMachine(dag, { input: "hello" });
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { machine, initialContext, initialState } = compiled.value;
    expect(initialState).toEqual({ kind: "pending" });
    expect(machine.isTerminal({ kind: "pending" })).toBe(false);
    expect(machine.isTerminal({ kind: "running", wave: 0 })).toBe(false);
    expect(machine.isTerminal({ kind: "succeeded", output: null })).toBe(true);
    expect(machine.isTerminal({ kind: "failed", error: nodeFailedError })).toBe(true);
    expect(machine.isFailed({ kind: "succeeded", output: null })).toBe(false);
    expect(machine.isFailed({ kind: "failed", error: nodeFailedError })).toBe(true);
    // @ts-expect-error — branded ID test fixture
    expect(initialContext.waves).toEqual([["a"], ["b"]]);
    expect(initialContext.initialInput).toEqual({ input: "hello" });
  });

  it("threads initialInput into context", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const dag = defineDagFromArray({ id: "d", nodes: [makeNode("a")], edges: [{ from: DAG_INPUT, to: "a" }] });
    const compiled = compileDagToMachine(dag, "my-input");
    if (!compiled.ok) throw new Error("compile failed in test setup");
    expect(compiled.value.initialContext.initialInput).toBe("my-input");
  });

  it("stateProgress maps phases to expected values", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const dag = defineDagFromArray({
      id: "simple",
      nodes: [makeNode("a")],
      edges: [{ from: DAG_INPUT, to: "a" }],
    });
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { machine } = compiled.value;
    expect(machine.stateProgress({ kind: "pending" })).toBe(0);
    expect(machine.stateProgress({ kind: "running", wave: 0 })).toBe(10);
    expect(machine.stateProgress({ kind: "retrying", wave: 0, nodeId: "a" as NodeId, attempt: 1, nextDelayMs: 1000 })).toBe(10);
    expect(machine.stateProgress({ kind: "awaiting-human", nodeId: "a" as NodeId, output: null, prompt: "", pendingReviews: [], wave: 0 })).toBe(50);
    expect(machine.stateProgress({ kind: "succeeded", output: null })).toBe(100);
    expect(machine.stateProgress({ kind: "failed", error: nodeFailedError })).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Full round-trip: pending -> start -> wave-done -> succeeded
// ---------------------------------------------------------------------------

describe("dagTransition — full round-trip", () => {
  it("linear 3-wave DAG goes pending -> running(0) -> running(1) -> running(2) -> succeeded", () => {
    const ctx = makeCtx();
    let phase: DagPhase = { kind: "pending" };

    // start
    let r = dagTransition(phase, { type: "start" }, ctx);
    expect(r.state.kind).toBe("running");
    phase = r.state;

    // wave 0 done
    r = dagTransition(phase, { type: "wave-done", wave: 0, outputs: new Map([["a", 1]]) as any, routingDecisions: new Map() }, r.context);
    expect(r.state).toMatchObject({ kind: "running", wave: 1 });
    phase = r.state;

    // wave 1 done
    r = dagTransition(phase, { type: "wave-done", wave: 1, outputs: new Map([["b", 2]]) as any, routingDecisions: new Map() }, r.context);
    expect(r.state).toMatchObject({ kind: "running", wave: 2 });
    phase = r.state;

    // wave 2 done
    r = dagTransition(phase, { type: "wave-done", wave: 2, outputs: new Map([["c", 3]]) as any, routingDecisions: new Map() }, r.context);
    expect(r.state.kind).toBe("succeeded");
  });

  it("retry path: node-failed -> retrying -> wave-done -> succeeded", () => {
    const dag = makeDag({ defaultRetryLimit: 1 });
    const ctx = makeCtx({ dag });
    let phase: DagPhase = { kind: "running", wave: 0 };
    let currentCtx: DagMachineContextPersisted = ctx;

    // first failure
    let r = dagTransition(phase, { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError }, currentCtx);
    expect(r.state.kind).toBe("retrying");
    phase = r.state;
    currentCtx = r.context;

    // retry succeeds — wave done
    r = dagTransition(phase, { type: "wave-done", wave: 0, outputs: new Map([["a", "recovered"]]) as any, routingDecisions: new Map() }, currentCtx);
    expect(r.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("HITL round-trip: running -> awaiting-human -> approve -> succeeded", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { humanReview: { prompt: "Review" } })],
      edges: [],
    });
    const ctx = makeCtx({ dag, waves: [[N("a")]] });
    let phase: DagPhase = { kind: "running", wave: 0 };
    let currentCtx: DagMachineContextPersisted = ctx;

    // wave done => awaiting-human
    let r = dagTransition(phase, { type: "wave-done", wave: 0, outputs: new Map([["a", "result"]]) as any, routingDecisions: new Map() }, currentCtx);
    expect(r.state.kind).toBe("awaiting-human");
    phase = r.state;
    currentCtx = r.context;

    // human approves => succeeded (single-wave DAG)
    r = dagTransition(phase, { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } }, currentCtx);
    expect(r.state.kind).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// dagTransition: awaiting-human + node-failed / ERROR (hook-crash retry)
// ---------------------------------------------------------------------------

describe("dagTransition — awaiting-human hook-crash retry (FR-029a)", () => {
  const awaitingWithPrompt = (
    nodeId: string,
    pendingReviews: string[] = [],
    wave = 0,
  ): Extract<DagPhase, { kind: "awaiting-human" }> => ({
    kind: "awaiting-human",
    // @ts-expect-error — branded ID test fixture
    nodeId,
    output: { result: "preserved-output" },
    prompt: "original-prompt",
    // @ts-expect-error — branded ID test fixture
    pendingReviews,
    wave,
  });

  it("awaiting-human + node-failed within budget => retrying-hook with preserved output and prompt", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a", [], 0);
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.nodeId).toBe(N("a"));
      expect(result.state.output).toEqual({ result: "preserved-output" });
      expect(result.state.prompt).toBe("original-prompt");
      expect(result.state.attempt).toBe(1);
      expect(result.state.nextDelayMs).toBeGreaterThan(0);
      expect(result.state.pendingReviews).toEqual([]);
      expect(result.state.wave).toBe(0);
    }
  });

  it("awaiting-human + node-failed budget exhausted => terminal failed with retry-exhausted", () => {
    const dag = makeDag({ defaultRetryLimit: 0 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a");
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
      if (result.state.error.kind === "retry-exhausted") {
        expect(result.state.error.nodeId).toBe(N("a"));
        expect(result.state.error.lastError).toBe("boom");
        expect(result.state.error.rootErrorKind).toBe("node-crash");
      }
    }
  });

  it("awaiting-human + ERROR within budget => retrying-hook", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a");
    const event: DagEvent = { type: "executor-error", retriable: true, error: "hook network failure" };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.nodeId).toBe(N("a"));
      expect(result.state.output).toEqual({ result: "preserved-output" });
    }
  });

  it("awaiting-human + ERROR budget exhausted => terminal failed with retry-exhausted", () => {
    const dag = makeDag({ defaultRetryLimit: 0 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a");
    const event: DagEvent = { type: "executor-error", retriable: false, error: "hook blew up" };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("awaiting-human hook-crash preserves pendingReviews and wave in retrying-hook", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a", ["b", "c"], 2);
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.pendingReviews).toEqual([N("b"), N("c")]);
      expect(result.state.wave).toBe(2);
    }
  });

  it("awaiting-human + node-failed with mismatched nodeId => no-op", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a", [], 0);
    // Event targets node "b", but we are awaiting-human for node "a"
    const mismatchedError: FrameworkError = { kind: "node-crash", nodeId: "b" as NodeId, retriability: "retriable", message: "wrong node" };
    const event: DagEvent = { type: "node-failed", nodeId: "b" as NodeId, error: mismatchedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
    expect(result.context).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// dagTransition: retrying-hook transitions
// ---------------------------------------------------------------------------

describe("dagTransition — retrying-hook (FR-029a)", () => {
  const retryingHookPhase = (
    attempt = 1,
    pendingReviews: string[] = [],
    wave = 0,
  ): Extract<DagPhase, { kind: "retrying-hook" }> => ({
    kind: "retrying-hook",
    nodeId: "a" as NodeId,
    output: { result: "preserved-output" },
    prompt: "original-prompt",
    attempt,
    nextDelayMs: 1000,
    // @ts-expect-error — branded ID test fixture
    pendingReviews,
    wave,
  });

  it("retrying-hook + human-responded approve => resolves (no pending reviews => next wave)", () => {
    const ctx = makeCtx({ outputs: new Map([["a", { result: "preserved-output" }]]) as any });
    const phase = retryingHookPhase(1, [], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("retrying-hook + human-responded reject => failed with rejected error", () => {
    const ctx = makeCtx();
    const phase = retryingHookPhase(1, [], 0);
    const event: DagEvent = {
      type: "human-responded",
      nodeId: "a" as NodeId,
      action: { kind: "reject", reason: "still not good" },
    };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "rejected", nodeId: "a" as NodeId, reason: "still not good" },
    });
  });

  it("retrying-hook + human-responded approve with pending reviews => awaiting-human for next", () => {
    const dagWithMultiHitl = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "Review A" } }),
        makeNode("b", { humanReview: { prompt: "Review B" } }),
      ],
      edges: [],
    });
    const ctx = makeCtx({
      dag: dagWithMultiHitl,
      waves: [[N("a"), N("b")]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]) as any,
    });
    const phase = retryingHookPhase(1, ["b"], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "b" as NodeId });
  });

  it("retrying-hook + node-failed again within budget => stays in retrying-hook with incremented attempt", () => {
    const dag = makeDag({ defaultRetryLimit: 3 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) as any });
    const phase = retryingHookPhase(1);
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.attempt).toBe(2);
    }
  });

  it("retrying-hook + node-failed when budget exhausted => terminal failed with retry-exhausted", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 2]]) as any });
    const phase = retryingHookPhase(2);
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("retrying-hook + abort => terminal failed via aborted (FR-033 global handler)", () => {
    const ctx = makeCtx();
    const phase = retryingHookPhase(1);
    const event: DagEvent = { type: "abort", reason: "user cancelled during hook retry" };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "aborted", reason: "user cancelled during hook retry" },
    });
  });

  it("retrying-hook + human-responded for wrong nodeId => no-op", () => {
    const ctx = makeCtx();
    const phase = retryingHookPhase(1);
    const event: DagEvent = { type: "human-responded", nodeId: "b" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
  });

  it("retrying-hook + approve-with-edit replaces output and advances", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "original"]]) as any });
    const phase = retryingHookPhase(1, [], 0);
    const event: DagEvent = {
      type: "human-responded",
      nodeId: "a" as NodeId,
      action: { kind: "approve-with-edit", newOutput: "edited" },
    };
    const result = dagTransition(phase, event, ctx);

    expect(result.context.outputs.get(N("a"))).toBe(N("edited"));
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("retrying-hook + node-failed with mismatched nodeId => no-op", () => {
    const dag = makeDag({ defaultRetryLimit: 3 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) as any });
    const phase = retryingHookPhase(1);
    // Event targets node "b", but we are retrying-hook for node "a"
    const mismatchedError: FrameworkError = { kind: "node-crash", nodeId: "b" as NodeId, retriability: "retriable", message: "wrong node" };
    const event: DagEvent = { type: "node-failed", nodeId: "b" as NodeId, error: mismatchedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
    expect(result.context).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// dagTransition: suspended (durable park) transitions — ADR-0060
//
// `suspended` is the phase serialized to Redis and replayed across restarts. On
// resume the executor re-dispatches the hook, so it accepts the SAME events as
// `awaiting-human`: a decision resolves the gate, another `pending` re-parks, a
// hook crash retries. These pin the guards that live at this pure layer.
// ---------------------------------------------------------------------------

describe("dagTransition — suspended (ADR-0060)", () => {
  const suspendedPhase = (
    nodeId = "a",
    pendingReviews: string[] = [],
    wave = 0,
  ): Extract<DagPhase, { kind: "suspended" }> => ({
    kind: "suspended",
    // @ts-expect-error — branded ID test fixture
    nodeId,
    output: { result: "preserved-output" },
    prompt: "original-prompt",
    // @ts-expect-error — branded ID test fixture
    pendingReviews,
    wave,
  });

  // ── entry: awaiting-human → suspended on human-suspend ──────────────────
  it("awaiting-human + human-suspend (matching node) => parks durably (suspended)", () => {
    const ctx = makeCtx();
    const phase: Extract<DagPhase, { kind: "awaiting-human" }> = {
      kind: "awaiting-human",
      nodeId: "a" as NodeId,
      output: { result: "preserved-output" },
      prompt: "original-prompt",
      pendingReviews: [],
      wave: 0,
    };
    const event: DagEvent = { type: "human-suspend", nodeId: "a" as NodeId };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({
      kind: "suspended",
      nodeId: N("a"),
      output: { result: "preserved-output" },
      prompt: "original-prompt",
      wave: 0,
    });
  });

  it("awaiting-human + human-suspend for a different node => no-op (stays awaiting-human)", () => {
    const ctx = makeCtx();
    const phase: Extract<DagPhase, { kind: "awaiting-human" }> = {
      kind: "awaiting-human",
      nodeId: "a" as NodeId,
      output: { result: "preserved-output" },
      prompt: "original-prompt",
      pendingReviews: [],
      wave: 0,
    };
    const event: DagEvent = { type: "human-suspend", nodeId: "b" as NodeId };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
  });

  // ── resume: a decision now present resolves the gate ────────────────────
  it("suspended + human-responded approve (no pending reviews) => next wave", () => {
    const ctx = makeCtx({ outputs: new Map([["a", { result: "preserved-output" }]]) as any });
    const phase = suspendedPhase("a", [], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("suspended + human-responded reject => failed with rejected error", () => {
    const ctx = makeCtx();
    const phase = suspendedPhase("a", [], 0);
    const event: DagEvent = {
      type: "human-responded",
      nodeId: "a" as NodeId,
      action: { kind: "reject", reason: "not good enough" },
    };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "rejected", nodeId: "a" as NodeId, reason: "not good enough" },
    });
  });

  it("suspended + human-responded approve-with-edit replaces output and advances", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "original"]]) as any });
    const phase = suspendedPhase("a", [], 0);
    const event: DagEvent = {
      type: "human-responded",
      nodeId: "a" as NodeId,
      action: { kind: "approve-with-edit", newOutput: "edited" },
    };
    const result = dagTransition(phase, event, ctx);

    expect(result.context.outputs.get(N("a"))).toBe(N("edited"));
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("suspended + human-responded approve with pending reviews => awaiting-human for next", () => {
    const dagWithMultiHitl = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "Review A" } }),
        makeNode("b", { humanReview: { prompt: "Review B" } }),
      ],
      edges: [],
    });
    const ctx = makeCtx({
      dag: dagWithMultiHitl,
      waves: [[N("a"), N("b")]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]) as any,
    });
    const phase = suspendedPhase("a", ["b"], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "b" as NodeId });
  });

  // ── staleness guard: a decision for a gate the run is NOT parked at ──────
  it("suspended + human-responded for the wrong node => no-op (stale gate cannot auto-resolve)", () => {
    const ctx = makeCtx();
    const phase = suspendedPhase("a", [], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "b" as NodeId, action: { kind: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
    expect(result.context).toBe(ctx);
  });

  // ── idempotent re-park: resumed but still no decision ───────────────────
  it("suspended + human-suspend => idempotent re-park (stays suspended)", () => {
    const ctx = makeCtx();
    const phase = suspendedPhase("a", ["b"], 1);
    const event: DagEvent = { type: "human-suspend", nodeId: "a" as NodeId };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
  });

  it("suspended + human-suspend re-parks unconditionally (node id is irrelevant)", () => {
    const ctx = makeCtx();
    const phase = suspendedPhase("a", [], 0);
    // A re-dispatch carrying a different node id still just re-parks the run.
    const event: DagEvent = { type: "human-suspend", nodeId: "b" as NodeId };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
  });

  // ── hook crash WHILE parked → retrying-hook ─────────────────────────────
  it("suspended + node-failed within budget => retrying-hook with preserved gate payload", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = suspendedPhase("a", ["b", "c"], 2);
    const event: DagEvent = { type: "node-failed", nodeId: "a" as NodeId, error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.nodeId).toBe(N("a"));
      expect(result.state.output).toEqual({ result: "preserved-output" });
      expect(result.state.prompt).toBe("original-prompt");
      expect(result.state.attempt).toBe(1);
      expect(result.state.pendingReviews).toEqual([N("b"), N("c")]);
      expect(result.state.wave).toBe(2);
    }
  });

  it("suspended + executor-error within budget => retrying-hook", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = suspendedPhase("a", [], 0);
    const event: DagEvent = { type: "executor-error", retriable: true, error: "hook network failure" };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.nodeId).toBe(N("a"));
    }
  });

  it("suspended + node-failed for the wrong node => no-op", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = suspendedPhase("a", [], 0);
    const mismatchedError: FrameworkError = { kind: "node-crash", nodeId: "b" as NodeId, retriability: "retriable", message: "wrong node" };
    const event: DagEvent = { type: "node-failed", nodeId: "b" as NodeId, error: mismatchedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
    expect(result.context).toBe(ctx);
  });

  // ── abort from a parked run (FR-033 global handler) ─────────────────────
  it("suspended + abort => terminal failed via aborted", () => {
    const ctx = makeCtx();
    const phase = suspendedPhase("a", [], 0);
    const event: DagEvent = { type: "abort", reason: "cancelled while parked" };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "aborted", reason: "cancelled while parked" },
    });
  });

  // ── retrying-hook → suspended: a previously-crashed hook now returns pending ─
  it("retrying-hook + human-suspend (matching node) => parks durably (suspended)", () => {
    const ctx = makeCtx();
    const phase: Extract<DagPhase, { kind: "retrying-hook" }> = {
      kind: "retrying-hook",
      nodeId: "a" as NodeId,
      output: { result: "preserved-output" },
      prompt: "original-prompt",
      attempt: 2,
      nextDelayMs: 1000,
      pendingReviews: ["b" as NodeId],
      wave: 1,
    };
    const event: DagEvent = { type: "human-suspend", nodeId: "a" as NodeId };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "suspended", nodeId: N("a"), wave: 1 });
    // Retry bookkeeping (attempt/nextDelayMs) is dropped on the projection.
    expect(result.state).not.toHaveProperty("attempt");
    expect(result.state).not.toHaveProperty("nextDelayMs");
  });

  it("retrying-hook + human-suspend for a different node => no-op", () => {
    const ctx = makeCtx();
    const phase: Extract<DagPhase, { kind: "retrying-hook" }> = {
      kind: "retrying-hook",
      nodeId: "a" as NodeId,
      output: { result: "preserved-output" },
      prompt: "original-prompt",
      attempt: 2,
      nextDelayMs: 1000,
      pendingReviews: [],
      wave: 0,
    };
    const event: DagEvent = { type: "human-suspend", nodeId: "b" as NodeId };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
  });
});

// ---------------------------------------------------------------------------
// compileDagToMachine — retrying-hook stateProgress / isTerminal / isFailed
// ---------------------------------------------------------------------------

describe("compileDagToMachine — retrying-hook predicates", () => {
  it("retrying-hook is not terminal and not failed, progress=50", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const dag = defineDagFromArray({ id: "d", nodes: [makeNode("a")], edges: [{ from: DAG_INPUT, to: "a" }] });
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { machine } = compiled.value;
    const phase: DagPhase = {
      kind: "retrying-hook",
      nodeId: "a" as NodeId,
      output: "out",
      prompt: "p",
      attempt: 1,
      nextDelayMs: 1000,
      pendingReviews: [],
      wave: 0,
    };
    expect(machine.isTerminal(phase)).toBe(false);
    expect(machine.isFailed(phase)).toBe(false);
    expect(machine.stateProgress(phase)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Error types extension — verify new FrameworkError kinds exist
// ---------------------------------------------------------------------------

describe("FrameworkError new kinds", () => {
  it("aborted error is assignable", () => {
    const e: FrameworkError = { kind: "aborted", reason: "test" };
    expect(e.kind).toBe("aborted");
  });

  it("rejected error is assignable", () => {
    const e: FrameworkError = { kind: "rejected", nodeId: "a" as NodeId, reason: "bad" };
    expect(e.kind).toBe("rejected");
  });

  it("invalid-reroute error is assignable", () => {
    const e: FrameworkError = { kind: "invalid-reroute", targetNodeId: N("x"), message: "fwd" };
    expect(e.kind).toBe("invalid-reroute");
  });
});
