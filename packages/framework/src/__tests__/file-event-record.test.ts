// file-event-record.test.ts — strict event-record codec matrix + properties
//
// Covers the read-side fail-closed gate (FR-009), the write-boundary
// losslessness pre-scan (`assertLosslessEvent`), and the FR-015 dedupKey
// charset boundary that this module owns, including the ADR-0076 `|` exclusion:
//   - serializeFileEventRecord: byte-exact 5-field schema, toJson preservation
//     of Map/Set/Date in `event`, invariant throws (the write side never emits
//     a record the strict reader would reject), and the FR-009 pre-scan that
//     rejects every value the serializer cannot represent losslessly
//     (accessor properties — rejected by descriptor inspection, the pre-scan
//     NEVER invokes getters — symbol-keyed/non-enumerable properties,
//     JSON-less values, pollution-filtered keys, reserved tag keys, custom
//     toJSON, BigInt, functions, symbols, invalid Dates, circular
//     references), plus the one documented acceptance: -0 → 0 normalization
//     (the deep-equal uses ===, not Object.is)
//   - parseFileEventRecord strict matrix: non-object/array raw, wrong
//     schemaVersion, non-integer/negative sequence, dedupKey charset errors
//     (incl. the `|` ADR-0076 rejection and the 256-char bound), non-finite
//     recordedAtMs, missing event, malformed reserved tag encodings in the
//     event at any depth — every failure names the source; well-formed
//     tag-shaped record bytes are byte-identical to legitimate Map/Set/Date
//     events and are ACCEPTED as their types through tryFromJson
//   - tryParseEventRecordJson / readFileEventRecords: fail-closed
//     prototype-pollution pre-scan at the raw-JSON seam (deserializeValue
//     would silently erase `__proto__`/`constructor`/`prototype` keys, so
//     the scan rejects the record BEFORE deserialization, never truncated)
//   - hostile record depth overflow: 50k-deep
//     records (arrays and objects) through the real pipeline, the raw
//     seam, and the direct API fail closed with the typed cache-error /
//     err naming the safe depth ceiling — never a raw RangeError — while
//     an event nested exactly at MAX_SAFE_RECORD_DEPTH round-trips
// - fast-check properties: every generated malformed record is rejected
//   with the source named; every generated valid record round-trips
//   serialize → tryFromJson → parse → serialize (byte-stable)

import { describe, it, expect, afterEach } from "bun:test";
import * as fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryFromJson, deepJsonEqual } from "../state-machine/serialize.js";
import type { DedupKey, FileEventRecord, JournalSequence } from "../file/event-record.js";
import {
  DEDUP_KEY_PATTERN,
  isDedupKey,
  assertLosslessEvent,
  serializeFileEventRecord,
  parseDedupKey,
  parseFileEventRecord,
  parseStoredEventRecord,
  parseJournalSequence,
  tryParseEventRecordJson,
  MAX_SAFE_RECORD_DEPTH,
} from "../file/event-record.js";
import { parseStoredEventRecord as barrelParseStoredEventRecord } from "../file.js";
import { readFileEventRecords, readFileEvents } from "../file/event-log.js";
import { asCacheError } from "./_cache-error-helpers.js";
import { EVENTS_DIR, JOURNAL_SCHEMA_VERSION } from "../file/layout.js";
import type { FrameworkError } from "../types/errors.js";
import { isFrameworkError } from "../types/errors.js";

/** Realistic source naming (FR-009: failures name the file they came from). */
const SOURCE = "events/000042-1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890.json";

/** Compile-time proof that durable parsed primitives cannot be forged. */
const assertOpaqueRecordFields = (_record: FileEventRecord): void => {
  // @ts-expect-error — only parseJournalSequence/parser output carries the brand.
  const sequence: JournalSequence = 1;
  // @ts-expect-error — only parseDedupKey/parser output carries the brand.
  const dedupKey: DedupKey = "key";
  void sequence;
  void dedupKey;
};
void assertOpaqueRecordFields;

/** Fresh temp directory + events/ subdir, removed after the test — for the
 * read-pipeline pollution tests (raw on-disk bytes, not write-side output). */
const pipelineDirs: string[] = [];
afterEach(() => {
  for (const dir of pipelineDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const pipelineDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "file-event-record-"));
  pipelineDirs.push(dir);
  mkdirSync(join(dir, EVENTS_DIR));
  return dir;
};

/** Write a hand-crafted raw record file (bypassing the write-side pre-scan,
 * which is exactly the point: these bytes could only come from a corrupt or
 * hostile writer) and run it through the REAL read pipeline. The reader
 * tags every failure `cache-error` (ADR-0080), whose frame carries the message. */
const readRawRecordFile = (
  contents: string,
  name = "000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
): { ok: boolean; error: string } => {
  const dir = pipelineDir();
  writeFileSync(join(dir, EVENTS_DIR, name), contents);
  const r = readFileEventRecords(dir);
  if (r.ok) return { ok: true, error: "" };
  const error = r.error as Extract<FrameworkError, { readonly kind: "cache-error" }>;
  return { ok: false, error: error.message };
};

/** A record valid in every field — mutations in the matrix break exactly one. */
const validRecord = (): Record<string, unknown> => ({
  schemaVersion: 1,
  sequence: 7,
  dedupKey: "agent:run-1",
  recordedAtMs: 1_700_000_000_000,
  event: { kind: "step", n: 2 },
});

const withoutKey = (obj: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _omitted, ...rest } = obj;
  return rest;
};

/** Assert a parse rejection: not ok, names the source, mentions the reason. */
const expectRejected = (
  raw: unknown,
  expectedSubstrings: readonly string[],
  source = SOURCE,
): void => {
  const r = parseFileEventRecord(raw, source);
  if (r.ok) {
    throw new Error(
      `expected parse rejection for ${JSON.stringify(raw)}, parsed as ${JSON.stringify(r.value)}`,
    );
  }
  expect(r.error).toContain(source);
  for (const s of expectedSubstrings) {
    expect(r.error, `error ${JSON.stringify(r.error)} should mention ${JSON.stringify(s)}`).toContain(s);
  }
};

describe("opaque durable event-record fields", () => {
  it("smart constructors preserve valid values and reject invalid runtime primitives", () => {
    const zero = parseJournalSequence(0);
    const ceiling = parseJournalSequence(999_999);
    expect(zero.ok && Number(zero.value)).toBe(0);
    expect(ceiling.ok && Number(ceiling.value)).toBe(999_999);
    expect(parseJournalSequence(1_000_000)).toMatchObject({ ok: false });
    expect(parseJournalSequence(1.5)).toMatchObject({ ok: false });

    const keyless = parseDedupKey("");
    const keyed = parseDedupKey("agent:run-1");
    expect(keyless.ok && String(keyless.value)).toBe("");
    expect(keyed.ok && String(keyed.value)).toBe("agent:run-1");
    expect(parseDedupKey("a|b")).toMatchObject({ ok: false });
    expect(parseDedupKey(42)).toMatchObject({ ok: false });
  });
});

describe("serializeFileEventRecord — byte-exact schema via toJson", () => {
  it("emits the exact 5-field record JSON (byte-identical ProgramEventRecord schema)", () => {
    const json = serializeFileEventRecord(7, "agent:run-1", 1_700_000_000_000, { n: 2 });
    expect(json).toBe(
      '{"schemaVersion":1,"sequence":7,"dedupKey":"agent:run-1","recordedAtMs":1700000000000,"event":{"n":2}}',
    );
    expect(JSON.parse(json)).toEqual({
      schemaVersion: 1,
      sequence: 7,
      dedupKey: "agent:run-1",
      recordedAtMs: 1_700_000_000_000,
      event: { n: 2 },
    });
  });

  it("preserves Map/Set/Date inside `event` through serialize → tryFromJson → parse", () => {
    const event = new Map<string, unknown>([
      ["set", new Set([1, 2, 3])],
      ["when", new Date(1_700_000_000_000)],
    ]);
    const json = serializeFileEventRecord(0, "", 1_700_000_000_000, event);

    const raw = tryFromJson(json);
    if (!raw.ok) throw new Error(`tryFromJson failed: ${raw.error}`);
    const r = parseFileEventRecord(raw.value, SOURCE);
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    expect(r.value.event).toEqual(event);
    expect(r.value.event).toBeInstanceOf(Map);
  });

  it("accepts the empty keyless dedupKey and a 256-char keyed key", () => {
    expect(serializeFileEventRecord(0, "", 1, null)).toBe(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":null}',
    );
    const key256 = "k".repeat(256);
    const json = serializeFileEventRecord(0, key256, 1, null);
    expect(JSON.parse(json).dedupKey).toBe(key256);
  });

  it("throws on invariant violations — never writes a record the reader would reject", () => {
    expect(() => serializeFileEventRecord(-1, "", 1, null)).toThrow(/sequence/);
    expect(() => serializeFileEventRecord(1.5, "", 1, null)).toThrow(/sequence/);
    expect(() => serializeFileEventRecord(Number.NaN, "", 1, null)).toThrow(/sequence/);
    expect(() => serializeFileEventRecord(0, "a|b", 1, null)).toThrow(/\|/);
    expect(() => serializeFileEventRecord(0, "a@b", 1, null)).toThrow(/dedupKey/);
    expect(() => serializeFileEventRecord(0, "a b", 1, null)).toThrow(/dedupKey/);
    expect(() => serializeFileEventRecord(0, "k".repeat(257), 1, null)).toThrow(/FR-015/);
    expect(() => serializeFileEventRecord(0, "", Number.NaN, null)).toThrow(/recordedAtMs/);
    expect(() => serializeFileEventRecord(0, "", Number.POSITIVE_INFINITY, null)).toThrow(/recordedAtMs/);
    expect(() => serializeFileEventRecord(0, "", 1, undefined)).toThrow(/undefined/);

    // Non-string dedupKey on the WRITE side throws too — the same FR-015
    // encoding guards serialize (the type says string; a non-string value
    // is a caller bug, caught at the boundary).
    expect(() => serializeFileEventRecord(0, 123 as unknown as string, 1, null)).toThrow(/dedupKey/);
    expect(() => serializeFileEventRecord(0, null as unknown as string, 1, null)).toThrow(/dedupKey/);
    expect(() => serializeFileEventRecord(0, undefined as unknown as string, 1, null)).toThrow(/dedupKey/);

    // recordedAtMs: finite-ness is the contract; negative finite values are
    // accepted (pre-epoch timestamps, pinned contract) on BOTH sides.
    expect(() => serializeFileEventRecord(0, "", -1, null)).not.toThrow();
    expect(JSON.parse(serializeFileEventRecord(0, "", -1, null)).recordedAtMs).toBe(-1);

    // Shared sequence domain (ADR-0076, advisory): the codec and the naming
    // layer enforce the same 6-digit lexicographic ceiling.
    expect(() => serializeFileEventRecord(1_000_000, "", 1, null)).toThrow(/lexicographic ceiling/);
    expect(() => serializeFileEventRecord(999_999, "", 1, null)).not.toThrow();
  });
});

