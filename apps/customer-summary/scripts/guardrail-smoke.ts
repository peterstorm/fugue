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
} from "@fuguejs/framework";
import type { NodeContext } from "@fuguejs/framework";
import type { SummaryResponse } from "../src/schemas/response.js";
import type { SynthesisOutput } from "../src/schemas/summary.js";
import { JsonFixtureSource } from "../src/sources/json-fixture-source.js";
import { createSummaryDag } from "../src/dag/summary-dag.js";

const MLFLOW_URI = process.env.MLFLOW_TRACKING_URI ?? "http://localhost:5000";
const fixturesDir = resolve(import.meta.dir, "../fixtures/customers");
const print = (message: string, detail?: unknown): void => {
  const suffix = detail === undefined
    ? ""
    : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  process.stdout.write(`${message}${suffix}\n`);
};

// 1. Init tracing with alwaysOn so every span exports
const tracing = await initTracing({
  exporter: createMlflowExporter({
    url: MLFLOW_URI,
    experimentId: "0",
  }),
  policy: alwaysOn(),
});

const source = new JsonFixtureSource(fixturesDir);
const dag = createSummaryDag(source);

const runSmokeCase = async (testCase: Readonly<{
  runId: NodeContext["runId"];
  output: SynthesisOutput;
  onSuccess: (response: SummaryResponse) => void;
}>): Promise<void> => {
  const ctx: NodeContext = {
    runId: testCase.runId,
    dagId: "customer-summary",
    observer: new NoopObserver(),
    cache: null,
    logger: console,
    prompts: { get: () => "synthesis prompt" },
    llm: new FakeLlmClient(() => testCase.output),
  };
  const result = await runDag<{ customerId: string }, SummaryResponse>(
    dag,
    { customerId: "cust-001" },
    ctx,
  );

  if (result.ok && result.value.status === "ok") {
    testCase.onSuccess(result.value);
  } else {
    print("  Result:", JSON.stringify(result, null, 2));
  }
};

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

print("Running DAG with grounded LLM output (cust-001)...");
await runSmokeCase({
  runId: "guardrail-smoke-grounded",
  output: groundedOutput,
  onSuccess: (response) => {
    print("  Status: ok");
    print("  Grounding warnings:", response.groundingWarnings ?? "none");
  },
});

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

print("\nRunning DAG with hallucinating LLM output (cust-001)...");
await runSmokeCase({
  runId: "guardrail-smoke-hallucination",
  output: hallucinatingOutput,
  onSuccess: (response) => {
    print("  Status: ok");
    print("  Summary:", response.summary.summary);
    print("  Grounding warnings:", JSON.stringify(response.groundingWarnings, null, 2));
  },
});

// 3. Flush to MLflow
print(`\nFlushing spans to MLflow at ${MLFLOW_URI}...`);
await tracing.flush();
await tracing.shutdown();
print("Done. Open MLflow UI → Traces tab.");
print("You should see two traces:");
print("  1. guardrail-smoke-grounded — grounding-guardrail node shows OK");
print("  2. guardrail-smoke-hallucination — grounding-guardrail node shows ERROR (red)");
