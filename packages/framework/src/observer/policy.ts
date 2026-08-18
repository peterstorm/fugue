import type { RunSummary } from "./run-summary.js";

export interface PersistencePolicy {
  shouldFlush(summary: RunSummary): boolean;
}

export function alwaysOn(): PersistencePolicy {
  return { shouldFlush: () => true };
}

export function errorOnly(): PersistencePolicy {
  return { shouldFlush: (s) => s.status === "error" };
}

/**
 * Sample-with-probability policy. The optional `rng` lets tests assert
 * deterministic flush decisions without monkey-patching `Math.random`.
 *
 * Throws `RangeError` if `p` is not a finite number in `[0, 1]` — invalid
 * inputs (NaN, Infinity, negatives) used to produce a silently-broken
 * policy whose `shouldFlush` either never fired or fired every time, which
 * is much harder to diagnose than a constructor-time error.
 */
export function ratio(p: number, rng: () => number = Math.random): PersistencePolicy {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`ratio(p): p must be a finite number in [0, 1], got ${p}`);
  }
  return { shouldFlush: () => rng() < p };
}

export function hadRetry(): PersistencePolicy {
  return { shouldFlush: (s) => s.retryCount > 0 };
}

export function anyOf(...policies: PersistencePolicy[]): PersistencePolicy {
  return { shouldFlush: (s) => policies.some((p) => p.shouldFlush(s)) };
}

export function allOf(...policies: PersistencePolicy[]): PersistencePolicy {
  return { shouldFlush: (s) => policies.every((p) => p.shouldFlush(s)) };
}

export function custom(
  fn: (summary: RunSummary) => boolean,
): PersistencePolicy {
  return { shouldFlush: fn };
}
