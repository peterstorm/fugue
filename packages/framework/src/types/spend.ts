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
import { err, ok, type Result } from "./result.js";

/**
 * A non-empty, canonically-ordered list of model names.
 *
 * Non-empty in the TYPE because every `unpriced` value exists precisely because
 * some model had no price — a zero-length list would be a value asserting
 * "unknown cost, caused by nothing". Canonically ordered (sorted, deduplicated)
 * so that `addSpend` is genuinely commutative under structural equality rather
 * than only up to a permutation.
 */
declare const unpricedModelsBrand: unique symbol;

export type UnpricedModels = readonly [string, ...string[]] & {
  readonly [unpricedModelsBrand]: void;
};

const canonicalModelNames = (models: readonly string[]): UnpricedModels | undefined => {
  const sorted = [...new Set(models)].sort();
  const [head, ...tail] = sorted;
  return head === undefined
    ? undefined
    : ([head, ...tail] as unknown as UnpricedModels);
};

/** Canonical smart constructor. Empty input has no honest unpriced meaning. */
export const unpricedModels = (models: readonly string[]): UnpricedModels | undefined =>
  canonicalModelNames(models);

const UNKNOWN_UNPRICED_MODELS = ["<unknown>"] as unknown as UnpricedModels;

/** Canonical non-empty constructor for one offending model name. */
export const unpricedModel = (model: string): UnpricedModels =>
  canonicalModelNames([model]) ?? UNKNOWN_UNPRICED_MODELS;

/**
 * Integer micro-USD (1e-6 USD).
 *
 * Money is an integer here, not a float, so settlement order cannot introduce
 * floating-point drift. JavaScript's exact integer domain is bounded: every
 * constructor and aggregate operation therefore clamps to
 * `Number.MAX_SAFE_INTEGER`. Saturation is deliberately fail-closed — once the
 * representable maximum is reached, every valid USD ceiling is reached too.
 *
 * Branded so it cannot be swapped with the raw-USD floats that `llm/cost.ts`
 * returns for display.
 */
declare const microUsdBrand: unique symbol;
export type MicroUsd = number & { readonly [microUsdBrand]: void };

const toNonNegativeSafeInteger = (value: number): number => {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value));
};

const addSafeIntegers = (a: number, b: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, a + b);

const multiplySafeIntegers = (value: number, times: number): number => {
  if (value === 0 || times === 0) return 0;
  if (value > Number.MAX_SAFE_INTEGER / times) return Number.MAX_SAFE_INTEGER;
  return value * times;
};

/** Construct a non-negative safe-integer micro-USD amount. */
export const microUsd = (value: number): MicroUsd =>
  toNonNegativeSafeInteger(value) as MicroUsd;

/** Zero, in micro-USD. */
export const NO_MICROS: MicroUsd = microUsd(0);

/**
 * Convert a raw USD float (what `costBreakdownUsd` produces) into the integer
 * domain, at the ONE boundary where money stops being a display figure and
 * starts being budget input.
 *
 * `NaN`, zero, and negative inputs read as zero. Every positive amount rounds
 * UP so a billable call can never disappear at this precision; repeated
 * sub-micro-dollar calls therefore still consume the USD budget. Positive
 * overflow saturates fail-closed at the largest representable amount.
 */
export const usdToMicros = (usd: number): MicroUsd => {
  if (Number.isNaN(usd) || usd <= 0) return NO_MICROS;
  if (!Number.isFinite(usd)) return microUsd(Number.MAX_SAFE_INTEGER);
  const scaled = usd * 1_000_000;
  return Number.isFinite(scaled)
    ? microUsd(scaled)
    : microUsd(Number.MAX_SAFE_INTEGER);
};

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

export interface SpendInput {
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

declare const spendBrand: unique symbol;
export type Spend = SpendInput & { readonly [spendBrand]: void };

const normalizePricedSpend = (usd: PricedSpend): PricedSpend =>
  usd.kind === "priced"
    ? { kind: "priced", micros: microUsd(usd.micros) }
    : {
        kind: "unpriced",
        models: canonicalModelNames(usd.models) ?? UNKNOWN_UNPRICED_MODELS,
        knownMicros: microUsd(usd.knownMicros),
      };

/** Smart constructor for trusted domain inputs; every numeric axis is safe. */
export const makeSpend = (input: SpendInput): Spend => ({
  usage: input.usage,
  tokens: toNonNegativeSafeInteger(input.tokens),
  calls: toNonNegativeSafeInteger(input.calls),
  usd: normalizePricedSpend(input.usd),
}) as Spend;

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const ownValue = (value: object, key: PropertyKey): Result<unknown, string> => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value")
      ? ok(descriptor.value)
      : err(`Spend.${String(key)} must be an own data property`);
  } catch {
    return err(`Spend.${String(key)} could not be inspected`);
  }
};

