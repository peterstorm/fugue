import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  handleWaveDone,
  advanceToNextWave,
  collectHumanReviewQueue,
  activeWaveNodes,
  waveIndexOf,
} from "../dag-runtime/wave-resolution.js";
import type { Decision } from "../dag-runtime/routing.js";
import type { DagDef, EdgeDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import { nonEmptyString } from "../types/non-empty-string.js";
import { N, D, nodeMap, nodeSet } from "./_id-helpers.js";
import { testRuntimeContext as mkCtx } from "./_context-factories.js";

// ---------------------------------------------------------------------------
// Minimal test fixtures
// ---------------------------------------------------------------------------

const mkNodeDef = (id: string, opts?: { humanReview?: { prompt: string } }): NodeDef<unknown, unknown> => ({
  id: N(id),
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  requires: [] as const,
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  run: async (i: unknown) => ({ ok: true, value: i }),
  ...(opts?.humanReview ? { humanReview: { prompt: nonEmptyString(opts.humanReview.prompt) } } : {}),
});

const mkEdge = (from: string, to: string): EdgeDef => ({
  from: N(from),
  to: N(to),
  kind: "unconditional",
});

// ---------------------------------------------------------------------------
// activeWaveNodes
// ---------------------------------------------------------------------------

describe("activeWaveNodes", () => {
  it("filters out pruned nodes", () => {
    const ctx = mkCtx({
      waves: [[N("a"), N("b"), N("c")]],
      activeNodeIds: nodeSet(["a", "c"]),
    });
    expect(activeWaveNodes(ctx, 0)).toEqual([N("a"), N("c")]);
  });

  it("returns empty for out-of-range wave", () => {
    const ctx = mkCtx({ waves: [[N("a")]], activeNodeIds: nodeSet(["a"]) });
    expect(activeWaveNodes(ctx, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// waveIndexOf
// ---------------------------------------------------------------------------

describe("waveIndexOf", () => {
  it("finds the wave containing a node", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b"), N("c")]],
    });
    expect(waveIndexOf(ctx, N("b"))).toBe(1);
  });

  it("returns -1 for unknown node", () => {
    const ctx = mkCtx({ waves: [[N("a")]] });
    expect(waveIndexOf(ctx, N("z"))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// collectHumanReviewQueue
// ---------------------------------------------------------------------------

describe("collectHumanReviewQueue", () => {
  it("collects humanReview nodes from the wave, sorted ascending", () => {
    const ctx = mkCtx({
      waves: [[N("c"), N("a"), N("b")]],
      activeNodeIds: nodeSet(["a", "b", "c"]),
      humanReviewNodeIds: new Set([N("a"), N("c")]),
      humanReviewPrompts: new Map([[N("a"), "review a"], [N("c"), "review c"]]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "review a" } })],
        ["b", mkNodeDef("b")],
        ["c", mkNodeDef("c", { humanReview: { prompt: "review c" } })],
      ]),
    });
    const queue = collectHumanReviewQueue(ctx, 0);
    expect(queue).toEqual([N("a"), N("c")]);
  });

  it("returns empty when no humanReview nodes", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      activeNodeIds: nodeSet(["a"]),
      nodeById: nodeMap([["a", mkNodeDef("a")]]),
    });
    expect(collectHumanReviewQueue(ctx, 0)).toEqual([]);
  });

  it("skips pruned nodes", () => {
    const ctx = mkCtx({
      waves: [[N("a"), N("b")]],
      activeNodeIds: nodeSet(["a"]), // b pruned
      nodeById: nodeMap([
        ["a", mkNodeDef("a")],
        ["b", mkNodeDef("b", { humanReview: { prompt: "review b" } })],
      ]),
    });
    expect(collectHumanReviewQueue(ctx, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleWaveDone — output merge
// ---------------------------------------------------------------------------

describe("handleWaveDone — output merge", () => {
  it("merges new outputs into context", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")]],
      activeNodeIds: nodeSet(["a", "b"]),
      outputs: nodeMap([["a", "old-a"]]),
      nodeById: nodeMap([["a", mkNodeDef("a")], ["b", mkNodeDef("b")]]),
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("b") } as unknown as DagDef,
    });
    const newOutputs = nodeMap([["a", "new-a"]]);
    const result = handleWaveDone(0, newOutputs, ctx, new Map());
    expect(result.context.outputs.get(N("a"))).toBe("new-a");
  });
});

// ---------------------------------------------------------------------------
// handleWaveDone — HITL queue
// ---------------------------------------------------------------------------

describe("handleWaveDone — human review queue", () => {
  it("enters awaiting-human for first review node", () => {
    const ctx = mkCtx({
      waves: [[N("a"), N("b")]],
      activeNodeIds: nodeSet(["a", "b"]),
      humanReviewNodeIds: new Set([N("a")]),
      humanReviewPrompts: new Map([[N("a"), "review a"]]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "review a" } })],
        ["b", mkNodeDef("b")],
      ]),
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const outputs = nodeMap([["a", "output-a"], ["b", "output-b"]]);
    const result = handleWaveDone(0, outputs, ctx, new Map());
    expect(result.state.kind).toBe("awaiting-human");
    if (result.state.kind === "awaiting-human") {
      expect(result.state.nodeId).toBe(N("a"));
      expect(result.state.output).toBe("output-a");
      expect(result.state.prompt).toBe("review a");
      expect(result.state.pendingReviews).toEqual([]);
    }
  });

  it("queues multiple review nodes in ascending order", () => {
    const ctx = mkCtx({
      waves: [[N("c"), N("a")]],
      activeNodeIds: nodeSet(["a", "c"]),
      humanReviewNodeIds: new Set([N("a"), N("c")]),
      humanReviewPrompts: new Map([[N("a"), "a"], [N("c"), "c"]]),
      nodeById: nodeMap([
        ["a", mkNodeDef("a", { humanReview: { prompt: "a" } })],
        ["c", mkNodeDef("c", { humanReview: { prompt: "c" } })],
      ]),
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const outputs = nodeMap([["a", "A"], ["c", "C"]]);
    const result = handleWaveDone(0, outputs, ctx, new Map());
    expect(result.state.kind).toBe("awaiting-human");
    if (result.state.kind === "awaiting-human") {
      expect(result.state.nodeId).toBe(N("a"));
      expect(result.state.pendingReviews).toEqual([N("c")]);
    }
  });

});

// ---------------------------------------------------------------------------
// handleWaveDone — routing decisions
// ---------------------------------------------------------------------------

describe("handleWaveDone — precomputed routing decisions", () => {
  it("expands active set via precomputed decisions", () => {
    const ctx = mkCtx({
      waves: [[N("router")], [N("a"), N("b")]],
      activeNodeIds: nodeSet(["router"]),
      nodeById: nodeMap([
        ["router", mkNodeDef("router")],
        ["a", mkNodeDef("a")],
        ["b", mkNodeDef("b")],
      ]),
      outgoingByNode: nodeMap([
        ["router", [
          { from: N("router"), to: N("a"), kind: "conditional" as const, when: { label: "x", version: 1, check: () => true } },
          { from: N("router"), to: N("b"), kind: "default" as const },
        ]],
      ]),
      dag: { id: D("test"), nodes: [], edges: [
        mkEdge("router", "a"),
        mkEdge("router", "b"),
      ], outputNodeId: N("a") } as unknown as DagDef,
    });
    const outputs = nodeMap([["router", { kind: "yes" }]]);
    const decisions = new Map<ReturnType<typeof N>, Decision>([
      [N("router"), {
        kind: "decided",
        chosenTargets: nodeSet(["a"]),
        prunedTargets: nodeSet(["b"]),
        defaultTaken: false,
        predicateResults: [],
      }],
    ]);
    const result = handleWaveDone(0, outputs, ctx, decisions);
    // a should now be active
    expect(result.context.activeNodeIds.has(N("a"))).toBe(true);
  });

  it("predicate-malformed in precomputed decision → failed", () => {
    const ctx = mkCtx({
      waves: [[N("router")]],
      activeNodeIds: nodeSet(["router"]),
      nodeById: nodeMap([["router", mkNodeDef("router")]]),
      outgoingByNode: new Map(),
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const outputs = nodeMap([["router", {}]]);
    const decisions = new Map<ReturnType<typeof N>, Decision>([
      [N("router"), {
        kind: "predicate-malformed",
        fromNodeId: N("router"),
        message: "broken predicate",
      }],
    ]);
    const result = handleWaveDone(0, outputs, ctx, decisions);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("predicate-malformed");
    }
  });
});

// ---------------------------------------------------------------------------
// advanceToNextWave
// ---------------------------------------------------------------------------

describe("advanceToNextWave", () => {
  it("advances to next wave when more waves remain", () => {
    const ctx = mkCtx({ waves: [[N("a")], [N("b")]] });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("running");
    if (result.state.kind === "running") {
      expect(result.state.wave).toBe(1);
    }
  });

  it("succeeds with explicit outputNodeId", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      outputs: nodeMap([["a", "result"]]),
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("a") } as unknown as DagDef,
    });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      expect(result.state.output).toBe("result");
    }
  });

  it("fails when explicit outputNodeId not in outputs", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      outputs: new Map(), // a never produced output
      dag: { id: D("test"), nodes: [], edges: [], outputNodeId: N("a") } as unknown as DagDef,
    });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
    }
  });

  it("falls back to last active node when no outputNodeId", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")]],
      outputs: nodeMap([["a", "A"], ["b", "B"]]),
      activeNodeIds: nodeSet(["a", "b"]),
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const result = advanceToNextWave(1, ctx);
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      expect(result.state.output).toBe("B");
    }
  });

  it("walks back through waves when final wave is fully pruned", () => {
    const ctx = mkCtx({
      waves: [[N("a")], [N("b")]],
      outputs: nodeMap([["a", "A"]]), // b never ran (pruned)
      activeNodeIds: nodeSet(["a"]),   // b not active
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const result = advanceToNextWave(1, ctx);
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      expect(result.state.output).toBe("A");
    }
  });

  it("fails when no active node produced output", () => {
    const ctx = mkCtx({
      waves: [[N("a")]],
      outputs: new Map(),
      activeNodeIds: new Set(),
      dag: { id: D("test"), nodes: [], edges: [] } as unknown as DagDef,
    });
    const result = advanceToNextWave(0, ctx);
    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("node-crash");
      if (result.state.error.kind === "node-crash") {
        expect(result.state.error.message).toContain("output-missing");
      }
    }
  });
});
