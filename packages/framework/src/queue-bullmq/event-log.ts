// createRedisStreamReader — XRANGE-backed EventLogReader for replay
// ioredis is imported here and by the three named Redis adapter files
// (see the check-imports.ts Enforces list)

import type Redis from "ioredis";
import type { EventLogOpts, EventLogReader } from "../queue/types.js";
import type { RecordedEvent } from "../state-machine/types.js";
import { defaultStreamKey } from "./job.js";
import { deserializeValue } from "../state-machine/serialize.js";
import { fwLogger } from "../logger.js";

// `EventLogReader` lives in `queue/types.ts` so both backends can implement it
// without coupling to BullMQ. Re-export here for prior consumers.
export type { EventLogReader };

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
      // Redis compares entry IDs as numeric uint64 pairs (ms field, then seq
      // field) — NOT lexicographically; using max u64 as the seq portion of
      // the end bound captures every entry recorded at the (toMs - 1)-th
      // millisecond precisely because that ordering is numeric.
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
    const { recordedAtMs, synthetic } = parseEntryIdTimestamp(entryId);
    return synthetic
      ? { recordedAtMs, event: obj, synthetic }
      : { recordedAtMs, event: obj };
  }

  const raw = fields[payloadIndex + 1];
  let parsed: unknown;
  try {
    parsed = deserializeValue(JSON.parse(raw));
  } catch (parseErr) {
    fwLogger().warn(
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
  const { recordedAtMs, synthetic } = parseEntryIdTimestamp(entryId);
  return synthetic
    ? { recordedAtMs, event: parsed, synthetic }
    : { recordedAtMs, event: parsed };
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
 * Total count of malformed entry IDs seen this process. Used to log at
 * decaying frequency so a degenerate stream cannot flood the log, but also
 * cannot silently suppress the warning past a cap once enough unique IDs
 * have rolled through. The first 10 occurrences always log; after that, log
 * every `MALFORMED_LOG_INTERVAL`-th occurrence with the cumulative count.
 */
let malformedIdCount = 0;
const MALFORMED_LOG_FIRST_N = 10;
const MALFORMED_LOG_INTERVAL = 100;

/**
 * Test-only reset hook. The framework barrel does not re-export this — it is
 * for test isolation between files that share the Bun module cache.
 */
export function __resetEventLogState(): void {
  malformedIdCount = 0;
}

/**
 * Test-only re-export of the parser so unit tests can exercise the
 * warning-frequency contract without standing up Redis.
 */
export const __parseEntryIdTimestamp = (
  entryId: string,
): { recordedAtMs: number; synthetic: boolean } => parseEntryIdTimestamp(entryId);

/**
 * Parse the millisecond prefix from a Redis Stream entry ID
 * (`1715200000000-0` → `1715200000000`). Falls back to `0` if the ID is
 * malformed — that should never happen for entries Redis itself produced,
 * but we don't want a single corrupt entry to crash the reader. The
 * malformed case is flagged via `synthetic: true` so downstream consumers
 * (forensic queries, replay-to-timestamp) can skip these entries instead
 * of silently including them at the epoch start.
 *
 * Logs the first 10 occurrences, then every 100th. Replaces the bounded-set
 * approach that silently suppressed warnings once 1000 unique malformed IDs
 * had been seen — operators need a signal even when the stream is being
 * mutated at scale.
 */
function parseEntryIdTimestamp(
  entryId: string,
): { recordedAtMs: number; synthetic: boolean } {
  const dashIdx = entryId.indexOf("-");
  const msStr = dashIdx === -1 ? entryId : entryId.slice(0, dashIdx);
  const ms = Number(msStr);
  if (Number.isFinite(ms)) return { recordedAtMs: ms, synthetic: false };
  malformedIdCount += 1;
  const shouldLog =
    malformedIdCount <= MALFORMED_LOG_FIRST_N ||
    malformedIdCount % MALFORMED_LOG_INTERVAL === 0;
  if (shouldLog) {
    fwLogger().warn(
      `[event-log] malformed Redis Stream entry ID "${entryId}" — falling back to recordedAtMs=0 (total malformed seen: ${malformedIdCount}). Forensic time-range queries against this entry will be inaccurate.`,
    );
  }
  return { recordedAtMs: 0, synthetic: true };
}
