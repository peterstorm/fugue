/**
 * Tail-sampling span processor for MLflow OTLP export.
 *
 * Buffers all spans per-trace in memory. When the root span ends (no parent),
 * evaluates the PersistencePolicy to decide whether to export the entire trace
 * or discard it.
 *
 * This replaces the previous TailSamplingExporter which only received root spans.
 * With OTLP export, we need ALL spans to be forwarded (the server reconstructs
 * the trace tree from parent_span_id).
 *
 * Implements SpanProcessor (not SpanExporter) so it integrates directly into
 * the OTel pipeline without needing a separate BatchSpanProcessor.
 */
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PersistencePolicy } from "./policy.js";
import type { RunSummary } from "./buffered.js";
import { SpanAttributeRegistry } from "./span-attribute-registry.js";

/**
 * Per-trace buffer holding spans until the root arrives.
 */
interface TraceBuffer {
  spans: ReadableSpan[];
  /** Track span IDs for cleanup on discard */
  spanIds: string[];
}

export class TailSamplingProcessor implements SpanProcessor {
  private readonly exporter: SpanExporter;
  private readonly policy: PersistencePolicy;
  private readonly buffers = new Map<string, TraceBuffer>();

  /** Counters for monitoring */
  exported = 0;
  dropped = 0;

  constructor(exporter: SpanExporter, policy: PersistencePolicy) {
    this.exporter = exporter;
    this.policy = policy;
  }

  onStart(_span: Span, _parentContext: Context): void {
    // No-op: we buffer on end, not start
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const spanId = span.spanContext().spanId;

    // Get or create buffer for this trace
    let buffer = this.buffers.get(traceId);
    if (!buffer) {
      buffer = { spans: [], spanIds: [] };
      this.buffers.set(traceId, buffer);
    }
    buffer.spans.push(span);
    buffer.spanIds.push(spanId);

    // If this is a root span (no parent), the trace is complete — decide now
    const parentId = (span as any).parentSpanId ?? span.parentSpanContext?.spanId ?? null;
    if (!parentId) {
      this.buffers.delete(traceId);
      this.processCompleteTrace(span, buffer);
    }
  }

  private processCompleteTrace(rootSpan: ReadableSpan, buffer: TraceBuffer): void {
    const summary = this.extractRunSummary(rootSpan, buffer);
    const shouldFlush = this.policy.shouldFlush(summary);

    if (shouldFlush) {
      this.exported++;
      this.exporter.export(buffer.spans, (result) => {
        if (result.code !== 0) {
          console.error("[TailSamplingProcessor] Export failed for trace", rootSpan.spanContext().traceId);
        }
      });
    } else {
      this.dropped++;
      // Clean up registry entries for discarded spans
      SpanAttributeRegistry.deleteAll(buffer.spanIds);
    }
  }

  private extractRunSummary(rootSpan: ReadableSpan, buffer: TraceBuffer): RunSummary {
    const traceId = rootSpan.spanContext().traceId;
    const isError = rootSpan.status.code === 2; // OTel ERROR

    // Count retries: duplicate span names
    const nameCount = new Map<string, number>();
    let totalCostUsd = 0;
    for (const span of buffer.spans) {
      nameCount.set(span.name, (nameCount.get(span.name) ?? 0) + 1);
      // Read cost from registry (since it's not on the OTel span attributes)
      const extra = SpanAttributeRegistry.get(span.spanContext().spanId);
      if (extra?.["mlflow.llm.cost"] && typeof extra["mlflow.llm.cost"] === "object") {
        const cost = extra["mlflow.llm.cost"] as Record<string, number>;
        totalCostUsd += cost.total_cost ?? 0;
      }
    }
    const retryCount = [...nameCount.values()].filter((c) => c > 1).length;

    // Duration from root span
    const startMs = rootSpan.startTime[0] * 1000 + rootSpan.startTime[1] / 1e6;
    const endMs = rootSpan.endTime[0] * 1000 + rootSpan.endTime[1] / 1e6;

    return {
      runId: `tr-${traceId}`,
      status: isError ? "error" : "ok",
      totalDuration: endMs - startMs,
      nodeCount: buffer.spans.length,
      retryCount,
      cacheHitCount: 0,
      totalCostUsd,
    };
  }

  async forceFlush(): Promise<void> {
    // Flush any buffered traces (force export regardless of policy)
    for (const [traceId, buffer] of this.buffers) {
      const rootSpan = buffer.spans.find((s) => !s.parentSpanContext?.spanId);
      if (rootSpan) {
        this.exporter.export(buffer.spans, () => {});
      }
    }
    this.buffers.clear();
    await this.exporter.forceFlush?.();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    await this.exporter.shutdown?.();
  }
}
