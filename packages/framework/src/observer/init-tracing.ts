/**
 * Initialize the OTel + MLflow tracing pipeline with tail-based sampling via OTLP.
 *
 * Architecture:
 * 1. Call mlflow.init() to configure experiment + enable mlflow.withSpan() API
 * 2. Keep MlflowSpanProcessor for InMemoryTraceManager (enables getCurrentActiveSpan, setInputs, etc.)
 *    but with a NoOp exporter (we don't use MlflowSpanExporter's artifact upload path)
 * 3. Add TailSamplingProcessor → MlflowOtlpExporter as a SECOND processor
 *    This exports ALL spans via OTLP to /v1/traces, which populates span_metrics for cost breakdown
 *
 * After this, mlflow.withSpan() creates OTel spans that flow through both processors:
 * - MlflowSpanProcessor: maintains InMemoryTraceManager for MLflow span API (setInputs, etc.)
 * - TailSamplingProcessor: buffers spans, applies policy, exports via OTLP on root span end
 */
import * as mlflow from "@mlflow/core";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { trace } from "@opentelemetry/api";
import { MlflowSpanProcessor } from "./mlflow-internals.js";
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

/** No-op exporter used for MlflowSpanProcessor (we don't want it to export). */
const noopExporter = {
  export(_spans: unknown[], cb: (r: { code: number }) => void) { cb({ code: 0 }); },
  shutdown() { return Promise.resolve(); },
};

export async function initTracing(config: TracingConfig): Promise<TracingHandle> {
  // Step 1: Call mlflow.init() to configure globalConfig (experimentId, auth, etc.)
  // This also starts an internal SDK with MlflowSpanExporter — we immediately shut it down.
  mlflow.init({
    trackingUri: config.trackingUri,
    experimentId: config.experimentId,
    trackingServerUsername: config.username,
    trackingServerPassword: config.password,
    trackingServerToken: config.token,
  });

  // Step 2: Immediately shut down mlflow.init()'s internal SDK to prevent
  // MlflowSpanExporter from firing (we use OTLP instead).
  const proxy = trace.getTracerProvider() as any;
  const existingDelegate = proxy.getDelegate?.();
  if (existingDelegate?.shutdown) {
    try {
      await existingDelegate.shutdown();
    } catch (e: unknown) {
      console.warn(`[initTracing] Previous tracer delegate shutdown failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  trace.disable();

  // Step 3: Build our processors
  // Processor 1: MlflowSpanProcessor with NoOp exporter — maintains InMemoryTraceManager
  // so that getCurrentActiveSpan(), setInputs(), setAttribute() work on MLflow spans
  const mlflowProcessor = new MlflowSpanProcessor(noopExporter as any);

  // Processor 2: TailSamplingProcessor → MlflowOtlpExporter
  // Buffers all spans, applies policy on root span end, exports full trace via OTLP
  const otlpExporter = new MlflowOtlpExporter({
    url: config.trackingUri,
    experimentId: config.experimentId,
  });
  const tailProcessor = new TailSamplingProcessor(otlpExporter, config.policy);

  const sdk = new NodeSDK({ spanProcessors: [mlflowProcessor, tailProcessor] });
  sdk.start();

  return {
    processor: tailProcessor,
    flush: async () => tailProcessor.forceFlush(),
    shutdown: async () => sdk.shutdown(),
  };
}