describe("serializeFileEventRecord — round-trip losslessness (FR-009)", () => {
  // The write side must never persist a record that diverges from the
  // caller's event. The writer pre-scans the event FIRST
  // (`assertLosslessEvent`) and rejects every value the serializer cannot
  // represent losslessly — the round-trip check could never see these
  // losses because `serializeValue` strips/drops identically on BOTH
  // comparison sides. The round-trip check survives as the backstop for
  // the one coercion the pre-scan defers: JSON.stringify coerces
  // NaN/±Infinity to `null`.

  const contextualError = (fn: () => string): Error => {
    try {
      fn();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected serializeFileEventRecord to throw");
  };

  it("rejects a nested symbol-valued property, naming kind and path", () => {
    const error = contextualError(() => serializeFileEventRecord(0, "", 1, { a: 1, s: Symbol("x") }));
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("event.s");
    expect(error.message).toContain("symbol");
  });

  it("rejects a top-level symbol event (previously serialized to no JSON)", () => {
    const error = contextualError(() => serializeFileEventRecord(0, "", 1, Symbol("x")));
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("event is a symbol");
  });

  it("rejects a function-valued event, naming kind and path", () => {
    const error = contextualError(() => serializeFileEventRecord(0, "", 1, { fn: () => 1 }));
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("event.fn");
    expect(error.message).toContain("function");
  });

  it("rejects BigInt with the contextual error, never the raw engine error", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [1n, "event is a BigInt"],
      [{ big: 1n }, "event.big is a BigInt"],
      [[1n], "event[0] is a BigInt"],
    ];
    for (const [event, expected] of cases) {
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain(expected);
      expect(error.message).not.toMatch(/^JSON\.stringify cannot serialize BigInt/);
    }
  });

  it("rejects a circular event with both ends of the cycle named", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const error = contextualError(() => serializeFileEventRecord(0, "", 1, circular));
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("circular reference");
    expect(error.message).toContain("event.self");
  });

  it("rejects a whole-event {__undefined__:true} marker as a literal reserved tag key", () => {
    const error = contextualError(() => serializeFileEventRecord(0, "", 1, { __undefined__: true }));
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("reserved tag key");
    expect(error.message).toContain("__undefined__");
    // The reader side of the hole: tryFromJson turns the marker into
    // undefined, and the strict parse rejects the resulting record.
    const raw = tryFromJson('{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"__undefined__":true}}');
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      const parsed = parseFileEventRecord(raw.value, SOURCE);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("missing event field");
    }
  });

  it("rejects nested literal {__undefined__:true} as a reserved tag key (was previously accepted)", () => {
    // `{__undefined__:true}` is unambiguous ONLY as serialize.ts's own
    // marker for an undefined VALUE — the tagged form. A caller's event
    // containing the literal KEY in a plain object is ambiguous (it reads
    // back as undefined), so the pre-scan rejects it at any depth.
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { nested: { __undefined__: true } }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("reserved tag key");
    expect(error.message).toContain("event.nested");
    // …while an actual undefined VALUE is the legitimate representation and
    // remains lossless.
    expect(() => serializeFileEventRecord(0, "", 1, { nested: undefined })).not.toThrow();
    expect(() => serializeFileEventRecord(0, "", 1, { nested: { deeper: undefined } })).not.toThrow();
  });

  it("rejects non-finite numbers inside event values (round-trip backstop: JSON silently writes null — a divergence)", () => {
    for (const event of [{ x: Number.NaN }, { x: Number.POSITIVE_INFINITY }, { x: Number.NEGATIVE_INFINITY }]) {
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
      expect(error.message).toContain("FR-009");
      expect(error.message).toMatch(/not lossless/);
    }
  });

  it("accepts -0 → 0 as the ONE documented coercion: persists as 0 without throwing (Object.is is NOT used)", () => {
    // Public contract (module header + serializer docs): the deep-equal
    // compares with ===, not Object.is, and JSON normalizes the sign of
    // zero — so -0 is an ACCEPTED coercion (unlike NaN/±Infinity → null,
    // which the round trip rejects), pinned here.
    expect(() => serializeFileEventRecord(0, "", 1, { x: -0 })).not.toThrow();
    expect(() => serializeFileEventRecord(0, "", 1, { list: [-0, 1] })).not.toThrow();
    expect(() => serializeFileEventRecord(0, "", 1, new Map([["k", -0]]))).not.toThrow();
    expect(() => serializeFileEventRecord(0, "", 1, new Set([-0]))).not.toThrow();

    const json = serializeFileEventRecord(0, "", 1, { x: -0, list: [-0] });
    const persisted = (JSON.parse(json) as { event: { x: number; list: number[] } }).event;
    expect(persisted.x).toBe(0);
    expect(Object.is(persisted.x, -0)).toBe(false);
    expect(persisted.list[0]).toBe(0);

    // …and the round-trip path stays green: parse reads 0, re-serialize is
    // byte-stable (the canonical form and the parsed form both normalize).
    const raw = tryFromJson(json);
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const parsed = parseFileEventRecord(raw.value, SOURCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.value.event as { x: number }).x).toBe(0);
    expect(serializeFileEventRecord(parsed.value.sequence, parsed.value.dedupKey, parsed.value.recordedAtMs, parsed.value.event)).toBe(json);
  });

  it("valid events still round-trip byte-stable", () => {
    // Plain, Map/Set/Date, and nested-undefined events are lossless
    // through toJson — the pre-scan AND the round-trip check must not
    // reject them.
    expect(serializeFileEventRecord(0, "", 1, { a: 1, b: [1, "x", null], c: { d: true } })).toBe(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"a":1,"b":[1,"x",null],"c":{"d":true}}}',
    );
    const mapEvent = new Map<string, unknown>([["set", new Set([1, 2])]]);
    const json = serializeFileEventRecord(0, "", 1, mapEvent);
    const raw = tryFromJson(json);
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const parsed = parseFileEventRecord(raw.value, SOURCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.event).toEqual(mapEvent);
  });
});

