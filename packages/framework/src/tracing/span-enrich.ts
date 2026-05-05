/**
 * Shared span enrichment for LLM calls.
 * Used by both the generic LLM node and the eval-judge node.
 */
import { computeCostUsd } from "../llm/cost.js";
import { mlflow } from "./mlflow.js";

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
  const getSpan = mlflow().getCurrentActiveSpan;
  if (!getSpan) return;
  const span = getSpan();
  if (!span?.setAttribute) return;

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
  span.setAttribute("llm.model", opts.model);
  span.setAttribute("llm.tokens_in", opts.tokensIn);
  span.setAttribute("llm.tokens_out", opts.tokensOut);
  span.setAttribute("cost_usd", computeCostUsd(opts.model, opts.tokensIn, opts.tokensOut));
  if (opts.thinking) {
    span.setAttribute("llm.thinking", opts.thinking);
  }
};
