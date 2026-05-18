import { describe, it, expect } from "bun:test";
import { handleHumanResponse } from "../dag-runtime/human-resolution.js";
import type { DagMachineContext, DagPhase, HumanAction } from "../dag-runtime/types.js";
import type { DagDef, EdgeDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import { N, D, nodeMap, nodeSet } from "./_id-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mkNodeDef = (id: string, opts?: { humanReview?: { prompt: string } }): NodeDef<unknown, unknown> => ({
  id: N(id),
  kind: "transform",
  inputSchema: { parse: (x: unknown) => x } as any,
  outputSchema: { parse: (x: unknown) => x } as any,
  requires: [] as const,
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  run: async (i: unknown) => ({ ok: true, value: i } as any),
  ...(opts?.humanReview ? { humanReview: opts.humanReview } : {}),
});

const mkCtx = (overrides: Partial<DagMachineContext> = {}): DagMachineContext => {
  const dag = overrides.dag ?? ({ id: D("test"), nodes: [], edges: [], outputNodeId: undefined } as unknown as DagDef);
  return {
    waves: overrides.waves ?? [],
    outputs: overrides.outputs ?? new Map(),
    retries: overrides.retries ?? new Map(),
    initialInput: null,
    activeNodeIds: overrides.activeNodeIds ?? new Set(),
    dag,
    incomingByNode: overrides.incomingByNode ?? new Map(),
    outgoingByNode: overrides.outgoingByNode ?? new Map(),
    nodeById: overrides.nodeById ?? new Map(),
    retryConfigs: overrides.retryConfigs ?? new Map(),
    outputNodeId: dag.outputNodeId,
    defaultRetryLimit: dag.defaultRetryLimit,
    retryLimits: dag.retryLimits,
    humanReviewNodeIds: overrides.humanReviewNodeIds ?? new Set(
      (dag.nodes ?? []).filter((n: any) => n.humanReview !== undefined).map((n: any) => n.id),
    ),
    humanReviewPrompts: overrides.humanReviewPrompts ?? new Map(
      (dag.nodes ?? []).filter((n: any) => n.humanReview !== undefined).map((n: any) => [n.id, n.humanReview!.prompt] as const),
    ),
    edges: dag.edges ?? [],
    confidenceByNode: new Map(),
    ...overrides,
  };
};

const mkAwaitingHuman = (
  nodeId: string,
  opts?: { pendingReviews?: string[]; wave?: number; output?: unknown },
): Extract<DagPhase, { kind: "awaiting-human" }> => ({
  kind: "awaiting-human",
  nodeId: N(nodeId),
  output: opts?.output ?? `output-${nodeId}`,
  prompt: `review ${nodeId}`,
  pendingReviews: (opts?.pendingReviews ?? []).map(N),
  wave: opts?.wave ?? 0,
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

describe("handleHumanResponse — approve", () => {
  it("advances to next wave after approve with no pending reviews", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")]],
      outputs: nodeMap([["a", "A"]]),
      activeNodeIds: nodeSet(["a", "b"]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "r" } })],
        ["b", mkNodeDef("b")],
      ]),
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("b") } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("a");
    const action: HumanAction = { action: "approve" };
    const result = handleHumanResponse(state, action, ctx);
    expect(result.state.kind).toBe("running");
    if (result.state.kind === "running") {
      expect(result.state.wave).toBe(1);
    }
  });

  it("succeeds when approve is the last wave", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      outputs: nodeMap([["a", "A"]]),
      activeNodeIds: nodeSet(["a"]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "r" } })],
      ]),
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("a") } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("a");
    const result = handleHumanResponse(state, { action: "approve" }, ctx);
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      expect(result.state.output).toBe("A");
    }
  });
});

// ---------------------------------------------------------------------------
// approve-with-edit
// ---------------------------------------------------------------------------

