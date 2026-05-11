// dag-transition.test.ts — SC-002 (>=95% transition coverage)
// Tests: retry within/at/over limit, sequential HITL by node-id (FR-028),
//        approve / approve-with-edit / reject / reroute-back / reroute-forward-invalid / abort

import { describe, it, expect } from "bun:test";
import { dagTransition } from "../dag-runtime/transition.js";
import {
  handleWaveDone,
  handleNodeFailed,
  handleHumanResponse,
  advanceToNextWave,
  collectHumanReviewQueue,
  computeBackoffMs,
  getRetryLimit,
  waveNodes,
  waveIndexOf,
} from "../dag-runtime/transition-helpers.js";
import type { DagPhase, DagEvent, DagMachineContext, HumanAction } from "../dag-runtime/types.js";
import type { DagDef, EdgeDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { defineDag, defineDagFromArray } from "../executor/define-dag.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const noop = async () => ({ ok: true as const, value: undefined });

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown, unknown>> = {},
): NodeDef<unknown, unknown, unknown> => ({
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  ...overrides,
});

interface MakeDagOverrides {
  readonly id?: string;
  readonly nodes?: readonly NodeDef<unknown, unknown, unknown>[];
  readonly edges?: readonly EdgeDef[];
  readonly outputNodeId?: string;
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
  readonly evalJudges?: DagDef["evalJudges"];
}

const DEFAULT_NODES: readonly NodeDef<unknown, unknown, unknown>[] = [
  makeNode("a"),
  makeNode("b"),
  makeNode("c"),
];
const DEFAULT_EDGES: readonly EdgeDef[] = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
];

const makeDag = (overrides: MakeDagOverrides = {}): DagDef => {
  // If a test overrides `nodes` but not `edges`, default edges to `[]` so
  // we don't leak the abc-chain default into a custom node set.
  const nodes = overrides.nodes ?? DEFAULT_NODES;
  const edges =
    overrides.edges ?? (overrides.nodes ? [] : DEFAULT_EDGES);
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

const makeCtx = (overrides: Partial<DagMachineContext> = {}): DagMachineContext => {
  const dag = overrides.dag ?? makeDag();
  return {
    dag,
    waves: [["a"], ["b"], ["c"]],
    outputs: new Map(),
    retries: new Map(),
    initialInput: null,
    activeNodeIds: new Set(dag.nodes.map((n) => n.id)),
    incomingByNode: new Map(),
    ...overrides,
  };
};

const nodeFailedError: FrameworkError = {
  kind: "node-crash",
  nodeId: "a",
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
  nodeId,
  output: { result: "some-output" },
  prompt: "Please review",
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
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map() };
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
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a", attempt: 1, nextDelayMs: 1000 };
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
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map([["a", 42]]) };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state).toEqual({ kind: "running", wave: 1 });
    expect(result.context.outputs.get("a")).toBe(42);
  });

  it("wave-done on last wave => succeeded", () => {
    const ctx = makeCtx();
    const event: DagEvent = { type: "wave-done", wave: 2, outputs: new Map([["c", "final"]]) };
    const result = dagTransition(running(2), event, ctx);
    expect(result.state).toMatchObject({ kind: "succeeded" });
  });

  it("wave-done — last wave uses outputNodeId when specified", () => {
    const dag = makeDag({ outputNodeId: "b" });
    const ctx = makeCtx({
      dag,
      waves: [["a"], ["b"], ["c"]],
      outputs: new Map([["b", "b-output"]]),
    });
    const event: DagEvent = { type: "wave-done", wave: 2, outputs: new Map([["c", "c-output"]]) };
    const result = dagTransition(running(2), event, ctx);
    expect(result.state).toMatchObject({ kind: "succeeded", output: "b-output" });
  });

  it("node-failed within retry limit => retrying", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state.kind).toBe("retrying");
    if (result.state.kind === "retrying") {
      expect(result.state.nodeId).toBe("a");
      expect(result.state.attempt).toBe(1);
    }
  });

  it("node-failed at retry limit (attempts == limit) => failed with retry-exhausted", () => {
    const dag = makeDag({ defaultRetryLimit: 1 });
    const ctx = makeCtx({
      dag,
      retries: new Map([["a", 1]]), // already at limit
    });
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
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
      retries: new Map([["a", 2]]), // over limit
    });
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("node-failed with no retry limit (defaultRetryLimit=0) => immediately failed", () => {
    const ctx = makeCtx(); // no retryLimits, no defaultRetryLimit => 0
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    expect(result.state.kind).toBe("failed");
  });

  it("per-node retryLimit overrides default", () => {
    const dag = makeDag({ defaultRetryLimit: 0, retryLimits: { a: 3 } });
    const ctx = makeCtx({ dag });
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(running(0), event, ctx);
    // First failure: attempt 0 < limit 3, so should retry
    expect(result.state.kind).toBe("retrying");
  });

  it("ERROR event from running => failed (node-crash)", () => {
    const event: DagEvent = { type: "ERROR", retriable: true, error: "executor blew up" };
    const result = dagTransition(running(0), event, makeCtx());
    expect(result.state.kind).toBe("failed");
  });

  it("other events while running => no-op", () => {
    const event: DagEvent = { type: "human-responded", nodeId: "a", action: { action: "approve" } };
    const result = dagTransition(running(0), event, makeCtx());
    expect(result.state).toEqual(running(0));
  });
});

