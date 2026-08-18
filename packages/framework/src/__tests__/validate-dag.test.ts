import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import type { DagDefInput } from "../types/dag.js";
import { DAG_INPUT } from "../types/ids.js";
import { validateDagShape } from "../executor/validate-dag.js";
import { createTransformNode } from "../nodes/transform.js";

const mkNode = (id: string) =>
  createTransformNode({
    id,
    inputSchema: z.any(),
    outputSchema: z.any(),
    transform: (i) => ok(i),
  });

describe("validateDagShape", () => {
  it("accepts a well-formed DAG", () => {
    const dag: DagDefInput = {
      id: "ok",
      nodes: { A: mkNode("A"), B: mkNode("B") },
      edges: [{ from: DAG_INPUT, to: "A" }, { from: "A", to: "B" }],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });

  it("rejects empty nodes", () => {
    const dag: DagDefInput = { id: "empty", nodes: {}, edges: [] };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("validation");
  });

  it("rejects a source node whose inputSchema rejects `undefined` (non-unit)", () => {
    // The `NodeDef` type permits `{ isSource: true, inputSchema: <non-void> }`;
    // `createSourceNode` never produces it, but a hand-built node could. A source
    // consumes no DAG input, so its schema must accept the always-`undefined`
    // input. This guard makes the illegal pairing fail at definition time.
    const badSource = { ...mkNode("S"), isSource: true, inputSchema: z.object({ x: z.number() }) };
    const dag: DagDefInput = {
      id: "bad-source-schema",
      nodes: { S: badSource, B: mkNode("B") },
      edges: [{ from: "S", to: "B" }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("rejects `undefined`");
    } else {
      throw new Error(`expected a validation error, got ${r.ok ? "ok" : r.error.kind}`);
    }
  });

  it("accepts a source node with a unit (z.void()) inputSchema", () => {
    const goodSource = { ...mkNode("S"), isSource: true, inputSchema: z.void() };
    const dag: DagDefInput = {
      id: "good-source-schema",
      nodes: { S: goodSource, B: mkNode("B") },
      edges: [{ from: "S", to: "B" }],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });

  it("rejects record key/node.id mismatch (the post-record-shape duplicate check)", () => {
    const dag: DagDefInput = {
      id: "dup",
      nodes: {
        A: mkNode("A"),
        B: mkNode("A"), // intentional id collision under different keys
      },
      edges: [],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("record key and node.id must match");
    }
  });

  it("rejects an edge referencing an unknown source node", () => {
    const dag: DagDefInput = {
      id: "bad-source",
      nodes: { A: mkNode("A") },
      edges: [{ from: "ghost" as never, to: "A" }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("unknown source");
    }
  });

  it("rejects an edge referencing an unknown target node", () => {
    const dag: DagDefInput = {
      id: "bad-target",
      nodes: { A: mkNode("A") },
      edges: [{ from: "A", to: "ghost" as never }],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("unknown target");
    }
  });

  it("rejects duplicate edges between the same (from, to)", () => {
    const dag: DagDefInput = {
      id: "dup-edge",
      nodes: { A: mkNode("A"), B: mkNode("B") },
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "B" },
      ],
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("duplicate-edge");
    }
  });

  it("rejects outputNodeId that does not exist", () => {
    const dag: DagDefInput = {
      id: "bad-output",
      nodes: { A: mkNode("A") },
      edges: [],
      outputNodeId: "ZZ" as never,
    };
    const r = validateDagShape(dag);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "validation") {
      expect(r.error.message).toContain("outputNodeId 'ZZ'");
    }
  });

  it("accepts diamond DAG with edges-only topology", () => {
    const dag: DagDefInput = {
      id: "diamond",
      nodes: {
        A: mkNode("A"),
        B: mkNode("B"),
        C: mkNode("C"),
        D: mkNode("D"),
      },
      edges: [
        { from: DAG_INPUT, to: "A" },
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
      ],
    };
    expect(validateDagShape(dag).ok).toBe(true);
  });
});
