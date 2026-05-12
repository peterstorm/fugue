import { describe, test, expect } from "bun:test";
import { createSpanAttributeRegistry } from "../tracing/span-attribute-registry.js";

/**
 * Wave 1.5 — `SpanAttributeRegistry` is now a factory, not a process-global
 * singleton. Parallel worker runs and concurrent tests must not cross-corrupt
 * one another's state, and a `clear()` on one registry must not evict entries
 * owned by a sibling.
 */
describe("SpanAttributeRegistry isolation (Wave 1.5)", () => {
  test("two registries have independent storage", () => {
    const a = createSpanAttributeRegistry();
    const b = createSpanAttributeRegistry();

    a.set("span-1", { "mlflow.spanInputs": { x: 1 } });
    b.set("span-2", { "mlflow.spanOutputs": { y: 2 } });

    expect(a.get("span-1")).toEqual({ "mlflow.spanInputs": { x: 1 } });
    expect(a.get("span-2")).toBeUndefined();
    expect(b.get("span-1")).toBeUndefined();
    expect(b.get("span-2")).toEqual({ "mlflow.spanOutputs": { y: 2 } });
  });

  test("clear() on one registry does not affect the other", () => {
    const a = createSpanAttributeRegistry();
    const b = createSpanAttributeRegistry();

    a.set("span-1", { tag: "from-a" });
    b.set("span-2", { tag: "from-b" });

    b.clear();
    expect(b.size).toBe(0);
    expect(a.size).toBe(1);
    expect(a.get("span-1")).toEqual({ tag: "from-a" });
  });

  test("pop() removes the entry; size reflects deletion", () => {
    const r = createSpanAttributeRegistry();
    r.set("span-1", { tag: "v1" });
    expect(r.size).toBe(1);

    const popped = r.pop("span-1");
    expect(popped).toEqual({ tag: "v1" });
    expect(r.size).toBe(0);
    expect(r.get("span-1")).toBeUndefined();
  });

  test("set() merges with existing attributes", () => {
    const r = createSpanAttributeRegistry();
    r.set("span-1", { a: 1 });
    r.set("span-1", { b: 2 });
    expect(r.get("span-1")).toEqual({ a: 1, b: 2 });
  });

  test("deleteAll() removes only listed spans", () => {
    const r = createSpanAttributeRegistry();
    r.set("s1", { v: 1 });
    r.set("s2", { v: 2 });
    r.set("s3", { v: 3 });

    r.deleteAll(["s1", "s3"]);
    expect(r.get("s1")).toBeUndefined();
    expect(r.get("s2")).toEqual({ v: 2 });
    expect(r.get("s3")).toBeUndefined();
  });
});
