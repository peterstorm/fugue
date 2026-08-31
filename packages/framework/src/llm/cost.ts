import { fwLogger } from "../logger.js";
import type { CacheTtl } from "../types/llm.js";
import type { Spend } from "../types/spend.js";
import { pricedCall, unpricedCall, usdToMicros } from "../types/spend.js";
import type { TokenUsage } from "../types/token-usage.js";
import { totalTokens, uncachedInputTokens } from "../types/token-usage.js";

/** Per-million-token rates for one model. */
export interface CostRates {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

const rates = (inputPer1M: number, outputPer1M: number): Readonly<CostRates> =>
  Object.freeze({ inputPer1M, outputPer1M });

/**
 * Framework pricing authority. Both admission and settlement read this exact,
 * deeply frozen object; tenant/DAG code cannot mutate first-call pricing.
 */
export const PRICE_TABLE: Readonly<Record<string, Readonly<CostRates>>> = Object.freeze({
  // Anthropic
  "claude-sonnet-4-20250514": rates(3.0, 15.0),
  "claude-haiku-4-20250514": rates(0.8, 4.0),
  "claude-3-5-sonnet-20241022": rates(3.0, 15.0),
  "claude-3-5-haiku-20241022": rates(0.8, 4.0),
  "claude-3-opus-20240229": rates(15.0, 75.0),
  "claude-3-sonnet-20240229": rates(3.0, 15.0),
  "claude-3-haiku-20240307": rates(0.25, 1.25),
  // OpenAI
  "gpt-4o": rates(2.5, 10.0),
  "gpt-4o-mini": rates(0.15, 0.6),
  "gpt-4o-2024-11-20": rates(2.5, 10.0),
  "gpt-4-turbo": rates(10.0, 30.0),
  "o3-mini": rates(1.1, 4.4),
  "o4-mini": rates(1.1, 4.4),
  "gpt-5-mini": rates(0.3, 1.25),
});

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
 * The TTL a cache write is billed at when a caller does not name one.
 *
 * Exported and referenced rather than re-typed at each default: the same
 * literal previously appeared as five independent `"5m"`s across this module
 * and the host's metered decorator, held in sync only by a comment saying so.
 * A domain default reachable from two packages is exactly the kind of constant
 * that drifts when one of its copies is edited.
 */
export const DEFAULT_CACHE_TTL: CacheTtl = "5m";

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
  writeTtl: CacheTtl = DEFAULT_CACHE_TTL,
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

/** The total from {@link costBreakdownUsd}, for callers that need only the figure. */
export const costUsd = (
  rates: CostRates,
  usage: TokenUsage,
  writeTtl: CacheTtl = DEFAULT_CACHE_TTL,
): number => costBreakdownUsd(rates, usage, writeTtl).total;

/**
 * One settled call, measured on every axis a budget can limit — the bridge from
 * "how many tokens" to "what did it cost".
 *
 * This is the ONLY producer of budget-facing cost, so the cache multipliers
 * above reach the budget through exactly one path and cannot be reimplemented
 * slightly differently by a second caller.
 *
 * Unlike `computeCostUsd`, an unknown model does NOT log and does NOT return
 * zero. It returns an `unpriced` spend, which carries the model name to
 * whoever refuses the run. That is strictly better on both counts: this runs on
 * every call (so a warn would be one line per call), and a zero would make an
 * unpriced model free — the cheapest possible way past a dollar budget.
 *
 * `calls` is 1 for a `sendWithTools` loop as much as for a single-shot call: a
 * loop's turns are already folded into one `TokenUsage` before it settles, and
 * one settled call is the granularity the overshoot-by-one guarantee is stated
 * at.
 */
export const spendOfCall = (
  model: string,
  usage: TokenUsage,
  writeTtl: CacheTtl = DEFAULT_CACHE_TTL,
): Spend => {
  const tokens = totalTokens(usage);
  const rates = PRICE_TABLE[model];
  if (rates === undefined) return unpricedCall(tokens, model);
  const usd = costUsd(rates, usage, writeTtl);
  // A non-finite figure here means the usage was self-inconsistent — a provider
  // (or a fixture) that omitted one of the four fields, so a subtraction inside
  // `costBreakdownUsd` produced NaN. Handing that to `usdToMicros` sanitizes it
  // to ZERO, and zero on the cost axis means FREE: the call would consume no
  // dollar budget at all and could never be refused. `unpriced` is the honest
  // answer to "we could not compute a cost", and the one that fails closed.
  return Number.isFinite(usd)
    ? pricedCall(tokens, usdToMicros(usd))
    : unpricedCall(tokens, model);
};

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
  writeTtl: CacheTtl = DEFAULT_CACHE_TTL,
): number {
  const entry = PRICE_TABLE[model];
  if (!entry) {
    fwLogger().warn(`[cost] Unknown model "${model}", returning cost 0`);
    return 0;
  }
  return costUsd(entry, usage, writeTtl);
}
