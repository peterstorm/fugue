/**
 * Shared span enrichment for LLM calls.
 * Used by both the generic LLM node and the eval-judge node.
 *
 * Sets attributes on the MLflow span (for backward compat / trace UI inputs/outputs)
 * AND registers object-valued attributes in SpanAttributeRegistry for OTLP export
 * (since OTel SDK rejects non-primitive attribute values).
 */
import { trace } from "@opentelemetry/api";
import { PRICE_TABLE } from "../llm/cost.js";
import { mlflow } from "./mlflow.js";
import { SpanAttributeRegistry } from "../observer/span-attribute-registry.js";

const getCostRates = (model: string) => PRICE_TABLE[model] ?? { inputPer1M: 0, outputPer1M: 0 };

export interface EnrichLlmSpanOpts {
  readonly model: string;
  readonly promptName?: string;
  readonly system: string;
  readonly user: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly thinking?: string;
  readonly extraInputs?: Record<string, unknown>;
}

/** Enrich the currently-active OTel span with LLM request/response details. */
export const enrichLlmSpan = (opts: EnrichLlmSpanOpts): void => {
  // --- MLflow span (for trace UI inputs/outputs) ---
  const getSpan = mlflow().getCurrentActiveSpan;
  if (getSpan) {
    const span = getSpan();
    if (span?.setAttribute) {
      span.setInputs({
        model: opts.model,
        prompt_name: opts.promptName,
        system_prompt: opts.system,
        user_prompt: opts.user,
        ...opts.extraInputs,
      });
      span.setAttribute("mlflow.chat.tokenUsage", {
        input_tokens: opts.tokensIn,
        output_tokens: opts.tokensOut,
        total_tokens: opts.tokensIn + opts.tokensOut,
      });
      span.setAttribute("mlflow.llm.model", opts.model);
      span.setAttribute("mlflow.llm.provider", "azure_openai");
    }
  }

  // --- OTel span attribute registry (for OTLP export → span_metrics) ---
  const otelSpan = trace.getActiveSpan();
  if (otelSpan) {
    const spanId = otelSpan.spanContext().spanId;
    const inputCost = (opts.tokensIn * getCostRates(opts.model).inputPer1M) / 1_000_000;
    const outputCost = (opts.tokensOut * getCostRates(opts.model).outputPer1M) / 1_000_000;

    // Register object attributes that the OTLP exporter will inject
    SpanAttributeRegistry.set(spanId, {
      "mlflow.llm.cost": {
        input_cost: inputCost,
        output_cost: outputCost,
        total_cost: inputCost + outputCost,
      },
      "mlflow.chat.tokenUsage": {
        input_tokens: opts.tokensIn,
        output_tokens: opts.tokensOut,
        total_tokens: opts.tokensIn + opts.tokensOut,
      },
      "mlflow.spanInputs": {
        model: opts.model,
        prompt_name: opts.promptName,
        system_prompt: opts.system,
        user_prompt: opts.user,
        ...opts.extraInputs,
      },
    });

    // Set primitive attributes directly on OTel span (these pass validation)
    otelSpan.setAttribute("mlflow.llm.model", opts.model);
    otelSpan.setAttribute("mlflow.llm.provider", "azure_openai");
    otelSpan.setAttribute("llm.model", opts.model);
    otelSpan.setAttribute("llm.tokens_in", opts.tokensIn);
    otelSpan.setAttribute("llm.tokens_out", opts.tokensOut);
    if (opts.thinking) {
      otelSpan.setAttribute("llm.thinking", opts.thinking);
    }
  }
};
