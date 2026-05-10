import { describe, test, expect } from "bun:test";
import {
  createEvalJudgeNode,
  toEvalJudgeResult,
  failOpenResult,
  EvalJudgeResponseSchema,
} from "../../src/nodes/eval-judge.js";
import type { EvalJudgeResponse } from "../../src/nodes/eval-judge.js";
import type { NodeContext } from "../../src/types/node.js";
import type { LlmClient } from "../../src/llm/client.js";
import { ok, err } from "../../src/types/result.js";
import { stubSendWithTools } from "./_llm-mocks.js";

// --- Helpers ---

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run",
  dagId: "test-dag",
  observer: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: null,
  ...overrides,
});

const makeMockLlm = (response: EvalJudgeResponse): LlmClient => ({
  sendWithTools: stubSendWithTools,
  sendStructured: async () => ok({ output: response, tokensIn: 100, tokensOut: 50, rawText: "" }) as any,
});

const makeFailingLlm = (message: string): LlmClient => ({
  sendWithTools: stubSendWithTools,
  sendStructured: async () => err({ kind: "node-crash", nodeId: "judge", message }) as any,
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
    expect(result.passed).toBe(true);
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
    expect(result.passed).toBe(false);
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
    expect(result.passed).toBe(false);
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
    expect(result.passed).toBe(true);
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
    expect(result.passed).toBe(true);
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
    expect(result.passed).toBe(true);
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

describe("failOpenResult", () => {
  test("returns passed: true with reason", () => {
    const result = failOpenResult("LLM unavailable");
    expect(result.passed).toBe(true);
    // Score is null when the judge couldn't run — distinct from a 1.0 verdict.
    expect(result.score).toBeNull();
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("LLM unavailable");
    expect(result.failedCriteria).toHaveLength(0);
  });
});

describe("createEvalJudgeNode", () => {
  test("creates node with correct kind and id", () => {
    const node = createEvalJudgeNode({
      id: "my-judge",
      criteria: ["factuality"],
    });
    expect(node.id).toBe("my-judge");
    expect(node.kind).toBe("eval-judge");
  });

  test("uses default threshold of 0.8", () => {
    const node = createEvalJudgeNode({
      id: "judge",
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
        id: "judge",
        criteria: ["factuality", "relevance"],
        threshold: 0.8,
      });

      const result = await node.run("input text", "output text", makeCtx({ judgeLlm: llm }));
      expect(result.passed).toBe(true);
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
        id: "judge",
        criteria: ["factuality", "relevance"],
        threshold: 0.8,
      });

      const result = await node.run("input", "output", makeCtx({ judgeLlm: llm }));
      expect(result.passed).toBe(false);
      expect(result.failedCriteria).toContain("factuality");
      expect(result.failedCriteria).toContain("relevance");
    });

    test("uses ctx.judgeLlm over ctx.llm", async () => {
      let calledWith = "";
      const judgeLlm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async (req) => {
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

      const node = createEvalJudgeNode({ id: "j", criteria: ["x"] });
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

      const node = createEvalJudgeNode({ id: "j", criteria: ["x"] });
      await node.run("in", "out", makeCtx({ llm: mainLlm }));
      expect(calledWith).toBe("mainLlm");
    });

    test("fail-open when no LLM client available", async () => {
      const node = createEvalJudgeNode({ id: "j", criteria: ["x"] });
      const result = await node.run("in", "out", makeCtx());
      expect(result.passed).toBe(true);
      expect(result.reason).toContain("No LLM client available");
    });

    test("fail-open when LLM returns error", async () => {
      const llm = makeFailingLlm("rate limited");
      const node = createEvalJudgeNode({ id: "j", criteria: ["x"] });
      const result = await node.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(result.passed).toBe(true);
      expect(result.reason).toContain("rate limited");
    });

    test("fail-open when LLM throws exception", async () => {
      const llm = makeThrowingLlm();
      const node = createEvalJudgeNode({ id: "j", criteria: ["x"] });
      const result = await node.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(result.passed).toBe(true);
      expect(result.reason).toContain("network timeout");
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
        id: "j",
        criteria: ["tone"],
        rubricInline: "Check that the tone is professional and neutral",
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
        id: "j",
        criteria: ["language"],
        rubricTemplateId: "custom-rubric",
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
        id: "j",
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

      const node = createEvalJudgeNode({ id: "j", criteria: ["x"] });
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

      const node = createEvalJudgeNode({ id: "j", criteria: ["x"] });
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
      const node1 = createEvalJudgeNode({ id: "j", criteria: ["x"] });
      await node1.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(capturedModel).toBe("gpt-4o-mini");

      // Custom model
      const node2 = createEvalJudgeNode({ id: "j", criteria: ["x"], model: "claude-haiku" });
      await node2.run("in", "out", makeCtx({ judgeLlm: llm }));
      expect(capturedModel).toBe("claude-haiku");
    });
  });
});
