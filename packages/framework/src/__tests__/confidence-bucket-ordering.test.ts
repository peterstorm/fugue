/**
 * Phase 2 test — confidence bucket ordering and bucketing helpers.
 *
 * Validates:
 * - CONFIDENCE_ORDER total ordering invariants
 * - meetsConfidence comparison
 * - bucketFromProbability with default and custom thresholds
 * - bucketFromEnsemble
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import {
  CONFIDENCE_ORDER,
  meetsConfidence,
} from "../types/confidence.js";
import type { ConfidenceBucket } from "../types/confidence.js";
import {
  bucketFromProbability,
  bucketFromEnsemble,
} from "../sugar/confidence-buckets.js";

describe("CONFIDENCE_ORDER", () => {
  it("has a strict total ordering: unknown < low < medium < high", () => {
    expect(CONFIDENCE_ORDER.unknown).toBeLessThan(CONFIDENCE_ORDER.low);
    expect(CONFIDENCE_ORDER.low).toBeLessThan(CONFIDENCE_ORDER.medium);
    expect(CONFIDENCE_ORDER.medium).toBeLessThan(CONFIDENCE_ORDER.high);
  });

  it("covers all four buckets", () => {
    const buckets: ConfidenceBucket[] = ["high", "medium", "low", "unknown"];
    for (const b of buckets) {
      expect(CONFIDENCE_ORDER[b]).toBeDefined();
      expect(typeof CONFIDENCE_ORDER[b]).toBe("number");
    }
  });

  it("values are distinct", () => {
    const values = Object.values(CONFIDENCE_ORDER);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("meetsConfidence", () => {
  it("same bucket always meets", () => {
    for (const b of ["high", "medium", "low", "unknown"] as const) {
      expect(meetsConfidence(b, b)).toBe(true);
    }
  });

  it("higher bucket meets lower requirement", () => {
    expect(meetsConfidence("high", "medium")).toBe(true);
    expect(meetsConfidence("high", "low")).toBe(true);
    expect(meetsConfidence("high", "unknown")).toBe(true);
    expect(meetsConfidence("medium", "low")).toBe(true);
    expect(meetsConfidence("medium", "unknown")).toBe(true);
    expect(meetsConfidence("low", "unknown")).toBe(true);
  });

  it("lower bucket does NOT meet higher requirement", () => {
    expect(meetsConfidence("low", "medium")).toBe(false);
    expect(meetsConfidence("low", "high")).toBe(false);
    expect(meetsConfidence("medium", "high")).toBe(false);
    expect(meetsConfidence("unknown", "low")).toBe(false);
    expect(meetsConfidence("unknown", "medium")).toBe(false);
    expect(meetsConfidence("unknown", "high")).toBe(false);
  });
});

describe("bucketFromProbability", () => {
  it("default thresholds: p >= 0.85 → high, p >= 0.6 → medium, else low", () => {
    expect(bucketFromProbability(0.9)).toBe("high");
    expect(bucketFromProbability(0.85)).toBe("high");
    expect(bucketFromProbability(0.7)).toBe("medium");
    expect(bucketFromProbability(0.6)).toBe("medium");
    expect(bucketFromProbability(0.5)).toBe("low");
    expect(bucketFromProbability(0.0)).toBe("low");
  });

  it("custom thresholds override defaults", () => {
    expect(bucketFromProbability(0.95, { high: 0.99, medium: 0.9 })).toBe("medium");
    expect(bucketFromProbability(0.5, { high: 0.5, medium: 0.3 })).toBe("high");
    expect(bucketFromProbability(0.2, { high: 0.5, medium: 0.3 })).toBe("low");
  });

  it("boundary values: exactly at threshold → that bucket", () => {
    expect(bucketFromProbability(0.85)).toBe("high");
    expect(bucketFromProbability(0.6)).toBe("medium");
    // Just below
    expect(bucketFromProbability(0.8499)).toBe("medium");
    expect(bucketFromProbability(0.5999)).toBe("low");
  });
});

describe("bucketFromEnsemble", () => {
  it("unanimous agreement → high", () => {
    expect(bucketFromEnsemble(5, 5)).toBe("high");
    expect(bucketFromEnsemble(10, 10)).toBe("high");
  });

  it("strong agreement → high or medium depending on ratio", () => {
    expect(bucketFromEnsemble(9, 10)).toBe("high"); // 0.9
    expect(bucketFromEnsemble(7, 10)).toBe("medium"); // 0.7
  });

  it("weak agreement → low", () => {
    expect(bucketFromEnsemble(3, 10)).toBe("low"); // 0.3
    expect(bucketFromEnsemble(1, 10)).toBe("low"); // 0.1
  });

  it("zero total → unknown", () => {
    expect(bucketFromEnsemble(0, 0)).toBe("unknown");
  });

  it("custom thresholds override defaults", () => {
    // With strict thresholds, 8/10 = 0.8 is only medium
    expect(bucketFromEnsemble(8, 10, { high: 0.95, medium: 0.5 })).toBe("medium");
  });
});

describe("bucketFromProbability — edge inputs", () => {
  it("NaN → low (NaN >= threshold is always false)", () => {
    expect(bucketFromProbability(NaN)).toBe("low");
  });

  it("Infinity → high (Infinity >= any finite threshold)", () => {
    expect(bucketFromProbability(Infinity)).toBe("high");
  });

  it("-Infinity → low (-Infinity >= threshold is always false)", () => {
    expect(bucketFromProbability(-Infinity)).toBe("low");
  });

  it("negative values → low", () => {
    expect(bucketFromProbability(-1)).toBe("low");
    expect(bucketFromProbability(-0.5)).toBe("low");
  });

  it("values > 1 → high (no clamping)", () => {
    expect(bucketFromProbability(2)).toBe("high");
    expect(bucketFromProbability(100)).toBe("high");
  });

  it("zero → low", () => {
    expect(bucketFromProbability(0)).toBe("low");
  });

  it("exactly 1.0 → high", () => {
    expect(bucketFromProbability(1.0)).toBe("high");
  });
});

describe("CONFIDENCE_ORDER — total order (property test)", () => {
  const buckets = ["high", "medium", "low", "unknown"] as const;

  it("reflexive, transitive, antisymmetric", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...buckets),
        fc.constantFrom(...buckets),
        fc.constantFrom(...buckets),
        (a, b, c) => {
          // Reflexive: a meets a
          if (!meetsConfidence(a, a)) return false;
          // Transitive: if a >= b and b >= c then a >= c
          if (meetsConfidence(a, b) && meetsConfidence(b, c)) {
            if (!meetsConfidence(a, c)) return false;
          }
          // Antisymmetric: if a >= b and b >= a then order(a) === order(b)
          if (meetsConfidence(a, b) && meetsConfidence(b, a)) {
            if (CONFIDENCE_ORDER[a] !== CONFIDENCE_ORDER[b]) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
