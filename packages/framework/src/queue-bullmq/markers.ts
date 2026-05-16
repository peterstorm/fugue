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
      // SET key value EX ttl — overwrites existing key and resets TTL
      await redis.set(key, "1", "EX", Math.ceil(ttlSeconds));
    },

    async exists(key: string): Promise<boolean> {
      const count = await redis.exists(key);
      return count > 0;
    },

    async delete(key: string): Promise<void> {
      await redis.del(key);
    },
  };
}
