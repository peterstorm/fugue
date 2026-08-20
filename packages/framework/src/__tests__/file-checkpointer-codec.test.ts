/**
 * Direct PURE tests for `src/file/checkpointer-codec.ts` — the meta/node/
 * options codec layer of the file `Checkpointer` backend, extracted from the
 * pre-split adapter during the 2026-08-14 codec-separation remediation
 * (review run
 * .claude/reviews/review-and-fix-runs/standalone-2026-08-14-f6-file-durable-runtime).
 *
 * The codec is the functional core: stored-schema serialization and strict
 * parsing for `meta.json` and `nodes/<digest>.json`, boundary snapshots and
 * parsers for `saveNode`/`load` options, the canonical serializer-ready
 * output grammar, and the `checkpoint-write-failed` construction policy.
 * No I/O and no clock reads: every test hands the codec in-memory values.
 *
 * Coverage:
 * - `writeFailed`: truthful brands for valid raw identifiers, documented
 *   internal locations (`checkpoint_invalid_run` / `checkpoint_invalid_node`
 *   / `META_RECORD_NODE_ID`) for values that cannot inhabit the branded
 *   fields, additive raw-value diagnostics, and total rendering of hostile
 *   values (FR-040).
 * - `snapshotMeta` / `snapshotNodeState` / `snapshotSaveNodeOpts`:
 *   snapshot-once semantics — exactly one property read per field, frozen
 *   snapshots, stateful accessors cannot yield one value to validation and
 *   another to the committed bytes.
 * - `serializeMeta` / `parseStoredMeta`: exact on-disk grammar, strict
 *   field validation (parse, don't validate), canonical-ISO-only timestamps,
 *   unknown additive meta fields tolerated, `frameworkVersion` defaulting
 *   vs. optional parse (ADR-0017 sees `undefined`, not corruption), and
 *   round-trip byte parity.
 * - `materializeCanonicalOutput`: -0 normalization, non-finite/accessor/
 *   sparse/reserved-tag/pollution-key/prototype/cycle/depth rejections,
 *   canonical Map/Set/Date/undefined tags, frozen output.
 * - `serializeNode` / `parseNodeFile`: the digest-filename contract (ADR-0076),
 *   exact stored-envelope validation with recoverable corrupt addresses
 *   (FR-028), and Map/Set/Date/undefined restoration through
 *   `deserializeValue` — every expected malformed-byte shape returns a
 *   verdict, never a throw.
 * - `parseSaveNodeBoundary` / `parseLoadOpts`: closed own-key grammars
 *   (symbols and typos rejected), plain-object-only options, per-field value
 *   rules, and fresh frozen canonical option objects.
 *
 * Filesystem behavior (atomic writes, symlink containment, load-order
 * verdicts, error mapping) stays covered by `file-checkpointer.test.ts` and
 * `file-verified-directory.test.ts`; this suite needs no temp directories.
 */

import { describe, expect, it } from "bun:test";
import type { FrameworkError } from "../types/errors.js";
import {
  META_RECORD_NODE_ID,
  materializeCanonicalOutput,
  parseCanonicalIsoDate,
  parseLoadOpts,
  parseNodeFile,
  parseStoredMeta,
  parseSaveNodeBoundary,
  serializeMeta,
  serializeNode,
  snapshotMeta,
  snapshotNodeState,
  snapshotSaveNodeOpts,
  writeFailed,
} from "../file/checkpointer-codec.js";
import { MAX_SAFE_RECORD_DEPTH } from "../file/event-record.js";
import { D, N } from "./_id-helpers.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import { keyDigest } from "../file/layout.js";

/** Narrow the `FrameworkError` union onto the `checkpoint-write-failed`
 * variant after asserting the discriminant (TS cannot narrow through
 * `expect`). */
