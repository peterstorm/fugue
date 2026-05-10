/**
 * MLflow-specific OTLP exporter.
 *
 * This is the ONLY file that knows about MLflow's attribute schema.
 * It transforms vendor-neutral OTel spans (using ai.* attributes and events)
 * into MLflow's expected format before forwarding to the OTLP endpoint.
 *
 * Transformations:
 * - ai.span.type → mlflow.spanType (uppercased)
 * - ai.node.input event → mlflow.spanInputs (object attribute)
 * - ai.node.output event → mlflow.spanOutputs (object attribute)
 * - ai.llm.request event → merged into mlflow.spanInputs
 * - ai.llm.cost event → mlflow.llm.cost (object attribute)
 * - ai.llm.thinking event → merged into span attributes
 * - ai.llm.model → mlflow.llm.model
 * - ai.llm.tokens_in/out (legacy) or gen_ai.usage.* (preferred) → mlflow.chat.tokenUsage
 *
 * The OTel SDK drops object-valued attributes, so the derived MLflow attributes
 * are stored in `SpanAttributeRegistry` (keyed by spanId) rather than mutated
 * onto the original `ReadableSpan.attributes`. At export time the spans are
 * wrapped in a Proxy that merges the registry entries with the original
 * attributes — the original span object stays untouched, so any other
 * downstream consumer sees pristine data.
 *
 * The otlp-transformer serializes object-valued attributes as protobuf
 * kvlist_value, which MLflow's server decodes correctly.
 */
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import {
  AI_SPAN_TYPE,
  AI_LLM_MODEL,
  AI_LLM_PROVIDER,
  AI_LLM_TOKENS_IN,
  AI_LLM_TOKENS_OUT,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  EVENT_LLM_REQUEST,
  EVENT_LLM_COST,
  EVENT_LLM_THINKING,
} from "../tracing/semantic-conventions.js";
import { SpanAttributeRegistry, type SpanAttributes } from "./span-attribute-registry.js";

export interface MlflowOtlpExporterConfig {
  /** MLflow tracking server URL (e.g. "http://localhost:5000") */
  readonly url: string;
  /** MLflow experiment ID (sent as x-mlflow-experiment-id header) */
  readonly experimentId: string;
  /**
   * Test seam: override the inner OTLP exporter factory. When omitted, the
   * exporter lazily imports `@opentelemetry/exporter-trace-otlp-proto`.
   */
  readonly createInner?: () => Promise<SpanExporter>;
}

/** Map from our span type values to MLflow's uppercase constants */
const SPAN_TYPE_TO_MLFLOW: Record<string, string> = {
  chain: "CHAIN",
  llm: "LLM",
  retriever: "RETRIEVER",
  tool: "TOOL",
};

