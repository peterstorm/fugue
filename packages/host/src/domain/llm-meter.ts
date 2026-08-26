/**
 * Pure LLM usage meter — per-`runId` token counter + budget decision.
 *
 * Functional core: no I/O, no clocks, no network. Every operation is a pure
 * function over an immutable `LlmMeter` value. The metered-llm adapter (the
 * imperative shell) holds the live meter and threads it through these
 * functions; this module never touches the wire.
 *
 * @satisfies FR-W0-004 — aggregate tokensIn/tokensOut per (dagId,runId,nodeId)
 * @satisfies FR-W1-002 — pre-call comparison of cumulative tokens vs budget
 * @satisfies FR-W1-004 — overshoot-by-one rule (check is BEFORE the call)
 * @satisfies FR-W1-005 — in-memory counter, no network
 * @satisfies FR-W1-006 — absent budget never refuses
 * @satisfies SC-003 — at most one call allowed past budget B
 */

import { match } from "ts-pattern";
import type { RunId, TokenUsage } from "@fuguejs/framework";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Token usage aggregated for a single run. Stores only the two independent
 * breakdown figures (FR-W0-004); the cumulative `total` is DERIVED via
 * `runTotal(u)`, never stored. Storing `total` independently would make a
 * `total !== tokensIn + tokensOut` value representable — an illegal state that
 * feeds the budget check directly. Dropping the field makes it unrepresentable.
 */
interface RunUsage {
  /**
   * ALL prompt tokens — uncached, cache-write and cache-read — as normalised by
   * the framework's provider clients. This is what keeps the budget honest once
   * a DAG enables prompt caching: Anthropic reports `input_tokens` as the
   * UNCACHED REMAINDER, so a meter that stored the provider's raw figure would
   * silently shrink a cached run's total and let it overrun its budget.
   */
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Prompt tokens this run wrote to a provider-side cache entry. */
  readonly cacheWriteTokens: number;
  /** Prompt tokens this run served from a provider-side cache entry. */
  readonly cacheReadTokens: number;
}

/**
 * The cumulative token figure the budget check consults — derived, never
 * stored, so it cannot disagree with the breakdown (`tokensIn + tokensOut`).
 */
export const runTotal = (u: RunUsage): number => u.tokensIn + u.tokensOut;


/**
 * Immutable per-`runId` token counter. The map is treated as frozen — every
 * mutation produces a new `LlmMeter` via `accumulate`. An absent `runId` means
 * zero usage (no entry is materialised until the first `accumulate`).
 */
export interface LlmMeter {
  readonly usageByRun: ReadonlyMap<RunId, RunUsage>;
}

/**
 * A single LLM call's token delta — structurally the framework's `TokenUsage`,
 * so an `LlmResponse` (or an error's partial usage) can be handed over whole.
 */
interface TokenDelta {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * Compile-time proof that `TokenDelta` and the framework's `TokenUsage` are the
 * same shape in BOTH directions.
 *
 * The host declares its own delta type so this pure domain module owns its
 * vocabulary rather than importing the framework's at the FC/IS boundary — but
 * structural typing means a field ADDED to `TokenUsage` would otherwise be
 * silently dropped here (excess-property checking does not fire on a value
 * passed by variable), which is exactly the "silently forgotten field" failure
 * the shared value type exists to prevent. `TokenUsage` has already grown once.
 * This makes the next growth a build error instead of a lost figure.
 */
type _TokenDeltaMatchesFrameworkUsage = [TokenDelta] extends [TokenUsage]
  ? [TokenUsage] extends [TokenDelta]
    ? true
    : never
  : never;
const _tokenDeltaShapeProof: _TokenDeltaMatchesFrameworkUsage = true;
void _tokenDeltaShapeProof;

/**
 * Outcome of a pre-call budget check — discriminated union so an `allow` can
 * never carry a refusal payload and vice-versa (illegal states unrepresentable).
 *
 * `cumulative` on both branches is the run's total-so-far at decision time
 * (before the in-flight call). `budget` is only meaningful on `refuse`.
 */
type BudgetDecision =
  | { readonly kind: "allow"; readonly cumulative: number }
  | { readonly kind: "refuse"; readonly cumulative: number; readonly budget: number };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const ZERO_USAGE: RunUsage = Object.freeze({
  tokensIn: 0,
  tokensOut: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
});

/** Runtime-read-only snapshot; no mutable `Map` methods escape the ADT. */
const meterOf = (entries: ReadonlyMap<RunId, RunUsage>): LlmMeter => {
  const snapshot = new Map(
    Array.from(entries, ([runId, usage]) => [runId, Object.freeze({ ...usage })] as const),
  );
  let view: ReadonlyMap<RunId, RunUsage>;
  const facade = {
    get size(): number { return snapshot.size; },
    get: (runId: RunId): RunUsage | undefined => snapshot.get(runId),
    has: (runId: RunId): boolean => snapshot.has(runId),
    entries: (): MapIterator<[RunId, RunUsage]> => snapshot.entries(),
    keys: (): MapIterator<RunId> => snapshot.keys(),
    values: (): MapIterator<RunUsage> => snapshot.values(),
    [Symbol.iterator]: (): MapIterator<[RunId, RunUsage]> => snapshot[Symbol.iterator](),
    forEach(
      callback: (usage: RunUsage, runId: RunId, map: ReadonlyMap<RunId, RunUsage>) => void,
      thisArg?: unknown,
    ): void {
      for (const [runId, usage] of snapshot) callback.call(thisArg, usage, runId, view);
    },
  } satisfies ReadonlyMap<RunId, RunUsage>;
  view = Object.freeze(facade);
  return Object.freeze({ usageByRun: view });
};

/** The empty meter — no runs have consumed any tokens yet. */
export const emptyMeter = (): LlmMeter => meterOf(new Map());

// ---------------------------------------------------------------------------
// Queries (pure)
// ---------------------------------------------------------------------------

/**
 * Usage aggregated for a run. An unmetered run reads as all-zero rather than
 * `undefined` — the budget check and callers treat "never seen" and "seen,
 * zero tokens" identically (FR-W1-002).
 */
export const usageFor = (meter: LlmMeter, runId: RunId): RunUsage =>
  meter.usageByRun.get(runId) ?? ZERO_USAGE;

// ---------------------------------------------------------------------------
// Transitions (pure)
// ---------------------------------------------------------------------------

/**
 * A delta component a provider may only ADD with: non-finite (NaN/±Infinity)
 * and negative figures both read as 0. Negative would be a budget refund;
 * non-finite would POISON the cumulative (`NaN` propagates through every later
 * sum and `NaN >= budget` is false — the budget would fail OPEN permanently).
 * Both are upstream-contract breaches (a missing/malformed provider `usage`
 * field), treated as "no attributable tokens", never as arithmetic input.
 */
const sanitizeDeltaComponent = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, n) : 0;

