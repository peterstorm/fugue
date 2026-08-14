// Strict file event-record codec for the file-backed durable runtime
// (`@fuguejs/framework/file`).
//
// `FileEventRecord` is the byte-level schema of every journal record file
// (`events/<NNNNNN>-<digest>.json`, AD-2): `{ schemaVersion: 1, sequence,
// dedupKey, recordedAtMs, event }` — byte-identical to Loom's proven
// `ProgramEventRecord`. Records are serialized with `toJson` so Map/Set/Date
// values inside `event` survive the JSON round-trip; the read pipeline is
// `tryParseEventRecordJson` — `JSON.parse` + the shared exact canonical
// serializer-grammar validator + `deserializeValue` (restoring those values)
// — followed by `parseFileEventRecord`. Every walk in the codec is bounded by the shared
// depth ceiling `MAX_SAFE_RECORD_DEPTH` (512): hostile records nested past
// it fail closed with a contextual FR-009 error naming the source and depth
// instead of overflowing the JS call stack as a raw RangeError. The READ
// pre-scans are ITERATIVE (explicit stack), so they cannot overflow at ANY
// depth; the WRITE pre-scan recursion admits at most the ceiling's depth,
// far below the engine's overflow threshold.
//
// FR-009 losslessness is enforced AT THE WRITE BOUNDARY by
// `assertLosslessEvent`, a recursive pre-scan of the event value that runs
// FIRST in `serializeFileEventRecord` and rejects anything the serializer
// cannot represent losslessly: accessor properties (an own accessor
// descriptor — a `get` — is rejected BY INSPECTION alone: the pre-scan
// never invokes getters, so their values are unverifiable, and `toJson`
// WOULD invoke them), symbol-keyed or non-enumerable own properties,
// JSON-less values (WeakMap/WeakSet/RegExp/Promise/class instances/typed
// arrays/boxed primitives), prototype-pollution-filtered keys
// (`__proto__`/`constructor`/`prototype`), the literal reserved tag
// keys (`__map__`/`__set__`/`__date__`/`__undefined__`) that serialize.ts
// uses as its internal markers, custom `toJSON` methods, BigInt, functions,
// symbols, invalid Dates, and circular references — each with a message
// naming the offending kind and path. These losses are invisible to a
// round-trip comparison because `serializeValue` strips/drops identically
// on BOTH sides, so the pre-scan makes silent loss UNREPRESENTABLE at the
// write boundary: no event shape the pre-scan lets through is discarded by
// `toJson`. The round-trip check then backstops the coercion class the
// pre-scan defers by design — non-finite numbers, which JSON coerces to
// `null` (the deep-equal rejects the divergence). The ONE accepted
// coercion is `-0` → `0`: the deep-equal deliberately compares with `===`,
// not `Object.is` (JSON normalizes the sign of zero), so a `-0` in an
// event persists as `0` without throwing.
//
// `parseFileEventRecord` is the fail-closed read-side gate (FR-009): every
// record read from the event log crosses this validator before it becomes a
// type, and ANY violation returns `err` with a message naming the source
// file. The event log is authoritative, so a corrupt record is never
// silently dropped mid-log — the caller decides how to fail closed. The
// strict schema is DELIBERATELY closed to unknown top-level fields
// (fail-closed posture consistent with every other check here): a record
// with any key other than
// `schemaVersion`/`sequence`/`dedupKey`/`recordedAtMs`/`event` is rejected,
// so a writer that starts emitting a new field fails the reader loudly
// instead of silently ignoring it. BEFORE deserialization, the reader
// validates every raw reserved-tag object recursively against the shared
// canonical serializer grammar: exactly one tag key, no siblings, canonical
// payload, exact Map tuples, bounded depth, and no pollution-filtered keys.
// This closes ambiguous shapes such as `{__map__: [...], extra: 1}` that the
// permissive decoder would otherwise reinterpret while silently discarding
// bytes. After deserialization, the parser retains a defense-in-depth
// rejection for literal reserved keys in direct-call/plain-object inputs.
//
// FR-015 charset validation lives HERE, at the persistence boundary (layout.ts
// defers it to this module): the keyed form must match
// `^[A-Za-z0-9:_-]{1,256}$`; the empty string is the keyless form. NOTE:
// `layout.ts` `isBoundaryId` is deliberately NOT reused — its `{1,128}`
// quantifier would wrongly reject the spec-valid 129..256-char range; the
// pattern below is the same ID charset with the FR-015 quantifier. The `|`
// character additionally gets an explicit rejection (AD-2 disjointness): the
// keyless digest form embeds `|` as a field separator
// (`sha256hex(`${sequence}|${toJson(event)}`)`, `eventDigestOf` in layout.ts),
// so a keyed dedupKey containing `|` would let a keyed record's digest input
// string coincide with a keyless record's — e.g. the keyed key `"5|{\"a\":1}"`
// hashes identically to the keyless record `(5, {a:1})` — two genuinely
// different events fighting for one filename, silently deduping one of them.
// Rejecting `|` keeps the keyed and keyless digest domains disjoint by
// construction. The rule has ONE encoding — `dedupKeyError` — consumed by
// the `isDedupKey` type guard and optional append parser: there is no second
// grammar implementation to drift.
//
// Error split: `serializeFileEventRecord` THROWS on invariant violations — a
// caller bug, and the write side must never emit a record the strict reader
// would reject (which is why a top-level `undefined` event is refused here
// too: the read path treats an undefined event as missing). FR-009
// losslessness is enforced by the write-boundary pre-scan
// (`assertLosslessEvent`, FIRST in the serializer) plus a ROUND-TRIP
// backstop: after producing the JSON, the serializer parses it back and the
// parsed `event` must deep-equal the canonicalized input event (via the
// same `serializeValue` identity). The round-trip catches the coercion the
// pre-scan defers — `JSON.stringify` silently converts NaN/±Infinity to
// `null` — and any other divergence; a divergence throws the module's
// contextual FR-009 error instead of silently mutating the authoritative
// journal. The ONE accepted divergence is the `-0` → `0` normalization:
// the deep-equal uses `===`, not `Object.is` (JSON normalizes the sign of
// zero; nobody's event semantics depend on it), so `-0` persists as `0`
// without throwing.
//
// `parseFileEventRecord` returns `Result<FileEventRecord, string>` because
// on-disk data may be corrupt through no fault of the caller.
//
// Pure module — no I/O (INV-1; only framework core imports: `layout.js`
// constants, `state-machine/serialize.js` `toJson`/`serializeValue`,
// `types/result.js`).

