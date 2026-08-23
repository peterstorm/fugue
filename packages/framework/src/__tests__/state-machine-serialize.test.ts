import { describe, it, expect } from "bun:test";
import {
  serializeValue,
  deserializeValue,
  toJson,
  fromJson,
  validateSerializedValueGrammar,
  MAX_SAFE_RECORD_DEPTH,
} from "../state-machine/serialize.js";

describe("serializeValue / deserializeValue", () => {
  it("round-trips a plain object", () => {
    const val = { a: 1, b: "hello", c: true, d: null };
    expect(deserializeValue(serializeValue(val))).toEqual(val);
  });

  it("round-trips a Map with string keys", () => {
    const m = new Map<string, number>([["x", 1], ["y", 2]]);
    const restored = deserializeValue(serializeValue(m)) as Map<string, number>;
    expect(restored).toBeInstanceOf(Map);
    expect(restored.get("x")).toBe(1);
    expect(restored.get("y")).toBe(2);
    expect(restored.size).toBe(2);
  });

  it("round-trips a Set", () => {
    const s = new Set([1, 2, 3]);
    const restored = deserializeValue(serializeValue(s)) as Set<number>;
    expect(restored).toBeInstanceOf(Set);
    expect(restored.has(1)).toBe(true);
    expect(restored.has(3)).toBe(true);
    expect(restored.size).toBe(3);
  });

  it("round-trips a Map with non-string keys", () => {
    const m = new Map<number, string>([[1, "one"], [2, "two"]]);
    const restored = deserializeValue(serializeValue(m)) as Map<number, string>;
    expect(restored).toBeInstanceOf(Map);
    expect(restored.get(1)).toBe("one");
  });

  it("round-trips a nested structure with Map + Set inside an object", () => {
    const val = {
      counts: new Map([["a", 1], ["b", 2]]),
      seen: new Set(["x", "y"]),
      name: "test",
    };
    const restored = deserializeValue(serializeValue(val)) as typeof val;
    expect(restored.counts).toBeInstanceOf(Map);
    expect(restored.seen).toBeInstanceOf(Set);
    expect(restored.counts.get("a")).toBe(1);
    expect(restored.seen.has("x")).toBe(true);
    expect(restored.name).toBe("test");
  });

  it("round-trips an array of Maps", () => {
    const val = [new Map([["k", "v"]]), new Map([["p", "q"]])];
    const restored = deserializeValue(serializeValue(val)) as Array<Map<string, string>>;
    expect(restored[0]).toBeInstanceOf(Map);
    expect(restored[0].get("k")).toBe("v");
    expect(restored[1].get("p")).toBe("q");
  });

  it("handles undefined and null", () => {
    expect(deserializeValue(serializeValue(null))).toBeNull();
    expect(deserializeValue(serializeValue(undefined))).toBeUndefined();
  });

  it("handles primitives", () => {
    expect(deserializeValue(serializeValue(42))).toBe(42);
    expect(deserializeValue(serializeValue("hello"))).toBe("hello");
    expect(deserializeValue(serializeValue(true))).toBe(true);
  });
});

describe("validateSerializedValueGrammar — options validation", () => {
  // The defensive own-options guards (exported function, in-tree callers
  // pass the shared constants) must stay fail-closed: non-safe-integer or
  // negative depth options are caller bugs, not grammar input.
  for (const badOptions of [
    { maxDepth: Number.NaN, rootPath: "value" },
    { maxDepth: -1, rootPath: "value" },
    { maxDepth: 1.5, rootPath: "value" },
    { maxDepth: Infinity, rootPath: "value" },
    { maxDepth: 512, initialDepth: -1, rootPath: "value" },
    { maxDepth: 512, initialDepth: Number.NaN, rootPath: "value" },
  ]) {
    it(`rejects ${JSON.stringify(Object.keys(badOptions).map((k) => `${k}=${String((badOptions as Record<string, unknown>)[k])}`).join(", "))}`, () => {
      const result = validateSerializedValueGrammar({ a: 1 }, badOptions as never);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/non-negative safe integer/);
      }
    });
  }

  it("accepts safe non-negative depth options and validates the value", () => {
    expect(validateSerializedValueGrammar({ a: 1 }, { maxDepth: 512, rootPath: "value" })).toEqual({ ok: true, value: undefined });
    const bad = validateSerializedValueGrammar(undefined, { maxDepth: 512, rootPath: "value" });
    expect(bad.ok).toBe(false);
  });
});

