/**
 * MLflow-aware OTLP exporter.
 *
 * Wraps OTLPTraceExporter and injects object-valued attributes from the
 * SpanAttributeRegistry onto ReadableSpan.attributes before serialization.
 *
 * The OTel SDK drops object attributes, but the otlp-transformer serializer
 * handles them fine (emits kvlist_value in protobuf). By mutating the attributes
 * object after the SDK's validation but before serialization, we get structured
 * attributes through to MLflow's server.
 *
 * MLflow's OTLP handler (/v1/traces) then:
 * - Decodes kvlist_value → Python dict
 * - dump_span_attribute_value(dict) → JSON string
 * - log_spans() reads mlflow.llm.cost → json.loads → writes to span_metrics table
 */
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { SpanAttributeRegistry } from "./span-attribute-registry.js";

export interface MlflowOtlpExporterConfig {
  /** MLflow tracking server URL (e.g. "http://localhost:5000") */
  readonly url: string;
  /** MLflow experiment ID (sent as x-mlflow-experiment-id header) */
  readonly experimentId: string;
}

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
        // Reset so next call can retry
        this.innerPromise = null;
        throw err;
      });
    }
    return this.innerPromise;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // Inject object attributes from registry onto each span
    for (const span of spans) {
      const spanId = span.spanContext().spanId;
      const extra = SpanAttributeRegistry.pop(spanId);
      if (extra) {
        // Mutate the attributes object directly. The OTel SDK doesn't freeze it.
        // The otlp-transformer will serialize objects as kvlist_value.
        const attrs = span.attributes as Record<string, unknown>;
        for (const [key, value] of Object.entries(extra)) {
          attrs[key] = value;
        }
      }
    }

    // Forward to the real OTLP exporter
    this.getInner()
      .then((inner) => inner.export(spans, resultCallback))
      .catch((err) => {
        console.error("[MlflowOtlpExporter] Failed to initialize OTLP exporter:", err);
        resultCallback({ code: 1 });
      });
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
