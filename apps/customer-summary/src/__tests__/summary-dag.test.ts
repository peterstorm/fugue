import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { runDag, FakeLlmClient, NoopObserver } from "@ai-summary/framework";
import type { NodeContext } from "@ai-summary/framework";
import type { SummaryResponse } from "../schemas/response.js";
import type { SynthesisOutput } from "../schemas/summary.js";
import { JsonFixtureSource } from "../sources/json-fixture-source.js";
import { createSummaryDag } from "../dag/summary-dag.js";

const FIXTURES_DIR = join(import.meta.dir, "../../fixtures/customers");

const fakeSynthesisOutput: SynthesisOutput = {
  overallSentiment: "positive",
  sentimentScore: 0.7,
  keyTopics: ["billing", "product"],
  summary: "Customer had positive interactions about billing and product features.",
  actionItems: ["Follow up on upgrade interest"],
  riskLevel: "low",
  customerSatisfaction: "satisfied",
};

let callCount = 0;

const makeCtx = (): NodeContext => {
  callCount = 0;
  const llm = new FakeLlmClient((_req: any) => {
    callCount++;
    return fakeSynthesisOutput;
  });

  return {
    runId: "test-run",
    dagId: "customer-summary",
    observer: new NoopObserver(),
    cache: null,
    logger: null,
    prompts: { get: (_name: string) => "synthesis prompt template" },
    llm,
  };
};

describe("summary-dag", () => {
  test("happy path: ok response for customer with conversations", async () => {
    const source = new JsonFixtureSource(FIXTURES_DIR);
    const dag = createSummaryDag(source, "cust-001");
    const ctx = makeCtx();

    const result = await runDag<{ customerId: string }, SummaryResponse>(
      dag,
      { customerId: "cust-001" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("ok");
      if (result.value.status === "ok") {
        expect(result.value.summary.overallSentiment).toBe("positive");
        expect(result.value.summary.keyTopics).toContain("billing");
        expect(result.value.customerId).toBe("cust-001");
      }
    }

    // FR-103: one synthesis LLM call + one eval-judge call on happy path
    expect(callCount).toBe(2);
  });

  test("not_found branch for missing customer", async () => {
    const source = new JsonFixtureSource(FIXTURES_DIR);
    const dag = createSummaryDag(source, "nonexistent-999");
    const ctx = makeCtx();

    const result = await runDag<{ customerId: string }, SummaryResponse>(
      dag,
      { customerId: "nonexistent-999" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("not_found");
      expect(result.value.customerId).toBe("nonexistent-999");
    }

    // No synthesis LLM call for not_found (1 call is the eval-judge, which fails open)
    expect(callCount).toBe(1);
  });

  test("no_history branch for customer with no conversations", async () => {
    const source = new JsonFixtureSource(FIXTURES_DIR);
    const dag = createSummaryDag(source, "cust-019");
    const ctx = makeCtx();

    const result = await runDag<{ customerId: string }, SummaryResponse>(
      dag,
      { customerId: "cust-019" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("no_history");
      expect(result.value.customerId).toBe("cust-019");
    }

    // No synthesis LLM call for no_history (1 call is the eval-judge, which fails open)
    expect(callCount).toBe(1);
  });

  test("insufficient_data branch for minimal customer", async () => {
    const source = new JsonFixtureSource(FIXTURES_DIR);
    const dag = createSummaryDag(source, "cust-017");
    const ctx = makeCtx();

    const result = await runDag<{ customerId: string }, SummaryResponse>(
      dag,
      { customerId: "cust-017" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("insufficient_data");
      expect(result.value.customerId).toBe("cust-017");
    }

    // No synthesis LLM call for insufficient_data (1 call is the eval-judge, which fails open)
    expect(callCount).toBe(1);
  });
});
