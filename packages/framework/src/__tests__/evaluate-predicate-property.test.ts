/**
 * Property tests for `evaluatePredicate` with confidence gating.
 *
 * Validates:
 * - minConfidence gating: null confidence or below-min → matched: false
 * - check exceptions → matched: false with "threw:" reason
 * - predicateLabel always preserved in output
 * - when check returns true/false → matched reflects it
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { evaluatePredicate } from "../types/dag.js";
import type { Confidence, ConfidenceBucket, ConfidenceSource } from "../types/confidence.js";

const arbBucket = fc.constantFrom<ConfidenceBucket>("high", "medium", "low", "unknown");
const arbSource = fc.constantFrom<ConfidenceSource>(
  "self-reported-bucket",
  "self-reported-numeric",
  "logprob",
  "classifier-probability",
  "ensemble-agreement",
  "heuristic",
);
const arbConfidence: fc.Arbitrary<Confidence> = fc.record({
  bucket: arbBucket,
  source: arbSource,
});
const arbConfidenceOrNull = fc.option(arbConfidence, { nil: null });

describe("evaluatePredicate — property tests", () => {
  it("predicateLabel is always preserved in output", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        arbConfidenceOrNull,
        fc.anything(),
        (label, confidence, output) => {
          const result = evaluatePredicate(
            { label, check: () => true },
            output,
            confidence,
          );
          return result.predicateLabel === label;
        },
      ),
    );
  });

  it("null confidence with minConfidence set → matched: false, reason: below-min-confidence", () => {
    fc.assert(
      fc.property(arbBucket, (minBucket) => {
        const result = evaluatePredicate(
          { label: "test", check: () => true, minConfidence: minBucket },
          "anything",
          null,
        );
        return result.matched === false && result.reason === "below-min-confidence";
      }),
    );
  });

  it("confidence below minConfidence → matched: false, reason: below-min-confidence", () => {
    // low is below medium and high; unknown is below everything
    const result1 = evaluatePredicate(
      { label: "test", check: () => true, minConfidence: "high" },
      "val",
      { bucket: "low", source: "heuristic" },
    );
    expect(result1.matched).toBe(false);
    expect(result1.reason).toBe("below-min-confidence");

    const result2 = evaluatePredicate(
      { label: "test", check: () => true, minConfidence: "medium" },
      "val",
      { bucket: "unknown", source: "heuristic" },
    );
    expect(result2.matched).toBe(false);
    expect(result2.reason).toBe("below-min-confidence");
  });

  it("confidence meets minConfidence → check is called and result reflects it", () => {
    fc.assert(
      fc.property(fc.boolean(), (checkResult) => {
        const result = evaluatePredicate(
          { label: "test", check: () => checkResult, minConfidence: "low" },
          "val",
          { bucket: "high", source: "heuristic" },
        );
        return result.matched === checkResult && result.reason === undefined;
      }),
    );
  });

  it("check that throws → matched: false, reason starts with 'threw:'", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (errorMsg) => {
        const result = evaluatePredicate(
          {
            label: "boom",
            check: () => {
              throw new Error(errorMsg);
            },
          },
          "val",
          null,
        );
        return (
          result.matched === false &&
          result.reason !== undefined &&
          result.reason.startsWith("threw:")
        );
      }),
    );
  });

  it("no minConfidence → check always runs regardless of confidence", () => {
    fc.assert(
      fc.property(arbConfidenceOrNull, (confidence) => {
        let called = false;
        evaluatePredicate(
          {
            label: "check-runs",
            check: () => {
              called = true;
              return true;
            },
          },
          "val",
          confidence,
        );
        return called;
      }),
    );
  });

  it("evaluatedConfidence is always the passed-in confidence", () => {
    fc.assert(
      fc.property(arbConfidenceOrNull, (confidence) => {
        const result = evaluatePredicate(
          { label: "test", check: () => true },
          "val",
          confidence,
        );
        return result.evaluatedConfidence === confidence;
      }),
    );
  });
});
