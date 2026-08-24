import { RecordingObserver } from "../observer/observer.js";
import { testNodeContext } from "./_context-factories.js";
import { N } from "./_id-helpers.js";
import type { NodeId } from "../types/ids.js";
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
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

const makeCtx = (overrides: Partial<NodeContext> = {}): NodeContext => testNodeContext(overrides);

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

  test("supports criterion names that overlap object prototype keys", () => {
    const result = toEvalJudgeResult({
      score: 1,
      criteria_scores: [{ name: "__proto__", score: 1 }],
      failed_criteria: [],
      reason: "Valid",
    }, 0.8, ["__proto__"]);

    expect(result.outcome).toBe("passed");
    expect(Object.prototype.hasOwnProperty.call(result.criteriaScores, "__proto__")).toBe(true);
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
      failed_criteria: ["relevance"],
      reason: "Mostly good",
    };
    const result = toEvalJudgeResult(response, 0.8, ["factuality", "relevance"]);
    expect(judgePassed(result)).toBe(false);
    expect(result.failedCriteria).toContain("relevance");
    expect(result.failedCriteria).not.toContain("factuality");
  });

  test("fails closed when a configured criterion is omitted", () => {
    const result = toEvalJudgeResult({
      score: 1,
      criteria_scores: [{ name: "factuality", score: 1 }],
      failed_criteria: [],
      reason: "Incomplete evaluation",
    }, 0.8, ["factuality", "relevance"]);

    expect(result.outcome).toBe("skipped-llm-failure");
    expect(judgePassed(result)).toBe(false);
    expect(result.reason).toContain("missing: relevance");
  });

  test("fails closed on duplicate or unexpected criterion scores", () => {
    const duplicate = toEvalJudgeResult({
      score: 1,
      criteria_scores: [{ name: "factuality", score: 1 }, { name: "Factuality", score: 1 }],
      failed_criteria: [],
      reason: "Duplicate",
    }, 0.8, ["factuality"]);
    const unexpected = toEvalJudgeResult({
      score: 1,
      criteria_scores: [{ name: "factuality", score: 1 }, { name: "extra", score: 1 }],
      failed_criteria: [],
      reason: "Extra",
    }, 0.8, ["factuality"]);

    expect(duplicate.outcome).toBe("skipped-llm-failure");
    expect(unexpected.outcome).toBe("skipped-llm-failure");
  });

  test("fails closed when failed_criteria contradicts the criterion scores", () => {
    const result = toEvalJudgeResult({
      score: 0.9,
      criteria_scores: [{ name: "factuality", score: 0.2 }],
      failed_criteria: [],
      reason: "Contradictory",
    }, 0.8, ["factuality"]);

    expect(result.outcome).toBe("skipped-llm-failure");
    expect(result.reason).toContain("contradicts");
  });

  test("property: omitting any configured criterion can never pass", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 12 }),
      (ids) => {
        const criteria = ids.map((id) => `criterion-${id}`);
        const response: EvalJudgeResponse = {
          score: 1,
          criteria_scores: criteria.slice(1).map((name) => ({ name, score: 1 })),
          failed_criteria: [],
          reason: "Incomplete",
        };
        expect(judgePassed(toEvalJudgeResult(response, 0.8, criteria))).toBe(false);
      },
    ));
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

  test("normalizes the default threshold to 0.8 on the constructed definition", () => {
    const node = createEvalJudgeNode({
      id: N("judge"),
      criteria: ["x"],
    });
    expect(node.config.threshold).toBe(0.8);
  });

  test("rejects non-finite and out-of-range thresholds before constructing a judge", () => {
    for (const threshold of [-1, -Number.MIN_VALUE, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => createEvalJudgeNode({ id: N("judge"), criteria: ["x"], threshold })).toThrow(RangeError);
    }
  });

  test("accepts every finite threshold in the inclusive [0, 1] domain", () => {
    fc.assert(fc.property(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      (threshold) => {
        const node = createEvalJudgeNode({ id: N("judge"), criteria: ["x"], threshold });
        expect(node.config.threshold).toBe(threshold);
      },
    ));
  });

  test("snapshots nested caller configuration and runs from the immutable definition", async () => {
    const criteria = ["factuality"];
    const rubric: { source: "inline"; text: string } = { source: "inline", text: "original rubric" };
    const config = {
      id: N("original-judge"),
      criteria,
      threshold: 0.8,
      rubric,
      model: "original-model",
    };
    let capturedModel = "";
    let capturedUser = "";
    const node = createEvalJudgeNode(config);

    criteria[0] = "mutated";
    rubric.text = "mutated rubric";
    config.id = N("mutated-judge");
    config.model = "mutated-model";

    const result = await node.run("input", "output", makeCtx({
      judgeLlm: {
        sendWithTools: stubSendWithTools,
        sendStructured: async (request) => {
          capturedModel = request.model;
          capturedUser = request.user;
          return ok({
            output: {
              score: 1,
              criteria_scores: [{ name: "factuality", score: 1 }],
              failed_criteria: [],
              reason: "valid",
            },
            tokensIn: 0,
            tokensOut: 0,
            rawText: "",
          }) as any;
        },
      },
    }));

    expect(result.outcome).toBe("passed");
    expect(node.id).toBe(N("original-judge"));
    expect(node.config.criteria).toEqual(["factuality"]);
    expect(node.config.rubric).toEqual({ source: "inline", text: "original rubric" });
    expect(capturedModel).toBe("original-model");
    expect(capturedUser).toContain("original rubric");
    expect(Object.isFrozen(node.config)).toBe(true);
    expect(Object.isFrozen(node.config.criteria)).toBe(true);
    expect(Object.isFrozen(node.config.rubric)).toBe(true);
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
        failed_criteria: ["factuality", "relevance"],
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

    test("a throwing logger cannot violate the no-LLM result seam", async () => {
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });
      const result = await node.run("in", "out", makeCtx({
        logger: {
          warn: () => { throw new Error("logger transport down"); },
          error: () => {},
        },
      }));

      expect(result.outcome).toBe("skipped-llm-failure");
      expect(result.reason).toContain("No LLM client available");
    });

    test("cyclic DAG data cannot escape during prompt assembly", async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });

      const result = await node.run(cyclic, "out", makeCtx({ judgeLlm: makeMockLlm({
        score: 1,
        criteria_scores: [],
        failed_criteria: [],
        reason: "unused",
      }) }));

      // Orchestrator-side, not LLM-side: prompt assembly choked on the DAG's own
      // data before any model was consulted. That is a bug in us, so it surfaces
      // as `crash` — which is what makes it visible on `judgesCrashed` — rather
      // than being merged into the "model was flaky" bucket. Both fail closed.
      expect(result.outcome).toBe("crash");
      expect(judgePassed(result)).toBe(false);
      expect(result.reason).toContain("Unexpected error");
    });

    test("a throwing prompt provider returns a typed judge outcome", async () => {
      const node = createEvalJudgeNode({
        id: N("j"),
        criteria: [N("x")],
        rubric: { source: "template", templateId: "rubric" },
      });

      const result = await node.run("in", "out", makeCtx({
        judgeLlm: makeMockLlm({ score: 1, criteria_scores: [], failed_criteria: [], reason: "unused" }),
        prompts: { get: () => { throw new Error("prompt store unavailable"); } },
      }));

      // The prompt store broke its contract — again orchestrator-side, so the
      // outcome is `crash` and the cause survives on `crashMessage`.
      expect(result.outcome).toBe("crash");
      expect(judgePassed(result)).toBe(false);
      expect(result.reason).toContain("prompt store unavailable");
      if (result.outcome === "crash") {
        expect(result.crashMessage).toContain("prompt store unavailable");
      }
    });

    test("a hostile LLM rejection is rendered safely and never rejects node.run", async () => {
      const rejection = Proxy.revocable({}, {});
      rejection.revoke();
      const llm: LlmClient = {
        sendWithTools: stubSendWithTools,
        sendStructured: async () => { throw rejection.proxy; },
      };
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });

      const result = await node.run("in", "out", makeCtx({ judgeLlm: llm }));

      // An `LlmClient` that THROWS instead of returning `err(...)` has broken the
      // port contract. The LLM's modeled failure mode (`!result.ok`) still maps
      // to `skipped-llm-failure`; a contract violation is a `crash`.
      expect(result.outcome).toBe("crash");
      expect(judgePassed(result)).toBe(false);
      expect(result.reason).toContain("Unexpected error");
    });

    test("skipped evaluator sub-spans use the runtime event timestamp seam", async () => {
      const observer = new RecordingObserver();
      const fixed = new Date("2026-08-20T12:34:56.789Z");
      const node = createEvalJudgeNode({ id: N("j"), criteria: [N("x")] });

      await node.run("in", "out", makeCtx({
        judgeLlm: makeFailingLlm("unavailable"),
        observer,
        eventTimestamp: () => new Date(fixed),
      }));

      const subSpan = observer.events.find((event) => event.type === "sub-span");
      expect(subSpan?.timestamp).toEqual(fixed);
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
