/**
 * The shared own-data boundary defence (`types/own-data.ts`).
 *
 * This algorithm was hand-rolled five times before round 14; these tests are
 * why consolidating it is worth doing. Each former call site kept only
 * field-level validation and its own wording, so the hostile-input surface —
 * getters, revoked Proxies, prototype-chain properties, sparse and decorated
 * arrays — is proven ONCE here, with properties, instead of by example in
 * three places that could each miss a different case.
 *
 * The invariant every caller depends on: a value crossing an extension
 * boundary is read through property DESCRIPTORS, so nothing this process later
 * uses can differ from what it validated, and no hostile value can turn a
 * parse into a throw.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import {
  hasExactOwnKeys,
  isObjectLike,
  ownDataValue,
  ownDescriptors,
  readOptionalOwnDataProperty,
  readOwnDataProperty,
  snapshotOwnDataArray,
  snapshotOwnDataObject,
} from "../types/own-data.js";

/** A value whose every read throws — the worst case each function must survive. */
const revoked = (): unknown => {
  const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
  revoke();
  return proxy;
};

describe("isObjectLike", () => {
  it("accepts objects, arrays and callables, rejects primitives and null", () => {
    for (const value of [{}, [], new Map(), () => {}, class {}]) {
      expect(isObjectLike(value)).toBe(true);
    }
    for (const value of [null, undefined, 1, "s", true, Symbol("s"), 1n]) {
      expect(isObjectLike(value)).toBe(false);
    }
  });

  it("accepts callables — a client object is a valid boundary value", () => {
    // Refusing functions here would reject legitimate LLM/broker clients.
    const callable = Object.assign(() => {}, { kind: "request" });
    expect(isObjectLike(callable)).toBe(true);
    expect(readOwnDataProperty(callable, "kind")).toEqual({ value: "request" });
  });
});

describe("readOwnDataProperty", () => {
  it("reads an own data property", () => {
    expect(readOwnDataProperty({ a: 1 }, "a")).toEqual({ value: 1 });
  });

  it("returns the value even when it is undefined, distinguishing it from absence", () => {
    // `{ a: undefined }` HAS the property; `{}` does not. A caller that
    // required a key must be able to tell those apart.
    expect(readOwnDataProperty({ a: undefined }, "a")).toEqual({ value: undefined });
    expect(readOwnDataProperty({}, "a")).toBeUndefined();
  });

  it("refuses a getter without ever invoking it", () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "a", {
      enumerable: true,
      get: () => { reads += 1; return 1; },
    });

    expect(readOwnDataProperty(hostile, "a")).toBeUndefined();
    // The point of descriptor reads: a value that changes per read, or throws,
    // never gets the chance.
    expect(reads).toBe(0);
  });

  it("refuses an inherited property", () => {
    const child = Object.create({ inherited: 1 }) as object;
    expect(readOwnDataProperty(child, "inherited")).toBeUndefined();
  });

  it("refuses prototype-chain names that look present", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(readOwnDataProperty({}, key)).toBeUndefined();
    }
  });

  it("reads symbol keys as own data too", () => {
    const key = Symbol("k");
    expect(readOwnDataProperty({ [key]: 7 }, key)).toEqual({ value: 7 });
  });

  it("agrees with ownDataValue on every input", () => {
    fc.assert(
      fc.property(fc.object(), fc.string(), (object, key) => {
        const read = readOwnDataProperty(object, key);
        const result = ownDataValue(object, key);
        expect(result.ok).toBe(read !== undefined);
        if (result.ok && read !== undefined) expect(result.value).toBe(read.value);
      }),
    );
  });
});

describe("ownDescriptors", () => {
  it("rejects non-objects as not-an-object", () => {
    for (const value of [null, undefined, 1, "s", true]) {
      const result = ownDescriptors(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not-an-object");
    }
  });

  it("reports a revoked Proxy as uninspectable rather than throwing", () => {
    const result = ownDescriptors(revoked());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("uninspectable");
  });

  it("never throws, for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => ownDescriptors(value)).not.toThrow();
      }),
    );
  });
});

