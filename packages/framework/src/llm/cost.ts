import { fwLogger } from "../logger.js";
import type { CacheTtl } from "../types/llm.js";
import type { TokenUsage } from "../types/token-usage.js";
import { uncachedInputTokens } from "../types/token-usage.js";

const PRICE_TABLE: Record<string, { readonly inputPer1M: number; readonly outputPer1M: number }> = {
  // Anthropic
  "claude-sonnet-4-20250514": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-20250514": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-sonnet-20240229": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
  // OpenAI
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o-2024-11-20": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4-turbo": { inputPer1M: 10.0, outputPer1M: 30.0 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "gpt-5-mini": { inputPer1M: 0.3, outputPer1M: 1.25 },
};

export { PRICE_TABLE };

/** Per-million-token rates for one model. */
export interface CostRates {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

/**
 * Rates for a model, or zeroes when the model is unpriced.
 *
 * Callers that want the operator warning use `computeCostUsd`; this exists for
 * the span enricher, which computes a cost per call and must not emit a log
 * line per span.
 */
export const costRatesFor = (model: string): CostRates =>
  PRICE_TABLE[model] ?? { inputPer1M: 0, outputPer1M: 0 };

/**
 * Price multipliers applied to the base INPUT rate, by how the prompt tokens
 * were billed. Cached reads are the reason prompt caching pays; the write
 * premium is the reason it is opt-in.
 *
 * A 5-minute entry breaks even on the second request (1.25 + 0.1 < 2.0); a
 * 1-hour entry on the third (2.0 + 0.2 < 3.0).
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER: Readonly<Record<CacheTtl, number>> = Object.freeze({
  "5m": 1.25,
  "1h": 2.0,
});

/**
 * THE cost calculation — every USD figure the framework emits derives from here,
 * split by how each token was billed.
 *
 * The three prompt-token classes are priced separately; that is the whole point
 * of the breakdown. Charging cache reads at the full input rate would overstate
 * a cached run's cost by ~10x and make caching look like it did nothing.
 *
 * `writeTtl` is a PARAMETER rather than a field on `TokenUsage`: the TTL is
 * fixed per request and every caller already knows it, so passing it here keeps
 * the usage value four plain numbers with a trivially total monoid instead of
 * splitting the write count per TTL. It only affects calls that wrote an entry.
 *
 * The components are emitted on the `llm.cost` span event so an operator can see
 * what caching actually saved rather than only the net figure; `total` is what
 * every cost caller reads. Deriving both here means they cannot drift apart.
 *
 * @satisfies FR-PC-008 — cache-write weighted by TTL, cache-read at 0.1x
 *
 * Emitted on the `llm.cost` span event so an operator can see what caching
 * actually saved rather than only the net figure. Derived here, beside the
 * pricing rules, rather than reconstructed by the caller from synthetic usage
 * values — the components and the total cannot drift apart.
 */
export interface CostBreakdownUsd {
  readonly uncachedInput: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly total: number;
}

export const costBreakdownUsd = (
  rates: CostRates,
  usage: TokenUsage,
  writeTtl: CacheTtl = "5m",
): CostBreakdownUsd => {
  const perMillion = (tokens: number, rate: number): number => (tokens * rate) / 1_000_000;
  const uncachedInput = perMillion(uncachedInputTokens(usage), rates.inputPer1M);
  const cacheWrite = perMillion(
    usage.cacheWriteTokens * CACHE_WRITE_MULTIPLIER[writeTtl],
    rates.inputPer1M,
  );
  const cacheRead = perMillion(usage.cacheReadTokens * CACHE_READ_MULTIPLIER, rates.inputPer1M);
  const output = perMillion(usage.tokensOut, rates.outputPer1M);
  return {
    uncachedInput,
    cacheWrite,
    cacheRead,
    output,
    total: uncachedInput + cacheWrite + cacheRead + output,
  };
};

/**
 * THE cost calculation — every USD figure the framework emits comes from here.
 *
 * The three prompt-token classes are priced separately; that is the whole point
 * of the breakdown. Charging cache reads at the full input rate would overstate
 * a cached run's cost by ~10x and make caching look like it did nothing.
 *
 * `writeTtl` is a PARAMETER rather than a field on `TokenUsage`: the TTL is
 * fixed per request and every caller already knows it, so passing it here keeps
 * the usage value four plain numbers with a trivially total monoid instead of
 * splitting the write count per TTL. It only affects calls that wrote an entry.
 *
 * @satisfies FR-PC-008 — cache-write weighted by TTL, cache-read at 0.1x
 */
export const costUsd = (
  rates: CostRates,
  usage: TokenUsage,
  writeTtl: CacheTtl = "5m",
): number => costBreakdownUsd(rates, usage, writeTtl).total;

/**
 * Cost of one call (or of an accumulated run) in USD, warning once when the
 * model has no price-table entry.
 *
 * Per-span enrichment uses `costUsd(costRatesFor(model), …)` instead: it runs on
 * every call, and an unpriced model would otherwise emit a log line per span.
 * The arithmetic is the same either way — only the unknown-model policy differs.
 */
export function computeCostUsd(
  model: string,
  usage: TokenUsage,
  writeTtl: CacheTtl = "5m",
): number {
  const entry = PRICE_TABLE[model];
  if (!entry) {
    fwLogger().warn(`[cost] Unknown model "${model}", returning cost 0`);
    return 0;
  }
  return costUsd(entry, usage, writeTtl);
}
