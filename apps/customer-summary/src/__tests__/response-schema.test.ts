import { describe, test, expect } from "bun:test";
import { CrmRecordSchema } from "../schemas/crm.js";
import { SynthesisOutputSchema } from "../schemas/summary.js";
import { SummaryResponseSchema } from "../schemas/response.js";
import { JsonFixtureSource } from "../sources/json-fixture-source.js";
import { join } from "node:path";

const fixturesDir = join(import.meta.dir, "../../fixtures/customers");

describe("SummaryResponseSchema", () => {
  test("parses 'ok' status", () => {
    const input = {
      status: "ok",
      customerId: "cust-001",
      summary: {
        overallSentiment: "mixed",
        sentimentScore: 0.3,
        keyTopics: ["billing"],
        summary: "Customer had billing questions.",
        actionItems: [],
        riskLevel: "low",
        customerSatisfaction: "satisfied",
      },
    };
    const result = SummaryResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("parses 'not_found' status", () => {
    const result = SummaryResponseSchema.safeParse({
      status: "not_found",
      customerId: "cust-999",
      message: "Customer not found",
    });
    expect(result.success).toBe(true);
  });

  test("parses 'no_history' status", () => {
    const result = SummaryResponseSchema.safeParse({
      status: "no_history",
      customerId: "cust-018",
      message: "No conversations",
    });
    expect(result.success).toBe(true);
  });

  test("parses 'insufficient_data' status", () => {
    const result = SummaryResponseSchema.safeParse({
      status: "insufficient_data",
      customerId: "cust-015",
      message: "Not enough data",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = SummaryResponseSchema.safeParse({
      status: "invalid",
      customerId: "cust-001",
      message: "bad",
    });
    expect(result.success).toBe(false);
  });
});

describe("SynthesisOutputSchema", () => {
  test("validates correct output", () => {
    const result = SynthesisOutputSchema.safeParse({
      overallSentiment: "positive",
      sentimentScore: 0.8,
      keyTopics: ["support", "billing"],
      summary: "Great experience overall.",
      actionItems: ["Follow up on feature request"],
      riskLevel: "low",
      customerSatisfaction: "satisfied",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid output — missing keyTopics", () => {
    const result = SynthesisOutputSchema.safeParse({
      overallSentiment: "positive",
      sentimentScore: 0.8,
      keyTopics: [],
      summary: "Great.",
      actionItems: [],
      riskLevel: "low",
      customerSatisfaction: "satisfied",
    });
    expect(result.success).toBe(false);
  });

  test("rejects sentimentScore out of range", () => {
    const result = SynthesisOutputSchema.safeParse({
      overallSentiment: "positive",
      sentimentScore: 2.0,
      keyTopics: ["test"],
      summary: "Test.",
      actionItems: [],
      riskLevel: "low",
      customerSatisfaction: "satisfied",
    });
    expect(result.success).toBe(false);
  });
});

describe("CrmRecordSchema", () => {
  const customerIds = Array.from({ length: 20 }, (_, i) =>
    `cust-${String(i + 1).padStart(3, "0")}`
  );

  for (const id of customerIds) {
    test(`validates fixture ${id}`, async () => {
      const raw = await Bun.file(join(fixturesDir, `${id}.json`)).json();
      const result = CrmRecordSchema.safeParse(raw);
      if (!result.success) {
        console.error(`${id} validation error:`, result.error.message);
      }
      expect(result.success).toBe(true);
    });
  }
});

describe("JsonFixtureSource", () => {
  const source = new JsonFixtureSource(fixturesDir);

  test("loads a fixture correctly", async () => {
    const result = await source.fetchCustomer("cust-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value!.customerId).toBe("cust-001");
      expect(result.value!.name).toBe("Alice Johnson");
      expect(result.value!.conversations.length).toBeGreaterThan(0);
    }
  });

  test("returns null for non-existent customer", async () => {
    const result = await source.fetchCustomer("cust-nonexistent");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });
});