// ---------------------------------------------------------------------------
// dagTransition: retrying
// ---------------------------------------------------------------------------

describe("dagTransition — retrying", () => {
  it("wave-done after retry => advance", () => {
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a", attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map([["a", "ok"]]) };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state.kind).toBe("running");
  });

  it("node-failed again during retrying => further retry or fail", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) });
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a", attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);
    // attempt count in ctx is 1, limit is 2 => 1 < 2 => retry again
    expect(result.state.kind).toBe("retrying");
    if (result.state.kind === "retrying") {
      expect(result.state.attempt).toBe(2);
    }
  });

  it("node-failed during retrying when exhausted => failed", () => {
    const dag = makeDag({ defaultRetryLimit: 1 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) }); // at limit
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a", attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);
    expect(result.state.kind).toBe("failed");
  });

  it("ERROR event during retrying => failed", () => {
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a", attempt: 1, nextDelayMs: 1000 };
    const event: DagEvent = { type: "ERROR", retriable: false, error: "crash" };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state.kind).toBe("failed");
  });

  it("unrelated events during retrying => no-op", () => {
    const phase: DagPhase = { kind: "retrying", wave: 0, nodeId: "a", attempt: 1, nextDelayMs: 1000 };
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
    const event: DagEvent = { type: "human-responded", nodeId: "b", action: { action: "approve" } };
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
    const ctx = makeCtx({ outputs: new Map([["a", "a-out"]]) });
    const event: DagEvent = { type: "human-responded", nodeId: "a", action: { action: "approve" } };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("approve with pending review => awaiting-human for next node (sequential order FR-028)", () => {
    const dagWithMultiHitl = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "Review A" } }),
        makeNode("b", { humanReview: { prompt: "Review B" } }),
      ],
      edges: [],
    });
    const ctx = makeCtx({
      dag: dagWithMultiHitl,
      waves: [["a", "b"]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]),
    });
    const phase = awaitingHuman("a", ["b"], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a", action: { action: "approve" } };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "b", pendingReviews: [] });
  });

  it("approve on last wave => succeeded", () => {
    const ctx = makeCtx({ waves: [["a"]], outputs: new Map([["a", "output"]]) });
    const phase = awaitingHuman("a", [], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a", action: { action: "approve" } };
    const result = dagTransition(phase, event, ctx);
    expect(result.state.kind).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// dagTransition: approve-with-edit (FR-029)
// ---------------------------------------------------------------------------

describe("dagTransition — approve-with-edit (FR-029)", () => {
  it("approve-with-edit replaces node output and advances", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "original"]]) });
    const phase = awaitingHuman("a", [], 0);
    const action: HumanAction = { action: "approve-with-edit", newOutput: "edited" };
    const event: DagEvent = { type: "human-responded", nodeId: "a", action };
    const result = dagTransition(phase, event, ctx);
    expect(result.context.outputs.get("a")).toBe("edited");
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("approve-with-edit with pending reviews => updates output + goes to next review", () => {
    const dagWithMultiHitl = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "Review A" } }),
        makeNode("b", { humanReview: { prompt: "Review B" } }),
      ],
      edges: [],
    });
    const ctx = makeCtx({
      dag: dagWithMultiHitl,
      waves: [["a", "b"]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]),
    });
    const phase = awaitingHuman("a", ["b"], 0);
    const action: HumanAction = { action: "approve-with-edit", newOutput: "edited-a" };
    const event: DagEvent = { type: "human-responded", nodeId: "a", action };
    const result = dagTransition(phase, event, ctx);
    expect(result.context.outputs.get("a")).toBe("edited-a");
    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "b" });
  });
});

