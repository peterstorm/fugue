import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  defineFanOut,
  createFetchNode,
  createTransformNode,
  createEvalJudgeNode,
  ok,
  nodeId,
  dagId,
} from "../index.js";

describe("defineFanOut", () => {
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

  const branchC = createFetchNode({
    id: "branch-c",
    inputSchema: z.object({ trigger: z.boolean() }),
    outputSchema: z.object({ c: z.string() }),
    fetch: async () => ok({ c: "charlie" }),
  });

  const join = createTransformNode({
    id: "merge",
    inputSchema: z.object({
      "branch-a": z.object({ a: z.string() }),
      "branch-b": z.object({ b: z.string() }),
      "branch-c": z.object({ c: z.string() }),
    }),
    outputSchema: z.object({ merged: z.boolean() }),
    transform: () => ok({ merged: true }),
  });

  it("creates source→each branch edges without a join", () => {
    const dag = defineFanOut({
      id: "fan-out-no-join",
      source,
      branches: [branchA, branchB, branchC],
    });

    expect(dag.id).toBe(dagId("fan-out-no-join"));
    // 4 nodes: source + 3 branches
    expect(dag.nodes).toHaveLength(4);
    // 3 edges: source→a, source→b, source→c
    expect(dag.edges).toHaveLength(3);
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: nodeId("source"), to: nodeId("branch-a") }),
        expect.objectContaining({ from: nodeId("source"), to: nodeId("branch-b") }),
        expect.objectContaining({ from: nodeId("source"), to: nodeId("branch-c") }),
      ]),
    );
    // No join → output is the last branch
    expect(dag.outputNodeId).toBe(nodeId("branch-c"));
  });

  it("creates source→branch and branch→join edges when join is provided", () => {
    const dag = defineFanOut({
      id: "fan-out-with-join",
      source,
      branches: [branchA, branchB, branchC],
      join,
    });

    // 5 nodes: source + 3 branches + join
    expect(dag.nodes).toHaveLength(5);
    // 6 edges: source→{a,b,c} + {a,b,c}→merge
    expect(dag.edges).toHaveLength(6);
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: nodeId("source"), to: nodeId("branch-a") }),
        expect.objectContaining({ from: nodeId("branch-a"), to: nodeId("merge") }),
        expect.objectContaining({ from: nodeId("branch-c"), to: nodeId("merge") }),
      ]),
    );
    expect(dag.outputNodeId).toBe(nodeId("merge"));
  });

  it("passes through retryLimits and defaultRetryLimit", () => {
    const dag = defineFanOut({
      id: "retry-fan-out",
      source,
      branches: [branchA, branchB],
      defaultRetryLimit: 2,
      retryLimits: { "branch-a": 5 },
    });

    expect(dag.defaultRetryLimit).toBe(2);
    expect(dag.retryLimits).toEqual({ "branch-a": 5 });
  });

  it("passes through evalJudges", () => {
    const judge = createEvalJudgeNode({
      id: "judge-fan-out",
      criteria: ["accuracy"],
      rubric: { source: "inline", text: "Score 0-1 based on accuracy." },
    });
    const dag = defineFanOut({
      id: "judges-fan-out",
      source,
      branches: [branchA, branchB],
      evalJudges: [judge],
    });
    expect(dag.evalJudges).toHaveLength(1);
    expect(dag.evalJudges?.[0]?.id).toBe(nodeId("judge-fan-out"));
  });

  it("delegates structural validation to defineDag (rejects duplicate branch ids)", () => {
    // Two branches with the same id — the validator should catch this.
    expect(() =>
      defineFanOut({
        id: "dup-branches",
        source,
        branches: [branchA, branchA],
      }),
    ).toThrow();
  });
});
