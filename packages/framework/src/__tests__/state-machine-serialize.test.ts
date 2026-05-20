import { describe, it, expect } from "bun:test";
import { serializeValue, deserializeValue, toJson, fromJson } from "../state-machine/serialize.js";

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
