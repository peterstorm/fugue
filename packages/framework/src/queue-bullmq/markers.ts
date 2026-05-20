// createRedisMarkerStore — Redis-backed MarkerStore with TTL
// Only queue-bullmq/** may import ioredis (enforced by check-imports.ts)

import type Redis from "ioredis";
import type { MarkerStore } from "../queue/types.js";

/**
 * Redis-backed MarkerStore using `SET key 1 EX ttlSeconds` for TTL-bounded markers.
 *
 * - `set`   → `SET key 1 EX ttlSeconds`  (re-set resets TTL)
 * - `exists` → `EXISTS key`
 * - `delete` → `DEL key`
 *
 * FR-043
 */
export function createRedisMarkerStore(redis: Redis): MarkerStore {
  return {
    async set(key: string, ttlSeconds: number): Promise<void> {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new RangeError(
          `ttlSeconds must be a finite positive number, got ${ttlSeconds}`,
        );
      }
      try {
        await redis.set(key, "1", "EX", Math.ceil(ttlSeconds));
      } catch (e) {
        throw new Error(
          `[RedisMarkerStore] set failed for key "${key}": ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    async exists(key: string): Promise<boolean> {
      try {
        const count = await redis.exists(key);
        return count > 0;
      } catch (e) {
        throw new Error(
          `[RedisMarkerStore] exists failed for key "${key}": ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await redis.del(key);
      } catch (e) {
        throw new Error(
          `[RedisMarkerStore] delete failed for key "${key}": ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    },
  };
}
