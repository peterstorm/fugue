#!/usr/bin/env bun
/**
 * MLflow smoke test — sends a real span through the full OTel pipeline and
 * verifies it appears in the MLflow REST API.
 *
 * Usage:  bun scripts/smoke-mlflow.ts [--url http://localhost:5000]
 */
import { initTracing } from "../packages/framework/src/tracing/init.js";
import { createMlflowExporter } from "../packages/framework/src/tracing/mlflow-otlp-exporter.js";
import { alwaysOn } from "../packages/framework/src/observer/policy.js";
import {
  AI_SPAN_TYPE,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  EVENT_LLM_COST,
} from "../packages/framework/src/tracing/semantic-conventions.js";
import { trace, SpanStatusCode, type Tracer } from "@opentelemetry/api";

const MLFLOW_URL = (() => {
  const idx = process.argv.indexOf("--url");
  return idx !== -1 ? process.argv[idx + 1] : "http://localhost:5000";
})()!;

const EXPERIMENT_NAME = "fugue-smoke-test";

// ---------------------------------------------------------------------------
// MLflow REST bodies are wire data: bound as `unknown` and narrowed, never cast.
// ---------------------------------------------------------------------------
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const experimentIdOf = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.experiment_id === "string" && body.experiment_id !== ""
    ? body.experiment_id
    : undefined;

const experimentIdByName = (body: unknown): string | undefined =>
  isRecord(body) ? experimentIdOf(body.experiment) : undefined;

/** The `request_id` of every well-formed trace in a traces-search response. */
const requestIdsOf = (body: unknown): readonly string[] => {
  if (!isRecord(body) || !Array.isArray(body.traces)) return [];
  return body.traces.flatMap((t: unknown) =>
    isRecord(t) && typeof t.request_id === "string" ? [t.request_id] : [],
  );
};

// ---------------------------------------------------------------------------
// 1. Ensure experiment exists and get its ID
// ---------------------------------------------------------------------------
async function ensureExperiment(): Promise<string> {
  // Try to create it (idempotent — returns existing ID if name collides)
  const createRes = await fetch(`${MLFLOW_URL}/api/2.0/mlflow/experiments/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: EXPERIMENT_NAME }),
  });
  const body: unknown = await createRes.json();
  const created = experimentIdOf(body);
  if (created !== undefined) return created;

  // Already exists — look it up by name
  const getRes = await fetch(
    `${MLFLOW_URL}/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(EXPERIMENT_NAME)}`,
  );
  const found = experimentIdByName(await getRes.json());
  if (found !== undefined) return found;
  throw new Error(`Could not create or find experiment: ${JSON.stringify(body)}`);
}

// ---------------------------------------------------------------------------
// 2. Poll MLflow traces API until our trace appears (or timeout)
// ---------------------------------------------------------------------------
async function waitForTrace(experimentId: string, traceId: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const reportedStatuses = new Set<number>();
  while (Date.now() < deadline) {
    const res = await fetch(`${MLFLOW_URL}/api/2.0/mlflow/traces?experiment_ids=${experimentId}&max_results=20`);
    if (!res.ok) {
      // Log each distinct failure status once — a 4xx misconfiguration must
      // be distinguishable from "trace not there yet".
      if (!reportedStatuses.has(res.status)) {
        reportedStatuses.add(res.status);
        console.warn(`⚠️   Traces poll returned HTTP ${res.status} ${res.statusText} — retrying until timeout`);
      }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    const body: unknown = await res.json();
    // MLflow prefixes the OTLP traceId with "tr-" in its request_id field
    const found = requestIdsOf(body).some(
      id => id === traceId || id === `tr-${traceId}`,
    );
    if (found) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 3. Emit a root (CHAIN) span with two child spans; returns the trace id
// ---------------------------------------------------------------------------
async function emitSmokeTrace(tracer: Tracer): Promise<string | undefined> {
  let traceId: string | undefined;
  await tracer.startActiveSpan("smoke-root", async (rootSpan) => {
    rootSpan.setAttribute(AI_SPAN_TYPE, "chain");
    rootSpan.addEvent(EVENT_NODE_INPUT, { data: JSON.stringify({ query: "smoke test" }) });

    traceId = rootSpan.spanContext().traceId;
    console.log(`📤  Emitting trace ${traceId}`);

    // Child LLM span
    await tracer.startActiveSpan("smoke-llm", async (llmSpan) => {
      llmSpan.setAttribute(AI_SPAN_TYPE, "llm");
      llmSpan.setAttribute(GEN_AI_REQUEST_MODEL, "claude-sonnet-4-20250514");
      llmSpan.setAttribute(GEN_AI_SYSTEM, "anthropic");
      llmSpan.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, 42);
      llmSpan.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, 17);
      llmSpan.addEvent(EVENT_LLM_COST, { input_cost: 0.000126, output_cost: 0.000255, total_cost: 0.000381 });
      llmSpan.setStatus({ code: SpanStatusCode.OK });
      llmSpan.end();
    });

    // Child transform span
    await tracer.startActiveSpan("smoke-transform", async (txSpan) => {
      txSpan.setAttribute(AI_SPAN_TYPE, "chain");
      txSpan.addEvent(EVENT_NODE_OUTPUT, { data: JSON.stringify({ summary: "all systems go" }) });
      txSpan.setStatus({ code: SpanStatusCode.OK });
      txSpan.end();
    });

    rootSpan.addEvent(EVENT_NODE_OUTPUT, { data: JSON.stringify({ result: "smoke test passed" }) });
    rootSpan.setStatus({ code: SpanStatusCode.OK });
    rootSpan.end();
  });
  return traceId;
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`🔍  MLflow smoke test → ${MLFLOW_URL}`);

  // Health check
  const health = await fetch(`${MLFLOW_URL}/health`);
  if (!health.ok) throw new Error(`MLflow not healthy: ${health.status}`);
  console.log("✅  /health OK");

  const experimentId = await ensureExperiment();
  console.log(`✅  Experiment "${EXPERIMENT_NAME}" id=${experimentId}`);

  // Spin up tracing with the real MLflow OTLP exporter
  const exporter = createMlflowExporter({ url: MLFLOW_URL, experimentId });
  const handle = await initTracing({ exporter, policy: alwaysOn() });
  const tracer = trace.getTracer("fugue-smoke-test", "0.0.1");

  // Emit a root (CHAIN) span with two child spans
  const traceId = await emitSmokeTrace(tracer);

  // Flush and shut down so spans are exported before we poll
  await handle.flush();
  await handle.shutdown();
  console.log("✅  Spans flushed");

  if (!traceId) throw new Error("No traceId captured");

  // Poll for the trace in MLflow
  console.log(`⏳  Waiting for trace to appear in MLflow...`);
  const found = await waitForTrace(experimentId, traceId);

  if (found) {
    console.log(`✅  Trace ${traceId} confirmed in MLflow — smoke test PASSED`);
    process.exit(0);
  } else {
    console.error(`❌  Trace ${traceId} NOT found in MLflow after 15s — smoke test FAILED`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("❌  Smoke test threw:", err);
  process.exit(1);
});
