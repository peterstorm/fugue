import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineDiamond, createFetchNode, createTransformNode, ok, nodeId, dagId } from "../index.js";

describe("defineDiamond", () => {
  const source = createFetchNode({
    id: "source",
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.object({ trigger: z.boolean() }),
    fetch: async () => ok({ trigger: true }),
  });

  const branchA = createFetchNode({
    id: "branch-a",
    inputSchema: z.object({ trigger: z.boolean() }),
    outputSchema: z.object({ a: z.string() }),
    fetch: async () => ok({ a: "alpha" }),
  });

  const branchB = createFetchNode({
    id: "branch-b",
    inputSchema: z.object({ trigger: z.boolean() }),
    outputSchema: z.object({ b: z.string() }),
    fetch: async () => ok({ b: "bravo" }),
  });

  const join = createTransformNode({
    id: "join",
    inputSchema: z.object({
      "branch-a": z.object({ a: z.string() }),
      "branch-b": z.object({ b: z.string() }),
    }),
    outputSchema: z.object({ merged: z.boolean() }),
    transform: () => ok({ merged: true }),
  });

  it("wires source→branches→join with join as output", () => {
    const dag = defineDiamond({
      id: "diamond-test",
      source,
      branches: [branchA, branchB],
      join,
    });

    expect(dag.id).toBe(dagId("diamond-test"));
    expect(dag.nodes).toHaveLength(4);
    // 4 edges: source→a, source→b, a→join, b→join
    expect(dag.edges).toHaveLength(4);
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: nodeId("source"), to: nodeId("branch-a") }),
        expect.objectContaining({ from: nodeId("source"), to: nodeId("branch-b") }),
        expect.objectContaining({ from: nodeId("branch-a"), to: nodeId("join") }),
        expect.objectContaining({ from: nodeId("branch-b"), to: nodeId("join") }),
      ]),
    );
    expect(dag.outputNodeId).toBe(nodeId("join"));
  });

  it("throws on empty branches array", () => {
    expect(() =>
      defineDiamond({ id: "empty", source, branches: [], join }),
    ).toThrow("branches array must not be empty");
  });

  it("supports a single branch (degenerate diamond, A→B→C)", () => {
    const dag = defineDiamond({
      id: "single-branch",
      source,
      branches: [branchA],
      join,
    });

    expect(dag.nodes).toHaveLength(3);
    expect(dag.edges).toHaveLength(2);
    expect(dag.outputNodeId).toBe(nodeId("join"));
  });

  it("passes through retryLimits", () => {
    const dag = defineDiamond({
      id: "retry-diamond",
      source,
      branches: [branchA, branchB],
      join,
      defaultRetryLimit: 3,
      retryLimits: { "branch-a": 5 },
    });

    expect(dag.defaultRetryLimit).toBe(3);
    expect(dag.retryLimits).toEqual({ "branch-a": 5 });
  });
});
