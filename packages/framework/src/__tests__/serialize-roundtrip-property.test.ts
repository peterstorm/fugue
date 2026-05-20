// Property test: serialize/deserialize round-trip with arbitrary nested structures.
// Asserts `fromJson(toJson(x))` structurally equals `x` for all supported types.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { toJson, fromJson } from "../state-machine/serialize.js";

// ---------------------------------------------------------------------------
// Arbitrary generators for framework-supported value shapes
// ---------------------------------------------------------------------------

/** Generate a leaf value (string, number, boolean, null). */
const leafArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);

/**
 * Generate an arbitrary nested structure containing Map, Set, Array, plain
 * object, and primitive values. Depth is bounded to avoid stack overflow.
 */
const nestedArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  tree: fc.oneof(
    { depthSize: "small" },
    leafArb,
    // Array of trees
    fc.array(tie("tree"), { maxLength: 5 }),
    // Plain object with string keys
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s !== "__map__" && s !== "__set__"),
      tie("tree"),
      { maxKeys: 5 },
    ),
    // Map with string keys and tree values
    fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 8 }), tie("tree")), { maxLength: 5 })
      .map((entries) => new Map(entries)),
    // Set of trees (using string values to avoid reference equality issues)
    fc.array(leafArb, { maxLength: 5 })
      .map((items) => new Set(items)),
  ),
})).tree;

// ---------------------------------------------------------------------------
// Structural equality that understands Map/Set
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    // Set equality by serialized value (since we use primitive leaves in Sets)
    const aVals = [...a].map((v) => JSON.stringify(v)).sort();
    const bVals = [...b].map((v) => JSON.stringify(v)).sort();
    return aVals.every((v, i) => v === bVals[i]);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("serialize/deserialize round-trip (property)", () => {
  test("fromJson(toJson(x)) === x for arbitrary nested structures", () => {
    fc.assert(
      fc.property(nestedArb, (value) => {
        const json = toJson(value);
        const restored = fromJson(json);
        expect(deepEqual(value, restored)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test("toJson produces valid JSON", () => {
    fc.assert(
      fc.property(nestedArb, (value) => {
        const json = toJson(value);
        expect(() => JSON.parse(json)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  test("nested Maps within Sets are preserved", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.string({ minLength: 1, maxLength: 5 }), fc.integer()),
          { minLength: 1, maxLength: 4 },
        ),
        (entries) => {
          const innerMap = new Map(entries);
          const outerMap = new Map([["nested", innerMap]]);
          const restored = fromJson(toJson(outerMap));
          expect(restored).toBeInstanceOf(Map);
          const restoredMap = restored as Map<string, unknown>;
          expect(restoredMap.get("nested")).toBeInstanceOf(Map);
          const restoredInner = restoredMap.get("nested") as Map<string, number>;
          for (const [k, v] of innerMap) {
            expect(restoredInner.get(k)).toBe(v);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("empty containers round-trip", () => {
    const cases = [new Map(), new Set(), [], {}];
    for (const c of cases) {
      const restored = fromJson(toJson(c));
      expect(deepEqual(c, restored)).toBe(true);
    }
  });
});