/**
 * Add a single call's token delta to a run's running total, returning a NEW
 * meter. The input meter is never mutated. Negative deltas are clamped to zero
 * — a provider can only ever add usage, never subtract it, so a negative figure
 * is treated as an absent/malformed count rather than a budget refund. Non-
 * finite deltas read as zero for the same reason (see `sanitizeDeltaComponent`).
 *
 * @satisfies FR-W0-004
 */
export const accumulate = (meter: LlmMeter, runId: RunId, delta: TokenDelta): LlmMeter => {
  const prev = usageFor(meter, runId);
  const addIn = sanitizeDeltaComponent(delta.tokensIn);
  const addOut = sanitizeDeltaComponent(delta.tokensOut);
  // The cache figures are a BREAKDOWN of `tokensIn`, not an addition to it, so
  // they are sanitized the same way but never widen the budget total.
  const addCacheWrite = sanitizeDeltaComponent(delta.cacheWriteTokens);
  const addCacheRead = sanitizeDeltaComponent(delta.cacheReadTokens);
  const next: RunUsage = {
    tokensIn: prev.tokensIn + addIn,
    tokensOut: prev.tokensOut + addOut,
    cacheWriteTokens: prev.cacheWriteTokens + addCacheWrite,
    cacheReadTokens: prev.cacheReadTokens + addCacheRead,
  };
  const usageByRun = new Map(meter.usageByRun);
  usageByRun.set(runId, next);
  return meterOf(usageByRun);
};

/**
 * Decide whether the NEXT call for `runId` is allowed under `budget`.
 *
 * The comparison is BEFORE the call, against cumulative-so-far (FR-W1-002).
 * The overshoot-by-one rule (FR-W1-004) falls out of this directly: while
 * `cumulative < budget` every call is allowed (so the call that crosses the
 * boundary — the single overshoot — runs), and only once `cumulative >= budget`
 * is the next call refused. With B = budget this caps calls-past-B at one
 * (SC-003).
 *
 * An absent (`undefined`) budget always allows — FR-W1-006: no budget means no
 * enforcement. A non-positive budget refuses the first call (a zero/negative
 * budget grants nothing).
 *
 * Fail closed on a non-finite cumulative: `accumulate` sanitizes its inputs so
 * the stored figures stay finite, but if a non-finite value ever reaches this
 * check anyway (defense in depth — same class as the non-finite-`now` guard in
 * jwt-validation), a budgeted run REFUSES rather than letting `NaN >= budget`
 * read as false forever (fail open).
 *
 * @satisfies FR-W1-002 FR-W1-004 FR-W1-006 SC-003
 */
export const budgetDecision = (
  meter: LlmMeter,
  runId: RunId,
  budget?: number,
): BudgetDecision => {
  const cumulative = runTotal(usageFor(meter, runId));
  if (budget === undefined) return { kind: "allow", cumulative };
  if (!Number.isFinite(cumulative)) return { kind: "refuse", cumulative, budget };
  return cumulative >= budget
    ? { kind: "refuse", cumulative, budget }
    : { kind: "allow", cumulative };
};

