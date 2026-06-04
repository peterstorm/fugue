import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import type { NodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import { runDag } from "../executor/run-dag.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createTransformNode } from "../nodes/transform.js";
import { defineDag, defineDagFromArray } from "../executor/define-dag.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

/**
 * SC-007: A simple "hello world" DAG using only public framework primitives.
 * Two nodes: fetchGreeting → formatGreeting
 */
describe("second-dag (SC-007): hello world DAG", () => {
  const GreetingInput = z.object({ name: z.string() });
  const RawGreeting = z.object({ raw: z.string() });
  const FormattedGreeting = z.object({ message: z.string() });

  const fetchGreeting = createFetchNode({
    id: N("fetchGreeting"),
    inputSchema: GreetingInput,
    outputSchema: RawGreeting,
    fetch: async (input) => ok({ raw: `Hello, ${input.name}` }),
  });

  const formatGreeting = createTransformNode({
    id: N("formatGreeting"),
    inputSchema: RawGreeting,
    outputSchema: FormattedGreeting,
    transform: (input) => ok({ message: `${input.raw}!` }),
  });

  const dag = defineDagFromArray({
    id: "hello-world",
    nodes: ([fetchGreeting, formatGreeting]),
    edges: [{ from: "fetchGreeting", to: "formatGreeting" }],
  });

  const mkCtx = (): NodeContext => ({
    runId: "hw-run" as RunId,
    dagId: "hello-world" as DagId,
    observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
    cache: null,
    prompts: null,
    llm: null, http: null,
    logger: { warn: () => {}, error: () => {} },
  });

  it("produces formatted greeting from name input", async () => {
    const result = await runDag(dag, { name: "World" }, mkCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ message: "Hello, World!" });
    }
  });

  it("uses only public framework primitives", () => {
    // Verify node kinds
    expect(fetchGreeting.kind).toBe("fetch");
    expect(formatGreeting.kind).toBe("transform");
    expect(dag.nodes.length).toBe(2);
    expect(dag.edges.length).toBe(1);
  });
});
