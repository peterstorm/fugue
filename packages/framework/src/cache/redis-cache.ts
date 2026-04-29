// Redis-backed Cache implementation

import type Redis from "ioredis";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import type { Cache } from "./cache.js";

const cacheError = (operation: string, message: string): FrameworkError => ({
  kind: "cache-error",
  operation,
  message,
});

export class RedisCache implements Cache {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<Result<T | null, FrameworkError>> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return ok(null);
      return ok(JSON.parse(raw) as T);
    } catch (e) {
      return err(cacheError("get", e instanceof Error ? e.message : String(e)));
    }
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSec);
      return ok(undefined);
    } catch (e) {
      return err(cacheError("set", e instanceof Error ? e.message : String(e)));
    }
  }
}
