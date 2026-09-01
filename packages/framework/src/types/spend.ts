// spend — the framework's single vocabulary for what a run COSTS.
//
// Functional core: pure values and pure functions, no I/O, no clocks. Lives in
// `types/` for the same reason `token-usage.ts` does — `types/errors.ts` needs
// it, and `types/**` must not import from `llm/**`.
//
// WHY A SEPARATE VALUE FROM `TokenUsage`: they answer different questions and
// F4 made the difference load-bearing. `TokenUsage` says how many tokens
// crossed the wire; `Spend` says what they cost. Before prompt caching those
// were the same question up to a constant, so a token count was a serviceable
// budget ceiling. It no longer is: a cache read bills at 0.1x and a cache write
// at 1.25-2.0x (see `llm/cost.ts`), so two runs with identical `tokensIn` can
// differ by better than an order of magnitude in money. A budget denominated
// in tokens cannot see that difference; one denominated in `Spend` can.

import { match } from "ts-pattern";
import { sanitizeCount } from "./token-usage.js";

/**
 * A non-empty, canonically-ordered list of model names.
 *
 * Non-empty in the TYPE because every `unpriced` value exists precisely because
 * some model had no price — a zero-length list would be a value asserting
 * "unknown cost, caused by nothing". Canonically ordered (sorted, deduplicated)
 * so that `addSpend` is genuinely commutative under structural equality rather
 * than only up to a permutation.
 */
export type UnpricedModels = readonly [string, ...string[]];

/**
 * Integer micro-USD (1e-6 USD).
 *
 * Money is an integer here, not a float, because this figure is compared
 * against a ceiling after an unbounded number of additions. Float addition is
 * not associative, so a run's total would depend on the order its calls
 * settled — and two operators reconciling the same run against the same budget
 * could legitimately disagree. Integers make the comparison exact.
 *
 * Branded so it cannot be swapped with the raw-USD floats that `llm/cost.ts`
 * returns for display.
 */
export type MicroUsd = number & { readonly __brand: "MicroUsd" };

/** Zero, in micro-USD. */
export const NO_MICROS: MicroUsd = 0 as MicroUsd;

/**
 * Convert a raw USD float (what `costBreakdownUsd` produces) into the integer
 * domain, at the ONE boundary where money stops being a display figure and
 * starts being budget input.
 *
 * Non-finite and negative inputs read as zero, for the same reason
 * `sanitizeCount` clamps token counts: a `NaN` would propagate through every
 * later sum and `NaN >= limit` is false forever, which fails the budget OPEN.
 */
export const usdToMicros = (usd: number): MicroUsd =>
  Math.round(sanitizeCount(usd) * 1_000_000) as MicroUsd;

/** Back to a raw USD float. Display only — never a ceiling comparison. */
export const microsToUsd = (micros: MicroUsd): number => micros / 1_000_000;

/**
 * What a call (or a run of them) cost, when the cost is knowable.
 *
 * `PRICE_TABLE` is hand-maintained, so a model can be in use before it is
 * priced. A plain `number` cannot say "unknown", and the obvious default —
 * zero — makes an unpriced model FREE: it would consume no budget at all and a
 * run on it could never be refused. That is the exact fail-open shape the whole
 * budget exists to prevent, so "unknown" gets its own union member.
 *
 * `unpriced` is ABSORBING under `addSpend`: once any call in a run was
 * unpriced, no total for that run can be trusted again, and the type says so
 * rather than a comment saying so. `knownMicros` still carries the priced
 * portion as a genuine LOWER BOUND, which is what makes a refusal message
 * actionable ("at least $1.23, plus unpriced model X") instead of merely
 * unhelpful ("unknown").
 */
export type PricedSpend =
  | { readonly kind: "priced"; readonly micros: MicroUsd }
  | {
      readonly kind: "unpriced";
      /** Every model seen in this aggregate that had no price-table entry. */
      readonly models: UnpricedModels;
      /** Cost of the PRICED calls in this aggregate — a lower bound on the true total. */
      readonly knownMicros: MicroUsd;
    };

/**
 * What a run has consumed, across every axis a ceiling can be denominated in.
 *
 * The three axes are independent measurements of the same calls, not
 * components of one number: `tokens` answers "how much context did this move",
 * `calls` answers "how many round trips" (the cheap circuit-breaker for a tool
 * loop stuck retrying), and `usd` answers "what did it cost". A budget may
 * limit any subset of them.
 */
export type UsageKnowledge = "known" | "unknown";

export interface Spend {
  /**
   * Whether every settled attempt contributed trustworthy token usage.
   * `unknown` is absorbing: known figures remain lower bounds, but token and
   * USD ceilings can no longer be evaluated safely.
   */
  readonly usage: UsageKnowledge;
  /** Every trustworthy reported token, or a lower bound when usage is unknown. */
  readonly tokens: number;
  /** Delegated LLM attempts settled by the run authority, including failures. */
  readonly calls: number;
  readonly usd: PricedSpend;
}

/** The additive identity — a run that has consumed nothing. */
export const NO_SPEND: Spend = Object.freeze({
  usage: "known",
  tokens: 0,
  calls: 0,
  usd: Object.freeze({ kind: "priced", micros: NO_MICROS }),
} as const);

/**
 * Merge two canonically-ordered model lists into one.
 *
 * The `?? a[0]` fallback is unreachable — `sorted` is built from `a`, which the
 * type guarantees is non-empty — but it is how the non-emptiness is carried to
 * the compiler without a cast or a non-null assertion. Cheap, and the
 * alternative is an assertion that would be load-bearing for correctness.
 */
const unionModels = (a: UnpricedModels, b: UnpricedModels): UnpricedModels => {
  const sorted = [...new Set([...a, ...b])].sort();
  return [sorted[0] ?? a[0], ...sorted.slice(1)];
};

