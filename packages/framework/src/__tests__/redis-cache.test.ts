import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import Redis from "ioredis";
import { RedisCache } from "../cache/redis-cache.js";
import { InMemoryCache } from "../cache/cache.js";
import type { Cache } from "../cache/cache.js";
import { stableHash } from "../cache/hash.js";

// --- Shared test suite for any Cache ---

function cacheSuite(name: string, factory: () => Cache) {
  describe(name, () => {
    let cache: Cache;

    beforeEach(() => {
      cache = factory();
    });

    test("get returns null on miss", async () => {
      const result = await cache.get("nonexistent");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });

    test("set + get round-trips correctly", async () => {
      const data = { foo: 1, bar: [2, 3] };
      const setRes = await cache.set("k1", data, 60);
      expect(setRes.ok).toBe(true);

      const getRes = await cache.get<typeof data>("k1");
      expect(getRes.ok).toBe(true);
      if (getRes.ok) expect(getRes.value).toEqual(data);
    });

    test("set + get round-trips string values", async () => {
      const setRes = await cache.set("k2", "hello", 60);
      expect(setRes.ok).toBe(true);

      const getRes = await cache.get<string>("k2");
      expect(getRes.ok).toBe(true);
      if (getRes.ok) expect(getRes.value).toBe("hello");
    });
  });
}

// --- InMemoryCache (always runs) ---

cacheSuite("InMemoryCache", () => new InMemoryCache());

describe("InMemoryCache TTL", () => {
  test("expired entries return null", async () => {
    const cache = new InMemoryCache();
    await cache.set("ttl-key", "value", 0); // 0 second TTL = already expired
    // Small delay to ensure expiry
    await new Promise((r) => setTimeout(r, 10));
    const res = await cache.get("ttl-key");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });
});

// --- stableHash tests (always run) ---

describe("stableHash", () => {
  test("produces consistent results", () => {
    const h1 = stableHash({ a: 1, b: 2 });
    const h2 = stableHash({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  test("different key-order objects hash equal", () => {
    const h1 = stableHash({ a: 1, b: 2, c: 3 });
    const h2 = stableHash({ c: 3, a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  test("nested objects with different key order hash equal", () => {
    const h1 = stableHash({ outer: { x: 1, y: 2 }, z: 3 });
    const h2 = stableHash({ z: 3, outer: { y: 2, x: 1 } });
    expect(h1).toBe(h2);
  });

  test("different values produce different hashes", () => {
    const h1 = stableHash({ a: 1 });
    const h2 = stableHash({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  test("returns 16 character hex string", () => {
    const h = stableHash("test");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test("handles null, arrays, numbers, booleans", () => {
    expect(stableHash(null)).toBe(stableHash(null));
    expect(stableHash([1, 2, 3])).toBe(stableHash([1, 2, 3]));
    expect(stableHash(true)).toBe(stableHash(true));
    expect(stableHash(42)).toBe(stableHash(42));
  });
});

// --- RedisCache (skip if Redis unavailable) ---
//
// Gates on `process.env.REDIS_URL` at module-load time. See the comment in
// redis-checkpointer.test.ts for the rationale.

const REDIS_URL = process.env.REDIS_URL;
const hasRedis = Boolean(REDIS_URL);

let redis: Redis | null = null;

beforeAll(async () => {
  if (!hasRedis) return;
  redis = new Redis(REDIS_URL!, { lazyConnect: true, connectTimeout: 2000 });
  await redis.connect();
});

afterAll(async () => {
  if (redis) await redis.quit();
});

const TEST_PREFIX = "cache:test:";

const describeRedis = hasRedis ? describe : describe.skip;

describeRedis("RedisCache", () => {
  let cache: RedisCache;

  beforeEach(async () => {
    cache = new RedisCache(redis!);
    // Clean up test keys
    const keys = await redis!.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) await redis!.del(...keys);
  });

  test("get returns null on miss", async () => {
    const result = await cache.get(`${TEST_PREFIX}nonexistent`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  test("set + get round-trips correctly", async () => {
    const data = { foo: 1, bar: [2, 3] };
    const setRes = await cache.set(`${TEST_PREFIX}k1`, data, 60);
    expect(setRes.ok).toBe(true);

    const getRes = await cache.get<typeof data>(`${TEST_PREFIX}k1`);
    expect(getRes.ok).toBe(true);
    if (getRes.ok) expect(getRes.value).toEqual(data);
  });

  test("TTL is set on key", async () => {
    await cache.set(`${TEST_PREFIX}ttl`, "val", 10);
    const ttl = await redis!.ttl(`${TEST_PREFIX}ttl`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });

  test("expired key returns null", async () => {
    await cache.set(`${TEST_PREFIX}exp`, "val", 1);
    await new Promise((r) => setTimeout(r, 1100));
    const res = await cache.get(`${TEST_PREFIX}exp`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });
});
