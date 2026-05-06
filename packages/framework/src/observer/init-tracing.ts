/**
 * Initialize the OTel tracing pipeline with tail-based sampling via OTLP.
 *
 * Architecture:
 * 1. TailSamplingProcessor → MlflowOtlpExporter
 *    Buffers spans per-trace, applies policy on root span end, exports via OTLP
 *
 * No @mlflow/core dependency — uses pure OTel APIs. Span attributes like
 * mlflow.spanInputs/Outputs are handled via SpanAttributeRegistry + MlflowOtlpExporter.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { TailSamplingProcessor } from "./tail-sampling-processor.js";
import { MlflowOtlpExporter } from "./mlflow-otlp-exporter.js";
import type { PersistencePolicy } from "./policy.js";

export interface TracingConfig {
  /** MLflow tracking server URI (e.g. "http://localhost:5000") */
  readonly trackingUri: string;
  /** MLflow experiment ID */
  readonly experimentId: string;
  /** Persistence policy for tail-based sampling */
  readonly policy: PersistencePolicy;
  /** Optional: basic auth username */
  readonly username?: string;
  /** Optional: basic auth password */
  readonly password?: string;
  /** Optional: bearer token */
  readonly token?: string;
}

export interface TracingHandle {
  /** The tail-sampling processor (for monitoring exported/dropped counts) */
  readonly processor: TailSamplingProcessor;
  /** Flush all pending traces to MLflow */
  readonly flush: () => Promise<void>;
  /** Shut down the tracing pipeline */
  readonly shutdown: () => Promise<void>;
}

export async function initTracing(config: TracingConfig): Promise<TracingHandle> {
  const otlpExporter = new MlflowOtlpExporter({
    url: config.trackingUri,
    experimentId: config.experimentId,
  });
  const tailProcessor = new TailSamplingProcessor(otlpExporter, config.policy);

  const sdk = new NodeSDK({ spanProcessors: [tailProcessor] });
  sdk.start();

  return {
    processor: tailProcessor,
    flush: async () => tailProcessor.forceFlush(),
    shutdown: async () => sdk.shutdown(),
  };
}
