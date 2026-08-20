import { NoopObserver } from "../observer/observer.js";
import { N } from "./_id-helpers.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { describe, test, expect } from "bun:test";
import { judgePassed } from "../types/eval-judge.js";
import {
  createEvalJudgeNode,
  toEvalJudgeResult,
  llmFailureResult,
  EvalJudgeResponseSchema,
} from "../../src/nodes/eval-judge.js";
import type { EvalJudgeResponse } from "../../src/nodes/eval-judge.js";
import type { NodeContext } from "../../src/types/node.js";
import type { LlmClient } from "../../src/types/llm.js";
import { ok, err } from "../../src/types/result.js";
import { stubSendWithTools } from "./_llm-mocks.js";

// --- Helpers ---

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null, http: null,
  clock: null,
  logger: { warn: () => {}, error: () => {} },
  ...overrides,
});

const makeMockLlm = (response: EvalJudgeResponse): LlmClient => ({
  sendWithTools: stubSendWithTools,
  sendStructured: async () => ok({ output: response, tokensIn: 100, tokensOut: 50, rawText: "" }) as any,
});

const makeFailingLlm = (message: string): LlmClient => ({
  sendWithTools: stubSendWithTools,
  sendStructured: async () => err({ kind: "node-crash", nodeId: "judge" as NodeId, message }) as any,
});

const makeThrowingLlm = (): LlmClient => ({
  sendWithTools: stubSendWithTools,
  sendStructured: async () => { throw new Error("network timeout"); },
});

// --- Tests ---

