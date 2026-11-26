/**
 * Self-test of the latency budget harness the acceptance budgets (AS-036,
 * NFR-002, NFR-003) are measured with.
 */

import { describe, expect, test } from "bun:test";
import { TIMED_SAMPLES, WARM_UP_ITERATIONS, measureLatency, nearestRankPercentile } from "./latency-budget.js";

const oneTo = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i + 1);

describe("nearestRankPercentile", () => {
  test("the p95 of 1..100 is 95", () => {
    expect(nearestRankPercentile(oneTo(100), 95)).toBe(95);
  });

  test("ignores input order", () => {
    expect(nearestRankPercentile([...oneTo(100)].reverse(), 95)).toBe(95);
  });

  test("is the smallest sample with at least the percentile at or below it", () => {
    expect(nearestRankPercentile(oneTo(10), 95)).toBe(10);
    expect(nearestRankPercentile(oneTo(10), 50)).toBe(5);
    expect(nearestRankPercentile(oneTo(100), 100)).toBe(100);
    expect(nearestRankPercentile([7], 95)).toBe(7);
  });

  test("throws on empty input", () => {
    expect(() => nearestRankPercentile([], 95)).toThrow(RangeError);
  });

  test("throws on a percentile outside (0, 100]", () => {
    expect(() => nearestRankPercentile(oneTo(10), 0)).toThrow(RangeError);
    expect(() => nearestRankPercentile(oneTo(10), 101)).toThrow(RangeError);
  });
});

describe("measureLatency", () => {
  test("discards the warm-ups, times every sample, and prepares outside the timed region", async () => {
    let prepared = 0;
    let ran = 0;
    const report = await measureLatency({
      label: "self-test",
      budgetMs: 50,
      prepare: () => {
        prepared += 1;
        return prepared;
      },
      run: async () => {
        ran += 1;
      },
      warmUps: 3,
      samples: 20,
    });
    expect(prepared).toBe(23);
    expect(ran).toBe(23);
    expect(report).toMatchObject({ label: "self-test", budgetMs: 50, warmUps: 3, samples: 20 });
    expect(report.p50Ms).toBeLessThanOrEqual(report.p95Ms);
    expect(report.p95Ms).toBeLessThanOrEqual(report.maxMs);
  });

  test("defaults to 50 warm-ups and 500 timed samples", async () => {
    let ran = 0;
    const report = await measureLatency({
      label: "self-test defaults",
      budgetMs: 50,
      prepare: () => undefined,
      run: async () => {
        ran += 1;
      },
    });
    expect(WARM_UP_ITERATIONS).toBe(50);
    expect(TIMED_SAMPLES).toBe(500);
    expect(report.warmUps).toBe(WARM_UP_ITERATIONS);
    expect(report.samples).toBe(TIMED_SAMPLES);
    expect(ran).toBe(WARM_UP_ITERATIONS + TIMED_SAMPLES);
  });
});
