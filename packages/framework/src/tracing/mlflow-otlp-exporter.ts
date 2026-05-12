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
 * - gen_ai.system.message event → merged into mlflow.spanInputs.system_prompt
 * - gen_ai.user.message event → merged into mlflow.spanInputs.user_prompt
 * - gen_ai.assistant.message event (reasoning_content) → mlflow.spanInputs.thinking
 * - ai.llm.cost event → mlflow.llm.cost (object attribute)
 * - gen_ai.request.model → mlflow.llm.model
 * - gen_ai.system → mlflow.llm.provider
 * - gen_ai.usage.input_tokens / gen_ai.usage.output_tokens → mlflow.chat.tokenUsage
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
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  EVENT_GEN_AI_SYSTEM_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_LLM_COST,
} from "./semantic-conventions.js";
import {
  createSpanAttributeRegistry,
  type SpanAttributeRegistry,
  type SpanAttributes,
} from "./span-attribute-registry.js";
import { fwLogger } from "../logger.js";

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
  /**
   * Optional side-channel registry for object-valued span attributes. When
   * omitted the exporter constructs its own private instance — parallel
   * exporters therefore never cross-corrupt each other's state. Pass a
   * shared registry only when an external producer (e.g. an enrichment
   * helper running outside the exporter) writes attributes for the same
   * spans this exporter will later export.
   */
  readonly registry?: SpanAttributeRegistry;
}

/** Map from our span type values to MLflow's uppercase constants */
const SPAN_TYPE_TO_MLFLOW: Record<string, string> = {
  chain: "CHAIN",
  llm: "LLM",
  retriever: "RETRIEVER",
  tool: "TOOL",
  // withLlmSpan / withToolSpan pass uppercase MLflow constants directly
  CHAT_MODEL: "CHAT_MODEL",
  TOOL: "TOOL",
  CHAIN: "CHAIN",
  LLM: "LLM",
  RETRIEVER: "RETRIEVER",
};

// ---------------------------------------------------------------------------
// Declarative translation tables
//
// The two tables below are the **single source of MLflow knowledge** for the
// framework. Adding a new vendor adapter (Langfuse, Phoenix, Honeycomb-GenAI)
// means writing analogous tables, not threading vendor logic through the
// rest of the framework.
//
// `ATTR_MAP` covers the simple case: copy one source attribute to one target
// attribute. `EVENT_HANDLERS` covers events whose payloads need to merge into
// MLflow's object-valued attributes (spanInputs / spanOutputs / llm.cost) —
// each handler mutates a shared accumulator.
// ---------------------------------------------------------------------------

/** Simple `from → to` attribute renames. Source values pass through unchanged. */
const ATTR_MAP: ReadonlyArray<{ readonly from: string; readonly to: string }> = [
  { from: GEN_AI_REQUEST_MODEL, to: "mlflow.llm.model" },
];

/** Accumulator threaded through event handlers as they walk a span's events. */
interface MlflowAccumulator {
  spanInputs: Record<string, unknown>;
  spanOutputs: Record<string, unknown>;
  llmCost: Record<string, number> | null;
}

interface EventHandlerCtx {
  readonly traceId: string;
  readonly parseFailureCounter: { count: number };
}

interface EventHandler {
  readonly event: string;
  readonly apply: (
    eventAttrs: Readonly<Record<string, unknown>>,
    acc: MlflowAccumulator,
    ctx: EventHandlerCtx,
  ) => void;
}

const mergeJsonDataField = (
  field: "spanInputs" | "spanOutputs",
  fieldLabel: string,
): EventHandler["apply"] => (eventAttrs, acc, ctx) => {
  const data = eventAttrs["data"] as string | undefined;
  if (data) {
    try {
      acc[field] = { ...acc[field], ...JSON.parse(data) };
    } catch (e) {
      logParseFailure(ctx.parseFailureCounter, fieldLabel, ctx.traceId, e);
      acc[field]["raw"] = data;
    }
  } else {
    acc[field] = { ...acc[field], ...Object.fromEntries(Object.entries(eventAttrs)) };
  }
};

