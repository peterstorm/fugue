// Validator tests for conditional edges — function-based predicates (Phase 2).
//
// Note: after Phase 2, predicates are `{ label, check, minConfidence? }` objects.
// The validator's predicate shape checks now verify label + check + minConfidence.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { validateDagShape } from "../executor/validate-dag.js";
import type { DagDefInput } from "../types/dag.js";
import { createTransformNode } from "../nodes/transform.js";
import { ok } from "../types/result.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

const mkNode = (id: string) =>
  createTransformNode({
    id,
    inputSchema: z.any(),
    outputSchema: z.any(),
    transform: (i) => ok(i),
  });

// Well-formed predicate used wherever the test just needs *some* conditional
// edge. Cast through `any` to build edge arrays in the simple `DagDefInput`
// shape without threading per-edge type inference.
const SOME = { label: "some-pred", check: () => true } as any;

describe("validateDagShape — conditional edges", () => {
  it("rejects missing default edge when conditionals exist", () => {
    const dag: DagDefInput = {
      id: "no-default",
      nodes: { a: mkNode("a"), b: mkNode("b") },
      edges: [{ from: "a", to: "b", when: SOME }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("missing-default-edge");
      if (r.error.kind === "missing-default-edge") {
        expect(r.error.nodeId).toBe(N("a"));
      }
    }
  });

  it("rejects more than one default edge per source (duplicate-edge wins first)", () => {
    const dag: DagDefInput = {
      id: "two-defaults",
      nodes: { a: mkNode("a"), b: mkNode("b"), c: mkNode("c") },
      edges: [
        { from: "a", to: "b", when: SOME },
        { from: "a", to: "c", kind: "default" },
        { from: "a", to: "b", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["duplicate-edge", "missing-default-edge"]).toContain(r.error.kind);
    }
  });

  it("rejects default edge without any conditional out-edge", () => {
    const dag: DagDefInput = {
      id: "lone-default",
      nodes: { a: mkNode("a"), b: mkNode("b") },
      edges: [{ from: "a", to: "b", kind: "default" }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("default edge");
    }
  });

  it("rejects duplicate edges between same (from, to)", () => {
    const dag: DagDefInput = {
      id: "dup-edge",
      nodes: { a: mkNode("a"), b: mkNode("b") },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("duplicate-edge");
    }
  });

  it("rejects outputNodeId not reachable along unconditional + default edges", () => {
    const dag: DagDefInput = {
      id: "unreachable-output",
      nodes: {
        router: mkNode("router"),
        a: mkNode("a"),
        b: mkNode("b"),
      },
      edges: [
        { from: "router", to: "a", when: SOME },
        { from: "router", to: "b", kind: "default" },
      ],
      outputNodeId: "a",
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("output-unreachable-under-routing");
    }
  });

  it("rejects record key/node.id mismatch", () => {
    const dag: DagDefInput = {
      id: "key-mismatch",
      nodes: { wrongKey: mkNode("a") },
      edges: [],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("record key and node.id must match");
    }
  });

  it("rejects a predicate with empty label", () => {
    const dag: DagDefInput = {
      id: "empty-label",
      nodes: {
        a: mkNode("a"),
        b: mkNode("b"),
        c: mkNode("c"),
      },
      edges: [
        { from: "a", to: "b", when: { label: "", check: () => true } as any },
        { from: "a", to: "c", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("label");
    }
  });

  it("rejects a predicate with missing check function", () => {
    const dag: DagDefInput = {
      id: "no-check",
      nodes: {
        a: mkNode("a"),
        b: mkNode("b"),
        c: mkNode("c"),
      },
      edges: [
        { from: "a", to: "b", when: { label: "foo" } as any },
        { from: "a", to: "c", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("check");
    }
  });

  it("rejects a non-object predicate", () => {
    const dag: DagDefInput = {
      id: "bad-pred",
      nodes: {
        a: mkNode("a"),
        b: mkNode("b"),
        c: mkNode("c"),
      },
      edges: [
        { from: "a", to: "b", when: "yes" as any },
        { from: "a", to: "c", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("malformed predicate");
    }
  });

  it("rejects a predicate with invalid minConfidence", () => {
    const dag: DagDefInput = {
      id: "bad-min-conf",
      nodes: {
        a: mkNode("a"),
        b: mkNode("b"),
        c: mkNode("c"),
      },
      edges: [
        { from: "a", to: "b", when: { label: "test", check: () => true, minConfidence: "super-high" } as any },
        { from: "a", to: "c", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("predicate-malformed");
    }
  });

  it("accepts a well-formed conditional DAG with function-based predicates", () => {
    const dag: DagDefInput = {
      id: "ok",
      nodes: {
        router: mkNode("router"),
        a: mkNode("a"),
        b: mkNode("b"),
        merge: mkNode("merge"),
      },
      edges: [
        { from: "router", to: "a", when: { label: "kind-is-yes", check: (v: any) => v?.kind === "yes" } as any },
        { from: "router", to: "b", kind: "default" },
        { from: "a", to: "merge" },
        { from: "b", to: "merge" },
      ],
      outputNodeId: "merge",
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(true);
  });

  it("accepts a predicate with valid minConfidence", () => {
    const dag: DagDefInput = {
      id: "with-min-conf",
      nodes: {
        router: mkNode("router"),
        a: mkNode("a"),
        b: mkNode("b"),
      },
      edges: [
        { from: "router", to: "a", when: { label: "high-conf-route", check: () => true, minConfidence: "medium" } as any },
        { from: "router", to: "b", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(true);
  });
});