describe("handleHumanResponse — approve-with-edit", () => {
  it("replaces the node output and advances", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      outputs: nodeMap([["a", "original"]]),
      activeNodeIds: nodeSet(["a"]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "r" } })],
      ]),
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("a") } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("a", { output: "original" });
    const result = handleHumanResponse(
      state,
      { action: "approve-with-edit", newOutput: "edited" },
      ctx,
    );
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      expect(result.state.output).toBe("edited");
    }
    expect(result.context.outputs.get(N("a"))).toBe("edited");
  });
});

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

describe("handleHumanResponse — reject", () => {
  it("transitions to failed with rejected error", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      outputs: nodeMap([["a", "A"]]),
    });
    const state = mkAwaitingHuman("a");
    const result = handleHumanResponse(
      state,
      { action: "reject", reason: "bad quality" },
      ctx,
    );
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("rejected");
      if (result.state.error.kind === "rejected") {
        expect(result.state.error.nodeId).toBe(N("a"));
        expect(result.state.error.reason).toBe("bad quality");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// reroute — backward
// ---------------------------------------------------------------------------

describe("handleHumanResponse — reroute backward", () => {
  it("resets to target wave, clears later outputs and retries", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")], [N("c")]],
      outputs: nodeMap([["a", "A"], ["b", "B"], ["c", "C"]]),
      retries: nodeMap([["b", 1], ["c", 2]]),
      activeNodeIds: nodeSet(["a", "b", "c"]),
      outgoingByNode: new Map(), // no conditional edges
      nodeById: nodeMap([
        ["a", mkNodeDef("a")],
        ["b", mkNodeDef("b", { humanReview: { prompt: "r" } })],
        ["c", mkNodeDef("c")],
      ]),
      dag: { id: D("test"), nodes: [], edges: [
        { from: N("a"), to: N("b"), kind: "unconditional" as const },
        { from: N("b"), to: N("c"), kind: "unconditional" as const },
      ] } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("b", { wave: 1 });
    const result = handleHumanResponse(
      state,
      { action: "reroute", targetNodeId: N("a") },
      ctx,
    );
    expect(result.state.kind).toBe("running");
    if (result.state.kind === "running") {
      expect(result.state.wave).toBe(0);
    }
    // Outputs from wave >= target should be cleared
    expect(result.context.outputs.has(N("a"))).toBe(false); // wave 0 = target, cleared
    expect(result.context.outputs.has(N("b"))).toBe(false);
    expect(result.context.outputs.has(N("c"))).toBe(false);
    // Retries from wave >= target should be cleared
    expect(result.context.retries.has(N("b"))).toBe(false);
    expect(result.context.retries.has(N("c"))).toBe(false);
  });

  it("preserves outputs from waves before target", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")], [N("c")]],
      outputs: nodeMap([["a", "A"], ["b", "B"]]),
      retries: new Map(),
      activeNodeIds: nodeSet(["a", "b", "c"]),
      outgoingByNode: new Map(),
      nodeById: nodeMap([
        ["a", mkNodeDef("a")],
        ["b", mkNodeDef("b", { humanReview: { prompt: "r" } })],
        ["c", mkNodeDef("c")],
      ]),
      dag: { id: D("test"), nodes: [], edges: [
        { from: N("a"), to: N("b"), kind: "unconditional" as const },
        { from: N("b"), to: N("c"), kind: "unconditional" as const },
      ] } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("c", { wave: 2 });
    const result = handleHumanResponse(
      state,
      { action: "reroute", targetNodeId: N("b") },
      ctx,
    );
    expect(result.state.kind).toBe("running");
    if (result.state.kind === "running") {
      expect(result.state.wave).toBe(1);
    }
    // wave 0 output should survive
    expect(result.context.outputs.get(N("a"))).toBe("A");
    // wave 1+ outputs cleared
    expect(result.context.outputs.has(N("b"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reroute — forward (invalid)
// ---------------------------------------------------------------------------

describe("handleHumanResponse — reroute forward (invalid)", () => {
  it("rejects forward reroute with invalid-reroute error", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")], [N("c")]],
      outputs: nodeMap([["a", "A"]]),
      activeNodeIds: nodeSet(["a", "b", "c"]),
    });
    const state = mkAwaitingHuman("a", { wave: 0 });
    const result = handleHumanResponse(
      state,
      { action: "reroute", targetNodeId: N("c") },
      ctx,
    );
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("invalid-reroute");
      if (result.state.error.kind === "invalid-reroute") {
        expect(result.state.error.targetNodeId).toBe(N("c"));
        expect(result.state.error.message).toContain("forward");
      }
    }
  });

  it("rejects reroute to unknown node", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      outputs: nodeMap([["a", "A"]]),
      activeNodeIds: nodeSet(["a"]),
    });
    const state = mkAwaitingHuman("a", { wave: 0 });
    const result = handleHumanResponse(
      state,
      { action: "reroute", targetNodeId: N("nonexistent") },
      ctx,
    );
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("invalid-reroute");
      if (result.state.error.kind === "invalid-reroute") {
        expect(result.state.error.message).toContain("not found");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// pending reviews queue processing
// ---------------------------------------------------------------------------

describe("handleHumanResponse — pending reviews", () => {
  it("processes next pending review after approve", () => {
    const ctx = mkCtx({
      waves: [[N("a"), N("b")]],
      outputs: nodeMap([["a", "A"], ["b", "B"]]),
      activeNodeIds: nodeSet(["a", "b"]),
      humanReviewNodeIds: new Set([N("a"), N("b")]),
      humanReviewPrompts: new Map([[N("a"), "review a"], [N("b"), "review b"]]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "review a" } })],
        ["b", mkNodeDef("b", { humanReview: { prompt: "review b" } })],
      ]),
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("b") } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("a", { pendingReviews: ["b"] });
    const result = handleHumanResponse(state, { action: "approve" }, ctx);
    expect(result.state.kind).toBe("awaiting-human");
    if (result.state.kind === "awaiting-human") {
      expect(result.state.nodeId).toBe(N("b"));
      expect(result.state.output).toBe("B");
      expect(result.state.prompt).toBe("review b");
      expect(result.state.pendingReviews).toEqual([]);
    }
  });

  it("advances to next wave after last pending review approved", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")]],
      outputs: nodeMap([["a", "A"]]),
      activeNodeIds: nodeSet(["a", "b"]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "r" } })],
        ["b", mkNodeDef("b")],
      ]),
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("b") } as unknown as DagDef,
    });
    // No pending reviews left — this is the last one
    const state = mkAwaitingHuman("a", { pendingReviews: [] });
    const result = handleHumanResponse(state, { action: "approve" }, ctx);
    expect(result.state.kind).toBe("running");
    if (result.state.kind === "running") {
      expect(result.state.wave).toBe(1);
    }
  });

  it("fails when pending review node is missing from nodeById", () => {
    const ctx = mkCtx({
      waves: [[N("a"), N("b")]],
      outputs: nodeMap([["a", "A"], ["b", "B"]]),
      activeNodeIds: nodeSet(["a", "b"]),
      humanReviewNodeIds: new Set([N("a")]),
      humanReviewPrompts: new Map([[N("a"), "r"]]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "r" } })],
        // "b" intentionally not in humanReviewNodeIds
      ]),
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("a", { pendingReviews: ["b"] });
    const result = handleHumanResponse(state, { action: "approve" }, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
      if (result.state.error.kind === "node-crash") {
        expect(result.state.error.message).toContain("no humanReview config");
      }
    }
  });

  it("fails when pending review node has no humanReview config", () => {
    const ctx = mkCtx({
      waves: [[N("a"), N("b")]],
      outputs: nodeMap([["a", "A"], ["b", "B"]]),
      activeNodeIds: nodeSet(["a", "b"]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "r" } })],
        ["b", mkNodeDef("b")], // present but no humanReview
      ]),
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const state = mkAwaitingHuman("a", { pendingReviews: ["b"] });
    const result = handleHumanResponse(state, { action: "approve" }, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
      if (result.state.error.kind === "node-crash") {
        expect(result.state.error.message).toContain("no humanReview config");
      }
    }
  });
});
