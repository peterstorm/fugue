/**
 * Pure Redis Spend Record encoding.
 *
 * One Redis HASH is the aggregate: numeric axes use their established fields,
 * while unknown-usage and unpriced-model membership use reserved marker fields.
 * One HGETALL prevents split-key reads; strict parsing protects every present
 * field. Transactional append plus the monotone unknown marker preserves the
 * accounting state that admission relies on.
 */

import type { Result, Spend } from "@fuguejs/framework";
import { costFloor, err, makeSpend, microUsd, ok, unpricedModels } from "@fuguejs/framework";

interface SpendRecord {
  readonly usageUnknown: boolean;
  readonly tokens: number;
  readonly calls: number;
  readonly micros: number;
  readonly unpricedModels: readonly string[];
}

/** Numeric hash fields. Reserved marker fields cannot collide with these. */
export const SPEND_HASH_FIELDS = Object.freeze({
  micros: "micros",
  tokens: "tokens",
  calls: "calls",
});

/** `$` cannot start a numeric axis; fixed-width UTF-16 hex makes each model one field. */
const SPEND_UNPRICED_FIELD_PREFIX = "$unpriced:";
export const SPEND_MARKER_VALUE = "1";
export const SPEND_USAGE_UNKNOWN_FIELD = "$usage:unknown";

type SpendHashParseError = Readonly<{
  kind: "malformed-spend-hash";
  field: string;
  reason: "unknown-field" | "invalid-numeric-value" | "invalid-marker-field" | "invalid-marker-value";
}>;

/** Flatten a trusted domain Spend for the transactional writer. */
export const recordOf = (spend: Spend): SpendRecord => ({
  usageUnknown: spend.usage === "unknown",
  tokens: spend.tokens,
  calls: spend.calls,
  micros: costFloor(spend.usd),
  unpricedModels: spend.usd.kind === "unpriced" ? [...spend.usd.models] : [],
});

/**
 * Canonical collision-proof hash field for one unpriced model.
 *
 * JavaScript strings are UTF-16 code-unit sequences, not guaranteed Unicode
 * scalar-value sequences. Encoding each code unit as four lowercase hex digits
 * is therefore total and reversible even for empty strings and lone surrogates.
 */
export const unpricedModelHashField = (model: string): string => {
  let encoded = "";
  for (let index = 0; index < model.length; index++) {
    encoded += model.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `${SPEND_UNPRICED_FIELD_PREFIX}${encoded}`;
};

const parseNonNegativeSafeInteger = (raw: string): number | undefined => {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const modelOfMarkerField = (field: string): string | undefined => {
  if (!field.startsWith(SPEND_UNPRICED_FIELD_PREFIX)) return undefined;
  const encoded = field.slice(SPEND_UNPRICED_FIELD_PREFIX.length);
  if (encoded.length % 4 !== 0 || !/^[0-9a-f]*$/.test(encoded)) return undefined;

  let model = "";
  for (let index = 0; index < encoded.length; index += 4) {
    model += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16));
  }
  return model;
};

/**
 * Strictly parse the complete Redis hash.
 *
 * Missing numeric axes mean zero; every PRESENT field and value is controlled
 * by this grammar. Unknown fields, malformed markers, and non-canonical,
 * negative, unsafe, or non-integer figures are typed failures rather than
 * values that could hydrate a cheaper-looking run.
 */
export const spendOfHash = (
  hash: Readonly<Record<string, string>>,
): Result<Spend, SpendHashParseError> => {
  const figures = { micros: 0, tokens: 0, calls: 0 };
  let usage: Spend["usage"] = "known";
  const models: string[] = [];

  for (const [field, raw] of Object.entries(hash)) {
    if (field === SPEND_HASH_FIELDS.micros ||
        field === SPEND_HASH_FIELDS.tokens ||
        field === SPEND_HASH_FIELDS.calls) {
      const parsed = parseNonNegativeSafeInteger(raw);
      if (parsed === undefined) {
        return err({ kind: "malformed-spend-hash", field, reason: "invalid-numeric-value" });
      }
      figures[field] = parsed;
      continue;
    }

    if (field === SPEND_USAGE_UNKNOWN_FIELD) {
      if (raw !== SPEND_MARKER_VALUE) {
        return err({ kind: "malformed-spend-hash", field, reason: "invalid-marker-value" });
      }
      usage = "unknown";
      continue;
    }
    if (!field.startsWith(SPEND_UNPRICED_FIELD_PREFIX)) {
      return err({ kind: "malformed-spend-hash", field, reason: "unknown-field" });
    }
    const model = modelOfMarkerField(field);
    if (model === undefined) {
      return err({ kind: "malformed-spend-hash", field, reason: "invalid-marker-field" });
    }
    if (raw !== SPEND_MARKER_VALUE) {
      return err({ kind: "malformed-spend-hash", field, reason: "invalid-marker-value" });
    }
    models.push(model);
  }

  models.sort();
  const canonicalModels = unpricedModels(models);
  const micros = microUsd(figures.micros);
  return ok(makeSpend({
    usage,
    tokens: figures.tokens,
    calls: figures.calls,
    usd: canonicalModels === undefined
      ? { kind: "priced", micros }
      : { kind: "unpriced", models: canonicalModels, knownMicros: micros },
  }));
};
