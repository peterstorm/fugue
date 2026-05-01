/**
 * Initialize the OTel + MLflow tracing pipeline with tail-based sampling.
 *
 * Flow:
 * 1. Call mlflow.init() to set globalConfig (required by MlflowSpanProcessor)
 * 2. Construct our own pipeline: MlflowSpanProcessor → TailSamplingExporter → MlflowSpanExporter
 * 3. Start a new NodeSDK that overwrites the throwaway one from init()
 *
 * After this, @mlflow/core's withSpan/startSpan and @mlflow/anthropic's tracedAnthropic
 * all route through our tail-sampling pipeline.
 */
import * as mlflow from "@mlflow/core";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { trace } from "@opentelemetry/api";
import { MlflowSpanProcessor, MlflowSpanExporter, createAuthProvider, InMemoryTraceManager } from "./mlflow-internals.js";
import { TailSamplingExporter } from "./tail-sampling-exporter.js";
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
  /** The tail-sampling exporter (for monitoring exported/dropped counts) */
  readonly exporter: TailSamplingExporter;
  /** Flush all pending traces to MLflow */
  readonly flush: () => Promise<void>;
  /** Shut down the tracing pipeline */
  readonly shutdown: () => Promise<void>;
}

export function initTracing(config: TracingConfig): TracingHandle {
  // Step 1: Call mlflow.init() to set globalConfig
  // This creates a throwaway NodeSDK that we'll overwrite
  mlflow.init({
    trackingUri: config.trackingUri,
    experimentId: config.experimentId,
    trackingServerUsername: config.username,
    trackingServerPassword: config.password,
    trackingServerToken: config.token,
  });

  // Step 2: Build our custom pipeline
  const authProvider = createAuthProvider({
    trackingUri: config.trackingUri,
    trackingServerUsername: config.username,
    trackingServerPassword: config.password,
    trackingServerToken: config.token,
  });

  const client = new mlflow.MlflowClient({
    trackingUri: config.trackingUri,
    authProvider,
  });

  const realExporter = new MlflowSpanExporter(client);
  const tailExporter = new TailSamplingExporter(realExporter, config.policy, InMemoryTraceManager.getInstance());
  const processor = new MlflowSpanProcessor(tailExporter);

  // Step 3: Replace the global TracerProvider registered by mlflow.init() with ours.
  // OTel's setGlobalTracerProvider is a no-op if already set, so we must:
  //   a) Shut down the existing delegate provider from mlflow.init()
  //   b) Call trace.disable() to clear the global registration
  //   c) Start our SDK which re-registers with the tail-sampling pipeline
  const proxy = trace.getTracerProvider() as any;
  const existingDelegate = proxy.getDelegate?.();
  if (existingDelegate?.shutdown) {
    existingDelegate.shutdown().catch((e: unknown) => {
      console.warn(`[initTracing] Previous tracer delegate shutdown failed: ${e instanceof Error ? e.message : e}`);
    });
  }
  trace.disable();

  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();

  return {
    exporter: tailExporter,
    flush: async () => processor.forceFlush(),
    shutdown: async () => sdk.shutdown(),
  };
}
