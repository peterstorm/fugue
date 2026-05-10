// Validator tests for conditional edges (ADR 0015 + ADR 0016 + ADR 0017).
//
// Note: after ADR 0017, deps/optionalDeps no longer exist on NodeDef — the
// validator's deps↔edges symmetry checks are gone. The tests here cover the
// surviving rules: else-totality, predicate shape, duplicate edges, output
// reachability, and record-key consistency.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { validateDagShape } from "../executor/validate-dag.js";
import type { DagDefInput } from "../types/dag.js";
import { createTransformNode } from "../nodes/transform.js";
import { ok } from "../types/result.js";

const mkNode = (id: string) =>
  createTransformNode({
    id,
    inputSchema: z.any(),
    outputSchema: z.any(),
    transform: (i) => ok(i),
  });

// Non-empty predicate used wherever the test just needs *some* conditional
// edge. Cast through `any` so we can build edge arrays in the simple
// `DagDefInput` shape without threading per-edge type inference.
const SOME = { kind: "x" } as any;

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
        expect(r.error.nodeId).toBe("a");
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

  it("rejects an empty predicate `{}` — use an unconditional edge instead", () => {
    const dag: DagDefInput = {
      id: "empty-pred",
      nodes: {
        a: mkNode("a"),
        b: mkNode("b"),
        c: mkNode("c"),
      },
      edges: [
        { from: "a", to: "b", when: {} as any },
        { from: "a", to: "c", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("empty predicate");
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

  it("accepts a well-formed conditional DAG with structural predicates", () => {
    const dag: DagDefInput = {
      id: "ok",
      nodes: {
        router: mkNode("router"),
        a: mkNode("a"),
        b: mkNode("b"),
        merge: mkNode("merge"),
      },
      edges: [
        { from: "router", to: "a", when: { kind: "yes" } as any },
        { from: "router", to: "b", kind: "default" },
        { from: "a", to: "merge" },
        { from: "b", to: "merge" },
      ],
      outputNodeId: "merge",
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(true);
  });

  it("accepts a oneOf predicate", () => {
    const dag: DagDefInput = {
      id: "oneof-ok",
      nodes: {
        router: mkNode("router"),
        a: mkNode("a"),
        b: mkNode("b"),
      },
      edges: [
        { from: "router", to: "a", when: { kind: { oneOf: ["x", "y"] } } as any },
        { from: "router", to: "b", kind: "default" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(true);
  });
});
