/**
 * Tail-sampling exporter for MLflow traces.
 *
 * Wraps the real MlflowSpanExporter and intercepts the export() call.
 * Uses a PersistencePolicy to decide whether to forward the trace to MLflow
 * or discard it. On discard, cleans up the trace manager to prevent leaks.
 *
 * The TraceManager dependency is injected (not a singleton) for testability.
 *
 * This enables tail-based sampling: prompts, thinking blocks, and full span
 * data are buffered in-memory during the trace, and only sent to MLflow if
 * the trace meets the persistence criteria (e.g. error, retry, cold cache).
 */
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PersistencePolicy } from "./policy.js";
import type { RunSummary } from "./buffered.js";

/**
 * Interface for the subset of InMemoryTraceManager we need.
 * Decouples from the singleton so tests can provide a stub.
 */
export interface TraceManager {
  getMlflowTraceIdFromOtelId(otelTraceId: string): string | null;
  getTrace(traceId: string): { spanDict: Map<string, { name: string; getAttribute(key: string): unknown }> } | null;
  popTrace(otelTraceId: string): unknown;
}

/**
 * Extract a RunSummary from the root span and the trace manager.
 * Uses the shared RunSummary type from buffered.ts — no separate TraceSummary needed.
 */
export function extractRunSummary(rootSpan: ReadableSpan, traceManager: TraceManager): RunSummary {
  const otelTraceId = rootSpan.spanContext().traceId;
  const mlflowTraceId = traceManager.getMlflowTraceIdFromOtelId(otelTraceId);
  const trace = mlflowTraceId ? traceManager.getTrace(mlflowTraceId) : null;

  const spanCount = trace?.spanDict?.size ?? 1;

  // Check status from OTel span status code (2 = ERROR in OTel)
  const isError = rootSpan.status.code === 2;

  // Check for retries: look for duplicate span names (same node ran twice)
  let retryCount = 0;
  let totalCostUsd = 0;
  if (trace) {
    const nameCount = new Map<string, number>();
    for (const span of trace.spanDict.values()) {
      nameCount.set(span.name, (nameCount.get(span.name) ?? 0) + 1);
      const cost = span.getAttribute("cost_usd");
      if (typeof cost === "number") totalCostUsd += cost;
    }
    retryCount = [...nameCount.values()].filter((c) => c > 1).length;
  }

  // Duration from root span
  const startMs = rootSpan.startTime[0] * 1000 + rootSpan.startTime[1] / 1e6;
  const endMs = rootSpan.endTime[0] * 1000 + rootSpan.endTime[1] / 1e6;

  return {
    runId: mlflowTraceId ?? otelTraceId,
    status: isError ? "error" : "ok",
    totalDuration: endMs - startMs,
    nodeCount: spanCount,
    retryCount,
    cacheHitCount: 0,
    totalCostUsd,
  };
}

export class TailSamplingExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  private readonly policy: PersistencePolicy;
  private readonly traceManager: TraceManager;

  /** Counters for monitoring */
  exported = 0;
  dropped = 0;

  constructor(inner: SpanExporter, policy: PersistencePolicy, traceManager: TraceManager) {
    this.inner = inner;
    this.policy = policy;
    this.traceManager = traceManager;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const toForward: ReadableSpan[] = [];

    for (const span of spans) {
      // MlflowSpanProcessor only calls export for root spans,
      // but guard just in case
      if (span.parentSpanContext?.spanId) {
        continue;
      }

      const summary = extractRunSummary(span, this.traceManager);
      const shouldFlush = this.policy.shouldFlush(summary);

      if (shouldFlush) {
        toForward.push(span);
        this.exported++;
      } else {
        // Discard — but MUST clean up trace manager to prevent memory leak
        this.traceManager.popTrace(span.spanContext().traceId);
        this.dropped++;
      }
    }

    // SpanExporter contract: resultCallback must be invoked exactly once per export() call.
    if (toForward.length > 0) {
      try {
        this.inner.export(toForward, resultCallback);
      } catch (e) {
        console.error(`[TailSamplingExporter] inner export failed: ${e instanceof Error ? e.message : e}`);
        resultCallback({ code: 1 });
      }
    } else {
      resultCallback({ code: 0 });
    }
  }

  async shutdown(): Promise<void> {
    return this.inner.shutdown?.();
  }

  async forceFlush(): Promise<void> {
    return (this.inner as any).forceFlush?.();
  }
}
