/**
 * Redis cache connection failure path tests.
 * Verifies that IO exceptions from ioredis are wrapped into Result.err({kind: "cache-error"})
 * without propagating as unhandled rejections.
 */
import { describe, test, expect } from "bun:test";
import { RedisCache } from "../cache/redis-cache.js";
import { z } from "zod";

/** Mock ioredis that throws on all operations. */
const makeFailingRedis = (errorMsg: string) => ({
  get: () => { throw new Error(errorMsg); },
  set: () => { throw new Error(errorMsg); },
  setex: () => { throw new Error(errorMsg); },
  del: () => { throw new Error(errorMsg); },
});

describe("RedisCache — connection failure paths", () => {
  test("get() returns cache-error on connection failure", async () => {
    const cache = new RedisCache(makeFailingRedis("ECONNREFUSED") as any);
    const result = await cache.get("test-key", z.unknown());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });

  test("set() returns cache-error on connection failure", async () => {
    const cache = new RedisCache(makeFailingRedis("ETIMEDOUT") as any);
    const result = await cache.set("test-key", { data: "value" }, 3600);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });
});
