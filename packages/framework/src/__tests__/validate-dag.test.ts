import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import type { DagDef } from "../types/dag.js";
import { validateDagShape } from "../executor/validate-dag.js";
import { createTransformNode } from "../nodes/transform.js";

const mkNode = (id: string, deps: readonly string[] = []) =>
  createTransformNode({
    id,
    inputSchema: z.any(),
    outputSchema: z.any(),
    deps,
    transform: (i) => ok(i),
  });

describe("validateDagShape", () => {
  it("accepts a well-formed DAG", () => {
    const dag: DagDef = {
      id: "ok",
      nodes: [mkNode("A"), mkNode("B", ["A"])],
      edges: [{ from: "A", to: "B" }],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });

  it("rejects empty nodes", () => {
    const dag: DagDef = { id: "empty", nodes: [], edges: [] };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("validation");
  });

  it("rejects duplicate node IDs", () => {
    const dag: DagDef = {
      id: "dup",
      nodes: [mkNode("A"), mkNode("A")],
      edges: [],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("Duplicate node id");
    }
  });

  it("rejects dep without matching incoming edge", () => {
    // node B declares dep on A but there's no edge A -> B
    const dag: DagDef = {
      id: "missing-edge",
      nodes: [mkNode("A"), mkNode("B", ["A"])],
      edges: [],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("declares dep 'A'");
    }
  });

  it("rejects edge without matching dep", () => {
    // edge A -> B but B does not declare A as a dep
    const dag: DagDef = {
      id: "extra-edge",
      nodes: [mkNode("A"), mkNode("B")],
      edges: [{ from: "A", to: "B" }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("no matching entry");
    }
  });

  it("rejects outputNodeId that does not exist", () => {
    const dag: DagDef = {
      id: "bad-output",
      nodes: [mkNode("A")],
      edges: [],
      outputNodeId: "ZZ",
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("outputNodeId 'ZZ'");
    }
  });

  it("accepts diamond DAG with consistent edges/deps", () => {
    const dag: DagDef = {
      id: "diamond",
      nodes: [
        mkNode("A"),
        mkNode("B", ["A"]),
        mkNode("C", ["A"]),
        mkNode("D", ["B", "C"]),
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
      ],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });
});