/**
 * The known-cost portion of either variant — the priced total, or the priced
 * lower bound an `unpriced` aggregate still carries.
 */
export const costFloor = (p: PricedSpend): MicroUsd =>
  p.kind === "priced" ? p.micros : p.knownMicros;

/**
 * Append on the cost axis. Not plain addition: `unpriced` ABSORBS, carrying the
 * union of the offending model names alongside the sum of whatever was priced.
 */
const addPriced = (a: PricedSpend, b: PricedSpend): PricedSpend => {
  const micros = (costFloor(a) + costFloor(b)) as MicroUsd;
  return match([a, b] as const)
    .returnType<PricedSpend>()
    .with([{ kind: "unpriced" }, { kind: "unpriced" }], ([x, y]) => ({
      kind: "unpriced",
      models: unionModels(x.models, y.models),
      knownMicros: micros,
    }))
    .with([{ kind: "unpriced" }, { kind: "priced" }], ([x]) => ({
      kind: "unpriced",
      models: x.models,
      knownMicros: micros,
    }))
    .with([{ kind: "priced" }, { kind: "unpriced" }], ([, y]) => ({
      kind: "unpriced",
      models: y.models,
      knownMicros: micros,
    }))
    .with([{ kind: "priced" }, { kind: "priced" }], () => ({ kind: "priced", micros }))
    .exhaustive();
};

/**
 * Monoid append over `NO_SPEND` — associative, commutative, with `NO_SPEND` as
 * identity. The host meter folds one of these per settled call to produce a
 * run's cumulative.
 */
export const addSpend = (a: Spend, b: Spend): Spend => ({
  usage: a.usage === "unknown" || b.usage === "unknown" ? "unknown" : "known",
  tokens: a.tokens + b.tokens,
  calls: a.calls + b.calls,
  usd: addPriced(a.usd, b.usd),
});

/**
 * A single call whose cost is known.
 *
 * Counts as one call: `calls` measures settled delegated attempts, and a `sendWithTools` loop
 * settles as ONE call for budget purposes (its turns are already folded into a
 * single `TokenUsage` by the loop) — the same granularity the overshoot-by-one
 * guarantee is stated at.
 */
export const pricedCall = (tokens: number, micros: MicroUsd): Spend => ({
  usage: "known",
  tokens: sanitizeCount(tokens),
  calls: 1,
  usd: { kind: "priced", micros },
});

/** A single call on a model with no price-table entry. */
export const unpricedCall = (tokens: number, model: string): Spend => ({
  usage: "known",
  tokens: sanitizeCount(tokens),
  calls: 1,
  usd: { kind: "unpriced", models: [model], knownMicros: NO_MICROS },
});

/**
 * One settled attempt whose provider usage cannot be trusted.
 * Known figures remain explicit lower bounds; admission decides which ceiling
 * axes can still be evaluated.
 */
export const unknownUsageCall = (usd: PricedSpend): Spend => ({
  usage: "unknown",
  tokens: 0,
  calls: 1,
  usd,
});

/**
 * `n` copies of one call's spend — the projection for `n` admitted-but-unsettled
 * concurrent calls, each estimated at the same per-call figure.
 *
 * `n <= 0` is `NO_SPEND` including on the cost axis: zero calls have no unknown
 * cost, so scaling an `unpriced` estimate by zero must yield a PRICED zero.
 * Returning `unpriced` there would project an unevaluable cost from no calls
 * at all and refuse a run that has nothing in flight.
 */
export const scaleSpend = (s: Spend, n: number): Spend => {
  const times = Math.max(0, Math.floor(sanitizeCount(n)));
  if (times === 0) return NO_SPEND;
  return {
    usage: s.usage,
    tokens: s.tokens * times,
    calls: s.calls * times,
    usd:
      s.usd.kind === "priced"
        ? { kind: "priced", micros: (s.usd.micros * times) as MicroUsd }
        : {
            kind: "unpriced",
            models: s.usd.models,
            knownMicros: (s.usd.knownMicros * times) as MicroUsd,
          },
  };
};

/**
 * Per-axis maximum — the learned per-call estimate, widened by each settled
 * call.
 *
 * `unpriced` wins on the cost axis for the same reason it absorbs in
 * `addSpend`: once a call of unknown cost has been seen, the estimate for the
 * next one cannot honestly be a number.
 */
export const maxSpend = (a: Spend, b: Spend): Spend => ({
  usage: a.usage === "unknown" || b.usage === "unknown" ? "unknown" : "known",
  tokens: Math.max(a.tokens, b.tokens),
  calls: Math.max(a.calls, b.calls),
  usd: match([a.usd, b.usd] as const)
    .returnType<PricedSpend>()
    .with([{ kind: "priced" }, { kind: "priced" }], ([x, y]) => ({
      kind: "priced",
      micros: Math.max(x.micros, y.micros) as MicroUsd,
    }))
    .with([{ kind: "unpriced" }, { kind: "unpriced" }], ([x, y]) => ({
      kind: "unpriced",
      models: unionModels(x.models, y.models),
      knownMicros: Math.max(x.knownMicros, y.knownMicros) as MicroUsd,
    }))
    .with([{ kind: "unpriced" }, { kind: "priced" }], ([x, y]) => ({
      kind: "unpriced",
      models: x.models,
      knownMicros: Math.max(x.knownMicros, y.micros) as MicroUsd,
    }))
    .with([{ kind: "priced" }, { kind: "unpriced" }], ([x, y]) => ({
      kind: "unpriced",
      models: y.models,
      knownMicros: Math.max(x.micros, y.knownMicros) as MicroUsd,
    }))
    .exhaustive(),
});