// ---------------------------------------------------------------------------
// dagTransition: reject (FR-030)
// ---------------------------------------------------------------------------

describe("dagTransition — reject (FR-030)", () => {
  it("reject => failed with rejected error carrying reason and nodeId", () => {
    const phase = awaitingHuman("a", [], 0);
    const action: HumanAction = { action: "reject", reason: "not good enough" };
    const event: DagEvent = { type: "human-responded", nodeId: "a", action };
    const result = dagTransition(phase, event, makeCtx());
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "rejected", nodeId: "a", reason: "not good enough" },
    });
  });
});

// ---------------------------------------------------------------------------
// dagTransition: reroute backward (FR-031)
// ---------------------------------------------------------------------------

describe("dagTransition — reroute backward (FR-031)", () => {
  it("reroute to earlier wave => running at target wave with cleared outputs", () => {
    const ctx = makeCtx({
      waves: [["a"], ["b"], ["c"]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"], ["c", "c-out"]]),
    });
    // We're awaiting-human after wave 2
    const phase = awaitingHuman("c", [], 2);
    const action: HumanAction = { action: "reroute", targetNodeId: "b" };
    const event: DagEvent = { type: "human-responded", nodeId: "c", action };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
    // Outputs from wave 1+ should be cleared
    expect(result.context.outputs.has("b")).toBe(false);
    expect(result.context.outputs.has("c")).toBe(false);
    // Wave 0 outputs preserved
    expect(result.context.outputs.get("a")).toBe("a-out");
  });

  it("reroute to current wave => allowed (FR-031 — same wave counts as backward)", () => {
    const ctx = makeCtx({
      waves: [["a"], ["b"], ["c"]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]),
    });
    const phase = awaitingHuman("b", [], 1); // currently in wave 1
    const action: HumanAction = { action: "reroute", targetNodeId: "b" }; // reroute to same wave
    const event: DagEvent = { type: "human-responded", nodeId: "b", action };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });
});

// ---------------------------------------------------------------------------
// dagTransition: reroute forward (FR-032) — invalid
// ---------------------------------------------------------------------------

