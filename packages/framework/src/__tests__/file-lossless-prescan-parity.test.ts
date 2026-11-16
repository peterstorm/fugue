// The FR-009 write pre-scan and the exact round-trip check (ADR-0091).
//
// 1. `assertLosslessEvent` no longer allocates a path string, key Set or
//    descriptor per value; its verdicts and messages must be exactly those of
//    the previous walk (frozen in support/legacy-lossless-prescan.ts).
// 2. `assertExactRoundTrip` replaces parsing a writer's own bytes back and
//    comparing: it must accept exactly the values for which
//    `isDeepStrictEqual(fromJson(toJson(v)), v)` holds.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isDeepStrictEqual } from "node:util";
import { assertExactRoundTrip, assertLosslessEvent } from "../file/event-record.js";
import { fromJson, toJson } from "../state-machine/serialize.js";
import { legacyAssertLossless } from "./support/legacy-lossless-prescan.js";

const LABELS = { operation: "checkpointWriter.write", root: "nodeOutput" } as const;

/** An Error's or a thrown FrameworkError's message. */
const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error);

const outcome = (run: () => void): string => {
  try {
    run();
    return "accepted";
  } catch (error) {
    return `refused: ${messageOf(error)}`;
  }
};

/** The previous walk's verdict, wrapped as the public shell wraps it. */
const legacy = (value: unknown): string =>
  outcome(() => {
    try {
      legacyAssertLossless(value, LABELS);
    } catch (error) {
      throw new Error(`assertLosslessEvent failed at event payload: ${(error as Error).message}`);
    }
  });

const current = (value: unknown): string => {
  const verdict = outcome(() => assertLosslessEvent(value, LABELS));
  // The typed shell formats a FrameworkError; compare the wrapped message it carries.
  return verdict.startsWith("refused") ? `refused: ${verdict.slice(verdict.indexOf("assertLosslessEvent failed"))}` : verdict;
};

const define = (target: object, key: PropertyKey, descriptor: PropertyDescriptor): object => {
  Object.defineProperty(target, key, descriptor);
  return target;
};

/** One way of making a plain object something the pre-scan must refuse (or accept). */
const HOSTILE: Readonly<Record<string, (o: Record<string, unknown>) => unknown>> = {
  plain: (o) => o,
  symbolKey: (o) => ({ ...o, [Symbol("k")]: 1 }),
  nonEnumerable: (o) => define({ ...o }, "hidden", { value: 1, enumerable: false }),
  getter: (o) => define({ ...o }, "g", { get: () => 1, enumerable: true }),
  setterOnly: (o) => define({ ...o }, "s", { set: () => undefined, enumerable: true }),
  bareAccessor: (o) => define({ ...o }, "b", { get: undefined, enumerable: true }),
  toJSONMethod: (o) => ({ ...o, toJSON: () => 1 }),
  toJSONAccessor: (o) => define({ ...o }, "toJSON", { get: () => 1, enumerable: true }),
  nullProto: (o) => Object.assign(Object.create(null) as object, o),
  classInstance: (o) => Object.assign(new (class Lead {})(), o),
  cycle: (o) => { const c: Record<string, unknown> = { ...o }; c["self"] = { up: c }; return c; },
  arrayExtraKey: (o) => Object.assign([o], { extra: 1 }),
  arrayIndexGetter: (o) => [o, define([1], "0", { get: () => 1, enumerable: true })],
  sparse: (o) => [, o],
  dateWithProperty: (o) => ({ o, d: Object.assign(new Date(0), { x: 1 }) }),
  mapWithProperty: (o) => ({ o, m: Object.assign(new Map(), { x: 1 }) }),
  invalidDate: (o) => ({ o, d: new Date(Number.NaN) }),
  subclassedMap: (o) => ({ o, m: new (class Registry extends Map {})() }),
  boxed: (o) => ({ o, n: Object(5) }),
};

/**
 * Arbitrary and hostile values. The map-key argument decides what Map keys may be: the
 * exact-round-trip property draws only primitive keys, because Bun's
 * `isDeepStrictEqual` (its reference) reports two identically shaped Maps with
 * structurally equal object keys as unequal, where Node reports them equal.
 */
