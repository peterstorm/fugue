// Map/Set <-> JSON serialization helpers
// Ensures state and context containing Map/Set instances round-trip
// through JSON without information loss (required for checkpoint persistence).

import type { Result } from "../types/result.js";
import { err, ok, tryCatch } from "../types/result.js";

const MAP_TAG = "__map__";
const SET_TAG = "__set__";
const DATE_TAG = "__date__";
const UNDEFINED_TAG = "__undefined__";

type SerializedMap = { __map__: Array<[unknown, unknown]> };
type SerializedSet = { __set__: unknown[] };
type SerializedDate = { __date__: string };
type SerializedUndefined = { __undefined__: true };

const RESERVED_TAGS = [MAP_TAG, SET_TAG, DATE_TAG, UNDEFINED_TAG] as const;
type ReservedTag = (typeof RESERVED_TAGS)[number];

/**
 * ONE encoding of the reserved tag-key set, shared with the file FR-009
 * pre-scans (`event-record.ts`, `checkpointer-codec.ts`) so a change to the
 * serializer's tag behavior can never silently desync the pre-scan guards.
 * The const tuple above remains the single source for the tag values.
 */
export const RESERVED_TAG_KEYS: ReadonlySet<string> = new Set(RESERVED_TAGS);

/**
 * ONE encoding of the prototype-pollution keys `serializeValue` filters out
 * of plain objects, shared with the file FR-009 pre-scans (which reject them
 * at the write boundary instead of persisting them missing).
 */
export const POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Maximum nesting depth of a value tree — the shared depth ceiling of
 * every recursive walk in this grammar (`serializeValue`,
 * `deserializeValue`, `deepJsonEqual`, `validateSerializedValueGrammar`)
 * and of every file-layer write/read pre-scan that enforces it on
 * caller-owned values BEFORE the grammar is allowed to recurse: the
 * event write-boundary pre-scan (`assertLosslessEvent`,
 * `file/event-record.ts`), the checkpoint codec materializer and envelope
 * pre-scan (`materializeCanonicalOutput`, `serializeFileCheckpoint`,
 * `file/checkpointer-codec.ts`), and the resume-proof read gate
 * (`file/resume-proof.ts`). The ceiling is a grammar knob — the deepest
 * nesting this grammar's recursion has been verified safe at — and it
 * lives here, with the grammar it bounds, not in a consumer module.
 *
 * Depth counts property hops from the scan root: in a journal record the
 * record fields and the `event` value sit at depth 1, the event's children
 * at depth 2, …; in a checkpoint the `{schemaVersion, data}` envelope (or a
 * node output) is scanned at depth 1 (`initialDepth: 1`) and its children
 * sit at depth 2. A value
 * whose deepest chain exceeds the ceiling fails closed (FR-009): on the
 * READ side with a typed `err` naming the source and depth (the raw seam
 * rejects BEFORE `deserializeValue` could recurse past it), on the WRITE
 * side with the module's contextual typed boundary error naming the path
 * and depth. 512 is far below the engine's call-stack overflow threshold
 * (~20k–50k frames in V8/bun — the exact depths at which the unchecked
 * recursive walks previously overflowed), so every walk (and every
 * recursion it admits) completes on the stack, while legitimately nested
 * values (state snapshots, tool outputs — typically well under 50 levels)
 * clear it by an order of magnitude. Write and read boundaries count
 * identically within their domain, so a writer can never emit a record the
 * strict reader rejects on depth.
 */
export const MAX_SAFE_RECORD_DEPTH = 512;

const isReservedTag = (key: string): key is ReservedTag =>
  RESERVED_TAG_KEYS.has(key);

/** A key that can be written as `.key` rather than `["key"]`. */
const identifierLike = (key: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);