describe("dagTransition — reroute forward invalid (FR-032)", () => {
  it("reroute to later wave => failed with invalid-reroute", () => {
    const ctx = makeCtx({ waves: [["a"], ["b"], ["c"]] });
    // Awaiting human at wave 0
    const phase = awaitingHuman("a", [], 0);
    const action: HumanAction = { action: "reroute", targetNodeId: "c" }; // c is in wave 2
    const event: DagEvent = { type: "human-responded", nodeId: "a", action };
    const result = dagTransition(phase, event, ctx);
    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "invalid-reroute", targetNodeId: "c" },
    });
  });

  it("reroute to unknown node => failed with invalid-reroute", () => {
    const ctx = makeCtx();
    const phase = awaitingHuman("a", [], 0);
    const action: HumanAction = { action: "reroute", targetNodeId: "nonexistent" };
    const event: DagEvent = { type: "human-responded", nodeId: "a", action };
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
    const event: DagEvent = { type: "wave-done", wave: 0, outputs: new Map() };
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
    const result = handleWaveDone(0, new Map([["a", 1]]), ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
    expect(result.context.outputs.get("a")).toBe(1);
  });

  it("human-review nodes => awaiting-human for first in sorted order", () => {
    const dag = makeDag({
      nodes: [
        makeNode("z", { humanReview: { prompt: "Review Z" } }),
        makeNode("a", { humanReview: { prompt: "Review A" } }),
      ],
      edges: [],
    });
    const ctx = makeCtx({
      dag,
      waves: [["a", "z"]],
      outputs: new Map([["a", "a-out"], ["z", "z-out"]]),
    });
    const result = handleWaveDone(0, new Map([["a", "a-out"], ["z", "z-out"]]), ctx);
    // "a" should come before "z" (sorted ascending)
    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "a" });
    if (result.state.kind === "awaiting-human") {
      expect(result.state.pendingReviews).toEqual(["z"]);
    }
  });

  it("last wave => succeeded", () => {
    const ctx = makeCtx({ waves: [["a"]] });
    const result = handleWaveDone(0, new Map([["a", "out"]]), ctx);
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
    const result = handleNodeFailed(0, "a", nodeFailedError, ctx);
    expect(result.state.kind).toBe("retrying");
    if (result.state.kind === "retrying") {
      expect(result.state.attempt).toBe(1);
      expect(result.context.retries.get("a")).toBe(1);
    }
  });

  it("attempt 0 with limit 0 => failed immediately with retry-exhausted", () => {
    const ctx = makeCtx(); // defaultRetryLimit = 0
    const result = handleNodeFailed(0, "a", nodeFailedError, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("attempt equals limit => failed with retry-exhausted (at limit not within limit)", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 2]]) }); // at limit
    const result = handleNodeFailed(0, "a", nodeFailedError, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("retry-exhausted");
    }
  });

  it("retry-exhausted carries nodeId, attempts, and lastError from node-crash", () => {
    const ctx = makeCtx(); // defaultRetryLimit = 0
    const result = handleNodeFailed(0, "a", nodeFailedError, ctx);
    expect(result.state).toMatchObject({
      kind: "failed",
      error: {
        kind: "retry-exhausted",
        nodeId: "a",
        attempts: 1,
        lastError: "boom",
      },
    });
  });

  it("retry-exhausted stringifies non-node-crash errors", () => {
    const ctx = makeCtx();
    const nonCrashError: FrameworkError = { kind: "rejected", nodeId: "a", reason: "bad output" };
    const result = handleNodeFailed(0, "a", nonCrashError, ctx);
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
    const ctx = makeCtx({ outputs: new Map([["a", "out"]]) });
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { action: "approve" }, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("approve-with-edit updates output then advances", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "old"]]) });
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { action: "approve-with-edit", newOutput: "new" }, ctx);
    expect(result.context.outputs.get("a")).toBe("new");
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("reject => failed with rejected error", () => {
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { action: "reject", reason: "bad" }, makeCtx());
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "rejected" } });
  });

  it("reroute backward => running at target wave", () => {
    const ctx = makeCtx({ waves: [["a"], ["b"], ["c"]], outputs: new Map([["a", "out"], ["b", "b"], ["c", "c"]]) });
    const state = awaitingHuman("c", [], 2);
    const result = handleHumanResponse(state, { action: "reroute", targetNodeId: "a" }, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 0 });
    expect(result.context.outputs.has("a")).toBe(false); // all cleared from wave 0+
  });

  it("reroute forward => failed with invalid-reroute", () => {
    const ctx = makeCtx({ waves: [["a"], ["b"], ["c"]] });
    const state = awaitingHuman("a", [], 0);
    const result = handleHumanResponse(state, { action: "reroute", targetNodeId: "c" }, ctx);
    expect(result.state).toMatchObject({ kind: "failed", error: { kind: "invalid-reroute" } });
  });
});

// ---------------------------------------------------------------------------
// advanceToNextWave — unit tests
// ---------------------------------------------------------------------------

