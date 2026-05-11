import type { RunSummary } from "./buffered.js";

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
 */
export function ratio(p: number, rng: () => number = Math.random): PersistencePolicy {
  return { shouldFlush: () => rng() < p };
}

export function hadRetry(): PersistencePolicy {
  return { shouldFlush: (s) => s.retryCount > 0 };
}

export function coldCache(): PersistencePolicy {
  return { shouldFlush: (s) => s.cacheHitCount < s.nodeCount };
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
