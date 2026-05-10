// adaptBullMQJob — JobLike adapter for BullMQ Job, event log via Redis Streams
// FR-047, FR-048, AD-3

import type { Job } from "bullmq";
import type Redis from "ioredis";
import type { JobLike, RecordedEvent } from "../state-machine/types.js";
import type { EventLogOpts } from "../queue/types.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { serializeValue, deserializeValue } from "../state-machine/serialize.js";

const DEFAULT_MAX_LEN = 10000;

/**
 * Options for `adaptBullMQJob` — the existing `EventLogOpts` is extended with a
 * data validator so the adapter remains a single-arg call (additive change).
 *
 * Without `validateData`, the adapter trusts that whoever wrote `bullJob.data`
 * produced a `{ state, context }` envelope; a corrupted or schema-drifted
 * payload surfaces only when the consumer misinterprets it. Supplying a
 * validator surfaces drift at the read boundary as `checkpoint-corrupt`.
 */
export type AdaptBullMQJobOpts = EventLogOpts & {
  readonly validateData?: (
    raw: unknown,
  ) => Result<{ state: unknown; context: unknown }, FrameworkError>;
};

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
  opts?: AdaptBullMQJobOpts,
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
  const now = opts?.now ?? Date.now;
  const validateData = opts?.validateData;

  return {
    get data(): { state: S; context: C } {
      // BullMQ stores the value enqueued/written via updateData. We tag Map/Set
      // on write (serializeValue), so reading must invert that tagging.
      const raw = deserializeValue(bullJob.data);
      if (validateData) {
        const result = validateData(raw);
        if (!result.ok) {
          throw new Error(
            `[adaptBullMQJob] data validation failed for queue "${queueName}" job "${bullJob.id}": ${result.error.kind === "checkpoint-corrupt" ? result.error.message : String(result.error)}`,
            { cause: result.error },
          );
        }
        return result.value as { state: S; context: C };
      }
      return raw as { state: S; context: C };
    },

    async updateData(d: { state: S; context: C }): Promise<void> {
      try {
        await bullJob.updateData(serializeValue(d) as { state: S; context: C });
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

    async appendEvent(event: unknown, dedupKey?: string): Promise<void> {
      // XADD events:{queueName}:{jobId} MAXLEN ~ <maxLen> ${recordedAtMs}-*
      //   type <type> payload <json> [dedupKey <key>]
      const eventObj = event as Record<string, unknown>;
      const type = typeof eventObj?.type === "string" ? eventObj.type : "event";
      // Wrap the event in a RecordedEvent envelope so wall-clock time is
      // captured at the durable-write boundary, transport-independent.
      // Events may carry node outputs containing Map/Set; tag them for JSON.
      const recordedAtMs = now();
      const envelope: RecordedEvent<unknown> = { recordedAtMs, event };
      const payload = JSON.stringify(serializeValue(envelope));
      // Pin the entry ID's ms portion to recordedAtMs so XRANGE bounds (used
      // by readEventsBetween) align with the envelope timestamp. Redis
      // auto-increments the seq portion on collision (`${ms}-*`).
      // Monotonic constraint: each XADD must produce an ID strictly greater
      // than the previous; non-decreasing now() satisfies this. If a caller
      // injects a now() that goes backwards, Redis rejects with an error.
      const id = `${recordedAtMs}-*`;

      try {
        // Idempotency: if a dedupKey is supplied, look at the most recent
        // stream entry and skip the XADD when its `dedupKey` field matches.
        // BullMQ holds the per-job lock during processing, so this two-step
        // check-then-write is race-free relative to other workers on the
        // same job.
        if (dedupKey !== undefined) {
          const last = (await redis.xrevrange(streamKey, "+", "-", "COUNT", 1)) as
            | Array<[string, string[]]>
            | null;
          if (last && last.length > 0) {
            const fields = last[0][1];
            for (let i = 0; i < fields.length; i += 2) {
              if (fields[i] === "dedupKey" && fields[i + 1] === dedupKey) {
                return; // Already appended for this transition; no-op.
              }
            }
          }
        }

        const args: (string | number)[] = approximate
          ? [streamKey, "MAXLEN", "~", maxLen, id, "type", type, "payload", payload]
          : [streamKey, "MAXLEN", maxLen, id, "type", type, "payload", payload];
        if (dedupKey !== undefined) {
          args.push("dedupKey", dedupKey);
        }
        // ioredis types are weak around xadd's variadic shape; cast at the call site.
        await (redis.xadd as unknown as (...a: (string | number)[]) => Promise<unknown>)(...args);
      } catch (err) {
        throw new Error(
          `[BullMQ] appendEvent failed for queue "${queueName}" job "${bullJob.id}" stream "${streamKey}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