describe("advanceToNextWave", () => {
  it("more waves remaining => running next wave", () => {
    const ctx = makeCtx({ waves: [["a"], ["b"]] });
    const result = advanceToNextWave(0, ctx);
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("no more waves => succeeded", () => {
    const ctx = makeCtx({ waves: [["a"]], outputs: new Map([["a", "out"]]) });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("succeeded");
  });

  it("uses outputNodeId from dag when succeeding", () => {
    const dag = makeDag({ outputNodeId: "a" });
    const ctx = makeCtx({ dag, waves: [["a"]], outputs: new Map([["a", "the-output"]]) });
    const result = advanceToNextWave(0, ctx);
    expect(result.state).toMatchObject({ kind: "succeeded", output: "the-output" });
  });

  it("fails when outputNodeId set but output not in ctx.outputs (F3)", () => {
    const dag = makeDag({ outputNodeId: "a" });
    // outputs map is empty — 'a' not present
    const ctx = makeCtx({ dag, waves: [["a"]], outputs: new Map() });
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
    // waves has an empty last entry
    const ctx = makeCtx({ waves: [[]] as unknown as readonly (readonly string[])[], outputs: new Map() });
    const result = advanceToNextWave(-1, ctx); // nextWave = 0 >= waves.length=1? No. Need to reach terminal.
    // Actually use makeCtx with waves so that nextWave >= waves.length
    const ctx2 = makeCtx({ waves: [[]], outputs: new Map() });
    const result2 = advanceToNextWave(0, ctx2);
    // nextWave=1 >= waves.length=1 => terminal; last wave is [], so should fail
    expect(result2.state.kind).toBe("failed");
    if (result2.state.kind === "failed") {
      expect(result2.state.error.kind).toBe("node-crash");
    }
  });

  it("falls back to last node (deepest topo) of last wave if no outputNodeId", () => {
    const ctx = makeCtx({ waves: [["a", "b"]], outputs: new Map([["a", "a-out"], ["b", "b-out"]]) });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      // fallback: last node (deepest topo) in last wave = "b"
      expect(result.state.output).toBe("b-out");
    }
  });

  it("fails when outputNodeId unset, last wave non-empty, but fallback node output missing (F11)", () => {
    // last wave has node "a" but outputs map is empty
    const ctx = makeCtx({ waves: [["a"]], outputs: new Map() });
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
      edges: [],
    });
    const ctx = makeCtx({ dag, waves: [["z", "m", "a"]] });
    const queue = collectHumanReviewQueue(ctx, 0);
    expect(queue).toEqual(["a", "m", "z"]);
  });

  it("only nodes in the current wave are included", () => {
    const dag = makeDag({
      nodes: [
        makeNode("a", { humanReview: { prompt: "A" } }),
        makeNode("b"),
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const ctx = makeCtx({ dag, waves: [["a"], ["b"]] });
    // Wave 1 only — "b" has no humanReview
    const queue1 = collectHumanReviewQueue(ctx, 1);
    expect(queue1).toEqual([]);
    // Wave 0 only — "a" has humanReview
    const queue0 = collectHumanReviewQueue(ctx, 0);
    expect(queue0).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// computeBackoffMs — unit tests
// ---------------------------------------------------------------------------

describe("computeBackoffMs", () => {
  it("returns base delay (no jitter) when no node retry config", () => {
    const dag = makeDag();
    const ctx = makeCtx({ dag });
    const delay = computeBackoffMs("a", 0, ctx.dag);
    // Default: [1000, 2000, 4000] — returns base 1000 (executor applies jitter)
    expect(delay).toBe(1000);
  });

  it("returns base delay (no jitter) with node-specific backoff config", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { retry: { backoffMs: [500, 1000], jitterRatio: 0.1 } })],
    });
    const delay = computeBackoffMs("a", 0, dag);
    // Base: 500 (executor applies jitter separately)
    expect(delay).toBe(500);
  });

  it("clamps to last backoff value for attempts beyond list length", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { retry: { backoffMs: [100, 200], jitterRatio: 0 } })],
    });
    const delay = computeBackoffMs("a", 10, dag); // attempt 10, only 2 entries
    // Last entry: 200 (base, no jitter)
    expect(delay).toBe(200);
  });

  it("advances through backoff list with attempt index", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { retry: { backoffMs: [100, 500, 2000] } })],
    });
    expect(computeBackoffMs("a", 0, dag)).toBe(100);
    expect(computeBackoffMs("a", 1, dag)).toBe(500);
    expect(computeBackoffMs("a", 2, dag)).toBe(2000);
    expect(computeBackoffMs("a", 5, dag)).toBe(2000); // clamped
  });
});

