/**
 * Whole-fan projection (AD-4, FR-011, FR-013, SC-005).
 *
 * Pins the per-headroom-kind refusal rule — `unbudgeted` never refuses and
 * projects nothing; `available` refuses when `remainingChildren × estimate`
 * exceeds the headroom amount; `unpriced` / `unknown-usage` refuse when the
 * known lower bound plus `remainingChildren × estimate` exceeds the ceiling
 * (refusing on the bound alone), flagged `lowerBound` — and that the FIRST
 * breached axis in ceiling order is the one reported.
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { project, type AxisCheck } from "../projection.js";
import type { CeilingHeadroom, Remaining } from "../../../types/budget-capability.js";
import { remainingFor } from "../../../types/budget-capability.js";
import { ceilings } from "../../../types/budget.js";
import type { SpendSample } from "../../../types/fan-scheduling.js";
import { makeSpend, microUsd, unpricedModel } from "../../../types/spend.js";

const RUNS = { numRuns: 1_000 } as const;

const sample = (tokens: number, calls: number, usd: number, lowerBound = false): SpendSample =>
  ({ tokens, calls, usdMicros: microUsd(usd), lowerBound });
const budgeted = (headroom: readonly CeilingHeadroom[]): Remaining =>
  ({ kind: "budgeted", basis: "projected", headroom });

const count = fc.integer({ min: 0, max: 10_000_000 });
const children = fc.integer({ min: 0, max: 200 });
const estimateArb: fc.Arbitrary<SpendSample> = fc.record({
  tokens: fc.integer({ min: 0, max: 100_000 }),
  calls: fc.integer({ min: 0, max: 20 }),
  usd: fc.integer({ min: 0, max: 100_000 }),
}).map(({ tokens, calls, usd }) => sample(tokens, calls, usd));

const headroomArb: fc.Arbitrary<CeilingHeadroom> = fc.oneof(
  fc.record({ limit: count, amount: count }).map(({ limit, amount }): CeilingHeadroom =>
    ({ kind: "available", unit: "tokens", ceiling: { kind: "tokens", limit }, amount })),
  fc.record({ limit: count, amount: count }).map(({ limit, amount }): CeilingHeadroom =>
    ({ kind: "available", unit: "calls", ceiling: { kind: "calls", limit }, amount })),
  fc.record({ limit: count, amount: count }).map(({ limit, amount }): CeilingHeadroom =>
    ({ kind: "available", unit: "usd", ceiling: { kind: "usd", limit: microUsd(limit) }, amount: microUsd(amount) })),
  fc.record({ limit: count, seen: count }).map(({ limit, seen }): CeilingHeadroom =>
    ({ kind: "unpriced", ceiling: { kind: "usd", limit: microUsd(limit) }, models: unpricedModel("m"), observedAtLeast: microUsd(seen) })),
  fc.record({ limit: count, seen: count }).map(({ limit, seen }): CeilingHeadroom =>
    ({ kind: "unknown-usage", ceiling: { kind: "tokens", limit }, observedAtLeast: seen })),
  fc.record({ limit: count, seen: count }).map(({ limit, seen }): CeilingHeadroom =>
    ({ kind: "unknown-usage", ceiling: { kind: "usd", limit: microUsd(limit) }, observedAtLeast: microUsd(seen) })),
);

const estimateOn = (h: CeilingHeadroom, e: SpendSample): number =>
  h.ceiling.kind === "tokens" ? e.tokens : h.ceiling.kind === "calls" ? e.calls : e.usdMicros;

/** The AD-4 table, restated independently of the implementation. */
const oracle = (h: CeilingHeadroom, n: number, e: SpendSample): { breached: boolean; lowerBound: boolean } =>
  h.kind === "available"
    ? { breached: n * estimateOn(h, e) > h.amount, lowerBound: false }
    : { breached: h.observedAtLeast + n * estimateOn(h, e) > h.ceiling.limit, lowerBound: true };

