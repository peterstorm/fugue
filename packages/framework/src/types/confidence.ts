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

import { type Result, ok, err } from "./result.js";

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
 * @internal — Bypass ALL validation. ONLY for hot deserialization / replay
 * paths where the payload provenance is already trusted and profiling shows
 * the validation cost matters. Prefer `__brandConfidence` everywhere else: an
 * unchecked corrupt value (e.g. `source: "logprob"` with no `raw`) silently
 * violates the documented invariants and is impossible to trace later.
 */
export const __brandConfidenceUnchecked = (c: {
  bucket: ConfidenceBucket;
  source: ConfidenceSource;
  raw?: number | string;
}): Confidence => c as Confidence;

const CONFIDENCE_SOURCES: readonly ConfidenceSource[] = [
  "self-reported-bucket",
  "self-reported-numeric",
  "logprob",
  "classifier-probability",
  "ensemble-agreement",
  "heuristic",
];

/**
 * @internal — Brand a plain object as `Confidence` after validating its
 * discriminant fields. Use for deserialization / replay where the payload may
 * be corrupt (a stale checkpoint, a hand-edited file). Returns `Err` with a
 * human-readable reason rather than minting an invalid value.
 */
export const __brandConfidence = (c: {
  bucket: string;
  source: string;
  raw?: number | string;
}): Result<Confidence, string> => {
  if (!(c.bucket in CONFIDENCE_ORDER)) {
    return err(`unknown confidence bucket '${c.bucket}'`);
  }
  if (!(CONFIDENCE_SOURCES as readonly string[]).includes(c.source)) {
    return err(`unknown confidence source '${c.source}'`);
  }
  if (c.source === "logprob" && typeof c.raw !== "number") {
    return err(`confidence source 'logprob' requires a numeric 'raw' value`);
  }
  return ok(c as Confidence);
};

/**
 * Public Result-returning constructor for parse boundaries where throwing is
 * undesirable. Validates bucket, source, and raw constraints. Mirrors the
 * pattern of `tryRunId`/`tryNodeId`/`tryDagId`.
 */
export const tryConfidence = (
  bucket: string,
  source: string,
  raw?: number | string,
): Result<Confidence, string> => {
  if (!(bucket in CONFIDENCE_ORDER)) {
    return err(`unknown confidence bucket '${bucket}'`);
  }
  if (!(CONFIDENCE_SOURCES as readonly string[]).includes(source)) {
    return err(`unknown confidence source '${source}'`);
  }
  if (source === "self-reported-numeric" && typeof raw === "number" && (raw < 0 || raw > 1)) {
    return err(`confidence raw value for "self-reported-numeric" must be in [0, 1], got ${raw}`);
  }
  if (source === "logprob" && (raw === undefined || typeof raw !== "number")) {
    return err(`confidence source "logprob" requires a numeric raw value`);
  }
  return ok({
    bucket: bucket as ConfidenceBucket,
    source: source as ConfidenceSource,
    ...(raw !== undefined ? { raw } : {}),
  } as Confidence);
};

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
