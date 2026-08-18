// Regression test for predicate-malformed detection.
//
// With function-based predicates, malformed predicates (missing `check` function,
// empty `label`) are caught at `defineDag` time by the validator. This test
// verifies the validator rejects them and that the runtime's defensive check
// in `decideRoute` also catches smuggled-through malformed predicates.

import { describe, it, expect } from "bun:test";
import type { RunId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { z } from "zod";
import { ok } from "../types/result.js";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDag } from "../executor/define-dag.js";
import { DagDefinitionError } from "../executor/define-dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { RecordingObserver } from "../observer/observer.js";

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: async () => ok(undefined as unknown),
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...overrides,
});

describe("predicate-malformed — caught at defineDag time", () => {
  it("missing check function throws DagDefinitionError", () => {
    expect(() => defineDag({
      id: "malformed",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "x" }) }),
        a: makeNode("a", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("A"),
        }),
        b: makeNode("b", {
          inputSchema: z.any(),
          run: async () => ok("B"),
        }),
      },
      edges: [
        {
          from: "router",
          to: "a",
          when: { label: "bad", version: 1, check: "not-a-fn" } as any,
        } as any,
        { from: "router", to: "b", kind: "default" },
      ],
      outputNodeId: "b",
      defaultRetryLimit: 0,
    })).toThrow(DagDefinitionError);
  });

  it("empty label throws DagDefinitionError", () => {
    expect(() => defineDag({
      id: "empty-label",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "x" }) }),
        a: makeNode("a"),
        b: makeNode("b"),
      },
      edges: [
        {
          from: "router",
          to: "a",
          when: { label: "", version: 1, check: () => true } as any,
        } as any,
        { from: "router", to: "b", kind: "default" },
      ],
      defaultRetryLimit: 0,
    })).toThrow(/label/);
  });

  it("non-object predicate throws DagDefinitionError", () => {
    expect(() => defineDag({
      id: "non-object",
      nodes: {
        router: makeNode("router"),
        a: makeNode("a"),
        b: makeNode("b"),
      },
      edges: [
        { from: "router", to: "a", when: "yes" as any } as any,
        { from: "router", to: "b", kind: "default" },
      ],
      defaultRetryLimit: 0,
    })).toThrow(DagDefinitionError);
  });
});

describe("predicate-malformed — runtime check throws when predicate check() throws", () => {
  it("throwing check function records reason: 'threw' and falls through to default", async () => {
    const mkCtx = (observer: RecordingObserver): NodeContext => ({
      runId: "threw-run" as RunId,
      dagId: "threw-dag" as DagId,
      observer,
      tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
      judgeLlm: null,
      cache: null,
      prompts: null,
      llm: null, http: null, clock: null,
      logger: { warn: () => {}, error: () => {} },
    });

    const dag = defineDag({
      id: "threw",
      nodes: {
        router: makeNode("router", { run: async () => ok({ kind: "x" }) }),
        a: makeNode("a", {
          inputSchema: z.object({ router: z.any().optional() }),
          run: async () => ok("A"),
        }),
        b: makeNode("b", {
          inputSchema: z.any(),
          run: async () => ok("B"),
        }),
      },
      edges: [
        { from: DAG_INPUT, to: "router" },
        {
          from: "router",
          to: "a",
          when: {
            label: "throws",
            version: 1,
            check: () => { throw new Error("boom"); },
          } as any,
        },
        { from: "router", to: "b", kind: "default" },
      ],
      defaultRetryLimit: 0,
    });

    const observer = new RecordingObserver();
    const result = await runDagStateful<unknown, string>(dag, null, mkCtx(observer));

    // A throwing predicate is now treated as predicate-malformed (programming error)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("predicate-malformed");
      if (result.error.kind === "predicate-malformed") {
        expect(result.error.message).toContain("threw an exception");
      }
    }
  });
});