describe("project — per headroom kind (AD-4 table)", () => {
  it("never refuses and projects no axis when unbudgeted", () => {
    expect(project({ kind: "unbudgeted" }, 1_000_000, sample(1e9, 1e9, 1e9))).toEqual({ kind: "admit", checks: [] });
  });

  it("refuses an available axis only when remainingChildren × estimate exceeds the amount", () => {
    const tokens: CeilingHeadroom = { kind: "available", unit: "tokens", ceiling: { kind: "tokens", limit: 1_000 }, amount: 600 };
    expect(project(budgeted([tokens]), 3, sample(200, 0, 0)).kind).toBe("admit");
    expect(project(budgeted([tokens]), 4, sample(200, 0, 0))).toEqual({
      kind: "breach", axis: "tokens", ceiling: { kind: "tokens", limit: 1_000 },
      estimate: 200, projected: 800, allowance: 600, lowerBound: false,
    });
  });

  it("projects an available usd axis in MicroUsd", () => {
    const usd: CeilingHeadroom = { kind: "available", unit: "usd", ceiling: { kind: "usd", limit: microUsd(5_000) }, amount: microUsd(1_000) };
    const verdict = project(budgeted([usd]), 2, sample(0, 0, 501));
    expect(verdict).toMatchObject({ kind: "breach", axis: "usd", projected: 1_002, allowance: 1_000, lowerBound: false });
  });

  it("refuses an unpriced usd axis on the known lower bound, flagged lowerBound", () => {
    const unpriced: CeilingHeadroom = {
      kind: "unpriced", ceiling: { kind: "usd", limit: microUsd(1_000) }, models: unpricedModel("m"), observedAtLeast: microUsd(700),
    };
    expect(project(budgeted([unpriced]), 3, sample(0, 0, 100)).kind).toBe("admit");
    expect(project(budgeted([unpriced]), 4, sample(0, 0, 100))).toMatchObject({
      kind: "breach", axis: "usd", projected: 1_100, allowance: 1_000, lowerBound: true,
    });
  });

  it("refuses once the lower bound alone breaches, even with a zero estimate (FR-013)", () => {
    const unknown: CeilingHeadroom = { kind: "unknown-usage", ceiling: { kind: "tokens", limit: 100 }, observedAtLeast: 101 };
    expect(project(budgeted([unknown]), 1, sample(0, 0, 0))).toMatchObject({
      kind: "breach", axis: "tokens", projected: 101, allowance: 100, lowerBound: true,
    });
  });

  it("admits zero-cost children against an exhausted available axis (AD-12 c)", () => {
    const calls: CeilingHeadroom = { kind: "available", unit: "calls", ceiling: { kind: "calls", limit: 10 }, amount: 0 };
    expect(project(budgeted([calls]), 5, sample(0, 0, 0)).kind).toBe("admit");
    expect(project(budgeted([calls]), 5, sample(0, 1, 0)).kind).toBe("breach");
  });

  it("reports the first breached axis in ceiling order, built from the host headroom", () => {
    const limits = ceilings([{ kind: "calls", limit: 10 }, { kind: "tokens", limit: 100 }, { kind: "usd", limit: microUsd(1_000) }]);
    const spent = makeSpend({ usage: "known", tokens: 90, calls: 9, usd: { kind: "priced", micros: microUsd(100) } });
    // usd leads the canonical order but is within budget; tokens is the first breach.
    expect(project(remainingFor(limits, spent), 2, sample(10, 1, 100))).toMatchObject({ kind: "breach", axis: "tokens" });
  });

  it("fails closed on a non-finite estimate", () => {
    const tokens: CeilingHeadroom = { kind: "available", unit: "tokens", ceiling: { kind: "tokens", limit: 1_000 }, amount: 600 };
    expect(project(budgeted([tokens]), 1, sample(Number.NaN, 0, 0)).kind).toBe("breach");
  });
});

describe("project — laws across all headroom kinds (SC-005, FR-013)", () => {
  it("admits iff no axis breaches the AD-4 rule, else reports the first breached axis", () => {
    fc.assert(fc.property(fc.array(headroomArb, { maxLength: 6 }), children, estimateArb, (headroom, n, e) => {
      const verdict = project(budgeted(headroom), n, e);
      const firstBreached = headroom.findIndex((h) => oracle(h, n, e).breached);
      if (firstBreached === -1) {
        expect(verdict.kind).toBe("admit");
        if (verdict.kind === "admit") expect(verdict.checks).toHaveLength(headroom.length);
        return;
      }
      const h = headroom[firstBreached]!;
      expect(verdict).toMatchObject({
        kind: "breach", axis: h.ceiling.kind, ceiling: h.ceiling,
        estimate: estimateOn(h, e), lowerBound: oracle(h, n, e).lowerBound,
      });
    }), RUNS);
  });

  it("every check agrees with its own figures: breached iff projected > allowance", () => {
    fc.assert(fc.property(fc.array(headroomArb, { maxLength: 6 }), children, estimateArb, (headroom, n, e) => {
      const verdict = project(budgeted(headroom), n, e);
      const checks: readonly AxisCheck[] = verdict.kind === "admit" ? verdict.checks : [verdict];
      for (const c of checks) {
        expect(c.axis).toBe(c.ceiling.kind);
        expect(c.projected > c.allowance).toBe(verdict.kind === "breach");
      }
    }), RUNS);
  });

  it("is monotone in remaining children: a refusal never turns into an admit with more children", () => {
    fc.assert(fc.property(fc.array(headroomArb, { maxLength: 6 }), children, children, estimateArb, (headroom, a, b, e) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      if (project(budgeted(headroom), lo, e).kind === "breach") {
        expect(project(budgeted(headroom), hi, e).kind).toBe("breach");
      }
    }), RUNS);
  });
});
