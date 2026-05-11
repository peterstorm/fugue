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
 * Atomic dedup-then-XADD via a single Lua script.
 *
 * The previous two-step XREVRANGE + XADD relied on BullMQ holding the per-job
 * lock to be race-free. Long Redis latency or a lock-window exceedance could
 * admit duplicates. The script collapses both operations into one
 * round-trip evaluated atomically by Redis.
 *
 * Returns the new entry ID on success or the literal string "skipped" when
 * the dedup matched.
 *
 * KEYS[1] = stream key
 * ARGV[1] = maxLen
 * ARGV[2] = "1" for MAXLEN ~ (approximate), "0" for MAXLEN (exact)
 * ARGV[3] = entry ID hint (e.g. "1715200000000-*")
 * ARGV[4] = dedupKey ("" when no dedup)
 * ARGV[5] = type
 * ARGV[6] = payload
 */
const APPEND_EVENT_SCRIPT = `
local stream = KEYS[1]
local maxlen = ARGV[1]
local approximate = ARGV[2]
local entryId = ARGV[3]
local dedupKey = ARGV[4]
local entryType = ARGV[5]
local payload = ARGV[6]

if dedupKey ~= "" then
  local last = redis.call("XREVRANGE", stream, "+", "-", "COUNT", 1)
  if last and #last > 0 then
    local fields = last[1][2]
    for i = 1, #fields, 2 do
      if fields[i] == "dedupKey" and fields[i+1] == dedupKey then
        return "skipped"
      end
    end
  end
end

local result
if dedupKey ~= "" then
  if approximate == "1" then
    result = redis.call("XADD", stream, "MAXLEN", "~", maxlen, entryId,
      "type", entryType, "payload", payload, "dedupKey", dedupKey)
  else
    result = redis.call("XADD", stream, "MAXLEN", maxlen, entryId,
      "type", entryType, "payload", payload, "dedupKey", dedupKey)
  end
else
  if approximate == "1" then
    result = redis.call("XADD", stream, "MAXLEN", "~", maxlen, entryId,
      "type", entryType, "payload", payload)
  else
    result = redis.call("XADD", stream, "MAXLEN", maxlen, entryId,
      "type", entryType, "payload", payload)
  end
end
return result
`.trim();

// Per-client EVALSHA hash cache, lazy SCRIPT LOAD.
const appendEventShaByClient = new WeakMap<object, string>();

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

      // Atomic dedup + XADD via single Lua script. Single round-trip and
      // truly race-free regardless of BullMQ lock-window timing. Script is
      // SCRIPT-LOADed lazily; NOSCRIPT recovers via inline EVAL on next call.
      const argv = [
        String(maxLen),
        approximate ? "1" : "0",
        id,
        dedupKey ?? "",
        type,
        payload,
      ];

      const runScript = async (): Promise<unknown> => {
        let sha = appendEventShaByClient.get(redis);
        if (!sha) {
          sha = (await redis.script("LOAD", APPEND_EVENT_SCRIPT)) as string;
          appendEventShaByClient.set(redis, sha);
        }
        try {
          return await redis.evalsha(sha, 1, streamKey, ...argv);
        } catch (e) {
          if (e instanceof Error && e.message.includes("NOSCRIPT")) {
            appendEventShaByClient.delete(redis);
            return await redis.eval(APPEND_EVENT_SCRIPT, 1, streamKey, ...argv);
          }
          throw e;
        }
      };

      try {
        const result = await runScript();
        // Lua returns the literal string "skipped" when dedup matched — no-op
        // on the caller's behalf, matching the previous two-step contract.
        void result;
      } catch (err) {
        throw new Error(
          `[BullMQ] appendEvent failed for queue "${queueName}" job "${bullJob.id}" stream "${streamKey}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
