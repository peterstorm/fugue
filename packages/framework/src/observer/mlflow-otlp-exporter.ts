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
 * - ai.llm.tokens_in/out → mlflow.chat.tokenUsage (object)
 *
 * The OTel SDK drops object-valued attributes, so we inject them onto the
 * ReadableSpan.attributes object after SDK validation but before serialization.
 * The otlp-transformer serializes objects as protobuf kvlist_value.
 */
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import {
  AI_SPAN_TYPE,
  AI_LLM_MODEL,
  AI_LLM_PROVIDER,
  AI_LLM_TOKENS_IN,
  AI_LLM_TOKENS_OUT,
  AI_LLM_COST_USD,
  AI_LLM_HAS_THINKING,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  EVENT_LLM_REQUEST,
  EVENT_LLM_COST,
  EVENT_LLM_THINKING,
} from "../tracing/semantic-conventions.js";

export interface MlflowOtlpExporterConfig {
  /** MLflow tracking server URL (e.g. "http://localhost:5000") */
  readonly url: string;
  /** MLflow experiment ID (sent as x-mlflow-experiment-id header) */
  readonly experimentId: string;
}

/** Map from our span type values to MLflow's uppercase constants */
const SPAN_TYPE_TO_MLFLOW: Record<string, string> = {
  chain: "CHAIN",
  llm: "LLM",
  retriever: "RETRIEVER",
  tool: "TOOL",
};

export class MlflowOtlpExporter implements SpanExporter {
  private innerPromise: Promise<SpanExporter> | null = null;
  private readonly config: MlflowOtlpExporterConfig;

  constructor(config: MlflowOtlpExporterConfig) {
    this.config = config;
  }

  /** Lazy-init the OTLPTraceExporter (singleton promise to avoid races). */
  private getInner(): Promise<SpanExporter> {
    if (!this.innerPromise) {
      this.innerPromise = import("@opentelemetry/exporter-trace-otlp-proto").then(
        ({ OTLPTraceExporter }) =>
          new OTLPTraceExporter({
            url: `${this.config.url}/v1/traces`,
            headers: {
              "x-mlflow-experiment-id": this.config.experimentId,
            },
          }),
      ).catch((err) => {
        this.innerPromise = null;
        throw err;
      });
    }
    return this.innerPromise;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // Transform each span: read standard events/attrs → inject MLflow object attributes
    for (const span of spans) {
      this.transformSpan(span);
    }

    // Forward to the real OTLP exporter
    this.getInner()
      .then((inner) => inner.export(spans, resultCallback))
      .catch((err) => {
        console.error("[MlflowOtlpExporter] Failed to initialize OTLP exporter:", err);
        resultCallback({ code: 1 });
      });
  }

  /** Transform a vendor-neutral span into MLflow's expected attribute format. */
  private transformSpan(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    const events = (span as any).events as TimedEvent[] | undefined;

    // 1. ai.span.type → mlflow.spanType
    const spanType = attrs[AI_SPAN_TYPE] as string | undefined;
    if (spanType) {
      attrs["mlflow.spanType"] = SPAN_TYPE_TO_MLFLOW[spanType] ?? "CHAIN";
    }

    // 2. Process events → MLflow object attributes
    let spanInputs: Record<string, unknown> = {};
    let spanOutputs: Record<string, unknown> = {};
    let llmCost: Record<string, number> | null = null;
    let tokenUsage: Record<string, number> | null = null;

    if (events) {
      for (const event of events) {
        const eventAttrs = event.attributes ?? {};
        switch (event.name) {
          case EVENT_NODE_INPUT: {
            const data = eventAttrs["data"] as string | undefined;
            if (data) {
              try { spanInputs = { ...spanInputs, ...JSON.parse(data) }; } catch { spanInputs["raw"] = data; }
            } else {
              // Flat event attributes (used by root span)
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
            // Merge into spanInputs
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
            if (content) {
              spanInputs["thinking"] = content;
            }
            break;
          }
        }
      }
    }

    // 3. Inject object attributes
    if (Object.keys(spanInputs).length > 0) {
      attrs["mlflow.spanInputs"] = spanInputs;
    }
    if (Object.keys(spanOutputs).length > 0) {
      attrs["mlflow.spanOutputs"] = spanOutputs;
    }
    if (llmCost) {
      attrs["mlflow.llm.cost"] = llmCost;
    }

    // 4. Token usage from flat attributes → object
    const tokensIn = attrs[AI_LLM_TOKENS_IN] as number | undefined;
    const tokensOut = attrs[AI_LLM_TOKENS_OUT] as number | undefined;
    if (tokensIn !== undefined || tokensOut !== undefined) {
      tokenUsage = {
        input_tokens: tokensIn ?? 0,
        output_tokens: tokensOut ?? 0,
        total_tokens: (tokensIn ?? 0) + (tokensOut ?? 0),
      };
      attrs["mlflow.chat.tokenUsage"] = tokenUsage;
    }

    // 5. Copy model/provider to MLflow namespace
    const model = attrs[AI_LLM_MODEL] as string | undefined;
    if (model) {
      attrs["mlflow.llm.model"] = model;
      attrs["mlflow.llm.provider"] = attrs[AI_LLM_PROVIDER] ?? "unknown";
    }
  }

  async shutdown(): Promise<void> {
    const inner = await this.innerPromise?.catch(() => null);
    if (inner?.shutdown) await inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    const inner = await this.innerPromise?.catch(() => null);
    if ((inner as any)?.forceFlush) await (inner as any).forceFlush();
  }
}

/** Factory function for creating an MLflow exporter. */
export const createMlflowExporter = (config: MlflowOtlpExporterConfig): MlflowOtlpExporter =>
  new MlflowOtlpExporter(config);
