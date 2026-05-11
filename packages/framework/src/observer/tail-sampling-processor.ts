/**
 * Tail-sampling span processor for OTLP export.
 *
 * Buffers all spans per-trace in memory. When the root span ends (no parent),
 * evaluates the PersistencePolicy to decide whether to export the entire trace
 * or discard it.
 *
 * Vendor-neutral: reads ai.* attributes from spans, no MLflow dependency.
 *
 * Implements SpanProcessor (not SpanExporter) so it integrates directly into
 * the OTel pipeline without needing a separate BatchSpanProcessor.
 */
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PersistencePolicy } from "./policy.js";
import type { RunSummary } from "./buffered.js";
import { AI_LLM_COST_USD, AI_RUN_ID } from "../tracing/semantic-conventions.js";

/** Maximum age (ms) for a trace buffer before it's evicted as orphaned. */
const BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Minimum interval between TTL/size eviction sweeps (kept off the onEnd hot path). */
const EVICTION_SWEEP_INTERVAL_MS = 30_000;
/** Maximum number of buffered traces before forced eviction of oldest. */
const MAX_BUFFERED_TRACES = 1000;

/**
 * Per-trace buffer holding spans until the root arrives.
 */
interface TraceBuffer {
  spans: ReadableSpan[];
  /** Timestamp when the buffer was created (for TTL eviction) */
  createdAt: number;
}

const exportAsync = (
  exporter: SpanExporter,
  spans: ReadableSpan[],
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    exporter.export(spans, (result) => {
      if (result.code === 0) resolve();
      else reject(result.error ?? new Error("export failed"));
    });
  });

export class TailSamplingProcessor implements SpanProcessor {
  private readonly exporter: SpanExporter;
  private readonly policy: PersistencePolicy;
  private readonly buffers = new Map<string, TraceBuffer>();
  /** Track in-flight exports so forceFlush/shutdown can await them. */
  private readonly pendingExports = new Set<Promise<void>>();
  private lastEvictedAt = 0;

  /** Counters for monitoring */
  exported = 0;
  dropped = 0;
  evicted = 0;
  /**
   * Count exports whose transport rejected (HTTP 4xx/5xx, TLS errors,
   * connection refused, etc). Operators alert on this counter — without it,
   * the rejection used to be swallowed in trackExport's `.catch` and
   * `forceFlush` would resolve as if every export had succeeded.
   */
  exportFailed = 0;

  constructor(exporter: SpanExporter, policy: PersistencePolicy) {
    this.exporter = exporter;
    this.policy = policy;
  }

  onStart(_span: Span, _parentContext: Context): void {
    // No-op: we buffer on end, not start
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;

    // Get or create buffer for this trace
    let buffer = this.buffers.get(traceId);
    if (!buffer) {
      buffer = { spans: [], createdAt: Date.now() };
      this.buffers.set(traceId, buffer);
    }
    buffer.spans.push(span);

    // If this is a root span (no parent), the trace is complete — decide now.
    if (!span.parentSpanContext?.spanId) {
      this.buffers.delete(traceId);
      this.processCompleteTrace(span, buffer);
    }

    // Throttled periodic eviction of orphaned buffers — keep onEnd O(1).
    const now = Date.now();
    if (now - this.lastEvictedAt > EVICTION_SWEEP_INTERVAL_MS) {
      this.lastEvictedAt = now;
      this.evictStaleBuffers();
    }
  }

  private evictStaleBuffers(): void {
    const now = Date.now();

    // TTL-based eviction
    for (const [traceId, buffer] of this.buffers) {
      if (now - buffer.createdAt > BUFFER_TTL_MS) {
        console.warn(`[TailSamplingProcessor] Evicting orphaned trace buffer ${traceId} (age: ${now - buffer.createdAt}ms, spans: ${buffer.spans.length})`);
        this.buffers.delete(traceId);
        this.evicted++;
      }
    }

    // Size-based eviction (oldest first) if over max
    if (this.buffers.size > MAX_BUFFERED_TRACES) {
      const entries = [...this.buffers.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toEvict = entries.slice(0, this.buffers.size - MAX_BUFFERED_TRACES);
      for (const [traceId] of toEvict) {
        console.warn(`[TailSamplingProcessor] Evicting trace buffer ${traceId} (max size exceeded)`);
        this.buffers.delete(traceId);
        this.evicted++;
      }
    }
  }

  private trackExport(spans: ReadableSpan[], traceId: string): void {
    // Track the original (rejectable) promise so forceFlush can observe
    // failures via allSettled — eagerly absorbing rejections into
    // resolved-`undefined` would hide transport failures from the SDK
    // shutdown sequence.
    const p = exportAsync(this.exporter, spans);
    p.catch((err) => {
      this.exportFailed++;
      console.error(`[TailSamplingProcessor] Export failed for trace ${traceId}:`, err);
    });
    this.pendingExports.add(p);
    p.finally(() => this.pendingExports.delete(p));
  }

  private processCompleteTrace(rootSpan: ReadableSpan, buffer: TraceBuffer): void {
    const summary = this.extractRunSummary(rootSpan, buffer);
    const shouldFlush = this.policy.shouldFlush(summary);

    if (shouldFlush) {
      this.exported++;
      this.trackExport(buffer.spans, rootSpan.spanContext().traceId);
    } else {
      this.dropped++;
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
      // Read cost from standard flat attribute
      const cost = span.attributes[AI_LLM_COST_USD];
      if (typeof cost === "number") {
        totalCostUsd += cost;
      }
    }
    const retryCount = [...nameCount.values()].filter((c) => c > 1).length;

    // Duration from root span
    const startMs = rootSpan.startTime[0] * 1000 + rootSpan.startTime[1] / 1e6;
    const endMs = rootSpan.endTime[0] * 1000 + rootSpan.endTime[1] / 1e6;

    // Prefer the application-level run id set on the root span; fall back to
    // the trace id only when the producer didn't tag it (legacy / external traces).
    const runIdAttr = rootSpan.attributes[AI_RUN_ID];
    const runId = typeof runIdAttr === "string" && runIdAttr.length > 0
      ? runIdAttr
      : `tr-${traceId}`;

    return {
      runId,
      status: isError ? "error" : "ok",
      totalDuration: endMs - startMs,
      nodeCount: buffer.spans.length,
      retryCount,
      cacheHitCount: 0,
      totalCostUsd,
    };
  }

  async forceFlush(): Promise<void> {
    // Flush all buffered traces — export regardless of policy (shutdown/flush scenario)
    for (const [traceId, buffer] of this.buffers) {
      if (buffer.spans.length > 0) {
        this.trackExport(buffer.spans, traceId);
      }
    }
    this.buffers.clear();
    // Wait for every export started so far to settle (resolve OR reject)
    // before flushing the inner. Individual failures are already counted in
    // `exportFailed` and logged by trackExport; allSettled ensures we never
    // miss waiting for an export just because it rejected.
    await Promise.allSettled([...this.pendingExports]);
    // Wrap the inner exporter's forceFlush so a rejection cannot escape into
    // the OTel SDK shutdown path. An unhandled rejection here makes a clean
    // application stop look like a crash to process supervisors.
    if (this.exporter.forceFlush) {
      try {
        await this.exporter.forceFlush();
      } catch (err) {
        this.exportFailed++;
        console.error("[TailSamplingProcessor] exporter.forceFlush rejected during flush:", err);
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    await this.exporter.shutdown?.();
  }
}