const EVENT_HANDLERS: ReadonlyArray<EventHandler> = [
  { event: EVENT_NODE_INPUT, apply: mergeJsonDataField("spanInputs", "spanInputs") },
  { event: EVENT_NODE_OUTPUT, apply: mergeJsonDataField("spanOutputs", "spanOutputs") },
  {
    event: EVENT_GEN_AI_SYSTEM_MESSAGE,
    apply: (eventAttrs, acc) => {
      const content = eventAttrs["content"] as string | undefined;
      const promptName = eventAttrs["ai.prompt_name"] as string | undefined;
      if (content) acc.spanInputs["system_prompt"] = content;
      if (promptName) acc.spanInputs["prompt_name"] = promptName;
    },
  },
  {
    event: EVENT_GEN_AI_USER_MESSAGE,
    apply: (eventAttrs, acc) => {
      const content = eventAttrs["content"] as string | undefined;
      if (content) acc.spanInputs["user_prompt"] = content;
    },
  },
  {
    event: EVENT_GEN_AI_ASSISTANT_MESSAGE,
    apply: (eventAttrs, acc) => {
      const reasoning = eventAttrs["reasoning_content"] as string | undefined;
      if (reasoning) acc.spanInputs["thinking"] = reasoning;
    },
  },
  {
    event: EVENT_LLM_COST,
    apply: (eventAttrs, acc) => {
      acc.llmCost = {
        input_cost: Number(eventAttrs["input_cost"] ?? 0),
        output_cost: Number(eventAttrs["output_cost"] ?? 0),
        total_cost: Number(eventAttrs["total_cost"] ?? 0),
      };
    },
  },
];

const EVENT_HANDLERS_BY_NAME: ReadonlyMap<string, EventHandler["apply"]> = new Map(
  EVENT_HANDLERS.map((h) => [h.event, h.apply]),
);

/**
 * Rate-limited JSON parse failure logging. Logs at counts 1, 10, 100, 1000, …
 * to avoid spam from a misbehaving node while still surfacing the problem at
 * first occurrence.
 */
