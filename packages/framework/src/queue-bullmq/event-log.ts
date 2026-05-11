// createRedisStreamReader — XRANGE-backed EventLogReader for replay (FR-048, AD-3)
// Only queue-bullmq/** may import ioredis (FR-082)

import type Redis from "ioredis";
import type { EventLogOpts } from "../queue/types.js";
import type { RecordedEvent } from "../state-machine/types.js";
import { defaultStreamKey } from "./job.js";
import { deserializeValue } from "../state-machine/serialize.js";

// ---------------------------------------------------------------------------
// EventLogReader interface — opaque read handle used by replay
// ---------------------------------------------------------------------------

/**
 * Read-side interface for the per-job event log.
 * The write-side (`appendEvent`) lives on `JobLike` / `adaptBullMQJob`.
 *
 * Returns `RecordedEvent<unknown>` envelopes — each entry has the
 * domain `event` plus the `recordedAtMs` wall-clock timestamp captured
 * at the original `appendEvent` call. For payloads written before the
 * envelope contract existed, `recordedAtMs` is derived from the Redis
 * Stream entry ID (which is also a millisecond timestamp).
 *
 * Implementations:
 *   - `createRedisStreamReader` (BullMQ adapter) — XRANGE-backed
 *   - In-memory: use the `.events` array on `InMemoryJob` directly
 *     (each entry is already a `RecordedEvent<unknown>` envelope).
 */
export interface EventLogReader {
  /**
   * Read all events for a job in insertion order, wrapped in
   * `RecordedEvent<unknown>` envelopes.
   */
  readEvents(queueName: string, jobId: string): Promise<readonly RecordedEvent<unknown>[]>;

  /**
   * Read only events recorded in the half-open interval `[fromMs, toMs)`.
   * Backends that can push the filter down (Redis: `XRANGE` with
   * ms-prefixed entry IDs) should do so. Backends without ID-based
   * filtering should filter post-fetch.
   *
   * Useful for forensic queries ("what was the state at T?") in
   * combination with `replayEventsUntil` / `replayEventSlice`.
   */
  readEventsBetween(
    queueName: string,
    jobId: string,
    fromMs: number,
    toMs: number,
  ): Promise<readonly RecordedEvent<unknown>[]>;
}

// ---------------------------------------------------------------------------
// Redis Streams reader (XRANGE)
// ---------------------------------------------------------------------------

/**
 * Creates an `EventLogReader` backed by Redis Streams (XRANGE).
 *
 * Reads from key `events:{queueName}:{jobId}` (or the override from `opts.streamKey`).
 * Each stream entry stores `type` and `payload` fields; we parse `payload` as JSON.
 * New events are wrapped in `RecordedEvent` envelopes by the writer; legacy
 * events (bare payloads) are detected and given a `recordedAtMs` derived
 * from the stream entry ID timestamp portion.
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
    ): Promise<readonly RecordedEvent<unknown>[]> {
      const key = streamKeyFn(queueName, jobId);
      // XRANGE key - + returns all entries in insertion order
      const entries = await redis.xrange(key, "-", "+");
      return entries.map(([entryId, fields]) => parseEnvelope(key, entryId, fields));
    },

    async readEventsBetween(
      queueName: string,
      jobId: string,
      fromMs: number,
      toMs: number,
    ): Promise<readonly RecordedEvent<unknown>[]> {
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        throw new RangeError(
          `[readEventsBetween] fromMs and toMs must be finite numbers; got fromMs=${fromMs}, toMs=${toMs}`,
        );
      }
      if (toMs < fromMs) {
        throw new RangeError(
          `[readEventsBetween] toMs (${toMs}) must be >= fromMs (${fromMs})`,
        );
      }
      const key = streamKeyFn(queueName, jobId);
      // Empty range → no entries possible. Avoid issuing XRANGE with malformed bounds.
      if (toMs === fromMs) return [];
      // Stream entry IDs are `${ms}-${seq}`. XRANGE bounds are inclusive.
      // For the half-open semantic [fromMs, toMs):
      //   start = `${fromMs}-0`           (first entry at or after fromMs)
      //   end   = `${toMs - 1}-18446744073709551615`  (last entry strictly before toMs)
      // Redis treats entry IDs lexicographically with ms.seq numeric ordering;
      // using max u64 as the seq portion of the end bound captures every
      // entry recorded at the (toMs - 1)-th millisecond.
      const start = `${fromMs}-0`;
      const end = `${toMs - 1}-18446744073709551615`;
      const entries = await redis.xrange(key, start, end);
      return entries.map(([entryId, fields]) => parseEnvelope(key, entryId, fields));
    },
  };
}

// ---------------------------------------------------------------------------
// Envelope parsing (handles both new envelope format and legacy bare payloads)
// ---------------------------------------------------------------------------

/**
 * Parse one Redis Stream entry into a `RecordedEvent<unknown>` envelope.
 *
 * Forward-compatible across the envelope rollout:
 * - **New format**: payload is a JSON-encoded `{ recordedAtMs, event }` envelope.
 *   Used as-is after `deserializeValue` restores Map/Set tagging.
 * - **Legacy format**: payload is the raw domain event (no envelope wrapper).
 *   Detected by absence of both `recordedAtMs` and `event` fields. The
 *   envelope is synthesized with `recordedAtMs` parsed from the stream
 *   entry ID's millisecond prefix (`1715200000000-0` → `1715200000000`).
 */
