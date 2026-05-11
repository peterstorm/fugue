// `observer/` — typed *domain event* bus for the framework runtime.
// Wave 5 §5.4: OTel SDK initialization, the MLflow exporter, and the
// span-attribute side-channel registry have moved to `tracing/`. For
// OTel pipeline setup see `tracing/init.ts`; for span helpers see
// `tracing/span-enrich.ts`. The barrel below covers only the domain
// observer surface.

export type { Observer } from "./observer.js";
export { NoopObserver, RecordingObserver } from "./observer.js";
export type { RunSummary, AggregateCounters } from "./buffered.js";
export { BufferedObserver, computeRunSummary, dispatchEvent } from "./buffered.js";
export type { PersistencePolicy } from "./policy.js";
export {
  alwaysOn,
  errorOnly,
  ratio,
  hadRetry,
  coldCache,
  anyOf,
  allOf,
  custom,
} from "./policy.js";
export { TailSamplingProcessor } from "./tail-sampling-processor.js";