import {
  JOURNAL_SCHEMA_VERSION,
  MAX_LEXICOGRAPHIC_SEQUENCE,
} from "./layout.js";
import {
  toJson,
  serializeValue,
  tryFromJson,
  deserializeValue,
  validateSerializedValueGrammar,
} from "../state-machine/serialize.js";
import type { Result } from "../types/result.js";
import { ok, err, tryCatch } from "../types/result.js";
import { safeDiagnosticRender, safeErrorMessage } from "../types/safe-error.js";
import { fileOperationError } from "./boundary-error.js";

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/** One immutable event record as stored in the journal (AD-2 schema). */
export interface FileEventRecord {
  /** Journal schema version — pinned to `JOURNAL_SCHEMA_VERSION` (1). */
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  /**
   * Position in the journal's append order: a non-negative safe integer at
   * most `MAX_LEXICOGRAPHIC_SEQUENCE` (999999) — the codec and the naming
   * layer (`eventFileName`) share one sequence domain, so a 7-digit
   * sequence can never sort before a 6-digit one in a listing.
   */
  readonly sequence: number;
  /** "" (keyless) or an FR-015 key: `^[A-Za-z0-9:_-]{1,256}$`, no "|". */
  readonly dedupKey: string;
  /** Wall-clock milliseconds of the append; must be finite. Negative finite
   * values ARE accepted — pre-epoch timestamps are representable (pinned
   * contract: the check is finite-ness, not sign). */
  readonly recordedAtMs: number;
  /**
   * Any losslessly-serializable value EXCEPT top-level `undefined` (the
   * read path treats an undefined event as missing, and the write side
   * refuses it). The write boundary pre-scans the event recursively
   * (`assertLosslessEvent`, FR-009) and rejects any value the serializer
   * cannot represent losslessly — own accessor properties (an accessor
   * `get` descriptor is rejected by inspection; the pre-scan never
   * invokes getters), symbol-keyed or non-enumerable properties, JSON-less
   * values (WeakMap/RegExp/class instances/typed arrays/...),
   * prototype-pollution-filtered keys
   * (`__proto__`/`constructor`/`prototype`), literal reserved tag keys
   * (`__map__`/`__set__`/`__date__`/`__undefined__`), custom `toJSON`,
   * BigInt, functions, symbols, invalid Dates, and circular references.
   * The round-trip check backstops the remaining coercion (non-finite
   * numbers → `null`). Map/Set/Date values survive the round-trip.
   */
  readonly event: unknown;
}

// ---------------------------------------------------------------------------
// FR-015 dedupKey boundary (shared by the write and read sides)
// ---------------------------------------------------------------------------

/**
 * FR-015 keyed dedupKey charset — the framework ID charset with the FR-015
 * quantifier (1..256). `|` is excluded by the charset AND by the explicit
 * check in `dedupKeyError` (AD-2 keyed/keyless digest disjointness).
 */
export const DEDUP_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;

/** Compact rendering of a raw field value for error messages — long strings
 * are truncated so a hostile 256+ char key cannot flood the log. */
const render = (value: unknown): string => {
  if (typeof value === "string") {
    const shown =
      value.length > 40 ? `${value.slice(0, 40)}…(${value.length} chars)` : value;
    return JSON.stringify(shown);
  }
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
  } catch {
    return safeDiagnosticRender(value);
  }
};

/**
 * FR-015/AD-2 violation message for a dedupKey value, or null when valid.
 * THE single encoding of the FR-015 rule — `isDedupKey` is derived from
 * this function, and the read side derives its rejection message from it,
 * so there is exactly one implementation of the rule to drift.
 */
const dedupKeyError = (value: unknown): string | null => {
  if (typeof value !== "string") {
    // Do not render or coerce object/function values here. Diagnostics are
    // part of the hostile runtime boundary: rendering a Proxy or boxed value
    // can execute traps, getters, `toJSON`, or `Symbol.toPrimitive` after the
    // type verdict is already known. `typeof` (plus the null distinction) is
    // sufficient, deterministic context and cannot dereference the value.
    const runtimeType = value === null ? "null" : typeof value;
    return `dedupKey must be a string, got runtime type ${runtimeType} (FR-015)`;
  }
  if (value.includes("|")) {
    return `dedupKey ${render(value)} contains "|" — forbidden: "|" is the keyless digest field separator (AD-2), so keyed and keyless digest domains must stay disjoint (FR-015); runStateMachine's default fallback keyer emits "|", so file-backed callers must inject an FR-015-safe computeDedupKey`;
  }
  if (value !== "" && !DEDUP_KEY_PATTERN.test(value)) {
    return `dedupKey ${render(value)} does not match ${DEDUP_KEY_PATTERN.source} (FR-015)`;
  }
  return null;
};

/**
 * FR-015/AD-2 validator: `""` (keyless) or a charset-valid key. Type guard —
 * also usable at the append boundary (journal.ts) so the write side and the
 * read side share one rule. DERIVED from `dedupKeyError` — one rule, two
 * views; there is no second encoding to drift.
 */
export const isDedupKey = (value: unknown): value is string =>
  dedupKeyError(value) === null;

/**
 * Parse the optional append-boundary value into the durable representation.
 * Only omission/`undefined` normalizes to the explicit keyless sentinel.
 * Runtime `null` is data, not omission, and therefore fails FR-015.
 *
 * The supplied value is passed through the grammar once. Non-string objects
 * are rejected by `typeof` before diagnostics can dereference a getter,
 * Proxy, coercion hook, or other executable property.
 */
export const parseOptionalDedupKey = (
  value: unknown,
): Result<string, string> => {
  if (value === undefined) return ok("");
  const failure = dedupKeyError(value);
  return failure === null ? ok(value as string) : err(failure);
};

/**
 * Structural equality over serializeValue canonical forms — the FR-009
 * losslessness verdict. `serializeValue` output is JSON-safe (primitives,
 * arrays, plain objects, `{__undefined__:true}` markers) EXCEPT that NaN is
 * preserved as itself, so equality must treat NaN as equal to NaN (JSON
 * would coerce it to `null` — exactly one of the silent mutations the
 * round-trip check exists to catch). -0 stays equal to 0 — the DOCUMENTED
 * accepted coercion (JSON normalizes the sign of zero; the comparison is
 * deliberately `===`, not `Object.is`, so `-0` never trips the gate).
 */
const deepJsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepJsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    typeof a === "object" && a !== null && typeof b === "object" && b !== null &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepJsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// FR-009 write-boundary pre-scan
// ---------------------------------------------------------------------------

/**
 * Literal keys that `state-machine/serialize.ts` uses as its internal
 * markers: `serializeValue` emits `{__map__:…}`/`{__set__:…}`/
 * `{__date__:…}`/`{__undefined__:true}` for Map/Set/Date/undefined values.
 * A plain object in a caller's event carrying one of these keys is
 * ambiguous with a tagged form — `{__map__: [[1,2]]}` reads back as a Map
 * and `{__undefined__:true}` reads back as undefined — so JSON would change
 * its TYPE or erase it on the round trip, invisibly to the (equally lossy)
 * digest recompute. The write boundary rejects them; the read boundary
 * rejects them too (domain agreement): the writer can never produce one in
 * a plain object. On the READ side, `raw` is `tryFromJson` output, so a
 * literal tag key in a plain object only exists as a MALFORMED tag
 * encoding — well-formed tag-shaped bytes deserialize to Map/Set/Date/
 * undefined and are legitimate events of those types (byte-identical).
 */
