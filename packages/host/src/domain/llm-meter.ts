/**
 * Pure LLM spend meter — per-`runId` accumulator + budget decision.
 *
 * Functional core: no I/O, no clocks, no network. Every operation is a pure
 * function over an immutable `LlmMeter` value. The metered-llm adapter (the
 * imperative shell) holds the live meter and threads it through these
 * functions; this module never touches the wire.
 *
 * WHY SPEND AND NOT TOKENS: the meter used to accumulate `tokensIn + tokensOut`
 * and compare that against a single token ceiling. Prompt caching (F4) severed
 * the link between those two figures and money — a cache read bills at 0.1x and
 * a write at 1.25-2.0x — so two runs with identical token counts can differ by
 * better than an order of magnitude in cost, and a token ceiling cannot see the
 * difference. The accumulator is now a `Spend`, which carries every axis a
 * ceiling can be denominated in, and the framework's `spendOfCall` is the one
 * place a call is priced.
 *
 * @satisfies FR-W0-004 — aggregate consumption by runId; DAG/node attribution
 *   belongs to Run Spend Authority diagnostics
 * @satisfies FR-W1-002 — pre-call comparison of cumulative vs budget
 * @satisfies FR-W1-004 — sequential pre-call admission permits the crossing call
 * @satisfies FR-W1-005 — in-memory counter, no network
 * @satisfies FR-W1-006 — absent budget never refuses
 * @satisfies SC-003 — concurrent admission accounts for a learned call estimate
 * @satisfies FR-B-002 — refuse when ANY declared ceiling is reached
 * @satisfies FR-B-013 — the refusal names the ceiling, basis, and observed figure
 */

import type { Breach, Ceilings, Result, RunId, Spend } from "@fuguejs/framework";
import {
  NO_SPEND,
  addSpend,
  err,
  firstBreach,
  maxSpend,
  ok,
  scaleSpend,
  snapshotSpend,
} from "@fuguejs/framework";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Immutable per-`runId` spend accumulator. The map is treated as frozen — every
 * mutation produces a new `LlmMeter` via `accumulate`. An absent `runId` means
 * zero spend (no entry is materialised until the first `accumulate`).
 */
export interface LlmMeter {
  readonly spendByRun: ReadonlyMap<RunId, Spend>;
}

/** Runtime-read-only snapshot; no mutable `Map` methods escape the ADT. */
const meterOf = (entries: ReadonlyMap<RunId, Spend>): LlmMeter => {
  const snapshot = new Map(
    Array.from(entries, ([runId, spend]) => [runId, snapshotSpend(spend)] as const),
  );
  let view: ReadonlyMap<RunId, Spend>;
  const facade = {
    get size(): number { return snapshot.size; },
    get: (runId: RunId): Spend | undefined => snapshot.get(runId),
    has: (runId: RunId): boolean => snapshot.has(runId),
    entries: (): MapIterator<[RunId, Spend]> => snapshot.entries(),
    keys: (): MapIterator<RunId> => snapshot.keys(),
    values: (): MapIterator<Spend> => snapshot.values(),
    [Symbol.iterator]: (): MapIterator<[RunId, Spend]> => snapshot[Symbol.iterator](),
    forEach(
      callback: (spend: Spend, runId: RunId, map: ReadonlyMap<RunId, Spend>) => void,
      thisArg?: unknown,
    ): void {
      for (const [runId, spend] of snapshot) callback.call(thisArg, spend, runId, view);
    },
  } satisfies ReadonlyMap<RunId, Spend>;
  view = Object.freeze(facade);
  return Object.freeze({ spendByRun: view });
};

/** The empty meter — no runs have consumed anything yet. */
export const emptyMeter = (): LlmMeter => meterOf(new Map());

// ---------------------------------------------------------------------------
// Queries (pure)
// ---------------------------------------------------------------------------

/**
 * Spend settled for a run. An unmetered run reads as `NO_SPEND` rather than
 * `undefined` — the budget check and callers treat "never seen" and "seen, spent
 * nothing" identically (FR-W1-002).
 */
export const spendFor = (meter: LlmMeter, runId: RunId): Spend =>
  meter.spendByRun.get(runId) ?? NO_SPEND;

// ---------------------------------------------------------------------------
// Transitions (pure)
// ---------------------------------------------------------------------------

/**
 * Add one settled call's spend to a run's running total, returning a NEW meter.
 * The input meter is never mutated.
 *
 * Sanitization happens at CONSTRUCTION, in the framework's `spendOfCall` /
 * `usdToMicros` / `sanitizeCount`, rather than being re-defended here: a
 * provider can only ever add consumption, so a negative figure reads as an
 * absent count and a non-finite one would poison every later sum (`NaN`
 * propagates, and `NaN >= limit` is false forever — a budget that fails OPEN).
 *
 * @satisfies FR-W0-004
 */
export const accumulate = (meter: LlmMeter, runId: RunId, delta: Spend): LlmMeter => {
  const next = addSpend(spendFor(meter, runId), delta);
  const spendByRun = new Map(meter.spendByRun);
  spendByRun.set(runId, next);
  return meterOf(spendByRun);
};

// ---------------------------------------------------------------------------
// Admission (pure) — the SC-003 bound under parallel calls
// ---------------------------------------------------------------------------

