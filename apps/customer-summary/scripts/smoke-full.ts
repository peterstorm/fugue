#!/usr/bin/env bun
/**
 * Comprehensive MLflow smoke test — exercises tool calls, multi-node DAGs,
 * eval judges, retries, and branching to produce rich traces in MLflow.
 *
 * Prerequisites:
 *   podman compose -f infra/compose.yaml up mlflow   (or docker compose)
 *
 * Usage:
 *   # With real LLM (needs OPENAI_API_KEY or ANTHROPIC_API_KEY):
 *   OPENAI_API_KEY=sk-... bun run apps/customer-summary/scripts/smoke-full.ts
 *
 *   # With fake LLM (no API keys needed — scripted tool calls):
 *   bun run apps/customer-summary/scripts/smoke-full.ts
 *
 * Then open http://localhost:5000 → Traces tab.
 */

import { resolve } from "node:path";
import { z } from "zod";
import {
  initTracing,
  createMlflowExporter,
  alwaysOn,
  FakeLlmClient,
  NoopObserver,
  RecordingObserver,
  runDag,
  defineDag,
  createFetchNode,
  createTransformNode,
  createLlmNode,
  createLlmWithToolsNode,
  createGuardrailNode,
  createEvalJudgeNode,
  makeNodeContext,
  ok,
} from "@ai-summary/framework";
import type { ToolDef, ToolCall, NodeContext } from "@ai-summary/framework";
import { OpenAILlmClient } from "@ai-summary/framework";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { JsonFixtureSource } from "../src/sources/json-fixture-source.js";
import { createSummaryDag } from "../src/dag/summary-dag.js";
import type { SummaryResponse } from "../src/schemas/response.js";
import type { SynthesisOutput } from "../src/schemas/summary.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MLFLOW_URI = process.env.MLFLOW_TRACKING_URI ?? "http://localhost:5000";
const fixturesDir = resolve(import.meta.dir, "../fixtures/customers");
const USE_REAL_LLM = Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

console.log(`MLflow URI: ${MLFLOW_URI}`);
console.log(`Mode: ${USE_REAL_LLM ? "REAL LLM" : "FAKE LLM (scripted)"}`);
console.log("---");

// ---------------------------------------------------------------------------
// 1. Init tracing
// ---------------------------------------------------------------------------

const tracing = await initTracing({
  exporter: createMlflowExporter({ url: MLFLOW_URI, experimentId: "0" }),
  policy: alwaysOn(),
});

/**
 * OTel-backed Tracer adapter — creates real OTel spans so tool calls and LLM
 * calls show up as separate spans in MLflow with proper parent-child nesting.
 */
const otelTracer: Tracer = {
  withSpan: async <T>(name: string, spanType: string, fn: () => Promise<T>): Promise<T> => {
    const tracer = trace.getTracer("ai-summary-framework");
    return tracer.startActiveSpan(name, { attributes: { "ai.span.type": spanType } }, async (span) => {
      try {
        const result = await fn();
        return result;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        span.end();
      }
    });
  },
};

// ---------------------------------------------------------------------------
// Helper: build LLM client
// ---------------------------------------------------------------------------

function buildLlmClient() {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAILlmClient({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
    });
  }
  // Fall through to fake
  return null;
}

const realLlm = buildLlmClient();

// ---------------------------------------------------------------------------
// Case 1: Full production DAG (customer summary with guardrail)
// ---------------------------------------------------------------------------

