/**
 * Bucketing helpers for converting numeric signals into confidence buckets.
 *
 * The thresholds defaults are intentionally opinionated and overridable per
 * node. Node authors call `bucketFromProbability` in their `confidence.extract`
 * implementation.
 */

import type { ConfidenceBucket } from "../types/confidence.js";

/**
 * Convert a probability [0, 1] into a confidence bucket. Intended for
 * `classifier-probability` and `self-reported-numeric` sources.
 *
 * @param p - probability in [0, 1]
 * @param thresholds - overridable per node; defaults to `{ high: 0.85, medium: 0.6 }`
 */
export const bucketFromProbability = (
  p: number,
  thresholds: { high: number; medium: number } = { high: 0.85, medium: 0.6 },
): ConfidenceBucket =>
  p >= thresholds.high ? "high" : p >= thresholds.medium ? "medium" : "low";

/**
 * Convert ensemble agreement (k out of n samples agreed) into a confidence bucket.
 *
 * @param agreed - number of samples that agreed
 * @param total - total number of samples
 * @param thresholds - overridable; defaults to `{ high: 0.9, medium: 0.6 }`
 */
export const bucketFromEnsemble = (
  agreed: number,
  total: number,
  thresholds: { high: number; medium: number } = { high: 0.9, medium: 0.6 },
): ConfidenceBucket => {
  if (total === 0) return "unknown";
  return bucketFromProbability(agreed / total, thresholds);
};