const RESERVED_TAG_KEYS: ReadonlySet<string> = new Set([
  "__map__",
  "__set__",
  "__date__",
  "__undefined__",
]);

/** Keys that `serializeValue` silently filters out of plain objects
 * (prototype-pollution defense). A caller's event containing them would be
 * persisted with those properties missing — the pre-scan rejects them at
 * the write boundary instead. */
const POLLUTION_FILTERED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Human-kind of a rejected value — constructor name, else toString tag —
 * so pre-scan errors name what was rejected. */
const kindName = (value: object): string => {
  const proto = Object.getPrototypeOf(value);
  const ctorName =
    proto !== null && typeof (proto as { constructor?: unknown }).constructor === "function"
      ? ((proto as { constructor: { name?: unknown } }).constructor.name)
      : undefined;
  if (typeof ctorName === "string" && ctorName !== "") return ctorName;
  return Object.prototype.toString.call(value).slice(8, -1); // "[object WeakMap]" → "WeakMap"
};

/** Render a property key as a path segment: `.name` for identifier keys,
 * `[3]` for index keys, `["weird key"]` otherwise, `[Symbol(desc)]` for
 * symbols. */
const renderPathSegment = (key: PropertyKey): string => {
  if (typeof key === "symbol") return `[Symbol(${key.description ?? ""})]`;
  if (typeof key === "number") return `[${key}]`;
  if (/^(0|[1-9]\d*)$/.test(key)) return `[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `.${key}`;
  return `[${JSON.stringify(key)}]`;
};

/**
 * Maximum nesting depth of a journal record's value tree — the shared depth
 * ceiling of every walk in the codec: the read-side pre-scans
 * (`findPollutionKey` on the RAW record, `findReservedTagKey` on the
 * deserialized event), the write-boundary pre-scan (`assertLosslessEvent`)
 * and — by construction — the serializer/deserializer recursion those walks
 * guard (`serializeValue`, `deserializeValue`, `deepJsonEqual`, `toJson`).
 * Depth counts property hops from the scan root: the record fields and the
 * `event` value sit at depth 1, the event's children at depth 2, … A value
 * whose deepest chain exceeds the ceiling fails closed (FR-009): on the
 * READ side with a typed `err` naming the source and depth (the raw seam
 * rejects BEFORE `deserializeValue` could recurse past it), on the WRITE
 * side with the module's contextual typed boundary error. 512 is far below the
 * engine's call-stack overflow threshold (~20k-50k frames in V8/bun — the
 * exact depths at which the unchecked recursive walks overflowed), so every
 * walk (and every recursion they admit) completes on the stack, while
 * legitimately nested events (state snapshots, tool outputs — typically
 * well under 50 levels) clear it by an order of magnitude. The write and
 * read boundaries count identically — both start at the record level — so
 * the writer can never emit a record the strict reader rejects on depth.
 */
export const MAX_SAFE_RECORD_DEPTH = 512;

/** One link of a lazily-built path chain for the ITERATIVE walks: a
 * pre-rendered path segment plus its parent. Chains grow O(1) per level
 * while a walk descends (each frame shares its parent's chain); the full
 * path string is rendered ONLY when a hit or a depth violation makes it
 * necessary — per-level rendering would be O(depth²) on a hostile deep
 * record. */
type PathLink = {
  readonly text: string;
  readonly parent: PathLink | null;
};

/** Render a path chain (innermost first, as built) as `root` + segments,
 * truncating after a bounded number of segments: a hostile record could
 * otherwise inflate an error message with a multi-hundred-KB path (the
 * message names the remaining depth count instead). */
const renderChain = (chain: PathLink | null, root: string): string => {
  const MAX_SHOWN = 16;
  const parts: string[] = [];
  let link: PathLink | null = chain;
  for (let i = 0; i < MAX_SHOWN && link !== null; i++) {
    parts.push(link.text);
    link = link.parent;
  }
  let hidden = 0;
  while (link !== null) {
    hidden++;
    link = link.parent;
  }
  const path = root + parts.reverse().join("");
  return hidden > 0 ? `${path}…(+${hidden} more levels)` : path;
};

/**
 * Verdict of an iterative read-side scan (pollution / reserved-tag): a
 * `hit` (the offending key + rendered path), a `too-deep` depth violation
 * (the record fails closed — FR-009), or a `clean` pass.
 *
 * Exported so the checkpoint-envelope seam in `resume.ts` can reuse the
 * pollution scan's verdict shape without re-implementing it.
 */
export type ScanVerdict =
  | { readonly kind: "hit"; readonly key: string; readonly path: string }
  | { readonly kind: "too-deep"; readonly depth: number; readonly path: string }
  | { readonly kind: "clean" };

/** Read an OWN property value without invoking getters or the `__proto__`
 * accessor — the walks iterate own enumerable keys, so the value must come
 * from the descriptor, not property access. */
const ownValue = (obj: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(obj, key)?.value;

/**
 * FR-009 write-boundary pre-scan: recursively verify that `event` is
 * representable losslessly by `toJson`. Runs FIRST in
 * `serializeFileEventRecord` so a value the serializer would silently drop
 * or mutate is rejected BEFORE any JSON is produced. The round-trip check
 * cannot see these losses — `serializeValue` strips/drops identically on
 * both comparison sides — so the pre-scan makes silent loss
 * unrepresentable at the write boundary.
 *
 * Throws a typed `FrameworkError` (`cache-error`, operation
 * `assertLosslessEvent`) naming the offending kind and path on ANY of:
 *
 *   a. symbol-keyed own properties, at any depth (objects and arrays);
 *   b. non-enumerable own properties, at any depth (objects and arrays),
 *      plus any own property on Date/Map/Set instances (the serializers
 *      visit only the instant/entries/items);
 *   c. keys `__proto__`/`constructor`/`prototype` on plain objects
 *      (`serializeValue` filters them as prototype-pollution vectors);
 *   d. literal reserved tag keys `__map__`/`__set__`/`__date__`/
 *      `__undefined__` on plain objects (they are unambiguous only as
 *      serialize.ts's own markers; a plain event containing one would
 *      round-trip as a different TYPE or vanish);
 *   e. values that are not primitives (string/number/boolean/null/
 *      undefined), plain objects, arrays, Date, Map, or Set with their
 *      standard prototypes — WeakMap, WeakSet, RegExp, Promise, class
 *      instances, typed arrays, boxed primitives, symbols, functions,
 *      BigInt, invalid Dates;
 *   f. objects with a custom `toJSON` method or a `toJSON` accessor
 *      (JSON.stringify would write the accessor's/method's return value
 *      instead of the object; both are detected via descriptors, never by
 *      invoking the accessor);
 *   g. circular references (active-chain tracking — a node revisited
 *      through its own descendants; sibling sharing is not a cycle);
 *   h. own accessor properties — an own descriptor carrying a `get` — at
 *      any depth: plain-object keys and array indices. The pre-scan NEVER
 *      invokes getters (they may throw, have side effects, or return a
 *      different value to `toJson`'s own Get), so an accessor's value is
 *      unverifiable and the property is refused BY INSPECTION — fail
 *      closed, even when the getter would return JSON-safe data.
 *   i. values nested past `MAX_SAFE_RECORD_DEPTH` (the codec's shared
 *      depth ceiling, 512) — a hostile caller event nested ~20k-50k deep
 *      previously overflowed this recursive walk and escaped as a raw
 *      RangeError with no FR-009 context. The ceiling throws the
 *      contextual typed boundary error naming the path and depth; depth counts
 *      from the record root (the event value sits at depth 1), exactly
 *      like the read side, so the write boundary can never emit a record
 *      the strict reader rejects on depth, and every recursion this walk
 *      admits (serializeValue, deepJsonEqual, deserializeValue) stays far
 *      below the engine's call-stack overflow threshold.
 *
 * Allowed: primitives, plain objects, arrays, Map/Set (entries validated
 * recursively), valid Dates — all with DATA properties only (no own
 * accessors anywhere), nested no deeper than `MAX_SAFE_RECORD_DEPTH`.
 * Non-finite numbers are deliberately deferred to the
 * round-trip check (JSON coerces NaN/±Infinity to `null`, which the
 * deep-equal rejects); `-0` → `0` is the one ACCEPTED coercion (`===`,
 * not `Object.is`).
 */
const assertLosslessEventUnchecked = (event: unknown): void => {
  const walk = (
    value: unknown,
    path: string,
    active: Map<object, string>,
    depth: number,
  ): void => {
    if (value === null || value === undefined) return;
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
        return;
      case "bigint":
        throw new Error(
          `serializeFileEventRecord: ${path} is a BigInt — JSON has no BigInt representation; refusing to persist a value that would diverge from the caller's event (FR-009)`,
        );
      case "symbol":
        throw new Error(
          `serializeFileEventRecord: ${path} is a symbol — JSON has no symbol representation; refusing to persist a value that would diverge from the caller's event (FR-009)`,
        );
      case "function":
        throw new Error(
          `serializeFileEventRecord: ${path} is a function — JSON has no function representation; refusing to persist a value that would diverge from the caller's event (FR-009)`,
        );
      case "object":
        break;
      default:
        throw new Error(
          `serializeFileEventRecord: ${path} is a ${typeof value} — not representable losslessly (FR-009)`,
        );
    }

    // Circular-reference guard: a node revisited through its own descendants
    // is a cycle; paths are tracked so the error names both ends. Sibling
    // sharing (a DAG) is NOT a cycle — JSON duplicates shared subtrees
    // losslessly — so the entry is removed when the subtree completes.
    const prior = active.get(value);
    if (prior !== undefined) {
      throw new Error(
        `serializeFileEventRecord: circular reference at ${path} — ${prior} is an ancestor of ${path}; JSON cannot represent object cycles (FR-009)`,
      );
    }
    // Depth ceiling (FR-009): a value nested past the shared
    // `MAX_SAFE_RECORD_DEPTH` cannot be verified safely — the recursive
    // pre-scan (and the serializer/round-trip recursion it guards) would
    // overflow the call stack on hostile input, escaping as a raw
    // RangeError with no contextual error. Depth counts from the record
    // root exactly like the read side (the event value sits at depth 1), so
    // the write boundary can never emit a record the strict reader rejects
    // on depth; and the ceiling sits far below the engine's overflow
    // threshold, so the maximum recursion this walk admits is safe.
    if (depth > MAX_SAFE_RECORD_DEPTH) {
      throw new Error(
        `serializeFileEventRecord: event nesting exceeds the safe depth ceiling ${MAX_SAFE_RECORD_DEPTH} at ${path} (depth ${depth}) — deeper values would overflow the serializer's recursive walks; refusing to persist a value the write boundary cannot safely verify (FR-009)`,
      );
    }
    active.set(value, path);
    try {
      const proto = Object.getPrototypeOf(value);

      if (value instanceof Date) {
        if (proto !== Date.prototype) {
          throw new Error(
            `serializeFileEventRecord: ${path} is a ${kindName(value)} — a subclassed Date would round-trip as a plain Date; toJson cannot preserve the class (FR-009)`,
          );
        }
        const own = Reflect.ownKeys(value);
        if (own.length > 0) {
          throw new Error(
            `serializeFileEventRecord: ${path} is a Date with own property ${renderPathSegment(own[0] as PropertyKey)} — toJson persists only the instant; the property would be silently dropped (FR-009)`,
          );
        }
        if (Number.isNaN(value.getTime())) {
          throw new Error(
            `serializeFileEventRecord: ${path} is an invalid Date (NaN instant) — it has no ISO-8601 representation (FR-009)`,
          );
        }
        return;
      }

      if (value instanceof Map) {
        if (proto !== Map.prototype) {
          throw new Error(
            `serializeFileEventRecord: ${path} is a ${kindName(value)} — a subclassed Map would round-trip as a plain Map; toJson cannot preserve the class (FR-009)`,
          );
        }
        const own = Reflect.ownKeys(value);
        if (own.length > 0) {
          throw new Error(
            `serializeFileEventRecord: ${path} is a Map with own property ${renderPathSegment(own[0] as PropertyKey)} — toJson persists only the entries; the property would be silently dropped (FR-009)`,
          );
        }
        let index = 0;
        for (const [k, v] of value.entries()) {
          walk(k, `${path}[map entry #${index} key]`, active, depth + 1);
          walk(v, `${path}[map entry #${index} value]`, active, depth + 1);
          index++;
        }
        return;
      }

      if (value instanceof Set) {
        if (proto !== Set.prototype) {
          throw new Error(
            `serializeFileEventRecord: ${path} is a ${kindName(value)} — a subclassed Set would round-trip as a plain Set; toJson cannot preserve the class (FR-009)`,
          );
        }
        const own = Reflect.ownKeys(value);
        if (own.length > 0) {
          throw new Error(
            `serializeFileEventRecord: ${path} is a Set with own property ${renderPathSegment(own[0] as PropertyKey)} — toJson persists only the items; the property would be silently dropped (FR-009)`,
          );
        }
        let index = 0;
        for (const item of value.values()) {
          walk(item, `${path}[set item #${index}]`, active, depth + 1);
          index++;
        }
        return;
      }

      if (Array.isArray(value)) {
        if (proto !== Array.prototype) {
          throw new Error(
            `serializeFileEventRecord: ${path} is a ${kindName(value)} — a subclassed or foreign-realm array would round-trip as a plain array; toJson cannot preserve the class (FR-009)`,
          );
        }
        // JSON arrays persist only their indices (0..length-1): symbol keys,
        // non-enumerable keys, and extra string keys (arr.foo = 1) are all
        // dropped by both JSON.stringify and serializeValue's map().
        for (const key of Reflect.ownKeys(value)) {
          if (key === "length") continue;
          const isIndex =
            typeof key === "string" &&
            /^(0|[1-9]\d*)$/.test(key) &&
            Number(key) < value.length;
          if (!isIndex) {
            throw new Error(
              `serializeFileEventRecord: ${path} is an array with own property ${renderPathSegment(key)} — JSON arrays persist only their indices (0..length-1); this property would be silently dropped (FR-009)`,
            );
          }
        }
        for (let i = 0; i < value.length; i++) {
          // Array-index getters are rejected by descriptor inspection too —
          // `value[i]` would invoke the getter (possibly throwing or
          // non-deterministic), and the pre-scan never invokes getters.
          // (`value[i]` is still safe AFTER this check: a non-accessor
          // index is a plain data read.)
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (descriptor !== undefined && "get" in descriptor) {
            throw new Error(
              `serializeFileEventRecord: ${path}[${i}] is an array-index accessor — the losslessness pre-scan never invokes getters, and toJson would; the element's losslessness cannot be verified (FR-009)`,
            );
          }
          walk(value[i], `${path}[${i}]`, active, depth + 1);
        }
        return;
      }

      // Not a plain object — JSON-less or class-shaped: WeakMap, WeakSet,
      // RegExp, Promise, class instances, typed arrays, boxed primitives,
      // cross-realm Date/Map/Set/array, anything Object.entries would
      // funnel to `{}`.
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(
          `serializeFileEventRecord: ${path} has kind ${kindName(value)} — only primitives, plain objects, arrays, and Date/Map/Set instances with their standard prototypes are representable losslessly (FR-009)`,
        );
      }

      const obj = value as Record<string, unknown>;

      // Custom toJSON rejection WITHOUT invoking anything: JSON.stringify
      // reads `toJSON` via Get — an own ACCESSOR would be invoked, so an
      // own toJSON accessor is rejected outright (the pre-scan never
      // invokes getters); an own data toJSON is rejected when callable;
      // an inherited callable toJSON is only reachable through
      // Object.prototype (null-proto objects have no inheritance) and is
      // read via ITS descriptor. `typeof obj.toJSON` is never used here —
      // it would invoke a throwing accessor and let a raw engine error
      // escape without FR-009 context.
      const toJSONDescriptor = Object.getOwnPropertyDescriptor(obj, "toJSON");
      if (toJSONDescriptor !== undefined && "get" in toJSONDescriptor) {
        throw new Error(
          `serializeFileEventRecord: ${path} has a custom toJSON accessor — JSON.stringify would invoke it and persist its return value instead of the object itself; the losslessness pre-scan never invokes getters, so the object cannot be verified (FR-009)`,
        );
      }
      const toJSONValue =
        toJSONDescriptor !== undefined
          ? toJSONDescriptor.value
          : proto === Object.prototype
            ? Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")?.value
            : undefined;
      if (typeof toJSONValue === "function") {
        throw new Error(
          `serializeFileEventRecord: ${path} has a custom toJSON method — JSON.stringify would persist the method's return value instead of the object itself (FR-009)`,
        );
      }

      // Every own key must be a string enumerable key: symbol keys and
      // non-enumerable string keys are invisible to Object.entries AND to
      // JSON.stringify, so they would be dropped on both comparison sides.
      const enumerable = new Set(Object.keys(obj));
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !enumerable.has(key)) {
          throw new Error(
            typeof key === "symbol"
              ? `serializeFileEventRecord: ${path} has symbol-keyed own property ${renderPathSegment(key)} — Object.entries/JSON.stringify never visit symbol keys; it would be silently dropped (FR-009)`
              : `serializeFileEventRecord: ${path} has non-enumerable own property ${renderPathSegment(key)} — JSON persists only enumerable own properties; it would be silently dropped (FR-009)`,
          );
        }
      }

      for (const key of enumerable) {
        if (POLLUTION_FILTERED_KEYS.has(key)) {
          throw new Error(
            `serializeFileEventRecord: ${path} has key ${JSON.stringify(key)} — toJson filters it as a prototype-pollution vector, so it would be silently dropped from the persisted record (FR-009)`,
          );
        }
        if (RESERVED_TAG_KEYS.has(key)) {
          throw new Error(
            `serializeFileEventRecord: ${path} has literal reserved tag key ${JSON.stringify(key)} — it is unambiguous only as serialize.ts's internal marker; in a plain event object it would round-trip as a different type or vanish (FR-009)`,
          );
        }
        // Accessor properties (an own descriptor carrying a `get`) are
        // rejected BY INSPECTION — fail closed, never by invoking the
        // getter. A getter's value is only observable by calling it, which
        // the pre-scan refuses to do (it may throw, have side effects, or
        // return a different value than `toJson`'s own Get would observe),
        // so an accessor's losslessness can never be verified — refusal is
        // the only sound verdict, even when the getter would return
        // JSON-safe data.
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (descriptor !== undefined && "get" in descriptor) {
          throw new Error(
            `serializeFileEventRecord: ${path} has accessor property ${renderPathSegment(key)} — a getter's value is only observable by invoking it, which the losslessness pre-scan refuses to do; toJson would invoke it, so the property's losslessness cannot be verified (FR-009)`,
          );
        }
      }

      for (const key of enumerable) {
        walk(ownValue(value, key), `${path}${renderPathSegment(key)}`, active, depth + 1);
      }
    } finally {
      active.delete(value);
    }
  };

  // Depth 1 = the `event` field's own position in the record tree, exactly
  // where the read side's raw scan starts counting — the two boundaries
  // share one depth domain, so a value accepted here is never rejected as
  // too deep when it is read back.
  walk(event, "event", new Map<object, string>(), 1);
};

