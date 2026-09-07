// F1 PR-B — the map width value type and its parser (D2, FR-F1-002..005).
//
// The width comes off an upstream node's output, so it is untrusted data on
// the path that decides how much money a fan is allowed to spend. These tests
// are organised around the three legal arms and the boundary between them,
// because the failure that matters here is not a crash — it is a wrong width
// that succeeds.

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { N } from "./_id-helpers.js";
import {
  asMaxWidth,
  asWidthFrom,
  maxWidth,
  resolveMappedItems,
  widthFrom,
  type MaxWidth,
  type WidthFrom,
} from "../types/map-width.js";

const NODE = N("fan");
const FROM = widthFrom("items");
const MAX = maxWidth(25);

describe("maxWidth — author-declared bound (FR-F1-002)", () => {
  it("accepts a positive safe integer", () => {
    // Compared as plain numbers: `toBe` infers the branded type from its
    // receiver, and the assertion here is about the VALUE surviving the
    // constructor unchanged, not about the brand (which `branding` below owns).
    expect(maxWidth(1) as number).toBe(1);
    expect(maxWidth(25) as number).toBe(25);
    expect(maxWidth(Number.MAX_SAFE_INTEGER) as number).toBe(Number.MAX_SAFE_INTEGER);
  });

  // Zero is rejected HERE but legal as a resolved width — the two numbers are
  // different facts and the asymmetry is deliberate (see the type's docs).
  const rejected: readonly (readonly [string, number])[] = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond the safe-integer range", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, bad] of rejected) {
    it(`rejects ${label} at module load`, () => {
      expect(asMaxWidth(bad)).toBeUndefined();
      expect(() => maxWidth(bad)).toThrow("positive safe integer");
    });
  }

  it("rejects a non-number smuggled past the type without coercing it", () => {
    // `"5" > 0` is true under coercion, so a guard that led with the
    // comparison would admit a string as a width bound.
    expect(asMaxWidth("5" as unknown as number)).toBeUndefined();
    expect(asMaxWidth(null as unknown as number)).toBeUndefined();
    // A hostile valueOf must not be consulted at all — the message names the
    // rule, never the hostile's own text.
    const hostile = { valueOf: () => { throw new Error("exploded"); } } as unknown as number;
    expect(asMaxWidth(hostile)).toBeUndefined();
    expect(() => maxWidth(hostile)).toThrow("positive safe integer");
    try {
      maxWidth(hostile);
    } catch (error) {
      expect((error as Error).message).not.toContain("exploded");
    }
  });
});

describe("widthFrom — the field reference (design constraint 4)", () => {
  it("accepts a JS identifier", () => {
    expect(widthFrom("items") as string).toBe("items");
    expect(widthFrom("_private$1") as string).toBe("_private$1");
  });

  // Not a path language: a dotted reference is rejected rather than quietly
  // read as a single weird key, so the authored surface cannot drift into an
  // expression evaluator one release at a time.
  const rejected = ["", "a.b", "a b", "1abc", "items[0]", "a-b", "__proto__"];
  for (const bad of rejected) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(asWidthFrom(bad)).toBeUndefined();
      expect(() => widthFrom(bad)).toThrow("field reference");
    });
  }

  it("rejects __proto__ specifically, because reading it would not be a data field", () => {
    // Not merely "an unusual name": `({}).__proto__` reaches the prototype
    // setter, so a map keyed on it would fan over something that was never in
    // the upstream output.
    expect(asWidthFrom("__proto__")).toBeUndefined();
  });
});

