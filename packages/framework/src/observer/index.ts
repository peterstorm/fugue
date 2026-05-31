// `observer/` — typed *domain event* bus for the framework runtime.
// OTel SDK initialization, the MLflow exporter, and the span-attribute
// side-channel registry live in `tracing/`. For OTel pipeline setup see
// `tracing/init.ts`; for span helpers see `tracing/span-enrich.ts`. The
// barrel below covers only the domain observer surface.

export type { Observer } from "./observer.js";
export { NoopObserver, RecordingObserver, createObserver, createExhaustiveObserver } from "./observer.js";
export type { RunSummary, AggregateCounters } from "./buffered.js";
export { BufferedObserver, computeRunSummary } from "./buffered.js";
export { dispatchEvent } from "./dispatch.js";
export type { PersistencePolicy } from "./policy.js";
export {
  alwaysOn,
  errorOnly,
  ratio,
  hadRetry,
  anyOf,
  allOf,
  custom,
} from "./policy.js";
export { TailSamplingProcessor } from "./tail-sampling-processor.js";

// AI Foundry domain-event recording (FR-018/019/020). Pure mapping +
// vendor-neutral observer over a FoundryTelemetrySink port. The
// applicationinsights-backed sink is composed at the app layer (T5).
export type { FoundryTelemetrySink } from "./ai-foundry-observer.js";
export { AiFoundryObserver } from "./ai-foundry-observer.js";
export type { FoundryEmission, RunSummaryExtras } from "./foundry-event-mapping.js";
export {
  mapEventToFoundry,
  mapRunSummaryToFoundry,
  FOUNDRY_EVENT_RUN_SUMMARY,
  FOUNDRY_EVENT_ROUTE_DECISION,
  FOUNDRY_EVENT_NODE_PRUNED,
  FOUNDRY_METRIC_RUN_LATENCY,
  FOUNDRY_METRIC_RUN_COST,
  FOUNDRY_METRIC_RUN_TOKENS,
  FOUNDRY_METRIC_NODE_LATENCY,
  FOUNDRY_METRIC_NODE_CACHE_HIT,
} from "./foundry-event-mapping.js";