console.log("=== Case 1: Full production DAG (customer summary) ===");
{
  const source = new JsonFixtureSource(fixturesDir);

  const groundedOutput: SynthesisOutput = {
    overallSentiment: "positive",
    sentimentScore: 0.6,
    keyTopics: ["billing", "product"],
    summary:
      "Customer had 2 conversations about billing inquiries and product features. " +
      "Generally satisfied with support responses.",
    actionItems: ["Follow up on upgrade interest"],
    riskLevel: "low",
    customerSatisfaction: "satisfied",
  };

  const llm = realLlm ?? new FakeLlmClient(() => groundedOutput);
  const observer = new RecordingObserver();
  const ctx: NodeContext = {
    runId: "smoke-case-1-full-dag",
    dagId: "customer-summary",
    observer,
    cache: null,
    tracer: otelTracer,
    logger: console,
    prompts: { get: () => "You are a customer analyst..." },
    llm,
    judgeLlm: llm,
  };

  const dag = createSummaryDag(source, "cust-001");
  const result = await runDag<{ customerId: string }, SummaryResponse>(
    dag,
    { customerId: "cust-001" },
    ctx,
  );

  if (result.ok && result.value.status === "ok") {
    console.log("  ✓ Status: ok");
    console.log(`  Topics: ${result.value.summary.keyTopics.join(", ")}`);
    console.log(`  Grounding: ${result.value.groundingWarnings?.length ?? 0} warnings`);
  } else {
    console.log("  Result:", JSON.stringify(result, null, 2).slice(0, 300));
  }
  console.log(`  Observer events: ${observer.events.length}`);
}

// ---------------------------------------------------------------------------
// Case 2: Tool-call node — CRM deal lookup
// ---------------------------------------------------------------------------

console.log("\n=== Case 2: LLM with tool calls (CRM deal lookup) ===");
{
  // Simulated CRM data
  const crmDeals = [
    { id: "deal-101", amount: 15000, closedAt: "2024-08-15", product: "Enterprise Plan" },
    { id: "deal-102", amount: 8500, closedAt: "2024-09-20", product: "Support Add-on" },
    { id: "deal-103", amount: 22000, closedAt: "2024-11-01", product: "Platform License" },
  ];

  const lookupDealsTool: ToolDef<
    { customerId: string; limit?: number },
    { deals: typeof crmDeals }
  > = {
    name: "lookup_deals",
    description: "Fetch closed deals for a customer from the CRM system.",
    inputSchema: z.object({
      customerId: z.string(),
      limit: z.number().int().positive().max(50).optional(),
    }),
    outputSchema: z.object({
      deals: z.array(z.object({
        id: z.string(),
        amount: z.number(),
        closedAt: z.string(),
        product: z.string(),
      })),
    }),
    run: async ({ customerId, limit }) => {
      // Simulate latency
      await new Promise((r) => setTimeout(r, 50));
      console.log(`    [tool] lookup_deals called for ${customerId} (limit=${limit ?? 20})`);
      return { deals: crmDeals.slice(0, limit ?? 20) };
    },
  };

  const getAccountInfoTool: ToolDef<
    { customerId: string },
    { accountType: string; tier: string; since: string }
  > = {
    name: "get_account_info",
    description: "Retrieve account metadata including tier and creation date.",
    inputSchema: z.object({ customerId: z.string() }),
    outputSchema: z.object({
      accountType: z.string(),
      tier: z.string(),
      since: z.string(),
    }),
    run: async ({ customerId }) => {
      await new Promise((r) => setTimeout(r, 30));
      console.log(`    [tool] get_account_info called for ${customerId}`);
      return { accountType: "business", tier: "enterprise", since: "2022-03-01" };
    },
  };

  const DealSummarySchema = z.object({
    summary: z.string(),
    totalRevenue: z.number(),
    dealCount: z.number(),
    accountTier: z.string(),
    recommendation: z.string(),
  });

  type DealSummary = z.infer<typeof DealSummarySchema>;

  // Script: LLM calls both tools then produces final answer
  const toolCallScript: Array<
    | { type: "tool_use"; calls: readonly ToolCall[]; tokensIn?: number; tokensOut?: number }
    | { type: "final"; content: unknown; tokensIn?: number; tokensOut?: number }
  > = [
    // Turn 1: LLM requests account info
    {
      type: "tool_use",
      calls: [
        { id: "tc-1", name: "get_account_info", input: { customerId: "cust-001" } },
      ],
      tokensIn: 320,
      tokensOut: 45,
    },
    // Turn 2: LLM requests deals
    {
      type: "tool_use",
      calls: [
        { id: "tc-2", name: "lookup_deals", input: { customerId: "cust-001", limit: 10 } },
      ],
      tokensIn: 450,
      tokensOut: 38,
    },
    // Turn 3: Final structured answer
    {
      type: "final",
      content: {
        summary:
          "Enterprise customer since 2022 with 3 closed deals totaling $45,500. " +
          "Strong platform adoption with recent support add-on purchase.",
        totalRevenue: 45500,
        dealCount: 3,
        accountTier: "enterprise",
        recommendation: "Candidate for strategic account review — high LTV trajectory.",
      } satisfies DealSummary,
      tokensIn: 680,
      tokensOut: 120,
    },
  ];

  const llm = new FakeLlmClient(() => ({}), { withToolsScript: toolCallScript });
  const observer = new RecordingObserver();

  const toolNode = createLlmWithToolsNode({
    id: "deal-analysis",
    inputSchema: z.object({ customerId: z.string() }),
    outputSchema: DealSummarySchema,
    model: "gpt-4o",
    tools: [
      lookupDealsTool as ToolDef<unknown, unknown>,
      getAccountInfoTool as ToolDef<unknown, unknown>,
    ],
    maxIterations: 5,
    system:
      "You are a revenue analyst. Use the available tools to gather account " +
      "and deal information, then produce a structured summary with recommendation.",
    buildUser: (input) => `Analyze customer: ${input.customerId}`,
  });

  const dag = defineDag({
    id: "deal-analysis-dag",
    nodes: { "deal-analysis": toolNode },
    edges: [],
    outputNodeId: "deal-analysis",
  });

  const ctx = makeNodeContext({
    runId: "smoke-case-2-tool-calls",
    dagId: "deal-analysis-dag",
    tracer: otelTracer,
    observer,
    llm,
    prompts: { get: () => null },
  });

  const result = await runDag<{ customerId: string }, DealSummary>(
    dag,
    { customerId: "cust-001" },
    ctx,
  );

  if (result.ok) {
    console.log("  ✓ Status: ok");
    console.log(`  Revenue: $${result.value.totalRevenue}`);
    console.log(`  Deals: ${result.value.dealCount}`);
    console.log(`  Recommendation: ${result.value.recommendation}`);
  } else {
    console.log("  ✗ Error:", JSON.stringify(result.error, null, 2).slice(0, 300));
  }
  console.log(`  Observer events: ${observer.events.length}`);
}

