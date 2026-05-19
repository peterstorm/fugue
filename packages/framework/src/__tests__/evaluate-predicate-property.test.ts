/**
 * Property tests for `evaluatePredicate` with confidence gating.
 *
 * Validates:
 * - minConfidence gating: null confidence or below-min → outcome: "below-min-confidence"
 * - check exceptions → outcome: "threw" with message
 * - predicateLabel always preserved in output
 * - when check returns true/false → outcome reflects it
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { evaluatePredicate } from "../dag-runtime/routing.js";
import { confidence } from "../types/confidence.js";
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
}).map(({ bucket, source }) => confidence(bucket, source));
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
            { label, version: 1, check: () => true },
            output,
            confidence,
          );
          return result.predicateLabel === label && result.predicateVersion === 1;
        },
      ),
    );
  });

  it("null confidence with minConfidence set → outcome: below-min-confidence", () => {
    fc.assert(
      fc.property(arbBucket, (minBucket) => {
        const result = evaluatePredicate(
          { label: "test", version: 1, check: () => true, minConfidence: minBucket },
          "anything",
          null,
        );
        return result.outcome === "below-min-confidence";
      }),
    );
  });

  it("confidence below minConfidence → outcome: below-min-confidence", () => {
    // low is below medium and high; unknown is below everything
    const result1 = evaluatePredicate(
      { label: "test", version: 1, check: () => true, minConfidence: "high" },
      "val",
      confidence("low", "heuristic"),
    );
    expect(result1.outcome).toBe("below-min-confidence");

    const result2 = evaluatePredicate(
      { label: "test", version: 1, check: () => true, minConfidence: "medium" },
      "val",
      confidence("unknown", "heuristic"),
    );
    expect(result2.outcome).toBe("below-min-confidence");
  });

  it("confidence meets minConfidence → check is called and outcome reflects it", () => {
    fc.assert(
      fc.property(fc.boolean(), (checkResult) => {
        const result = evaluatePredicate(
          { label: "test", version: 1, check: () => checkResult, minConfidence: "low" },
          "val",
          confidence("high", "heuristic"),
        );
        return result.outcome === (checkResult ? "matched" : "not-matched");
      }),
    );
  });

  it("check that throws → outcome: threw with message", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (errorMsg) => {
        const result = evaluatePredicate(
          {
            label: "boom",
            version: 1,
            check: () => {
              throw new Error(errorMsg);
            },
          },
          "val",
          null,
        );
        return (
          result.outcome === "threw" &&
          result.message === errorMsg
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
            version: 1,
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
          { label: "test", version: 1, check: () => true },
          "val",
          confidence,
        );
        return result.evaluatedConfidence === confidence;
      }),
    );
  });
});
