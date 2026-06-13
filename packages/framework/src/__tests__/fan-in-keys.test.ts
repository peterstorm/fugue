// Direct unit tests for the two pure, load-bearing introspection functions that
// `defineSources` (definition-time) and `fugue lint` B1 both depend on:
//   - `objectSchemaKeys` (llm/zod-schema) — top-level keys of a Zod object, or
//     `null` when the schema isn't an introspectable object.
//   - `fanInKeyCheck` (executor/fan-in-keys) — ok / mismatch / unverifiable.
// Both are exercised transitively through their callers, but their defensive
// branches (non-Zod input, non-object schema, render failure) are NOT all
// reachable through those callers. A direct table here pins the
// `null`-on-unintrospectable contract both callers rely on, so a future refactor
// of the introspection logic cannot silently regress it.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { objectSchemaKeys } from "../llm/zod-schema.js";
import { fanInKeyCheck } from "../executor/fan-in-keys.js";

describe("objectSchemaKeys", () => {
  it("returns the top-level property names of a Zod object schema", () => {
    const keys = objectSchemaKeys(z.object({ a: z.number(), b: z.string() }));
    expect(keys).not.toBeNull();
    expect([...(keys ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("returns [] for an empty object schema", () => {
    expect(objectSchemaKeys(z.object({}))).toEqual([]);
  });

  it("returns null for z.unknown() (introspectable but not an object)", () => {
    expect(objectSchemaKeys(z.unknown())).toBeNull();
  });

  it("returns null for a union (non-object JSON-Schema result)", () => {
    expect(objectSchemaKeys(z.union([z.object({ a: z.number() }), z.object({ b: z.number() })]))).toBeNull();
  });

  it("returns null for a non-object primitive schema", () => {
    expect(objectSchemaKeys(z.string())).toBeNull();
    expect(objectSchemaKeys(z.number())).toBeNull();
  });

  it("returns null for a value that isn't a Zod schema at all", () => {
    expect(objectSchemaKeys(null)).toBeNull();
    expect(objectSchemaKeys(undefined)).toBeNull();
    expect(objectSchemaKeys(42)).toBeNull();
    expect(objectSchemaKeys({ shape: { a: 1 } })).toBeNull(); // object, but no `parse`
    expect(objectSchemaKeys({ parse: "not a function" })).toBeNull();
  });

  it("returns null (not throw) when introspection blows up", () => {
    // A `parse`-bearing object whose `toJSONSchema` rendering throws must be
    // caught and reported as `null`, not propagated.
    const hostile = { parse: () => undefined } as unknown;
    expect(objectSchemaKeys(hostile)).toBeNull();
  });
});

describe("fanInKeyCheck", () => {
  const A = z.object({ a: z.number() });
  const B = z.object({ b: z.number() });

  it("ok when object-schema keys equal the incoming source ids", () => {
    expect(fanInKeyCheck(z.object({ "src-a": A, "src-b": B }), ["src-a", "src-b"])).toEqual({ kind: "ok" });
  });

  it("ok is order-independent", () => {
    expect(fanInKeyCheck(z.object({ "src-b": B, "src-a": A }), ["src-a", "src-b"])).toEqual({ kind: "ok" });
  });

  it("mismatch reports missing and extra keys", () => {
    const result = fanInKeyCheck(z.object({ "src-a": A, WRONG: B }), ["src-a", "src-b"]);
    expect(result.kind).toBe("mismatch");
    const m = result as Extract<typeof result, { kind: "mismatch" }>;
    expect(m.missing).toEqual(["src-b"]); // incoming source with no key
    expect(m.extra).toEqual(["WRONG"]); // key with no incoming source
    expect([...m.schemaKeys].sort()).toEqual(["WRONG", "src-a"]);
  });

  it("unverifiable when the schema isn't an introspectable object", () => {
    expect(fanInKeyCheck(z.unknown(), ["src-a", "src-b"])).toEqual({ kind: "unverifiable" });
    expect(fanInKeyCheck(z.union([A, B]), ["src-a", "src-b"])).toEqual({ kind: "unverifiable" });
    expect(fanInKeyCheck("not a schema", ["src-a", "src-b"])).toEqual({ kind: "unverifiable" });
  });
});