/** Diagnostic path renderer shared with `checkpointer-codec.ts` (ONE rule). */
export const serializedPath = (parent: string, key: string | number): string => {
  if (typeof key === "number") return `${parent}[${key}]`;
  return identifierLike(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
};

/** SameValueZero identity for primitives after deserialization. Objects return
 * null because distinct object identities may have byte-identical serialized
 * shapes while remaining distinct Map keys or Set values. */
const primitiveSameValueZeroIdentity = (value: unknown): string | null => {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") return `number:${Object.is(value, -0) ? 0 : value}`;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>)[UNDEFINED_TAG] === true
  ) {
    return "undefined";
  }
  return null;
};

interface SerializedGrammarOptions {
  /** Diagnostic root, for example `record` or `output`. */
  readonly rootPath: string;
  /** Maximum property/tag hops admitted before recursive deserialization. */
  readonly maxDepth: number;
  /** Root depth in the caller's containing envelope. Defaults to zero. */
  readonly initialDepth?: number;
}

/**
 * Validate a raw JSON value against the exact canonical grammar emitted by
 * `serializeValue`, before `deserializeValue` may reinterpret tagged objects
 * or erase pollution keys.
 *
 * The iterative validator rejects pollution keys at every depth; reserved-tag
 * objects with siblings or multiple tags; malformed Map tuples, Set payloads,
 * Date strings, and undefined markers; duplicate primitive Map keys / Set
 * values that deserialization would collapse; non-finite or negative-zero raw
 * numbers that the serializer never emits; and excessive nesting. Expected
 * failures are returned as `Result` strings so persistence adapters can map
 * them to their own typed corruption errors.
 */
