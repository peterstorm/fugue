// budget — what limits a run's `Spend`, and what it means to have reached it.
//
// Functional core: pure values and pure decisions, no I/O. The host's meter
// holds the running `Spend` and asks the questions here; this module never sees
// a run, a clock, or a provider.
//
// The split from `spend.ts` is deliberate and one-directional: `Spend` is the
// measurement, `Ceiling` is the limit on it. Budgets import spend; spend knows
// nothing about budgets, so the value type stays usable for pure reporting.

import { match, P } from "ts-pattern";
import type { MicroUsd, Spend, UnpricedModels } from "./spend.js";
import { microsToUsd } from "./spend.js";
import { sanitizeCount } from "./token-usage.js";

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/** Limit on every token that crosses the wire, in either direction. */
export interface TokensCeiling {
  readonly kind: "tokens";
  readonly limit: number;
}

/**
 * Limit on settled provider calls.
 *
 * The cheapest available circuit-breaker for retry amplification: a tool that
 * always errors burns turns until its iteration cap, and a call ceiling catches
 * that immediately where a token ceiling only catches it expensively.
 */
export interface CallsCeiling {
  readonly kind: "calls";
  readonly limit: number;
}

/** Limit on money. The only ceiling that means what an operator actually meant. */
export interface UsdCeiling {
  readonly kind: "usd";
  readonly limit: MicroUsd;
}

export type Ceiling = TokensCeiling | CallsCeiling | UsdCeiling;

export type CeilingKind = Ceiling["kind"];

/**
 * A run's declared limits: non-empty, at most one per kind, canonically ordered.
 *
 * All three properties are established by the `ceilings` smart constructor and
 * relied upon downstream, so this type is only ever produced there.
 *
 * - **Non-empty** because "a budget that limits nothing" and "no budget" are the
 *   same fact, and one fact deserves one spelling. The second spelling is
 *   `undefined`, which is what the pre-existing absent-budget contract already
 *   used (FR-W1-006).
 * - **At most one per kind** because two token ceilings would raise "which one
 *   applies?", a question with no good answer at the point of refusal.
 * - **Canonically ordered** so the ceiling reported in a refusal is stable
 *   across restarts, rather than reflecting the order a config file happened to
 *   list them in.
 *
 * BRANDED so those properties are enforced by the compiler rather than by
 * convention. Without the brand this is a plain structural tuple: any module
 * could assign an array literal carrying two `tokens` entries, an unsanitized
 * limit, or the wrong order, and `firstBreach` would faithfully evaluate it.
 * The brand makes `ceilings()` the only way to obtain the type, which is the
 * same technique `MicroUsd` and the branded identifiers already use here.
 */
export type Ceilings = readonly [Ceiling, ...Ceiling[]] & {
  readonly __brand: "Ceilings";
};

/**
 * Report order when several ceilings are breached at once.
 *
 * `usd` leads deliberately: the usd branch is the only one that can fail for a
 * reason the operator must go and FIX (an unpriced model), rather than for the
 * reason budgets exist. Surfacing it first is what gets it fixed.
 */
const KIND_ORDER: readonly CeilingKind[] = ["usd", "tokens", "calls"];

const limitOf = (c: Ceiling): number => c.limit;

const withLimit = (c: Ceiling, limit: number): Ceiling =>
  match(c)
    .returnType<Ceiling>()
    .with({ kind: "usd" }, () => ({ kind: "usd", limit: limit as MicroUsd }))
    .with({ kind: "tokens" }, () => ({ kind: "tokens", limit }))
    .with({ kind: "calls" }, () => ({ kind: "calls", limit }))
    .exhaustive();

/**
 * THE constructor for `Ceilings` — establishes non-emptiness, one-per-kind, and
 * canonical order, and returns `undefined` for "no limits at all".
 *
 * Duplicate kinds collapse to their MINIMUM, which is what makes this the same
 * operation as narrowing: composing a DAG's ceilings with a caller-supplied set
 * is `ceilings([...dagCeilings, ...requestCeilings])`. A request can therefore
 * only ever tighten a limit, never relax one, because taking a minimum has no
 * way to express "raise it" — the deny-by-default rule is a consequence of the
 * data structure rather than a check somebody has to remember to write.
 */
export const ceilings = (declared: readonly Ceiling[]): Ceilings | undefined => {
  const tightest = new Map<CeilingKind, Ceiling>();
  for (const raw of declared) {
    // A limit is sanitized exactly like a token count, and for the same reason:
    // a non-finite limit would make `observed >= limit` false forever, failing
    // the budget OPEN. Clamping to zero fails it CLOSED — a malformed ceiling
    // grants nothing, which is the safe reading of "we could not understand
    // your limit". A legitimately non-positive limit already meant this, so no
    // honest configuration changes behaviour.
    const c = withLimit(raw, sanitizeCount(raw.limit));
    const seen = tightest.get(c.kind);
    if (seen === undefined || limitOf(c) < limitOf(seen)) tightest.set(c.kind, c);
  }
  const ordered = KIND_ORDER.flatMap((kind) => {
    const c = tightest.get(kind);
    return c === undefined ? [] : [c];
  });
  const [head, ...rest] = ordered;
  // The one cast that mints the brand — every invariant above was just
  // established, which is precisely what the brand attests to.
  return head === undefined ? undefined : ([head, ...rest] as unknown as Ceilings);
};

// ---------------------------------------------------------------------------
// Breaches
// ---------------------------------------------------------------------------

