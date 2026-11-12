/**
 * Refusal-seed ceiling evaluation (AD-11, FR-017, FR-026).
 *
 * Pins `ceilingsOfRemaining` (every budgeted ceiling of a headroom snapshot,
 * in its order) and `ceilingsRaised` — true iff the run became unbudgeted, a
 * seeded axis disappeared, or some seeded axis's limit went UP; lowered or
 * equal limits keep the refusal sticky.
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { ceilingsOfRemaining, ceilingsRaised } from "../seed.js";
import { remainingFor, type Remaining } from "../../../types/budget-capability.js";
import { ceilings, type Ceiling, type CeilingKind } from "../../../types/budget.js";
import { makeSpend, microUsd, NO_SPEND, unpricedModel, type Spend } from "../../../types/spend.js";

const RUNS = { numRuns: 1_000 } as const;

const ceiling = (kind: CeilingKind, limit: number): Ceiling =>
  kind === "usd" ? { kind, limit: microUsd(limit) } : { kind, limit };
const current = (cs: readonly Ceiling[], spend: Spend = NO_SPEND): Remaining => remainingFor(ceilings(cs), spend);

const unpricedSpend = makeSpend({
  usage: "known", tokens: 5, calls: 1, usd: { kind: "unpriced", models: unpricedModel("m"), knownMicros: microUsd(3) },
});
const unknownSpend = makeSpend({ usage: "unknown", tokens: 5, calls: 1, usd: { kind: "priced", micros: microUsd(3) } });
const spendArb = fc.constantFrom(NO_SPEND, unpricedSpend, unknownSpend);

describe("ceilingsOfRemaining", () => {
  it("has no ceilings when unbudgeted", () => {
    expect(ceilingsOfRemaining({ kind: "unbudgeted" })).toEqual([]);
  });

  it("lists every budgeted ceiling in headroom order, whatever the headroom kind", () => {
    const cs = [ceiling("tokens", 100), ceiling("usd", 50), ceiling("calls", 3)];
    for (const spend of [NO_SPEND, unpricedSpend, unknownSpend]) {
      expect(ceilingsOfRemaining(current(cs, spend))).toEqual([ceiling("usd", 50), ceiling("tokens", 100), ceiling("calls", 3)]);
    }
  });
});

describe("ceilingsRaised — table (AD-11)", () => {
  const seeded = [ceiling("usd", 1_000), ceiling("tokens", 500)];

  it("is true when one axis is raised", () => {
    expect(ceilingsRaised(seeded, current([ceiling("usd", 1_001), ceiling("tokens", 500)]))).toBe(true);
  });

  it("is false when every axis is lowered", () => {
    expect(ceilingsRaised(seeded, current([ceiling("usd", 999), ceiling("tokens", 1)]))).toBe(false);
  });

  it("is false when every axis is equal", () => {
    expect(ceilingsRaised(seeded, current(seeded))).toBe(false);
  });

  it("is true when a seeded axis was removed", () => {
    expect(ceilingsRaised(seeded, current([ceiling("usd", 1_000)]))).toBe(true);
  });

  it("is true when the run is now unbudgeted", () => {
    expect(ceilingsRaised(seeded, { kind: "unbudgeted" })).toBe(true);
  });

  it("is false when only a new axis was added (a tightening)", () => {
    expect(ceilingsRaised(seeded, current([...seeded, ceiling("calls", 10_000)]))).toBe(false);
  });

  it("is true when one axis is raised even though another is lowered", () => {
    expect(ceilingsRaised(seeded, current([ceiling("usd", 1), ceiling("tokens", 501)]))).toBe(true);
  });
});

describe("ceilingsRaised — laws (FR-017)", () => {
  const KINDS: readonly CeilingKind[] = ["usd", "tokens", "calls"];
  const limitsArb = fc.record({
    usd: fc.option(fc.nat(1_000_000), { nil: undefined }),
    tokens: fc.option(fc.nat(1_000_000), { nil: undefined }),
    calls: fc.option(fc.nat(1_000), { nil: undefined }),
  }).filter((l) => KINDS.some((k) => l[k] !== undefined));
  const toCeilings = (l: Partial<Record<CeilingKind, number>>): Ceiling[] =>
    KINDS.flatMap((k) => (l[k] === undefined ? [] : [ceiling(k, l[k])]));

  it("is false for any current budget pointwise ≤ the seeded ceilings on every seeded axis", () => {
    fc.assert(fc.property(limitsArb, fc.array(fc.nat(1_000_000), { minLength: 3, maxLength: 3 }), fc.boolean(), spendArb,
      (limits, cuts, addAxes, spend) => {
        const seeded = toCeilings(limits);
        const lowered = seeded.map((c, i) => ceiling(c.kind, Math.max(0, c.limit - cuts[i]!)));
        const extra = addAxes ? KINDS.filter((k) => limits[k] === undefined).map((k) => ceiling(k, 7)) : [];
        expect(ceilingsRaised(seeded, current([...lowered, ...extra], spend))).toBe(false);
      }), RUNS);
  });

  it("is true whenever some seeded axis's limit increases", () => {
    fc.assert(fc.property(limitsArb, fc.nat(2), fc.integer({ min: 1, max: 1_000 }), spendArb, (limits, pick, by, spend) => {
      const seeded = toCeilings(limits);
      const raisedAt = pick % seeded.length;
      const next = seeded.map((c, i) => (i === raisedAt ? ceiling(c.kind, c.limit + by) : c));
      expect(ceilingsRaised(seeded, current(next, spend))).toBe(true);
    }), RUNS);
  });

  it("round-trips: a snapshot's own ceilings never count as raised against it", () => {
    fc.assert(fc.property(limitsArb, spendArb, (limits, spend) => {
      const now = current(toCeilings(limits), spend);
      expect(ceilingsRaised(ceilingsOfRemaining(now), now)).toBe(false);
    }), RUNS);
  });
});
