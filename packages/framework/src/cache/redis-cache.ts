// Redis-backed Cache implementation

import type Redis from "ioredis";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { ok, err } from "../types/result.js";
import type { Cache } from "./cache.js";
import { fwLogger } from "../logger.js";

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
      const message = `key="${key}": ${e instanceof Error ? e.message : String(e)}`;
      fwLogger().warn(`[RedisCache.get] ${message}`);
      return err(cacheError("get", message));
    }
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSec);
      return ok(undefined);
    } catch (e) {
      const message = `key="${key}": ${e instanceof Error ? e.message : String(e)}`;
      fwLogger().warn(`[RedisCache.set] ${message}`);
      return err(cacheError("set", message));
    }
  }
}