// ---------------------------------------------------------------------------
// Case 3: Multi-node DAG with parallel branches + guardrail + eval judge
// ---------------------------------------------------------------------------

console.log("\n=== Case 3: Multi-node DAG (fetch → parallel analysis → guardrail → assemble) ===");
{
  // Schemas
  const CustomerDataSchema = z.object({
    name: z.string(),
    accountType: z.string(),
    conversationCount: z.number(),
    lastContact: z.string(),
  });
  const SentimentSchema = z.object({
    sentiment: z.enum(["positive", "negative", "neutral", "mixed"]),
    confidence: z.number(),
  });
  const RiskSchema = z.object({
    riskLevel: z.enum(["low", "medium", "high"]),
    factors: z.array(z.string()),
  });
  const FinalReportSchema = z.object({
    customerName: z.string(),
    sentiment: z.string(),
    riskLevel: z.string(),
    riskFactors: z.array(z.string()),
    recommendation: z.string(),
  });
  type FinalReport = z.infer<typeof FinalReportSchema>;

  // Nodes
  const fetchCustomer = createFetchNode({
    id: "fetch-customer",
    inputSchema: z.object({ customerId: z.string() }),
    outputSchema: CustomerDataSchema,
    fetch: async (input) => {
      await new Promise((r) => setTimeout(r, 40));
      return ok({
        name: "Alice Johnson",
        accountType: "enterprise",
        conversationCount: 12,
        lastContact: "2024-11-15",
      });
    },
  });

  const analyzeSentiment = createLlmNode({
    id: "analyze-sentiment",
    inputSchema: CustomerDataSchema,
    outputSchema: SentimentSchema,
    model: "gpt-4o-mini",
    promptName: "sentiment-analysis",
    system: "Analyze customer sentiment based on their interaction history.",
    buildInput: (input) => ({
      name: input.name,
      accountType: input.accountType,
      conversations: input.conversationCount,
      lastContact: input.lastContact,
    }),
  });

  const assessRisk = createLlmNode({
    id: "assess-risk",
    inputSchema: CustomerDataSchema,
    outputSchema: RiskSchema,
    model: "gpt-4o-mini",
    promptName: "risk-assessment",
    system: "Assess churn risk based on customer profile and engagement patterns.",
    buildInput: (input) => ({
      name: input.name,
      accountType: input.accountType,
      conversations: input.conversationCount,
      lastContact: input.lastContact,
    }),
  });

  const assembleReport = createTransformNode({
    id: "assemble-report",
    inputSchema: z.object({
      "analyze-sentiment": SentimentSchema,
      "assess-risk": RiskSchema,
      "fetch-customer": CustomerDataSchema,
    }),
    outputSchema: FinalReportSchema,
    transform: (inputs) =>
      ok({
        customerName: inputs["fetch-customer"].name,
        sentiment: inputs["analyze-sentiment"].sentiment,
        riskLevel: inputs["assess-risk"].riskLevel,
        riskFactors: inputs["assess-risk"].factors,
        recommendation:
          inputs["assess-risk"].riskLevel === "high"
            ? "Immediate outreach required"
            : "Continue standard engagement cadence",
      }),
  });

  // Guardrail: verify the report doesn't have contradictory sentiment/risk
  const GuardrailOutputSchema = z.object({
    kind: z.literal("validated"),
    value: FinalReportSchema,
    passed: z.boolean(),
    warnings: z.array(z.string()),
    checks: z.array(z.object({ dimension: z.string(), passed: z.boolean(), detail: z.string() })),
  });

  const consistencyGuardrail = createGuardrailNode<z.infer<typeof FinalReportSchema>, z.infer<typeof FinalReportSchema>>({
    id: "consistency-check",
    inputSchema: FinalReportSchema,
    outputSchema: GuardrailOutputSchema as any,
    validate: (report) => {
      const checks: Array<{ dimension: string; passed: boolean; detail: string }> = [];
      const warnings: string[] = [];

      // Check sentiment-risk consistency
      if (report.sentiment === "positive" && report.riskLevel === "high") {
        checks.push({ dimension: "sentiment-risk-consistency", passed: false, detail: "Positive sentiment contradicts high risk" });
        warnings.push("Positive sentiment contradicts high risk assessment");
      } else {
        checks.push({ dimension: "sentiment-risk-consistency", passed: true, detail: "Consistent" });
      }

      // Check recommendation presence
      if (report.recommendation.length > 10) {
        checks.push({ dimension: "has-recommendation", passed: true, detail: "Present" });
      } else {
        checks.push({ dimension: "has-recommendation", passed: false, detail: "Recommendation too short" });
        warnings.push("Recommendation too short");
      }

      return {
        kind: "validated" as const,
        value: report,
        passed: checks.every((c) => c.passed),
        warnings,
        checks,
      };
    },
  });

  // Build DAG with parallel fan-out from fetch
  const dag = defineDag({
    id: "customer-health-report",
    nodes: {
      "fetch-customer": fetchCustomer,
      "analyze-sentiment": analyzeSentiment,
      "assess-risk": assessRisk,
      "assemble-report": assembleReport,
      "consistency-check": consistencyGuardrail,
    },
    edges: [
      { from: "fetch-customer", to: "analyze-sentiment" },
      { from: "fetch-customer", to: "assess-risk" },
      { from: "analyze-sentiment", to: "assemble-report" },
      { from: "assess-risk", to: "assemble-report" },
      { from: "fetch-customer", to: "assemble-report" },
      { from: "assemble-report", to: "consistency-check" },
    ],
    outputNodeId: "consistency-check",
  });

  // Fake LLM that returns appropriate shaped data per node
  const llm = new FakeLlmClient((req) => {
    if (req.nodeId === "analyze-sentiment") {
      return { sentiment: "positive", confidence: 0.82 };
    }
    if (req.nodeId === "assess-risk") {
      return { riskLevel: "low", factors: ["low engagement frequency", "long time since last contact"] };
    }
    return {};
  });

  const observer = new RecordingObserver();
  const ctx = makeNodeContext({
    runId: "smoke-case-3-parallel-dag",
    dagId: "customer-health-report",
    tracer: otelTracer,
    observer,
    llm,
    prompts: {
      get: (name: string) => {
        const templates: Record<string, string> = {
          "sentiment-analysis":
            "Analyze sentiment for customer {{name}} ({{accountType}} account, " +
            "{{conversations}} conversations, last contact {{lastContact}}).",
          "risk-assessment":
            "Assess churn risk for customer {{name}} ({{accountType}} account, " +
            "{{conversations}} conversations, last contact {{lastContact}}).",
        };
        return templates[name] ?? null;
      },
    },
  });

  const result = await runDag<{ customerId: string }, any>(
    dag,
    { customerId: "cust-001" },
    ctx,
  );

  if (result.ok) {
    const report = result.value.value ?? result.value;
    console.log("  ✓ Status: ok");
    console.log(`  Customer: ${report.customerName}`);
    console.log(`  Sentiment: ${report.sentiment}`);
    console.log(`  Risk: ${report.riskLevel} (${report.riskFactors?.join(", ") ?? "none"})`);
    console.log(`  Recommendation: ${report.recommendation}`);
    if (result.value.warnings?.length) {
      console.log(`  Guardrail warnings: ${result.value.warnings.join(", ")}`);
    }
  } else {
    console.log("  ✗ Error:", JSON.stringify(result.error, null, 2).slice(0, 300));
  }
  console.log(`  Observer events: ${observer.events.length}`);
}

