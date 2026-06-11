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
import type { RunId } from "@fuguejs/framework";

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
export interface RunUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
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

/** A single LLM call's token delta. */
export interface TokenDelta {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * Outcome of a pre-call budget check — discriminated union so an `allow` can
 * never carry a refusal payload and vice-versa (illegal states unrepresentable).
 *
 * `cumulative` on both branches is the run's total-so-far at decision time
 * (before the in-flight call). `budget` is only meaningful on `refuse`.
 */
export type BudgetDecision =
  | { readonly kind: "allow"; readonly cumulative: number }
  | { readonly kind: "refuse"; readonly cumulative: number; readonly budget: number };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const ZERO_USAGE: RunUsage = { tokensIn: 0, tokensOut: 0 };

/** The empty meter — no runs have consumed any tokens yet. */
export const emptyMeter = (): LlmMeter => ({ usageByRun: new Map() });

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
 * Add a single call's token delta to a run's running total, returning a NEW
 * meter. The input meter is never mutated. Negative deltas are clamped to zero
 * — a provider can only ever add usage, never subtract it, so a negative figure
 * is treated as an absent/malformed count rather than a budget refund.
 *
 * @satisfies FR-W0-004
 */
export const accumulate = (meter: LlmMeter, runId: RunId, delta: TokenDelta): LlmMeter => {
  const prev = usageFor(meter, runId);
  const addIn = Math.max(0, delta.tokensIn);
  const addOut = Math.max(0, delta.tokensOut);
  const next: RunUsage = {
    tokensIn: prev.tokensIn + addIn,
    tokensOut: prev.tokensOut + addOut,
  };
  const usageByRun = new Map(meter.usageByRun);
  usageByRun.set(runId, next);
  return { usageByRun };
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
 * @satisfies FR-W1-002 FR-W1-004 FR-W1-006 SC-003
 */
export const budgetDecision = (
  meter: LlmMeter,
  runId: RunId,
  budget?: number,
): BudgetDecision => {
  const cumulative = runTotal(usageFor(meter, runId));
  if (budget === undefined) return { kind: "allow", cumulative };
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