/** Public typed throwing shell for the losslessness pre-scan. */
export const assertLosslessEvent = (event: unknown): void => {
  try {
    assertLosslessEventUnchecked(event);
  } catch (error) {
    throw fileOperationError("assertLosslessEvent", "event payload", error);
  }
};

// ---------------------------------------------------------------------------
// Raw-JSON read-pipeline entry (fail-closed prototype-pollution pre-scan)
// ---------------------------------------------------------------------------

/**
 * Fail-closed read-side pre-scan: walk a PLAIN-JSON value (the output of
 * `JSON.parse`, before `deserializeValue` runs) and return the first
 * prototype-pollution-filtered key (`__proto__`/`constructor`/`prototype`)
 * as a `hit`, a `too-deep` depth violation, or `clean`. `deserializeValue`
 * silently ERASES these keys (prototype-pollution defense — the same set
 * the write pre-scan rejects), so an on-disk record containing one would
 * read back truncated with no error; the strict reader must detect the key
 * BEFORE deserialization erases it. Exact-keyed: a `"constructor"` string
 * VALUE, a `"key_constructor"` key, or a Map key are data and pass.
 * `JSON.parse` output has no accessors and no cycles, so plain property
 * reads are safe here.
 *
 * ITERATIVE (explicit stack, no JS recursion): a hostile record nested
 * ~50k deep parses fine in V8's iterative JSON.parse but overflowed the
 * call stack in the previous recursive walk, escaping the read seam as a
 * raw RangeError. The walk now cannot overflow at ANY depth, and a record
 * whose chain exceeds `MAX_SAFE_RECORD_DEPTH` fails closed with a
 * `too-deep` verdict (the caller wraps it in a typed FR-009 error naming
 * the source). Depth counts hops from the record root (the `event` value
 * sits at depth 1), matching the write side's count exactly.
 *
 * Exported for the checkpoint-envelope seam in `resume.ts`: the checkpoint
 * decode path runs the SAME raw-JSON pollution pre-scan (parity with the
 * strict record codec) before `deserializeValue` erases pollution keys.
 */