describe("assertLosslessEvent — write-boundary pre-scan rejection classes (a–g, FR-009)", () => {
  // The class this closes: `serializeValue` strips/drops ALL of these on
  // BOTH comparison sides, so the round-trip check could never see them.
  // Each rejection must name the offending kind and path, and must be
  // reachable at ANY depth.

  const contextualError = (fn: () => string): Error => {
    try {
      fn();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected serializeFileEventRecord to throw");
  };

  describe("(a) symbol-keyed own properties", () => {
    it("rejects a symbol key on a plain object, naming the path", () => {
      const event: Record<string, unknown> = { a: 1 };
      Object.defineProperty(event, Symbol("k"), { value: "v", enumerable: true });
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("symbol-keyed");
      expect(error.message).toContain("Symbol(k)");
    });

    it("rejects a symbol key at depth (nested object and array element)", () => {
      const nested: Record<string, unknown> = { deep: { inner: 1 } };
      Object.defineProperty(nested, Symbol("s"), { value: 2, enumerable: true });
      const error = contextualError(() =>
        serializeFileEventRecord(0, "", 1, { outer: { arr: [1, nested] } }),
      );
      expect(error.message).toContain("event.outer.arr[1]");
      expect(error.message).toContain("symbol-keyed");
    });

    it("rejects a symbol key on an array (JSON arrays persist only indices)", () => {
      const arr: unknown[] = [1];
      Object.defineProperty(arr, Symbol("x"), { value: 2, enumerable: true });
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, arr));
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("own property [Symbol(x)]");
    });
  });

  describe("(b) non-enumerable own properties", () => {
    it("rejects a non-enumerable property on a plain object, naming the path", () => {
      const event: Record<string, unknown> = { a: 1 };
      Object.defineProperty(event, "hidden", { value: 42, enumerable: false });
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("non-enumerable");
      expect(error.message).toContain("event"); // names the container path
      expect(error.message).toContain(".hidden"); // names the offending key
    });

    it("rejects a non-enumerable property at depth", () => {
      const inner: Record<string, unknown> = {};
      Object.defineProperty(inner, "secret", { value: 1, enumerable: false });
      const error = contextualError(() =>
        serializeFileEventRecord(0, "", 1, { level: { inner } }),
      );
      expect(error.message).toContain("event.level.inner");
      expect(error.message).toContain(".secret");
    });

    it("rejects an extra string property on an array (arr.foo — dropped by map())", () => {
      const arr: unknown[] = [1];
      (arr as unknown as Record<string, unknown>).foo = 1;
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, arr));
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("own property .foo");
    });

    it("rejects own properties on Date/Map/Set instances (serializers never visit them)", () => {
      const d = new Date(1_700_000_000_000) as unknown as Record<string, unknown>;
      d.extra = 1;
      const map = new Map([["k", 1]]) as unknown as Record<string, unknown>;
      map.extra = 1;
      const set = new Set([1]) as unknown as Record<string, unknown>;
      set.extra = 1;
      for (const [event, path] of [[d, "event is a Date"], [map, "event is a Map"], [set, "event is a Set"]] as const) {
        const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
        expect(error.message).toContain("FR-009");
        expect(error.message).toContain(path);
        expect(error.message).toContain("own property .extra");
      }
    });
  });

  describe("(c) prototype-pollution-filtered keys", () => {
    it("rejects constructor / prototype / __proto__ keys, naming the key", () => {
      const events: ReadonlyArray<readonly [unknown, string]> = [
        [{ type: "X", constructor: { hidden: 1 } }, "constructor"],
        [{ type: "X", prototype: { hidden: 1 } }, "prototype"],
        // JSON.parse creates an OWN __proto__ key (an object literal would
        // set the prototype instead) — the real hostile shape.
        [JSON.parse('{"type":"X","__proto__":{"polluted":1}}'), "__proto__"],
      ];
      for (const [event, key] of events) {
        const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
        expect(error.message).toContain("FR-009");
        expect(error.message).toContain("pollution");
        expect(error.message).toContain(JSON.stringify(key));
      }
    });

    it("rejects a pollution-filtered key at depth", () => {
      const error = contextualError(() =>
        serializeFileEventRecord(0, "", 1, { a: { b: { constructor: { x: 1 } } } }),
      );
      expect(error.message).toContain("event.a.b");
      expect(error.message).toContain("constructor");
    });
  });

  describe("(d) literal reserved tag keys — the type-changing family", () => {
    it("rejects all four reserved keys on plain objects", () => {
      const events: ReadonlyArray<readonly [unknown, string]> = [
        [{ __map__: [[1, 2]] }, "__map__"],
        [{ __set__: [1, 2] }, "__set__"],
        [{ __date__: "2024-01-01T00:00:00.000Z" }, "__date__"],
        [{ __undefined__: true }, "__undefined__"],
      ];
      for (const [event, key] of events) {
        const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
        expect(error.message).toContain("FR-009");
        expect(error.message).toContain("reserved tag key");
        expect(error.message).toContain(JSON.stringify(key));
      }
    });

    it("rejects a tag key at any depth: nested object, array element, Map value, Set item", () => {
      const cases: ReadonlyArray<readonly [unknown, string]> = [
        [{ a: { __map__: "not-an-array" } }, "event.a"],
        [[{ __set__: 1 }], "event[0]"],
        [new Map<string, unknown>([["k", { __date__: 123 }]]), "event[map entry #0 value]"],
        [new Set<unknown>([{ __undefined__: false }]), "event[set item #0]"],
      ];
      for (const [event, path] of cases) {
        const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
        expect(error.message).toContain("FR-009");
        expect(error.message).toContain("reserved tag key");
        expect(error.message).toContain(path);
      }
    });

    it("allows the legitimate tagged FORMS: Map/Set/Date values and tag-looking Map keys", () => {
      // The rejection targets literal keys IN PLAIN OBJECTS; the tagged
      // forms themselves (Map/Set/Date VALUES, and strings that merely
      // LOOK like tags inside Map/Set entries) are the legitimate
      // representations and must round-trip.
      const map = new Map<string, unknown>([["__map__", 1]]);
      const json = serializeFileEventRecord(0, "", 1, map);
      const raw = tryFromJson(json);
      expect(raw.ok).toBe(true);
      if (!raw.ok) return;
      const parsed = parseFileEventRecord(raw.value, SOURCE);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.event).toBeInstanceOf(Map);
      expect(parsed.value.event).toEqual(new Map([["__map__", 1]]));
    });
  });

  describe("(e) JSON-less values and non-JSON scalars", () => {
    it("rejects WeakMap/WeakSet/RegExp/Promise/class instances/typed arrays/boxed primitives, naming the kind", () => {
      class Widget {
        constructor(public id: number) {}
      }
      const events: ReadonlyArray<readonly [unknown, string]> = [
        [new WeakMap(), "WeakMap"],
        [new WeakSet(), "WeakSet"],
        [/x/g, "RegExp"],
        [Promise.resolve(1), "Promise"],
        [new Widget(1), "Widget"],
        [new Uint8Array([1, 2]), "Uint8Array"],
        [new Number(5), "Number"],
        [new Error("boom"), "Error"],
      ];
      for (const [event, kind] of events) {
        const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
        expect(error.message).toContain("FR-009");
        expect(error.message).toContain(`has kind ${kind}`);
      }
    });

    it("rejects a JSON-less value at depth, naming the path", () => {
      const error = contextualError(() =>
        serializeFileEventRecord(0, "", 1, { a: { b: [/x/] } }),
      );
      expect(error.message).toContain("event.a.b[0]");
      expect(error.message).toContain("RegExp");
    });

    it("rejects symbol values as Map keys (JSON would write null)", () => {
      const error = contextualError(() =>
        serializeFileEventRecord(0, "", 1, new Map([[Symbol("s"), 1]])),
      );
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("event[map entry #0 key]");
      expect(error.message).toContain("symbol");
    });

    it("rejects BigInt as a Map value and Set item (depth coverage)", () => {
      const mapError = contextualError(() =>
        serializeFileEventRecord(0, "", 1, new Map([["k", 1n]])),
      );
      expect(mapError.message).toContain("event[map entry #0 value]");
      expect(mapError.message).toContain("BigInt");
      const setError = contextualError(() =>
        serializeFileEventRecord(0, "", 1, new Set([1n])),
      );
      expect(setError.message).toContain("event[set item #0]");
      expect(setError.message).toContain("BigInt");
    });

    it("rejects an invalid Date (NaN instant) and a subclassed Date", () => {
      const invalid = contextualError(() =>
        serializeFileEventRecord(0, "", 1, new Date(Number.NaN)),
      );
      expect(invalid.message).toContain("FR-009");
      expect(invalid.message).toContain("invalid Date");
      class FutureDate extends Date {}
      const sub = contextualError(() =>
        serializeFileEventRecord(0, "", 1, new FutureDate(1_700_000_000_000)),
      );
      expect(sub.message).toContain("FR-009");
      expect(sub.message).toContain("FutureDate");
    });

    it("accepts every allowed leaf kind (primitives, plain objects, arrays, Date, Map, Set) at depth", () => {
      const event = {
        nil: null,
        yes: true,
        n: 42.5,
        s: "str",
        u: undefined,
        nested: { deep: [1, 2, { x: null }] },
        when: new Date(1_700_000_000_000),
        map: new Map<string, unknown>([["k", new Set([new Date(1_700_000_000_000), "v"])]]),
      };
      expect(() => serializeFileEventRecord(0, "", 1, event)).not.toThrow();
      expect(() => assertLosslessEvent(event)).not.toThrow();
    });
  });

  describe("(f) custom toJSON methods", () => {
    it("rejects a custom toJSON that would replace the payload", () => {
      const error = contextualError(() =>
        serializeFileEventRecord(0, "", 1, {
          a: 1,
          toJSON() {
            return { hacked: true };
          },
        }),
      );
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("custom toJSON");
    });

    it("rejects a custom toJSON at depth, naming the path", () => {
      const error = contextualError(() =>
        serializeFileEventRecord(0, "", 1, { wrapper: { payload: 1, toJSON: () => ({ gone: true }) } }),
      );
      expect(error.message).toContain("event.wrapper");
      expect(error.message).toContain("custom toJSON");
    });
  });

  describe("(g) circular references", () => {
    it("rejects direct self-reference with both ends of the cycle", () => {
      const circular: Record<string, unknown> = { name: "root" };
      circular.me = circular;
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, circular));
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("circular reference at event.me");
      expect(error.message).toContain("event is an ancestor");
    });

    it("rejects a multi-node cycle and a Map self-cycle", () => {
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = { back: a };
      a.next = b;
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, { a }));
      expect(error.message).toContain("circular reference");

      const selfMap = new Map<string, unknown>();
      selfMap.set("self", selfMap);
      const mapError = contextualError(() => serializeFileEventRecord(0, "", 1, selfMap));
      expect(mapError.message).toContain("circular reference");
    });

    it("allows shared (DAG) references — they are not cycles and serialize losslessly", () => {
      const shared = { cfg: 1 };
      expect(() =>
        serializeFileEventRecord(0, "", 1, { first: shared, second: shared }),
      ).not.toThrow();
    });
  });

  it("throws cache-error(assertLosslessEvent) when the pre-scan is called directly", () => {
    let failure: unknown;
    try {
      assertLosslessEvent({ value: Symbol("x") });
    } catch (error) {
      failure = error;
    }
    const typed = asCacheError(failure, "assertLosslessEvent");
    expect(typed.message).toContain("event.value");
    expect(typed.message).toContain("FR-009");
  });

  it("throws typed cache-error(serializeFileEventRecord) with module context on every class", () => {
    for (const event of [
      { [Symbol("k")]: 1 } as unknown,
      (() => {
        const o: Record<string, unknown> = {};
        Object.defineProperty(o, "h", { value: 1 });
        return o;
      })(),
      { constructor: {} },
      { __date__: "x" },
      /x/,
      Promise.resolve(1),
      1n,
      { toJSON: () => ({}) },
    ]) {
      try {
        serializeFileEventRecord(0, "", 1, event);
        throw new Error(`expected pre-scan rejection for ${String(event)}`);
      } catch (error) {
        const typed = asCacheError(error, "serializeFileEventRecord");
        expect(typed.message).toContain("serializeFileEventRecord:");
        expect(typed.message).toContain("FR-009");
      }
    }
  });
});

