// Observer crash isolation — verifies that a throwing observer does not
// prevent a DAG run from completing successfully.

import { describe, it, expect } from "bun:test";
import type { RunId, DagId } from "../types/ids.js";
import { z } from "zod";
import { ok } from "../types/result.js";
import type { NodeContext } from "../types/node.js";
import type { Observer } from "../observer/observer.js";
import { runDag } from "../executor/run-dag.js";
import { defineDag } from "../executor/define-dag.js";
import { createTransformNode } from "../nodes/transform.js";

const mkCtx = (observer: Observer): NodeContext => ({
  runId: "crash-test-run" as RunId,
  dagId: "crash-test-dag" as DagId,
  observer,
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("Observer crash isolation", () => {
  it("DAG run completes despite observer throwing on every event", async () => {
    const throwingObserver: Observer = {
      observe: () => { throw new Error("observer exploded"); },
    };

    const nodeA = createTransformNode({
      id: "a",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      transform: (input) => ok(input.x * 2),
    });

    const dag = defineDag({
      id: "crash-dag",
      nodes: { a: nodeA },
      edges: [],
      outputNodeId: "a",
    });

    const ctx = mkCtx(throwingObserver);
    const result = await runDag(dag, { x: 5 }, ctx);

    // Observer crashes must NOT prevent the run from producing a result
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(10); // 5*2
    }
  });

  it("multi-node DAG completes with throwing observer (sequential waves)", async () => {
    const throwingObserver: Observer = {
      observe: () => { throw new Error("observer exploded"); },
    };

    // Two nodes in the same wave (no edges) — proves wave execution survives
    const nodeA = createTransformNode({
      id: "a",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      transform: (input) => ok(input.x * 2),
    });

    const nodeB = createTransformNode({
      id: "b",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      transform: (input) => ok(input.x + 100),
    });

    const dag = defineDag({
      id: "multi-crash-dag",
      nodes: { a: nodeA, b: nodeB },
      edges: [],
      outputNodeId: "b",
    });

    const ctx = mkCtx(throwingObserver);
    const result = await runDag(dag, { x: 4 }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(104); // 4 + 100
    }
  });

  it("DAG run completes when observer returns a rejecting promise", async () => {
    const asyncThrowingObserver: Observer = {
      observe: () => {
        // Return a thenable (violates void signature) — dispatchEvent should catch the rejection
        return Promise.reject(new Error("async observer exploded")) as unknown as void;
      },
    };

    const nodeA = createTransformNode({
      id: "a",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      transform: (input) => ok(input.x + 10),
    });

    const dag = defineDag({
      id: "async-crash-dag",
      nodes: { a: nodeA },
      edges: [],
      outputNodeId: "a",
    });

    const ctx = mkCtx(asyncThrowingObserver);
    const result = await runDag(dag, { x: 3 }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(13);
    }
  });
});