// ---------------------------------------------------------------------------
// Case 4: Tool calls with parallel tool dispatch (2 tools called simultaneously)
// ---------------------------------------------------------------------------

console.log("\n=== Case 4: Parallel tool dispatch (weather + calendar in one turn) ===");
{
  const weatherTool: ToolDef<{ city: string }, { temp: number; condition: string }> = {
    name: "get_weather",
    description: "Get current weather for a city",
    inputSchema: z.object({ city: z.string() }),
    outputSchema: z.object({ temp: z.number(), condition: z.string() }),
    run: async ({ city }) => {
      await new Promise((r) => setTimeout(r, 60));
      console.log(`    [tool] get_weather called for ${city}`);
      return { temp: 18, condition: "partly cloudy" };
    },
  };

  const calendarTool: ToolDef<{ date: string }, { events: string[] }> = {
    name: "check_calendar",
    description: "Check calendar events for a date",
    inputSchema: z.object({ date: z.string() }),
    outputSchema: z.object({ events: z.array(z.string()) }),
    run: async ({ date }) => {
      await new Promise((r) => setTimeout(r, 45));
      console.log(`    [tool] check_calendar called for ${date}`);
      return { events: ["Team standup 9:00", "Client call 14:00", "Sprint review 16:00"] };
    },
  };

  const BriefingSchema = z.object({
    greeting: z.string(),
    weatherSummary: z.string(),
    todayEvents: z.array(z.string()),
    suggestion: z.string(),
  });
  type Briefing = z.infer<typeof BriefingSchema>;

  // Script: single turn dispatches BOTH tools in parallel, then final answer
  const script = [
    {
      type: "tool_use" as const,
      calls: [
        { id: "tc-w", name: "get_weather", input: { city: "Copenhagen" } },
        { id: "tc-c", name: "check_calendar", input: { date: "2024-12-10" } },
      ],
      tokensIn: 280,
      tokensOut: 62,
    },
    {
      type: "final" as const,
      content: {
        greeting: "Good morning! Here's your daily briefing.",
        weatherSummary: "18°C and partly cloudy in Copenhagen — light jacket weather.",
        todayEvents: ["Team standup 9:00", "Client call 14:00", "Sprint review 16:00"],
        suggestion: "Consider walking to the client meeting — weather is mild.",
      } satisfies Briefing,
      tokensIn: 520,
      tokensOut: 95,
    },
  ];

  const llm = new FakeLlmClient(() => ({}), { withToolsScript: script });
  const observer = new RecordingObserver();

  const briefingNode = createLlmWithToolsNode({
    id: "morning-briefing",
    inputSchema: z.object({ userId: z.string() }),
    outputSchema: BriefingSchema,
    model: "gpt-4o",
    tools: [
      weatherTool as ToolDef<unknown, unknown>,
      calendarTool as ToolDef<unknown, unknown>,
    ],
    maxIterations: 3,
    system: "You are a personal assistant. Check weather and calendar, then provide a morning briefing.",
    buildUser: (input) => `Prepare morning briefing for user ${input.userId} in Copenhagen.`,
  });

  const dag = defineDag({
    id: "morning-briefing-dag",
    nodes: { "morning-briefing": briefingNode },
    edges: [],
    outputNodeId: "morning-briefing",
  });

  const ctx = makeNodeContext({
    runId: "smoke-case-4-parallel-tools",
    dagId: "morning-briefing-dag",
    tracer: otelTracer,
    observer,
    llm,
  });

  const result = await runDag<{ userId: string }, Briefing>(
    dag,
    { userId: "user-42" },
    ctx,
  );

  if (result.ok) {
    console.log("  ✓ Status: ok");
    console.log(`  Greeting: ${result.value.greeting}`);
    console.log(`  Weather: ${result.value.weatherSummary}`);
    console.log(`  Events: ${result.value.todayEvents.length}`);
    console.log(`  Suggestion: ${result.value.suggestion}`);
  } else {
    console.log("  ✗ Error:", JSON.stringify(result.error, null, 2).slice(0, 300));
  }
  console.log(`  Observer events: ${observer.events.length}`);
}

