/**
 * Tail-sampling exporter for MLflow traces.
 *
 * Wraps the real MlflowSpanExporter and intercepts the export() call.
 * Uses a PersistencePolicy to decide whether to forward the trace to MLflow
 * or discard it. On discard, cleans up InMemoryTraceManager to prevent leaks.
 *
 * This enables tail-based sampling: prompts, thinking blocks, and full span
 * data are buffered in-memory during the trace, and only sent to MLflow if
 * the trace meets the persistence criteria (e.g. error, retry, cold cache).
 */
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
// Deep imports from @mlflow/core — pinned at 0.2.0
// @ts-ignore — no public export, using internal path
import { InMemoryTraceManager } from "@mlflow/core/dist/core/trace_manager";
import type { PersistencePolicy } from "./policy.js";

/** Minimal summary extracted from a completed trace for the persistence policy. */
export interface TraceSummary {
  readonly traceId: string;
  readonly status: "ok" | "error";
  readonly totalDuration: number;
  readonly spanCount: number;
  readonly hasRetry: boolean;
  readonly totalCostUsd: number;
}

/**
 * Extract a TraceSummary from the root span and the InMemoryTraceManager.
 * Called before the trace is potentially discarded.
 */
function extractTraceSummary(rootSpan: ReadableSpan): TraceSummary {
  const traceManager = InMemoryTraceManager.getInstance();
  const otelTraceId = rootSpan.spanContext().traceId;
  const mlflowTraceId = traceManager.getMlflowTraceIdFromOtelId(otelTraceId);
  const trace = mlflowTraceId ? traceManager.getTrace(mlflowTraceId) : null;

  const spanCount = trace?.spanDict?.size ?? 1;

  // Check status from OTel span status code (2 = ERROR in OTel)
  const isError = rootSpan.status.code === 2;

  // Check for retries: look for duplicate span names (same node ran twice)
  let hasRetry = false;
  let totalCostUsd = 0;
  if (trace) {
    const nameCount = new Map<string, number>();
    for (const span of trace.spanDict.values()) {
      const name = span.name;
      nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
      // Extract cost from span attributes if present
      const cost = span.getAttribute("cost_usd");
      if (typeof cost === "number") totalCostUsd += cost;
    }
    hasRetry = [...nameCount.values()].some((c) => c > 1);
  }

  // Duration from root span
  const startMs = rootSpan.startTime[0] * 1000 + rootSpan.startTime[1] / 1e6;
  const endMs = rootSpan.endTime[0] * 1000 + rootSpan.endTime[1] / 1e6;
  const totalDuration = endMs - startMs;

  return {
    traceId: mlflowTraceId ?? otelTraceId,
    status: isError ? "error" : "ok",
    totalDuration,
    spanCount,
    hasRetry,
    totalCostUsd,
  };
}

/**
 * Adapter: converts TraceSummary to the RunSummary shape that PersistencePolicy expects.
 */
function toRunSummary(ts: TraceSummary): {
  runId: string;
  status: "ok" | "error";
  totalDuration: number;
  nodeCount: number;
  retryCount: number;
  cacheHitCount: number;
  totalCostUsd: number;
} {
  return {
    runId: ts.traceId,
    status: ts.status,
    totalDuration: ts.totalDuration,
    nodeCount: ts.spanCount,
    retryCount: ts.hasRetry ? 1 : 0,
    cacheHitCount: 0,
    totalCostUsd: ts.totalCostUsd,
  };
}

export class TailSamplingExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  private readonly policy: PersistencePolicy;

  /** Counters for monitoring */
  exported = 0;
  dropped = 0;

  constructor(inner: SpanExporter, policy: PersistencePolicy) {
    this.inner = inner;
    this.policy = policy;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const toForward: ReadableSpan[] = [];

    for (const span of spans) {
      // MlflowSpanProcessor only calls export for root spans,
      // but guard just in case
      if (span.parentSpanContext?.spanId) {
        continue;
      }

      const summary = extractTraceSummary(span);
      const shouldFlush = this.policy.shouldFlush(toRunSummary(summary));

      if (shouldFlush) {
        toForward.push(span);
        this.exported++;
      } else {
        // Discard — but MUST clean up InMemoryTraceManager to prevent memory leak
        const traceManager = InMemoryTraceManager.getInstance();
        traceManager.popTrace(span.spanContext().traceId);
        this.dropped++;
      }
    }

    // SpanExporter contract: resultCallback must be invoked exactly once per export() call.
    if (toForward.length > 0) {
      try {
        this.inner.export(toForward, resultCallback);
      } catch {
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
