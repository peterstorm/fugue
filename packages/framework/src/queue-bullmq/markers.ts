// createRedisMarkerStore — Redis-backed MarkerStore with TTL
// ioredis is imported here and by the three named Redis adapter files
// (see the check-imports.ts Enforces list)

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
/**
 * THE one Redis-failure rewrap for this store: name the operation and the key,
 * preserve the driver error as `cause`. Each method differs only in the label
 * and the call, so the message shape (and the `cause` chain a caller needs to
 * classify a connection drop) lives here rather than in three copies.
 */
const redisOp = async <T>(op: string, key: string, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    throw new Error(
      `[RedisMarkerStore] ${op} failed for key "${key}": ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
};

export function createRedisMarkerStore(redis: Redis): MarkerStore {
  return {
    async set(key: string, ttlSeconds: number): Promise<void> {
      // Argument validation is the CALLER's bug, not a Redis failure — it must
      // stay outside `redisOp` so it is never rewrapped as one.
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new RangeError(
          `ttlSeconds must be a finite positive number, got ${ttlSeconds}`,
        );
      }
      await redisOp("set", key, () => redis.set(key, "1", "EX", Math.ceil(ttlSeconds)));
    },

    async exists(key: string): Promise<boolean> {
      return (await redisOp("exists", key, () => redis.exists(key))) > 0;
    },

    async delete(key: string): Promise<void> {
      await redisOp("delete", key, () => redis.del(key));
    },
  };
}
