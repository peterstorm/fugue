// Map/Set <-> JSON serialization helpers — FR-010
// Ensures state and context containing Map/Set instances round-trip
// through JSON without information loss (required for checkpoint persistence).

const MAP_TAG = "__map__";
const SET_TAG = "__set__";

type SerializedMap = { __map__: Array<[unknown, unknown]> };
type SerializedSet = { __set__: unknown[] };

/** Serialize a value to a plain JSON-safe object, preserving Map/Set. */
export const serializeValue = (value: unknown): unknown => {
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
      out[k] = serializeValue(v);
    }
    return out;
  }

  return value;
};

/** Deserialize a value produced by serializeValue, restoring Map/Set. */
export const deserializeValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

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

    // Plain object
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
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
