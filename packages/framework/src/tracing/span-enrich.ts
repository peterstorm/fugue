/**
 * Shared span enrichment for LLM calls.
 * Used by both the generic LLM node and the eval-judge node.
 *
 * Uses vendor-neutral OTel primitives: flat attributes + span events.
 * Backend-specific exporters (e.g., MLflow) transform these into their format.
 */
import { trace } from "@opentelemetry/api";
import { PRICE_TABLE } from "../llm/cost.js";
import {
  AI_LLM_MODEL,
  AI_LLM_PROVIDER,
  AI_LLM_TOKENS_IN,
  AI_LLM_TOKENS_OUT,
  AI_LLM_COST_USD,
  AI_LLM_HAS_THINKING,
  EVENT_LLM_REQUEST,
  EVENT_LLM_COST,
  EVENT_LLM_THINKING,
} from "./semantic-conventions.js";

const getCostRates = (model: string) => PRICE_TABLE[model] ?? { inputPer1M: 0, outputPer1M: 0 };

export interface EnrichLlmSpanOpts {
  readonly model: string;
  readonly promptName?: string;
  readonly system: string;
  readonly user: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly thinking?: string;
  readonly provider?: string;
  readonly extraInputs?: Record<string, unknown>;
  /**
   * When `true`, include prompt/output/thinking content in spans.
   * Default OFF — these payloads frequently contain PII and should not leave
   * the process boundary unless an operator has explicitly opted in. Caller
   * (typically a node) reads this from `NodeContext.includeContent`.
   */
  readonly includeContent?: boolean;
}

/** Enrich the currently-active OTel span with LLM request/response details. */
export const enrichLlmSpan = (opts: EnrichLlmSpanOpts): void => {
  const otelSpan = trace.getActiveSpan();
  if (!otelSpan) return;

  const inputCost = (opts.tokensIn * getCostRates(opts.model).inputPer1M) / 1_000_000;
  const outputCost = (opts.tokensOut * getCostRates(opts.model).outputPer1M) / 1_000_000;
  const totalCost = inputCost + outputCost;

  // Flat attributes (primitive values — always safe with any OTel backend)
  otelSpan.setAttribute(AI_LLM_MODEL, opts.model);
  otelSpan.setAttribute(AI_LLM_PROVIDER, opts.provider ?? "unknown");
  otelSpan.setAttribute(AI_LLM_TOKENS_IN, opts.tokensIn);
  otelSpan.setAttribute(AI_LLM_TOKENS_OUT, opts.tokensOut);
  otelSpan.setAttribute(AI_LLM_COST_USD, totalCost);

  const includeContent = opts.includeContent ?? false;

  // Structured event: LLM request details. Prompts gated by LLM_TRACE_PROMPTS (PII).
  otelSpan.addEvent(EVENT_LLM_REQUEST, includeContent
    ? {
        model: opts.model,
        prompt_name: opts.promptName ?? "",
        system_prompt: opts.system,
        user_prompt: opts.user,
      }
    : {
        model: opts.model,
        prompt_name: opts.promptName ?? "",
        system_prompt_redacted: "true",
        user_prompt_redacted: "true",
        system_prompt_chars: opts.system.length,
        user_prompt_chars: opts.user.length,
      });

  // Structured event: cost breakdown
  otelSpan.addEvent(EVENT_LLM_COST, {
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: totalCost,
  });

  // Thinking/reasoning (potentially large + may contain PII)
  if (opts.thinking) {
    otelSpan.setAttribute(AI_LLM_HAS_THINKING, true);
    if (includeContent) {
      otelSpan.addEvent(EVENT_LLM_THINKING, { content: opts.thinking });
    } else {
      otelSpan.addEvent(EVENT_LLM_THINKING, { content_redacted: "true", content_chars: opts.thinking.length });
    }
  }
};
