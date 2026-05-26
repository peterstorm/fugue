import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  defineRouter,
  createFetchNode,
  createTransformNode,
  ok,
  nodeId,
  dagId,
} from "../index.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";

describe("defineRouter", () => {
  const classifier = createFetchNode({
    id: "classify",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ category: z.string() }),
    fetch: async () => ok({ category: "simple" }),
  });

  const simpleHandler = createTransformNode({
    id: "handle-simple",
    inputSchema: z.object({ category: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    transform: () => ok({ done: true }),
  });

  const complexHandler = createTransformNode({
    id: "handle-complex",
    inputSchema: z.object({ category: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    transform: () => ok({ done: true }),
  });

  const fallback = createTransformNode({
    id: "fallback",
    inputSchema: z.object({ category: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    transform: () => ok({ done: false }),
  });

  it("wires classifier→case targets via conditional edges plus a default edge", () => {
    const dag = defineRouter({
      id: "router-test",
      classifier,
      cases: {
        "simple-category": {
          when: (out) => (out as { category: string }).category === "simple",
          to: simpleHandler,
        },
        "complex-category": {
          when: (out) => (out as { category: string }).category === "complex",
          to: complexHandler,
        },
      },
      default: fallback,
    });

    expect(dag.id).toBe(dagId("router-test"));
    // 4 nodes: classifier + 2 case targets + default
    expect(dag.nodes).toHaveLength(4);
    // 3 edges: 2 conditional + 1 default
    expect(dag.edges).toHaveLength(3);

    const conditionals = dag.edges.filter(isConditionalEdge);
    const defaults = dag.edges.filter(isDefaultEdge);
    expect(conditionals).toHaveLength(2);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      from: nodeId("classify"),
      to: nodeId("fallback"),
      kind: "default",
    });
  });

  it("uses the case key as the synthesized predicate label (ergonomic form)", () => {
    const dag = defineRouter({
      id: "label-test",
      classifier,
      cases: {
        "is-simple": {
          when: (out) => (out as { category: string }).category === "simple",
          to: simpleHandler,
        },
      },
      default: fallback,
    });

    const cond = dag.edges.find(isConditionalEdge);
    expect(cond?.when.label).toBe("is-simple");
    expect(cond?.when.version).toBe(1);
  });

  it("passes through whenPredicate unchanged (advanced form)", () => {
    const customPredicate = {
      label: "custom-label",
      version: 7,
      check: (value: unknown) => (value as { category: string }).category === "simple",
      minConfidence: "high" as const,
    };

    const dag = defineRouter({
      id: "predicate-test",
      classifier,
      cases: {
        "case-key-ignored": {
          whenPredicate: customPredicate,
          to: simpleHandler,
        },
      },
      default: fallback,
    });

    const cond = dag.edges.find(isConditionalEdge);
    expect(cond?.when).toBe(customPredicate);
    expect(cond?.when.label).toBe("custom-label");
    expect(cond?.when.version).toBe(7);
    expect(cond?.when.minConfidence).toBe("high");
  });

  it("throws on empty cases", () => {
    expect(() =>
      defineRouter({
        id: "empty",
        classifier,
        cases: {},
        default: fallback,
      }),
    ).toThrow("cases must not be empty");
  });

  it("evaluates synthesized predicate against the upstream output", () => {
    const dag = defineRouter({
      id: "eval-test",
      classifier,
      cases: {
        "is-simple": {
          when: (out) => (out as { category: string }).category === "simple",
          to: simpleHandler,
        },
      },
      default: fallback,
    });

    const cond = dag.edges.find(isConditionalEdge)!;
    expect(cond.when.check({ category: "simple" }, null)).toBe(true);
    expect(cond.when.check({ category: "other" }, null)).toBe(false);
  });

  it("accepts the default node as an explicit outputNodeId", () => {
    // The validator requires `outputNodeId` to be reachable via
    // unconditional/default edges only. The default branch qualifies; a
    // conditional case target does not.
    const dag = defineRouter({
      id: "output-test",
      classifier,
      cases: {
        "is-simple": {
          when: (out) => (out as { category: string }).category === "simple",
          to: simpleHandler,
        },
      },
      default: fallback,
      outputNodeId: "fallback",
    });

    expect(dag.outputNodeId).toBe(nodeId("fallback"));
  });

  it("rejects setting outputNodeId to a conditional-only case target", () => {
    // simpleHandler is only reachable via a conditional edge. The output
    // reachability rule (unconditional + default only) must reject this.
    expect(() =>
      defineRouter({
        id: "bad-output",
        classifier,
        cases: {
          "is-simple": {
            when: (out) => (out as { category: string }).category === "simple",
            to: simpleHandler,
          },
        },
        default: fallback,
        outputNodeId: "handle-simple",
      }),
    ).toThrow(/not reachable/);
  });

  it("delegates validation: rejects an unknown outputNodeId", () => {
    expect(() =>
      defineRouter({
        id: "bad-id",
        classifier,
        cases: {
          "case-a": { when: () => true, to: simpleHandler },
        },
        default: fallback,
        outputNodeId: "does-not-exist",
      }),
    ).toThrow();
  });
});
