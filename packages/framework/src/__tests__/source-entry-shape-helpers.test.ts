// Source-entry branch of the single-entry shape helpers (C0 / 0.2.0).
//
// Each single-entry shape helper (linear, fan-out, diamond, router) feeds its
// entry node the DAG request via a `$input` edge — UNLESS that entry node is a
// source (`isSource: true`), which consumes nothing and so gets no `$input`
// edge. The shared `dagInputEdgeFor` decides this. The other shape-helper suites
// only ever pass a NON-source entry node, so they exercise only the
// "$input-edge-IS-wired" branch. This suite covers the complementary
// source-entry branch directly (the helper in isolation) and per helper (the
// helper invokes `dagInputEdgeFor` on the right config field), so a regression
// that "helpfully" always wires the `$input` edge — which would make a
// source-rooted helper throw `source-has-incoming` at definition time — is
// caught.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  defineLinearDag,
  defineFanOut,
  defineDiamond,
  defineRouter,
  createSourceNode,
  createTransformNode,
  ok,
} from "../index.js";
import { dagInputEdgeFor } from "../executor/dag-input-edge.js";
import { resourceName } from "../types/freshness.js";

const V = z.object({ v: z.number() });
const B = z.object({ b: z.boolean() });

const src = createSourceNode({ id: "src", outputSchema: V, fetch: async () => ok({ v: 1 }) });
const nonSource = createTransformNode({
  id: "non-source",
  inputSchema: V,
  outputSchema: V,
  transform: (i) => ok(i),
});
const sink = createTransformNode({ id: "sink", inputSchema: V, outputSchema: B, transform: () => ok({ b: true }) });

const hasInputEdge = (dag: { readonly edges: readonly { readonly from: string }[] }): boolean =>
  dag.edges.some((e) => e.from === "$input");

describe("dagInputEdgeFor — source vs non-source entry", () => {
  it("wires a $input→node edge for a non-source entry node", () => {
    expect(dagInputEdgeFor(nonSource)).toEqual([{ from: "$input", to: "non-source" }]);
  });

  it("wires NO edge for a source entry node (it consumes nothing)", () => {
    expect(dagInputEdgeFor(src)).toEqual([]);
  });
});

describe("single-entry shape helpers with a source entry node wire no $input edge", () => {
  it("defineLinearDag — source as the first node", () => {
    const dag = defineLinearDag({ id: "linear-src", nodes: [src, sink] });
    expect(hasInputEdge(dag)).toBe(false);
    // Only the inferred src→sink edge remains.
    expect(dag.edges).toEqual([expect.objectContaining({ from: "src", to: "sink" })]);
  });

  it("defineFanOut — source as the `source` field", () => {
    const branch = createTransformNode({ id: "branch", inputSchema: V, outputSchema: B, transform: () => ok({ b: true }) });
    const dag = defineFanOut({ id: "fanout-src", source: src, branches: [branch] });
    expect(hasInputEdge(dag)).toBe(false);
    expect(dag.edges).toEqual([expect.objectContaining({ from: "src", to: "branch" })]);
  });

  it("defineDiamond — source as the `source` field", () => {
    const branch = createTransformNode({ id: "branch", inputSchema: V, outputSchema: B, transform: () => ok({ b: true }) });
    // Single branch ⇒ join receives a bare value (<2 incoming), so its schema is B.
    const join = createTransformNode({ id: "join", inputSchema: B, outputSchema: B, transform: (i) => ok(i) });
    const dag = defineDiamond({ id: "diamond-src", source: src, branches: [branch], join });
    expect(hasInputEdge(dag)).toBe(false);
  });

  it("defineRouter — source as the `classifier`", () => {
    const targetA = createTransformNode({ id: "target-a", inputSchema: V, outputSchema: B, transform: () => ok({ b: true }) });
    const targetB = createTransformNode({ id: "target-b", inputSchema: V, outputSchema: B, transform: () => ok({ b: false }) });
    const dag = defineRouter({
      id: "router-src",
      classifier: src,
      cases: { positive: { when: (o) => (o as { v: number }).v > 0, to: targetA } },
      default: targetB,
    });
    expect(hasInputEdge(dag)).toBe(false);
  });
});

describe("createSourceNode field defaults", () => {
  it("marks isSource and uses a unit (undefined-accepting) inputSchema", () => {
    expect(src.isSource).toBe(true);
    // A source consumes no DAG input — its schema accepts the always-`undefined`
    // input value (the invariant validate-dag enforces for sources).
    expect(src.inputSchema.safeParse(undefined).success).toBe(true);
  });

  it("defaults sideEffects to { kind: 'reads', resource: id } when omitted", () => {
    expect(src.sideEffects).toEqual({ kind: "reads", resource: resourceName("src") });
  });

  it("honours an explicit sideEffects override", () => {
    const writer = createSourceNode({
      id: "writer",
      outputSchema: V,
      sideEffects: { kind: "writes", resource: resourceName("postgres:audit") },
      fetch: async () => ok({ v: 1 }),
    });
    expect(writer.sideEffects).toEqual({ kind: "writes", resource: resourceName("postgres:audit") });
  });
});