describe("hasExactOwnKeys", () => {
  it("requires the key set to match exactly — no extras, no absences", () => {
    const descriptors = Object.getOwnPropertyDescriptors({ kind: "fixed", model: "m" });
    expect(hasExactOwnKeys(descriptors, ["kind", "model"])).toBe(true);
    expect(hasExactOwnKeys(descriptors, ["model", "kind"])).toBe(true); // order-free
    expect(hasExactOwnKeys(descriptors, ["kind"])).toBe(false);
    expect(hasExactOwnKeys(descriptors, ["kind", "model", "extra"])).toBe(false);
  });

  it("refuses a symbol-keyed extra that a string-only check would miss", () => {
    // An extra symbol key is still an extra key: it could carry a payload the
    // exact-shape check exists to reject.
    const descriptors = Object.getOwnPropertyDescriptors({ kind: "request", [Symbol("x")]: 1 });
    expect(hasExactOwnKeys(descriptors, ["kind"])).toBe(false);
  });
});

describe("snapshotOwnDataObject", () => {
  it("copies own data properties into a frozen, null-prototype snapshot", () => {
    const result = snapshotOwnDataObject({ a: 1, b: "two" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(result.value["a"]).toBe(1);
    expect(result.value["b"]).toBe("two");
  });

  it("isolates the snapshot from later mutation of the source", () => {
    // The whole reason to copy: the author cannot change the value under us
    // between validation and use.
    const source: Record<string, unknown> = { a: 1 };
    const result = snapshotOwnDataObject(source);
    source["a"] = 999;
    source["added"] = true;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value["a"]).toBe(1);
      expect("added" in result.value).toBe(false);
    }
  });

  it("rejects an object carrying any accessor, naming the offending key", () => {
    let reads = 0;
    const hostile = Object.defineProperty({ safe: 1 }, "hostile", {
      enumerable: true,
      get: () => { reads += 1; return 1; },
    });

    const result = snapshotOwnDataObject(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "not-own-data") {
      expect(result.error.key).toBe("hostile");
    }
    expect(reads).toBe(0);
  });

  it("rejects a revoked Proxy rather than throwing", () => {
    const result = snapshotOwnDataObject(revoked());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("uninspectable");
  });

  it("never throws and never returns a mutable value, for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = snapshotOwnDataObject(value);
        if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
      }),
    );
  });

  it("round-trips any plain object's own enumerable data", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (source) => {
        const result = snapshotOwnDataObject(source);
        expect(result.ok).toBe(true);
        if (result.ok) {
          for (const [key, value] of Object.entries(source)) {
            expect(result.value[key]).toBe(value);
          }
        }
      }),
    );
  });
});

describe("snapshotOwnDataArray", () => {
  it("snapshots a dense array", () => {
    const result = snapshotOwnDataArray([1, "two", null]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.value]).toEqual([1, "two", null]);
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it("accepts an empty array by default and refuses one under a minimum", () => {
    // The one axis call sites disagree on: a tools array may be empty, an
    // unpriced model list may not.
    expect(snapshotOwnDataArray([]).ok).toBe(true);
    const tooShort = snapshotOwnDataArray([], 1);
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok && tooShort.error.kind === "too-short") {
      expect(tooShort.error.length).toBe(0);
    }
  });

  it("rejects a non-array", () => {
    for (const value of [{}, "ab", 1, null, { length: 2, 0: "a", 1: "b" }]) {
      const result = snapshotOwnDataArray(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not-an-array");
    }
  });

  it("rejects a sparse array — a hole is not an own data property", () => {
    const sparse = [1, , 3] as unknown[]; // eslint-disable-line no-sparse-arrays
    const result = snapshotOwnDataArray(sparse);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not-dense");
  });

  it("rejects an array decorated with an extra own key", () => {
    const decorated = Object.assign([1, 2], { extra: "payload" });
    const result = snapshotOwnDataArray(decorated);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not-dense");
  });

  it("rejects an accessor-backed index without invoking it", () => {
    let reads = 0;
    const hostile: unknown[] = [1];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      configurable: true,
      get: () => { reads += 1; return 1; },
    });

    const result = snapshotOwnDataArray(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not-own-data");
    expect(reads).toBe(0);
  });

  it("rejects an array reporting a nonsensical length", () => {
    // A real array's `length` is non-configurable, so it cannot BE an accessor
    // — but a Proxy over one can report whatever descriptor it likes, and
    // `Array.isArray` still says true. `length` is writable, so reporting a
    // different value satisfies the Proxy invariants and reaches the parser.
    for (const reported of [-1, 1.5, Number.NaN, "2"]) {
      const hostile = new Proxy([] as unknown[], {
        getOwnPropertyDescriptor: (target, key) =>
          key === "length"
            ? { value: reported, writable: true, enumerable: false, configurable: false }
            : Object.getOwnPropertyDescriptor(target, key),
      });

      const result = snapshotOwnDataArray(hostile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("bad-length");
    }
  });

  it("rejects a revoked Proxy rather than throwing — Array.isArray itself throws on one", () => {
    // The first question asked of the value is already a hazard; this is the
    // regression that surfaced when the algorithm was first extracted.
    const result = snapshotOwnDataArray(revoked());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("uninspectable");
  });

  it("never throws, for any input", () => {
    fc.assert(
      fc.property(fc.anything(), fc.nat({ max: 4 }), (value, minLength) => {
        expect(() => snapshotOwnDataArray(value, minLength)).not.toThrow();
      }),
    );
  });

  it("accepts exactly the dense arrays meeting the minimum, and copies them faithfully", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 8 }), fc.nat({ max: 4 }), (source, min) => {
        const result = snapshotOwnDataArray(source, min);
        expect(result.ok).toBe(source.length >= min);
        if (result.ok) expect([...result.value]).toEqual(source);
      }),
    );
  });

  it("isolates the snapshot from later mutation of the source", () => {
    const source = [1, 2];
    const result = snapshotOwnDataArray(source);
    source.push(3);
    source[0] = 99;

    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.value]).toEqual([1, 2]);
  });
});

