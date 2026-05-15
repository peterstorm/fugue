// Map/Set <-> JSON serialization helpers — FR-010
// Ensures state and context containing Map/Set instances round-trip
// through JSON without information loss (required for checkpoint persistence).

const MAP_TAG = "__map__";
const SET_TAG = "__set__";
const DATE_TAG = "__date__";
const UNDEFINED_TAG = "__undefined__";

type SerializedMap = { __map__: Array<[unknown, unknown]> };
type SerializedSet = { __set__: unknown[] };
type SerializedDate = { __date__: string };
type SerializedUndefined = { __undefined__: true };

/** Serialize a value to a plain JSON-safe object, preserving Map/Set/Date/undefined. */
export const serializeValue = (value: unknown): unknown => {
  if (value === undefined) {
    return { [UNDEFINED_TAG]: true } satisfies SerializedUndefined;
  }

  if (value instanceof Date) {
    return { [DATE_TAG]: value.toISOString() } satisfies SerializedDate;
  }

  if (value instanceof Map) {
    const entries: Array<[unknown, unknown]> = [];
    for (const [k, v] of value.entries()) {
      entries.push([serializeValue(k), serializeValue(v)]);
    }
    return { [MAP_TAG]: entries } satisfies SerializedMap;
  }

  if (value instanceof Set) {
    const items: unknown[] = [];
    for (const item of value.values()) {
      items.push(serializeValue(item));
    }
    return { [SET_TAG]: items } satisfies SerializedSet;
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = serializeValue(v);
    }
    return out;
  }

  return value;
};

/** Deserialize a value produced by serializeValue, restoring Map/Set/Date/undefined. */
export const deserializeValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Detect serialized undefined
    if (UNDEFINED_TAG in obj && obj[UNDEFINED_TAG] === true) {
      return undefined;
    }

    // Detect serialized Date
    if (DATE_TAG in obj && typeof obj[DATE_TAG] === "string") {
      return new Date(obj[DATE_TAG] as string);
    }

    // Detect serialized Map
    if (MAP_TAG in obj && Array.isArray(obj[MAP_TAG])) {
      const map = new Map<unknown, unknown>();
      for (const [k, v] of obj[MAP_TAG] as Array<[unknown, unknown]>) {
        map.set(deserializeValue(k), deserializeValue(v));
      }
      return map;
    }

    // Detect serialized Set
    if (SET_TAG in obj && Array.isArray(obj[SET_TAG])) {
      const set = new Set<unknown>();
      for (const item of obj[SET_TAG] as unknown[]) {
        set.add(deserializeValue(item));
      }
      return set;
    }

    // Plain object — filter prototype pollution vectors
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = deserializeValue(v);
    }
    return out;
  }

  return value;
};

/** Serialize to JSON string — suitable for Redis/storage writes. */
export const toJson = (value: unknown): string =>
  JSON.stringify(serializeValue(value));

/** Deserialize from JSON string — inverse of toJson. */
export const fromJson = (json: string): unknown =>
  deserializeValue(JSON.parse(json));