const logParseFailure = (counter: { count: number }, field: string, traceId: string, err: unknown): void => {
  counter.count++;
  const c = counter.count;
  // Log first hit and then every order-of-magnitude milestone.
  const shouldLog = c === 1 || (c >= 10 && c % Math.pow(10, Math.floor(Math.log10(c))) === 0);
  if (shouldLog) {
    fwLogger().warn(
      `[MlflowOtlpExporter] JSON parse failed for ${field} on trace ${traceId} (occurrence ${c}): ${err instanceof Error ? err.message : err}`,
    );
  }
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
  private readonly parseFailureCounter = { count: 0 };
  private readonly registry: SpanAttributeRegistry;

  /** Exposed for health checks — non-null when initialization failed permanently. */
  get failed(): Error | null {
    return this.failedPermanently;
  }

  /**
   * Cumulative JSON parse failures observed on `mlflow.spanInputs` /
   * `mlflow.spanOutputs` data fields, per-instance. Tests assert isolation
   * across exporters; operators can scrape it for misbehaving producers.
   */
  get parseFailureCount(): number {
    return this.parseFailureCounter.count;
  }

  /** Number of spans dropped due to permanent initialization failure. */
  droppedSpanCount = 0;

  constructor(config: MlflowOtlpExporterConfig) {
    this.config = config;
    this.registry = config.registry ?? createSpanAttributeRegistry();
  }

  /** The side-channel registry this exporter owns or was wired with. */
  getRegistry(): SpanAttributeRegistry {
    return this.registry;
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
        // Log at the failure point so misconfiguration is visible
        // immediately. Without this the failure was silently latched and only
        // logged on the next export() (and only if getInner threw, which it
        // can't here because of the `.catch(() => null)` below).
        fwLogger().error(
          "[MlflowOtlpExporter] Permanent initialization failure — all future spans will be dropped:",
          this.failedPermanently,
        );
        throw this.failedPermanently;
      });
    }
    // Surface latched failure as `null` to callers, but never re-trigger import.
    return this.innerPromise.catch(() => null);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // Compute derived MLflow attrs and wrap spans inline — no intermediate
    // registry storage, so an exception cannot leak entries.
    const wrapped = spans.map((span) => {
      const extra = this.computeDerivedAttrs(span);
      // Also merge any pre-existing registry entries (from external callers)
      const registryExtra = this.registry.pop(span.spanContext().spanId);
      const merged = registryExtra ? { ...registryExtra, ...extra } : extra;
      return merged && Object.keys(merged).length > 0 ? withMergedAttrs(span, merged) : span;
    });

    this.getInner()
      .then((inner) => {
        if (!inner) {
          // Permanent failure: surface to the SDK so it stops retrying.
          this.droppedSpanCount += spans.length;
          resultCallback({ code: 1, error: this.failedPermanently ?? undefined });
          return;
        }
        inner.export(wrapped, resultCallback);
      })
      .catch((err) => {
        fwLogger().error("[MlflowOtlpExporter] Failed to initialize OTLP exporter:", err);
        this.droppedSpanCount += spans.length;
        resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
      });
  }

  /** Compute MLflow-shape attributes from a span. Returns the extra attrs or undefined. */
  private computeDerivedAttrs(span: ReadableSpan): SpanAttributes | undefined {
    const attrs = span.attributes as Record<string, unknown>;
    const events = (span as { events?: TimedEvent[] }).events;
    const traceId = span.spanContext().traceId;
    const out: Record<string, unknown> = {};

    // ai.span.type → mlflow.spanType — enum re-mapping (not a straight copy),
    // SPAN_TYPE_TO_MLFLOW normalises our casing to MLflow's uppercase constants.
    // Surface unknown values via fwLogger so silently coercing to CHAIN doesn't
    // mask a producer typo.
    const spanType = attrs[AI_SPAN_TYPE] as string | undefined;
    if (spanType) {
      const mlflowType = SPAN_TYPE_TO_MLFLOW[spanType];
      if (!mlflowType) {
        fwLogger().warn(
          `[MlflowOtlpExporter] Unknown spanType="${spanType}" → defaulting to CHAIN`,
        );
      }
      out["mlflow.spanType"] = mlflowType ?? "CHAIN";
    }

    for (const { from, to } of ATTR_MAP) {
      const value = attrs[from];
      if (value !== undefined) out[to] = value;
    }

    const acc: MlflowAccumulator = { spanInputs: {}, spanOutputs: {}, llmCost: null };
    if (events) {
      for (const event of events) {
        const handler = EVENT_HANDLERS_BY_NAME.get(event.name);
        if (handler) handler(event.attributes ?? {}, acc, { traceId, parseFailureCounter: this.parseFailureCounter });
      }
    }
    if (Object.keys(acc.spanInputs).length > 0) out["mlflow.spanInputs"] = acc.spanInputs;
    if (Object.keys(acc.spanOutputs).length > 0) out["mlflow.spanOutputs"] = acc.spanOutputs;
    if (acc.llmCost) out["mlflow.llm.cost"] = acc.llmCost;

    const tokensIn = attrs[GEN_AI_USAGE_INPUT_TOKENS] as number | undefined;
    const tokensOut = attrs[GEN_AI_USAGE_OUTPUT_TOKENS] as number | undefined;
    if (tokensIn !== undefined || tokensOut !== undefined) {
      out["mlflow.chat.tokenUsage"] = {
        input_tokens: tokensIn ?? 0,
        output_tokens: tokensOut ?? 0,
        total_tokens: (tokensIn ?? 0) + (tokensOut ?? 0),
      };
    }

    // Emit provider only when a model is present — keeps non-LLM spans from
    // getting a misleading provider stamp.
    if (attrs[GEN_AI_REQUEST_MODEL] !== undefined) {
      out["mlflow.llm.provider"] = attrs[GEN_AI_SYSTEM] ?? "unknown";
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }

  async shutdown(): Promise<void> {
    // No-op when init failed permanently — the failure was already logged at
    // init time. Re-throwing here aborts the OTel SDK shutdown chain and
    // leaves sibling exporters un-closed.
    if (this.failedPermanently) return;
    if (!this.innerPromise) return;
    const inner = await this.innerPromise.catch(() => null);
    if (inner?.shutdown) await inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    // No-op when init failed permanently. Silently resolving used to mask
    // dropped spans; now the dropped count is surfaced via `droppedSpanCount`
    // and the original init error via `failed`.
    if (this.failedPermanently) return;
    if (!this.innerPromise) return;
    const inner = await this.innerPromise.catch(() => null);
    const flush = (inner as { forceFlush?: () => Promise<void> } | null)?.forceFlush;
    if (flush) await flush.call(inner);
  }
}

/** Factory function for creating an MLflow exporter. */
export const createMlflowExporter = (config: MlflowOtlpExporterConfig): MlflowOtlpExporter =>
  new MlflowOtlpExporter(config);
