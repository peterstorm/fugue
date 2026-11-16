// FROZEN ORACLE — do not edit. The FR-009 write pre-scan walk exactly as it
// was before ADR-0091 made it allocation-free (`assertLosslessEventUnchecked`
// and its scalar classification, event-record.ts at 3ec970a3). The helpers
// that change left untouched are imported, not copied. The differential test
// in file-lossless-prescan-parity.test.ts holds the current walk to this
// walk's verdicts and messages byte-for-byte.

import { match } from "ts-pattern";
import { MAX_SAFE_RECORD_DEPTH, POLLUTION_KEYS, RESERVED_TAG_KEYS } from "../../state-machine/serialize.js";
import { kindName, ownValue, renderPathSegment, unrepresentableKind } from "../../file/event-record.js";

type UnrepresentableKind = "BigInt" | "symbol" | "function";

/**
 * What the write pre-scan walk does with one value — a pure classification;
 * the walk alone decides that a rejection throws.
 */
type WalkClassification =
  | { readonly kind: "scalar" }
  | { readonly kind: "walkable"; readonly value: object }
  | { readonly kind: "unrepresentable"; readonly jsonGap: UnrepresentableKind };

const SCALAR: WalkClassification = { kind: "scalar" };

const unrepresentable = (jsonGap: UnrepresentableKind): WalkClassification => ({
  kind: "unrepresentable",
  jsonGap,
});

/**
 * First gate of the write pre-scan walk: a non-null object is walkable (the
 * walk descends into it, carrying the narrowed value), a JSON scalar
 * (null/undefined/string/number/boolean) is admitted as-is, and bigint/
 * symbol/function are `unrepresentable`. Every `typeof` result is matched
 * exhaustively — there is no `default` arm left to hide a kind this walk does
 * not admit.
 */
const classifyWalkValue = (value: unknown): WalkClassification => {
  if (typeof value === "object" && value !== null) return { kind: "walkable", value };
  return match(typeof value)
    // "object" is reachable here only as `null`: non-null objects returned above.
    .with("string", "number", "boolean", "undefined", "object", () => SCALAR)
    .with("bigint", () => unrepresentable("BigInt"))
    .with("symbol", () => unrepresentable("symbol"))
    .with("function", () => unrepresentable("function"))
    .exhaustive();
};

