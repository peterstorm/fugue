import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { dagFingerprint, FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import { createTransformNode } from "../nodes/transform.js";
import type { DagDef } from "../types/dag.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { DAG_INPUT } from "../types/ids.js";
import { ok } from "../types/result.js";

const node = (id: string) =>
  createTransformNode({
    id,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    transform: (i) => ok(i),
  });

const dag = (
  id: string,
  nodes: ReturnType<typeof node>[],
  edges: { from: string; to: string }[] = [],
  outputNodeId?: string,
): DagDef => {
  // Add DAG_INPUT edges for root nodes (nodes not appearing as `to` in any edge).
  const toSet = new Set(edges.map((e) => e.to));
  const dagInputEdges = nodes
    .filter((n) => !toSet.has(n.id as string))
    .map((n) => ({ from: DAG_INPUT as string, to: n.id as string }));
  return defineDagFromArray({
    id,
    nodes,
    edges: [...dagInputEdges, ...edges],
    outputNodeId,
  });
};

describe("dagFingerprint", () => {
  it("is stable for the same DAG shape", () => {
    const a = dag("d", [node("A"), node("B")], [{ from: "A", to: "B" }]);
    const b = dag("d", [node("A"), node("B")], [{ from: "A", to: "B" }]);
    expect(dagFingerprint(a)).toBe(dagFingerprint(b));
  });

  it("is independent of node declaration order", () => {
    const a = dag("d", [node("A"), node("B")], [{ from: "A", to: "B" }]);
    const b = dag("d", [node("B"), node("A")], [{ from: "A", to: "B" }]);
    expect(dagFingerprint(a)).toBe(dagFingerprint(b));
  });

  it("changes when a node is added", () => {
    const a = dag("d", [node("A")]);
    const b = dag("d", [node("A"), node("B")], [{ from: "A", to: "B" }]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when a node is renamed", () => {
    const a = dag("d", [node("A"), node("B")], [{ from: "A", to: "B" }]);
    const b = dag("d", [node("A"), node("C")], [{ from: "A", to: "C" }]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when edges are rewired", () => {
    const a = dag("d", [node("A"), node("B"), node("C")], [{ from: "A", to: "C" }]);
    const b = dag("d", [node("A"), node("B"), node("C")], [{ from: "B", to: "C" }]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when outputNodeId changes", () => {
    const a = dag("d", [node("A"), node("B")], [{ from: "A", to: "B" }], "A");
    const b = dag("d", [node("A"), node("B")], [{ from: "A", to: "B" }], "B");
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });

  it("changes when DAG id changes", () => {
    const a = dag("d1", [node("A")]);
    const b = dag("d2", [node("A")]);
    expect(dagFingerprint(a)).not.toBe(dagFingerprint(b));
  });
});

describe("FRAMEWORK_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof FRAMEWORK_VERSION).toBe("string");
    expect(FRAMEWORK_VERSION.length).toBeGreaterThan(0);
  });
});

// Wave 6 §6.15 — byte-stability golden test. A drift in dagFingerprint's
// output bytes is a checkpoint-compatibility breaking change and must come
// with a FRAMEWORK_VERSION bump. The golden file at __fixtures__/dag-
// fingerprint.golden pins the exact sha256 for a canonical DAG shape; if
// this test fails because the fingerprint algorithm changed deliberately,
// bump FRAMEWORK_VERSION and regenerate the golden.
describe("dagFingerprint byte-stability (§6.15)", () => {
  const goldenDag = () =>
    defineDagFromArray({
      id: "golden-dag",
      nodes: [node("fetch"), node("classify"), node("synthesize"), node("guardrail")],
      edges: [
        { from: DAG_INPUT as string, to: "fetch" },
        { from: "fetch", to: "classify" },
        { from: "classify", to: "synthesize" },
        { from: "synthesize", to: "guardrail" },
      ],
      outputNodeId: "guardrail",
    });

  it("recompute is bit-identical to first compute (intra-process)", () => {
    const d = goldenDag();
    expect(dagFingerprint(d)).toBe(dagFingerprint(d));
  });

  it("matches the pinned golden sha256", () => {
    // Golden value pinned inline. The fixture file at
    // __fixtures__/dag-fingerprint.golden tracks the same value for
    // human inspection; keep them in sync if the algorithm is bumped
    // (which requires a FRAMEWORK_VERSION bump — see
    // checkpoint/fingerprint.ts comment).
    const GOLDEN_SHA = "37abe48d9a4508c6765d029ead2c8a5cc3a5e87e905de20af1f93f394f6b9cd3";
    const actual = dagFingerprint(goldenDag());
    expect(actual).toBe(GOLDEN_SHA);
  });
});
