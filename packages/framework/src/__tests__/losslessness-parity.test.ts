import { describe, expect, it } from "bun:test";
import { serializeFileEventRecord } from "../file/event-record.js";
import { materializeCanonicalOutput } from "../file/checkpointer-codec.js";
import { MAX_SAFE_RECORD_DEPTH } from "../state-machine/serialize.js";

/**
 * Losslessness parity — the deepening-round pin (simp-4) for the FR-009
 * write-boundary pre-scans' INVENTORY AGREEMENT.
 *
 * The file layer has two write-side losslessness walkers, each guarding its
 * own persistence boundary:
 *   - `serializeFileEventRecord` (journal events — event-record.ts)
 *   - `materializeCanonicalOutput` (node outputs — checkpointer-codec.ts)
 *
 * Their MESSAGE corpora are deliberately per-module (each path is
 * test-pinned against its own read-side strict parser), so this test does
 * NOT compare messages. It pins what must never drift: the ACCEPT/REJECT
 * VERDICT for the same value must agree at both boundaries. If one walker
 * starts accepting a value the other refuses (or vice versa), the build
 * fails here instead of the desync being discovered by a reviewer.
 *
 * The corpus is the union of both walkers' documented rejection classes
 * (non-representable kinds, cycles, accessors, malformed containers,
 * pollution/reserved keys, hostile Dates, over-ceiling nesting) plus the
 * shared safe domain (primitives, plain containers, Map/Set/Date, the
 * `-0` normalization, near-ceiling nesting). Depth rows are built
 * RELATIVE to `MAX_SAFE_RECORD_DEPTH` — imported from its canonical home,
 * the serializer grammar module — so the rows track the knob if it moves.
 */

const eventAccepts = (value: unknown): boolean => {
  try {
    // The probe envelope is JSON-safe, so the verdict is the walker's own
    // answer for `value` — the event schema contributes no rejection.
    serializeFileEventRecord(1, "parity", 1000, { type: "parity", payload: { probe: value } });
    return true;
  } catch {
    return false;
  }
};

const codecAccepts = (value: unknown): boolean => {
  try {
    materializeCanonicalOutput({ probe: value });
    return true;
  } catch {
    return false;
  }
};

const deepObject = (n: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < n; i += 1) v = { nested: v };
  return v;
};

const deepArray = (n: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < n; i += 1) v = [v];
  return v;
};

const cycle = (): unknown => {
  const c: Record<string, unknown> = {};
  c.self = c;
  return c;
};

const sparseArray = (): unknown => {
  const a = [1, 2, 3];
  delete a[1];
  return a;
};

const arrayWithOwnProp = (): unknown => {
  const a = [1, 2];
  (a as unknown as Record<string, unknown>).extra = 3;
  return a;
};

const dateWithOwnProp = (): unknown => {
  const d = new Date("2026-08-18T00:00:00Z");
  (d as unknown as Record<string, unknown>).extra = 1;
  return d;
};

const mapWithOwnProp = (): unknown => {
  const m = new Map<string, number>([["a", 1]]);
  (m as unknown as Record<string, unknown>).extra = 1;
  return m;
};

const nonEnumerableProp = (): unknown => {
  const o: Record<string, unknown> = { visible: 1 };
  Object.defineProperty(o, "hidden", { value: 1, enumerable: false, configurable: true });
  return o;
};

