/**
 * Unit tests for confidence bucket helpers.
 *
 * Validates:
 * - `bucketFromProbability` default thresholds and custom thresholds
 * - `bucketFromEnsemble` delegates correctly and handles edge cases
 */

import { describe, it, expect } from "bun:test";
import { bucketFromProbability, bucketFromEnsemble } from "../sugar/confidence-buckets.js";

describe("bucketFromProbability", () => {
  it(">=0.85 → high (default thresholds)", () => {
    expect(bucketFromProbability(0.85)).toBe("high");
    expect(bucketFromProbability(0.99)).toBe("high");
    expect(bucketFromProbability(1.0)).toBe("high");
  });

  it(">=0.6 and <0.85 → medium (default thresholds)", () => {
    expect(bucketFromProbability(0.6)).toBe("medium");
    expect(bucketFromProbability(0.7)).toBe("medium");
    expect(bucketFromProbability(0.84)).toBe("medium");
  });

  it("<0.6 → low (default thresholds)", () => {
    expect(bucketFromProbability(0.0)).toBe("low");
    expect(bucketFromProbability(0.3)).toBe("low");
    expect(bucketFromProbability(0.59)).toBe("low");
  });

  it("custom thresholds override defaults", () => {
    expect(bucketFromProbability(0.5, { high: 0.9, medium: 0.5 })).toBe("medium");
    expect(bucketFromProbability(0.49, { high: 0.9, medium: 0.5 })).toBe("low");
    expect(bucketFromProbability(0.9, { high: 0.9, medium: 0.5 })).toBe("high");
  });

  it("boundary: exactly at threshold → that bucket", () => {
    expect(bucketFromProbability(0.85)).toBe("high");
    expect(bucketFromProbability(0.6)).toBe("medium");
  });
});

describe("bucketFromEnsemble", () => {
  it("total=0 → unknown", () => {
    expect(bucketFromEnsemble(0, 0)).toBe("unknown");
  });

  it("all agree → high (default thresholds)", () => {
    expect(bucketFromEnsemble(10, 10)).toBe("high");
  });

  it("9/10 → high (0.9 >= 0.9 default)", () => {
    expect(bucketFromEnsemble(9, 10)).toBe("high");
  });

  it("7/10 → medium (0.7 >= 0.6 default)", () => {
    expect(bucketFromEnsemble(7, 10)).toBe("medium");
  });

  it("3/10 → low (0.3 < 0.6 default)", () => {
    expect(bucketFromEnsemble(3, 10)).toBe("low");
  });

  it("custom thresholds", () => {
    expect(bucketFromEnsemble(4, 5, { high: 0.9, medium: 0.7 })).toBe("medium"); // 0.8
    expect(bucketFromEnsemble(5, 5, { high: 0.9, medium: 0.7 })).toBe("high"); // 1.0
  });
});