export const findPollutionKey = (value: unknown): ScanVerdict => {
  const stack: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly chain: PathLink | null;
  }> = [{ value, depth: 0, chain: null }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.value === null || typeof frame.value !== "object") continue;
    if (frame.depth > MAX_SAFE_RECORD_DEPTH) {
      return {
        kind: "too-deep",
        depth: frame.depth,
        path: renderChain(frame.chain, "record"),
      };
    }
    if (Array.isArray(frame.value)) {
      // Push in reverse so the pop order is left-to-right (DFS order).
      for (let i = frame.value.length - 1; i >= 0; i--) {
        stack.push({
          value: frame.value[i],
          depth: frame.depth + 1,
          chain: { text: renderPathSegment(i), parent: frame.chain },
        });
      }
      continue;
    }
    const obj = frame.value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (POLLUTION_FILTERED_KEYS.has(key)) {
        return {
          kind: "hit",
          key,
          path: renderChain({ text: renderPathSegment(key), parent: frame.chain }, "record"),
        };
      }
    }
    const keys = Object.keys(obj);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      stack.push({
        value: obj[key],
        depth: frame.depth + 1,
        chain: { text: renderPathSegment(key), parent: frame.chain },
      });
    }
  }
  return { kind: "clean" };
};

/**
 * The single raw-JSON entry point of the file event-record READ pipeline
 * (used by the event-log reader `readStrict`): `JSON.parse` → shared exact
 * canonical serializer-grammar validation → `deserializeValue`
 * (Map/Set/Date/undefined restored). Validation MUST precede deserialization:
 * the permissive decoder recognizes a tag whenever its key is present and
 * otherwise filters pollution keys, so malformed tags or extra siblings
 * could be reinterpreted/erased before the record parser observed the raw
 * bytes. JSON and grammar errors both name the source and carry FR-009.
 */