// ---------------------------------------------------------------------------
// getRetryLimit — unit tests
// ---------------------------------------------------------------------------

describe("getRetryLimit", () => {
  it("returns 0 when no limits configured", () => {
    const ctx = makeCtx();
    expect(getRetryLimit("a", ctx)).toBe(0);
  });

  it("returns defaultRetryLimit when no per-node override", () => {
    const dag = makeDag({ defaultRetryLimit: 3 });
    const ctx = makeCtx({ dag });
    expect(getRetryLimit("a", ctx)).toBe(3);
  });

  it("returns per-node limit overriding default", () => {
    const dag = makeDag({ defaultRetryLimit: 1, retryLimits: { a: 5 } });
    const ctx = makeCtx({ dag });
    expect(getRetryLimit("a", ctx)).toBe(5);
    expect(getRetryLimit("b", ctx)).toBe(1); // no override => default
  });
});

// ---------------------------------------------------------------------------
// waveNodes / waveIndexOf — unit tests
// ---------------------------------------------------------------------------

describe("waveNodes / waveIndexOf", () => {
  const ctx = makeCtx({ waves: [["a"], ["b", "c"], ["d"]] });

  it("waveNodes returns nodes in wave", () => {
    expect(waveNodes(ctx, 1)).toEqual(["b", "c"]);
  });

  it("waveNodes returns empty array for out-of-bounds wave", () => {
    expect(waveNodes(ctx, 99)).toEqual([]);
  });

  it("waveIndexOf finds the correct wave", () => {
    expect(waveIndexOf(ctx, "b")).toBe(1);
    expect(waveIndexOf(ctx, "d")).toBe(2);
    expect(waveIndexOf(ctx, "a")).toBe(0);
  });

  it("waveIndexOf returns -1 for unknown node", () => {
    expect(waveIndexOf(ctx, "nonexistent")).toBe(-1);
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
      edges: [{ from: "a", to: "b" }],
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
    expect(initialContext.waves).toEqual([["a"], ["b"]]);
    expect(initialContext.initialInput).toEqual({ input: "hello" });
  });

  it("threads initialInput into context", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const dag = defineDagFromArray({ id: "d", nodes: [makeNode("a")], edges: [] });
    const compiled = compileDagToMachine(dag, "my-input");
    if (!compiled.ok) throw new Error("compile failed in test setup");
    expect(compiled.value.initialContext.initialInput).toBe("my-input");
  });

  it("stateProgress maps phases to expected values", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const dag = defineDagFromArray({
      id: "simple",
      nodes: [makeNode("a")],
      edges: [],
    });
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { machine } = compiled.value;
    expect(machine.stateProgress({ kind: "pending" })).toBe(0);
    expect(machine.stateProgress({ kind: "running", wave: 0 })).toBe(10);
    expect(machine.stateProgress({ kind: "retrying", wave: 0, nodeId: "a", attempt: 1, nextDelayMs: 1000 })).toBe(10);
    expect(machine.stateProgress({ kind: "awaiting-human", nodeId: "a", output: null, prompt: "", pendingReviews: [], wave: 0 })).toBe(50);
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
    r = dagTransition(phase, { type: "wave-done", wave: 0, outputs: new Map([["a", 1]]) }, r.context);
    expect(r.state).toMatchObject({ kind: "running", wave: 1 });
    phase = r.state;

    // wave 1 done
    r = dagTransition(phase, { type: "wave-done", wave: 1, outputs: new Map([["b", 2]]) }, r.context);
    expect(r.state).toMatchObject({ kind: "running", wave: 2 });
    phase = r.state;

    // wave 2 done
    r = dagTransition(phase, { type: "wave-done", wave: 2, outputs: new Map([["c", 3]]) }, r.context);
    expect(r.state.kind).toBe("succeeded");
  });

  it("retry path: node-failed -> retrying -> wave-done -> succeeded", () => {
    const dag = makeDag({ defaultRetryLimit: 1 });
    const ctx = makeCtx({ dag });
    let phase: DagPhase = { kind: "running", wave: 0 };
    let currentCtx = ctx;

    // first failure
    let r = dagTransition(phase, { type: "node-failed", nodeId: "a", error: nodeFailedError }, currentCtx);
    expect(r.state.kind).toBe("retrying");
    phase = r.state;
    currentCtx = r.context;

    // retry succeeds — wave done
    r = dagTransition(phase, { type: "wave-done", wave: 0, outputs: new Map([["a", "recovered"]]) }, currentCtx);
    expect(r.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("HITL round-trip: running -> awaiting-human -> approve -> succeeded", () => {
    const dag = makeDag({
      nodes: [makeNode("a", { humanReview: { prompt: "Review" } })],
      edges: [],
    });
    const ctx = makeCtx({ dag, waves: [["a"]] });
    let phase: DagPhase = { kind: "running", wave: 0 };
    let currentCtx = ctx;

    // wave done => awaiting-human
    let r = dagTransition(phase, { type: "wave-done", wave: 0, outputs: new Map([["a", "result"]]) }, currentCtx);
    expect(r.state.kind).toBe("awaiting-human");
    phase = r.state;
    currentCtx = r.context;

    // human approves => succeeded (single-wave DAG)
    r = dagTransition(phase, { type: "human-responded", nodeId: "a", action: { action: "approve" } }, currentCtx);
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
    nodeId,
    output: { result: "preserved-output" },
    prompt: "original-prompt",
    pendingReviews,
    wave,
  });

  it("awaiting-human + node-failed within budget => retrying-hook with preserved output and prompt", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a", [], 0);
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.nodeId).toBe("a");
      expect(result.state.output).toEqual({ result: "preserved-output" });
      expect(result.state.prompt).toBe("original-prompt");
      expect(result.state.attempt).toBe(1);
      expect(result.state.nextDelayMs).toBeGreaterThan(0);
      expect(result.state.pendingReviews).toEqual([]);
      expect(result.state.wave).toBe(0);
    }
  });

  it("awaiting-human + node-failed budget exhausted => terminal failed with node-crash", () => {
    const dag = makeDag({ defaultRetryLimit: 0 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a");
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
      if (result.state.error.kind === "node-crash") {
        expect(result.state.error.nodeId).toBe("a");
        expect(result.state.error.message).toBe("boom");
      }
    }
  });

  it("awaiting-human + ERROR within budget => retrying-hook", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a");
    const event: DagEvent = { type: "ERROR", retriable: true, error: "hook network failure" };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.nodeId).toBe("a");
      expect(result.state.output).toEqual({ result: "preserved-output" });
    }
  });

  it("awaiting-human + ERROR budget exhausted => terminal failed with node-crash", () => {
    const dag = makeDag({ defaultRetryLimit: 0 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a");
    const event: DagEvent = { type: "ERROR", retriable: false, error: "hook blew up" };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
    }
  });

  it("awaiting-human hook-crash preserves pendingReviews and wave in retrying-hook", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a", ["b", "c"], 2);
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.pendingReviews).toEqual(["b", "c"]);
      expect(result.state.wave).toBe(2);
    }
  });

  it("awaiting-human + node-failed with mismatched nodeId => no-op", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag });
    const phase = awaitingWithPrompt("a", [], 0);
    // Event targets node "b", but we are awaiting-human for node "a"
    const mismatchedError: FrameworkError = { kind: "node-crash", nodeId: "b", message: "wrong node" };
    const event: DagEvent = { type: "node-failed", nodeId: "b", error: mismatchedError };
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
    nodeId: "a",
    output: { result: "preserved-output" },
    prompt: "original-prompt",
    attempt,
    nextDelayMs: 1000,
    pendingReviews,
    wave,
  });

  it("retrying-hook + human-responded approve => resolves (no pending reviews => next wave)", () => {
    const ctx = makeCtx({ outputs: new Map([["a", { result: "preserved-output" }]]) });
    const phase = retryingHookPhase(1, [], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a", action: { action: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("retrying-hook + human-responded reject => failed with rejected error", () => {
    const ctx = makeCtx();
    const phase = retryingHookPhase(1, [], 0);
    const event: DagEvent = {
      type: "human-responded",
      nodeId: "a",
      action: { action: "reject", reason: "still not good" },
    };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({
      kind: "failed",
      error: { kind: "rejected", nodeId: "a", reason: "still not good" },
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
      waves: [["a", "b"]],
      outputs: new Map([["a", "a-out"], ["b", "b-out"]]),
    });
    const phase = retryingHookPhase(1, ["b"], 0);
    const event: DagEvent = { type: "human-responded", nodeId: "a", action: { action: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toMatchObject({ kind: "awaiting-human", nodeId: "b" });
  });

  it("retrying-hook + node-failed again within budget => stays in retrying-hook with incremented attempt", () => {
    const dag = makeDag({ defaultRetryLimit: 3 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) });
    const phase = retryingHookPhase(1);
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("retrying-hook");
    if (result.state.kind === "retrying-hook") {
      expect(result.state.attempt).toBe(2);
    }
  });

  it("retrying-hook + node-failed when budget exhausted => terminal failed with node-crash", () => {
    const dag = makeDag({ defaultRetryLimit: 2 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 2]]) });
    const phase = retryingHookPhase(2);
    const event: DagEvent = { type: "node-failed", nodeId: "a", error: nodeFailedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
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
    const event: DagEvent = { type: "human-responded", nodeId: "b", action: { action: "approve" } };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
  });

  it("retrying-hook + approve-with-edit replaces output and advances", () => {
    const ctx = makeCtx({ outputs: new Map([["a", "original"]]) });
    const phase = retryingHookPhase(1, [], 0);
    const event: DagEvent = {
      type: "human-responded",
      nodeId: "a",
      action: { action: "approve-with-edit", newOutput: "edited" },
    };
    const result = dagTransition(phase, event, ctx);

    expect(result.context.outputs.get("a")).toBe("edited");
    expect(result.state).toMatchObject({ kind: "running", wave: 1 });
  });

  it("retrying-hook + node-failed with mismatched nodeId => no-op", () => {
    const dag = makeDag({ defaultRetryLimit: 3 });
    const ctx = makeCtx({ dag, retries: new Map([["a", 1]]) });
    const phase = retryingHookPhase(1);
    // Event targets node "b", but we are retrying-hook for node "a"
    const mismatchedError: FrameworkError = { kind: "node-crash", nodeId: "b", message: "wrong node" };
    const event: DagEvent = { type: "node-failed", nodeId: "b", error: mismatchedError };
    const result = dagTransition(phase, event, ctx);

    expect(result.state).toEqual(phase);
    expect(result.context).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// compileDagToMachine — retrying-hook stateProgress / isTerminal / isFailed
// ---------------------------------------------------------------------------

describe("compileDagToMachine — retrying-hook predicates", () => {
  it("retrying-hook is not terminal and not failed, progress=50", async () => {
    const { compileDagToMachine } = await import("../dag-runtime/machine.js");
    const dag = defineDagFromArray({ id: "d", nodes: [makeNode("a")], edges: [] });
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed in test setup");
    const { machine } = compiled.value;
    const phase: DagPhase = {
      kind: "retrying-hook",
      nodeId: "a",
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
    const e: FrameworkError = { kind: "rejected", nodeId: "a", reason: "bad" };
    expect(e.kind).toBe("rejected");
  });

  it("invalid-reroute error is assignable", () => {
    const e: FrameworkError = { kind: "invalid-reroute", targetNodeId: "x", message: "fwd" };
    expect(e.kind).toBe("invalid-reroute");
  });
});
