/**
 * Tests for the pure token cache (domain/token-cache.ts).
 *
 * Covers: the half-open freshness boundary (`now < expiresAt`), the
 * miss-is-not-an-error contract (FR-503), and the SC-008 property — within a
 * TTL window a key resolves to the SAME cached token, so the broker mints at
 * most once per (identity,audience,scope) per window.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import {
  cacheKey,
  cacheToken,
  isFresh,
  lookup,
  store,
  emptyCache,
  effectiveTtlMs,
  TOKEN_REFRESH_SKEW_MS,
  type CachedToken,
} from "../token-cache.js";

describe("cacheKey", () => {
  it("is deterministic for the same triple", () => {
    expect(cacheKey("sub-1", "https://graph", "mail.send")).toBe(
      cacheKey("sub-1", "https://graph", "mail.send"),
    );
  });

  it("is injective: shifting a delimiter boundary does not alias (collision-proof separator)", () => {
    // With a `:`-like separator, `a` + `b:c` and `a:b` + `c` would collide.
    // The control-char delimiter keeps these distinct.
    const k1 = cacheKey("a", "b", "c:d");
    const k2 = cacheKey("a", "b:c", "d");
    expect(k1).not.toBe(k2);
  });

  it("distinct triples produce distinct keys across each axis", () => {
    const base = cacheKey("id", "aud", "scope");
    expect(cacheKey("id2", "aud", "scope")).not.toBe(base);
    expect(cacheKey("id", "aud2", "scope")).not.toBe(base);
    expect(cacheKey("id", "aud", "scope2")).not.toBe(base);
  });
});

describe("isFresh — half-open boundary [storedAt, expiresAt)", () => {
  const entry: CachedToken = { token: "tok", expiresAt: 1000 };

  it("is fresh strictly before expiry (just-fresh)", () => {
    expect(isFresh(entry, 999)).toBe(true);
  });

  it("is STALE exactly at expiry (now === expiresAt)", () => {
    expect(isFresh(entry, 1000)).toBe(false);
  });

  it("is stale just after expiry (just-expired)", () => {
    expect(isFresh(entry, 1001)).toBe(false);
  });

  it("cacheToken encodes expiresAt = storedAt + ttl", () => {
    const t = cacheToken("tok", 500, 250);
    expect(t.expiresAt).toBe(750);
    expect(isFresh(t, 749)).toBe(true);
    expect(isFresh(t, 750)).toBe(false);
  });
});

describe("lookup — miss is NOT an error (FR-503)", () => {
  it("an absent key reads as undefined, never an Err", () => {
    const result = lookup(emptyCache, cacheKey("a", "b", "c"), 0);
    expect(result).toBeUndefined();
  });

  it("an expired-but-present key also reads as undefined (treated as a miss)", () => {
    const key = cacheKey("a", "b", "c");
    const cache = store(emptyCache, key, cacheToken("tok", 0, 100), 0);
    // now == expiresAt → stale → miss
    expect(lookup(cache, key, 100)).toBeUndefined();
    // well past expiry → miss
    expect(lookup(cache, key, 500)).toBeUndefined();
  });

  it("a fresh present key returns the cached token", () => {
    const key = cacheKey("a", "b", "c");
    const entry = cacheToken("tok-xyz", 0, 100);
    const cache = store(emptyCache, key, entry, 0);
    expect(lookup(cache, key, 50)).toEqual(entry);
  });
});

describe("store — immutable, pure", () => {
  it("does not mutate the input cache", () => {
    const key = cacheKey("a", "b", "c");
    const next = store(emptyCache, key, cacheToken("t", 0, 10), 0);
    expect(emptyCache.entries[key]).toBeUndefined();
    expect(next.entries[key]).toBeDefined();
  });

  it("overwrites an existing key (post-mint refresh path)", () => {
    const key = cacheKey("a", "b", "c");
    const c1 = store(emptyCache, key, cacheToken("old", 0, 100), 0);
    const c2 = store(c1, key, cacheToken("new", 200, 100), 200);
    expect(lookup(c2, key, 250)?.token).toBe("new");
  });
});

describe("store — sweeps stale entries at store time (A2: bounded growth, no expired bearers retained)", () => {
  it("drops entries already stale at store time and keeps fresh ones", () => {
    const staleKey = cacheKey("a", "b", "c");
    const freshKey = cacheKey("d", "e", "f");
    const newKey = cacheKey("g", "h", "i");
    let cache = store(emptyCache, staleKey, cacheToken("stale-bearer", 0, 100), 0); // expires at 100
    cache = store(cache, freshKey, cacheToken("fresh-bearer", 0, 10_000), 0); // expires at 10_000

    // Store a new entry at t=100: `staleKey` is stale (half-open boundary) and
    // must be SWEPT — the expired bearer string is gone, not just unreadable.
    const swept = store(cache, newKey, cacheToken("new-bearer", 100, 100), 100);

    expect(swept.entries[staleKey]).toBeUndefined();
    expect(swept.entries[freshKey]?.token).toBe("fresh-bearer");
    expect(swept.entries[newKey]?.token).toBe("new-bearer");
    expect(Object.keys(swept.entries).length).toBe(2);
  });

  it("the sweep is pure — the input cache keeps its (stale) entries", () => {
    const staleKey = cacheKey("a", "b", "c");
    const cache = store(emptyCache, staleKey, cacheToken("stale", 0, 100), 0);
    store(cache, cacheKey("x", "y", "z"), cacheToken("t", 500, 100), 500);
    expect(cache.entries[staleKey]).toBeDefined();
  });

  it("repeated stores of distinct expired triples never grow the cache past the fresh set", () => {
    // The unbounded-growth shape: many distinct triples, each expiring before
    // the next store. Without the sweep the cache would hold all N entries.
    let cache = emptyCache;
    for (let i = 0; i < 50; i++) {
      const t = i * 1_000;
      cache = store(cache, cacheKey(`id-${i}`, "aud", "scope"), cacheToken(`tok-${i}`, t, 500), t);
    }
    // Every prior entry was stale at each subsequent store → only the last survives.
    expect(Object.keys(cache.entries)).toEqual([cacheKey("id-49", "aud", "scope")]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SC-008 property: ≤ 1 mint per (identity,audience,scope) per TTL window.
//
// Modelled purely: store ONE entry minted at `storedAt` with TTL `ttl`, then
// for ANY two lookup times both within `[storedAt, storedAt + ttl)` the lookup
// returns the SAME cached entry as fresh. A fresh hit means "reuse, do not
// mint", so two in-window lookups never trigger a second mint — exactly ≤ 1
// mint per window. @satisfies SC-008
// ───────────────────────────────────────────────────────────────────────────

describe("SC-008 property: a key is reused (not re-minted) within its TTL window", () => {
  it("any two lookups inside [storedAt, storedAt+ttl) see the same fresh entry", () => {
    fc.assert(
      fc.property(
        fc.string(), // identity
        fc.string(), // audience
        fc.string(), // scope
        fc.string(), // token value
        fc.nat({ max: 1_000_000 }), // storedAt
        fc.integer({ min: 1, max: 1_000_000 }), // ttl (> 0 so the window is non-empty)
        fc.nat({ max: 999_999 }), // offset1 into the window (capped below by ttl)
        fc.nat({ max: 999_999 }), // offset2 into the window
        (identity, audience, scope, token, storedAt, ttl, o1, o2) => {
          const key = cacheKey(identity, audience, scope);
          const entry = cacheToken(token, storedAt, ttl);
          const cache = store(emptyCache, key, entry, storedAt);

          // Two arbitrary instants STRICTLY inside the freshness window.
          const t1 = storedAt + (o1 % ttl);
          const t2 = storedAt + (o2 % ttl);

          const hit1 = lookup(cache, key, t1);
          const hit2 = lookup(cache, key, t2);

          // Both are fresh hits → both reuse the SAME token → at most one mint.
          expect(hit1).toEqual(entry);
          expect(hit2).toEqual(entry);
          expect(hit1?.token).toBe(hit2?.token as string);
        },
      ),
    );
  });

  it("at or beyond the window boundary the entry is a miss (mint is then required)", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        fc.string(),
        fc.nat({ max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }), // extra time at/after the boundary
        (identity, audience, scope, token, storedAt, ttl, extra) => {
          const key = cacheKey(identity, audience, scope);
          const cache = store(emptyCache, key, cacheToken(token, storedAt, ttl), storedAt);
          // now = expiresAt + extra  ⇒  now >= expiresAt ⇒ stale ⇒ miss.
          const now = storedAt + ttl + extra;
          expect(lookup(cache, key, now)).toBeUndefined();
        },
      ),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Early-refresh margin (review I2): the effective TTL a freshly minted token is
// cached for. Bounds, not a recomputation: never longer than the token's real
// lifetime, never shorter than half of it, and short of it by exactly the skew
// once the lifetime is long enough to afford the full margin.
// ───────────────────────────────────────────────────────────────────────────

describe("effectiveTtlMs — early-refresh margin with a half-lifetime floor", () => {
  const expiresInSec = fc.integer({ min: 1, max: 86_400 });

  it("caches strictly inside the real lifetime and never below half of it", () => {
    fc.assert(
      fc.property(expiresInSec, (sec) => {
        const lifetimeMs = sec * 1000;
        const ttl = effectiveTtlMs(sec);
        expect(ttl).toBeLessThan(lifetimeMs);
        expect(ttl * 2).toBeGreaterThanOrEqual(lifetimeMs);
      }),
    );
  });

  it("refreshes exactly TOKEN_REFRESH_SKEW_MS early once the lifetime affords the full margin", () => {
    fc.assert(
      fc.property(fc.integer({ min: (2 * TOKEN_REFRESH_SKEW_MS) / 1000, max: 86_400 }), (sec) => {
        expect(sec * 1000 - effectiveTtlMs(sec)).toBe(TOKEN_REFRESH_SKEW_MS);
      }),
    );
  });

  it("is monotone: a longer-lived token is never cached for less time", () => {
    fc.assert(
      fc.property(expiresInSec, expiresInSec, (a, b) => {
        const [shorter, longer] = a <= b ? [a, b] : [b, a];
        expect(effectiveTtlMs(shorter)).toBeLessThanOrEqual(effectiveTtlMs(longer));
      }),
    );
  });

  it("is total over every double: always a finite number >= 0, and 0 exactly for a non-finite or non-positive lifetime", () => {
    fc.assert(
      fc.property(fc.double(), (sec) => {
        const ttl = effectiveTtlMs(sec);
        expect(Number.isFinite(ttl)).toBe(true);
        expect(ttl).toBeGreaterThanOrEqual(0);
        const uncacheable = !Number.isFinite(sec) || sec <= 0;
        expect(ttl === 0).toBe(uncacheable);
      }),
    );
  });

  it("names the uncacheable lifetimes explicitly: NaN, ±Infinity, 0 and negatives all yield 0", () => {
    for (const sec of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, -1, -86_400]) {
      expect(effectiveTtlMs(sec)).toBe(0);
    }
  });
});

describe("store — an uncacheable (0 TTL) token is never bound", () => {
  it("for any lifetime effectiveTtlMs reads as uncacheable, the stored key is a miss at the store instant and the input entry for the key is superseded", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 0), fc.double({ max: 0 })),
        fc.nat({ max: 1_000_000 }),
        (sec, storedAt) => {
          const key = cacheKey("id", "aud", "scope");
          const prior = store(emptyCache, key, cacheToken("old", storedAt, 10_000), storedAt);
          const next = store(prior, key, cacheToken("new", storedAt, effectiveTtlMs(sec)), storedAt);
          expect(next.entries[key]).toBeUndefined();
          expect(lookup(next, key, storedAt)).toBeUndefined();
        },
      ),
    );
  });
});
