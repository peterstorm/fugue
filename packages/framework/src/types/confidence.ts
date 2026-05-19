/**
 * Bucketed confidence types for state-transition observability.
 *
 * The framework currency is a **semantic bucket with declared provenance**,
 * not a raw numeric probability. LLM-emitted numeric self-confidence is
 * well-documented to be miscalibrated (Tian et al., "Just Ask for Calibration",
 * NeurIPS 2023); the framework
 * never compares raw numbers directly. Predicates gate on bucket ordering;
 * dashboards segment calibration by source.
 *
 * Raw numeric values are preserved for forensics but never compared by the
 * framework.
 *
 * @see docs/adr/0027-confidence-calibration-workflow.md
 */

export type ConfidenceBucket = "high" | "medium" | "low" | "unknown";

export type ConfidenceSource =
  | "self-reported-bucket"      // LLM picked from {high, medium, low}
  | "self-reported-numeric"     // LLM emitted a number — least trusted, requires explicit bucketing
  | "logprob"                   // token-level softmax over closed-domain answer
  | "classifier-probability"    // dedicated calibrated classifier
  | "ensemble-agreement"        // N/M samples agreed
  | "heuristic";                // deterministic rule

declare const __confidenceBrand: unique symbol;

export type Confidence = {
  readonly bucket: ConfidenceBucket;
  readonly source: ConfidenceSource;
  /** Original value, forensics only — never compared by framework. */
  readonly raw?: number | string;
} & { readonly [__confidenceBrand]: void };

/** Smart constructor — the only sanctioned way to create a Confidence value. */
export function confidence(
  bucket: ConfidenceBucket,
  source: "self-reported-numeric" | "logprob",
  raw: number,
): Confidence;
export function confidence(
  bucket: ConfidenceBucket,
  source: ConfidenceSource,
  raw: number | string,
): Confidence;
export function confidence(
  bucket: ConfidenceBucket,
  source: ConfidenceSource,
  raw?: number | string,
): Confidence;
export function confidence(
  bucket: ConfidenceBucket,
  source: ConfidenceSource,
  raw?: number | string,
): Confidence {
  if (source === "self-reported-numeric" && typeof raw === "number" && (raw < 0 || raw > 1)) {
    throw new RangeError(
      `confidence raw value for "self-reported-numeric" must be in [0, 1], got ${raw}`,
    );
  }
  if (source === "logprob" && (raw === undefined || typeof raw !== "number")) {
    throw new TypeError(
      `confidence source "logprob" requires a numeric raw value, got ${raw === undefined ? "undefined" : typeof raw}`,
    );
  }
  return ({ bucket, source, ...(raw !== undefined ? { raw } : {}) }) as Confidence;
}

/**
 * @internal — Bypass validation for trusted internal code (deserialization,
 * replay). NOT part of the public API.
 */
export const __brandConfidence = (c: {
  bucket: ConfidenceBucket;
  source: ConfidenceSource;
  raw?: number | string;
}): Confidence => c as Confidence;

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
