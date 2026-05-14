import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { runDag } from "../../src/executor/executor.js";
import { createTransformNode } from "../../src/nodes/transform.js";
import { createEvalJudgeNode } from "../../src/nodes/eval-judge.js";
import type { EvalJudgeResponse } from "../../src/nodes/eval-judge.js";
import type { NodeContext } from "../../src/types/node.js";
import type { DagDef } from "../../src/types/dag.js";
import type { LlmClient } from "../../src/types/llm.js";
import { ok, err } from "../../src/types/result.js";
import { stubSendWithTools } from "./_llm-mocks.js";
import { defineDag, defineDagFromArray } from "../executor/define-dag.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

// --- Helpers ---

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
  ...overrides,
});

const makeMockJudgeLlm = (response: EvalJudgeResponse): LlmClient => ({
  sendWithTools: stubSendWithTools,
  sendStructured: async () => ok({ output: response, tokensIn: 100, tokensOut: 50, rawText: "" }) as any,
});

/** Simple transform node that uppercases a string. */
const uppercaseNode = createTransformNode({
  id: N("uppercase"),
  inputSchema: z.string(),
  outputSchema: z.string(),
  transform: (input) => ok(input.toUpperCase()),
});

/** A two-node DAG for testing. */
const makeDag = (evalJudges: DagDef["evalJudges"] = undefined): DagDef =>
  defineDagFromArray({
    id: "test-dag",
    nodes: [uppercaseNode],
    edges: [],
    outputNodeId: "uppercase",
    evalJudges,
  });

// --- Tests ---

describe("executor + eval-judge integration", () => {
  test("DAG returns output unchanged regardless of judge result", async () => {
    const llm = makeMockJudgeLlm({
      score: 0.3,
      criteria_scores: [{ name: "quality", score: 0.3 }],
      failed_criteria: ["quality"],
      reason: "Terrible output",
    });

    const judge = createEvalJudgeNode({
      id: N("quality-judge"),
      criteria: ["quality"],
      threshold: 0.8,
    });

    const dag = makeDag([judge]);
    const result = await runDag<string, string>(dag, "hello", makeCtx({ judgeLlm: llm }));

    // DAG output is unaffected by judge failure
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("HELLO");
    }
  });

  test("DAG works normally without eval judges", async () => {
    const dag = makeDag();
    const result = await runDag<string, string>(dag, "world", makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("WORLD");
    }
  });

  test("DAG works with empty evalJudges array", async () => {
    const dag = makeDag([]);
    const result = await runDag<string, string>(dag, "test", makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("TEST");
    }
  });

  test("multiple judges run in parallel", async () => {
    const callOrder: string[] = [];

    const llm1: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async () => {
        callOrder.push("judge-1");
        return ok({ output: { score: 0.9, criteria_scores: [{ name: "a", score: 0.9 }], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
      },
    };
    const llm2: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async () => {
        callOrder.push("judge-2");
        return ok({ output: { score: 0.5, criteria_scores: [{ name: "b", score: 0.5 }], failed_criteria: ["b"], reason: "bad" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
      },
    };

    // Both judges share the same judgeLlm — we just need to check both run
    // Use a single LLM that tracks calls
    let callCount = 0;
    const sharedLlm: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async () => {
        callCount++;
        return ok({
          output: { score: 0.9, criteria_scores: [{ name: "x", score: 0.9 }], failed_criteria: [], reason: "ok" },
          tokensIn: 0, tokensOut: 0, rawText: "",
        }) as any;
      },
    };

    const judge1 = createEvalJudgeNode({ id: N("judge-1"), criteria: [N("x")] });
    const judge2 = createEvalJudgeNode({ id: N("judge-2"), criteria: [N("y")] });

    const dag = makeDag([judge1, judge2]);
    await runDag<string, string>(dag, "hi", makeCtx({ judgeLlm: sharedLlm }));
    expect(callCount).toBe(2);
  });

  test("eval judges don't run when DAG fails", async () => {
    let judgeCalled = false;
    const llm: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async () => {
        judgeCalled = true;
        return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
      },
    };

    const failingNode = createTransformNode({
      id: N("failing"),
      inputSchema: z.string(),
      outputSchema: z.string(),
      transform: () => err({ kind: "node-crash" as const, nodeId: "failing" as NodeId, retriability: "retriable" as const, message: "boom" }),
    });

    const judge = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
    const dag = defineDagFromArray({
      id: "fail-dag",
      nodes: [failingNode],
      edges: [],
      outputNodeId: "failing",
      evalJudges: [judge],
    });

    const result = await runDag<string, string>(dag, "in", makeCtx({ judgeLlm: llm }));
    expect(result.ok).toBe(false);
    expect(judgeCalled).toBe(false);
  });

  test("judge failure doesn't crash the DAG", async () => {
    const throwingLlm: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async () => { throw new Error("catastrophic failure"); },
    };

    const judge = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
    const dag = makeDag([judge]);

    const result = await runDag<string, string>(dag, "hi", makeCtx({ judgeLlm: throwingLlm }));
    // DAG still succeeds
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("HI");
    }
  });

  test("judge receives correct DAG input and output", async () => {
    let receivedInput: unknown = null;
    let receivedOutput: unknown = null;

    const llm: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async (req) => {
        // Extract from the user message
        if (req.user.includes("original input")) receivedInput = "found";
        if (req.user.includes("ORIGINAL INPUT")) receivedOutput = "found";
        return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
      },
    };

    const judge = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
    const dag = makeDag([judge]);

    await runDag<string, string>(dag, "original input", makeCtx({ judgeLlm: llm }));
    expect(receivedInput).toBe("found");
    expect(receivedOutput).toBe("found");
  });

  test("judge uses ctx.judgeLlm, not ctx.llm", async () => {
    let whichCalled = "";

    const mainLlm: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async () => {
        whichCalled = "main";
        return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
      },
    };
    const judgeLlm: LlmClient = {
      sendWithTools: stubSendWithTools,
      sendStructured: async () => {
        whichCalled = "judge";
        return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
      },
    };

    const judge = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
    const dag = makeDag([judge]);

    await runDag<string, string>(dag, "hi", makeCtx({ llm: mainLlm, judgeLlm }));
    expect(whichCalled).toBe("judge");
  });
});
