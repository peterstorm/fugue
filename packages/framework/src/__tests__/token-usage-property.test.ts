/**
 * Property tests for the `TokenUsage` value type — the algebra every token
 * figure in the framework flows through.
 *
 * Pins INV-PC-1 (the cache split never exceeds the inclusive prompt total),
 * INV-PC-2 (`addUsage` is a monoid over `NO_TOKENS`) and INV-PC-3 (the derived
 * uncached remainder is non-negative).
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import {
  NO_TOKENS,
  addUsage,
  cacheHitRatio,
  isCacheInert,
  tokensOnly,
  totalTokens,
  uncachedInputTokens,
} from "../types/token-usage.js";
import type { TokenUsage } from "../types/token-usage.js";

/** Counts as a provider reports them: non-negative integers. */
const count = fc.nat({ max: 1_000_000 });

/**
 * A well-formed usage value: the cache split is a partition of the inclusive
 * prompt total, so `cacheWrite + cacheRead <= tokensIn` holds by construction —
 * the shape both clients normalise to.
 */
const arbUsage: fc.Arbitrary<TokenUsage> = fc
  .tuple(count, count, count, count)
  .map(([uncached, write, read, tokensOut]) => ({
    tokensIn: uncached + write + read,
    tokensOut,
    cacheWriteTokens: write,
    cacheReadTokens: read,
  }));

describe("TokenUsage — INV-PC-1: the cache split never exceeds the prompt total", () => {
  it("holds for every well-formed value", () => {
    fc.assert(
      fc.property(arbUsage, (u) => {
        expect(u.cacheWriteTokens + u.cacheReadTokens).toBeLessThanOrEqual(u.tokensIn);
      }),
    );
  });

  it("is preserved by addUsage", () => {
    fc.assert(
      fc.property(arbUsage, arbUsage, (a, b) => {
        const sum = addUsage(a, b);
        expect(sum.cacheWriteTokens + sum.cacheReadTokens).toBeLessThanOrEqual(sum.tokensIn);
      }),
    );
  });
});

describe("TokenUsage — INV-PC-2: addUsage is a monoid over NO_TOKENS", () => {
  it("has NO_TOKENS as a two-sided identity", () => {
    fc.assert(
      fc.property(arbUsage, (u) => {
        expect(addUsage(u, NO_TOKENS)).toEqual(u);
        expect(addUsage(NO_TOKENS, u)).toEqual(u);
      }),
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(arbUsage, arbUsage, arbUsage, (a, b, c) => {
        expect(addUsage(addUsage(a, b), c)).toEqual(addUsage(a, addUsage(b, c)));
      }),
    );
  });

  it("is commutative, so turn ordering cannot change a run total", () => {
    fc.assert(
      fc.property(arbUsage, arbUsage, (a, b) => {
        expect(addUsage(a, b)).toEqual(addUsage(b, a));
      }),
    );
  });

  it("folds a turn sequence to the same total regardless of fold direction", () => {
    fc.assert(
      fc.property(fc.array(arbUsage, { maxLength: 12 }), (turns) => {
        const left = turns.reduce(addUsage, NO_TOKENS);
        const right = [...turns].reverse().reduce(addUsage, NO_TOKENS);
        expect(left).toEqual(right);
      }),
    );
  });
});

describe("TokenUsage — INV-PC-3: derived figures stay in range", () => {
  it("never derives a negative uncached remainder, even from an inconsistent provider report", () => {
    fc.assert(
      fc.property(count, count, count, count, (tokensIn, tokensOut, write, read) => {
        // Deliberately UNCONSTRAINED: a provider that reports a cache split
        // exceeding its own total must not produce a negative charge.
        const hostile: TokenUsage = {
          tokensIn,
          tokensOut,
          cacheWriteTokens: write,
          cacheReadTokens: read,
        };
        expect(uncachedInputTokens(hostile)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("partitions the prompt total exactly for well-formed values", () => {
    fc.assert(
      fc.property(arbUsage, (u) => {
        expect(uncachedInputTokens(u) + u.cacheWriteTokens + u.cacheReadTokens).toBe(u.tokensIn);
      }),
    );
  });

  it("keeps the cache hit ratio in [0, 1]", () => {
    fc.assert(
      fc.property(arbUsage, (u) => {
        const ratio = cacheHitRatio(u);
        expect(ratio).toBeGreaterThanOrEqual(0);
        expect(ratio).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("totals every token that crossed the wire", () => {
    fc.assert(
      fc.property(arbUsage, (u) => {
        expect(totalTokens(u)).toBe(u.tokensIn + u.tokensOut);
      }),
    );
  });
});

describe("TokenUsage — constructors", () => {
  it("tokensOnly reports no cache activity, so it is always inert", () => {
    fc.assert(
      fc.property(count, count, (tIn, tOut) => {
        const u = tokensOnly(tIn, tOut);
        expect(u.cacheWriteTokens).toBe(0);
        expect(u.cacheReadTokens).toBe(0);
        expect(uncachedInputTokens(u)).toBe(tIn);
        expect(isCacheInert(u)).toBe(true);
      }),
    );
  });

  it("flags a call as inert exactly when it neither wrote nor read a cache entry", () => {
    fc.assert(
      fc.property(arbUsage, (u) => {
        expect(isCacheInert(u)).toBe(u.cacheWriteTokens === 0 && u.cacheReadTokens === 0);
      }),
    );
  });

  it("NO_TOKENS is frozen — the identity cannot be mutated by a consumer", () => {
    expect(Object.isFrozen(NO_TOKENS)).toBe(true);
  });
});
