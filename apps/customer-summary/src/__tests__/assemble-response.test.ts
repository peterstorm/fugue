import { describe, test, expect } from "bun:test";
import { createAssembleResponseNode } from "../dag/nodes/assemble-response.js";
import { NoopObserver } from "@ai-summary/framework";
import type { SynthesisOutput } from "../schemas/summary.js";
import type { GuardrailResult } from "@ai-summary/framework";

const makeCtx = () => ({
  runId: "test",
  dagId: "test",
  observer: new NoopObserver(),
  cache: null,
  logger: null,
  prompts: null,
  llm: null,
});

const makeSynthesis = (): SynthesisOutput => ({
  overallSentiment: "positive",
  sentimentScore: 0.5,
  keyTopics: ["billing"],
  summary: "Customer had a billing inquiry.",
  actionItems: [],
  riskLevel: "low",
  customerSatisfaction: "satisfied",
});

const makeGuardrailPassed = (): GuardrailResult<SynthesisOutput> => ({
  value: makeSynthesis(),
  passed: true,
  warnings: [],
  checks: [{ dimension: "topic_grounding", passed: true, detail: "All topics grounded" }],
});

const makeGuardrailFailed = (): GuardrailResult<SynthesisOutput> => ({
  value: makeSynthesis(),
  passed: false,
  warnings: ["[topic_grounding] Ungrounded topics: shipping"],
  checks: [
    { dimension: "topic_grounding", passed: false, detail: "Ungrounded topics: shipping" },
    { dimension: "sentiment_consistency", passed: true, detail: "Consistent" },
  ],
});

describe("assemble-response node", () => {
  test("ok branch with passing guardrail — no groundingWarnings", async () => {
    const node = createAssembleResponseNode("cust-001");
    const result = await node.run(
      {
        "extract-features": { branch: "ok" as const, recentUtterances: [], scoredConversations: [] },
        "grounding-guardrail": makeGuardrailPassed(),
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("ok");
      if (result.value.status === "ok") {
        expect(result.value.groundingWarnings).toBeUndefined();
        expect(result.value.summary.overallSentiment).toBe("positive");
      }
    }
  });

  test("ok branch with failing guardrail — includes groundingWarnings", async () => {
    const node = createAssembleResponseNode("cust-001");
    const result = await node.run(
      {
        "extract-features": { branch: "ok" as const, recentUtterances: [], scoredConversations: [] },
        "grounding-guardrail": makeGuardrailFailed(),
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("ok");
      if (result.value.status === "ok") {
        expect(result.value.groundingWarnings).toBeDefined();
        expect(result.value.groundingWarnings!.length).toBe(1);
        expect(result.value.groundingWarnings![0].dimension).toBe("topic_grounding");
      }
    }
  });

  test("ok branch with missing guardrail — degrades gracefully", async () => {
    const node = createAssembleResponseNode("cust-001");
    const result = await node.run(
      {
        "extract-features": { branch: "ok" as const, recentUtterances: [], scoredConversations: [] },
        "grounding-guardrail": undefined,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("ok");
    }
  });

  test("not_found branch ignores guardrail", async () => {
    const node = createAssembleResponseNode("cust-999");
    const result = await node.run(
      {
        "extract-features": { branch: "not_found" as const },
        "grounding-guardrail": undefined,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("not_found");
      expect(result.value.customerId).toBe("cust-999");
    }
  });

  test("no_history branch ignores guardrail", async () => {
    const node = createAssembleResponseNode("cust-019");
    const result = await node.run(
      {
        "extract-features": { branch: "no_history" as const },
        "grounding-guardrail": undefined,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("no_history");
    }
  });

  test("insufficient_data branch ignores guardrail", async () => {
    const node = createAssembleResponseNode("cust-017");
    const result = await node.run(
      {
        "extract-features": { branch: "insufficient_data" as const },
        "grounding-guardrail": undefined,
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("insufficient_data");
    }
  });
});
