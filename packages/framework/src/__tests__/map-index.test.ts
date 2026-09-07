// F1 PR-B — the `MapIndex` brand.
//
// Its two sibling brands in this feature (`WidthFrom`, `MaxWidth`) get
// exhaustive rejection tables in `map-width.test.ts`; this one had none,
// exercised only through the fan driver's own loop counter, which can never
// produce an invalid value. An untested guard is not evidence for the failure
// mode its doc comment claims ("an index that silently re-executes forever"),
// so it gets the same table as its siblings.

import { describe, it, expect } from "bun:test";
import { asMapIndex, mapIndex, type MapIndex } from "../types/map-index.js";

describe("mapIndex — the durable fan address component", () => {
  it("accepts a non-negative safe integer", () => {
    // Zero is legal here and NOT the canonical address: index 0 is a real fan
    // position, which is what stops a one-wide fan from overwriting the node's
    // own canonical checkpoint.
    expect(mapIndex(0) as number).toBe(0);
    expect(mapIndex(1) as number).toBe(1);
    expect(mapIndex(Number.MAX_SAFE_INTEGER) as number).toBe(Number.MAX_SAFE_INTEGER);
  });

  const rejected: readonly (readonly [string, number])[] = [
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond the safe-integer range", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, bad] of rejected) {
    it(`rejects ${label}`, () => {
      // Each of these would mint a durable address no resume could ever match,
      // so the entry is written and then never found again.
      expect(asMapIndex(bad)).toBeUndefined();
      expect(() => mapIndex(bad)).toThrow("non-negative safe integer");
    });
  }

  it("rejects a non-number smuggled past the type without coercing it", () => {
    // `"3" >= 0` is true under coercion, so a guard leading with the comparison
    // would admit a string as a durable address component.
    expect(asMapIndex("3" as unknown as number)).toBeUndefined();
    expect(asMapIndex(null as unknown as number)).toBeUndefined();
    const hostile = { valueOf: () => { throw new Error("exploded"); } } as unknown as number;
    expect(asMapIndex(hostile)).toBeUndefined();
    expect(() => mapIndex(hostile)).toThrow("non-negative safe integer");
    try {
      mapIndex(hostile);
    } catch (error) {
      // The codec names its own rule, never the hostile value's error text.
      expect((error as Error).message).not.toContain("exploded");
    }
  });

  it("rejects a bare number at the type level", () => {
    // @ts-expect-error — a bare number is not a MapIndex; the guard runs once,
    // at construction, not at each key builder.
    const bad: MapIndex = 3;
    expect(typeof bad).toBe("number");
  });
});
