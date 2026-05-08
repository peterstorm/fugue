// adaptBullMQJob — JobLike adapter for BullMQ Job, event log via Redis Streams
// FR-047, FR-048, AD-3

import type { Job } from "bullmq";
import type Redis from "ioredis";
import type { JobLike } from "../state-machine/types.js";
import type { EventLogOpts } from "../queue/types.js";

const DEFAULT_MAX_LEN = 10000;

/**
 * Returns the Redis Stream key for a given queue + job.
 * Default: `events:{queueName}:{jobId}` per AD-3.
 */
export const defaultStreamKey = (queueName: string, jobId: string): string =>
  `events:${queueName}:${jobId}`;

/**
 * Adapts a BullMQ `Job` to the `JobLike<S, C>` interface.
 *
 * - `updateData` calls `job.updateData` (BullMQ persists to Redis)
 * - `updateProgress` calls `job.updateProgress` (BullMQ persists to Redis)
 * - `appendEvent` writes to a Redis Stream keyed `events:{queueName}:{jobId}`
 *   using `XADD MAXLEN ~ <maxLen>` (FR-048, AD-3)
 *
 * FR-047, FR-048
 */
export function adaptBullMQJob<S, C>(
  bullJob: Job<{ state: S; context: C }>,
  redis: Redis,
  queueName: string,
  opts?: EventLogOpts,
): JobLike<S, C> {
  if (!bullJob.id) {
    throw new Error(
      `[adaptBullMQJob] BullMQ job has no id for queue "${queueName}"`,
    );
  }

  const maxLen = opts?.maxLen ?? DEFAULT_MAX_LEN;
  const approximate = opts?.approximate ?? true;
  const streamKeyFn = opts?.streamKey ?? defaultStreamKey;
  const streamKey = streamKeyFn(queueName, bullJob.id);

  return {
    get data(): { state: S; context: C } {
      return bullJob.data;
    },

    async updateData(d: { state: S; context: C }): Promise<void> {
      try {
        await bullJob.updateData(d);
      } catch (err) {
        throw new Error(
          `[BullMQ] updateData failed for queue "${queueName}" job "${bullJob.id}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },

    async updateProgress(pct: number): Promise<void> {
      try {
        await bullJob.updateProgress(pct);
      } catch (err) {
        throw new Error(
          `[BullMQ] updateProgress failed for queue "${queueName}" job "${bullJob.id}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },

    async appendEvent(event: unknown): Promise<void> {
      // XADD events:{queueName}:{jobId} MAXLEN ~ <maxLen> * type <type> payload <json>
      const eventObj = event as Record<string, unknown>;
      const type = typeof eventObj?.type === "string" ? eventObj.type : "event";
      const payload = JSON.stringify(event);

      try {
        if (approximate) {
          // XADD key MAXLEN ~ maxLen * field value ...
          await redis.xadd(
            streamKey,
            "MAXLEN",
            "~",
            maxLen,
            "*",
            "type",
            type,
            "payload",
            payload,
          );
        } else {
          await redis.xadd(
            streamKey,
            "MAXLEN",
            maxLen,
            "*",
            "type",
            type,
            "payload",
            payload,
          );
        }
      } catch (err) {
        throw new Error(
          `[BullMQ] appendEvent failed for queue "${queueName}" job "${bullJob.id}" stream "${streamKey}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