describe("EvalJudgeResponseSchema", () => {
  test("validates correct response", () => {
    const valid = {
      score: 0.85,
      criteria_scores: [{ name: "factuality", score: 0.9 }, { name: "relevance", score: 0.8 }],
      failed_criteria: [],
      reason: "Good output",
    };
    expect(EvalJudgeResponseSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects score below 0", () => {
    const invalid = { score: -0.1, criteria_scores: [], failed_criteria: [], reason: "x" };
    expect(EvalJudgeResponseSchema.safeParse(invalid).success).toBe(false);
  });

  test("rejects score above 1", () => {
    const invalid = { score: 1.1, criteria_scores: [], failed_criteria: [], reason: "x" };
    expect(EvalJudgeResponseSchema.safeParse(invalid).success).toBe(false);
  });

  test("rejects missing reason", () => {
    const invalid = { score: 0.5, criteria_scores: [], failed_criteria: [] };
    expect(EvalJudgeResponseSchema.safeParse(invalid).success).toBe(false);
  });

  test("rejects criteria_scores with non-numeric values", () => {
    const invalid = { score: 0.5, criteria_scores: [{ name: "x", score: "bad" }], failed_criteria: [], reason: "x" };
    expect(EvalJudgeResponseSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("toEvalJudgeResult", () => {
  test("passes when score >= threshold and no criteria fail", () => {
    const response: EvalJudgeResponse = {
      score: 0.9,
      criteria_scores: [{ name: "factuality", score: 0.95 }, { name: "relevance", score: 0.85 }],
      failed_criteria: [],
      reason: "Good",
    };
    const result = toEvalJudgeResult(response, 0.8, ["factuality", "relevance"]);
    expect(judgePassed(result)).toBe(true);
    expect(result.score).toBe(0.9);
    expect(result.failedCriteria).toHaveLength(0);
  });

  test("fails when score < threshold", () => {
    const response: EvalJudgeResponse = {
      score: 0.6,
      criteria_scores: [{ name: "factuality", score: 0.6 }, { name: "relevance", score: 0.6 }],
      failed_criteria: ["factuality", "relevance"],
      reason: "Poor quality",
    };
    const result = toEvalJudgeResult(response, 0.8, ["factuality", "relevance"]);
    expect(judgePassed(result)).toBe(false);
    expect(result.score).toBe(0.6);
  });

  test("fails when individual criterion below threshold even if aggregate passes", () => {
    const response: EvalJudgeResponse = {
      score: 0.85,
      criteria_scores: [{ name: "factuality", score: 0.95 }, { name: "relevance", score: 0.75 }],
      failed_criteria: [],
      reason: "Mostly good",
    };
    const result = toEvalJudgeResult(response, 0.8, ["factuality", "relevance"]);
    expect(judgePassed(result)).toBe(false);
    expect(result.failedCriteria).toContain("relevance");
    expect(result.failedCriteria).not.toContain("factuality");
  });

  test("ignores criteria not in the config list", () => {
    const response: EvalJudgeResponse = {
      score: 0.9,
      criteria_scores: [{ name: "factuality", score: 0.9 }, { name: "extra", score: 0.1 }],
      failed_criteria: ["extra"],
      reason: "Fine",
    };
    // Only checking "factuality" — "extra" is not in our criteria list
    const result = toEvalJudgeResult(response, 0.8, ["factuality"]);
    expect(judgePassed(result)).toBe(true);
    expect(result.failedCriteria).toHaveLength(0);
  });

  test("handles edge case: score exactly at threshold", () => {
    const response: EvalJudgeResponse = {
      score: 0.8,
      criteria_scores: [{ name: "clarity", score: 0.8 }],
      failed_criteria: [],
      reason: "Borderline",
    };
    const result = toEvalJudgeResult(response, 0.8, ["clarity"]);
    expect(judgePassed(result)).toBe(true);
  });

  test("handles edge case: criterion score exactly at threshold", () => {
    const response: EvalJudgeResponse = {
      score: 0.9,
      criteria_scores: [{ name: "clarity", score: 0.8 }],
      failed_criteria: [],
      reason: "OK",
    };
    const result = toEvalJudgeResult(response, 0.8, ["clarity"]);
    // 0.8 is NOT < 0.8, so it passes
    expect(judgePassed(result)).toBe(true);
  });

  test("preserves reason from response", () => {
    const response: EvalJudgeResponse = {
      score: 0.5,
      criteria_scores: [],
      failed_criteria: [],
      reason: "The output lacks coherence",
    };
    const result = toEvalJudgeResult(response, 0.8, []);
    expect(result.reason).toBe("The output lacks coherence");
  });
});

describe("llmFailureResult", () => {
  test("returns skipped-llm-failure outcome that fails quality gating closed", () => {
    const result = llmFailureResult("LLM unavailable");
    expect(result.outcome).toBe("skipped-llm-failure");
    expect(judgePassed(result)).toBe(false);
    expect(result.score).toBeNull();
    expect(result.reason).toContain("LLM unavailable");
    expect(result.failedCriteria).toHaveLength(0);
  });
});

describe("createEvalJudgeNode", () => {
  test("creates node with correct kind and id", () => {
    const node = createEvalJudgeNode({
      id: N("my-judge"),
      criteria: ["factuality"],
    });
    expect(node.id).toBe(N("my-judge"));
    expect(node.kind).toBe("eval-judge");
  });

  test("uses default threshold of 0.8", () => {
    const node = createEvalJudgeNode({
      id: N("judge"),
      criteria: ["x"],
    });
    expect(node.config.threshold).toBeUndefined(); // stored as config, applied at runtime
  });

  describe("run()", () => {
    test("returns passing result when LLM scores above threshold", async () => {
      const llm = makeMockLlm({
        score: 0.9,
        criteria_scores: [{ name: "factuality", score: 0.95 }, { name: "relevance", score: 0.85 }],
        failed_criteria: [],
        reason: "Good summary",
      });

      const node = createEvalJudgeNode({
        id: N("judge"),
        criteria: ["factuality", "relevance"],
        threshold: 0.8,
      });

      const result = await node.run("input text", "output text", makeCtx({ judgeLlm: llm }));
      expect(judgePassed(result)).toBe(true);
      expect(result.score).toBe(0.9);
    });

    test("returns failing result when LLM scores below threshold", async () => {
      const llm = makeMockLlm({
        score: 0.5,
        criteria_scores: [{ name: "factuality", score: 0.3 }, { name: "relevance", score: 0.7 }],
        failed_criteria: ["factuality"],
        reason: "Contains hallucinations",
      });

      const node = createEvalJudgeNode({
        id: N("judge"),
        criteria: ["factuality", "relevance"],
        threshold: 0.8,
      });

      const result = await node.run("input", "output", makeCtx({ judgeLlm: llm }));
      expect(judgePassed(result)).toBe(false);
      expect(result.failedCriteria).toContain("factuality");
      expect(result.failedCriteria).toContain("relevance");
    });

    test("uses ctx.judgeLlm over ctx.llm", async () => {
      let calledWith = "";
      const judgeLlm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (_req) => {
          calledWith = "judgeLlm";
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };
      const mainLlm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async () => {
          calledWith = "mainLlm";
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      await node.run("in", "out", makeCtx({ llm: mainLlm, judgeLlm }));
      expect(calledWith).toBe("judgeLlm");
    });

    test("falls back to ctx.llm when judgeLlm not set", async () => {
      let calledWith = "";
      const mainLlm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async () => {
          calledWith = "mainLlm";
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      await node.run("in", "out", makeCtx({ llm: mainLlm }));
      expect(calledWith).toBe("mainLlm");
    });

    test("fails quality gating closed when no LLM client is available", async () => {
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      const result = await node.run("in", "out", makeCtx());
      expect(judgePassed(result)).toBe(false);
      expect(result.reason).toContain("No LLM client available");
    });

    test("fails quality gating closed when LLM returns an error", async () => {
      const llm = makeFailingLlm("rate limited");
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      const result = await node.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(judgePassed(result)).toBe(false);
      expect(result.reason).toContain("rate limited");
    });

    test("fails quality gating closed when LLM throws", async () => {
      const llm = makeThrowingLlm();
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      const result = await node.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(judgePassed(result)).toBe(false);
      expect(result.reason).toContain("network timeout");
    });

    test("fails quality gating closed when the structured response is invalid", async () => {
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async () => ok({
          output: { score: 2, criteria_scores: [], failed_criteria: [], reason: "invalid" },
          tokensIn: 0,
          tokensOut: 0,
          rawText: "",
        }) as any,
      };
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      const result = await node.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(result.outcome).toBe("skipped-llm-failure");
      expect(judgePassed(result)).toBe(false);
      expect(result.reason).toContain("Invalid judge response");
    });

    test("uses rubricInline in the prompt", async () => {
      let capturedUser = "";
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (req) => {
          capturedUser = req.user;
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      const node = createEvalJudgeNode({
        id: N("j"),
        criteria: ["tone"],
        rubric: { source: "inline", text: "Check that the tone is professional and neutral" },
      });
      await node.run("input", "output", makeCtx({ judgeLlm: llm }));
      expect(capturedUser).toContain("professional and neutral");
    });

    test("uses rubricTemplateId from prompts", async () => {
      let capturedUser = "";
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (req) => {
          capturedUser = req.user;
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      const prompts = { get: (name: string) => name === "custom-rubric" ? "Evaluate for Danish language quality" : null };
      const node = createEvalJudgeNode({
        id: N("j"),
        criteria: ["language"],
        rubric: { source: "template", templateId: "custom-rubric" },
      });
      await node.run("in", "out", makeCtx({ judgeLlm: llm, prompts }));
      expect(capturedUser).toContain("Danish language quality");
    });

    test("auto-generates rubric from criteria when no rubric provided", async () => {
      let capturedUser = "";
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (req) => {
          capturedUser = req.user;
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      const node = createEvalJudgeNode({
        id: N("j"),
        criteria: ["factuality", "completeness"],
        threshold: 0.7,
      });
      await node.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(capturedUser).toContain("- factuality:");
      expect(capturedUser).toContain("- completeness:");
      expect(capturedUser).toContain("0.7");
    });

    test("includes DAG input and output in the prompt", async () => {
      let capturedUser = "";
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (req) => {
          capturedUser = req.user;
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      await node.run({ topic: "AI safety" }, { summary: "AI is important" }, makeCtx({ judgeLlm: llm }));
      expect(capturedUser).toContain("AI safety");
      expect(capturedUser).toContain("AI is important");
    });

    test("uses JUDGE_SYSTEM_FRAME as system prompt", async () => {
      let capturedSystem = "";
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (req) => {
          capturedSystem = req.system;
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      await node.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(capturedSystem).toContain("quality evaluation judge");
    });

    test("uses configured model or defaults to gpt-4o-mini", async () => {
      let capturedModel = "";
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (req) => {
          capturedModel = req.model;
          return ok({ output: { score: 1, criteria_scores: [], failed_criteria: [], reason: "ok" }, tokensIn: 0, tokensOut: 0, rawText: "" }) as any;
        },
      };

      // Default model
      const node1 = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      await node1.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(capturedModel).toBe("gpt-4o-mini");

      // Custom model
      const node2 = createEvalJudgeNode({ id: N("j"), criteria: [N("x")], model: N("claude-haiku") });
      await node2.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(capturedModel).toBe("claude-haiku");
    });
  });
});