const parseSafeInteger = (value: unknown, path: string): Result<number, string> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? ok(value)
    : err(`${path} must be a non-negative safe integer`);

const parseObject = (
  value: unknown,
  path: string,
): Result<Readonly<Record<PropertyKey, unknown>>, string> => {
  if (!isObjectLike(value)) return err(`${path} must be an object`);
  try {
    return Array.isArray(value)
      ? err(`${path} must be an object`)
      : ok(value);
  } catch {
    return err(`${path} could not be inspected`);
  }
};

const parseModelArray = (value: unknown): Result<readonly string[], string> => {
  try {
    if (!Array.isArray(value)) {
      return err("Spend.usd.models must be a non-empty string array");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      return err("Spend.usd.models.length must be an own data property");
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length <= 0) {
      return err("Spend.usd.models must be a non-empty string array");
    }
    const keys = Reflect.ownKeys(descriptors);
    const canonicalIndices = keys.every((key) => {
      if (key === "length") return true;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      return Number(key) < length;
    });
    if (keys.length !== length + 1 || !canonicalIndices) {
      return err("Spend.usd.models must be a dense own-data array");
    }
    const models: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) ||
          typeof descriptor.value !== "string") {
        return err("Spend.usd.models must be a non-empty string array");
      }
      models.push(descriptor.value);
    }
    return ok(models);
  } catch {
    return err("Spend.usd.models could not be inspected");
  }
};

/** Parse an adapter-supplied value before it enters budget arithmetic. */
export const parseSpend = (value: unknown): Result<Spend, string> => {
  const spend = parseObject(value, "Spend");
  if (!spend.ok) return spend;
  const usage = ownValue(spend.value, "usage");
  const tokens = ownValue(spend.value, "tokens");
  const calls = ownValue(spend.value, "calls");
  const usd = ownValue(spend.value, "usd");
  if (!usage.ok) return usage;
  if (usage.value !== "known" && usage.value !== "unknown") {
    return err("Spend.usage must be 'known' or 'unknown'");
  }
  if (!tokens.ok) return tokens;
  const parsedTokens = parseSafeInteger(tokens.value, "Spend.tokens");
  if (!parsedTokens.ok) return parsedTokens;
  if (!calls.ok) return calls;
  const parsedCalls = parseSafeInteger(calls.value, "Spend.calls");
  if (!parsedCalls.ok) return parsedCalls;
  if (!usd.ok) return usd;
  const usdObject = parseObject(usd.value, "Spend.usd");
  if (!usdObject.ok) return usdObject;
  const kind = ownValue(usdObject.value, "kind");
  if (!kind.ok) return kind;
  if (kind.value === "priced") {
    const micros = ownValue(usdObject.value, "micros");
    if (!micros.ok) return micros;
    const parsedMicros = parseSafeInteger(micros.value, "Spend.usd.micros");
    return parsedMicros.ok
      ? ok(makeSpend({
          usage: usage.value,
          tokens: parsedTokens.value,
          calls: parsedCalls.value,
          usd: { kind: "priced", micros: microUsd(parsedMicros.value) },
        }))
      : parsedMicros;
  }
  if (kind.value !== "unpriced") return err("Spend.usd.kind is invalid");
  const models = ownValue(usdObject.value, "models");
  const knownMicros = ownValue(usdObject.value, "knownMicros");
  if (!models.ok) return models;
  const rawModels = parseModelArray(models.value);
  if (!rawModels.ok) return rawModels;
  const canonical = canonicalModelNames(rawModels.value);
  if (canonical === undefined || canonical.length !== rawModels.value.length ||
      canonical.some((model, index) => model !== rawModels.value[index])) {
    return err("Spend.usd.models must be sorted and deduplicated");
  }
  if (!knownMicros.ok) return knownMicros;
  const parsedMicros = parseSafeInteger(knownMicros.value, "Spend.usd.knownMicros");
  return parsedMicros.ok
    ? ok(makeSpend({
        usage: usage.value,
        tokens: parsedTokens.value,
        calls: parsedCalls.value,
        usd: {
          kind: "unpriced",
          models: canonical,
          knownMicros: microUsd(parsedMicros.value),
        },
      }))
    : parsedMicros;
};

