// Wave 7 §7.6 — applyJitter is deterministic when the RNG is injected.

import { describe, it, expect } from "bun:test";
import { applyJitter } from "../shared/jitter.js";

describe("applyJitter", () => {
  it("is symmetric around the base delay (random=0.5 returns the base)", () => {
    // (0.5 * 2 - 1) * 0.2 = 0 → 1000 * 1 = 1000
    expect(applyJitter(1000, 0.2, () => 0.5)).toBe(1000);
  });

  it("subtracts up to jitterRatio when random=0 (the negative bound)", () => {
    // (0 * 2 - 1) * 0.2 = -0.2 → 1000 * 0.8 = 800
    expect(applyJitter(1000, 0.2, () => 0)).toBe(800);
  });

  it("adds up to jitterRatio when random=1 (the positive bound)", () => {
    // (1 * 2 - 1) * 0.2 = 0.2 → 1000 * 1.2 = 1200
    expect(applyJitter(1000, 0.2, () => 1)).toBe(1200);
  });

  it("returns an integer (Math.round applied)", () => {
    // 333 * (1 + 0.123) ≈ 373.959 → rounds to 374
    const r = applyJitter(333, 0.123, () => 1);
    expect(Number.isInteger(r)).toBe(true);
  });

  it("is deterministic with a seeded RNG", () => {
    const rng = () => 0.314;
    const r1 = applyJitter(2000, 0.3, rng);
    const r2 = applyJitter(2000, 0.3, rng);
    expect(r1).toBe(r2);
  });
});
