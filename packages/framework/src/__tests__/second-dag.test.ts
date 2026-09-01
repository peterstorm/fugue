import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import { testNodeContext } from "./_context-factories.js";
import { runDag } from "../executor/run-dag.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createTransformNode } from "../nodes/transform.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { DAG_INPUT, dagId, runId } from "../types/ids.js";
import { N } from "./_id-helpers.js";

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
    edges: [
      { from: DAG_INPUT, to: "fetchGreeting" },
      { from: "fetchGreeting", to: "formatGreeting" },
    ],
  });

  const mkCtx = () => testNodeContext({
    runId: runId("hw-run"),
    dagId: dagId("hello-world"),
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
    // 2 edges now: the chain edge + the injected DAG_INPUT edge to the root.
    expect(dag.edges.length).toBe(2);
  });
});
