/**
 * Unit tests for `computeJsonPatch`.
 *
 * Validates:
 * - Identical objects → empty patch
 * - Added/removed/changed keys → correct ops
 * - Array diff → wholesale replace
 * - Null and primitive diff → replace at root
 * - Nested object deep equality vs reference equality
 * - RFC 6902 key escaping (~ and /)
 */

import { describe, it, expect } from "bun:test";
import { computeJsonPatch } from "../shared/json-patch.js";

describe("computeJsonPatch", () => {
  it("identical objects → empty patch", () => {
    const obj = { a: 1, b: "hello" };
    expect(computeJsonPatch(obj, obj)).toEqual([]);
  });

  it("structurally identical objects → empty patch (deep equality)", () => {
    expect(computeJsonPatch({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("structurally identical nested objects → empty patch", () => {
    expect(
      computeJsonPatch(
        { a: { nested: true } },
        { a: { nested: true } },
      ),
    ).toEqual([]);
  });

  it("added key → add op", () => {
    const patch = computeJsonPatch({ a: 1 }, { a: 1, b: 2 });
    expect(patch).toEqual([{ op: "add", path: "/b", value: 2 }]);
  });

  it("removed key → remove op", () => {
    const patch = computeJsonPatch({ a: 1, b: 2 }, { a: 1 });
    expect(patch).toEqual([{ op: "remove", path: "/b" }]);
  });

  it("changed key → replace op", () => {
    const patch = computeJsonPatch({ a: 1 }, { a: 2 });
    expect(patch).toEqual([{ op: "replace", path: "/a", value: 2 }]);
  });

  it("multiple changes in one pass", () => {
    const patch = computeJsonPatch(
      { a: 1, b: "old", c: true },
      { a: 1, b: "new", d: "added" },
    );
    // b changed, c removed, d added
    const ops = patch.map(p => p.op).sort();
    expect(ops).toEqual(["add", "remove", "replace"]);
  });

  it("array diff → wholesale replace at root", () => {
    const patch = computeJsonPatch([1, 2], [1, 2, 3]);
    expect(patch).toEqual([{ op: "replace", path: "/", value: [1, 2, 3] }]);
  });

  it("null → object → replace at root", () => {
    const patch = computeJsonPatch(null, { a: 1 });
    expect(patch).toEqual([{ op: "replace", path: "/", value: { a: 1 } }]);
  });

  it("primitives → replace at root", () => {
    const patch = computeJsonPatch("hello", "world");
    expect(patch).toEqual([{ op: "replace", path: "/", value: "world" }]);
  });

  it("object → null → replace at root", () => {
    const patch = computeJsonPatch({ a: 1 }, null);
    expect(patch).toEqual([{ op: "replace", path: "/", value: null }]);
  });

  it("nested object changed → replace for that key", () => {
    const patch = computeJsonPatch(
      { a: { x: 1 } },
      { a: { x: 2 } },
    );
    expect(patch).toEqual([{ op: "replace", path: "/a", value: { x: 2 } }]);
  });

  it("escapes ~ and / in keys per RFC 6902", () => {
    const patch = computeJsonPatch(
      { "a/b": 1, "c~d": 2 },
      { "a/b": 1, "c~d": 3 },
    );
    expect(patch).toEqual([{ op: "replace", path: "/c~0d", value: 3 }]);
  });

  it("same reference → empty patch", () => {
    const obj = { a: 1 };
    expect(computeJsonPatch(obj, obj)).toEqual([]);
  });
});