/** Human-readable summary of a budget decision — for structured logging. */
export const formatBudgetDecision = (d: BudgetDecision): string =>
  match(d)
    .with({ kind: "allow" }, (d) => `allow (cumulative ${d.cumulative})`)
    .with({ kind: "refuse" }, (d) => `refuse (cumulative ${d.cumulative} >= budget ${d.budget})`)
    .exhaustive();

// ---------------------------------------------------------------------------
// Concurrency reservation (pure) — the SC-003 bound under parallel calls
// ---------------------------------------------------------------------------

/**
 * Reservation accounting for admitted-but-unsettled calls (review I1 / SC-003).
 *
 * `budgetDecision` refuses only once cumulative ≥ budget, but cumulative
 * updates AFTER a call settles — so N calls fired in parallel all read the same
 * pre-settle cumulative, all pass the gate, and overshoot by N rather than one.
 * Treating ADMITTED-but-unsettled calls as already-spending closes that:
 * `maxObservedCall` is the learned per-call estimate (the largest single call
 * seen so far), `reservedInFlight` the sum of estimates currently reserved.
 * Steady-state overshoot is bounded to ~one call; the very first parallel burst
 * (estimate still 0) can overshoot by its call count — the documented FR-W1-004
 * allowance, generalised.
 *
 * Pure value + pure transitions: the metered-llm shell holds one mutable cell
 * and threads it through `admitWithReservation` / `releaseReservation` /
 * `learnObservedCall`, the same shape as the broker's cells over `token-cache`.
 */
export interface ReservationState {
  readonly reservedInFlight: number;
  readonly maxObservedCall: number;
}

/** No calls admitted, no per-call estimate learned yet. */
export const emptyReservation: ReservationState = { reservedInFlight: 0, maxObservedCall: 0 };

/**
 * Outcome of the reservation-aware pre-call gate. An `admit` carries the next
 * reservation state AND the exact amount reserved (so the matching release
 * frees precisely that, even if the estimate has since grown); a `refuse`
 * carries the figures the shell logs. Illegal blends unrepresentable.
 */
type AdmitDecision =
  | { readonly kind: "admit"; readonly state: ReservationState; readonly reserved: number }
  | {
      readonly kind: "refuse";
      /** SETTLED cumulative at decision time (the `llm-budget-exceeded` contract). */
      readonly cumulative: number;
      /** Reservation that contributed to the projection — log-only, never on the error. */
      readonly reservedInFlight: number;
      readonly budget: number;
    };

/**
 * Reservation-aware budget gate: refuse when the settled cumulative has reached
 * `budget` (`budgetDecision`), or when cumulative plus the in-flight reservation
 * projects past it. On admit, reserve the learned per-call estimate.
 *
 * @satisfies FR-W1-004 SC-003 (the concurrency-bounded overshoot)
 */
export const admitWithReservation = (
  meter: LlmMeter,
  runId: RunId,
  state: ReservationState,
  budget?: number,
): AdmitDecision => {
  const decision = budgetDecision(meter, runId, budget);
  const projected = decision.cumulative + state.reservedInFlight;
  // The exceeded budget, when over: a `refuse` decision carries it; otherwise
  // the projection is over only when a budget was supplied. Reading it off the
  // branches keeps this cast-free — `undefined` means "admit". Not `??`: a
  // `refuse` decision's own budget stands even if it were undefined.
  const projectedOverBudget = budget !== undefined && projected >= budget ? budget : undefined;
  const exceededBudget = decision.kind === "refuse" ? decision.budget : projectedOverBudget;
  if (exceededBudget !== undefined) {
    return {
      kind: "refuse",
      cumulative: decision.cumulative,
      reservedInFlight: state.reservedInFlight,
      budget: exceededBudget,
    };
  }
  const reserved = state.maxObservedCall;
  return {
    kind: "admit",
    reserved,
    state: { ...state, reservedInFlight: state.reservedInFlight + reserved },
  };
};

/**
 * Free exactly the amount a matching `admit` reserved (call once, on settle).
 * Clamped at 0 — `reservedInFlight` is a sum of admitted reservations, so a
 * negative value is only reachable via a contract breach (double release);
 * clamping keeps the projection gate sane rather than letting a negative
 * reservation grant free budget headroom.
 */
export const releaseReservation = (state: ReservationState, reserved: number): ReservationState => ({
  ...state,
  reservedInFlight: Math.max(0, state.reservedInFlight - reserved),
});

/**
 * Learn the per-call estimate from a settled call's total (monotone max).
 *
 * `callTotal` is provider-sourced (the shell feeds it the RAW response's
 * `tokensIn + tokensOut`), so it gets the same sanitization as `accumulate`'s
 * deltas: one NaN figure would otherwise make `maxObservedCall` — and every
 * subsequent `reservedInFlight` sum — permanently NaN, silently disabling the
 * SC-003 reservation gate (`projected >= budget` reads false forever: the
 * exact fail-open poison `sanitizeDeltaComponent` exists to prevent).
 */
export const learnObservedCall = (state: ReservationState, callTotal: number): ReservationState => ({
  ...state,
  maxObservedCall: Math.max(state.maxObservedCall, sanitizeDeltaComponent(callTotal)),
});