describe("assertLosslessEvent — accessor properties are rejected BY INSPECTION (class h, FR-009)", () => {
  // The accessor bypass: `ownValue` reads `descriptor.value`, which is
  // undefined for an accessor descriptor, so an enumerable getter was
  // walked as undefined and never inspected — while serializeValue/
  // JSON.stringify DO invoke the getter (Object.entries), funneling the
  // result identically on BOTH round-trip comparison sides. Verified
  // loss: serializeFileEventRecord(0,"",1,{a:1,get x(){return new
  // WeakMap()}}) persisted {"a":1,"x":{}} with NO throw. The fix fails
  // closed: any own accessor descriptor (a `get`) is rejected at any
  // depth WITHOUT invoking the getter — a getter's value is
  // unverifiable, so even a getter that would return JSON-safe data is
  // refused (pinned in the control test below).

  const contextualError = (fn: () => string): Error => {
    try {
      fn();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected serializeFileEventRecord to throw");
  };

  it("rejects an enumerable getter returning a WeakMap — the verified loss — naming the path", () => {
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { a: 1, get x() { return new WeakMap(); } }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("accessor property .x");
    expect(error.message).toMatch(/event has accessor/); // path = event, segment = .x
  });

  it("rejects a getter returning a global RegExp, naming the path", () => {
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { g: 1, get r() { return /x/g; } }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("accessor property .r");
  });

  it("rejects a getter returning a class instance", () => {
    class Widget {
      constructor(public id: number) {}
    }
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { get w() { return new Widget(1); } }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("accessor property .w");
  });

  it("rejects a getter returning a symbol-keyed object", () => {
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { get s() { return { [Symbol("k")]: "v" }; } }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("accessor property .s");
  });

  it("rejects a getter returning a non-enumerable-bearing object", () => {
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, {
        get n() {
          const o: Record<string, unknown> = {};
          Object.defineProperty(o, "hidden", { value: 1 });
          return o;
        },
      }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("accessor property .n");
  });

  it("rejects nested getters at depth, naming the exact path", () => {
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { outer: { inner: { get deep() { return 1; } } } }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("event.outer.inner");
    expect(error.message).toContain("accessor property .deep");

    // A getter whose RESULT object itself carries a getter: the outer
    // accessor is rejected first (never invoked), so the inner one is
    // never reached — the rejection is descriptor-based.
    const nested = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { get g() { return { get inner() { return 1; } }; } }),
    );
    expect(nested.message).toContain("accessor property .g");
  });

  it("rejects getters inside array elements, Map values, Set items, and Map keys — depth coverage", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [[{ get g() { return 1; } }], "event[0]"],
      [new Map<string, unknown>([["k", { get g() { return 1; } }]]), "event[map entry #0 value]"],
      [new Set<unknown>([{ get g() { return 1; } }]), "event[set item #0]"],
      [new Map<unknown, unknown>([[{ get k() { return 1; } }, 1]]), "event[map entry #0 key]"],
    ];
    for (const [event, path] of cases) {
      const error = contextualError(() => serializeFileEventRecord(0, "", 1, event));
      expect(error.message).toContain("FR-009");
      expect(error.message).toContain("accessor property");
      expect(error.message).toContain(path);
    }
  });

  it("rejects an ARRAY-INDEX getter (previously invoked by value[i] and its result walked — lossy or not, never accepted)", () => {
    const arr: unknown[] = [1];
    Object.defineProperty(arr, 0, {
      get() { return new WeakMap(); },
      enumerable: true,
      configurable: true,
    });
    const error = contextualError(() => serializeFileEventRecord(0, "", 1, arr));
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("event[0]");
    expect(error.message).toContain("array-index accessor");
  });

  it("rejects a non-enumerable getter via the existing non-enumerable gate, naming it contextually", () => {
    const o: Record<string, unknown> = { a: 1 };
    Object.defineProperty(o, "hidden", { get() { return 1; }, configurable: true }); // enumerable: false
    const error = contextualError(() => serializeFileEventRecord(0, "", 1, o));
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("non-enumerable");
    expect(error.message).toContain(".hidden");
  });

  it("control: the getter is NEVER invoked — invocation counter stays 0, and an equivalent DATA property stays accepted", () => {
    // (1) The pre-scan must not call the getter — not even to "check" its
    // value: a getter may throw, have side effects, or return a different
    // value to toJson's own Get.
    let invocations = 0;
    const event: Record<string, unknown> = { a: 1 };
    Object.defineProperty(event, "x", {
      get() { invocations++; return new WeakMap(); },
      enumerable: true,
      configurable: true,
    });
    try {
      serializeFileEventRecord(0, "", 1, event);
    } catch {
      // expected: accessor rejection
    }
    expect(invocations).toBe(0);

    // (2) Fail-closed on the DESCRIPTOR, not the value: a getter that
    // would return plain JSON-safe data is STILL rejected — the pre-scan
    // cannot verify what it never invokes, and acceptance would re-open
    // the verified bypass. (The earlier behavior silently accepted this
    // class, which is exactly the hole; the fix refuses the whole class.)
    const safe = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { a: 1, get x() { return { safe: 1 }; } }),
    );
    expect(safe.message).toContain("FR-009");
    expect(safe.message).toContain("accessor property .x");
    expect(safe.message).not.toContain("safe"); // rejection never inspects the value

    // (3) The same data as a plain DATA property remains accepted — the
    // rejection is accessor-specific, not value-specific.
    expect(() => serializeFileEventRecord(0, "", 1, { a: 1, x: { safe: 1 } })).not.toThrow();

    // (4) The write boundary stays byte-exact for the equivalent data form.
    const json = serializeFileEventRecord(0, "", 1, { a: 1, x: { safe: 1 } });
    expect(JSON.parse(json).event).toEqual({ a: 1, x: { safe: 1 } });
  });

  it("rejects a throwing toJSON ACCESSOR with the contextual FR-009 error, never the raw engine error", () => {
    // The old probe `typeof obj.toJSON` invoked the accessor OUTSIDE
    // tryCatch: {get toJSON(){throw new Error("boom")}} escaped as a raw
    // "boom" with no FR-009 context. The descriptor-based probe rejects
    // the accessor by inspection — the getter is never invoked.
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { a: 1, get toJSON() { throw new Error("boom"); } }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("custom toJSON accessor");
    expect(error.message).not.toContain("boom");

    // A toJSON accessor whose getter returns undefined is equally refused:
    // the descriptor is what matters, the value is never observed.
    let invoked = 0;
    const event: Record<string, unknown> = { a: 1 };
    Object.defineProperty(event, "toJSON", {
      get() { invoked++; return undefined; },
      enumerable: true,
      configurable: true,
    });
    expect(() => serializeFileEventRecord(0, "", 1, event)).toThrow(/custom toJSON accessor/);
    expect(invoked).toBe(0);
  });

  it("rejects accessors inside Map/Set entries nested in arrays — the full walk path", () => {
    const inner: Record<string, unknown> = {};
    Object.defineProperty(inner, "g", { get() { return 1; }, enumerable: true, configurable: true });
    const error = contextualError(() =>
      serializeFileEventRecord(0, "", 1, { list: [new Set([inner])] }),
    );
    expect(error.message).toContain("FR-009");
    expect(error.message).toContain("event.list[0][set item #0]");
    expect(error.message).toContain("accessor property .g");
  });
});

describe("isDedupKey — the FR-015 type guard", () => {
  it("accepts '' (keyless) and rejects non-strings", () => {
    expect(isDedupKey("")).toBe(true);
    expect(isDedupKey(123)).toBe(false);
    expect(isDedupKey(null)).toBe(false);
    expect(isDedupKey(undefined)).toBe(false);
    expect(isDedupKey({})).toBe(false);
  });

  it("accepts every single FR-015 charset character", () => {
    const charset =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-";
    for (const ch of charset) {
      expect(isDedupKey(ch), `single char ${JSON.stringify(ch)}`).toBe(true);
      expect(isDedupKey(`pre${ch}post`), `embedded char ${JSON.stringify(ch)}`).toBe(true);
    }
  });

  it("accepts lengths 1..256 and rejects 0-length keys other than '' and 257+", () => {
    expect(isDedupKey("")).toBe(true);
    expect(isDedupKey("a".repeat(1))).toBe(true);
    expect(isDedupKey("a".repeat(256))).toBe(true);
    expect(isDedupKey("a".repeat(257))).toBe(false);
    expect(isDedupKey("a".repeat(300))).toBe(false);
  });

  it("rejects hostile strings: separators, whitespace, dots, non-ASCII, control chars", () => {
    for (const key of ["a|b", "|", "a@b", "a b", "a.b", "a/b", "a\\b", "a,b", "a;b", "a=b", "a\nb", "a\u0000b", "é", "😀", "a".repeat(257)]) {
      expect(isDedupKey(key), JSON.stringify(key)).toBe(false);
    }
  });
});

describe("parseFileEventRecord — valid records", () => {
  it("parses a full keyed record to the exact FileEventRecord", () => {
    const raw = validRecord();
    const r = parseFileEventRecord(raw, SOURCE);
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    const expected = {
      schemaVersion: 1 as const,
      sequence: 7,
      dedupKey: "agent:run-1",
      recordedAtMs: 1_700_000_000_000,
      event: { kind: "step", n: 2 },
    };
    expect({
      ...r.value,
      sequence: Number(r.value.sequence),
      dedupKey: String(r.value.dedupKey),
    }).toEqual(expected);
  });

  it("accepts the keyless form (dedupKey: '') and boundary values", () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["keyless", { ...validRecord(), dedupKey: "" }],
      ["sequence 0", { ...validRecord(), sequence: 0 }],
      ["sequence 999999", { ...validRecord(), sequence: 999_999 }],
      ["recordedAtMs 0", { ...validRecord(), recordedAtMs: 0 }],
      ["negative finite recordedAtMs", { ...validRecord(), recordedAtMs: -1 }],
      ["event null", { ...validRecord(), event: null }],
      ["event string", { ...validRecord(), event: "plain" }],
      ["event boolean", { ...validRecord(), event: true }],
      ["event number", { ...validRecord(), event: 42 }],
      ["event array", { ...validRecord(), event: [1, { a: 2 }] }],
      ["event nested undefined VALUE", { ...validRecord(), event: { nested: undefined } }],
      ["event Map value", { ...validRecord(), event: new Map([["k", 1]]) }],
      ["event Map with tag-looking KEY", { ...validRecord(), event: new Map([["__map__", 1]]) }],
      ["event Set value", { ...validRecord(), event: new Set([1, 2]) }],
      ["event Date value", { ...validRecord(), event: new Date(1_700_000_000_000) }],
      ["dedupKey 1-char", { ...validRecord(), dedupKey: "a" }],
      ["dedupKey 1-char colon", { ...validRecord(), dedupKey: ":" }],
      ["dedupKey 256 chars", { ...validRecord(), dedupKey: "k".repeat(256) }],
    ];
    for (const [name, raw] of cases) {
      const r = parseFileEventRecord(raw, SOURCE);
      expect(r.ok, name).toBe(true);
    }
  });

  it("accepts every FR-015 charset character inside a keyed dedupKey", () => {
    const charset =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-";
    for (const ch of charset) {
      const raw = { ...validRecord(), dedupKey: `k${ch}k` };
      const r = parseFileEventRecord(raw, SOURCE);
      expect(r.ok, `charset char ${JSON.stringify(ch)}`).toBe(true);
    }
  });
});

