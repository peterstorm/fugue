/**
 * Bucketed confidence types for state-transition observability.
 *
 * The framework currency is a **semantic bucket with declared provenance**,
 * not a raw numeric probability. LLM-emitted numeric self-confidence is
 * well-documented to be miscalibrated (Tian et al. 2023); the framework
 * never compares raw numbers directly. Predicates gate on bucket ordering;
 * dashboards segment calibration by source.
 *
 * Raw numeric values are preserved for forensics but never compared by the
 * framework.
 */

export type ConfidenceBucket = "high" | "medium" | "low" | "unknown";

export type ConfidenceSource =
  | "self-reported-bucket"      // LLM picked from {high, medium, low}
  | "self-reported-numeric"     // LLM emitted a number — least trusted, requires explicit bucketing
  | "logprob"                   // token-level softmax over closed-domain answer
  | "classifier-probability"    // dedicated calibrated classifier
  | "ensemble-agreement"        // N/M samples agreed
  | "heuristic";                // deterministic rule

export interface Confidence {
  readonly bucket: ConfidenceBucket;
  readonly source: ConfidenceSource;
  /** Original value, forensics only — never compared by framework. */
  readonly raw?: number | string;
}

/**
 * Total ordering for predicate gating. Higher is more confident.
 * Framework short-circuits predicates when the upstream bucket is below
 * `minConfidence`.
 */
export const CONFIDENCE_ORDER: Readonly<Record<ConfidenceBucket, number>> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

/**
 * Compare two confidence buckets. Returns true when `actual` meets or
 * exceeds `required`.
 */
export const meetsConfidence = (
  actual: ConfidenceBucket,
  required: ConfidenceBucket,
): boolean => CONFIDENCE_ORDER[actual] >= CONFIDENCE_ORDER[required];