export const tryParseEventRecordJson = (
  json: string,
  source: string,
): Result<unknown, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return err(
      `${source}: not valid JSON: ${safeErrorMessage(error)} (FR-009)`,
    );
  }
  // Validate the complete RAW persisted tree before the permissive decoder
  // can reinterpret a reserved-tag object or discard any sibling/pollution
  // field. This is the exact shared serializer grammar used by the file
  // checkpointer: tags are closed one-key objects with canonical payloads,
  // Map entries are exact pairs, and every nested value is depth-bounded.
  const grammar = validateSerializedValueGrammar(parsed, {
    rootPath: "record",
    maxDepth: MAX_SAFE_RECORD_DEPTH,
  });
  if (!grammar.ok) {
    return err(
      `${source}: serialized record is not canonical: ${grammar.error}; the record is corrupt or hostile and the reader fails closed (FR-009)`,
    );
  }

  const deserialized = tryCatch(() => deserializeValue(parsed));
  if (!deserialized.ok) {
    return err(
      `${source}: not valid JSON: ${deserialized.error.message} (FR-009)`,
    );
  }
  return ok(deserialized.value);
};

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/**
 * Serialize a record to its on-disk JSON via `toJson` (Map/Set/Date
 * survive). Throws on invariant violations: the write side must never emit
 * a record the strict reader would reject (non-FR-015 dedupKey, invalid
 * sequence/timestamp, a top-level `undefined` event — which the read path
 * treats as missing — or a sequence past `MAX_LEXICOGRAPHIC_SEQUENCE`, the
 * 6-digit lexicographic ceiling shared with `eventFileName`).
 *
 * The event value is PRE-SCANNED FIRST (`assertLosslessEvent`, FR-009): a
 * recursive walk rejects anything the serializer cannot represent
 * losslessly — own accessor properties (rejected by descriptor inspection;
 * the pre-scan never invokes getters), symbol-keyed or non-enumerable own
 * properties, JSON-less
 * values (WeakMap/WeakSet/RegExp/Promise/class instances/typed arrays/
 * boxed primitives), prototype-pollution-filtered keys
 * (`__proto__`/`constructor`/`prototype`), literal reserved tag keys
 * (`__map__`/`__set__`/`__date__`/`__undefined__`), custom `toJSON`
 * methods, BigInt, functions, symbols, invalid Dates, and circular
 * references — each with a message naming the offending kind and path.
 * These losses are invisible to a round-trip comparison (`serializeValue`
 * drops the same things on both sides), so they are refused BEFORE any
 * JSON is produced: silent loss is unrepresentable at the write boundary.
 *
 * After the pre-scan, the JSON is ROUND-TRIP-VERIFIED (FR-009): `toJson`
 * runs inside `tryCatch` (an unexpected engine error still yields THIS
 * module's contextual error, never a raw engine error), and the result is
 * parsed back and the parsed `event` must deep-equal the canonicalized
 * input event (via the same `serializeValue` identity). The round-trip
 * backstops the coercion class the pre-scan defers — `JSON.stringify`
 * silently converts NaN/±Infinity to `null` — and any divergence throws
 * the contextual FR-009 error instead of silently mutating the
 * authoritative journal. The one ACCEPTED coercion is the `-0` → `0`
 * normalization: the deep-equal compares with `===`, not `Object.is`
 * (JSON normalizes the sign of zero).
 */