describe("parseFileEventRecord — strict rejection matrix (FR-009)", () => {
  // [name, raw, substrings the error must contain]
  const REJECTION_MATRIX: ReadonlyArray<readonly [string, unknown, readonly string[]]> = [
    // non-object / array raw
    ["raw undefined", undefined, ["event record"]],
    ["raw null", null, ["event record"]],
    ["raw number", 42, ["event record"]],
    ["raw string", "not a record", ["event record"]],
    ["raw boolean", true, ["event record"]],
    ["raw array", [1, 2], ["event record"]],
    ["raw empty array", [], ["event record"]],

    // schemaVersion
    ["schemaVersion missing", withoutKey(validRecord(), "schemaVersion"), ["schemaVersion"]],
    ["schemaVersion 0", { ...validRecord(), schemaVersion: 0 }, ["schemaVersion"]],
    ["schemaVersion 2", { ...validRecord(), schemaVersion: 2 }, ["schemaVersion"]],
    ["schemaVersion -1", { ...validRecord(), schemaVersion: -1 }, ["schemaVersion"]],
    ["schemaVersion 1.5", { ...validRecord(), schemaVersion: 1.5 }, ["schemaVersion"]],
    ["schemaVersion string '1'", { ...validRecord(), schemaVersion: "1" }, ["schemaVersion"]],
    ["schemaVersion null", { ...validRecord(), schemaVersion: null }, ["schemaVersion"]],

    // sequence
    ["sequence missing", withoutKey(validRecord(), "sequence"), ["sequence"]],
    ["sequence -1", { ...validRecord(), sequence: -1 }, ["sequence"]],
    ["sequence fractional", { ...validRecord(), sequence: 1.5 }, ["sequence"]],
    ["sequence NaN", { ...validRecord(), sequence: Number.NaN }, ["sequence"]],
    ["sequence Infinity", { ...validRecord(), sequence: Number.POSITIVE_INFINITY }, ["sequence"]],
    ["sequence unsafe 2^53", { ...validRecord(), sequence: 9_007_199_254_740_992 }, ["sequence"]],
    ["sequence string '1'", { ...validRecord(), sequence: "1" }, ["sequence"]],
    ["sequence null", { ...validRecord(), sequence: null }, ["sequence"]],
    // sequence past the 6-digit lexicographic ceiling (shared codec/naming domain)
    ["sequence 1000000 (lexicographic ceiling)", { ...validRecord(), sequence: 1_000_000 }, ["sequence", "lexicographic ceiling"]],
    ["sequence 9007199254740991 (ceiling, max safe)", { ...validRecord(), sequence: Number.MAX_SAFE_INTEGER }, ["lexicographic ceiling"]],

    // unknown top-level fields — fail-closed strict schema
    ["unknown top-level field 'extra'", { ...validRecord(), extra: 1 }, ["unknown top-level field", "extra"]],
    ["unknown top-level field 'n'", { ...validRecord(), n: "x" }, ["unknown top-level field", "n"]],
    ["unknown top-level field '__proto__-adjacent'", { ...validRecord(), data: {} }, ["unknown top-level field", "data"]],

    // dedupKey charset (FR-015)
    ["dedupKey missing", withoutKey(validRecord(), "dedupKey"), ["dedupKey"]],
    ["dedupKey undefined", { ...validRecord(), dedupKey: undefined }, ["dedupKey"]],
    ["dedupKey number", { ...validRecord(), dedupKey: 123 }, ["dedupKey"]],
    ["dedupKey null", { ...validRecord(), dedupKey: null }, ["dedupKey"]],
    ["dedupKey object", { ...validRecord(), dedupKey: {} }, ["dedupKey"]],
    ["dedupKey '|' (ADR-0076)", { ...validRecord(), dedupKey: "a|b" }, ["dedupKey", "|"]],
    ["dedupKey '@'", { ...validRecord(), dedupKey: "a@b" }, ["dedupKey"]],
    ["dedupKey space", { ...validRecord(), dedupKey: "a b" }, ["dedupKey"]],
    ["dedupKey dot", { ...validRecord(), dedupKey: "a.b" }, ["dedupKey"]],
    ["dedupKey slash", { ...validRecord(), dedupKey: "a/b" }, ["dedupKey"]],
    ["dedupKey backslash", { ...validRecord(), dedupKey: "a\\b" }, ["dedupKey"]],
    ["dedupKey non-ASCII", { ...validRecord(), dedupKey: "café" }, ["dedupKey"]],
    ["dedupKey 257 chars", { ...validRecord(), dedupKey: "k".repeat(257) }, ["dedupKey", "256"]],

    // recordedAtMs
    ["recordedAtMs missing", withoutKey(validRecord(), "recordedAtMs"), ["recordedAtMs"]],
    ["recordedAtMs NaN", { ...validRecord(), recordedAtMs: Number.NaN }, ["recordedAtMs"]],
    ["recordedAtMs +Infinity", { ...validRecord(), recordedAtMs: Number.POSITIVE_INFINITY }, ["recordedAtMs"]],
    ["recordedAtMs -Infinity", { ...validRecord(), recordedAtMs: Number.NEGATIVE_INFINITY }, ["recordedAtMs"]],
    ["recordedAtMs string", { ...validRecord(), recordedAtMs: "123" }, ["recordedAtMs"]],
    ["recordedAtMs null", { ...validRecord(), recordedAtMs: null }, ["recordedAtMs"]],

    // event
    ["event key missing", withoutKey(validRecord(), "event"), ["event"]],
    ["event undefined", { ...validRecord(), event: undefined }, ["event"]],

    // malformed reserved tag ENCODINGS in the event (domain agreement: the
    // write pre-scan forbids literal tag keys in plain objects, and a literal
    // tag key that SURVIVES deserialization as a plain-object key is by
    // definition a malformed encoding — well-formed tag-shaped bytes
    // (`__map__:[[...]]`, `__set__:[...]`, `__date__:"<iso>",
    // `__undefined__:true`) deserialize to Map/Set/Date/undefined and are
    // byte-identical to legitimate events of those types, ACCEPTED as their
    // types through tryFromJson (pinned in the pipeline tests below). These
    // direct-call cases pin the malformed forms only.
    ["event malformed map tag {__map__:'x'} (non-array form)", { ...validRecord(), event: { __map__: "x" } }, ["__map__", "reserved", "corrupt or hostile"]],
    ["event malformed set tag {__set__:1}", { ...validRecord(), event: { __set__: 1 } }, ["__set__", "reserved"]],
    ["event malformed set tag {__set__:{}}", { ...validRecord(), event: { __set__: {} } }, ["__set__", "reserved"]],
    ["event malformed date tag {__date__:123}", { ...validRecord(), event: { __date__: 123 } }, ["__date__", "reserved"]],
    ["event malformed date tag {__date__:null}", { ...validRecord(), event: { __date__: null } }, ["__date__", "reserved"]],
    ["event malformed undefined tag {__undefined__:false}", { ...validRecord(), event: { __undefined__: false } }, ["__undefined__", "reserved"]],
    ["event nested malformed tag key", { ...validRecord(), event: { a: { b: { __map__: 1 } } } }, ["__map__", "event.a.b"]],
    ["event malformed tag key in array", { ...validRecord(), event: [{ __date__: 123 }] }, ["__date__", "event[0]"]],
    ["event malformed tag key in Map value", { ...validRecord(), event: new Map([["k", { __set__: 1 }]]) }, ["__set__"]],
    ["event malformed tag key in Set item", { ...validRecord(), event: new Set([{ __undefined__: false }]) }, ["__undefined__"]],
  ];

  for (const [name, raw, substrings] of REJECTION_MATRIX) {
    it(`rejects: ${name}`, () => {
      expectRejected(raw, substrings);
    });
  }

  it("names the exact source file in every rejection (FR-009 fail-closed)", () => {
    const results = REJECTION_MATRIX.map(([, raw]) => parseFileEventRecord(raw, SOURCE));
    for (const r of results) {
      if (r.ok) {
        throw new Error(`expected rejection, parsed as ${JSON.stringify(r.value)}`);
      }
      // error is a string naming the source — never a bare code or empty message
      expect(typeof r.error).toBe("string");
      expect(r.error.length).toBeGreaterThan(0);
      expect(r.error).toContain(SOURCE);
    }
  });
});

describe("parseFileEventRecord — ADR-0076 `|` rejection with rationale", () => {
  it("rejects every keyed dedupKey containing '|', however placed", () => {
    // A keyed dedupKey containing "|" is indistinguishable in form from the
    // keyless digest input `${sequence}|${toJson(event)}` (layout.ts
    // eventDigestOf) — e.g. keyed key `5|{"a":1}` would hash identically to
    // the keyless record (5, {a:1}), so the two records would fight for one
    // filename and silently dedup one of them. The charset exclusion makes
    // the keyed and keyless digest domains disjoint by construction (ADR-0076).
    for (const key of ["a|b", "|", "a|", "|a", "x|y|z", "5|{\"a\":1}", "|a|b|"]) {
      const r = parseFileEventRecord({ ...validRecord(), dedupKey: key }, SOURCE);
      expect(r.ok, `dedupKey ${JSON.stringify(key)} must be rejected`).toBe(false);
    }
    expectRejected({ ...validRecord(), dedupKey: "a|b" }, ["|", "ADR-0076", "FR-015"]);
  });

  it("documents the rule on the exported surface (pattern + guard + error)", () => {
    expect(DEDUP_KEY_PATTERN.test("a|b")).toBe(false);
    expect(isDedupKey("a|b")).toBe(false);
    expectRejected({ ...validRecord(), dedupKey: "a|b" }, ["dedupKey"]);
  });
});

describe("parseFileEventRecord — FR-015 256-char bound", () => {
  it("accepts exactly 256 chars, rejects 257 chars", () => {
    const r256 = parseFileEventRecord({ ...validRecord(), dedupKey: "k".repeat(256) }, SOURCE);
    expect(r256.ok).toBe(true);
    if (r256.ok) expect(String(r256.value.dedupKey)).toBe("k".repeat(256));

    const r257 = parseFileEventRecord({ ...validRecord(), dedupKey: "k".repeat(257) }, SOURCE);
    expect(r257.ok).toBe(false);
    if (!r257.ok) {
      expect(r257.error).toContain("256");
      expect(r257.error).toContain("1,256");
    }
  });
});

