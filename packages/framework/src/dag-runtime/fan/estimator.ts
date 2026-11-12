// estimator — the per-child cost estimate projection multiplies (AD-5, FR-046).
//
// Percentiles are NEAREST-RANK over each axis's sample multiset: the value at
// rank ⌈p/100 · n⌉ of the ascending samples. That always returns an OBSERVED
// integer — never a fractional MicroUsd. It is NOT guaranteed to be at or
// above the linearly interpolated percentile; the conservatism comes from the
// `largest-seen` fallback below PERCENTILE_MIN_SAMPLES and from choosing p90 /
// p95. `largest-seen` is the 100th percentile, i.e. the per-axis maximum M
// (FR-018).
//
// Below PERCENTILE_MIN_SAMPLES samples a percentile has too little data to
// mean anything, so it falls back to `largest-seen`, and `applied` reports the
// estimator ACTUALLY used — the refusal and the projection event carry it.
// Seeded samples (AD-11) count toward the threshold like any other.
//
// Functional core: pure, no I/O.

import { match } from "ts-pattern";
import type { FanEstimator, SpendSample } from "../../types/fan-scheduling.js";
import { microUsd } from "../../types/spend.js";

/** Settled samples a percentile estimator needs before it applies (FR-046). */
export const PERCENTILE_MIN_SAMPLES = 5;

/** The per-child estimate, and the estimator that produced it. */
export type Estimate = Readonly<{ perChild: SpendSample; applied: FanEstimator }>;

const percentileOf = (e: FanEstimator): number =>
  match(e)
    .with("largest-seen", () => 100)
    .with("p50", () => 50)
    .with("p90", () => 90)
    .with("p95", () => 95)
    .exhaustive();

/** Nearest-rank percentile of `values`; 0 for an empty multiset. Never mutates. */
const nearestRank = (values: readonly number[], percentile: number): number => {
  const ascending = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile * ascending.length) / 100);
  return ascending[rank - 1] ?? 0;
};

/**
 * Estimate one more child's spend from the fan's samples so far. With no
 * samples the estimate is zero on every axis, under `largest-seen`.
 * `lowerBound` is set when any sample was itself a lower bound.
 */
export const estimate = (samples: readonly SpendSample[], estimator: FanEstimator): Estimate => {
  const applied: FanEstimator = samples.length < PERCENTILE_MIN_SAMPLES ? "largest-seen" : estimator;
  const p = percentileOf(applied);
  const perChild: SpendSample = Object.freeze({
    tokens: nearestRank(samples.map((s) => s.tokens), p),
    calls: nearestRank(samples.map((s) => s.calls), p),
    usdMicros: microUsd(nearestRank(samples.map((s) => s.usdMicros), p)),
    lowerBound: samples.some((s) => s.lowerBound),
  });
  return Object.freeze({ perChild, applied });
};