const asWriteFailed = (
  failure: FrameworkError,
): Extract<FrameworkError, { readonly kind: "checkpoint-write-failed" }> => {
  if (failure.kind !== "checkpoint-write-failed") {
    throw new Error(`expected checkpoint-write-failed, got ${failure.kind}`);
  }
  return failure;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATE = (overrides?: Record<string, unknown>) => ({
  nodeId: "n1",
  output: { done: true },
  completedAt: new Date("2025-06-01T12:00:00Z"),
  ...overrides,
});

/** `<sha256hex(nodeKey)>.json` — the on-disk filename contract (ADR-0076). */
const fileNameOf = (nodeKey: string): string => `${keyDigest(nodeKey)}.json`;

const envelopeJson = (nodeKey: string, overrides?: Record<string, unknown>): string =>
  JSON.stringify({
    nodeKey,
    nodeId: "n1",
    output: { done: true },
    completedAt: "2025-06-01T12:00:00.000Z",
    ...overrides,
  });

// ---------------------------------------------------------------------------
// checkpoint-write-failed construction policy
// ---------------------------------------------------------------------------

describe("writeFailed — truthful checkpoint-write-failed construction", () => {
  it("keeps valid raw identifiers under their own brands", () => {
    const failure = asWriteFailed(writeFailed("run-1", "node-1", "boom"));
    expect(failure.kind).toBe("checkpoint-write-failed");
    expect(String(failure.runId)).toBe("run-1");
    expect(String(failure.nodeId)).toBe("node-1");
    expect(failure.message).toBe("boom");
    expect("invalidRunId" in failure).toBe(false);
    expect("invalidNodeId" in failure).toBe(false);
  });

  it("uses META_RECORD_NODE_ID for metadata-scoped failures (no node being written)", () => {
    const failure = asWriteFailed(writeFailed("run-1", undefined, "meta rejected"));
    expect(failure.nodeId).toBe(META_RECORD_NODE_ID);
    expect(String(META_RECORD_NODE_ID)).toBe("checkpoint_meta");
    expect("invalidNodeId" in failure).toBe(false);
  });

  it("uses documented internal locations and additive raw diagnostics for boundary-invalid ids", () => {
    const failure = asWriteFailed(writeFailed("../attack", "bad/node", "rejected"));
    expect(String(failure.runId)).toBe("checkpoint_invalid_run");
    expect(String(failure.nodeId)).toBe("checkpoint_invalid_node");
    expect(failure.invalidRunId).toBe("../attack");
    expect(failure.invalidNodeId).toBe("bad/node");
    expect(failure.message).toBe("rejected");
  });

  it("renders hostile non-string raw values totally (FR-040)", () => {
    const failure = asWriteFailed(writeFailed({ plain: true }, 42, "rejected"));
    expect(failure.invalidRunId).toBe("[object Object]");
    expect(failure.invalidNodeId).toBe("42");
    // A revoked proxy as the raw value renders as "<unprintable>".
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const rawRevoked = asWriteFailed(writeFailed(revoked.proxy, undefined, "rejected"));
    expect(rawRevoked.invalidRunId).toBe("<unprintable>");
  });
});

// ---------------------------------------------------------------------------
// Meta codec — snapshot semantics
// ---------------------------------------------------------------------------

describe("snapshotMeta — snapshot-once boundary reads", () => {
  it("reads each public RunMeta field exactly once and freezes the snapshot", () => {
    let reads = 0;
    const meta = new Proxy(
      {
        dagId: "d",
        startedAt: new Date(0),
        nodeCount: 1,
      },
      {
        get(target, property, receiver) {
          reads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const snapshot = snapshotMeta(meta);
    expect(reads).toBe(6); // dagId, startedAt, nodeCount, subject, dagFingerprint, frameworkVersion
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.plainRecord).toBe(true);
  });

  it("a stateful accessor can never yield one value to validation and another to the committed bytes", () => {
    let reads = 0;
    const meta = {
      dagId: "d",
      startedAt: new Date(0),
      get nodeCount() {
        reads += 1;
        return reads === 1 ? 1 : 99;
      },
    };
    const snapshot = snapshotMeta(meta);
    expect(snapshot.nodeCount).toBe(1);
    // Even though a later read would observe 99, the committed bytes come
    // from the frozen snapshot alone.
    const json = serializeMeta(snapshot, 0);
    expect(JSON.parse(json).nodeCount).toBe(1);
    expect(reads).toBe(1);
  });

  it("marks non-plain records so serialization rejects them; null/undefined are unreadable and throw", () => {
    // Class instances pass `isPlainRecord` (it admits any object) and are
    // instead rejected by per-field validation in `serializeMeta`; only
    // non-objects and arrays are structurally non-plain here.
    for (const hostile of [42, "meta", ["dagId"]]) {
      expect(snapshotMeta(hostile).plainRecord).toBe(false);
    }
    expect(snapshotMeta(new (class M {})()).plainRecord).toBe(true);
    // Reading fields off null/undefined throws — the shell catches that and
    // maps it to a write failure; the codec documents it as unreadable.
    expect(() => snapshotMeta(null)).toThrow();
    expect(() => snapshotMeta(undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Meta codec — serialization strictness
// ---------------------------------------------------------------------------

describe("serializeMeta — writes the exact on-disk grammar or throws", () => {
  it("emits { dagId, startedAt, nodeCount, createdAt, frameworkVersion } with the injected clock", () => {
    const json = serializeMeta(
      snapshotMeta({
        dagId: "d",
        startedAt: new Date("2025-01-01T00:00:00Z"),
        nodeCount: 3,
      }),
      1_700_000_000_000,
    );
    expect(JSON.parse(json)).toEqual({
      dagId: "d",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 3,
      createdAt: "2023-11-14T22:13:20.000Z",
      frameworkVersion: FRAMEWORK_VERSION,
    });
  });

  it("preserves an explicit frameworkVersion and omits absent optional fields", () => {
    const json = serializeMeta(
      snapshotMeta({
        dagId: "d",
        startedAt: new Date(0),
        nodeCount: 0,
        subject: "tenant-7",
        frameworkVersion: "0.1.0-stale",
      }),
      0,
    );
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.frameworkVersion).toBe("0.1.0-stale");
    expect(parsed.subject).toBe("tenant-7");
    expect("dagFingerprint" in parsed).toBe(false);
  });

  it("throws for every non-representable meta field", () => {
    // A class instance is a record-shaped object with no fields; it trips
    // per-field validation (dagId missing) rather than the record-shape gate.
    expect(() => serializeMeta(snapshotMeta(new (class M {})()), 0)).toThrow(
      /meta\.dagId must be a string/,
    );
    // A structurally non-plain value trips the record-shape gate first.
    expect(() => serializeMeta(snapshotMeta(42), 0)).toThrow(/meta must be an object/);
    const cases: Array<[string, unknown]> = [
      ["meta.dagId must be a string", { dagId: 4, startedAt: new Date(0), nodeCount: 1 }],
      ["meta.startedAt", { dagId: "d", startedAt: new Date(NaN), nodeCount: 1 }],
      ["meta.startedAt", { dagId: "d", startedAt: "2025-01-01", nodeCount: 1 }],
      ["nodeCount", { dagId: "d", startedAt: new Date(0), nodeCount: -1 }],
      ["nodeCount", { dagId: "d", startedAt: new Date(0), nodeCount: 1.5 }],
      ["nodeCount", { dagId: "d", startedAt: new Date(0), nodeCount: "1" }],
      ["subject", { dagId: "d", startedAt: new Date(0), nodeCount: 1, subject: 9 }],
      ["dagFingerprint", { dagId: "d", startedAt: new Date(0), nodeCount: 1, dagFingerprint: {} }],
      ["frameworkVersion", { dagId: "d", startedAt: new Date(0), nodeCount: 1, frameworkVersion: 2 }],
    ];
    for (const [needle, meta] of cases) {
      expect(() => serializeMeta(snapshotMeta(meta), 0)).toThrow(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("throws when the injected clock cannot be represented", () => {
    expect(() =>
      serializeMeta(snapshotMeta({ dagId: "d", startedAt: new Date(0), nodeCount: 1 }), Number.NaN),
    ).toThrow(/clock produced a non-representable timestamp/);
    expect(() =>
      serializeMeta(snapshotMeta({ dagId: "d", startedAt: new Date(0), nodeCount: 1 }), Number.POSITIVE_INFINITY),
    ).toThrow(/clock produced a non-representable timestamp/);
  });
});

// ---------------------------------------------------------------------------
// Meta codec — strict parse
// ---------------------------------------------------------------------------

describe("parseStoredMeta — strict parse of meta.json (parse, don't validate)", () => {
  it("rejects non-JSON text", () => {
    expect(parseStoredMeta("{not json").ok).toBe(false);
  });

  it("rejects non-object roots", () => {
    for (const text of ["null", "[1]", '"meta"', "42"]) {
      const result = parseStoredMeta(text);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects every schema-violating field with a diagnostic", () => {
    const base = {
      dagId: "d",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const cases: Array<[string, string]> = [
      ["dagId must be a string", JSON.stringify({ ...base, dagId: 4 })],
      ["colons not allowed", JSON.stringify({ ...base, dagId: "tenant:dag" })],
      ["startedAt must be a string", JSON.stringify({ ...base, startedAt: 4 })],
      ["createdAt must be a string", JSON.stringify({ ...base, createdAt: {} })],
      ["nodeCount must be a non-negative safe integer", JSON.stringify({ ...base, nodeCount: -1 })],
      ["nodeCount must be a non-negative safe integer", JSON.stringify({ ...base, nodeCount: 1.5 })],
      ["subject must be a string when present", JSON.stringify({ ...base, subject: 9 })],
      ["dagFingerprint must be a string when present", JSON.stringify({ ...base, dagFingerprint: 1 })],
      ["frameworkVersion must be a string when present", JSON.stringify({ ...base, frameworkVersion: 2 })],
      ["startedAt must be a canonical ISO timestamp", JSON.stringify({ ...base, startedAt: "2025-01-01" })],
      ["createdAt must be a canonical ISO timestamp", JSON.stringify({ ...base, createdAt: "2025-01-01T00:00:00Z" })],
      ["createdAt must be a canonical ISO timestamp", JSON.stringify({ ...base, createdAt: "not-a-date" })],
    ];
    for (const [needle, text] of cases) {
      const result = parseStoredMeta(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(needle);
    }
  });

  it("tolerates unknown additive top-level fields for forward-compatible metadata evolution", () => {
    const result = parseStoredMeta(JSON.stringify({
      dagId: "d",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
      futureField: { nested: [1, 2, 3] },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.dagId).toBe(D("d"));
  });

  it("treats an absent frameworkVersion as absent (ADR-0017 sees undefined, not corruption)", () => {
    const result = parseStoredMeta(JSON.stringify({
      dagId: "d",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("frameworkVersion" in result.value.meta).toBe(false);
    expect(result.value.meta.frameworkVersion).toBeUndefined();
  });

  it("round-trips serializeMeta bytes and returns the stamped createdAt separately", () => {
    const json = serializeMeta(
      snapshotMeta({
        dagId: "d",
        startedAt: new Date("2025-01-01T00:00:00Z"),
        nodeCount: 2,
        dagFingerprint: "fp",
      }),
      1_700_000_000_000,
    );
    const parsed = parseStoredMeta(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.meta).toEqual({
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 2,
      dagFingerprint: "fp",
      frameworkVersion: FRAMEWORK_VERSION,
    });
    expect(parsed.value.createdAt).toEqual(new Date(1_700_000_000_000));
  });
});

describe("parseCanonicalIsoDate — canonical-timestamp grammar", () => {
  it("accepts only byte-identical canonical ISO text", () => {
    expect(parseCanonicalIsoDate("2025-01-01T00:00:00.000Z", "startedAt").ok).toBe(true);
    for (const nonCanonical of [
      "2025-01-01T00:00:00Z", // missing fractional seconds
      "2025-01-01", // date-only
      "2025-01-01T00:00:00.000+00:00", // offset spelling
      "2025-01-01t00:00:00.000z", // lowercase
      "garbage",
    ]) {
      const result = parseCanonicalIsoDate(nonCanonical, "startedAt");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("canonical ISO timestamp");
    }
  });
});

// ---------------------------------------------------------------------------
// Output canonicalization — the serializer-ready grammar
// ---------------------------------------------------------------------------

describe("materializeCanonicalOutput — canonical serializer-ready grammar", () => {
  it("normalizes -0 to JSON zero and rejects non-finite numbers", () => {
    const zero = materializeCanonicalOutput(-0);
    expect(zero).toBe(0);
    expect(Object.is(zero, -0)).toBe(false);
    expect(() => materializeCanonicalOutput(Number.NaN)).toThrow(/non-finite number/);
    expect(() => materializeCanonicalOutput(Number.POSITIVE_INFINITY)).toThrow(/non-finite number/);
  });

  it("preserves null/string/boolean and tags undefined", () => {
    expect(materializeCanonicalOutput(null)).toBe(null);
    expect(materializeCanonicalOutput("text")).toBe("text");
    expect(materializeCanonicalOutput(false)).toBe(false);
    expect(JSON.stringify(materializeCanonicalOutput(undefined))).toBe('{"__undefined__":true}');
  });

  it("rejects functions, symbols, and bigint", () => {
    expect(() => materializeCanonicalOutput(() => 1)).toThrow(/JSON cannot represent it losslessly/);
    expect(() => materializeCanonicalOutput(Symbol("s"))).toThrow(/JSON cannot represent it losslessly/);
    expect(() => materializeCanonicalOutput(1n)).toThrow(/JSON cannot represent it losslessly/);
  });

  it("tags Date, Map, and Set canonically", () => {
    expect(JSON.stringify(materializeCanonicalOutput(new Date("2025-01-01T00:00:00Z"))))
      .toBe('{"__date__":"2025-01-01T00:00:00.000Z"}');
    expect(JSON.stringify(materializeCanonicalOutput(new Map<string | number, string | number>([["k", 1], [2, "v"]]))))
      .toBe('{"__map__":[["k",1],[2,"v"]]}');
    expect(JSON.stringify(materializeCanonicalOutput(new Set([1, "b"]))))
      .toBe('{"__set__":[1,"b"]}');
  });

  it("rejects invalid Dates and Date/Map/Set instances with own properties", () => {
    expect(() => materializeCanonicalOutput(new Date(NaN))).toThrow(/invalid Date/);
    const dated = new Date(0);
    (dated as unknown as Record<string, unknown>).extra = 1;
    expect(() => materializeCanonicalOutput(dated)).toThrow(/own properties/);
    const mapped = new Map();
    (mapped as unknown as Record<string, unknown>).extra = 1;
    expect(() => materializeCanonicalOutput(mapped)).toThrow(/own properties/);
  });

  it("rejects accessors, non-enumerable and symbol keys, and custom prototypes", () => {
    expect(() => materializeCanonicalOutput({ get x() { return 1; } })).toThrow(/accessor/);
    const nonEnumerable = { x: 1 };
    Object.defineProperty(nonEnumerable, "hidden", { value: 2, enumerable: false });
    expect(() => materializeCanonicalOutput(nonEnumerable)).toThrow(/non-enumerable/);
    expect(() => materializeCanonicalOutput({ [Symbol("s")]: 1 })).toThrow(/symbol-keyed/);
    expect(() => materializeCanonicalOutput(new (class C {})())).toThrow(/unsupported prototype/);
  });

  it("rejects sparse arrays, array accessors, and exotic array properties", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    expect(() => materializeCanonicalOutput(sparse)).toThrow(/sparse/);

    const accessorArray: unknown[] = [];
    accessorArray.length = 1;
    Object.defineProperty(accessorArray, "0", { get: () => 1, enumerable: true });
    expect(() => materializeCanonicalOutput(accessorArray)).toThrow(/accessor/);

    // A real array auto-extends `length` when an index property is defined,
    // so an out-of-range INDEX can only be observed through a surrogate view:
    // a Proxy reporting a phantom index with a materialized descriptor. The
    // canonicalizer must reject it against the captured length.
    const phantomIndex = new Proxy([1], {
      ownKeys(_target) {
        return ["0", "1", "length"];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === "1") {
          return { value: 2, enumerable: true, writable: true, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(() => materializeCanonicalOutput(phantomIndex)).toThrow(/out-of-range array index/);

    const nonNumericKey: unknown[] = [1];
    (nonNumericKey as unknown as Record<string, unknown>).extra = 2;
    expect(() => materializeCanonicalOutput(nonNumericKey)).toThrow(/unsupported array property/);
  });

  it("rejects prototype-pollution and reserved serializer-tag keys in plain objects", () => {
    const pollution = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
    expect(() => materializeCanonicalOutput(pollution)).toThrow(/prototype-pollution key/);
    expect(() => materializeCanonicalOutput({ __map__: [] })).toThrow(/reserved serializer tag/);
    expect(() => materializeCanonicalOutput({ __date__: "x" })).toThrow(/reserved serializer tag/);
  });

  it("rejects cycles and excessive depth", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => materializeCanonicalOutput(cyclic)).toThrow(/cycle/);

    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_SAFE_RECORD_DEPTH; i += 1) deep = { nested: deep };
    expect(() => materializeCanonicalOutput(deep)).not.toThrow();

    let tooDeep: unknown = "leaf";
    for (let i = 0; i <= MAX_SAFE_RECORD_DEPTH; i += 1) tooDeep = { nested: tooDeep };
    expect(() => materializeCanonicalOutput(tooDeep)).toThrow(/safe depth ceiling/);
  });

  it("returns a frozen tree that never re-observes caller-owned state", () => {
    const source: Record<string, unknown> = { a: [1, { b: 2 }] };
    const canonical = materializeCanonicalOutput(source);
    source.a = "mutated";
    expect(JSON.stringify(canonical)).toBe('{"a":[1,{"b":2}]}');
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen((canonical as Record<string, unknown>).a)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Node codec — serialization
// ---------------------------------------------------------------------------

describe("snapshotNodeState — snapshot-once boundary reads", () => {
  it("reads each public NodeState field exactly once and freezes the snapshot", () => {
    let reads = 0;
    const state = new Proxy(STATE(), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const snapshot = snapshotNodeState(state);
    expect(reads).toBe(3); // nodeId, output, completedAt
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("serializeNode — canonical envelope bytes", () => {
  it("emits exactly { nodeKey, nodeId, output, completedAt } with a canonical timestamp", () => {
    const json = serializeNode("ns@n1@2@3", snapshotNodeState(STATE()));
    expect(JSON.parse(json)).toEqual({
      nodeKey: "ns@n1@2@3",
      nodeId: "n1",
      output: { done: true },
      completedAt: "2025-06-01T12:00:00.000Z",
    });
  });

  it("validates the stored nodeId against the boundary pattern", () => {
    expect(() =>
      serializeNode("n1", snapshotNodeState(STATE({ nodeId: "../evil" }))),
    ).toThrow(/does not match/);
    expect(() =>
      serializeNode("n1", snapshotNodeState(STATE({ nodeId: 42 }))),
    ).toThrow(/does not match/);
  });

  it("rejects invalid or non-Date completedAt values", () => {
    expect(() =>
      serializeNode("n1", snapshotNodeState(STATE({ completedAt: new Date(NaN) }))),
    ).toThrow(/completedAt must be a valid Date/);
    expect(() =>
      serializeNode("n1", snapshotNodeState(STATE({ completedAt: "2025-06-01" }))),
    ).toThrow(/completedAt must be a valid Date/);
  });

  it("addresses the filename by keyDigest(nodeKey) — the node-key ownership contract (ADR-0076)", () => {
    const nodeKey = "ns@n1@2@3";
    const json = serializeNode(nodeKey, snapshotNodeState(STATE()));
    const fileName = fileNameOf(nodeKey);
    expect(fileName).toMatch(/^[0-9a-f]{64}\.json$/);
    // The output of serializeNode must validate through the strict parser as
    // the same bytes the shell will write to that filename.
    const verdict = parseNodeFile(fileName, json);
    expect(verdict.kind).toBe("entry");
  });
});

// ---------------------------------------------------------------------------
// Node codec — strict parse verdicts
// ---------------------------------------------------------------------------

describe("parseNodeFile — strict parse of one node file", () => {
  it("returns a usable entry for a canonical key with Map/Set/Date/undefined output restoration", () => {
    const json = JSON.stringify({
      nodeKey: "n1",
      nodeId: "n1",
      output: {
        when: { __date__: "2025-06-01T12:00:00.000Z" },
        tags: { __set__: ["a", "b"] },
        counts: { __map__: [["x", 1]] },
        missing: { __undefined__: true },
      },
      completedAt: "2025-06-01T12:00:00.000Z",
    });
    const verdict = parseNodeFile(fileNameOf("n1"), json);
    expect(verdict).toMatchObject({ kind: "entry", nodeKey: "n1" });
    if (verdict.kind !== "entry") return;
    expect(verdict.state.nodeId).toBe(N("n1"));
    expect(verdict.state.completedAt).toEqual(new Date("2025-06-01T12:00:00Z"));
    const output = verdict.state.output as Record<string, unknown>;
    expect(output.when).toEqual(new Date("2025-06-01T12:00:00Z"));
    expect(output.tags).toEqual(new Set(["a", "b"]));
    expect(output.counts).toEqual(new Map([["x", 1]]));
    expect("missing" in output).toBe(true);
    expect((output as Record<string, unknown>).missing).toBeUndefined();
  });

  it("returns a usable entry for a composite key and reports it under the stored nodeKey", () => {
    const verdict = parseNodeFile(fileNameOf("dag@n1@0@1"), envelopeJson("dag@n1@0@1"));
    expect(verdict).toMatchObject({ kind: "entry", nodeKey: "dag@n1@0@1" });
  });

  it("classifies every expected malformed-byte shape as corrupt, never a throw (FR-028)", () => {
    const cases: Array<[string, string, string, RegExp]> = [
      ["not valid JSON", fileNameOf("n1"), "{", /not valid JSON/],
      ["non-object root", fileNameOf("n1"), "[1]", /node entry must be a JSON object/],
      ["non-object root", fileNameOf("n1"), "null", /node entry must be a JSON object/],
      [
        "unparseable nodeKey",
        fileNameOf("n1"),
        envelopeJson("n1", { nodeKey: "a@b" }),
        /nodeKey .* is not a well-formed canonical or composite node key/,
      ],
      [
        "unparseable nodeKey (many separators)",
        fileNameOf("n1"),
        envelopeJson("n1", { nodeKey: "a@b@c@d@e" }),
        /not a well-formed/,
      ],
      [
        "unknown envelope field",
        fileNameOf("n1"),
        envelopeJson("n1", { extra: 1 }),
        /unknown node-envelope field "extra"/,
      ],
      [
        "missing envelope field",
        fileNameOf("n1"),
        envelopeJson("n1", { completedAt: undefined }),
        /missing node-envelope field "completedAt"/,
      ],
      [
        "filename outside the digest contract",
        "not-a-digest.json",
        envelopeJson("n1"),
        /filename does not match the node-entry contract/,
      ],
      [
        "filename owned by another key",
        fileNameOf("n2"),
        envelopeJson("n1"),
        /does not own this address/,
      ],
      [
        "boundary-invalid stored nodeId",
        fileNameOf("n1"),
        envelopeJson("n1", { nodeId: "../evil" }),
        /nodeId .* does not match/,
      ],
      [
        "stored nodeId disagreeing with the nodeKey",
        fileNameOf("n1"),
        envelopeJson("n1", { nodeId: "n2" }),
        /names nodeId "n1" but entry contains "n2"/,
      ],
      [
        "non-string completedAt",
        fileNameOf("n1"),
        envelopeJson("n1", { completedAt: 42 }),
        /completedAt must be a string/,
      ],
      [
        "non-canonical completedAt",
        fileNameOf("n1"),
        envelopeJson("n1", { completedAt: "2025-06-01" }),
        /completedAt must be a canonical ISO timestamp/,
      ],
      [
        "pollution key inside output",
        fileNameOf("n1"),
        envelopeJson("n1", { output: JSON.parse('{"__proto__": 1}') }),
        /serialized output is not canonical/,
      ],
      [
        "ambiguous reserved tag inside output",
        fileNameOf("n1"),
        envelopeJson("n1", { output: { __map__: [], extra: 1 } }),
        /serialized output is not canonical/,
      ],
      [
        "duplicate primitive Map keys inside output",
        fileNameOf("n1"),
        envelopeJson("n1", { output: { __map__: [["a", 1], ["a", 2]] } }),
        /serialized output is not canonical/,
      ],
    ];
    for (const [label, fileName, text, message] of cases) {
      const verdict = parseNodeFile(fileName, text);
      // bun:test optional-message support is not assumed; the label is part
      // of the assertion failure via the thrown branch.
      expect(verdict.kind).toBe("corrupt");
      if (verdict.kind === "corrupt") {
        expect(verdict.message).toMatch(message);
      } else {
        throw new Error(`expected corrupt verdict for case: ${label}`);
      }
    }
  });

  it("recovers a valid node address even when the rest of the entry is corrupt (FR-028)", () => {
    const digestMismatch = parseNodeFile(fileNameOf("n2"), envelopeJson("n1"));
    expect(digestMismatch.kind).toBe("corrupt");
    if (digestMismatch.kind === "corrupt") expect(digestMismatch.address).toBe("n1");

    const unknownField = parseNodeFile(fileNameOf("n1"), envelopeJson("n1", { extra: 1 }));
    expect(unknownField.kind).toBe("corrupt");
    if (unknownField.kind === "corrupt") expect(unknownField.address).toBe("n1");

    // With no recoverable nodeKey (malformed envelope), the filename is the address.
    const badKey = parseNodeFile(fileNameOf("n1"), envelopeJson("n1", { nodeKey: 42 }));
    expect(badKey.kind).toBe("corrupt");
    if (badKey.kind === "corrupt") expect(badKey.address).toBe(fileNameOf("n1"));
  });
});

// ---------------------------------------------------------------------------
// saveNode options boundary
// ---------------------------------------------------------------------------

describe("snapshotSaveNodeOpts — snapshot-once boundary reads", () => {
  it("returns undefined for an absent options bag and reads declared fields at most once", () => {
    expect(snapshotSaveNodeOpts(undefined)).toBeUndefined();
    let reads = 0;
    const opts = new Proxy({ namespace: "ns", index: 2, attempt: 3 }, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const snapshot = snapshotSaveNodeOpts(opts);
    expect(reads).toBe(3);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot?.ownKeys).toEqual(["namespace", "index", "attempt"]);
  });

  it("captures the complete own-key set including symbols so the grammar stays closed", () => {
    const opts = { namespace: "ns" };
    (opts as Record<symbol, unknown>)[Symbol("hidden")] = 1;
    const snapshot = snapshotSaveNodeOpts(opts);
    expect(snapshot?.ownKeys).toHaveLength(2);
    expect(typeof snapshot?.ownKeys[1]).toBe("symbol");
  });
});

describe("parseSaveNodeBoundary — closed options grammar (FR-016)", () => {
  const rawState = snapshotNodeState(STATE());

  it("rejects boundary-invalid runId, nodeId, and state.nodeId before any path join", () => {
    for (const hostile of ["", "../run", "run/..", "a\u0000b", "has space", "a".repeat(129)]) {
      const runRes = parseSaveNodeBoundary(hostile, "n1", rawState, undefined);
      if (runRes.ok) throw new Error(`runId ${JSON.stringify(hostile)} was accepted`);
      expect(runRes.error).toContain("does not match");
      const nodeRes = parseSaveNodeBoundary("run-1", hostile, rawState, undefined);
      if (nodeRes.ok) throw new Error(`nodeId ${JSON.stringify(hostile)} was accepted`);
      expect(nodeRes.error).toContain("does not match");
      const stateRes = parseSaveNodeBoundary("run-1", "n1", snapshotNodeState(STATE({ nodeId: hostile })), undefined);
      if (stateRes.ok) throw new Error(`state.nodeId ${JSON.stringify(hostile)} was accepted`);
      expect(stateRes.error).toContain("does not match");
    }
  });

  it("requires state.nodeId to match the addressed nodeId and state to be a record", () => {
    const mismatch = parseSaveNodeBoundary("run-1", "n1", snapshotNodeState(STATE({ nodeId: "n2" })), undefined);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain("must match addressed nodeId");
    // null/undefined are unreadable to the snapshotter (the shell catches the
    // throw); other non-records produce a snapshot the boundary rejects.
    expect(() => snapshotNodeState(null)).toThrow();
    expect(() => snapshotNodeState(undefined)).toThrow();
    for (const badState of [42, "state", [1]]) {
      const nonRecord = parseSaveNodeBoundary("run-1", "n1", snapshotNodeState(badState), undefined);
      if (nonRecord.ok) throw new Error(`state ${JSON.stringify(badState)} was accepted`);
      expect(nonRecord.error).toContain("node state must be an object");
    }
  });

  it("returns ok(undefined) when no options are present", () => {
    const result = parseSaveNodeBoundary("run-1", "n1", rawState, undefined);
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("rejects class instances and arrays as options", () => {
    for (const badOpts of [new (class O {})(), [1, 2]]) {
      const result = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts(badOpts));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("plain object");
    }
  });

  it("rejects unsupported own keys, including symbols and typos", () => {
    for (const unsupported of [{ typo: 1 }, { namespace: "ns", index: 1, extra: 2 }]) {
      const result = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts(unsupported));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("unsupported field");
    }
    const symbolOpts = { namespace: "ns" };
    (symbolOpts as Record<symbol, unknown>)[Symbol("hidden")] = 1;
    const symbolResult = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts(symbolOpts));
    expect(symbolResult.ok).toBe(false);
    if (!symbolResult.ok) expect(symbolResult.error).toContain("unsupported field");
  });

  it("validates namespace against ID_PATTERN and index/attempt as non-negative safe integers", () => {
    const badNamespace = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts({ namespace: "../ns" }));
    expect(badNamespace.ok).toBe(false);
    for (const bad of [-1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY]) {
      const indexRes = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts({ index: bad }));
      if (indexRes.ok) throw new Error(`index ${String(bad)} was accepted`);
      expect(indexRes.error).toContain("non-negative safe integer");
      const attemptRes = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts({ attempt: bad }));
      if (attemptRes.ok) throw new Error(`attempt ${String(bad)} was accepted`);
      expect(attemptRes.error).toContain("non-negative safe integer");
    }
  });

  it("produces a fresh frozen canonical options object with exactly the supplied fields", () => {
    const result = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts({ namespace: "ns", index: 2, attempt: 3 }));
    expect(result).toEqual({ ok: true, value: { namespace: "ns", index: 2, attempt: 3 } });
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value).not.toBe(undefined);

    const partial = parseSaveNodeBoundary("run-1", "n1", rawState, snapshotSaveNodeOpts({ index: 0 }));
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.value).toEqual({ index: 0 });
  });
});

// ---------------------------------------------------------------------------
// load options boundary
// ---------------------------------------------------------------------------

describe("parseLoadOpts — strict runtime parser for the load-options grammar", () => {
  it("returns ok(undefined) for absent options and rejects non-plain objects", () => {
    expect(parseLoadOpts(undefined)).toEqual({ ok: true, value: undefined });
    for (const badOpts of [null, [1], new (class O {})(), "opts"]) {
      const result = parseLoadOpts(badOpts);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("plain object");
    }
  });

  it("rejects unsupported keys (strings and symbols) and closed-field typos", () => {
    for (const unsupported of [{ expectedDagFingerprintX: "fp" }, { expectedFingerprint: "fp" }]) {
      const result = parseLoadOpts(unsupported);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("unsupported field");
    }
    const symbolOpts: Record<PropertyKey, unknown> = {};
    symbolOpts[Symbol("hidden")] = 1;
    const symbolResult = parseLoadOpts(symbolOpts);
    expect(symbolResult.ok).toBe(false);
  });

  it("validates expectedDagFingerprint as a string when present", () => {
    for (const bad of [42, null, {}, []]) {
      const result = parseLoadOpts({ expectedDagFingerprint: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("expectedDagFingerprint must be a string");
    }
  });

  it("returns fresh frozen option objects the caller cannot mutate or re-observe", () => {
    let reads = 0;
    const opts = new Proxy({ expectedDagFingerprint: "fp-1" }, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const result = parseLoadOpts(opts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ expectedDagFingerprint: "fp-1" });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(reads).toBe(1);

    const empty = parseLoadOpts({});
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value).toEqual({});
    expect(Object.isFrozen(empty.value)).toBe(true);
  });
});
