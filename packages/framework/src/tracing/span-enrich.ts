/**
 * Shared span enrichment for LLM calls.
 * Used by both the generic LLM node and the eval-judge node.
 *
 * Uses vendor-neutral OTel primitives: flat attributes + span events.
 * Backend-specific exporters (e.g., MLflow) transform these into their format.
 */
import { trace } from "@opentelemetry/api";
import { costBreakdownUsd, costRatesFor, isPricedModel } from "../llm/cost.js";
import type { CacheTtl, ConversationCachePolicy } from "../types/llm.js";
import type { TokenUsage } from "../types/token-usage.js";
import { isCacheInert } from "../types/token-usage.js";
import type { ContentFilter } from "./content-filter.js";
import { resolveContentFilter } from "./content-filter.js";
import {
  AI_LLM_COST_PRICED,
  AI_LLM_COST_USD,
  AI_LLM_HAS_THINKING,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SYSTEM,
  AI_PROMPT_CACHE_EFFECTIVE,
  AI_PROMPT_CACHE_POLICY,
  GEN_AI_USAGE_CACHE_READ_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_GEN_AI_SYSTEM_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  EVENT_LLM_COST,
} from "./semantic-conventions.js";

export interface EnrichLlmSpanOpts {
  readonly model: string;
  readonly promptName?: string;
  /** Fingerprint of the prompt sources — ties a trace to the prompt version that produced it. */
  readonly promptHash?: string;
  readonly system: string;
  readonly user: string;
  /** The call's token consumption, including its provider-side cache split. */
  readonly usage: TokenUsage;
  /**
   * The declared cache policy's discriminant, when the call declared one. Drives
   * `ai.prompt_cache.policy` and, with the usage, `ai.prompt_cache.effective` —
   * the pair that makes a policy which quietly did nothing visible in a trace.
   */
  readonly cachePolicy?: ConversationCachePolicy["kind"];
  /** TTL of any cache entry this call wrote — sets the write premium in the cost. */
  readonly cacheWriteTtl?: CacheTtl;
  readonly thinking?: string;
  readonly provider?: string;
  /**
   * Content filter applied to prompt/output/thinking before attaching to spans.
   * When `null`/`undefined`, content is fully redacted. Use `piiScrubber` for
   * regex-based PII removal or `IDENTITY_FILTER` for unfiltered content.
   */
  readonly contentFilter?: ContentFilter | null;
}

/** Enrich the currently-active OTel span with LLM request/response details. */
export const enrichLlmSpan = (opts: EnrichLlmSpanOpts): void => {
  const otelSpan = trace.getActiveSpan();
  if (!otelSpan) return;

  // One cost implementation, shared with `computeCostUsd` — a second copy here
  // would have kept charging cache reads at the full input rate while the other
  // learned the multipliers, and no test would have caught the divergence.
  const cost = costBreakdownUsd(costRatesFor(opts.model), opts.usage, opts.cacheWriteTtl);

  // Flat attributes — OTel GenAI semconv for model/provider/usage, framework-owned
  // ai.llm.cost_usd for cost (not covered by the spec).
  otelSpan.setAttribute(GEN_AI_REQUEST_MODEL, opts.model);
  otelSpan.setAttribute(GEN_AI_SYSTEM, opts.provider ?? "unknown");
  otelSpan.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, opts.usage.tokensIn);
  otelSpan.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, opts.usage.tokensOut);
  otelSpan.setAttribute(GEN_AI_USAGE_CACHE_WRITE_TOKENS, opts.usage.cacheWriteTokens);
  otelSpan.setAttribute(GEN_AI_USAGE_CACHE_READ_TOKENS, opts.usage.cacheReadTokens);
  otelSpan.setAttribute(AI_LLM_COST_USD, cost.total);
  otelSpan.setAttribute(AI_LLM_COST_PRICED, isPricedModel(opts.model));
  if (opts.cachePolicy !== undefined) {
    otelSpan.setAttribute(AI_PROMPT_CACHE_POLICY, opts.cachePolicy);
    // Only meaningful for a call that ASKED for caching: for `none` there is
    // nothing to be effective or ineffective about.
    if (opts.cachePolicy !== "none") {
      otelSpan.setAttribute(AI_PROMPT_CACHE_EFFECTIVE, !isCacheInert(opts.usage));
    }
  }
  if (opts.promptHash !== undefined) otelSpan.setAttribute("ai.prompt_hash", opts.promptHash);

  const filter = resolveContentFilter(opts);

  /**
   * One encoding of the filter-or-redact rule the three GenAI message events
   * share: when a content filter is wired the (filtered) text is emitted under
   * `<field>`; when it is not, the text NEVER leaves the process and the event
   * carries `<field>_redacted` plus the original length instead.
   *
   * `field` varies (`content` for system/user, `reasoning_content` for the
   * assistant message) which is why this takes it as a parameter rather than
   * hardcoding `content` — three copies of the ternary is how the redaction
   * rule and the length disclosure drift apart on the field that gets missed.
   */
  const contentAttrs = (
    field: "content" | "reasoning_content",
    text: string,
  ): Record<string, string | number> =>
    filter
      ? { [field]: filter(text) }
      : { [`${field}_redacted`]: "true", [`${field}_chars`]: text.length };

  // OTel GenAI semconv: emit prompts as `gen_ai.system.message` and
  // `gen_ai.user.message` events. Content gated by content filter (PII).
  // The `prompt_name` framework field rides along as an extra attribute on
  // the system message — not part of the spec, but harmless and useful.
  otelSpan.addEvent(EVENT_GEN_AI_SYSTEM_MESSAGE, {
    role: "system",
    ...contentAttrs("content", opts.system),
    "ai.prompt_name": opts.promptName ?? "",
  });
  otelSpan.addEvent(EVENT_GEN_AI_USER_MESSAGE, {
    role: "user",
    ...contentAttrs("content", opts.user),
  });

  // Structured event: cost breakdown (framework-specific — not in GenAI spec).
  // `input_cost` stays the whole prompt side so existing consumers are
  // unaffected; the two cache components refine it.
  otelSpan.addEvent(EVENT_LLM_COST, {
    input_cost: cost.uncachedInput + cost.cacheWrite + cost.cacheRead,
    output_cost: cost.output,
    cache_write_cost: cost.cacheWrite,
    cache_read_cost: cost.cacheRead,
    total_cost: cost.total,
  });

  // Thinking/reasoning — emit as a `gen_ai.assistant.message` event with a
  // `reasoning_content` body field. The OTel spec doesn't yet standardize the
  // reasoning field, so this is the framework's convention; consumers that
  // know GenAI semconv will still see the event and the role.
  if (opts.thinking) {
    otelSpan.setAttribute(AI_LLM_HAS_THINKING, true);
    otelSpan.addEvent(EVENT_GEN_AI_ASSISTANT_MESSAGE, {
      role: "assistant",
      ...contentAttrs("reasoning_content", opts.thinking),
    });
  }
};