// ---------------------------------------------------------------------------
// Case 5: Tool call that fails (exercises error telemetry path)
// ---------------------------------------------------------------------------

console.log("\n=== Case 5: Tool call failure (exercises error spans) ===");
{
  const failingTool: ToolDef<{ query: string }, { results: string[] }> = {
    name: "search_knowledge_base",
    description: "Search internal knowledge base",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ results: z.array(z.string()) }),
    run: async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error("Connection refused: knowledge-base service unavailable");
    },
  };

  const AnswerSchema = z.object({ answer: z.string(), sources: z.array(z.string()) });
  type Answer = z.infer<typeof AnswerSchema>;

  // Script: LLM calls tool (which throws), then tries again — but tool keeps failing.
  // No final turn provided, so the script runs out and the node fails.
  const failingScript = [
    {
      type: "tool_use" as const,
      calls: [{ id: "tc-s1", name: "search_knowledge_base", input: { query: "refund policy" } }],
      tokensIn: 150,
      tokensOut: 30,
    },
    // Model sees the error and tries again
    {
      type: "tool_use" as const,
      calls: [{ id: "tc-s2", name: "search_knowledge_base", input: { query: "refund policy retry" } }],
      tokensIn: 200,
      tokensOut: 25,
    },
    // No final turn — script exhausts, node crashes
  ];

  const llm = new FakeLlmClient(() => ({}), { withToolsScript: failingScript });
  const observer = new RecordingObserver();

  const node = createLlmWithToolsNode({
    id: "kb-search",
    inputSchema: z.object({ question: z.string() }),
    outputSchema: AnswerSchema,
    model: "gpt-4o",
    tools: [failingTool as ToolDef<unknown, unknown>],
    maxIterations: 5,
    system: "Search the knowledge base and answer the user's question.",
    buildUser: (input) => input.question,
  });

  const dag = defineDag({
    id: "kb-qa-dag",
    nodes: { "kb-search": node },
    edges: [],
    outputNodeId: "kb-search",
  });

  const ctx = makeNodeContext({
    runId: "smoke-case-5-tool-failure",
    dagId: "kb-qa-dag",
    tracer: otelTracer,
    observer,
    llm,
  });

  const result = await runDag<{ question: string }, Answer>(
    dag,
    { question: "What is the refund policy?" },
    ctx,
  );

  if (result.ok) {
    console.log("  ✓ Status: ok (unexpected — should have failed)");
  } else {
    console.log("  ✗ Failed as expected:", result.error.kind);
    console.log(`    Message: ${"message" in result.error ? result.error.message : ""}`);
  }
  // Check observer captured the tool error event
  const errorEvents = observer.events.filter(
    (e) => e.type === "sub-span" && (e as any).attributes?.["tool.error"],
  );
  console.log(`  Observer events: ${observer.events.length} (tool errors: ${errorEvents.length})`);
}

