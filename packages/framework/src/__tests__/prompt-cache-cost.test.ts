/**
 * Cache-aware cost — INV-PC-4.
 *
 * The point of the token breakdown is that the three prompt-token classes are
 * NOT interchangeable: a cache read is billed at ~0.1x and a write at a
 * premium. A cost function that ignored the split would report a cached run as
 * costing the same as an uncached one, which is the exact question caching is
 * supposed to answer.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  computeCostUsd,
  costRatesFor,
  costUsd,
} from "../llm/cost.js";
import { NO_TOKENS, tokensOnly } from "../types/token-usage.js";
import type { TokenUsage } from "../types/token-usage.js";
import type { CacheTtl } from "../types/llm.js";

const MODEL = "gpt-4o"; // 2.5 in / 10.0 out per 1M
const RATES = costRatesFor(MODEL);
const count = fc.nat({ max: 100_000 });

const usageOf = (over: Partial<TokenUsage>): TokenUsage => {
  const cacheWriteTokens = over.cacheWriteTokens ?? 0;
  const cacheReadTokens = over.cacheReadTokens ?? 0;
  return {
    tokensIn: over.tokensIn ?? cacheWriteTokens + cacheReadTokens,
    tokensOut: over.tokensOut ?? 0,
    cacheWriteTokens,
    cacheReadTokens,
  };
};

describe("cache multipliers", () => {
  it("prices a cache read at a tenth of an uncached token", () => {
    const uncached = computeCostUsd(MODEL, tokensOnly(1_000_000, 0));
    const cached = computeCostUsd(
      MODEL,
      usageOf({ tokensIn: 1_000_000, cacheReadTokens: 1_000_000 }),
    );
    expect(uncached).toBeCloseTo(2.5, 10);
    expect(cached).toBeCloseTo(2.5 * CACHE_READ_MULTIPLIER, 10);
  });

  it("prices a 5m cache write at 1.25x and a 1h write at 2x", () => {
    const write = usageOf({ tokensIn: 1_000_000, cacheWriteTokens: 1_000_000 });
    expect(computeCostUsd(MODEL, write, "5m")).toBeCloseTo(2.5 * 1.25, 10);
    expect(computeCostUsd(MODEL, write, "1h")).toBeCloseTo(2.5 * 2.0, 10);
    expect(CACHE_WRITE_MULTIPLIER["5m"]).toBe(1.25);
    expect(CACHE_WRITE_MULTIPLIER["1h"]).toBe(2.0);
  });

  it("defaults to the 5m write premium when no TTL is given", () => {
    const write = usageOf({ tokensIn: 1_000, cacheWriteTokens: 1_000 });
    expect(computeCostUsd(MODEL, write)).toBe(computeCostUsd(MODEL, write, "5m"));
  });

  it("charges an uncached call exactly what it charged before caching existed", () => {
    fc.assert(
      fc.property(count, count, (tIn, tOut) => {
        const legacy = (tIn * RATES.inputPer1M + tOut * RATES.outputPer1M) / 1_000_000;
        expect(computeCostUsd(MODEL, tokensOnly(tIn, tOut))).toBeCloseTo(legacy, 10);
      }),
    );
  });
});

describe("INV-PC-4 — cost is monotonic and cache reads are strictly cheaper", () => {
  it("charges strictly less for a cached prompt token than an uncached one", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (n) => {
        const uncached = computeCostUsd(MODEL, tokensOnly(n, 0));
        const cachedRead = computeCostUsd(MODEL, usageOf({ tokensIn: n, cacheReadTokens: n }));
        expect(cachedRead).toBeLessThan(uncached);
      }),
    );
  });

  it("charges strictly MORE for a cache write than an uncached token — the opt-in's price", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (n) => {
        const uncached = computeCostUsd(MODEL, tokensOnly(n, 0));
        const written = computeCostUsd(MODEL, usageOf({ tokensIn: n, cacheWriteTokens: n }));
        expect(written).toBeGreaterThan(uncached);
      }),
    );
  });

  it("never returns a negative cost, even for an inconsistent provider report", () => {
    fc.assert(
      fc.property(count, count, count, count, (tokensIn, tokensOut, w, r) => {
        const hostile: TokenUsage = {
          tokensIn,
          tokensOut,
          cacheWriteTokens: w,
          cacheReadTokens: r,
        };
        expect(computeCostUsd(MODEL, hostile)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("is monotonic in every token field", () => {
    fc.assert(
      fc.property(count, fc.integer({ min: 1, max: 1000 }), (base, delta) => {
        const start = usageOf({ tokensIn: base, tokensOut: base });
        const moreOutput = { ...start, tokensOut: start.tokensOut + delta };
        const moreInput = { ...start, tokensIn: start.tokensIn + delta };
        expect(computeCostUsd(MODEL, moreOutput)).toBeGreaterThan(computeCostUsd(MODEL, start));
        expect(computeCostUsd(MODEL, moreInput)).toBeGreaterThan(computeCostUsd(MODEL, start));
      }),
    );
  });

  it("costs nothing for no tokens", () => {
    expect(computeCostUsd(MODEL, NO_TOKENS)).toBe(0);
  });
});

describe("costUsd / computeCostUsd share one implementation", () => {
  it("agrees for every priced model and TTL", () => {
    const ttls: readonly CacheTtl[] = ["5m", "1h"];
    fc.assert(
      fc.property(count, count, count, fc.constantFrom(...ttls), (uncached, w, r, ttl) => {
        const usage = usageOf({ tokensIn: uncached + w + r, cacheWriteTokens: w, cacheReadTokens: r });
        expect(costUsd(costRatesFor(MODEL), usage, ttl)).toBe(computeCostUsd(MODEL, usage, ttl));
      }),
    );
  });

  it("returns 0 for an unpriced model on both paths", () => {
    const usage = usageOf({ tokensIn: 1000, cacheReadTokens: 500, tokensOut: 100 });
    expect(computeCostUsd("no-such-model", usage)).toBe(0);
    expect(costUsd(costRatesFor("no-such-model"), usage)).toBe(0);
  });
});