/**
 * Reservation accounting for admitted-but-unsettled calls (review I1 / SC-003).
 *
 * A budget refuses only once settled spend reaches a ceiling, but spend settles
 * AFTER a call returns — so N calls fired in parallel all read the same
 * pre-settle figure, all pass the gate, and overshoot by N rather than one.
 * Treating admitted-but-unsettled calls as already-spending closes that:
 * `maxObservedCall` is the learned per-call estimate (the per-axis largest
 * single call seen so far) and `inFlight` counts the calls currently holding a
 * reservation, so the projection is `settled + inFlight x maxObservedCall`.
 *
 * Admission reserves the largest settled call observed so far. That estimate
 * limits bursts whose calls are no larger than what the authority has learned,
 * but it is not a one-call bound: a later concurrent burst of larger calls can
 * exceed the estimate. Settlement learns the larger per-axis size, tightening
 * subsequent admissions monotonically.
 *
 * `inFlight` is a COUNT rather than a running sum of reserved amounts. The sum
 * form required each release to free exactly what its matching admit reserved,
 * which meant threading the reserved figure through the shell and clamping the
 * total against double-release. A count releases by decrementing, and the
 * projection uses the CURRENT estimate for every in-flight call — slightly more
 * conservative than the old sum of older, smaller estimates, which is the
 * fail-closed direction, and it deletes the bookkeeping entirely. `Spend`
 * additionally cannot be subtracted honestly: once an `unpriced` call is in the
 * sum there is no way to take it back out.
 */
declare const __reservationStateBrand: unique symbol;

/** Opaque state: only this module's legal transitions can construct it. */
export type ReservationState = Readonly<{
  readonly inFlight: number;
  readonly maxObservedCall: Spend;
  readonly [__reservationStateBrand]: "ReservationState";
}>;

const reservationState = (inFlight: number, maxObservedCall: Spend): ReservationState =>
  Object.freeze({
    inFlight,
    maxObservedCall: snapshotSpend(maxObservedCall),
  }) as ReservationState;

/** No calls admitted, no per-call estimate learned yet. */
export const emptyReservation: ReservationState = reservationState(0, NO_SPEND);

/**
 * Admission-safe spend projection shared by enforcement and the budget read
 * model. One formula prevents concurrent reservations from being presented as
 * available headroom while the next call's gate already considers them spent.
 */
export const projectedSpend = (
  meter: LlmMeter,
  runId: RunId,
  state: ReservationState,
): Spend => addSpend(spendFor(meter, runId), scaleSpend(state.maxObservedCall, state.inFlight));

/**
 * Outcome of the reservation-aware pre-call gate. An `admit` carries the next
 * reservation state; a `refuse` carries the breach that caused it plus the
 * figures the shell logs. Illegal blends are unrepresentable.
 */
export type AdmitDecision =
  | { readonly kind: "admit"; readonly state: ReservationState }
  | {
      readonly kind: "refuse";
      /** Which ceiling, on which basis, at what observed figure. */
      readonly breach: Breach;
      /** SETTLED spend at decision time — always reconciles against the metered totals. */
      readonly settled: Spend;
      /** Calls holding a reservation when this was decided — log-only. */
      readonly inFlight: number;
    };

const reserve = (state: ReservationState): ReservationState =>
  reservationState(state.inFlight + 1, state.maxObservedCall);

/**
 * Decide whether the NEXT call for `runId` may proceed under `limits`.
 *
 * The comparison is BEFORE the call, against settled-so-far (FR-W1-002). In a
 * sequential flow, while spend is below every ceiling the crossing call is
 * admitted and the following call is refused (FR-W1-004). Concurrent admission
 * additionally projects `inFlight × maxObservedCall`; that estimate limits a
 * learned-size burst but cannot promise one-call overshoot for a first or larger
 * concurrent burst.
 *
 * Absent `limits` always admits (FR-W1-006: no budget means no enforcement,
 * though metering still happens). A ceiling of zero refuses the first call, as
 * a budget granting nothing should.
 *
 * The settled check runs before the projected one so that a refusal reports the
 * strongest available reason: a ceiling that spend has ACTUALLY reached, rather
 * than one an estimate says it is about to. That ordering is also what makes
 * `Breach.basis` correct by construction — each call to `firstBreach` is handed
 * one spend figure and told what it is, instead of a single check inferring
 * afterwards which figure drove it.
 *
 * @satisfies FR-W1-002 FR-W1-004 FR-W1-006 SC-003 FR-B-002 FR-B-013
 */
export const admit = (
  meter: LlmMeter,
  runId: RunId,
  state: ReservationState,
  limits?: Ceilings,
): AdmitDecision => {
  const settled = spendFor(meter, runId);
  if (limits === undefined) return { kind: "admit", state: reserve(state) };

  const refusal = (breach: Breach): AdmitDecision => ({
    kind: "refuse",
    breach,
    settled,
    inFlight: state.inFlight,
  });

  const settledBreach = firstBreach(settled, limits, "settled");
  if (settledBreach !== undefined) return refusal(settledBreach);

  const projectedBreach = firstBreach(projectedSpend(meter, runId, state), limits, "projected");
  if (projectedBreach !== undefined) return refusal(projectedBreach);

  return { kind: "admit", state: reserve(state) };
};

export type ReservationInvariantError = {
  readonly kind: "reservation-underflow";
  readonly inFlight: number;
};

/**
 * Release one admitted call's reservation (call once, on settle).
 *
 * Underflow is a typed invariant failure, never a clamped success. The input is
 * immutable and the Err carries no replacement state, so a caller cannot
 * accidentally install a lower count and grant headroom after a double release.
 */
export const releaseReservation = (
  state: ReservationState,
): Result<ReservationState, ReservationInvariantError> =>
  state.inFlight <= 0
    ? err({ kind: "reservation-underflow", inFlight: state.inFlight })
    : ok(reservationState(state.inFlight - 1, state.maxObservedCall));

/** Widen the per-call estimate from a settled call (per-axis monotone max). */
export const learnObservedCall = (state: ReservationState, call: Spend): ReservationState =>
  reservationState(state.inFlight, maxSpend(state.maxObservedCall, call));