describe("parseFileEventRecord — reserved tag keys (FR-009 domain agreement)", () => {
  it("rejects MALFORMED tag encodings at any depth — literal keys that survive deserialization — naming key and path", () => {
    // `raw` reaches the reader as tryFromJson output. A literal tag key in a
    // plain object in that output space is BY DEFINITION a malformed
    // encoding (well-formed tag-shaped bytes deserialize to Map/Set/Date/
    // undefined first — pinned in the acceptance test below):
    // `{__map__: "x"}` is not a Map, `{__set__: 1}` is not a Set,
    // `{__date__: 123}` is not a Date, `{__undefined__: false}` is not the
    // undefined marker. These cannot be produced by the write pre-scan, so
    // they are corrupt or hostile.
    const cases: ReadonlyArray<readonly [unknown, ReadonlyArray<string>]> = [
      [{ __map__: "x" }, ["__map__", "event.__map__"]],
      [{ __set__: 1 }, ["__set__", "event.__set__"]],
      [{ __date__: 123 }, ["__date__", "event.__date__"]],
      [{ __undefined__: false }, ["__undefined__", "event.__undefined__"]],
      [{ a: { b: { __map__: 7 } } }, ["__map__", "event.a.b.__map__"]],
      [[{ __date__: 123 }], ["__date__", "event[0].__date__"]],
      [new Map<string, unknown>([["k", { __set__: 1 }]]), ["__set__", "event[map entry #0 value].__set__"]],
      [new Set<unknown>([{ __undefined__: false }]), ["__undefined__"]],
    ];
    for (const [event, substrings] of cases) {
      const r = parseFileEventRecord({ ...validRecord(), event }, SOURCE);
      expect(r.ok, JSON.stringify(event)).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain(SOURCE);
      expect(r.error).toContain("corrupt or hostile");
      for (const s of substrings) {
        expect(r.error, `error ${JSON.stringify(r.error)} should mention ${JSON.stringify(s)}`).toContain(s);
      }
    }
  });

  it("accepts the legitimate tagged FORMS through the real pipeline (Map/Set/Date events)", () => {
    // The rejection targets malformed encodings — literal tag KEYS in plain
    // objects. Real Map/Set/Date values serialize via toJson's ACTUAL tags
    // and read back as their types — the pipeline must keep accepting them.
    const events: ReadonlyArray<unknown> = [
      new Map([["k", 1]]),
      new Set([1, "a"]),
      new Date(1_700_000_000_000),
      new Map([["__map__", 1]]), // tag-looking KEY inside a Map is data, not a marker
    ];
    for (const event of events) {
      const json = serializeFileEventRecord(0, "", 1, event);
      const raw = tryParseEventRecordJson(json, SOURCE);
      expect(raw.ok).toBe(true);
      if (!raw.ok) continue;
      const parsed = parseFileEventRecord(raw.value, SOURCE);
      expect(parsed.ok, `legitimate tagged form rejected: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      if (parsed.ok) expect(parsed.value.event).toEqual(event);
    }
  });

  it("well-formed tag-shaped record bytes pass the strict raw seam and are accepted as their types", () => {
    // Exact canonical tags are legitimate serializer output. The strict raw
    // grammar accepts them before the decoder restores their runtime types.
    const record = (eventJson: string): string =>
      `{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":${eventJson}}`;

    const mapRaw = tryParseEventRecordJson(record('{"__map__":[[1,2]]}'), SOURCE);
    expect(mapRaw.ok).toBe(true);
    if (!mapRaw.ok) return;
    const mapParsed = parseFileEventRecord(mapRaw.value, SOURCE);
    expect(mapParsed.ok, `well-formed __map__ record must be accepted, got ${mapParsed.ok ? "" : mapParsed.error}`).toBe(true);
    if (mapParsed.ok) {
      expect(mapParsed.value.event).toBeInstanceOf(Map);
      expect(mapParsed.value.event).toEqual(new Map([[1, 2]]));
    }

    const setRaw = tryParseEventRecordJson(record('{"__set__":[1,2]}'), SOURCE);
    expect(setRaw.ok).toBe(true);
    if (!setRaw.ok) return;
    const setParsed = parseFileEventRecord(setRaw.value, SOURCE);
    expect(setParsed.ok, `well-formed __set__ record must be accepted, got ${setParsed.ok ? "" : setParsed.error}`).toBe(true);
    if (setParsed.ok) {
      expect(setParsed.value.event).toBeInstanceOf(Set);
      expect(setParsed.value.event).toEqual(new Set([1, 2]));
    }

    const dateRaw = tryParseEventRecordJson(record('{"__date__":"2024-01-01T00:00:00.000Z"}'), SOURCE);
    expect(dateRaw.ok).toBe(true);
    if (!dateRaw.ok) return;
    const dateParsed = parseFileEventRecord(dateRaw.value, SOURCE);
    expect(dateParsed.ok, `well-formed __date__ record must be accepted, got ${dateParsed.ok ? "" : dateParsed.error}`).toBe(true);
    if (dateParsed.ok) {
      expect(dateParsed.value.event).toBeInstanceOf(Date);
      expect((dateParsed.value.event as Date).toISOString()).toBe("2024-01-01T00:00:00.000Z");
    }

    // The undefined marker is the one well-formed tag the pipeline ends up
    // REJECTING — but for a different reason: it erases the event field
    // entirely, which the strict schema treats as missing.
    const undefRaw = tryParseEventRecordJson(record('{"__undefined__":true}'), SOURCE);
    expect(undefRaw.ok).toBe(true);
    if (!undefRaw.ok) return;
    const undefParsed = parseFileEventRecord(undefRaw.value, SOURCE);
    expect(undefParsed.ok).toBe(false);
    if (!undefParsed.ok) expect(undefParsed.error).toContain("missing event field");

    // Malformed encodings go through the SAME pipeline and DO fail closed
    // with the reserved-tag gate — that is the shape the reader actually
    // rejects: literal tag keys that survive deserialization.
    const malformedMapRaw = tryParseEventRecordJson(record('{"__map__":"x"}'), SOURCE);
    expect(malformedMapRaw.ok).toBe(false);
    if (!malformedMapRaw.ok) {
      expect(malformedMapRaw.error).toContain("__map__");
      expect(malformedMapRaw.error).toContain("corrupt or hostile");
    }
  });

  it("shows the write/read agreement: literal tag keys are unwritable, and the reader's verdict matches the deserialized shape", () => {
    // WRITE side: every literal tag key in a plain object — well-formed or
    // malformed — is rejected by the pre-scan (the writer can never produce
    // one).
    const literalTagEvents: ReadonlyArray<unknown> = [
      { __map__: [[1, 2]] },
      { __set__: [1] },
      { __date__: "2024-01-01T00:00:00.000Z" },
      { __undefined__: true },
      { a: { __map__: 1 } },
    ];
    for (const event of literalTagEvents) {
      expect(() => serializeFileEventRecord(0, "", 1, event)).toThrow(/reserved tag key/);
    }

    // READ side: canonical Map/Set/Date tag bytes pass the strict grammar
    // and read back as their types; malformed tags fail BEFORE decoding.
    const throughPipeline = (eventJson: string): { ok: boolean; error: string } => {
      const raw = tryParseEventRecordJson(
        `{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":${eventJson}}`,
        SOURCE,
      );
      if (!raw.ok) return { ok: false, error: raw.error };
      const parsed = parseFileEventRecord(raw.value, SOURCE);
      return parsed.ok ? { ok: true, error: "" } : { ok: false, error: parsed.error };
    };
    expect(throughPipeline('{"__map__":[[1,2]]}').ok).toBe(true);
    expect(throughPipeline('{"__set__":[1,2]}').ok).toBe(true);
    expect(throughPipeline('{"__date__":"2024-01-01T00:00:00.000Z"}').ok).toBe(true);
    expect(throughPipeline('{"__undefined__":false}').ok).toBe(false); // malformed marker
    expect(throughPipeline('{"a":{"__map__":1}}').ok).toBe(false); // malformed tag at depth
  });
});

describe("tryParseEventRecordJson — exact canonical serializer grammar before deserialization", () => {
  const record = (eventJson: string): string =>
    `{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":${eventJson}}`;

  const expectRawTagRejected = (
    eventJson: string,
    expectedSubstrings: readonly string[],
  ): void => {
    const result = tryParseEventRecordJson(record(eventJson), SOURCE);
    expect(result.ok, eventJson).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(SOURCE);
    expect(result.error).toContain("serialized record is not canonical");
    expect(result.error).toContain("corrupt or hostile");
    for (const substring of expectedSubstrings) {
      expect(result.error).toContain(substring);
    }
  };

  it("accepts recursively nested canonical Map/Set/Date/undefined tags", () => {
    const result = tryParseEventRecordJson(
      record(
        '{"__map__":[["nested",{"__set__":[{"__date__":"2025-01-02T03:04:05.000Z"},{"__undefined__":true}]}]]}',
      ),
      SOURCE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseFileEventRecord(result.value, SOURCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.event).toEqual(
      new Map([
        ["nested", new Set([new Date("2025-01-02T03:04:05.000Z"), undefined])],
      ]),
    );
  });

  it("rejects malformed or ambiguous nested Map/Set/Date/undefined tags, including extra siblings", () => {
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
      [
        '{"outer":{"__map__":[["k",1]],"extra":"decoder-would-drop"}}',
        ["record.event.outer", "ambiguous serializer-tag object", "extra"],
      ],
      [
        '{"outer":{"__map__":[["k",1,"decoder-would-ignore"]]}}',
        ["record.event.outer.__map__[0]", "exact two-element"],
      ],
      [
        '{"outer":{"__set__":[1],"extra":true}}',
        ["record.event.outer", "ambiguous serializer-tag object", "extra"],
      ],
      [
        '{"outer":{"__date__":"2025-01-02T03:04:05.000Z","extra":1}}',
        ["record.event.outer", "ambiguous serializer-tag object", "extra"],
      ],
      [
        '{"outer":{"__undefined__":true,"extra":1}}',
        ["record.event.outer", "ambiguous serializer-tag object", "extra"],
      ],
      [
        '{"outer":{"__map__":[],"__set__":[]}}',
        ["record.event.outer", "ambiguous serializer-tag object", "__map__", "__set__"],
      ],
      ['{"outer":{"__map__":"not-an-array"}}', ["record.event.outer.__map__", "must be an array"]],
      ['{"outer":{"__set__":{}}}', ["record.event.outer.__set__", "must be an array"]],
      [
        '{"outer":{"__date__":"2025-01-02"}}',
        ["record.event.outer.__date__", "canonical ISO timestamp"],
      ],
      [
        '{"outer":{"__undefined__":false}}',
        ["record.event.outer.__undefined__", "exactly true"],
      ],
    ];

    for (const [eventJson, expected] of cases) {
      expectRawTagRejected(eventJson, expected);
    }
  });

  it("rejects hostile keys recursively inside Map/Set tag payloads before the decoder can erase them", () => {
    expectRawTagRejected(
      '{"__map__":[["safe",{"__set__":[{"constructor":{"polluted":true}}]}]]}',
      [
        "record.event.__map__[0][1].__set__[0].constructor",
        "prototype-pollution-filtered key",
      ],
    );
  });

  it("rejects hostile tag nesting past the shared depth ceiling before recursive deserialization", () => {
    const depth = MAX_SAFE_RECORD_DEPTH + 1;
    const nestedSets = '{"__set__":['.repeat(depth) + "1" + "]}".repeat(depth);
    expectRawTagRejected(nestedSets, ["safe depth ceiling", String(MAX_SAFE_RECORD_DEPTH)]);
  });

  it("rejects raw non-canonical -0 while preserving the writer's deliberate -0 → 0 canonicalization", () => {
    expectRawTagRejected('{"x":-0}', ["record.event.x", "normalizes -0 to 0"]);
    const written = serializeFileEventRecord(0, "", 1, { x: -0 });
    expect(written).toContain('"event":{"x":0}');
    expect(tryParseEventRecordJson(written, SOURCE).ok).toBe(true);
  });
});

describe("prototype-pollution keys — fail-closed at the raw-JSON read seam (FR-009)", () => {
  // `deserializeValue` silently ERASES `__proto__`/`constructor`/`prototype`
  // keys, so a record containing one reads back TRUNCATED with no error —
  // the strict validator never sees the erased key. Verified loss:
  // `{"event":{"constructor":{"hidden":1},"ok":1}}` deserializes to
  // `{"event":{"ok":1}}` and parses as valid. The read side fails closed
  // BEFORE deserialization erases them, at the raw-JSON seam
  // (`tryParseEventRecordJson`, wired into `readFileEventRecords`), naming
  // the source and path. The write side rejects the same keys, so the scan
  // adding no behavior change for writer-produced records.

  it("rejects a constructor key through the REAL read pipeline (readFileEventRecords), naming the file", () => {
    const r = readRawRecordFile(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"constructor":{"hidden":1},"ok":1}}',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/events\/000000-/); // names the source file
    expect(r.error).toContain("record.event.constructor");
    expect(r.error).toContain("prototype-pollution-filtered key");
    expect(r.error).toContain("corrupt or hostile");
  });

  it("rejects __proto__ (the real hostile shape: JSON.parse creates an OWN key), naming the path", () => {
    const r = readRawRecordFile(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"__proto__":{"polluted":1}}}',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("record.event.__proto__");
    expect(r.error).toContain("corrupt or hostile");
  });

  it("rejects prototype at depth, naming the nested path", () => {
    const r = readRawRecordFile(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"a":{"b":{"prototype":1}}}}',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("record.event.a.b.prototype");
  });

  it("rejects pollution keys inside tag-shaped bytes (a Map value region) BEFORE deserialization turns them into a Map", () => {
    // Bytes that would deserialize to Map([["k", {constructor:{x:1}}]]):
    // deserializeValue would erase the nested constructor mid-entry — the
    // raw-JSON scan catches it at record.event.__map__[0][1].constructor
    // while the bytes are still a plain tree.
    const r = readRawRecordFile(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"__map__":[["k",{"constructor":{"x":1}}]]}}',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("record.event.__map__[0][1].constructor");
  });

  it("rejects top-level pollution keys too (a record field would be erased before the strict schema gate)", () => {
    const r = readRawRecordFile(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":null,"constructor":{"hidden":1}}',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("record.constructor");
  });

  it("never false-positives: 'constructor' as a VALUE or inside a longer key is data", () => {
    // The scan is exact-keyed: these records must NOT be rejected by the
    // pollution gate. (They ARE still rejected by the reader — the
    // filename digest check on the dummy name — which proves the gate that
    // fired is the digest one, not pollution.)
    const r = readRawRecordFile(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"msg":"constructor","key_constructor":1,"list":["prototype",["__proto__"]]}}',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/filename digest/);
    expect(r.error).not.toContain("prototype-pollution-filtered");
  });

  it("accepts a legitimate record through the seam: unit-level tryParseEventRecordJson", () => {
    const r = tryParseEventRecordJson(
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":{"kind":"step","map":{"__map__":[["constructor",1]]}}}',
      SOURCE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Map keys are data: a "constructor" STRING key inside a Map survives
    // (deserializeValue filters only plain-object keys) and reads back as
    // a Map of one entry.
    const event = (r.value as Record<string, unknown>).event as Record<string, unknown>;
    expect(event.map).toBeInstanceOf(Map);
    expect(event.map).toEqual(new Map([["constructor", 1]]));
  });

  it("reports malformed JSON identically to the old tryFromJson seam (message shape preserved)", () => {
    const r = tryParseEventRecordJson('{"schemaVersion":1,"sequence":0', SOURCE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(`${SOURCE}: not valid JSON:`);
      expect(r.error).toContain("(FR-009)");
    }
  });
});