/** The additive identity — a run that has consumed nothing. */
export const NO_SPEND: Spend = Object.freeze(makeSpend({
  usage: "known",
  tokens: 0,
  calls: 0,
  usd: Object.freeze({ kind: "priced", micros: NO_MICROS }),
}));

/**
 * Merge two canonically-ordered model lists into one.
 *
 * The `?? a[0]` fallback is unreachable — `sorted` is built from `a`, which the
 * type guarantees is non-empty — but it is how the non-emptiness is carried to
 * the compiler without a cast or a non-null assertion. Cheap, and the
 * alternative is an assertion that would be load-bearing for correctness.
 */
const unionModels = (a: UnpricedModels, b: UnpricedModels): UnpricedModels =>
  canonicalModelNames([...a, ...b]) ?? a;

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
  const micros = microUsd(addSafeIntegers(costFloor(a), costFloor(b)));
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
export const addSpend = (a: Spend, b: Spend): Spend => makeSpend({
  usage: a.usage === "unknown" || b.usage === "unknown" ? "unknown" : "known",
  tokens: addSafeIntegers(a.tokens, b.tokens),
  calls: addSafeIntegers(a.calls, b.calls),
  usd: addPriced(a.usd, b.usd),
});

/**
 * A single call whose cost is known.
 *
 * Counts as one call: `calls` measures settled delegated attempts, and a `sendWithTools` loop
 * settles as ONE call for budget purposes (its turns are already folded into a
 * single `TokenUsage` by the loop) — the same granularity as the sequential
 * overshoot-by-one behavior.
 */
export const pricedCall = (tokens: number, micros: MicroUsd): Spend => makeSpend({
  usage: "known",
  tokens,
  calls: 1,
  usd: { kind: "priced", micros },
});

/** A single call on a model with no price-table entry. */
export const unpricedCall = (tokens: number, model: string): Spend => makeSpend({
  usage: "known",
  tokens,
  calls: 1,
  usd: {
    kind: "unpriced",
    models: unpricedModel(model),
    knownMicros: NO_MICROS,
  },
});

/**
 * One settled attempt whose provider usage cannot be trusted.
 * Known figures remain explicit lower bounds; admission decides which ceiling
 * axes can still be evaluated.
 */
export const unknownUsageCall = (usd: PricedSpend): Spend => makeSpend({
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
  const times = toNonNegativeSafeInteger(n);
  if (times === 0) return NO_SPEND;
  return makeSpend({
    usage: s.usage,
    tokens: multiplySafeIntegers(s.tokens, times),
    calls: multiplySafeIntegers(s.calls, times),
    usd:
      s.usd.kind === "priced"
        ? { kind: "priced", micros: microUsd(multiplySafeIntegers(s.usd.micros, times)) }
        : {
            kind: "unpriced",
            models: s.usd.models,
            knownMicros: microUsd(multiplySafeIntegers(s.usd.knownMicros, times)),
          },
  });
};

/**
 * Per-axis maximum — the learned per-call estimate, widened by each settled
 * call.
 *
 * `unpriced` wins on the cost axis for the same reason it absorbs in
 * `addSpend`: once a call of unknown cost has been seen, the estimate for the
 * next one cannot honestly be a number.
 */
export const maxSpend = (a: Spend, b: Spend): Spend => makeSpend({
  usage: a.usage === "unknown" || b.usage === "unknown" ? "unknown" : "known",
  tokens: Math.max(a.tokens, b.tokens),
  calls: Math.max(a.calls, b.calls),
  usd: match([a.usd, b.usd] as const)
    .returnType<PricedSpend>()
    .with([{ kind: "priced" }, { kind: "priced" }], ([x, y]) => ({
      kind: "priced",
      micros: microUsd(Math.max(x.micros, y.micros)),
    }))
    .with([{ kind: "unpriced" }, { kind: "unpriced" }], ([x, y]) => ({
      kind: "unpriced",
      models: unionModels(x.models, y.models),
      knownMicros: microUsd(Math.max(x.knownMicros, y.knownMicros)),
    }))
    .with([{ kind: "unpriced" }, { kind: "priced" }], ([x, y]) => ({
      kind: "unpriced",
      models: x.models,
      knownMicros: microUsd(Math.max(x.knownMicros, y.micros)),
    }))
    .with([{ kind: "priced" }, { kind: "unpriced" }], ([x, y]) => ({
      kind: "unpriced",
      models: y.models,
      knownMicros: microUsd(Math.max(x.micros, y.knownMicros)),
    }))
    .exhaustive(),
});
