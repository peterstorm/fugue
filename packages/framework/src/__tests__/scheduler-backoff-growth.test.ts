// W5.4 — Exponential-backoff growth curve for `rescheduleTaskWithBackoff`.
//
// The scheduler's failure-handling re-arm doubles the delay on every
// consecutive failure and clamps at `BACKOFF_CAP_MS`. Pass-3 fixed a related
// bug (W6.11) but left the actual growth curve untested. A regression that
// flattens the curve to a constant — or removes the cap — would silently
// either hammer a failing backend on every cron tick or starve recovery
// indefinitely. This test pins the curve.

import { describe, it, expect } from "bun:test";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  computeBackoffMs,
} from "../scheduler/scheduler.js";

describe("computeBackoffMs", () => {
  it("returns BACKOFF_BASE_MS on the first failure (n=1)", () => {
    expect(computeBackoffMs(1)).toBe(BACKOFF_BASE_MS);
  });

  it("doubles for each subsequent failure until the cap", () => {
    // 2^0, 2^1, 2^2, 2^3 — exact powers-of-two growth.
    expect(computeBackoffMs(1)).toBe(BACKOFF_BASE_MS);
    expect(computeBackoffMs(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(computeBackoffMs(3)).toBe(4 * BACKOFF_BASE_MS);
    expect(computeBackoffMs(4)).toBe(8 * BACKOFF_BASE_MS);
    expect(computeBackoffMs(5)).toBe(16 * BACKOFF_BASE_MS);
  });

  it("clamps at BACKOFF_CAP_MS once 2^(n-1)*BASE exceeds the cap", () => {
    // BACKOFF_CAP_MS / BACKOFF_BASE_MS = 1800. The curve stays uncapped while
    // 2^(n-1) <= 1800 — i.e. n <= 11 — and clamps from n >= 12 onward. Walk
    // the boundary explicitly so any future cap/base tweak surfaces a test
    // failure rather than silent drift.
    const uncappedAt11 = BACKOFF_BASE_MS * Math.pow(2, 10);
    expect(uncappedAt11).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(computeBackoffMs(11)).toBe(uncappedAt11);
    expect(computeBackoffMs(12)).toBe(BACKOFF_CAP_MS);
    expect(computeBackoffMs(20)).toBe(BACKOFF_CAP_MS);
    expect(computeBackoffMs(100)).toBe(BACKOFF_CAP_MS);
  });

  it("clamps to 1 for non-positive failure counts (defensive against caller bugs)", () => {
    // The production caller `rescheduleTaskWithBackoff` only ever passes
    // `(consecutiveFailures.get(id) ?? 0) + 1`, which is >= 1. Lock the
    // clamp so a future caller bug feeding 0 / -1 cannot collapse the
    // backoff to 0ms and turn the scheduler into a tight retry loop.
    expect(computeBackoffMs(0)).toBe(BACKOFF_BASE_MS);
    expect(computeBackoffMs(-5)).toBe(BACKOFF_BASE_MS);
  });

  it("is a pure function — no hidden state between calls", () => {
    // Same input → same output, regardless of call order.
    const a = computeBackoffMs(3);
    const b = computeBackoffMs(20);
    const c = computeBackoffMs(3);
    expect(a).toBe(c);
    expect(b).toBe(BACKOFF_CAP_MS);
  });
});
