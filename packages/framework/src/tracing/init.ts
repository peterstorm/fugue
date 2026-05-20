/**
 * Initialize the OTel tracing pipeline with tail-based sampling.
 *
 * Vendor-neutral: accepts any SpanExporter. Use createMlflowExporter() for MLflow,
 * or any standard OTLPTraceExporter for Jaeger/Tempo/Honeycomb/etc.
 */
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { TailSamplingProcessor } from "../observer/tail-sampling-processor.js";
import type { PersistencePolicy } from "../observer/policy.js";

export interface TracingConfig {
  /** Any OTel-compatible span exporter */
  readonly exporter: SpanExporter;
  /** Persistence policy for tail-based sampling */
  readonly policy: PersistencePolicy;
}

export interface TracingHandle {
  /** The tail-sampling processor (for monitoring exported/dropped counts) */
  readonly processor: TailSamplingProcessor;
  /**
   * The persistence policy bound to the tail-sampler. Hosts wiring a
   * `BufferedObserver` should pass *this same instance* so events and spans
   * make a single coherent persistence decision per run. Diverging policies
   * mean a run can persist events while dropping spans (or vice versa).
   */
  readonly policy: PersistencePolicy;
  /** Flush all pending traces */
  readonly flush: () => Promise<void>;
  /** Shut down the tracing pipeline */
  readonly shutdown: () => Promise<void>;
}

export async function initTracing(config: TracingConfig): Promise<TracingHandle> {
  const tailProcessor = new TailSamplingProcessor(config.exporter, config.policy);

  const sdk = new NodeSDK({ spanProcessors: [tailProcessor] });
  sdk.start();

  return {
    processor: tailProcessor,
    policy: config.policy,
    flush: async () => tailProcessor.forceFlush(),
    shutdown: async () => sdk.shutdown(),
  };
}
