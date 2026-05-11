#!/usr/bin/env bun
/**
 * Emit a guardrail span to MLflow by running the actual DAG.
 *
 * Prerequisites:
 *   docker compose -f infra/compose.yaml up mlflow
 *
 * Usage:
 *   bun run apps/customer-summary/scripts/guardrail-smoke.ts
 *
 * Then open http://localhost:5000 → Traces tab.
 */

import { resolve, join } from "node:path";
import {
  initTracing,
  createMlflowExporter,
  alwaysOn,
  FakeLlmClient,
  NoopObserver,
  runDag,
} from "@ai-summary/framework";
import type { NodeContext } from "@ai-summary/framework";
import type { SummaryResponse } from "../src/schemas/response.js";
import type { SynthesisOutput } from "../src/schemas/summary.js";
import { JsonFixtureSource } from "../src/sources/json-fixture-source.js";
import { createSummaryDag } from "../src/dag/summary-dag.js";

const MLFLOW_URI = process.env.MLFLOW_TRACKING_URI ?? "http://localhost:5000";
const fixturesDir = resolve(import.meta.dir, "../fixtures/customers");

// 1. Init tracing with alwaysOn so every span exports
const tracing = await initTracing({
  exporter: createMlflowExporter({
    url: MLFLOW_URI,
    experimentId: "0",
  }),
  policy: alwaysOn(),
});

const source = new JsonFixtureSource(fixturesDir);

// --- Case 1: Grounded summary (should pass guardrail) ---

const groundedOutput: SynthesisOutput = {
  overallSentiment: "positive",
  sentimentScore: 0.6,
  keyTopics: ["billing", "product"],
  summary: "Customer had 2 conversations about billing inquiries and product features. Generally satisfied.",
  actionItems: ["Follow up on upgrade interest"],
  riskLevel: "low",
  customerSatisfaction: "satisfied",
};

console.log("Running DAG with grounded LLM output (cust-001)...");
{
  const llm = new FakeLlmClient(() => groundedOutput);
  const ctx: NodeContext = {
    runId: "guardrail-smoke-grounded",
    dagId: "customer-summary",
    observer: new NoopObserver(),
    cache: null,
    logger: console,
    prompts: { get: () => "synthesis prompt" },
    llm,
  };
  const dag = createSummaryDag(source, "cust-001");
  const result = await runDag<{ customerId: string }, SummaryResponse>(dag, { customerId: "cust-001" }, ctx);

  if (result.ok && result.value.status === "ok") {
    console.log("  Status: ok");
    console.log("  Grounding warnings:", result.value.groundingWarnings ?? "none");
  } else {
    console.log("  Result:", JSON.stringify(result, null, 2));
  }
}

// --- Case 2: Hallucinating summary (should fail guardrail) ---

const hallucinatingOutput: SynthesisOutput = {
  overallSentiment: "negative",
  sentimentScore: -0.8,
  keyTopics: ["shipping", "outage", "compliance"],
  summary: "Across 7 conversations, the customer experienced severe shipping delays and repeated outages.",
  actionItems: ["Escalate shipping complaint"],
  riskLevel: "high",
  customerSatisfaction: "dissatisfied",
};

console.log("\nRunning DAG with hallucinating LLM output (cust-001)...");
{
  const llm = new FakeLlmClient(() => hallucinatingOutput);
  const ctx: NodeContext = {
    runId: "guardrail-smoke-hallucination",
    dagId: "customer-summary",
    observer: new NoopObserver(),
    cache: null,
    logger: console,
    prompts: { get: () => "synthesis prompt" },
    llm,
  };
  const dag = createSummaryDag(source, "cust-001");
  const result = await runDag<{ customerId: string }, SummaryResponse>(dag, { customerId: "cust-001" }, ctx);

  if (result.ok && result.value.status === "ok") {
    console.log("  Status: ok");
    console.log("  Summary:", result.value.summary.summary);
    console.log("  Grounding warnings:", JSON.stringify(result.value.groundingWarnings, null, 2));
  } else {
    console.log("  Result:", JSON.stringify(result, null, 2));
  }
}

// 3. Flush to MLflow
console.log(`\nFlushing spans to MLflow at ${MLFLOW_URI}...`);
await tracing.flush();
await tracing.shutdown();
console.log("Done. Open MLflow UI → Traces tab.");
console.log("You should see two traces:");
console.log("  1. guardrail-smoke-grounded — grounding-guardrail node shows OK");
console.log("  2. guardrail-smoke-hallucination — grounding-guardrail node shows ERROR (red)");