describe("parseStoredEventRecord — the public text entry point (barrel forensic path)", () => {
  it("is exported from the public file barrel", () => {
    expect(barrelParseStoredEventRecord).toBe(parseStoredEventRecord);
  });

  it("round-trips a Map/Set/Date-bearing record file TEXT without a spurious corrupt verdict", () => {
    // Regression pin for the shallow-fragment footgun: a legitimate
    // Map/Set/Date record serializes to tag-shaped plain objects in raw
    // JSON. The composite keeps the reader's full pipeline (grammar gate →
    // deserializeValue → strict parse) and restores the types; the fragment
    // stage alone, fed raw `JSON.parse` output, trips the reserved-tag scan
    // as a literal tag key — a FALSE positive on valid input.
    const event = new Map<string, unknown>([
      ["set", new Set([1, 2, 3])],
      ["when", new Date(1_700_000_000_000)],
    ]);
    const json = serializeFileEventRecord(3, "agent:run-9", 1_700_000_000_000, event);

    const viaText = parseStoredEventRecord(json, SOURCE);
    expect(viaText.ok).toBe(true);
    if (viaText.ok) {
      expect(viaText.value.event).toEqual(event);
      expect(viaText.value.event).toBeInstanceOf(Map);
    }

    const viaFragment = parseFileEventRecord(JSON.parse(json), SOURCE);
    expect(viaFragment.ok).toBe(false);
    if (!viaFragment.ok) {
      expect(viaFragment.error).toContain("literal reserved serializer tag key");
    }
  });

  it("keeps the fail-closed pollution-key guarantee through the text seam", () => {
    const polluted =
      '{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,' +
      '"event":{"__proto__":{"polluted":1}}}' ;
    const result = parseStoredEventRecord(polluted, SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("record.event.__proto__");
      expect(result.error).toContain("prototype-pollution-filtered key");
      expect(result.error).toContain("corrupt or hostile");
    }
  });
});