export const legacyAssertLossless = (
  event: unknown,
  labels: { operation: string; root: string } = {
    operation: "serializeFileEventRecord",
    root: "event",
  },
): void => {
  const { operation, root } = labels;
  const walk = (
    candidate: unknown,
    path: string,
    active: Map<object, string>,
    depth: number,
  ): void => {
    const classified = classifyWalkValue(candidate);
    if (classified.kind === "scalar") return;
    if (classified.kind === "unrepresentable") {
      throw unrepresentableKind(operation, path, classified.jsonGap);
    }
    const value = classified.value;

    // Circular-reference guard: a node revisited through its own descendants
    // is a cycle; paths are tracked so the error names both ends. Sibling
    // sharing (a DAG) is NOT a cycle — JSON duplicates shared subtrees
    // losslessly — so the entry is removed when the subtree completes.
    const prior = active.get(value);
    if (prior !== undefined) {
      throw new Error(
        `${operation}: circular reference at ${path} — ${prior} is an ancestor of ${path}; JSON cannot represent object cycles (FR-009)`,
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
        `${operation}: ${root} nesting exceeds the safe depth ceiling ${MAX_SAFE_RECORD_DEPTH} at ${path} (depth ${depth}) — deeper values would overflow the serializer's recursive walks; refusing to persist a value the write boundary cannot safely verify (FR-009)`,
      );
    }
    active.set(value, path);
    try {
      const proto = Object.getPrototypeOf(value);

      if (value instanceof Date) {
        if (proto !== Date.prototype) {
          throw new Error(
            `${operation}: ${path} is a ${kindName(value)} — a subclassed Date would round-trip as a plain Date; toJson cannot preserve the class (FR-009)`,
          );
        }
        const own = Reflect.ownKeys(value);
        if (own.length > 0) {
          throw new Error(
            `${operation}: ${path} is a Date with own property ${renderPathSegment(own[0] as PropertyKey)} — toJson persists only the instant; the property would be silently dropped (FR-009)`,
          );
        }
        if (Number.isNaN(value.getTime())) {
          throw new Error(
            `${operation}: ${path} is an invalid Date (NaN instant) — it has no ISO-8601 representation (FR-009)`,
          );
        }
        return;
      }

      if (value instanceof Map) {
        if (proto !== Map.prototype) {
          throw new Error(
            `${operation}: ${path} is a ${kindName(value)} — a subclassed Map would round-trip as a plain Map; toJson cannot preserve the class (FR-009)`,
          );
        }
        const own = Reflect.ownKeys(value);
        if (own.length > 0) {
          throw new Error(
            `${operation}: ${path} is a Map with own property ${renderPathSegment(own[0] as PropertyKey)} — toJson persists only the entries; the property would be silently dropped (FR-009)`,
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
            `${operation}: ${path} is a ${kindName(value)} — a subclassed Set would round-trip as a plain Set; toJson cannot preserve the class (FR-009)`,
          );
        }
        const own = Reflect.ownKeys(value);
        if (own.length > 0) {
          throw new Error(
            `${operation}: ${path} is a Set with own property ${renderPathSegment(own[0] as PropertyKey)} — toJson persists only the items; the property would be silently dropped (FR-009)`,
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
            `${operation}: ${path} is a ${kindName(value)} — a subclassed or foreign-realm array would round-trip as a plain array; toJson cannot preserve the class (FR-009)`,
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
              `${operation}: ${path} is an array with own property ${renderPathSegment(key)} — JSON arrays persist only their indices (0..length-1); this property would be silently dropped (FR-009)`,
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
              `${operation}: ${path}[${i}] is an array-index accessor — the losslessness pre-scan never invokes getters, and toJson would; the element's losslessness cannot be verified (FR-009)`,
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
          `${operation}: ${path} has kind ${kindName(value)} — only primitives, plain objects, arrays, and Date/Map/Set instances with their standard prototypes are representable losslessly (FR-009)`,
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
          `${operation}: ${path} has a custom toJSON accessor — JSON.stringify would invoke it and persist its return value instead of the object itself; the losslessness pre-scan never invokes getters, so the object cannot be verified (FR-009)`,
        );
      }
      // Falls back to Object.prototype's own `toJSON` ONLY when the value has
      // no own descriptor — an own descriptor whose `.value` is undefined still
      // wins, so this is deliberately not `??`.
      const inheritedToJSON = proto === Object.prototype
        ? Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")?.value
        : undefined;
      const toJSONValue = toJSONDescriptor !== undefined ? toJSONDescriptor.value : inheritedToJSON;
      if (typeof toJSONValue === "function") {
        throw new Error(
          `${operation}: ${path} has a custom toJSON method — JSON.stringify would persist the method's return value instead of the object itself (FR-009)`,
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
              ? `${operation}: ${path} has symbol-keyed own property ${renderPathSegment(key)} — Object.entries/JSON.stringify never visit symbol keys; it would be silently dropped (FR-009)`
              : `${operation}: ${path} has non-enumerable own property ${renderPathSegment(key)} — JSON persists only enumerable own properties; it would be silently dropped (FR-009)`,
          );
        }
      }

      for (const key of enumerable) {
        if (POLLUTION_KEYS.has(key)) {
          throw new Error(
            `${operation}: ${path} has key ${JSON.stringify(key)} — toJson filters it as a prototype-pollution vector, so it would be silently dropped from the persisted record (FR-009)`,
          );
        }
        if (RESERVED_TAG_KEYS.has(key)) {
          throw new Error(
            `${operation}: ${path} has literal reserved tag key ${JSON.stringify(key)} — it is unambiguous only as serialize.ts's internal marker; in a plain event object it would round-trip as a different type or vanish (FR-009)`,
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
            `${operation}: ${path} has accessor property ${renderPathSegment(key)} — a getter's value is only observable by invoking it, which the losslessness pre-scan refuses to do; toJson would invoke it, so the property's losslessness cannot be verified (FR-009)`,
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
  walk(event, root, new Map<object, string>(), 1);
};
