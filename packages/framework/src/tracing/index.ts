// `tracing/` — OTel SDK setup, span helpers, semantic conventions, and the
// MLflow exporter. For typed *domain* events (`run-start`, `node-end`, etc.)
// see `observer/`. Wave 5 §5.4 split these namespaces: a consumer building a
// custom Observer should never have to touch OTel SDK plumbing, and vice
// versa.

export { enrichLlmSpan } from "./span-enrich.js";
export type { EnrichLlmSpanOpts } from "./span-enrich.js";
export * from "./semantic-conventions.js";

// OTel pipeline setup (Wave 5 §5.4, moved from observer/)
export type { TracingConfig, TracingHandle } from "./init.js";
export { initTracing } from "./init.js";

// MLflow-specific OTLP exporter (Wave 5 §5.4, moved from observer/)
export { MlflowOtlpExporter, createMlflowExporter } from "./mlflow-otlp-exporter.js";
export type { MlflowOtlpExporterConfig } from "./mlflow-otlp-exporter.js";
