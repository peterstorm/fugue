// Wave 7 §7.5 — capability-typed NodeContext: run-start validation.
//
// A node declaring `requires: ["llm"]` against a no-llm NodeContext must
// fail before `node.run` is ever invoked, with
// `Err({ kind: "missing-capability", capability: "llm", nodeId })`.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { defineDagFromArray } from "../executor/define-dag.js";
import { ok, err } from "../types/result.js";
import type { NodeContext, NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { NoopObserver } from "../observer/observer.js";

const noLlmCtx = (): NodeContext => ({
  runId: "r",
  dagId: "d",
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
});

describe("capability-typed NodeContext (Wave 7 §7.5)", () => {
  it("node with requires:[\"llm\"] against a no-llm context fails at run start", async () => {
    let ranBody = false;
    const node: NodeDef<unknown, unknown, FrameworkError, readonly ["llm"]> = {
      id: "needs-llm",
      kind: "llm",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: ["llm"] as const,
      run: async () => {
        ranBody = true;
        return ok("never");
      },
    };
    const dag = defineDagFromArray({ id: "cap", nodes: [node], edges: [] });

    const result = await runDagStateful(dag, null, noLlmCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-capability");
      if (result.error.kind === "missing-capability") {
        expect(result.error.capability).toBe("llm");
        expect(result.error.nodeId).toBe("needs-llm");
      }
    }
    // The node body must not have run — validation happens before any node executes.
    expect(ranBody).toBe(false);
  });

  it("node with requires:[\"prompts\"] against a no-prompts context fails at run start", async () => {
    const node: NodeDef<unknown, unknown, FrameworkError, readonly ["prompts"]> = {
      id: "needs-prompts",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: ["prompts"] as const,
      run: async () => ok("never"),
    };
    const dag = defineDagFromArray({ id: "cap", nodes: [node], edges: [] });

    const result = await runDagStateful(dag, null, noLlmCtx());
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "missing-capability") {
      expect(result.error.capability).toBe("prompts");
      expect(result.error.nodeId).toBe("needs-prompts");
    }
  });

  it("node with requires:[] always passes capability validation", async () => {
    const node: NodeDef<unknown, unknown, FrameworkError, readonly []> = {
      id: "pure",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: [] as const,
      run: async () => ok("ok"),
    };
    const dag = defineDagFromArray({ id: "cap", nodes: [node], edges: [] });
    const result = await runDagStateful(dag, null, noLlmCtx());
    expect(result.ok).toBe(true);
  });

  it("first missing capability is surfaced (multiple unsatisfied requirements)", async () => {
    const node: NodeDef<unknown, unknown, FrameworkError, readonly ["llm", "cache"]> = {
      id: "multi",
      kind: "transform",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: ["llm", "cache"] as const,
      run: async () => ok("never"),
    };
    const dag = defineDagFromArray({ id: "cap", nodes: [node], edges: [] });
    const result = await runDagStateful(dag, null, noLlmCtx());
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "missing-capability") {
      // First in `requires` order — `llm` precedes `cache`.
      expect(result.error.capability).toBe("llm");
    }
  });

  it("satisfied capability passes validation and the node runs", async () => {
    let ranBody = false;
    const fakeLlm = {
      sendStructured: async () => err({ kind: "node-crash" as const, nodeId: "x", message: "no" }),
    };
    const node: NodeDef<unknown, unknown, FrameworkError, readonly ["llm"]> = {
      id: "uses-llm",
      kind: "llm",
      inputSchema: z.any(),
      outputSchema: z.any(),
      requires: ["llm"] as const,
      run: async (_input, ctx) => {
        ranBody = true;
        // ctx.llm is typed non-null here — no need to null-check.
        expect(ctx.llm).toBeTruthy();
        return ok("ran");
      },
    };
    const dag = defineDagFromArray({ id: "cap", nodes: [node], edges: [] });

    const ctx: NodeContext = { ...noLlmCtx(), llm: fakeLlm as unknown as NodeContext["llm"] };
    const result = await runDagStateful(dag, null, ctx);

    expect(ranBody).toBe(true);
    expect(result.ok).toBe(true);
  });
});
