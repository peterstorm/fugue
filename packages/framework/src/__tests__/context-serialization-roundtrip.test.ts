/**
 * Property test: toJson/fromJson roundtrip preserves Map, Set, Date, and
 * undefined values — the building blocks of DagMachineContextPersisted.
 *
 * The serialize module uses tagged sentinel objects (__map__, __set__,
 * __date__, __undefined__) to encode non-JSON-native types. This property
 * test ensures the roundtrip is lossless for arbitrary nesting depths and
 * edge-case values.
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { toJson, fromJson } from "../state-machine/serialize.js";
import { parsePersistedDagContext } from "../dag-runtime/persistence.js";
import { N } from "./_id-helpers.js";
import type { DagMachineContextPersisted } from "../dag-runtime/types.js";
import type { NodeId } from "../types/ids.js";
import { freshnessExecutionEpoch, resourceName, witness } from "../types/witness.js";

// ---------------------------------------------------------------------------
// Arbitraries for serializable primitives and containers
// ---------------------------------------------------------------------------

/** Arbitrary JSON-safe primitive value. */
const jsonPrimitive = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);

/** Arbitrary value that exercises all serialize paths (recursive). */
const serializableValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    jsonPrimitive,
    fc.date({ noInvalidDate: true }),
    fc.constant(undefined),
    fc.array(tie("value"), { maxLength: 5 }),
    fc.dictionary(fc.string({ maxLength: 8 }), tie("value"), { maxKeys: 5 }),
    // Map with string keys
    fc.array(fc.tuple(fc.string({ maxLength: 8 }), tie("value")), { maxLength: 5 })
      .map((entries) => new Map(entries)),
    // Set of primitives
    fc.array(jsonPrimitive, { maxLength: 5 })
      .map((items) => new Set(items)),
  ),
})).value;

// ---------------------------------------------------------------------------
// Roundtrip property: fromJson(toJson(x)) ≡ x
// ---------------------------------------------------------------------------

