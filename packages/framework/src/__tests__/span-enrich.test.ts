// span-enrich.test.ts — Tests for LLM cost calculation and content filtering
// Finding #18: cost calculation had no unit test.

import { describe, it, expect } from "bun:test";
import { computeCostUsd, PRICE_TABLE } from "../llm/cost.js";
import { resolveContentFilter } from "../tracing/content-filter.js";

// ---------------------------------------------------------------------------
// computeCostUsd — pure cost calculation
// ---------------------------------------------------------------------------

describe("computeCostUsd", () => {
  it("computes correct cost for a known model (gpt-4o)", () => {
    const rates = PRICE_TABLE["gpt-4o"]!;
    const tokensIn = 1000;
    const tokensOut = 500;
    const expected = (tokensIn * rates.inputPer1M + tokensOut * rates.outputPer1M) / 1_000_000;
    expect(computeCostUsd("gpt-4o", tokensIn, tokensOut)).toBeCloseTo(expected, 10);
  });

  it("computes correct cost for Anthropic model", () => {
    const rates = PRICE_TABLE["claude-sonnet-4-20250514"]!;
    const tokensIn = 2000;
    const tokensOut = 1000;
    const expected = (tokensIn * rates.inputPer1M + tokensOut * rates.outputPer1M) / 1_000_000;
    expect(computeCostUsd("claude-sonnet-4-20250514", tokensIn, tokensOut)).toBeCloseTo(expected, 10);
  });

  it("returns 0 for unknown model", () => {
    expect(computeCostUsd("unknown-model-xyz", 5000, 2000)).toBe(0);
  });

  it("returns 0 for zero tokens on known model", () => {
    expect(computeCostUsd("gpt-4o", 0, 0)).toBe(0);
  });

  it("handles large token counts correctly", () => {
    const rates = PRICE_TABLE["gpt-4o"]!;
    const tokensIn = 1_000_000;
    const tokensOut = 500_000;
    const expected = (tokensIn * rates.inputPer1M + tokensOut * rates.outputPer1M) / 1_000_000;
    expect(computeCostUsd("gpt-4o", tokensIn, tokensOut)).toBeCloseTo(expected, 10);
    // Sanity: 1M input tokens at $2.5/M + 500K output at $10/M = $7.50
    expect(computeCostUsd("gpt-4o", tokensIn, tokensOut)).toBeCloseTo(7.5, 2);
  });

  it("all PRICE_TABLE models produce non-negative costs", () => {
    for (const [model, rates] of Object.entries(PRICE_TABLE)) {
      const cost = computeCostUsd(model, 100, 100);
      expect(cost).toBeGreaterThanOrEqual(0);
      // Every model should have a positive rate for at least one direction
      expect(rates.inputPer1M + rates.outputPer1M).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveContentFilter — content redaction logic
// ---------------------------------------------------------------------------

describe("resolveContentFilter", () => {
  it("returns null when contentFilter is explicitly null", () => {
    const filter = resolveContentFilter({ contentFilter: null });
    expect(filter).toBeNull();
  });

  it("returns the provided filter function when set", () => {
    const myFilter = (s: string) => s.slice(0, 10);
    const filter = resolveContentFilter({ contentFilter: myFilter });
    expect(filter).toBe(myFilter);
    expect(filter!("hello world this is long")).toBe("hello worl");
  });

  it("returns identity filter when includeContent is true (deprecated path)", () => {
    const filter = resolveContentFilter({ includeContent: true });
    expect(filter).not.toBeNull();
    expect(filter!("secret")).toBe("secret");
  });

  it("returns null when includeContent is false (deprecated path)", () => {
    const filter = resolveContentFilter({ includeContent: false });
    expect(filter).toBeNull();
  });
});
