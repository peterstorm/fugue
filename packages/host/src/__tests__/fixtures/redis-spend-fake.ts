import type { RedisSpendAppend } from "../../ports.js";
import {
  recordOf,
  SPEND_HASH_FIELDS,
  SPEND_MARKER_VALUE,
  SPEND_USAGE_UNKNOWN_FIELD,
  unpricedModelHashField,
} from "../../domain/spend-record.js";

/** Apply the Redis spend transaction's commutative hash update in a plain test store. */
export const applyRedisSpendAppend = (
  hashes: Map<string, Map<string, string>>,
  append: RedisSpendAppend,
): void => {
  const record = recordOf(append.delta);
  const hash = hashes.get(append.key) ?? new Map<string, string>();
  if (record.usageUnknown) hash.set(SPEND_USAGE_UNKNOWN_FIELD, SPEND_MARKER_VALUE);
  for (const model of record.unpricedModels) {
    hash.set(unpricedModelHashField(model), SPEND_MARKER_VALUE);
  }
  for (const [field, by] of [
    [SPEND_HASH_FIELDS.micros, record.micros],
    [SPEND_HASH_FIELDS.tokens, record.tokens],
    [SPEND_HASH_FIELDS.calls, record.calls],
  ] as const) {
    if (by !== 0) hash.set(field, String(Number(hash.get(field) ?? "0") + by));
  }
  if (hash.size > 0) hashes.set(append.key, hash);
};
