import type { RedisSpendAppend } from "../../ports.js";
import {
  addSpendRecordInteger,
  recordOf,
  SPEND_HASH_FIELDS,
  SPEND_MARKER_VALUE,
  SPEND_USAGE_UNKNOWN_FIELD,
  unpricedModelHashField,
} from "../../domain/spend-record.js";

/**
 * The marker half of a spend record: set-once fields whose write is identical in
 * both appliers below, and which carry no read-modify-write to interleave. Only
 * the numeric accumulation differs between them, so only that stays duplicated.
 */
const writeMarkerFields = (
  hash: Map<string, string>,
  record: ReturnType<typeof recordOf>,
): void => {
  if (record.usageUnknown) hash.set(SPEND_USAGE_UNKNOWN_FIELD, SPEND_MARKER_VALUE);
  for (const model of record.unpricedModels) {
    hash.set(unpricedModelHashField(model), SPEND_MARKER_VALUE);
  }
};

/** Apply the Redis spend transaction's commutative hash update in a plain test store. */
export const applyRedisSpendAppend = (
  hashes: Map<string, Map<string, string>>,
  append: RedisSpendAppend,
): void => {
  const record = recordOf(append.delta);
  const hash = hashes.get(append.key) ?? new Map<string, string>();
  writeMarkerFields(hash, record);
  for (const [field, by] of [
    [SPEND_HASH_FIELDS.micros, record.micros],
    [SPEND_HASH_FIELDS.tokens, record.tokens],
    [SPEND_HASH_FIELDS.calls, record.calls],
  ] as const) {
    if (by !== 0) {
      hash.set(field, String(addSpendRecordInteger(Number(hash.get(field) ?? "0"), by)));
    }
  }
  if (hash.size > 0) hashes.set(append.key, hash);
};

/**
 * The same commutative update, but yielding between the read and the write of
 * each field so concurrent appends genuinely interleave.
 *
 * `applyRedisSpendAppend` is synchronous, so a `Promise.all` over it never
 * yields mid-append and the "concurrent" appends in fact run strictly in
 * sequence — the race it is meant to model cannot occur. Real Redis makes the
 * whole read-modify-write atomic (WATCH/MULTI/EXEC); this deliberately does
 * NOT, so a ledger that re-did any part of that accumulation around the port
 * instead of inside it loses updates and the test catches it.
 */
export const applyRedisSpendAppendInterleaved = async (
  hashes: Map<string, Map<string, string>>,
  append: RedisSpendAppend,
): Promise<void> => {
  const record = recordOf(append.delta);
  const hash = hashes.get(append.key) ?? new Map<string, string>();
  writeMarkerFields(hash, record);
  for (const [field, by] of [
    [SPEND_HASH_FIELDS.micros, record.micros],
    [SPEND_HASH_FIELDS.tokens, record.tokens],
    [SPEND_HASH_FIELDS.calls, record.calls],
  ] as const) {
    if (by === 0) continue;
    const current = Number(hash.get(field) ?? "0");
    // THE interleaving point: another append may run to completion here.
    await Promise.resolve();
    hash.set(field, String(addSpendRecordInteger(current, by)));
  }
  if (hash.size > 0) hashes.set(append.key, hash);
};