describe("readOptionalOwnDataProperty", () => {
  // The reason this primitive exists: `readOwnDataProperty` answers `undefined`
  // for BOTH "absent" and "accessor", which is the right verdict for a required
  // field and the wrong one for an optional field, where absent is valid and an
  // accessor must be refused. `run-spend-authority.ts`'s optional `thinking`
  // field is the call site that needs the split.
  it("reports an absent key as absent", () => {
    expect(readOptionalOwnDataProperty({}, "thinking")).toEqual({ kind: "absent" });
  });

  it("reports an own data property as data, carrying the value", () => {
    expect(readOptionalOwnDataProperty({ thinking: "why" }, "thinking")).toEqual({
      kind: "data",
      value: "why",
    });
  });

  it("reports an own data property holding undefined as data, NOT absent", () => {
    // The distinction matters: `{ thinking: undefined }` is a key the author
    // supplied as data, and collapsing it to `absent` would be the same
    // information loss this primitive exists to avoid.
    expect(readOptionalOwnDataProperty({ thinking: undefined }, "thinking")).toEqual({
      kind: "data",
      value: undefined,
    });
  });

  it("reports a getter-backed key as accessor, never as absent", () => {
    const hostile = Object.defineProperty({}, "thinking", {
      get: () => "attacker-controlled",
      configurable: true,
      enumerable: true,
    });
    expect(readOptionalOwnDataProperty(hostile, "thinking")).toEqual({ kind: "accessor" });
  });

  it("reports a setter-only key as accessor", () => {
    const hostile = Object.defineProperty({}, "thinking", {
      set: () => {},
      configurable: true,
      enumerable: true,
    });
    expect(readOptionalOwnDataProperty(hostile, "thinking")).toEqual({ kind: "accessor" });
  });

  it("reports an inherited data property as absent — only OWN properties count", () => {
    const inherited = Object.create({ thinking: "from-prototype" }) as object;
    expect(readOptionalOwnDataProperty(inherited, "thinking")).toEqual({ kind: "absent" });
  });

  it("agrees with readOwnDataProperty on every value, modulo the split it preserves", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const holder = { field: value };
        const required = readOwnDataProperty(holder, "field");
        const optional = readOptionalOwnDataProperty(holder, "field");
        // For a plain data property the two agree on the value...
        expect(optional).toEqual({ kind: "data", value });
        expect(required).toEqual({ value });
        // ...and `absent`/`accessor` are exactly the cases the required form
        // collapses to `undefined`.
        expect(readOwnDataProperty({}, "field")).toBeUndefined();
        expect(readOptionalOwnDataProperty({}, "field")).toEqual({ kind: "absent" });
      }),
    );
  });
});
