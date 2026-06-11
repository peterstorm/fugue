/**
 * Tests for the pure token cache (domain/token-cache.ts).
 *
 * Covers: the half-open freshness boundary (`now < expiresAt`), the
 * miss-is-not-an-error contract (FR-X-003), and the SC-008 property — within a
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

describe("lookup — miss is NOT an error (FR-X-003)", () => {
  it("an absent key reads as undefined, never an Err", () => {
    const result = lookup(emptyCache, cacheKey("a", "b", "c"), 0);
    expect(result).toBeUndefined();
  });

  it("an expired-but-present key also reads as undefined (treated as a miss)", () => {
    const key = cacheKey("a", "b", "c");
    const cache = store(emptyCache, key, cacheToken("tok", 0, 100));
    // now == expiresAt → stale → miss
    expect(lookup(cache, key, 100)).toBeUndefined();
    // well past expiry → miss
    expect(lookup(cache, key, 500)).toBeUndefined();
  });

  it("a fresh present key returns the cached token", () => {
    const key = cacheKey("a", "b", "c");
    const entry = cacheToken("tok-xyz", 0, 100);
    const cache = store(emptyCache, key, entry);
    expect(lookup(cache, key, 50)).toEqual(entry);
  });
});

describe("store — immutable, pure", () => {
  it("does not mutate the input cache", () => {
    const key = cacheKey("a", "b", "c");
    const next = store(emptyCache, key, cacheToken("t", 0, 10));
    expect(emptyCache.entries[key]).toBeUndefined();
    expect(next.entries[key]).toBeDefined();
  });

  it("overwrites an existing key (post-mint refresh path)", () => {
    const key = cacheKey("a", "b", "c");
    const c1 = store(emptyCache, key, cacheToken("old", 0, 100));
    const c2 = store(c1, key, cacheToken("new", 200, 100));
    expect(lookup(c2, key, 250)?.token).toBe("new");
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
          const cache = store(emptyCache, key, entry);

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
          const cache = store(emptyCache, key, cacheToken(token, storedAt, ttl));
          // now = expiresAt + extra  ⇒  now >= expiresAt ⇒ stale ⇒ miss.
          const now = storedAt + ttl + extra;
          expect(lookup(cache, key, now)).toBeUndefined();
        },
      ),
    );
  });
});