/** Wrap a span so that `attributes` reads merge an extra object on top. */
const withMergedAttrs = (span: ReadableSpan, extra: SpanAttributes): ReadableSpan =>
  new Proxy(span, {
    get(target, prop, receiver) {
      if (prop === "attributes") {
        return { ...(target.attributes as Record<string, unknown>), ...extra };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

export class MlflowOtlpExporter implements SpanExporter {
  private innerPromise: Promise<SpanExporter> | null = null;
  private failedPermanently: Error | null = null;
  private readonly config: MlflowOtlpExporterConfig;

  constructor(config: MlflowOtlpExporterConfig) {
    this.config = config;
  }

  /**
   * Lazy-init the OTLPTraceExporter (singleton promise to avoid races).
   * On first failure, latches `failedPermanently` so subsequent calls
   * resolve to `null` immediately rather than thundering-herd retrying.
   */
  private getInner(): Promise<SpanExporter | null> {
    if (this.failedPermanently) return Promise.resolve(null);
    if (!this.innerPromise) {
      const factory =
        this.config.createInner ??
        (async () => {
          const mod = await import("@opentelemetry/exporter-trace-otlp-proto");
          return new mod.OTLPTraceExporter({
            url: `${this.config.url}/v1/traces`,
            headers: {
              "x-mlflow-experiment-id": this.config.experimentId,
            },
          });
        });
      this.innerPromise = factory().catch((err) => {
        // Latch permanent failure — every future call resolves to null.
        this.failedPermanently = err instanceof Error ? err : new Error(String(err));
        throw this.failedPermanently;
      });
    }
    // Surface latched failure as `null` to callers, but never re-trigger import.
    return this.innerPromise.catch(() => null);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // Compute derived MLflow attrs into the side-channel registry — original
    // spans are not mutated. Wrap each span so the inner exporter sees the
    // merged view at serialization time.
    const wrapped = spans.map((span) => {
      this.indexDerivedAttrs(span);
      const extra = SpanAttributeRegistry.pop(span.spanContext().spanId);
      return extra ? withMergedAttrs(span, extra) : span;
    });

    this.getInner()
      .then((inner) => {
        if (!inner) {
          // Permanent failure: surface to the SDK so it stops retrying.
          resultCallback({ code: 1, error: this.failedPermanently ?? undefined });
          return;
        }
        inner.export(wrapped, resultCallback);
      })
      .catch((err) => {
        console.error("[MlflowOtlpExporter] Failed to initialize OTLP exporter:", err);
        resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
      });
  }

  /** Compute MLflow-shape attributes from a span and store them in the registry. */
  private indexDerivedAttrs(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    const events = (span as { events?: TimedEvent[] }).events;
    const out: Record<string, unknown> = {};

    // 1. ai.span.type → mlflow.spanType
    const spanType = attrs[AI_SPAN_TYPE] as string | undefined;
    if (spanType) {
      out["mlflow.spanType"] = SPAN_TYPE_TO_MLFLOW[spanType] ?? "CHAIN";
    }

    // 2. Process events → MLflow object attributes
    let spanInputs: Record<string, unknown> = {};
    let spanOutputs: Record<string, unknown> = {};
    let llmCost: Record<string, number> | null = null;

    if (events) {
      for (const event of events) {
        const eventAttrs = event.attributes ?? {};
        switch (event.name) {
          case EVENT_NODE_INPUT: {
            const data = eventAttrs["data"] as string | undefined;
            if (data) {
              try { spanInputs = { ...spanInputs, ...JSON.parse(data) }; } catch { spanInputs["raw"] = data; }
            } else {
              spanInputs = { ...spanInputs, ...Object.fromEntries(Object.entries(eventAttrs)) };
            }
            break;
          }
          case EVENT_NODE_OUTPUT: {
            const data = eventAttrs["data"] as string | undefined;
            if (data) {
              try { spanOutputs = { ...spanOutputs, ...JSON.parse(data) }; } catch { spanOutputs["raw"] = data; }
            } else {
              spanOutputs = { ...spanOutputs, ...Object.fromEntries(Object.entries(eventAttrs)) };
            }
            break;
          }
          case EVENT_LLM_REQUEST: {
            spanInputs = {
              ...spanInputs,
              model: eventAttrs["model"],
              prompt_name: eventAttrs["prompt_name"],
              system_prompt: eventAttrs["system_prompt"],
              user_prompt: eventAttrs["user_prompt"],
            };
            break;
          }
          case EVENT_LLM_COST: {
            llmCost = {
              input_cost: Number(eventAttrs["input_cost"] ?? 0),
              output_cost: Number(eventAttrs["output_cost"] ?? 0),
              total_cost: Number(eventAttrs["total_cost"] ?? 0),
            };
            break;
          }
          case EVENT_LLM_THINKING: {
            const content = eventAttrs["content"] as string | undefined;
            if (content) spanInputs["thinking"] = content;
            break;
          }
        }
      }
    }

    if (Object.keys(spanInputs).length > 0) out["mlflow.spanInputs"] = spanInputs;
    if (Object.keys(spanOutputs).length > 0) out["mlflow.spanOutputs"] = spanOutputs;
    if (llmCost) out["mlflow.llm.cost"] = llmCost;

    // 4. Token usage — prefer modern GenAI semconv, fall back to legacy ai.llm.*.
    const tokensIn =
      (attrs["gen_ai.usage.input_tokens"] as number | undefined) ??
      (attrs[AI_LLM_TOKENS_IN] as number | undefined);
    const tokensOut =
      (attrs["gen_ai.usage.output_tokens"] as number | undefined) ??
      (attrs[AI_LLM_TOKENS_OUT] as number | undefined);
    if (tokensIn !== undefined || tokensOut !== undefined) {
      out["mlflow.chat.tokenUsage"] = {
        input_tokens: tokensIn ?? 0,
        output_tokens: tokensOut ?? 0,
        total_tokens: (tokensIn ?? 0) + (tokensOut ?? 0),
      };
    }

    // 5. Copy model/provider to MLflow namespace
    const model = attrs[AI_LLM_MODEL] as string | undefined;
    if (model) {
      out["mlflow.llm.model"] = model;
      out["mlflow.llm.provider"] = attrs[AI_LLM_PROVIDER] ?? "unknown";
    }

    if (Object.keys(out).length > 0) {
      SpanAttributeRegistry.set(span.spanContext().spanId, out);
    }
  }

  async shutdown(): Promise<void> {
    if (this.failedPermanently) throw this.failedPermanently;
    const inner = this.innerPromise ? await this.innerPromise.catch(() => null) : null;
    if (inner?.shutdown) await inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    if (this.failedPermanently) throw this.failedPermanently;
    const inner = this.innerPromise ? await this.innerPromise.catch(() => null) : null;
    const flush = (inner as { forceFlush?: () => Promise<void> } | null)?.forceFlush;
    if (flush) await flush.call(inner);
  }
}

/** Factory function for creating an MLflow exporter. */
export const createMlflowExporter = (config: MlflowOtlpExporterConfig): MlflowOtlpExporter =>
  new MlflowOtlpExporter(config);