describe("resolveMappedItems — the three arms (FR-F1-003/004/005)", () => {
  it("returns the items when the field is an array within bound", () => {
    const result = resolveMappedItems(NODE, { items: ["a", "b", "c"] }, FROM, MAX);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a width");
    expect(result.value.items).toEqual(["a", "b", "c"]);
    expect(result.value.width).toBe(3);
  });

  // FR-F1-004. The arm most at risk of being "corrected" into an error by
  // someone reading the other two.
  it("a width of 0 SUCCEEDS with an empty fan — it is not an error", () => {
    const result = resolveMappedItems(NODE, { items: [] }, FROM, MAX);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected zero width to be legal");
    expect(result.value.items).toEqual([]);
    expect(result.value.width).toBe(0);
  });

  // FR-F1-003 — the boundary table the plan asks for: 0, 1, maxWidth, maxWidth+1.
  const at = (n: number): { readonly items: readonly number[] } => ({
    items: Array.from({ length: n }, (_, i) => i),
  });
  for (const width of [0, 1, 25]) {
    it(`admits a width of exactly ${width} against maxWidth 25`, () => {
      const result = resolveMappedItems(NODE, at(width), FROM, MAX);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.width).toBe(width);
    });
  }

  it("refuses maxWidth + 1, naming BOTH numbers structurally", () => {
    const result = resolveMappedItems(NODE, at(26), FROM, MAX);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an over-width refusal");
    expect(result.error.kind).toBe("map-width-exceeded");
    if (result.error.kind === "map-width-exceeded") {
      // Structurally, not only in the message: the operator's next action
      // differs for 26-against-25 (raise the limit) versus 40000-against-25
      // (upstream data went wrong).
      expect(result.error.resolvedWidth).toBe(26);
      expect(result.error.maxWidth).toBe(25);
      expect(result.error.nodeId).toBe(NODE);
    }
  });

  it("NEVER truncates an over-wide fan", () => {
    // The whole point of the fail-closed arm. A truncated fan produces a
    // plausible, wrong, cheaper answer that nothing downstream can distinguish
    // from a correct one — so the refusal must carry no items at all.
    const result = resolveMappedItems(NODE, at(1000), FROM, MAX);
    expect(result.ok).toBe(false);
    expect(Object.values(result as object).some((v) => Array.isArray(v))).toBe(false);
  });

  // FR-F1-005.
  const notArrays: readonly (readonly [string, unknown])[] = [
    ["a string", "abc"],
    ["a number", 3],
    ["null", null],
    ["undefined (absent field)", undefined],
    ["an object", { length: 3 }],
    ["a Set", new Set([1, 2, 3])],
  ];
  for (const [label, value] of notArrays) {
    it(`refuses a widthFrom resolving to ${label}`, () => {
      const result = resolveMappedItems(NODE, { items: value }, FROM, MAX);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a typed refusal");
      expect(result.error.kind).toBe("map-width-invalid");
      if (result.error.kind === "map-width-invalid") {
        expect(result.error.widthFrom).toBe("items");
        expect(result.error.nodeId).toBe(NODE);
      }
    });
  }

  // An array-LIKE is the near-miss that a `.length` check would have admitted.
  it("refuses an array-like, which a length check would have accepted", () => {
    const result = resolveMappedItems(NODE, { items: { 0: "a", 1: "b", length: 2 } }, FROM, MAX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("map-width-invalid");
  });

  for (const [label, upstream] of [
    ["a non-object upstream", "not an object"],
    ["a null upstream", null],
    ["an undefined upstream", undefined],
  ] as const) {
    it(`refuses ${label} rather than throwing`, () => {
      const result = resolveMappedItems(NODE, upstream, FROM, MAX);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("map-width-invalid");
    });
  }

  it("converts a throwing getter on the upstream output into a typed refusal", () => {
    // This runs inside a node's `run`, whose contract is
    // `Result<_, FrameworkError>` — a raw throw here would escape as a node
    // crash and be attributed to the wrong thing.
    const upstream = {
      get items(): unknown {
        throw new Error("hostile getter exploded");
      },
    };
    const result = resolveMappedItems(NODE, upstream, FROM, MAX);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("map-width-invalid");
      if (result.error.kind === "map-width-invalid") {
        expect(result.error.found).toContain("threw");
      }
    }
  });

  it("reads a null-prototype upstream object without throwing", () => {
    const upstream = Object.assign(Object.create(null) as object, { items: [1, 2] });
    const result = resolveMappedItems(NODE, upstream, FROM, MAX);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.width).toBe(2);
  });

  it("copies the items, so a later mutation of the upstream cannot change the fan mid-flight", () => {
    // The fan's width and its items must be the same facts at index 0 and at
    // index N-1; aliasing the caller's array would let an upstream mutation
    // desynchronise them.
    const items = ["a", "b"];
    const result = resolveMappedItems(NODE, { items }, FROM, MAX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    items.push("c");
    expect(result.value.items).toEqual(["a", "b"]);
    expect(result.value.width).toBe(2);
  });
});

describe("resolveMappedItems — properties", () => {
  it("width always equals items.length on every success", () => {
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 25 }), (items) => {
        const result = resolveMappedItems(NODE, { items }, FROM, MAX);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.width).toBe(result.value.items.length);
      }),
      { numRuns: 300 },
    );
  });

  it("admits exactly the arrays within bound and refuses exactly those beyond it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 0, max: 60 }),
        (bound, length) => {
          const max = maxWidth(bound);
          const items = Array.from({ length }, (_, i) => i);
          const result = resolveMappedItems(NODE, { items }, FROM, max);
          // One rule, both directions: nothing in the admitted set exceeds the
          // bound and nothing beyond the bound is admitted.
          expect(result.ok).toBe(length <= bound);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never returns items the caller did not supply", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 25 }), (items) => {
        const result = resolveMappedItems(NODE, { items }, FROM, MAX);
        if (result.ok) expect(result.value.items).toEqual(items);
      }),
      { numRuns: 300 },
    );
  });
});

// A branded value is only worth having if a bare one cannot reach the parser.
describe("branding", () => {
  it("rejects a bare string / bare number at the type level", () => {
    // @ts-expect-error — a bare string is not a WidthFrom; the identifier rule
    // is enforced once, at construction, not at each read.
    const bad: WidthFrom = "items";
    // @ts-expect-error — a bare number is not a MaxWidth.
    const badMax: MaxWidth = 25;
    expect(typeof bad).toBe("string");
    expect(typeof badMax).toBe("number");
  });
});
