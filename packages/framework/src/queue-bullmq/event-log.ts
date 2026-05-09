// createRedisStreamReader — XRANGE-backed EventLogReader for replay (FR-048, AD-3)
// Only queue-bullmq/** may import ioredis (FR-082)

import type Redis from "ioredis";
import type { EventLogOpts } from "../queue/types.js";
import { defaultStreamKey } from "./job.js";
import { deserializeValue } from "../state-machine/serialize.js";

// ---------------------------------------------------------------------------
// EventLogReader interface — opaque read handle used by replay
// ---------------------------------------------------------------------------

/**
 * Read-side interface for the per-job event log.
 * The write-side (`appendEvent`) lives on `JobLike` / `adaptBullMQJob`.
 *
 * Implementations:
 *   - `createRedisStreamReader` (BullMQ adapter) — XRANGE-backed
 *   - In-memory: use the `.events` array on `InMemoryJob` directly
 */
export interface EventLogReader {
  /**
   * Read all events for a job in insertion order.
   * Returns raw event objects parsed from stored JSON payloads.
   */
  readEvents(queueName: string, jobId: string): Promise<readonly unknown[]>;
}

// ---------------------------------------------------------------------------
// Redis Streams reader (XRANGE)
// ---------------------------------------------------------------------------

/**
 * Creates an `EventLogReader` backed by Redis Streams (XRANGE).
 *
 * Reads from key `events:{queueName}:{jobId}` (or the override from `opts.streamKey`).
 * Each stream entry stores `type` and `payload` fields; we parse `payload` as JSON.
 *
 * FR-048, AD-3
 */
export function createRedisStreamReader(
  redis: Redis,
  opts?: Pick<EventLogOpts, "streamKey">,
): EventLogReader {
  const streamKeyFn = opts?.streamKey ?? defaultStreamKey;

  return {
    async readEvents(
      queueName: string,
      jobId: string,
    ): Promise<readonly unknown[]> {
      const key = streamKeyFn(queueName, jobId);

      // XRANGE key - + returns all entries in insertion order
      // Each entry: [id, [field, value, field, value, ...]]
      const entries = await redis.xrange(key, "-", "+");

      return entries.map(([entryId, fields]) => {
        // fields is a flat array: [field, value, field, value, ...]
        const payloadIndex = fields.indexOf("payload");
        if (payloadIndex !== -1 && payloadIndex + 1 < fields.length) {
          const raw = fields[payloadIndex + 1];
          try {
            // Inverse of serializeValue in appendEvent — restores Map/Set.
            return deserializeValue(JSON.parse(raw));
          } catch (parseErr) {
            console.warn(
              `[readEvents] JSON.parse failed for stream "${key}" entry "${entryId}":`,
              parseErr,
              "raw value:", raw,
            );
            throw new Error(
              `[readEvents] Corrupt event in stream "${key}" entry "${entryId}": ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
              { cause: parseErr },
            );
          }
        }
        // Fallback: reconstruct object from all field-value pairs
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        return obj;
      });
    },
  };
}