describe("hostile record depth — fail closed with FR-009 context, never a raw RangeError", () => {
  // Depth-overflow regression: a hostile
  // record whose event nests ~50k deep (~100KB) parses fine in V8's
  // iterative JSON.parse, but the RECURSIVE walks — the raw seam
  // (`validateSerializedValueGrammar` on parsed JSON), findReservedTagKey in
  // parseFileEventRecord, assertLosslessEvent on the write side — overflowed
  // the JS call stack and escaped:
  //   - read: a raw RangeError through tryParseEventRecordJson →
  //     readFileEventRecords, breaking the Result<_, FrameworkError>
  //     contract and the typed cache-error classification FR-009 promises
  //     (crashing the T7 resume flow without checkpoint-corrupt)
  //   - write: a bare RangeError with no FR-009 context from the write
  //     pre-scan, violating the documented contextual-Error boundary
  // The read walks are now ITERATIVE (explicit stack — they cannot overflow
  // at any depth) and both boundaries enforce the shared
  // MAX_SAFE_RECORD_DEPTH ceiling, failing closed with contextual FR-009
  // errors naming the source and the depth violation.

  /** Hostile deep-JSON builders (the finding's shapes: arrays and objects). */
  const deepArrayJson = (depth: number): string =>
    "[".repeat(depth) + "1" + "]".repeat(depth);
  const deepObjectJson = (depth: number): string =>
    '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
  /** A full record file bytes whose `event` field is the given JSON. */
  const deepRecordJson = (eventJson: string): string =>
    `{"schemaVersion":1,"sequence":0,"dedupKey":"","recordedAtMs":1,"event":${eventJson}}`;

  /** Caller-event builders for the write side (real JS trees) — exactly
   * `depth` nested containers, so an event built with
   * `MAX_SAFE_RECORD_DEPTH` sits precisely at the ceiling and one past it
   * is rejected. */
  const deepArrayValue = (depth: number): unknown => {
    const root: unknown[] = [];
    let cur = root;
    for (let i = 0; i < depth - 1; i++) {
      const next: unknown[] = [];
      (cur as unknown[]).push(next);
      cur = next;
    }
    (cur as unknown[]).push(1);
    return root;
  };
  const deepObjectValue = (depth: number): Record<string, unknown> => {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < depth - 1; i++) {
      const next: Record<string, unknown> = {};
      cur.a = next;
      cur = next;
    }
    cur.a = 1;
    return root;
  };

  it("read pipeline: a 50k-deep nested ARRAY record returns a typed cache-error naming the depth violation, never throws", () => {
    const r = readRawRecordFile(deepRecordJson(deepArrayJson(50_000)));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/events\/000000-/); // names the source file
    expect(r.error).toContain("safe depth ceiling");
    expect(r.error).toContain(String(MAX_SAFE_RECORD_DEPTH));
    expect(r.error).toContain("(FR-009)");
  });

  it("read pipeline: a 50k-deep nested OBJECT record returns a typed cache-error naming the depth violation, never throws", () => {
    const r = readRawRecordFile(deepRecordJson(deepObjectJson(50_000)));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("safe depth ceiling");
    expect(r.error).toContain("(FR-009)");
  });

  it("readFileEvents drives the same seam and tags its own operation", () => {
    const dir = pipelineDir();
    writeFileSync(
      join(dir, EVENTS_DIR, "000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"),
      deepRecordJson(deepArrayJson(50_000)),
    );
    const result = readFileEvents(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failure = result.error as Extract<FrameworkError, { readonly kind: "cache-error" }>;
    expect(failure.operation).toBe("readFileEvents");
    expect(failure.message).toContain("safe depth ceiling");
  });

  it("the raw seam itself (tryParseEventRecordJson) errs on deep nesting, never throws", () => {
    const r = tryParseEventRecordJson(deepRecordJson(deepArrayJson(50_000)), SOURCE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(SOURCE);
    expect(r.error).toContain("record nesting"); // the whole-record raw scan
    expect(r.error).toContain("safe depth ceiling");
  });

  it("parseFileEventRecord direct API errs on a 50k-deep DESERIALIZED event, never throws", () => {
    // The verified scenario: V8's iterative JSON.parse produces the deep
    // tree with NO recursion (JSON.parse in the pipeline rejects the record
    // BEFORE deserialization via the raw seam — tryParseEventRecordJson —
    // so this direct call hands the validator the same tree shape a
    // shallower record would have after tryFromJson). findReservedTagKey
    // must reject it as err — never a raw RangeError escaping
    // Result<FileEventRecord, string>.
    const deepEvent = JSON.parse(deepArrayJson(50_000)) as unknown;
    const parsed = parseFileEventRecord({ ...validRecord(), event: deepEvent }, SOURCE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain(SOURCE);
    expect(parsed.error).toContain("event nesting"); // the event-level scan
    expect(parsed.error).toContain("safe depth ceiling");
  });

  it("write boundary: 50k-deep caller events throw typed cache-error, never a raw RangeError", () => {
    for (const event of [deepArrayValue(50_000), deepObjectValue(50_000)]) {
      let error: unknown;
      try {
        serializeFileEventRecord(0, "", 1, event);
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      const typed = asCacheError(error, "serializeFileEventRecord");
      expect(typed.message).toContain("serializeFileEventRecord:");
      expect(typed.message).toContain("safe depth ceiling");
      expect(typed.message).toContain(String(MAX_SAFE_RECORD_DEPTH));
      expect(typed.message).toContain("(FR-009)");
    }
  });

  it("depth boundary: an event nested exactly at MAX_SAFE_RECORD_DEPTH round-trips; one level past it fails closed on BOTH sides", () => {
    // MAX_SAFE_RECORD_DEPTH counts property hops from the record root — the
    // `event` field itself is depth 1 — so N nested containers inside the
    // event sit at depths 1..N. N = MAX_SAFE_RECORD_DEPTH is the exact
    // boundary: accepted by writer AND reader; N+1 fails closed by both.
    const at = deepArrayValue(MAX_SAFE_RECORD_DEPTH);
    const json = serializeFileEventRecord(0, "", 1, at);
    const raw = tryFromJson(json);
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const parsed = parseFileEventRecord(raw.value, SOURCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // read → write: byte-stable even at the boundary.
    expect(
      serializeFileEventRecord(
        parsed.value.sequence,
        parsed.value.dedupKey,
        parsed.value.recordedAtMs,
        parsed.value.event,
      ),
    ).toBe(json);

    // One level past the ceiling: the write pre-scan throws contextually…
    for (const tooDeep of [
      deepArrayValue(MAX_SAFE_RECORD_DEPTH + 1),
      deepObjectValue(MAX_SAFE_RECORD_DEPTH + 1),
    ]) {
      expect(() => serializeFileEventRecord(0, "", 1, tooDeep)).toThrow(/safe depth ceiling/);
    }
    // …and the raw read seam agrees (writer/reader depth-domain parity).
    const deep = tryParseEventRecordJson(
      deepRecordJson(deepArrayJson(MAX_SAFE_RECORD_DEPTH + 1)),
      SOURCE,
    );
    expect(deep.ok).toBe(false);
    if (!deep.ok) {
      expect(deep.error).toContain("safe depth ceiling");
      expect(deep.error).not.toContain("RangeError");
    }
  });

  it("moderately deep legitimate events (100 levels, array and object) still round-trip byte-stable", () => {
    for (const event of [deepArrayValue(100), deepObjectValue(100)]) {
      const json = serializeFileEventRecord(0, "", 1, event);
      const raw = tryFromJson(json);
      expect(raw.ok).toBe(true);
      if (!raw.ok) continue;
      const parsed = parseFileEventRecord(raw.value, SOURCE);
      expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
      if (!parsed.ok) continue;
      expect(
        serializeFileEventRecord(
          parsed.value.sequence,
          parsed.value.dedupKey,
          parsed.value.recordedAtMs,
          parsed.value.event,
        ),
      ).toBe(json);
    }
  });
});

describe("fast-check properties", () => {
  const keyedKeyArb = fc.stringMatching(/^[A-Za-z0-9:_-]{1,64}$/);
  const dedupKeyArb = fc.oneof(fc.constant(""), keyedKeyArb);
  const eventArb = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.constant(0.5),
    fc.constant(-2.75),
    fc.string(),
    fc.constant({}),
    fc.constant({ a: [1, 2, 3], b: "x" }),
    fc.array(fc.integer()),
    fc.constant(new Date(1_700_000_000_123)),
    fc.constant(new Map([["k", 1]])),
    fc.constant(new Set([1, "a"])),
    // nested composite: Map/Set/Date recognized deep inside plain data —
    // the pre-scan must keep accepting the legitimate tagged forms at any
    // depth, and the round-trip must stay byte-stable.
    fc.constant({
      when: new Date(1_700_000_000_123),
      map: new Map<string, unknown>([
        ["set", new Set([1, 2])],
        ["inner", { deep: [new Date(1_700_000_000_123), null, "x"] }],
      ]),
      list: [new Map([["k", new Set([3])]])],
    }),
  );
  const validRecordArb = fc.record({
    sequence: fc.integer({ min: 0, max: 999_999 }),
    dedupKey: dedupKeyArb,
    recordedAtMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
    event: eventArb,
  });

  it("rejects EVERY generated malformed record, naming the source (FR-009)", () => {
    const invalidSchemaVersion = fc.oneof(
      fc.constant(0), fc.constant(2), fc.constant(-1), fc.constant(1.5),
      fc.constant("1"), fc.constant(null), fc.constant(true),
    );
    const invalidSequence = fc.oneof(
      fc.constant(-1), fc.constant(1.5), fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY), fc.constant("1"), fc.constant(null),
      fc.constant(true), fc.constant(9_007_199_254_740_992), fc.constant(1_000_000),
      fc.constant(Number.MAX_SAFE_INTEGER),
    );
    const invalidDedupKey = fc.oneof(
      fc.constant("a|b"), fc.constant("|"), fc.constant("a|"), fc.constant("5|{\"a\":1}"),
      fc.constant("@bad"), fc.constant("has space"), fc.constant("dot."),
      fc.constant("slash/"), fc.constant("café"), fc.constant("a".repeat(257)),
      fc.constant(123), fc.constant(null), fc.constant(true), fc.constant(undefined),
    );
    const invalidRecordedAtMs = fc.oneof(
      fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY), fc.constant("123"),
      fc.constant(null), fc.constant(undefined),
    );
    const nonObjectRaw = fc.oneof(
      fc.constant(null), fc.constant(42), fc.constant("x"), fc.constant(true),
      fc.constant([1, 2]), fc.constant([]), fc.constant(undefined),
    );

    const malformedRecordArb = fc.oneof(
      nonObjectRaw,
      fc.record({ schemaVersion: invalidSchemaVersion, sequence: fc.constant(0), dedupKey: fc.constant(""), recordedAtMs: fc.constant(0), event: fc.constant(null) }),
      fc.record({ schemaVersion: fc.constant(1), sequence: invalidSequence, dedupKey: fc.constant(""), recordedAtMs: fc.constant(0), event: fc.constant(null) }),
      fc.record({ schemaVersion: fc.constant(1), sequence: fc.constant(0), dedupKey: invalidDedupKey, recordedAtMs: fc.constant(0), event: fc.constant(null) }),
      fc.record({ schemaVersion: fc.constant(1), sequence: fc.constant(0), dedupKey: fc.constant(""), recordedAtMs: invalidRecordedAtMs, event: fc.constant(null) }),
      fc.record({ schemaVersion: fc.constant(1), sequence: fc.constant(0), dedupKey: fc.constant(""), recordedAtMs: fc.constant(0), event: fc.constant(undefined) }),
      // unknown top-level field (fail-closed strict schema)
      fc.record({ schemaVersion: fc.constant(1), sequence: fc.constant(0), dedupKey: fc.constant(""), recordedAtMs: fc.constant(0), event: fc.constant(null), extra: fc.constant(1) }),
      fc.record({ schemaVersion: fc.constant(1), sequence: fc.constant(0), dedupKey: fc.constant(""), recordedAtMs: fc.constant(0), event: fc.constant(null), data: fc.constant({}) }),
    );

    fc.assert(
      fc.property(malformedRecordArb, (raw) => {
        const r = parseFileEventRecord(raw, SOURCE);
        if (r.ok) {
          throw new Error(
            `malformed record parsed as valid: ${JSON.stringify(r.value)} (raw ${JSON.stringify(raw)})`,
          );
        }
        expect(r.error).toContain(SOURCE);
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it("round-trips every generated valid record: serialize → tryFromJson → parse → serialize", () => {
    fc.assert(
      fc.property(validRecordArb, (rec) => {
        const json = serializeFileEventRecord(rec.sequence, rec.dedupKey, rec.recordedAtMs, rec.event);

        // write → read: tryFromJson (restores Map/Set/Date) then strict parse
        const raw = tryFromJson(json);
        if (!raw.ok) throw new Error(`tryFromJson failed: ${String(raw.error)}`);
        const parsed = parseFileEventRecord(raw.value, SOURCE);
        if (!parsed.ok) throw new Error(`valid record rejected: ${parsed.error}`);

        expect(parsed.value.schemaVersion).toBe(JOURNAL_SCHEMA_VERSION);
        expect(Number(parsed.value.sequence)).toBe(rec.sequence);
        expect(String(parsed.value.dedupKey)).toBe(rec.dedupKey);
        expect(parsed.value.recordedAtMs).toBe(rec.recordedAtMs);
        expect(parsed.value.event).toEqual(rec.event);

        // read → write: re-serialization is byte-stable even with Map/Set/Date
        const re = serializeFileEventRecord(
          parsed.value.sequence,
          parsed.value.dedupKey,
          parsed.value.recordedAtMs,
          parsed.value.event,
        );
        expect(re).toBe(json);
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile-boundary diagnostic discipline: error-message construction runs
// while handling an earlier failure, so rendering an untrusted value must
// never execute `toJSON`/getter traps (the same contract `dedupKeyError`
// enforces in this module — `render` previously attempted `JSON.stringify`
// on non-primitives, which executes traps before its catch can fire).
// ---------------------------------------------------------------------------

describe("rejection diagnostics — hostile value rendering is trap-free", () => {
  it("a throwing toJSON on a rejected sequence value does not execute during error construction", () => {
    let trapExecuted = false;
    const hostile = {
      toJSON: () => {
        trapExecuted = true;
        throw new Error("toJSON trap fired");
      },
    };

    const result = parseJournalSequence(hostile);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/FR-009/);
      expect(result.error.length).toBeGreaterThan(0);
    }
    expect(trapExecuted).toBe(false);
  });

  it("a throwing toJSON GETTER on a rejected value does not execute during error construction", () => {
    let trapExecuted = false;
    const hostile: Record<PropertyKey, unknown> = {};
    Object.defineProperty(hostile, "toJSON", {
      get: () => {
        trapExecuted = true;
        throw new Error("getter trap fired");
      },
      enumerable: true,
      configurable: true,
    });

    const result = parseJournalSequence(hostile);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/FR-009/);
    }
    expect(trapExecuted).toBe(false);
  });

  it("a hostile sequence field on a rejected record renders without executing traps", () => {
    let trapExecuted = false;
    const hostile = {
      toJSON: () => {
        trapExecuted = true;
        throw new Error("toJSON trap fired");
      },
    };

    // A record whose `sequence` is a non-numeric hostile object is rejected
    // by `parseJournalSequence`; the rejection message renders the value.
    const raw = { schemaVersion: JOURNAL_SCHEMA_VERSION, sequence: hostile, dedupKey: "", recordedAtMs: 5, event: {} };
    const result = parseFileEventRecord(raw, SOURCE);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/sequence/);
    }
    expect(trapExecuted).toBe(false);
  });

  // Round-10 A7 (type-design-analyzer): the defense-in-depth catch-all used
  // to render `source` through `safeDiagnosticRender`, whose 60-char cap
  // truncates legal-but-long run-directory paths in exactly the branch where
  // the full name is the diagnostic (every normal rejection branch
  // interpolates the full path). The catch-all now uses the escape-only,
  // non-truncating `safeDiagnosticString`.
  it("the catch-all branch preserves a long (>60-char) source path in full, escaped", () => {
    // A hostile `ownKeys` trap throws inside `Object.keys(record)` — the
    // one interior operation the unchecked parser cannot pre-guard, which is
    // what the result-preserving shell's catch exists for.
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("ownKeys trap exploded");
        },
      },
    );
    const longSource =
      "/var/lib/fugue/runs/2026-08-17/standalone-2026-08-17-171928-f6-file-durable-runtime/events/node-a1b2c3/000042-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.json";
    expect(longSource.length).toBeGreaterThan(60);

    const result = parseFileEventRecord(hostile, longSource);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      // The full path, JSON-escaped at the head — not the truncated
      // `…(N chars)` form — and the FR-040 shell signature.
      expect(result.error.startsWith(`"${longSource}": event-record inspection failed`)).toBe(true);
      expect(result.error).toMatch(/FR-040/);
    }
  });
});

// ---------------------------------------------------------------------------
// `deepJsonEqual` totality — the shared FR-009 verdict helper is exported,
// so it must be safe at ANY depth, not only for the 512-pre-bounded inputs
// of the in-scope codecs. The iterative walk cannot overflow the call stack:
// a hostile unbounded-depth pair previously died as a raw RangeError outside
// any Result channel.
// ---------------------------------------------------------------------------

describe("deepJsonEqual — total over unbounded-depth hostile input", () => {
  const buildDeep = (leaf: string, depth: number): unknown => {
    let value: unknown = leaf;
    for (let i = 0; i < depth; i += 1) value = [value];
    return value;
  };

  it("a ~20k-deep hostile pair decides without overflowing the stack", () => {
    expect(() => deepJsonEqual(buildDeep("a", 20_000), buildDeep("b", 20_000))).not.toThrow();
    expect(deepJsonEqual(buildDeep("a", 20_000), buildDeep("b", 20_000))).toBe(false);
    expect(deepJsonEqual(buildDeep("a", 20_000), buildDeep("a", 20_000))).toBe(true);
  });

  it("keeps the canonical-form semantics (NaN-equals-NaN, structural mismatch)", () => {
    expect(deepJsonEqual({ a: [1, Number.NaN] }, { a: [1, Number.NaN] })).toBe(true);
    expect(deepJsonEqual({ a: [1, Number.NaN] }, { a: [1, 2] })).toBe(false);
    expect(deepJsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepJsonEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepJsonEqual(undefined, undefined)).toBe(true);
  });
});