/**
 * WHICH spend figure drove a refusal.
 *
 * `settled` is spend the provider has already reported. `projected` is settled
 * spend plus the reservation held for admitted-but-unsettled concurrent calls —
 * the estimate that bounds concurrent overshoot.
 *
 * This exists because the two were previously indistinguishable at the point of
 * refusal: a single `cumulative` field carried the settled figure while the
 * decision might have been driven by the projection, and only a comment
 * reconciled them. Making the caller pass the basis it evaluated means the
 * answer is correct by construction — `breachOf` is told which spend it was
 * handed and cannot infer it wrongly.
 */
export type Basis = "settled" | "projected";

/**
 * Why a run may not make another call.
 *
 * `unpriced` is a distinct member rather than a `reached` with a missing
 * figure: the operator response differs completely. `reached` means the budget
 * did its job; `unpriced` means the budget could not be evaluated because a
 * model in use has no price-table entry, and the fix is to add one.
 */
export type Breach =
  | {
      readonly kind: "reached";
      readonly ceiling: Ceiling;
      readonly basis: Basis;
      /** The figure compared, in the ceiling's own unit. */
      readonly observed: number;
    }
  | {
      readonly kind: "unpriced";
      readonly ceiling: UsdCeiling;
      readonly basis: Basis;
      /** Models in use with no price-table entry. */
      readonly models: UnpricedModels;
      /** Cost of the calls that WERE priced — a genuine lower bound. */
      readonly observedAtLeast: MicroUsd;
    };

/**
 * Compare one observed figure against one limit — refusing if EITHER side is
 * non-finite.
 *
 * Both guards are fail-closed and both are load-bearing, for the same reason
 * from opposite directions: `observed >= limit` is false whenever either
 * operand is `NaN`, so a single poisoned figure would make this ceiling never
 * refuse again. `ceilings` already sanitizes limits and `Spend` is built from
 * sanitized components, but `Ceiling` is a plain structural type — nothing
 * stops a caller (or a wire record) from presenting one that never passed
 * through the smart constructor, and a budget is the wrong place to assume
 * good faith.
 */
const reachedBy = (observed: number, limit: number): boolean =>
  !Number.isFinite(observed) || !Number.isFinite(limit) || observed >= limit;

/**
 * Whether `spend` has reached `ceiling`, and if so, why.
 *
 * A `usd` ceiling against unpriced spend ALWAYS breaches. This is the
 * fail-closed rule: an unpriced model has an unknown cost, an unknown cost
 * cannot be shown to be under a limit, and treating it as zero would make the
 * cheapest way past a dollar budget "use a model we forgot to price".
 */
export const breachOf = (spend: Spend, ceiling: Ceiling, basis: Basis): Breach | undefined =>
  match(ceiling)
    .returnType<Breach | undefined>()
    .with({ kind: "tokens" }, (c) =>
      reachedBy(spend.tokens, c.limit)
        ? { kind: "reached", ceiling: c, basis, observed: spend.tokens }
        : undefined,
    )
    .with({ kind: "calls" }, (c) =>
      reachedBy(spend.calls, c.limit)
        ? { kind: "reached", ceiling: c, basis, observed: spend.calls }
        : undefined,
    )
    .with({ kind: "usd" }, (c) =>
      match(spend.usd)
        .returnType<Breach | undefined>()
        .with({ kind: "unpriced" }, (u) => ({
          kind: "unpriced",
          ceiling: c,
          basis,
          models: u.models,
          observedAtLeast: u.knownMicros,
        }))
        .with({ kind: "priced" }, (p) =>
          reachedBy(p.micros, c.limit)
            ? { kind: "reached", ceiling: c, basis, observed: p.micros }
            : undefined,
        )
        .exhaustive(),
    )
    .exhaustive();

/**
 * The first breach among a run's ceilings, in canonical order — or `undefined`
 * when the run is within every one of them.
 *
 * A run is over budget when ANY ceiling is reached; the ceilings are
 * independent limits on the same calls, not components of one limit.
 */
export const firstBreach = (
  spend: Spend,
  limits: Ceilings,
  basis: Basis,
): Breach | undefined => {
  for (const ceiling of limits) {
    const breach = breachOf(spend, ceiling, basis);
    if (breach !== undefined) return breach;
  }
  return undefined;
};

/** Micro-USD rendered as dollars, for human-facing text only. */
const dollars = (micros: number): string => `$${microsToUsd(micros as MicroUsd).toFixed(6)}`;

/** Human-readable one-liner for a breach — for logs and error messages. */
export const formatBreach = (b: Breach): string =>
  match(b)
    .with({ kind: "reached", ceiling: { kind: "usd" } }, (x) =>
      `${x.basis} spend ${dollars(x.observed)} reached the ${dollars(x.ceiling.limit)} budget`,
    )
    .with({ kind: "reached", ceiling: { kind: P.union("tokens", "calls") } }, (x) =>
      `${x.basis} ${x.ceiling.kind} ${x.observed} reached the ${x.ceiling.limit} budget`,
    )
    .with({ kind: "unpriced" }, (x) =>
      `cost cannot be evaluated against a ${dollars(x.ceiling.limit)} budget: ` +
      `no price-table entry for ${x.models.join(", ")} ` +
      `(priced calls so far: ${dollars(x.observedAtLeast)})`,
    )
    .exhaustive();

/**
 * The figure a breach compared, as a plain number in the ceiling's unit.
 *
 * Both members carry an observation, but under different names because they
 * mean different things (`observed` is exact; `observedAtLeast` is a lower
 * bound). Consumers that only need "the number" — a log line, a persisted
 * error — read it here rather than re-matching and risking one of the two
 * being forgotten.
 */
export const observedOf = (b: Breach): number =>
  b.kind === "reached" ? b.observed : b.observedAtLeast;
