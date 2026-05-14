// Tests for computeJsonPatch — the shallow RFC 6902 JSON Patch diff
// used by HumanInterventionEvent for approve-with-edit forensics.

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { computeJsonPatch } from "../dag-runtime/json-patch.js";

describe("computeJsonPatch", () => {
  test("identical values yield empty patch", () => {
    expect(computeJsonPatch(42, 42)).toEqual([]);
  });

  test("primitive to primitive yields root replace", () => {
    expect(computeJsonPatch(1, 2)).toEqual([
      { op: "replace", path: "/", value: 2 },
    ]);
  });

  test("null to object yields root replace", () => {
    expect(computeJsonPatch(null, { a: 1 })).toEqual([
      { op: "replace", path: "/", value: { a: 1 } },
    ]);
  });

  test("object to null yields root replace", () => {
    expect(computeJsonPatch({ a: 1 }, null)).toEqual([
      { op: "replace", path: "/", value: null },
    ]);
  });

  test("added key yields add op", () => {
    const patch = computeJsonPatch({ a: 1 }, { a: 1, b: 2 });
    expect(patch).toEqual([{ op: "add", path: "/b", value: 2 }]);
  });

  test("removed key yields remove op", () => {
    const patch = computeJsonPatch({ a: 1, b: 2 }, { a: 1 });
    expect(patch).toEqual([{ op: "remove", path: "/b" }]);
  });

  test("changed key yields replace op", () => {
    const patch = computeJsonPatch({ a: 1 }, { a: 2 });
    expect(patch).toEqual([{ op: "replace", path: "/a", value: 2 }]);
  });

  test("multiple changes in one object", () => {
    const patch = computeJsonPatch(
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 99, d: 4 },
    );
    // b changed, c removed, d added
    expect(patch).toContainEqual({ op: "replace", path: "/b", value: 99 });
    expect(patch).toContainEqual({ op: "remove", path: "/c" });
    expect(patch).toContainEqual({ op: "add", path: "/d", value: 4 });
    expect(patch).toHaveLength(3);
  });

  test("nested object change yields replace for the key", () => {
    const patch = computeJsonPatch(
      { a: { nested: 1 } },
      { a: { nested: 2 } },
    );
    expect(patch).toEqual([
      { op: "replace", path: "/a", value: { nested: 2 } },
    ]);
  });

  test("array to array yields root replace", () => {
    expect(computeJsonPatch([1, 2], [3, 4])).toEqual([
      { op: "replace", path: "/", value: [3, 4] },
    ]);
  });

  test("identical arrays yield empty patch", () => {
    const arr = [1, 2, 3];
    expect(computeJsonPatch(arr, arr)).toEqual([]);
  });

  test("keys with ~ and / are RFC 6902 escaped", () => {
    const patch = computeJsonPatch(
      { "a/b": 1, "c~d": 2 },
      { "a/b": 99, "c~d": 88 },
    );
    expect(patch).toContainEqual({ op: "replace", path: "/a~1b", value: 99 });
    expect(patch).toContainEqual({ op: "replace", path: "/c~0d", value: 88 });
  });

  test("string values use reference equality for same strings", () => {
    expect(computeJsonPatch("hello", "hello")).toEqual([]);
  });

  test("different strings yield root replace", () => {
    expect(computeJsonPatch("hello", "world")).toEqual([
      { op: "replace", path: "/", value: "world" },
    ]);
  });

  test("boolean change yields root replace", () => {
    expect(computeJsonPatch(true, false)).toEqual([
      { op: "replace", path: "/", value: false },
    ]);
  });

  test("empty objects yield empty patch", () => {
    expect(computeJsonPatch({}, {})).toEqual([]);
  });

  test("undefined to value yields root replace", () => {
    expect(computeJsonPatch(undefined, 42)).toEqual([
      { op: "replace", path: "/", value: 42 },
    ]);
  });

  test("key with both ~ and / escapes in correct order", () => {
    // RFC 6902: ~ is escaped first to ~0, then / to ~1
    const patch = computeJsonPatch({ "a~/b": 1 }, { "a~/b": 2 });
    expect(patch).toEqual([
      { op: "replace", path: "/a~0~1b", value: 2 },
    ]);
  });

  test("property: computeJsonPatch(x, x) always returns []", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.string(),
          fc.boolean(),
          fc.constant(null),
          fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null))),
        ),
        (x) => {
          expect(computeJsonPatch(x, x)).toEqual([]);
        },
      ),
    );
  });
});