const values = (mapKey: (tie: fc.LetrecTypedTie<{ value: unknown }>) => fc.Arbitrary<unknown>) => fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constantFrom(undefined, null, true, 0, -0, Number.NaN, Number.NEGATIVE_INFINITY, "x", 1n, Symbol("s"), () => 1),
    fc.double(),
    fc.date(),
    fc.string({ unit: "binary" }),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.sparseArray(tie("value"), { maxLength: 4 }),
    fc.dictionary(
      fc.oneof(fc.string(), fc.constantFrom("__proto__", "constructor", "__map__", "0", "a b", "toJSON")),
      tie("value"),
      { maxKeys: 4 },
    ),
    fc.array(fc.tuple(mapKey(tie), tie("value")), { maxLength: 3 }).map((entries) => new Map(entries)),
    fc.array(tie("value"), { maxLength: 3 }).map((items) => new Set(items)),
    fc.tuple(fc.dictionary(fc.string(), tie("value"), { maxKeys: 3 }), fc.constantFrom(...Object.keys(HOSTILE)))
      .map(([o, how]) => HOSTILE[how]!(o)),
  ),
})).value;

const value = values((tie) => tie("value"));
const primitiveKeyedValue = values(() => fc.oneof(fc.string(), fc.integer(), fc.constantFrom(null, undefined, true)));

/** `levels` nested `{k: [...]}` hops around a leaf: two hops per level. */
const nested = (levels: number): unknown => {
  let inner: unknown = 1;
  for (let level = 0; level < levels; level++) inner = { k: [inner] };
  return inner;
};

describe("assertLosslessEvent keeps the previous walk's verdicts and messages", () => {
  test("over arbitrary and hostile values", () => {
    fc.assert(fc.property(value, (v) => {
      expect(current(v)).toBe(legacy(v));
    }), { numRuns: 20_000 });
  });

  test("on shared references, Map cycles and the depth ceiling", () => {
    const shared = { a: 1 };
    const mapCycle = new Map<string, unknown>();
    mapCycle.set("me", mapCycle);
    for (const v of [{ x: shared, y: shared }, mapCycle, nested(255), nested(256), nested(300), [[], [[]]]]) {
      expect(current(v)).toBe(legacy(v));
    }
  });
});

describe("assertExactRoundTrip accepts exactly what restores deep-strictly-equal", () => {
  const restoresExactly = (v: unknown): boolean => {
    try {
      assertLosslessEvent(v);
      return isDeepStrictEqual(fromJson(toJson(v)), v);
    } catch {
      return false;
    }
  };

  test("over arbitrary and hostile values", () => {
    fc.assert(fc.property(primitiveKeyedValue, (v) => {
      expect(outcome(() => assertExactRoundTrip(v)) === "accepted").toBe(restoresExactly(v));
    }), { numRuns: 20_000 });
  });

  test("accepts a Map whose object keys are structurally equal, which restores entry for entry", () => {
    // Bun's isDeepStrictEqual calls this Map unequal to an identical copy, so
    // the parse-back comparison refused it; JSON restores it exactly.
    const v = new Map<unknown, unknown>([[new Set(), new Date(0)], [new Set(), ""]]);
    expect(outcome(() => assertExactRoundTrip(v))).toBe("accepted");
    expect([...(fromJson(toJson(v)) as Map<unknown, unknown>)]).toEqual([...v]);
  });

  test.each([
    ["a non-finite number", { lead: { score: Number.POSITIVE_INFINITY } }, "value.lead.score is the non-finite number Infinity"],
    ["-0", { lead: { score: -0 } }, "value.lead.score is -0"],
    ["an array hole", { leads: [1, , 3] }, "value.leads[1] is an array hole"],
    ["a null-prototype object", { lead: Object.create(null) as object }, "value.lead is a null-prototype object"],
  ])("refuses %s, naming its path", (_label, v, expected) => {
    expect(outcome(() => assertExactRoundTrip(v))).toContain(expected);
  });

  test("accepts what JSON restores exactly, including Map, Set, Date and undefined", () => {
    const v = { byNode: new Map([["n", new Set(["approved"])]]), at: new Date(0), optional: undefined, list: [undefined, 0] };
    expect(outcome(() => assertExactRoundTrip(v))).toBe("accepted");
  });
});
