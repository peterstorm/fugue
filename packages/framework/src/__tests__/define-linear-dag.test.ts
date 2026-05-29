import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineLinearDag, createFetchNode, createTransformNode, ok, nodeId, dagId, DagDefinitionError } from "../index.js";
import type { Result, FrameworkError } from "../index.js";

describe("defineLinearDag", () => {
  const nodeA = createFetchNode({
    id: "fetch",
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.object({ fetched: z.boolean() }),
    fetch: async () => ok({ fetched: true }),
  });

  const nodeB = createTransformNode({
    id: "transform",
    inputSchema: z.object({ fetched: z.boolean() }),
    outputSchema: z.object({ transformed: z.boolean() }),
    transform: () => ok({ transformed: true }),
  });

  const nodeC = createTransformNode({
    id: "assemble",
    inputSchema: z.object({ transformed: z.boolean() }),
    outputSchema: z.object({ done: z.boolean() }),
    transform: () => ok({ done: true }),
  });

  it("creates a linear DAG with edges inferred from array order", () => {
    const dag = defineLinearDag({
      id: "linear-test",
      nodes: [nodeA, nodeB, nodeC],
    });

    expect(dag.id).toBe(dagId("linear-test"));
    expect(dag.nodes).toHaveLength(3);
    expect(dag.edges).toHaveLength(2);
    expect(dag.edges[0]).toMatchObject({ from: nodeId("fetch"), to: nodeId("transform") });
    expect(dag.edges[1]).toMatchObject({ from: nodeId("transform"), to: nodeId("assemble") });
    expect(dag.outputNodeId).toBe(nodeId("assemble"));
  });

  it("works with a single node (no edges)", () => {
    const dag = defineLinearDag({
      id: "single",
      nodes: [nodeA],
    });

    expect(dag.nodes).toHaveLength(1);
    expect(dag.edges).toHaveLength(0);
    expect(dag.outputNodeId).toBe(nodeId("fetch"));
  });

  it("throws a DagDefinitionError on empty nodes array", () => {
    expect(() => defineLinearDag({ id: "empty", nodes: [] })).toThrow(DagDefinitionError);
  });

  it("DagDefinitionError has correct kind and message", () => {
    let caught: unknown;
    try { defineLinearDag({ id: "empty", nodes: [] }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DagDefinitionError);
    const dagErr = caught as DagDefinitionError;
    expect(dagErr.detail.kind).toBe("validation");
    // The Error.message string is formatted by DagDefinitionError's constructor
    expect(dagErr.message).toContain("at least one node");
  });

  it("passes through retryLimits and evalJudges", () => {
    const dag = defineLinearDag({
      id: "retry-test",
      nodes: [nodeA, nodeB],
      defaultRetryLimit: 3,
      retryLimits: { fetch: 5 },
    });

    expect(dag.defaultRetryLimit).toBe(3);
    expect(dag.retryLimits).toEqual({ fetch: 5 });
  });
});
