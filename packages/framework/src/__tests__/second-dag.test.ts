import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ok } from "../types/result.js";
import type { NodeContext } from "../types/node.js";
import type { DagDef } from "../types/dag.js";
import { runDag } from "../executor/executor.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createTransformNode } from "../nodes/transform.js";

/**
 * SC-007: A simple "hello world" DAG using only public framework primitives.
 * Two nodes: fetchGreeting → formatGreeting
 */
describe("second-dag (SC-007): hello world DAG", () => {
  const GreetingInput = z.object({ name: z.string() });
  const RawGreeting = z.object({ raw: z.string() });
  const FormattedGreeting = z.object({ message: z.string() });

  const fetchGreeting = createFetchNode({
    id: "fetchGreeting",
    inputSchema: GreetingInput,
    outputSchema: RawGreeting,
    deps: [],
    fetch: async (input) => ok({ raw: `Hello, ${input.name}` }),
  });

  const formatGreeting = createTransformNode({
    id: "formatGreeting",
    inputSchema: RawGreeting,
    outputSchema: FormattedGreeting,
    deps: ["fetchGreeting"],
    transform: (input) => ok({ message: `${input.raw}!` }),
  });

  const dag: DagDef = {
    id: "hello-world",
    nodes: [fetchGreeting, formatGreeting],
    edges: [{ from: "fetchGreeting", to: "formatGreeting" }],
  };

  const mkCtx = (): NodeContext => ({
    runId: "hw-run",
    dagId: "hello-world",
    observer: null,
    cache: null,
    prompts: null,
    llm: null,
    logger: null,
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
