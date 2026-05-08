/**
 * Initialize the OTel tracing pipeline with tail-based sampling.
 *
 * Vendor-neutral: accepts any SpanExporter. Use createMlflowExporter() for MLflow,
 * or any standard OTLPTraceExporter for Jaeger/Tempo/Honeycomb/etc.
 */
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { TailSamplingProcessor } from "./tail-sampling-processor.js";
import type { PersistencePolicy } from "./policy.js";

export interface TracingConfig {
  /** Any OTel-compatible span exporter */
  readonly exporter: SpanExporter;
  /** Persistence policy for tail-based sampling */
  readonly policy: PersistencePolicy;
}

/** @deprecated Use TracingConfig with exporter param instead */
export interface LegacyTracingConfig {
  /** MLflow tracking server URI (e.g. "http://localhost:5000") */
  readonly trackingUri: string;
  /** MLflow experiment ID */
  readonly experimentId: string;
  /** Persistence policy for tail-based sampling */
  readonly policy: PersistencePolicy;
}

export interface TracingHandle {
  /** The tail-sampling processor (for monitoring exported/dropped counts) */
  readonly processor: TailSamplingProcessor;
  /** Flush all pending traces */
  readonly flush: () => Promise<void>;
  /** Shut down the tracing pipeline */
  readonly shutdown: () => Promise<void>;
}

export async function initTracing(config: TracingConfig | LegacyTracingConfig): Promise<TracingHandle> {
  let exporter: SpanExporter;

  if ("exporter" in config) {
    // New generic path
    exporter = config.exporter;
  } else {
    // Legacy path — import MLflow exporter for backwards compatibility
    const { createMlflowExporter } = await import("./mlflow-otlp-exporter.js");
    exporter = createMlflowExporter({
      url: config.trackingUri,
      experimentId: config.experimentId,
    });
  }

  const tailProcessor = new TailSamplingProcessor(exporter, config.policy);

  const sdk = new NodeSDK({ spanProcessors: [tailProcessor] });
  sdk.start();

  return {
    processor: tailProcessor,
    flush: async () => tailProcessor.forceFlush(),
    shutdown: async () => sdk.shutdown(),
  };
}