const serializeFileEventRecordUnchecked = (
  sequence: number,
  dedupKey: string,
  recordedAtMs: number,
  event: unknown,
): string => {
  // FR-009 write-boundary pre-scan FIRST: reject any event value the
  // serializer cannot represent losslessly. The round-trip check cannot see
  // these losses — serializeValue strips/drops identically on both
  // comparison sides — so they must be refused before any JSON is produced.
  assertLosslessEventUnchecked(event);

  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(
      `serializeFileEventRecord: sequence must be a non-negative safe integer, got ${render(sequence)}`,
    );
  }
  if (sequence > MAX_LEXICOGRAPHIC_SEQUENCE) {
    throw new Error(
      `serializeFileEventRecord: sequence ${sequence} exceeds the 6-digit lexicographic ceiling ${MAX_LEXICOGRAPHIC_SEQUENCE} — a 7-digit prefix would sort before "999999-" and break sorted-listing = append order (AD-2, FR-009)`,
    );
  }
  const keyError = dedupKeyError(dedupKey);
  if (keyError !== null) {
    throw new Error(`serializeFileEventRecord: ${keyError}`);
  }
  if (typeof recordedAtMs !== "number" || !Number.isFinite(recordedAtMs)) {
    throw new Error(
      `serializeFileEventRecord: recordedAtMs must be a finite number, got ${render(recordedAtMs)} (FR-009)`,
    );
  }
  if (event === undefined) {
    throw new Error(
      "serializeFileEventRecord: event must not be undefined — the strict reader treats an undefined event as missing (FR-009)",
    );
  }

  // `toJson` may THROW (BigInt values, circular structures — the raw engine
  // error carries no module/rule context) or return a non-string (a top-level
  // symbol/function event stringifies to JSON `undefined`). Both cases are
  // contextualized here per FR-009. (The pre-scan rejects BigInt, symbols,
  // functions and cycles up front; this is the defense-in-depth backstop.)
  const serialized = tryCatch(() =>
    toJson({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sequence,
      dedupKey,
      recordedAtMs,
      event,
    }),
  );
  if (!serialized.ok) {
    throw new Error(
      `serializeFileEventRecord: event is not toJson-serializable — ${serialized.error.message} (FR-009)`,
    );
  }
  const json = serialized.value;
  if (typeof json !== "string") {
    throw new Error(
      `serializeFileEventRecord: event serialized to no JSON (${String(json)}) — a top-level symbol/function value has no JSON representation (FR-009)`,
    );
  }

  // Round-trip verification (FR-009): parse the produced JSON back and
  // require the parsed `event` to deep-equal the canonicalized input event
  // (both sides through the same `serializeValue` identity). Any divergence
  // means JSON silently dropped or mutated part of the caller's event — the
  // persisted record would not be the event the caller appended, and the
  // digest recompute (built on the same lossy `toJson`) could never detect
  // it. Fail closed instead of mutating the authoritative journal.
  const roundTrip = tryFromJson(json);
  if (!roundTrip.ok) {
    throw new Error(
      `serializeFileEventRecord: serialized record failed to parse back — ${roundTrip.error.message} (FR-009)`,
    );
  }
  // The verdict itself (serializeValue canonicalization + deepJsonEqual)
  // runs inside tryCatch so an unexpected engine error — e.g. a RangeError
  // on pathological depth, if the pre-scan ceiling were ever bypassed —
  // still surfaces as THIS module's contextual FR-009 error, never a raw
  // escape. (The pre-scan's depth ceiling keeps the recursion far below
  // the stack-overflow threshold; this is defense in depth.)
  const lossless = tryCatch(() => {
    const parsedEvent = (roundTrip.value as Record<string, unknown>).event;
    const canonicalEvent = serializeValue(event);
    return (
      parsedEvent !== undefined &&
      deepJsonEqual(serializeValue(parsedEvent), canonicalEvent)
    );
  });
  if (!lossless.ok) {
    throw new Error(
      `serializeFileEventRecord: event value failed the losslessness round-trip verification — ${lossless.error.message} (FR-009)`,
    );
  }
  if (!lossless.value) {
    throw new Error(
      `serializeFileEventRecord: event value is not lossless through toJson — JSON.stringify silently drops or mutates non-JSON values (symbol/function properties, non-finite numbers) or the event deserializes to a missing event; refusing to persist a record that diverges from the caller's event (FR-009)`,
    );
  }

  return json;
};

/**
 * Public typed throwing shell for event-record construction. Every invalid
 * sequence/key/timestamp/value and every serializer runtime failure is a
 * closed `FrameworkError` (`cache-error`) with operation context.
 */
export const serializeFileEventRecord = (
  sequence: number,
  dedupKey: string,
  recordedAtMs: number,
  event: unknown,
): string => {
  try {
    return serializeFileEventRecordUnchecked(sequence, dedupKey, recordedAtMs, event);
  } catch (error) {
    throw fileOperationError("serializeFileEventRecord", "event record", error);
  }
};

/**
 * Strict-parse a record read from the journal (FR-009). `raw` is expected to
 * be the output of `tryFromJson` (Map/Set/Date already restored). Any
 * violation returns `err` with a message naming `source` — the reader fails
 * closed, never silently dropping a corrupt record.
 *
 * Rejects: non-object/array raw, wrong schemaVersion, non-safe-integer/
 * negative sequence (including any sequence past the
 * `MAX_LEXICOGRAPHIC_SEQUENCE` 6-digit ceiling, shared with the naming
 * layer), invalid dedupKey charset ("" allowed; `|` rejected per AD-2),
 * non-finite recordedAtMs, missing/undefined event, an event that contains
 * a literal reserved serializer tag key (`__map__`/`__set__`/`__date__`/
 * `__undefined__`) as a plain-object key at any depth — `raw` is
 * `tryFromJson` output, so such a key only exists as a MALFORMED tag
 * encoding (well-formed tag-shaped bytes deserialize to Map/Set/Date/
 * undefined and are byte-identical to legitimate events of those types,
 * reading back as their types); the write pre-scan forbids literal tag
 * keys in plain objects, so such a record is corrupt or hostile — and,
 * fail-closed, ANY unknown top-level field: the schema is exactly
 * `{ schemaVersion, sequence, dedupKey, recordedAtMs, event }`, so a
 * writer emitting a new field fails the reader loudly instead of being
 * silently ignored. NOTE: the raw-JSON pollution pre-scan that guards the
 * read pipeline (`tryParseEventRecordJson`, used by the event-log reader)
 * runs BEFORE this validator — `deserializeValue` would silently erase
 * `__proto__`/`constructor`/`prototype` keys, so they are rejected at the
 * raw-text seam, not here.
 */