function parseEnvelope(
  streamKey: string,
  entryId: string,
  fields: string[],
): RecordedEvent<unknown> {
  const payloadIndex = fields.indexOf("payload");
  if (payloadIndex === -1 || payloadIndex + 1 >= fields.length) {
    // No payload field — fall back to reconstructing from all fields.
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return {
      recordedAtMs: parseEntryIdTimestamp(entryId),
      event: obj,
    };
  }

  const raw = fields[payloadIndex + 1];
  let parsed: unknown;
  try {
    parsed = deserializeValue(JSON.parse(raw));
  } catch (parseErr) {
    console.warn(
      `[readEvents] JSON.parse failed for stream "${streamKey}" entry "${entryId}":`,
      parseErr,
      "raw value:",
      raw,
    );
    throw new Error(
      `[readEvents] Corrupt event in stream "${streamKey}" entry "${entryId}": ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      { cause: parseErr },
    );
  }

  if (isEnvelope(parsed)) return parsed;
  // Legacy bare payload: synthesize the envelope from the entry ID timestamp.
  return {
    recordedAtMs: parseEntryIdTimestamp(entryId),
    event: parsed,
  };
}

/**
 * Type guard for the new envelope shape. Forward-compatible: extra fields are
 * allowed (we only check the required keys), so adding `workerId` /
 * `correlationId` later does not break this check.
 */
function isEnvelope(v: unknown): v is RecordedEvent<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    "recordedAtMs" in v &&
    typeof (v as { recordedAtMs: unknown }).recordedAtMs === "number" &&
    "event" in v
  );
}

/**
 * Wave 3 §3.8 — track IDs we've already warned about so a corrupt stream
 * doesn't fill the log. Bounded so a degenerate stream can't grow this
 * indefinitely.
 */
const warnedMalformedIds = new Set<string>();
const MAX_WARNED_IDS = 1000;

/**
 * Parse the millisecond prefix from a Redis Stream entry ID
 * (`1715200000000-0` → `1715200000000`). Falls back to `0` if the ID is
 * malformed — that should never happen for entries Redis itself produced,
 * but we don't want a single corrupt entry to crash the reader.
 *
 * Wave 3 §3.8: log once per unique malformed ID. The `0` fallback maps to
 * the Unix epoch, so silently accepting it makes forensic time-range queries
 * unreliable; the warn gives operators a signal that the stream has been
 * manually mutated or contains pre-envelope-format data.
 */
function parseEntryIdTimestamp(entryId: string): number {
  const dashIdx = entryId.indexOf("-");
  const msStr = dashIdx === -1 ? entryId : entryId.slice(0, dashIdx);
  const ms = Number(msStr);
  if (Number.isFinite(ms)) return ms;
  if (warnedMalformedIds.size < MAX_WARNED_IDS && !warnedMalformedIds.has(entryId)) {
    warnedMalformedIds.add(entryId);
    console.warn(
      `[event-log] malformed Redis Stream entry ID "${entryId}" — falling back to recordedAtMs=0. Forensic time-range queries against this entry will be inaccurate.`,
    );
  }
  return 0;
}
