/**
 * `serializeLossless` is the gate every durable HITL record passes through
 * before it reaches Redis: a value that silently loses a field, a `Date`, or a
 * `Map` on the way to JSON would resume as a DIFFERENT run than the one that was
 * suspended. It had no dedicated suite — its behaviour was only observed
 * indirectly through `redis-stores.test.ts`, which exercises the happy path.
 *
 * These tests pin the parts that actually make it a gate: what it REFUSES, that
 * a refusal is a typed error rather than a throw, and that the optional schema
 * strengthens the check rather than merely decorating it.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { serializeLossless } from "../../hitl/adapters/lossless-json.js";

const opts = { operation: "test-write", root: "record", subject: "test record" };

describe("serializeLossless — accepts faithful records", () => {
  it("round-trips a plain JSON object and returns the encoded bytes", () => {
    const value = { kind: "approve", actor: "alice", nested: { n: 1, list: [1, 2, 3] } };
    const result = serializeLossless(value, opts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value)).toEqual(value);
  });

  it("preserves an explicit null (distinct from an absent field)", () => {
    const result = serializeLossless({ reason: null }, opts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value)).toEqual({ reason: null });
  });

  it("preserves an undefined property, which plain JSON would drop", () => {
    // `JSON.stringify({u: undefined})` yields `{}` — the key vanishes. The
    // framework codec tags it instead, so the decoded record still HAS the key.
    // That is why this gate uses `toJson`/`fromJson` rather than raw JSON.
    const result = serializeLossless({ u: undefined }, opts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.value)).toEqual({ u: { __undefined__: true } });
  });

  it("REFUSES -0, because this gate is stricter than the framework's own round-trip check", () => {
    // Worth pinning precisely because the two differ. The framework's
    // `deepJsonEqual` compares with `===` and documents `-0` → `0` as an
    // ACCEPTED coercion; this wrapper compares with `isDeepStrictEqual`, which
    // uses `Object.is` semantics for numbers and therefore refuses it. For a
    // durable HITL record that stricter reading is the right one — but it is a
    // deliberate divergence, not an accident, so a change to either side has to
    // come past this test.
    const result = serializeLossless({ delta: -0 }, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal-invariant-violated");
  });
});

describe("serializeLossless — refuses records JSON cannot carry", () => {
  const refuses = (value: unknown, what: string): void => {
    it(`refuses ${what} with a typed error, never a throw`, () => {
      const result = serializeLossless(value, opts);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal-invariant-violated");
        expect(result.error.message).toContain("test record");
        expect(result.error.message).toContain("not losslessly serializable");
      }
    });
  };

  refuses({ big: 1n }, "a BigInt (JSON.stringify throws on it)");
  refuses({ fn: () => 1 }, "a function value (silently dropped by JSON)");
  refuses({ sym: Symbol("s") }, "a symbol value (silently dropped by JSON)");

  it("refuses a cyclic record instead of throwing out of the call", () => {
    const cyclic: Record<string, unknown> = { kind: "approve" };
    cyclic.self = cyclic;
    const result = serializeLossless(cyclic, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal-invariant-violated");
  });

  it("refuses a value whose toJSON lies about its own content", () => {
    // The round-trip comparison — not the encode — is what catches this: the
    // bytes are valid JSON, they just are not THIS value.
    const liar = { kind: "approve", toJSON: () => ({ kind: "reject" }) };
    const result = serializeLossless(liar, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal-invariant-violated");
  });
});

describe("serializeLossless — the schema strengthens the round trip", () => {
  const Schema = z.object({ kind: z.literal("approve"), actor: z.string() });

  it("accepts a record the reader's schema also accepts", () => {
    const value = { kind: "approve" as const, actor: "alice" };
    const result = serializeLossless(value, { ...opts, schema: Schema });
    expect(result.ok).toBe(true);
  });

  it("REFUSES a record that round-trips structurally but the reader would reject", () => {
    // Structurally JSON-clean, so the schema-free check would pass it — and the
    // resume path would then fail to parse its own durable record.
    const value = { kind: "approve" as const, actor: 42 } as unknown as z.infer<typeof Schema>;
    const withoutSchema = serializeLossless(value, opts);
    expect(withoutSchema.ok).toBe(true);

    const withSchema = serializeLossless(value, { ...opts, schema: Schema });
    expect(withSchema.ok).toBe(false);
    if (!withSchema.ok) expect(withSchema.error.kind).toBe("internal-invariant-violated");
  });

  it("REFUSES when the schema strips a field, so stored bytes can never exceed what the reader keeps", () => {
    // A non-stripping mismatch: the schema parses successfully but DROPS
    // `extra`, so the decoded-and-parsed value no longer equals the original.
    // Storing it would silently discard data the writer believed it persisted.
    const value = { kind: "approve" as const, actor: "alice", extra: "dropped" };
    const result = serializeLossless(value, { ...opts, schema: Schema as unknown as z.ZodType<typeof value> });
    expect(result.ok).toBe(false);
  });
});
