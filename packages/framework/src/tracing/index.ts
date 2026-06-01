// `tracing/` — OTel SDK setup, span helpers, semantic conventions, the
// multi-backend fan-out exporter (CompositeSpanExporter, which delivers the
// same spans to N trace backends with fault isolation), the MLflow exporter,
// and the Azure AI Foundry (Application Insights) pass-through exporter. For
// typed *domain* events (`run-start`, `node-end`, etc.)
// see `observer/`. A consumer building a custom Observer should never have
// to touch OTel SDK plumbing, and vice versa.

export { enrichLlmSpan } from "./span-enrich.js";
export type { EnrichLlmSpanOpts } from "./span-enrich.js";
export {
  // Framework-owned span attributes — consumers building custom exporters need these
  AI_NODE_ID,
  AI_NODE_KIND,
  AI_SPAN_TYPE,
  AI_DAG_ID,
  AI_RUN_ID,
  AI_LLM_COST_USD,
  AI_LLM_HAS_THINKING,
  AI_GUARDRAIL_PASSED,
  AI_NODE_SIDE_EFFECTS_KIND,
  AI_NODE_SIDE_EFFECTS_RESOURCE,
  AI_NODE_IDEMPOTENCY_KEY,
  AI_ROUTE_CONFIDENCE_BUCKET,
  AI_ROUTE_CONFIDENCE_SOURCE,
  AI_FRESHNESS_WITNESS_KIND,
  AI_FRESHNESS_WITNESS_RESOURCE,
  AI_FRESHNESS_WITNESS_VALUE,
  AI_FRESHNESS_CONDITIONED_ON_VALUE,
  AI_FRESHNESS_VIOLATION,
  AI_HUMAN_ACTION,
  AI_HUMAN_ACTOR,
  AI_HUMAN_CONFIDENCE_BUCKET,
  AI_HUMAN_CONFIDENCE_SOURCE,
  NODE_KIND_TO_SPAN_TYPE,
  // Span event names
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  EVENT_LLM_COST,
} from "./semantic-conventions.js";

// OTel pipeline setup
export type { TracingConfig, TracingHandle } from "./init.js";
export { initTracing, normalizeExporter } from "./init.js";

// Re-export the OTel `SpanExporter` contract so consumers (e.g. the app
// composition layer) can name the exporter type WITHOUT a direct
// `@opentelemetry/*` dependency — the framework owns the OTel surface.
export type { SpanExporter } from "@opentelemetry/sdk-trace-base";

// Multi-backend fan-out exporter (FR-002): deliver the same spans to N backends
export { CompositeSpanExporter } from "./composite-exporter.js";
export type { ChildFailureCount } from "./composite-exporter.js";
export { setFrameworkTracer, fwTracer } from "./global-tracer.js";

// MLflow-specific OTLP exporter
export { MlflowOtlpExporter, createMlflowExporter } from "./mlflow-otlp-exporter.js";
export type { MlflowOtlpExporterConfig } from "./mlflow-otlp-exporter.js";

// Azure AI Foundry (Application Insights) exporter — pure pass-through
export {
  AzureMonitorExporter,
  AzureMonitorExporterConfigError,
  createAzureMonitorExporter,
} from "./azure-monitor-exporter.js";
export type {
  AzureMonitorExporterConfig,
  AzureMonitorAuth,
  AzureMonitorInnerOpts,
  AzureMonitorInnerFactory,
} from "./azure-monitor-exporter.js";

// Side-channel registry for object-valued span attributes (advanced)
export { createSpanAttributeRegistry } from "./span-attribute-registry.js";
export type { SpanAttributeRegistry, SpanAttributes } from "./span-attribute-registry.js";

// Content filter / PII scrubber
export type { ContentFilter } from "./content-filter.js";
export { piiScrubber, IDENTITY_FILTER, composeFilters, resolveContentFilter } from "./content-filter.js";
