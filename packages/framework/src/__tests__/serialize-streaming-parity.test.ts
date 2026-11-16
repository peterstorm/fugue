// `toJson` streams the serializer grammar through JSON.stringify's replacer
// instead of building `serializeValue`'s intermediate tree. Its bytes must be
// exactly `JSON.stringify(serializeValue(v))`, and it must refuse exactly the
// values `serializeValue` refuses, so every reader and every stored checkpoint
// is unaffected.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { MAX_SAFE_RECORD_DEPTH, serializeValue, toJson } from "../state-machine/serialize.js";

/** What the historical two-step `toJson` produced: its bytes, or its error message. */
const reference = (value: unknown): string => {
  try {
    return `ok:${JSON.stringify(serializeValue(value))}`;
  } catch (error) {
    return `throws:${error instanceof Error ? error.message : String(error)}`;
  }
};

const streamed = (value: unknown): string => {
  try {
    return `ok:${toJson(value)}`;
  } catch (error) {
    return `throws:${error instanceof Error ? error.message : String(error)}`;
  }
};

const { value } = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constantFrom(undefined, null, true, false, 0, -0, Number.NaN, Number.POSITIVE_INFINITY, "", "x", 1.5),
    fc.date({ noInvalidDate: true }),
    fc.string(),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(
      fc.oneof(fc.string(), fc.constantFrom("__proto__", "constructor", "prototype", "__map__", "__undefined__")),
      tie("value"),
      { maxKeys: 4 },
    ),
    fc.array(fc.tuple(tie("value"), tie("value")), { maxLength: 3 }).map((entries) => new Map(entries)),
    fc.array(tie("value"), { maxLength: 3 }).map((items) => new Set(items)),
  ),
}));

/** `levels` nested containers produced by `wrap`, around a primitive leaf. */
const nested = (levels: number, wrap: (inner: unknown) => unknown): unknown => {
  let current: unknown = 1;
  for (let level = 0; level < levels; level += 1) current = wrap(current);
  return current;
};

describe("toJson streams the serializer grammar byte-for-byte", () => {
  test("matches JSON.stringify(serializeValue(v)) over arbitrary values", () => {
    fc.assert(fc.property(value, (v) => {
      expect(streamed(v)).toBe(reference(v));
    }), { numRuns: 5000 });
  });

  test("matches on shared references, boxed primitives and own toJSON", () => {
    const shared = { a: 1, d: new Date(0) };
    const cases: readonly unknown[] = [
      { state: { kind: "succeeded", output: shared }, outputs: new Map([["n", shared]]) },
      { n: Object(5), s: Object("s"), b: Object(true) },
      { withToJson: { toJSON: () => ({ m: new Map([["k", 1]]) }), v: 1 } },
      [undefined, () => 1, Symbol("s")],
      { nested: { set: new Set([new Date(1), undefined]) } },
    ];
    for (const c of cases) expect(streamed(c)).toBe(reference(c));
  });

  test("refuses exactly what serializeValue refuses at the depth ceiling", () => {
    for (const levels of [MAX_SAFE_RECORD_DEPTH, MAX_SAFE_RECORD_DEPTH + 1, MAX_SAFE_RECORD_DEPTH + 2, 600]) {
      for (const wrap of [
        (inner: unknown) => [inner],
        (inner: unknown) => ({ k: inner }),
        (inner: unknown) => new Map([["k", inner]]),
        (inner: unknown) => new Set([inner]),
      ]) {
        const v = nested(levels, wrap);
        expect(streamed(v)).toBe(reference(v));
      }
    }
  });
});