const parseFileEventRecordUnchecked = (
  raw: unknown,
  source: string,
): Result<FileEventRecord, string> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(`${source}: event record must be a JSON object, got ${render(raw)}`);
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "schemaVersion" && key !== "sequence" && key !== "dedupKey" && key !== "recordedAtMs" && key !== "event") {
      return err(
        `${source}: unknown top-level field ${render(key)} — the strict record schema is { schemaVersion, sequence, dedupKey, recordedAtMs, event } and rejects unknown fields (FR-009)`,
      );
    }
  }

  const { schemaVersion, sequence, dedupKey, recordedAtMs, event } = record;

  if (schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    return err(
      `${source}: unsupported schemaVersion ${render(schemaVersion)} — expected ${JOURNAL_SCHEMA_VERSION} (FR-009)`,
    );
  }

  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    return err(
      `${source}: sequence must be a non-negative safe integer, got ${render(sequence)} (FR-009)`,
    );
  }
  if (sequence > MAX_LEXICOGRAPHIC_SEQUENCE) {
    return err(
      `${source}: sequence ${render(sequence)} exceeds the 6-digit lexicographic ceiling ${MAX_LEXICOGRAPHIC_SEQUENCE} — the codec and the naming layer share one sequence domain, so a 7-digit sequence can never sort before a 6-digit one (FR-009)`,
    );
  }

  // Single FR-015 encoding: the guard IS `isDedupKey` (derived from
  // `dedupKeyError`), and the rejection message comes from the same
  // `dedupKeyError` — there is no second rule to drift.
  if (!isDedupKey(dedupKey)) {
    return err(
      `${source}: ${dedupKeyError(dedupKey) ?? `dedupKey ${render(dedupKey)} is not a valid FR-015 key`}`,
    );
  }

  if (typeof recordedAtMs !== "number" || !Number.isFinite(recordedAtMs)) {
    return err(
      `${source}: recordedAtMs must be a finite number, got ${render(recordedAtMs)} (FR-009)`,
    );
  }

  if (event === undefined) {
    return err(`${source}: missing event field (FR-009)`);
  }

  // Reserved-tag domain agreement: the write pre-scan can never produce a
  // record containing a literal reserved tag key in a plain object, so one
  // that does is corrupt or hostile — fail closed, naming the source.
  const reserved = findReservedTagKey(event);
  if (reserved.kind !== "clean") {
    if (reserved.kind === "too-deep") {
      return err(
        `${source}: event nesting exceeds the safe depth ceiling ${MAX_SAFE_RECORD_DEPTH} at ${reserved.path} (depth ${reserved.depth}) — deeper values would overflow the reader's recursive walks; the record is corrupt or hostile and the reader fails closed (FR-009)`,
      );
    }
    return err(
      `${source}: event contains literal reserved serializer tag key ${JSON.stringify(reserved.key)} at ${reserved.path} — the write boundary pre-scan forbids literal tag keys in plain objects (they exist only as toJson's own markers), so this record is corrupt or hostile (FR-009)`,
    );
  }

  return ok({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sequence,
    dedupKey,
    recordedAtMs,
    event,
  });
};

/** Result-preserving public parser shell: hostile runtime values never throw. */
export const parseFileEventRecord = (
  raw: unknown,
  source: string,
): Result<FileEventRecord, string> => {
  try {
    return parseFileEventRecordUnchecked(raw, source);
  } catch (error) {
    return err(
      `${safeDiagnosticRender(source)}: event-record inspection failed: ${safeErrorMessage(error)} (FR-040)`,
    );
  }
};

/**
 * Read-side companion of the write pre-scan's reserved-tag rejection: walk
 * `event` and return the first plain object carrying a literal reserved tag
 * key (`__map__`/`__set__`/`__date__`/`__undefined__`) as a `hit`, a
 * `too-deep` depth violation, or `clean`. On-disk data comes from
 * `tryFromJson`, so values here are primitives, plain objects, arrays,
 * Map/Set/Date — the `seen` set only guards hand-built raw against cycles
 * and sharing. A literal tag key in a plain object in this output space is
 * BY DEFINITION a malformed tag encoding (well-formed tag-shaped bytes
 * deserialize to Map/Set/Date/undefined and are byte-identical to
 * legitimate events of those types). Map/Set/Date VALUES and tag-looking
 * KEYS inside Map/Set entries are legitimate and pass untouched; only
 * literal tag keys in PLAIN OBJECTS are corrupt (the write pre-scan
 * forbids them at every depth, so writer and reader agree).
 *
 * ITERATIVE (explicit stack, no JS recursion) with the shared
 * `MAX_SAFE_RECORD_DEPTH` ceiling: a hostile ~50k-deep record previously
 * overflowed the recursive walk and escaped `parseFileEventRecord`'s
 * `Result` as a raw RangeError. The walk now cannot overflow at ANY depth
 * and a chain past the ceiling fails closed with a `too-deep` verdict (the
 * caller wraps it in a typed FR-009 error naming the source). Depth counts
 * hops from the record root — the `event` value sits at depth 1, matching
 * the write side's count exactly.
 */
const findReservedTagKey = (event: unknown): ScanVerdict => {
  const stack: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly chain: PathLink | null;
  }> = [{ value: event, depth: 1, chain: { text: "event", parent: null } }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const value = frame.value;
    if (value === null || typeof value !== "object") continue;
    // Shared nodes (hand-built raw only — JSON output has no sharing) are
    // scanned once: the subtree verdict is path-independent, so a second
    // visit adds nothing. Checked BEFORE the depth gate so a node already
    // scanned at a shallow depth is never re-flagged via a deeper chain.
    if (seen.has(value)) continue;
    if (frame.depth > MAX_SAFE_RECORD_DEPTH) {
      return {
        kind: "too-deep",
        depth: frame.depth,
        path: renderChain(frame.chain, ""),
      };
    }
    seen.add(value);
    if (value instanceof Map) {
      const entries = [...value.entries()];
      // Push each entry's VALUE before its KEY and entries in reverse, so
      // the pop order is entry 0 key → value → entry 1 key → value …
      // (DFS order, identical to the recursive walk).
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i];
        stack.push({
          value: v,
          depth: frame.depth + 1,
          chain: { text: `[map entry #${i} value]`, parent: frame.chain },
        });
        stack.push({
          value: k,
          depth: frame.depth + 1,
          chain: { text: `[map entry #${i} key]`, parent: frame.chain },
        });
      }
      continue;
    }
    if (value instanceof Set) {
      const items = [...value.values()];
      for (let i = items.length - 1; i >= 0; i--) {
        stack.push({
          value: items[i],
          depth: frame.depth + 1,
          chain: { text: `[set item #${i}]`, parent: frame.chain },
        });
      }
      continue;
    }
    if (value instanceof Date) continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({
          value: value[i],
          depth: frame.depth + 1,
          chain: { text: renderPathSegment(i), parent: frame.chain },
        });
      }
      continue;
    }
    // Plain object (deserializeValue's output space): literal tag KEYS are
    // the corrupt form; the values may hold further objects to walk.
    for (const key of Object.keys(value)) {
      if (RESERVED_TAG_KEYS.has(key)) {
        return {
          kind: "hit",
          key,
          path: renderChain({ text: renderPathSegment(key), parent: frame.chain }, ""),
        };
      }
    }
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      stack.push({
        value: ownValue(value, key),
        depth: frame.depth + 1,
        chain: { text: renderPathSegment(key), parent: frame.chain },
      });
    }
  }
  return { kind: "clean" };
};