export const validateSerializedValueGrammar = (
  value: unknown,
  options: SerializedGrammarOptions,
): Result<void, string> => {
  const initialDepth = options.initialDepth ?? 0;
  if (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0) {
    return err(`maxDepth must be a non-negative safe integer, got ${String(options.maxDepth)}`);
  }
  if (!Number.isSafeInteger(initialDepth) || initialDepth < 0) {
    return err(`initialDepth must be a non-negative safe integer, got ${String(initialDepth)}`);
  }

  const stack: Array<{
    readonly value: unknown;
    readonly path: string;
    readonly depth: number;
  }> = [{ value, path: options.rootPath, depth: initialDepth }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.value === undefined) {
      return err(`${frame.path} is raw undefined; canonical serialization requires {${UNDEFINED_TAG}:true}`);
    }
    if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) {
        return err(`${frame.path} is a non-finite number that canonical JSON serialization never emits`);
      }
      if (Object.is(frame.value, -0)) {
        return err(`${frame.path} is -0; canonical serialization normalizes -0 to 0`);
      }
      continue;
    }
    if (
      frame.value === null ||
      typeof frame.value === "string" ||
      typeof frame.value === "boolean"
    ) {
      continue;
    }
    if (typeof frame.value !== "object") {
      return err(`${frame.path} has non-JSON type ${typeof frame.value}`);
    }
    // Depth counts nested containers, matching serializeValue's recursive
    // calls and the file codec's established boundary. Primitive leaves do
    // not add another recursive frame.
    if (frame.depth > options.maxDepth) {
      return err(
        `${options.rootPath} nesting exceeds the safe depth ceiling ${options.maxDepth} at ${frame.path} (depth ${frame.depth})`,
      );
    }

    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index--) {
        stack.push({
          value: frame.value[index],
          path: serializedPath(frame.path, index),
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    const record = frame.value as Record<string, unknown>;
    const keys = Object.keys(record);
    const pollutionKey = keys.find((key) => POLLUTION_KEYS.has(key));
    if (pollutionKey !== undefined) {
      return err(
        `${serializedPath(frame.path, pollutionKey)} contains prototype-pollution-filtered key ${JSON.stringify(pollutionKey)}; deserialization would silently erase it`,
      );
    }

    const tags = keys.filter(isReservedTag);
    if (tags.length === 0) {
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        stack.push({
          value: record[key],
          path: serializedPath(frame.path, key),
          depth: frame.depth + 1,
        });
      }
      continue;
    }
    if (tags.length !== 1 || keys.length !== 1) {
      return err(
        `${frame.path} is an ambiguous serializer-tag object: reserved tag objects must contain exactly one canonical tag field, got ${keys.map((key) => JSON.stringify(key)).join(", ")}`,
      );
    }

    const tag = tags[0];
    const payload = record[tag];
    if (tag === UNDEFINED_TAG) {
      if (payload !== true) {
        return err(`${frame.path}.${UNDEFINED_TAG} must be exactly true`);
      }
      continue;
    }
    if (tag === DATE_TAG) {
      if (typeof payload !== "string") {
        return err(`${frame.path}.${DATE_TAG} must be an ISO string`);
      }
      const date = new Date(payload);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== payload) {
        return err(
          `${frame.path}.${DATE_TAG} must be the canonical ISO timestamp emitted by Date#toISOString, got ${JSON.stringify(payload)}`,
        );
      }
      continue;
    }
    if (!Array.isArray(payload)) {
      return err(`${frame.path}.${tag} must be an array`);
    }

    if (tag === SET_TAG) {
      const primitiveValues = new Set<string>();
      for (let index = payload.length - 1; index >= 0; index--) {
        const rawValue = payload[index];
        const identity = primitiveSameValueZeroIdentity(rawValue);
        if (identity !== null) {
          if (primitiveValues.has(identity)) {
            return err(
              `${frame.path}.${SET_TAG}[${index}] duplicates a primitive Set value; canonical Set serialization cannot contain duplicate primitive values`,
            );
          }
          primitiveValues.add(identity);
        }
        stack.push({
          value: rawValue,
          path: `${frame.path}.${SET_TAG}[${index}]`,
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    const primitiveKeys = new Set<string>();
    for (let index = payload.length - 1; index >= 0; index--) {
      const entry = payload[index];
      if (!Array.isArray(entry) || entry.length !== 2) {
        return err(
          `${frame.path}.${MAP_TAG}[${index}] must be an exact two-element [key, value] tuple`,
        );
      }
      const rawKey = entry[0];
      const identity = primitiveSameValueZeroIdentity(rawKey);
      if (identity !== null) {
        if (primitiveKeys.has(identity)) {
          return err(
            `${frame.path}.${MAP_TAG}[${index}][0] duplicates a primitive Map key; canonical Map serialization cannot contain duplicate primitive keys`,
          );
        }
        primitiveKeys.add(identity);
      }
      stack.push({
        value: entry[1],
        path: `${frame.path}.${MAP_TAG}[${index}][1]`,
        depth: frame.depth + 1,
      });
      stack.push({
        value: rawKey,
        path: `${frame.path}.${MAP_TAG}[${index}][0]`,
        depth: frame.depth + 1,
      });
    }
  }

  return ok(undefined);
};

/**
 * Fail-closed depth backstop for the two RECURSIVE walks of this grammar.
 *
 * `deepJsonEqual` and `validateSerializedValueGrammar` are iterative and carry
 * their own ceiling; `serializeValue`/`deserializeValue` recurse, so the
 * ceiling `MAX_SAFE_RECORD_DEPTH` documents as belonging to "every recursive
 * walk in this grammar" has to live INSIDE them — not in whichever caller
 * remembered to pre-scan. The `file/*` layer does pre-scan (`assertLosslessEvent`,
 * the checkpoint codec, the resume-proof read gate); the `queue-bullmq/*` layer
 * hands Redis/BullMQ payloads straight to these walks, so without this backstop a
 * hostile ~20k-deep tenant payload escapes as a raw `RangeError` from a blown
 * call stack instead of a named, bounded failure.
 *
 * The backstop can never be TIGHTER than an existing pre-scan: every file-layer
 * pre-scan counts with `initialDepth` 0 or 1 against the same `maxDepth`, and
 * this walk roots at 0, so it admits at least everything they admit. Counting
 * matches `validateSerializedValueGrammar` exactly — a container costs a hop,
 * a primitive leaf does not — so a writer can never emit a value the strict
 * reader then rejects on depth.
 */
const depthExceeded = (walk: string, depth: number): never => {
  throw new Error(
    `${walk}: value nesting exceeds the safe depth ceiling ${MAX_SAFE_RECORD_DEPTH} (depth ${depth}) — deeper values overflow this recursive walk; refusing to recurse (FR-009)`,
  );
};

const serializeAt = (value: unknown, depth: number): unknown => {
  if (value === undefined) {
    return { [UNDEFINED_TAG]: true } satisfies SerializedUndefined;
  }

  if (value instanceof Date) {
    if (depth > MAX_SAFE_RECORD_DEPTH) depthExceeded("serializeValue", depth);
    return { [DATE_TAG]: value.toISOString() } satisfies SerializedDate;
  }

  if (value instanceof Map) {
    if (depth > MAX_SAFE_RECORD_DEPTH) depthExceeded("serializeValue", depth);
    const entries: Array<[unknown, unknown]> = [];
    for (const [k, v] of value.entries()) {
      entries.push([serializeAt(k, depth + 1), serializeAt(v, depth + 1)]);
    }
    return { [MAP_TAG]: entries } satisfies SerializedMap;
  }

  if (value instanceof Set) {
    if (depth > MAX_SAFE_RECORD_DEPTH) depthExceeded("serializeValue", depth);
    const items: unknown[] = [];
    for (const item of value.values()) {
      items.push(serializeAt(item, depth + 1));
    }
    return { [SET_TAG]: items } satisfies SerializedSet;
  }

  if (Array.isArray(value)) {
    if (depth > MAX_SAFE_RECORD_DEPTH) depthExceeded("serializeValue", depth);
    return value.map((item) => serializeAt(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    if (depth > MAX_SAFE_RECORD_DEPTH) depthExceeded("serializeValue", depth);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (POLLUTION_KEYS.has(k)) continue;
      out[k] = serializeAt(v, depth + 1);
    }
    return out;
  }

  return value;
};

/** Serialize a value to a plain JSON-safe object, preserving Map/Set/Date/undefined. */
export const serializeValue = (value: unknown): unknown => serializeAt(value, 0);

/**
 * Structural equality over `serializeValue` canonical forms — the ONE shared
 * FR-009 losslessness verdict. `serializeValue` output is JSON-safe
 * (primitives, arrays, plain objects, `{__undefined__:true}` markers) EXCEPT
 * that NaN is preserved as itself, so equality must treat NaN as equal to NaN
 * (JSON would coerce it to `null` — exactly one of the silent mutations the
 * round-trip check exists to catch). -0 stays equal to 0 — the DOCUMENTED
 * accepted coercion (JSON normalizes the sign of zero; the comparison is
 * deliberately `===`, not `Object.is`, so `-0` never trips the gate).
 *
 * Shared by the event-record codec (`serializeFileEventRecord` round-trip
 * verdict) and the checkpoint codec (`serializeFileCheckpoint` bytes-⇔-
 * snapshot verdict): a single definition so the two FR-009 gates can never
 * drift apart.
 *
 * ITERATIVE (explicit pair queue) — total over arbitrary input at ANY depth:
 * a hostile unbounded-depth pair cannot overflow the call stack, matching the
 * iterative posture of the read-side pre-scans. Semantics are identical to
 * the historical recursive walk (structural equality over canonical
 * `serializeValue` forms, NaN-equals-NaN, `-0`-equals-`0`). */
export const deepJsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  const pending: Array<readonly [unknown, unknown]> = [[a, b]];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const x = entry[0];
    const y = entry[1];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") {
      if (!(Number.isNaN(x) && Number.isNaN(y))) return false;
      continue;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) {
        pending.push([x[i], y[i]]);
      }
      continue;
    }
    if (
      typeof x === "object" && x !== null && typeof y === "object" && y !== null &&
      !Array.isArray(x) && !Array.isArray(y)
    ) {
      const kx = Object.keys(x);
      const ky = Object.keys(y);
      if (kx.length !== ky.length) return false;
      const xRec = x as Record<string, unknown>;
      const yRec = y as Record<string, unknown>;
      for (const key of kx) {
        if (!Object.prototype.hasOwnProperty.call(y, key)) return false;
        pending.push([xRec[key], yRec[key]]);
      }
      continue;
    }
    return false;
  }
  return true;
};