describe("toJson / fromJson", () => {
  it("round-trips a Map through JSON string", () => {
    const m = new Map([["a", 1], ["b", 2]]);
    const json = toJson(m);
    expect(typeof json).toBe("string");
    const restored = fromJson(json) as Map<string, number>;
    expect(restored).toBeInstanceOf(Map);
    expect(restored.get("a")).toBe(1);
  });

  it("round-trips a Set through JSON string", () => {
    const s = new Set(["alpha", "beta"]);
    const json = toJson(s);
    const restored = fromJson(json) as Set<string>;
    expect(restored).toBeInstanceOf(Set);
    expect(restored.has("alpha")).toBe(true);
    expect(restored.has("beta")).toBe(true);
  });

  it("round-trips a complex state object", () => {
    const state = {
      wave: 2,
      completed: new Set(["node-a", "node-b"]),
      outputs: new Map<string, unknown>([["node-a", { result: 42 }]]),
    };
    const json = toJson(state);
    const restored = fromJson(json) as typeof state;
    expect(restored.wave).toBe(2);
    expect(restored.completed).toBeInstanceOf(Set);
    expect(restored.completed.has("node-a")).toBe(true);
    expect(restored.outputs).toBeInstanceOf(Map);
    expect((restored.outputs.get("node-a") as { result: number }).result).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Depth backstop (SC-1 / type-design-analyzer-4)
//
// `MAX_SAFE_RECORD_DEPTH` is documented as the ceiling of EVERY recursive walk
// in this grammar. `deepJsonEqual`/`validateSerializedValueGrammar` are
// iterative and already enforce it; these pins prove the two RECURSIVE walks
// enforce it too, so the `queue-bullmq/*` call sites — which hand Redis/BullMQ
// payloads straight in with no pre-scan — fail closed with a named error
// instead of blowing the call stack with a raw RangeError.
//
// Counting convention (shared with `validateSerializedValueGrammar`): the walk
// roots at depth 0, a CONTAINER costs a hop, a primitive leaf does not. So a
// chain of `n` nested containers has its deepest container at depth `n - 1`,
// and the ceiling admits chains of `MAX_SAFE_RECORD_DEPTH + 1` containers.
// ---------------------------------------------------------------------------

/** A chain of `containers` nested plain objects; deepest container sits at depth `containers - 1`. */
const nestPlain = (containers: number, leaf: unknown = 1): unknown => {
  let node: unknown = leaf;
  for (let i = 0; i < containers; i++) node = { n: node };
  return node;
};

const ADMITTED = MAX_SAFE_RECORD_DEPTH + 1; // deepest container at exactly the ceiling
const REJECTED = MAX_SAFE_RECORD_DEPTH + 2; // deepest container one hop past it

describe("serializeValue / deserializeValue — depth ceiling backstop", () => {
  it("round-trips a value whose deepest container sits exactly at the ceiling", () => {
    const atCeiling = nestPlain(ADMITTED);
    const wire = serializeValue(atCeiling);
    expect(deserializeValue(wire)).toEqual(atCeiling as object);
  });

  it("agrees with the iterative validator on both sides of the ceiling", () => {
    // The recursive walks and the iterative validator must admit exactly the
    // same set, or a writer could emit a value the strict reader rejects.
    const opts = { rootPath: "v", maxDepth: MAX_SAFE_RECORD_DEPTH } as const;
    expect(validateSerializedValueGrammar(nestPlain(ADMITTED), opts).ok).toBe(true);
    expect(validateSerializedValueGrammar(nestPlain(REJECTED), opts).ok).toBe(false);
    expect(() => serializeValue(nestPlain(ADMITTED))).not.toThrow();
    expect(() => serializeValue(nestPlain(REJECTED))).toThrow();
  });

  it("serializeValue fails closed past the ceiling, naming the walk and depth", () => {
    expect(() => serializeValue(nestPlain(REJECTED))).toThrow(
      new RegExp(
        `serializeValue: value nesting exceeds the safe depth ceiling ${MAX_SAFE_RECORD_DEPTH} \\(depth ${MAX_SAFE_RECORD_DEPTH + 1}\\)`,
      ),
    );
  });

  it("deserializeValue fails closed past the ceiling on a hostile wire value", () => {
    // Built directly as wire bytes — the shape a Redis/BullMQ payload arrives
    // in, where nothing pre-scanned it.
    expect(() => deserializeValue(nestPlain(REJECTED))).toThrow(
      new RegExp(`deserializeValue: value nesting exceeds the safe depth ceiling ${MAX_SAFE_RECORD_DEPTH}`),
    );
  });

  it("counts an array hop exactly like a plain-object hop", () => {
    const nestArray = (containers: number): unknown => {
      let node: unknown = 1;
      for (let i = 0; i < containers; i++) node = [node];
      return node;
    };
    expect(() => serializeValue(nestArray(ADMITTED))).not.toThrow();
    expect(() => serializeValue(nestArray(REJECTED))).toThrow(/exceeds the safe depth ceiling/);
  });

  it("counts a Map value hop and a Set item hop exactly like a plain-object hop", () => {
    const nestMap = (containers: number): unknown => {
      let node: unknown = 1;
      for (let i = 0; i < containers; i++) node = new Map([["k", node]]);
      return node;
    };
    const nestSet = (containers: number): unknown => {
      let node: unknown = 1;
      for (let i = 0; i < containers; i++) node = new Set([node]);
      return node;
    };
    expect(() => serializeValue(nestMap(ADMITTED))).not.toThrow();
    expect(() => serializeValue(nestMap(REJECTED))).toThrow(/exceeds the safe depth ceiling/);
    expect(() => serializeValue(nestSet(ADMITTED))).not.toThrow();
    expect(() => serializeValue(nestSet(REJECTED))).toThrow(/exceeds the safe depth ceiling/);
  });

  it("toJson inherits the backstop rather than overflowing the stack", () => {
    expect(() => toJson(nestPlain(REJECTED))).toThrow(/exceeds the safe depth ceiling/);
  });
});
