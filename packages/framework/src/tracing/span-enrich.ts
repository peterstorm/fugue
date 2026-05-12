/**
 * Shared span enrichment for LLM calls.
 * Used by both the generic LLM node and the eval-judge node.
 *
 * Uses vendor-neutral OTel primitives: flat attributes + span events.
 * Backend-specific exporters (e.g., MLflow) transform these into their format.
 */
import { trace } from "@opentelemetry/api";
import { PRICE_TABLE } from "../llm/cost.js";
import type { ContentFilter } from "./content-filter.js";
import { resolveContentFilter } from "./content-filter.js";
import {
  AI_LLM_COST_USD,
  AI_LLM_HAS_THINKING,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_GEN_AI_SYSTEM_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  EVENT_LLM_COST,
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
  /**
   * Content filter applied to prompt/output/thinking before attaching to spans.
   * When `null`/`undefined`, content is fully redacted. Use `piiScrubber` for
   * regex-based PII removal or `IDENTITY_FILTER` for unfiltered content.
   */
  readonly contentFilter?: ContentFilter | null;
  /**
   * @deprecated Use `contentFilter` instead.
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

  // Flat attributes — OTel GenAI semconv for model/provider/usage, framework-owned
  // ai.llm.cost_usd for cost (not covered by the spec).
  otelSpan.setAttribute(GEN_AI_REQUEST_MODEL, opts.model);
  otelSpan.setAttribute(GEN_AI_SYSTEM, opts.provider ?? "unknown");
  otelSpan.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, opts.tokensIn);
  otelSpan.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, opts.tokensOut);
  otelSpan.setAttribute(AI_LLM_COST_USD, totalCost);

  const filter = resolveContentFilter(opts);

  // OTel GenAI semconv: emit prompts as `gen_ai.system.message` and
  // `gen_ai.user.message` events. Content gated by content filter (PII).
  // The `prompt_name` framework field rides along as an extra attribute on
  // the system message — not part of the spec, but harmless and useful.
  otelSpan.addEvent(
    EVENT_GEN_AI_SYSTEM_MESSAGE,
    filter
      ? {
          role: "system",
          content: filter(opts.system),
          "ai.prompt_name": opts.promptName ?? "",
        }
      : {
          role: "system",
          content_redacted: "true",
          content_chars: opts.system.length,
          "ai.prompt_name": opts.promptName ?? "",
        },
  );
  otelSpan.addEvent(
    EVENT_GEN_AI_USER_MESSAGE,
    filter
      ? { role: "user", content: filter(opts.user) }
      : { role: "user", content_redacted: "true", content_chars: opts.user.length },
  );

  // Structured event: cost breakdown (framework-specific — not in GenAI spec).
  otelSpan.addEvent(EVENT_LLM_COST, {
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: totalCost,
  });

  // Thinking/reasoning — emit as a `gen_ai.assistant.message` event with a
  // `reasoning_content` body field. The OTel spec doesn't yet standardize the
  // reasoning field, so this is the framework's convention; consumers that
  // know GenAI semconv will still see the event and the role.
  if (opts.thinking) {
    otelSpan.setAttribute(AI_LLM_HAS_THINKING, true);
    otelSpan.addEvent(
      EVENT_GEN_AI_ASSISTANT_MESSAGE,
      filter
        ? { role: "assistant", reasoning_content: filter(opts.thinking) }
        : {
            role: "assistant",
            reasoning_content_redacted: "true",
            reasoning_content_chars: opts.thinking.length,
          },
    );
  }
};