const deserializeAt = (value: unknown, depth: number): unknown => {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    if (depth > MAX_SAFE_RECORD_DEPTH) depthExceeded("deserializeValue", depth);
    return value.map((item) => deserializeAt(item, depth + 1));
  }

  if (typeof value === "object") {
    // Same counting as `validateSerializedValueGrammar`: the container costs
    // the hop, and a tag object is a container like any other.
    if (depth > MAX_SAFE_RECORD_DEPTH) depthExceeded("deserializeValue", depth);
    const obj = value as Record<string, unknown>;

    // Detect serialized undefined
    if (UNDEFINED_TAG in obj && obj[UNDEFINED_TAG] === true) {
      return undefined;
    }

    // Detect serialized Date
    if (DATE_TAG in obj && typeof obj[DATE_TAG] === "string") {
      const d = new Date(obj[DATE_TAG] as string);
      if (isNaN(d.getTime())) {
        throw new Error(`deserializeValue: invalid date string "${obj[DATE_TAG]}"`);
      }
      return d;
    }

    // Detect serialized Map
    if (MAP_TAG in obj && Array.isArray(obj[MAP_TAG])) {
      const map = new Map<unknown, unknown>();
      for (const [k, v] of obj[MAP_TAG] as Array<[unknown, unknown]>) {
        map.set(deserializeAt(k, depth + 1), deserializeAt(v, depth + 1));
      }
      return map;
    }

    // Detect serialized Set
    if (SET_TAG in obj && Array.isArray(obj[SET_TAG])) {
      const set = new Set<unknown>();
      for (const item of obj[SET_TAG] as unknown[]) {
        set.add(deserializeAt(item, depth + 1));
      }
      return set;
    }

    // Plain object — filter prototype pollution vectors
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (POLLUTION_KEYS.has(k)) continue;
      out[k] = deserializeAt(v, depth + 1);
    }
    return out;
  }

  return value;
};

/** Deserialize a value produced by serializeValue, restoring Map/Set/Date/undefined. */
export const deserializeValue = (value: unknown): unknown => deserializeAt(value, 0);

/**
 * Serialize the supported, pre-scanned value domain to JSON storage bytes.
 * Outside that domain, `JSON.stringify` may throw or produce `undefined` at
 * runtime; persistence boundaries must apply their losslessness gate first.
 */
export const toJson = (value: unknown): string =>
  JSON.stringify(serializeValue(value));

/**
 * Deserialize JSON emitted by `toJson` for the supported collision-free,
 * lossless value domain. Plain objects must not use the reserved serializer
 * tag keys (`__map__`, `__set__`, `__date__`, `__undefined__`): tag-shaped
 * objects are intentionally decoded as their Map/Set/Date/undefined values,
 * so `fromJson(toJson(value))` is not an identity for such ambiguous inputs.
 * Throws on malformed JSON or malformed tagged values.
 */
export const fromJson = (json: string): unknown =>
  deserializeValue(JSON.parse(json));

/** Safe variant of `fromJson` — returns a Result instead of throwing on malformed input. */
export const tryFromJson = (json: string): Result<unknown, Error> =>
  tryCatch(() => deserializeValue(JSON.parse(json)));
