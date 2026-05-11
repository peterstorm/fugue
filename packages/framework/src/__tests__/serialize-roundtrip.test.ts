// Wave 6 §6.7: serializeValue/deserializeValue roundtrip property test.
//
// Generates arbitrarily-nested values mixing Map, Set, Array, plain objects,
// and primitives. Asserts the deepEqual roundtrip property holds.

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { serializeValue, deserializeValue, toJson, fromJson } from "../state-machine/serialize.js";

// ---------------------------------------------------------------------------
// Deep equality that understands Map and Set
// ---------------------------------------------------------------------------

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (typeof a !== "object") return Object.is(a, b);

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k)) return false;
      if (!deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Map || b instanceof Map) return false;

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keysA = Object.keys(aObj);
  const keysB = Object.keys(bObj);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(aObj[k], bObj[k]));
};

// ---------------------------------------------------------------------------
// Arbitrary: a recursive "JSON-ish" value enriched with Map<string, V> and
// Set<primitive>. We constrain Map keys to strings (matching the framework's
// actual usage — Map keys are always node ids / dedup keys / etc.).
// ---------------------------------------------------------------------------

const primitive = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.float({ noNaN: true, noDefaultInfinity: true, minExcluded: false }),
  fc.string({ maxLength: 16 }),
);

const value = (): fc.Arbitrary<unknown> =>
  fc.letrec((tie) => ({
    value: fc.oneof(
      { maxDepth: 4, withCrossShrink: true },
      primitive,
      fc.array(tie("value"), { maxLength: 5 }) as fc.Arbitrary<unknown>,
      fc.dictionary(fc.string({ maxLength: 8 }), tie("value"), { maxKeys: 5 }) as fc.Arbitrary<unknown>,
      fc.array(fc.tuple(fc.string({ maxLength: 8 }), tie("value")), { maxLength: 5 })
        .map((pairs) => new Map(pairs as [string, unknown][])) as fc.Arbitrary<unknown>,
      fc.array(primitive, { maxLength: 5 })
        .map((items) => new Set(items)) as fc.Arbitrary<unknown>,
    ),
  })).value;

describe("§6.7 — serialize roundtrip property", () => {
  it("deserialize(serialize(x)) ≅ x for arbitrary Map/Set/Array/object/primitive structures", () => {
    fc.assert(
      fc.property(value(), (x) => {
        const round = deserializeValue(serializeValue(x));
        return deepEqual(round, x);
      }),
      { numRuns: 200 },
    );
  });

  it("fromJson(toJson(x)) ≅ x — the JSON-bracketed form preserves the same invariant", () => {
    fc.assert(
      fc.property(value(), (x) => {
        const round = fromJson(toJson(x));
        return deepEqual(round, x);
      }),
      { numRuns: 200 },
    );
  });

  it("nested Map<string, Set<unknown>> roundtrips (the framework's hot shape)", () => {
    const original = new Map<string, Set<unknown>>([
      ["a", new Set([1, "x", null])],
      ["b", new Set([true, 42])],
    ]);
    const round = deserializeValue(serializeValue(original)) as Map<string, Set<unknown>>;
    expect(round instanceof Map).toBe(true);
    expect(round.size).toBe(2);
    expect(round.get("a") instanceof Set).toBe(true);
    expect([...(round.get("a") as Set<unknown>)].sort()).toEqual([1, "x", null].sort());
  });

  it("empty containers roundtrip preserving type", () => {
    expect(deserializeValue(serializeValue(new Map())) instanceof Map).toBe(true);
    expect(deserializeValue(serializeValue(new Set())) instanceof Set).toBe(true);
    expect((deserializeValue(serializeValue(new Map())) as Map<unknown, unknown>).size).toBe(0);
    expect((deserializeValue(serializeValue(new Set())) as Set<unknown>).size).toBe(0);
  });
});
