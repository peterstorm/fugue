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
  spendOfCall,
} from "../llm/cost.js";
import { NO_TOKENS, tokensOnly } from "../types/token-usage.js";
import type { TokenUsage } from "../types/token-usage.js";
import type { CacheTtl } from "../types/llm.js";
import { usdToMicros } from "../types/spend.js";

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

describe("spendOfCall: the budget-facing bridge from tokens to money", () => {
  it("measures one call on every axis a ceiling can limit", () => {
    const usage = usageOf({ tokensIn: 1000, tokensOut: 200 });
    const spend = spendOfCall(MODEL, usage);
    expect(spend.tokens).toBe(1200);
    expect(spend.calls).toBe(1);
    expect(spend.usd).toEqual({ kind: "priced", micros: usdToMicros(computeCostUsd(MODEL, usage)) });
  });

  it("prices a cached run FAR below an uncached one at identical token counts", () => {
    // This is the regression the whole cost-denominated budget exists for. A
    // token ceiling sees these two runs as identical; a dollar ceiling sees an
    // order of magnitude. If cache reads ever go back to being billed at the
    // full input rate, this fails.
    const cold = usageOf({ tokensIn: 100_000, tokensOut: 10_000 });
    const warm = usageOf({ tokensIn: 100_000, tokensOut: 10_000, cacheReadTokens: 95_000 });

    const coldSpend = spendOfCall(MODEL, cold);
    const warmSpend = spendOfCall(MODEL, warm);

    expect(warmSpend.tokens).toBe(coldSpend.tokens); // indistinguishable to a token budget
    if (coldSpend.usd.kind !== "priced" || warmSpend.usd.kind !== "priced") throw new Error("priced");
    expect(warmSpend.usd.micros).toBeLessThan(coldSpend.usd.micros);
    // 95k read at 0.1x + 5k at 1.0x = 14.5k input-equivalents vs 100k.
    expect(coldSpend.usd.micros / warmSpend.usd.micros).toBeGreaterThan(2);
  });

  it("charges the write premium at the TTL the request declared", () => {
    const usage = usageOf({ tokensIn: 50_000, cacheWriteTokens: 50_000 });
    const short = spendOfCall(MODEL, usage, "5m");
    const long = spendOfCall(MODEL, usage, "1h");
    if (short.usd.kind !== "priced" || long.usd.kind !== "priced") throw new Error("priced");
    expect(long.usd.micros).toBeGreaterThan(short.usd.micros);
    expect(long.usd.micros / short.usd.micros).toBeCloseTo(
      CACHE_WRITE_MULTIPLIER["1h"] / CACHE_WRITE_MULTIPLIER["5m"],
      5,
    );
  });

  it("returns `unpriced` — never zero — for a model with no price-table entry", () => {
    // `computeCostUsd` returns 0 and warns; that is right for a display figure
    // and wrong for a budget, where zero means FREE and an unpriced model would
    // be the cheapest possible way past a dollar ceiling.
    const spend = spendOfCall("no-such-model", usageOf({ tokensIn: 1000, tokensOut: 100 }));
    expect(spend.usd.kind).toBe("unpriced");
    if (spend.usd.kind !== "unpriced") return;
    expect([...spend.usd.models]).toEqual(["no-such-model"]);
    expect(spend.usd.knownMicros).toBe(usdToMicros(0));
    // The token axis is still exact — only cost is unknown.
    expect(spend.tokens).toBe(1100);
  });

  it("agrees with computeCostUsd for every priced model and TTL", () => {
    const ttls: readonly CacheTtl[] = ["5m", "1h"];
    fc.assert(
      fc.property(count, count, count, fc.constantFrom(...ttls), (uncached, w, r, ttl) => {
        const usage = usageOf({ tokensIn: uncached + w + r, cacheWriteTokens: w, cacheReadTokens: r });
        const spend = spendOfCall(MODEL, usage, ttl);
        if (spend.usd.kind !== "priced") throw new Error("priced");
        expect(spend.usd.micros).toBe(usdToMicros(computeCostUsd(MODEL, usage, ttl)));
      }),
    );
  });
});