/** Deep equality that handles Map, Set, Date, and undefined correctly. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return a === b;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    // Set equality for primitives
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
  }

  return false;
}

describe("toJson/fromJson roundtrip property", () => {
  it("preserves arbitrary serializable values", () => {
    fc.assert(
      fc.property(serializableValue, (value) => {
        const json = toJson(value);
        const restored = fromJson(json);
        expect(deepEqual(value, restored)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("preserves Map<NodeId, unknown> — the DagMachineContextPersisted.outputs shape", () => {
    const nodeIdMapArb = fc.array(
      fc.tuple(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
        fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.boolean()),
      ),
      { maxLength: 10 },
    ).map((entries) => new Map(entries.map(([k, v]) => [N(k), v])));

    fc.assert(
      fc.property(nodeIdMapArb, (map) => {
        const json = toJson(map);
        const restored = fromJson(json) as Map<NodeId, unknown>;
        expect(restored).toBeInstanceOf(Map);
        expect(restored.size).toBe(map.size);
        for (const [k, v] of map) {
          expect(restored.get(k)).toEqual(v);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("preserves Set<NodeId> — the DagMachineContextPersisted.activeNodeIds shape", () => {
    const nodeIdSetArb = fc.array(
      fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
      { maxLength: 10 },
    ).map((ids) => new Set(ids.map(N)));

    fc.assert(
      fc.property(nodeIdSetArb, (set) => {
        const json = toJson(set);
        const restored = fromJson(json) as Set<NodeId>;
        expect(restored).toBeInstanceOf(Set);
        expect(restored.size).toBe(set.size);
        for (const id of set) {
          expect(restored.has(id)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("preserves nested Map<NodeId, Map<string, Date>> — deep nesting", () => {
    const nestedArb = fc.array(
      fc.tuple(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/),
        fc.array(
          fc.tuple(fc.string({ maxLength: 6 }), fc.date({ noInvalidDate: true })),
          { maxLength: 3 },
        ).map((entries) => new Map(entries)),
      ),
      { maxLength: 5 },
    ).map((entries) => new Map(entries.map(([k, v]) => [N(k), v])));

    fc.assert(
      fc.property(nestedArb, (map) => {
        const json = toJson(map);
        const restored = fromJson(json) as Map<NodeId, Map<string, Date>>;
        expect(restored).toBeInstanceOf(Map);
        expect(restored.size).toBe(map.size);
        for (const [k, innerMap] of map) {
          const restoredInner = restored.get(k);
          expect(restoredInner).toBeInstanceOf(Map);
          expect(restoredInner!.size).toBe(innerMap.size);
          for (const [ik, date] of innerMap) {
            expect((restoredInner!.get(ik) as Date).getTime()).toBe(date.getTime());
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("handles empty containers", () => {
    const emptyMap = new Map();
    const emptySet = new Set();
    const emptyObj = {};
    const emptyArr: unknown[] = [];

    for (const value of [emptyMap, emptySet, emptyObj, emptyArr]) {
      const json = toJson(value);
      const restored = fromJson(json);
      expect(deepEqual(value, restored)).toBe(true);
    }
  });

  it("preserves undefined in Map values (explicit undefined stored as sentinel)", () => {
    const map = new Map<string, unknown>([
      ["a", undefined],
      ["b", null],
      ["c", 42],
    ]);
    const json = toJson(map);
    const restored = fromJson(json) as Map<string, unknown>;
    expect(restored.get("a")).toBe(undefined);
    expect(restored.has("a")).toBe(true);
    expect(restored.get("b")).toBe(null);
    expect(restored.get("c")).toBe(42);
  });
});

const CONTEXT_NODE = N("context-node");
const VALID_PERSISTED_CONTEXT: DagMachineContextPersisted = {
  waves: [[CONTEXT_NODE]],
  edges: [{ from: CONTEXT_NODE, to: CONTEXT_NODE, kind: "conditional" }],
  unconditionalAdj: new Map([[CONTEXT_NODE, []]]),
  outputNodeId: CONTEXT_NODE,
  retries: new Map([[CONTEXT_NODE, 0]]),
  retryConfigs: new Map([[
    CONTEXT_NODE,
    { backoffMs: [100, 200], jitterRatio: 0.1 },
  ]]),
  defaultRetryLimit: 1,
  retryLimits: { [CONTEXT_NODE]: 2 },
  humanReviewNodeIds: new Set([CONTEXT_NODE]),
  humanReviewPrompts: new Map([[CONTEXT_NODE, "Approve?"]]),
  activeNodeIds: new Set([CONTEXT_NODE]),
  confidenceByNode: new Map([[CONTEXT_NODE, null]]),
  outputs: new Map([[CONTEXT_NODE, { answer: 42 }]]),
  initialInput: { request: true },
  priorWitnesses: new Map([[
    "postgres:orders",
    witness("version", resourceName("postgres:orders"), "42"),
  ]]),
  freshnessCompletedNodeIds: new Set([CONTEXT_NODE]),
  freshnessExecutionEpoch: freshnessExecutionEpoch(3),
};

const REQUIRED_CONTEXT_FIELDS = [
  "waves",
  "edges",
  "unconditionalAdj",
  "outputNodeId",
  "retries",
  "retryConfigs",
  "defaultRetryLimit",
  "retryLimits",
  "humanReviewNodeIds",
  "humanReviewPrompts",
  "activeNodeIds",
  "confidenceByNode",
  "outputs",
  "initialInput",
  "priorWitnesses",
  "freshnessCompletedNodeIds",
  "freshnessExecutionEpoch",
] as const satisfies readonly (keyof DagMachineContextPersisted)[];

describe("parsePersistedDagContext", () => {
  it("parses a canonical serialization round-trip and preserves the fingerprint", () => {
    const fingerprint = "a".repeat(64);
    const restored = fromJson(toJson({
      ...VALID_PERSISTED_CONTEXT,
      __dagFingerprint: fingerprint,
    }));

    const parsed = parsePersistedDagContext(restored);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(toJson(parsed.value)).toBe(toJson({
        ...VALID_PERSISTED_CONTEXT,
        __dagFingerprint: fingerprint,
      }));
      expect(parsed.value.__dagFingerprint).toBe(fingerprint);
      expect("when" in parsed.value.edges[0]!).toBe(false);
    }
  });

  it("property: removing any required field is always rejected", () => {
    fc.assert(fc.property(fc.constantFrom(...REQUIRED_CONTEXT_FIELDS), (field) => {
      const candidate: Record<string, unknown> = { ...VALID_PERSISTED_CONTEXT };
      delete candidate[field];
      expect(parsePersistedDagContext(candidate).ok).toBe(false);
    }));
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed freshness execution epoch %s",
    (freshnessExecutionEpoch) => {
      const parsed = parsePersistedDagContext({
        ...VALID_PERSISTED_CONTEXT,
        freshnessExecutionEpoch,
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("context.freshnessExecutionEpoch");
    },
  );

  it("rejects a prior-witness map whose resource key disagrees with its witness", () => {
    const candidate = {
      ...VALID_PERSISTED_CONTEXT,
      priorWitnesses: new Map([[
        "postgres:orders",
        witness("version", resourceName("postgres:customers"), "42"),
      ]]),
    };
    const parsed = parsePersistedDagContext(candidate);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("must match its map key");
  });
});