// ---------------------------------------------------------------------------
// Case 6: Eval judge (quality assessment with pass/fail scoring)
// ---------------------------------------------------------------------------

console.log("\n=== Case 6: Eval judge node (summary quality assessment) ===");
{
  const SummaryInputSchema = z.object({
    summary: z.string(),
    sourceText: z.string(),
  });

  const QualityOutputSchema = z.object({
    qualityScore: z.number(),
    passed: z.boolean(),
  });

  const transformToJudgeInput = createTransformNode({
    id: "prepare-eval-input",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: SummaryInputSchema,
    transform: (input) =>
      ok({
        summary: "Customer Alice has 2 billing conversations. Satisfied overall.",
        sourceText: input.text,
      }),
  });

  const evalJudge = createEvalJudgeNode({
    id: "summary-quality-judge",
    model: "gpt-4o",
    rubric: {
      factuality: "Does the summary accurately reflect the source material?",
      completeness: "Does it cover all key topics mentioned in conversations?",
      conciseness: "Is the summary appropriately brief without losing meaning?",
    },
    threshold: 0.7,
  });

  // For the eval judge we need a judgeLlm that returns scores
  const judgeLlm = new FakeLlmClient(() => ({
    factuality: { score: 0.9, reasoning: "Summary accurately reflects billing inquiry content" },
    completeness: { score: 0.75, reasoning: "Covers billing but misses product interest topic" },
    conciseness: { score: 0.95, reasoning: "Appropriately brief" },
  }));

  const observer = new RecordingObserver();
  const ctx = makeNodeContext({
    runId: "smoke-case-6-eval-judge",
    dagId: "eval-judge-test",
    tracer: otelTracer,
    observer,
    llm: new FakeLlmClient(() => ({})),
    judgeLlm,
  });

  // Run just the eval judge standalone via runDag with a minimal dag
  const dag = defineDag({
    id: "eval-judge-test",
    nodes: { "prepare-eval-input": transformToJudgeInput },
    edges: [],
    outputNodeId: "prepare-eval-input",
    evalJudges: [evalJudge],
  });

  const result = await runDag<{ text: string }, z.infer<typeof SummaryInputSchema>>(
    dag,
    { text: "Alice had 2 conversations: one about billing (resolved), one about premium features." },
    ctx,
  );

  if (result.ok) {
    console.log("  ✓ DAG completed");
    console.log(`  Summary: ${result.value.summary}`);
  } else {
    console.log("  ✗ Error:", JSON.stringify(result.error, null, 2).slice(0, 300));
  }
  console.log(`  Observer events: ${observer.events.length}`);
  // Eval judge results show up in observer events
  const judgeEvents = observer.events.filter((e) => e.type === "node-end");
  console.log(`  Node completions: ${judgeEvents.length}`);
}

// ---------------------------------------------------------------------------
// Flush & done
// ---------------------------------------------------------------------------

console.log("\n---");
console.log(`Flushing spans to MLflow at ${MLFLOW_URI}...`);
await tracing.flush();
await tracing.shutdown();
console.log("Done. Open MLflow UI → Traces tab to inspect:");
console.log("  1. smoke-case-1-full-dag — full production customer summary DAG");
console.log("  2. smoke-case-2-tool-calls — sequential tool calls (account + deals)");
console.log("  3. smoke-case-3-parallel-dag — parallel fan-out with guardrail");
console.log("  4. smoke-case-4-parallel-tools — parallel tool dispatch in single turn");
console.log("  5. smoke-case-5-tool-failure — tool throws, graceful degradation");
console.log("  6. smoke-case-6-eval-judge — eval judge quality scoring");
