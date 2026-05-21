import { describe, test, expect } from "bun:test";
import { createGroundingGuardrailNode } from "../dag/nodes/grounding-guardrail.js";
import { makeNodeContext } from "@fugue/framework";
import type { SynthesisOutput } from "../schemas/summary.js";
import type { CrmRecord } from "../schemas/crm.js";

const makeCtx = () => makeNodeContext({ runId: "test", dagId: "test" });

const makeSynthesis = (overrides: Partial<SynthesisOutput> = {}): SynthesisOutput => ({
  overallSentiment: "positive",
  sentimentScore: 0.5,
  keyTopics: ["billing"],
  summary: "Customer had a billing inquiry.",
  actionItems: [],
  riskLevel: "low",
  customerSatisfaction: "satisfied",
  ...overrides,
});

const makeRecord = (overrides: Partial<CrmRecord> = {}): CrmRecord => ({
  customerId: "test-001",
  name: "Test User",
  createdAt: "2024-01-01T00:00:00Z",
  conversations: [
    {
      id: "conv-1",
      date: "2024-06-01",
      channel: "chat",
      messages: [
        { role: "customer", content: "I have a billing question.", timestamp: "2024-06-01T10:00:00Z" },
        { role: "agent", content: "Let me check.", timestamp: "2024-06-01T10:01:00Z" },
      ],
    },
  ],
  ...overrides,
});

describe("grounding-guardrail node", () => {
  test("passes when synthesis is grounded", async () => {
    const node = createGroundingGuardrailNode();
    const result = await node.run(
      { "synthesize": makeSynthesis(), "fetch-crm": { customer: makeRecord() } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("validated");
      if (result.value.kind === "validated") {
        expect(result.value.passed).toBe(true);
        expect(result.value.warnings).toHaveLength(0);
        expect(result.value.value).toEqual(makeSynthesis());
      }
    }
  });

  test("fails when synthesis has ungrounded topics", async () => {
    const node = createGroundingGuardrailNode();
    const result = await node.run(
      { "synthesize": makeSynthesis({ keyTopics: ["shipping"] }), "fetch-crm": { customer: makeRecord() } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("validated");
      expect(result.value.passed).toBe(false);
      expect(result.value.warnings.length).toBeGreaterThan(0);
      // Value is still passed through
      if (result.value.kind === "validated") {
        expect(result.value.value.keyTopics).toContain("shipping");
      }
    }
  });

  test("returns passed=true with skip message when customer is null", async () => {
    const node = createGroundingGuardrailNode();
    const result = await node.run(
      { "synthesize": makeSynthesis(), "fetch-crm": { customer: null } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("validated");
      expect(result.value.passed).toBe(true);
      expect(result.value.checks[0].dimension).toBe("source_data");
      expect(result.value.checks[0].detail).toContain("No customer data");
    }
  });

  test("returns passed=true with skip when synthesis is undefined (non-ok branch)", async () => {
    const node = createGroundingGuardrailNode();
    const result = await node.run(
      { "synthesize": undefined, "fetch-crm": { customer: null } },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("skipped");
      expect(result.value.passed).toBe(true);
      expect(result.value.checks[0].detail).toContain("non-ok branch");
    }
  });
});
