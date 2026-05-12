// `tracing/` — OTel SDK setup, span helpers, semantic conventions, and the
// MLflow exporter. For typed *domain* events (`run-start`, `node-end`, etc.)
// see `observer/`. A consumer building a custom Observer should never have
// to touch OTel SDK plumbing, and vice versa.

export { enrichLlmSpan } from "./span-enrich.js";
export type { EnrichLlmSpanOpts } from "./span-enrich.js";
export * from "./semantic-conventions.js";

// OTel pipeline setup
export type { TracingConfig, TracingHandle } from "./init.js";
export { initTracing } from "./init.js";
export { setFrameworkTracer, fwTracer } from "./global-tracer.js";

// MLflow-specific OTLP exporter
export { MlflowOtlpExporter, createMlflowExporter } from "./mlflow-otlp-exporter.js";
export type { MlflowOtlpExporterConfig } from "./mlflow-otlp-exporter.js";

// Side-channel registry for object-valued span attributes (advanced)
export { createSpanAttributeRegistry } from "./span-attribute-registry.js";
export type { SpanAttributeRegistry, SpanAttributes } from "./span-attribute-registry.js";
