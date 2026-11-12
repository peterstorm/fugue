/**
 * Per-child cost estimation (AD-5, FR-046, SC-014) and the lifetime-window
 * spend sample it consumes (AD-3).
 *
 * Pins: nearest-rank percentiles that always return an OBSERVED integer
 * value, monotone in the percentile; the largest-seen fallback below 5
 * samples (0/1/4 samples fall back, the 5th sample switches the percentile
 * on); and `spendDelta` as a never-under-counting window measure — exact for
 * a lone child, an over-approximation under concurrent siblings.
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { estimate, PERCENTILE_MIN_SAMPLES } from "../estimator.js";
import { spendDelta } from "../spend-window.js";
import { FAN_ESTIMATORS, type FanEstimator, type SpendSample } from "../../../types/fan-scheduling.js";
import {
  addSpend,
  makeSpend,
  microUsd,
  NO_SPEND,
  pricedCall,
  unknownUsageCall,
  unpricedCall,
  type Spend,
} from "../../../types/spend.js";

const RUNS = { numRuns: 1_000 } as const;

const sample = (tokens: number, calls: number, usd: number, lowerBound = false): SpendSample =>
  ({ tokens, calls, usdMicros: microUsd(usd), lowerBound });

const count = fc.integer({ min: 0, max: 1_000_000 });
const sampleArb: fc.Arbitrary<SpendSample> = fc.record({
  tokens: count,
  calls: fc.integer({ min: 0, max: 50 }),
  usd: count,
  lowerBound: fc.boolean(),
}).map(({ tokens, calls, usd, lowerBound }) => sample(tokens, calls, usd, lowerBound));
const samplesArb = (min: number) => fc.array(sampleArb, { minLength: min, maxLength: 40 });
const estimatorArb = fc.constantFrom<FanEstimator>(...FAN_ESTIMATORS);

type Axis = "tokens" | "calls" | "usdMicros";
const AXES: readonly Axis[] = ["tokens", "calls", "usdMicros"];
const axisValues = (samples: readonly SpendSample[], axis: Axis): number[] => samples.map((s) => s[axis]);

describe("estimate — fallback below 5 samples (FR-046, SC-014)", () => {
  it("needs 5 settled children before a percentile applies", () => {
    expect(PERCENTILE_MIN_SAMPLES).toBe(5);
  });

  it("returns a zero, exact estimate under largest-seen with 0 samples", () => {
    for (const e of FAN_ESTIMATORS) {
      expect(estimate([], e)).toEqual({ perChild: sample(0, 0, 0), applied: "largest-seen" });
    }
  });

  it("falls back to largest-seen at 1 sample", () => {
    const one = [sample(7, 1, 300)];
    for (const e of FAN_ESTIMATORS) {
      expect(estimate(one, e)).toEqual({ perChild: sample(7, 1, 300), applied: "largest-seen" });
    }
  });

  it("falls back to largest-seen at 4 samples and reports the estimator actually applied", () => {
    const four = [sample(10, 1, 100), sample(40, 4, 400), sample(20, 2, 200), sample(30, 3, 300)];
    expect(estimate(four, "p50")).toEqual({ perChild: sample(40, 4, 400), applied: "largest-seen" });
    expect(estimate(four, "p95").applied).toBe("largest-seen");
  });

  it("applies the percentile from the 5th sample on", () => {
    const five = [sample(10, 1, 100), sample(50, 5, 500), sample(20, 2, 200), sample(40, 4, 400), sample(30, 3, 300)];
    // nearest rank of p50 over 5 values: ceil(0.5 × 5) = 3rd smallest.
    expect(estimate(five, "p50")).toEqual({ perChild: sample(30, 3, 300), applied: "p50" });
    expect(estimate(five, "p90")).toEqual({ perChild: sample(50, 5, 500), applied: "p90" });
  });

  it("uses the largest per-child spend seen so far when no estimator is chosen (AS-040 default)", () => {
    const seen = [sample(5, 1, 9), sample(90, 2, 3), sample(1, 7, 40), sample(2, 2, 2), sample(3, 3, 3), sample(4, 4, 4)];
    expect(estimate(seen, "largest-seen")).toEqual({ perChild: sample(90, 7, 40), applied: "largest-seen" });
  });

  it("computes nearest-rank percentiles over ten samples", () => {
    const ten = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10].map((t) => sample(t, 1, t * 10));
    expect(estimate(ten, "p50").perChild.tokens).toBe(50);
    expect(estimate(ten, "p90").perChild.tokens).toBe(90);
    // ceil(0.95 × 10) = 10th smallest — never interpolated.
    expect(estimate(ten, "p95").perChild.tokens).toBe(100);
    expect(estimate(ten, "p95").perChild.usdMicros).toBe(microUsd(1_000));
  });

  it("flags the estimate as a lower bound when any sample is one", () => {
    const mixed = [sample(1, 1, 1), sample(2, 2, 2, true)];
    expect(estimate(mixed, "largest-seen").perChild.lowerBound).toBe(true);
    expect(estimate([sample(1, 1, 1)], "largest-seen").perChild.lowerBound).toBe(false);
  });
});

describe("estimate — nearest-rank laws (AD-5)", () => {
  it("every axis estimate is an observed sample value (MicroUsd-safe integer)", () => {
    fc.assert(fc.property(samplesArb(1), estimatorArb, (samples, e) => {
      const { perChild } = estimate(samples, e);
      for (const axis of AXES) {
        expect(axisValues(samples, axis)).toContain(perChild[axis]);
        expect(Number.isSafeInteger(perChild[axis])).toBe(true);
      }
    }), RUNS);
  });

  it("is monotone in the percentile: p50 ≤ p90 ≤ p95 ≤ largest-seen on every axis", () => {
    fc.assert(fc.property(samplesArb(0), (samples) => {
      const [p50, p90, p95, max] = (["p50", "p90", "p95", "largest-seen"] as const)
        .map((e) => estimate(samples, e).perChild);
      for (const axis of AXES) {
        expect(p50![axis]).toBeLessThanOrEqual(p90![axis]);
        expect(p90![axis]).toBeLessThanOrEqual(p95![axis]);
        expect(p95![axis]).toBeLessThanOrEqual(max![axis]);
      }
    }), RUNS);
  });

  it("largest-seen is the per-axis maximum M, and applied falls back exactly below 5 samples", () => {
    fc.assert(fc.property(samplesArb(0), estimatorArb, (samples, e) => {
      const largest = estimate(samples, "largest-seen").perChild;
      for (const axis of AXES) {
        expect(largest[axis]).toBe(Math.max(0, ...axisValues(samples, axis)));
      }
      expect(estimate(samples, e).applied).toBe(samples.length < 5 ? "largest-seen" : e);
    }), RUNS);
  });

  it("is invariant under sample order and never mutates its input", () => {
    fc.assert(fc.property(samplesArb(0), estimatorArb, fc.integer(), (samples, e, seed) => {
      const before = samples.map((s) => ({ ...s }));
      const shuffled = [...samples].sort((a, b) => ((a.tokens * 31 + seed) % 7) - ((b.tokens * 31 + seed) % 7));
      expect(estimate(shuffled, e)).toEqual(estimate(samples, e));
      expect(samples).toEqual(before);
    }), RUNS);
  });
});

const spendArb: fc.Arbitrary<Spend> = fc.record({
  tokens: count,
  calls: fc.integer({ min: 0, max: 1_000 }),
  micros: count,
}).map(({ tokens, calls, micros }) => makeSpend({
  usage: "known", tokens, calls, usd: { kind: "priced", micros: microUsd(micros) },
}));

describe("spendDelta — lifetime-window measure (AD-3)", () => {
  it("is the per-axis difference of two priced, known snapshots", () => {
    const before = addSpend(pricedCall(100, microUsd(1_000)), pricedCall(50, microUsd(500)));
    const after = addSpend(before, pricedCall(30, microUsd(250)));
    expect(spendDelta(before, after)).toEqual(sample(30, 1, 250));
  });

  it("clamps a non-monotone snapshot pair to zero per axis", () => {
    expect(spendDelta(pricedCall(100, microUsd(1_000)), NO_SPEND)).toEqual(sample(0, 0, 0));
  });

  it("measures unpriced spend by its known floor, flagged as a lower bound", () => {
    const before = pricedCall(10, microUsd(400));
    const after = addSpend(before, addSpend(unpricedCall(20, "mystery"), pricedCall(5, microUsd(100))));
    expect(spendDelta(before, after)).toEqual(sample(25, 2, 100, true));
  });

  it("flags unknown usage as a lower bound", () => {
    const before = pricedCall(10, microUsd(400));
    const after = addSpend(before, unknownUsageCall({ kind: "priced", micros: microUsd(70) }));
    expect(spendDelta(before, after)).toEqual(sample(0, 1, 70, true));
  });

  it("is exact for a lone child: the window equals the child's settled spend", () => {
    fc.assert(fc.property(spendArb, spendArb, (before, child) => {
      const s = spendDelta(before, addSpend(before, child));
      expect(s).toEqual(sample(child.tokens, child.calls, child.usd.kind === "priced" ? child.usd.micros : 0));
    }), RUNS);
  });

  it("never under-counts a child whose window overlaps concurrent siblings", () => {
    fc.assert(fc.property(spendArb, spendArb, spendArb, (before, child, sibling) => {
      const s = spendDelta(before, addSpend(addSpend(before, child), sibling));
      const exact = spendDelta(before, addSpend(before, child));
      for (const axis of AXES) expect(s[axis]).toBeGreaterThanOrEqual(exact[axis]);
    }), RUNS);
  });
});
