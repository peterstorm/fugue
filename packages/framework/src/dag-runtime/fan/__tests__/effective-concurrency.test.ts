/**
 * Effective fan concurrency (FR-002, FR-033): `min(authored, host cap)`, with
 * `clamped` set exactly when the host cap lowered the authored value.
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { effectiveConcurrency } from "../effective-concurrency.js";
import {
  childConcurrency,
  DEFAULT_FAN_CONCURRENCY_CAP,
  fanConcurrencyCap,
} from "../../../types/fan-scheduling.js";

describe("effectiveConcurrency", () => {
  it("keeps an authored value below the cap, unclamped", () => {
    expect(effectiveConcurrency(childConcurrency(3), fanConcurrencyCap(8))).toEqual({ effective: childConcurrency(3), clamped: false });
  });

  it("keeps an authored value equal to the cap, unclamped", () => {
    expect(effectiveConcurrency(childConcurrency(8), fanConcurrencyCap(8))).toEqual({ effective: childConcurrency(8), clamped: false });
  });

  it("clamps an authored value above the cap to the cap", () => {
    expect(effectiveConcurrency(childConcurrency(12), DEFAULT_FAN_CONCURRENCY_CAP)).toEqual({ effective: childConcurrency(8), clamped: true });
  });

  it("clamps every fan to 1 under a host maximum of 1", () => {
    expect(effectiveConcurrency(childConcurrency(4), fanConcurrencyCap(1))).toEqual({ effective: childConcurrency(1), clamped: true });
  });

  it("is min(authored, cap), at least 1, and clamped iff authored > cap", () => {
    const positive = fc.integer({ min: 1, max: 10_000 });
    fc.assert(fc.property(positive, positive, (authored, cap) => {
      const { effective, clamped } = effectiveConcurrency(childConcurrency(authored), fanConcurrencyCap(cap));
      expect(effective).toBe(childConcurrency(Math.min(authored, cap)));
      expect(effective).toBeGreaterThanOrEqual(1);
      expect(clamped).toBe(authored > cap);
    }), { numRuns: 1_000 });
  });
});