/** [label, value factory] — every hostile row must be REJECTED by both. */
const hostileCorpus: ReadonlyArray<readonly [string, () => unknown]> = [
  ["a BigInt", () => 10n],
  ["a symbol", () => Symbol("parity")],
  ["a function", () => () => 1],
  ["NaN", () => Number.NaN],
  ["+Infinity", () => Number.POSITIVE_INFINITY],
  ["-Infinity", () => Number.NEGATIVE_INFINITY],
  ["a cycle", cycle],
  [`an object chain ${MAX_SAFE_RECORD_DEPTH + 3} deep`, () => deepObject(MAX_SAFE_RECORD_DEPTH + 3)],
  [`an object chain ${MAX_SAFE_RECORD_DEPTH + 128} deep`, () => deepObject(MAX_SAFE_RECORD_DEPTH + 128)],
  ["an own accessor property", () => ({ get value() { return 1; } })],
  ["a sparse array", sparseArray],
  ["an array with an own extra property", arrayWithOwnProp],
  ["a non-enumerable own property", nonEnumerableProp],
  ['an own "__proto__" key', () => {
    // A literal `{ __proto__: X }` SETS the prototype — the defineProperty
    // form is the only way to build an object with an OWN `__proto__` key.
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, "__proto__", { value: { hijacked: true }, enumerable: true, writable: true, configurable: true });
    return o;
  }],
  ['a "constructor" key', () => ({ constructor: { prototype: { admin: true } } })],
  ['a forged "__map__" tag', () => ({ __map__: [[1, 2]] })],
  ['a forged "__undefined__" tag', () => ({ __undefined__: true })],
  ["a subclassed Date", () => new (class extends Date {}) (Date.now())],
  ["an invalid Date", () => new Date(Number.NaN)],
  ["a Date with an own property", dateWithOwnProp],
  ["a Map with an own property", mapWithOwnProp],
  ["a boxed primitive", () => Object("parity")],
  ["a WeakSet", () => new WeakSet<object>()],
  ["a RegExp", () => /parity/],
  ["a Promise", () => Promise.resolve(1)],
  ["a typed array", () => new Uint8Array([1])],
];

/** [label, value factory] — every safe row must be ACCEPTED by both. */
const safeCorpus: ReadonlyArray<readonly [string, () => unknown]> = [
  ["a string", () => "parity"],
  ["the empty string", () => ""],
  ["a positive number", () => 42],
  ["a negative number", () => -7],
  ["a float", () => 3.14],
  ["zero", () => 0],
  ["-0 (normalized to JSON's canonical zero)", () => -0],
  ["the largest safe integer", () => Number.MAX_SAFE_INTEGER],
  ["true", () => true],
  ["false", () => false],
  ["null", () => null],
  ["a nested plain object", () => ({ a: 1, b: { c: [1, 2, 3] } })],
  ["an empty object", () => ({} as Record<string, never>)],
  ["a mixed array", () => [1, "two", { three: 3 }]],
  ["an empty array", () => [] as unknown[]],
  ["a Map nesting a Set", () => new Map<string, unknown>([["k", [1, 2]], ["nested", new Set(["a", "b"])]])],
  ["a Set of mixed values", () => new Set<unknown>([1, "two", { three: 3 }])],
  ["an empty Map", () => new Map<string, never>()],
  ["an empty Set", () => new Set<never>()],
  ["a valid Date", () => new Date("2026-08-18T00:00:00Z")],
  ["the epoch Date", () => new Date(0)],
  [`an object chain ${MAX_SAFE_RECORD_DEPTH - 7} deep (under the ceiling)`, () => deepObject(MAX_SAFE_RECORD_DEPTH - 7)],
  [`an array chain ${MAX_SAFE_RECORD_DEPTH - 12} deep (under the ceiling)`, () => deepArray(MAX_SAFE_RECORD_DEPTH - 12)],
  ["a Map/Set/Date combo", () => ({ m: new Map<string, unknown>([["d", new Date("2026-08-18T00:00:00Z")]]), arr: [{ d: new Date(0) }] })],
];

describe("losslessness parity — the two FR-009 write-boundary pre-scans agree (deepening round, simp-4)", () => {
  for (const [label, make] of hostileCorpus) {
    it(`both reject: ${label}`, () => {
      expect(eventAccepts(make()), `event boundary (serializeFileEventRecord) accepted ${label}`).toBe(false);
      expect(codecAccepts(make()), `codec boundary (materializeCanonicalOutput) accepted ${label}`).toBe(false);
    });
  }

  for (const [label, make] of safeCorpus) {
    it(`both accept: ${label}`, () => {
      expect(eventAccepts(make()), `event boundary (serializeFileEventRecord) rejected ${label}`).toBe(true);
      expect(codecAccepts(make()), `codec boundary (materializeCanonicalOutput) rejected ${label}`).toBe(true);
    });
  }

  it("pins the ceiling the depth rows are built from (the knob lives in the grammar module)", () => {
    expect(MAX_SAFE_RECORD_DEPTH).toBe(512);
  });
});
