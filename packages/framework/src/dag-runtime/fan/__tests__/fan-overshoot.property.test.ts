/**
 * FR-018 overshoot bounds (AD-12, SC-004, NFR-021) — the LC-1 machine driven
 * against a SIMULATED run-wide spend model, ≥ 1,000 cases each.
 *
 * The model: two budgeted axes (tokens, calls) with ceilings L. Each child has
 * an arbitrary cost it spends in up to two parts during its lifetime — part
 * of it at an arbitrary moment while in flight, the rest at settle — and the
 * settle order is arbitrary, so windows overlap freely at C > 1. The shell's
 * view is reproduced exactly: every admission snapshot is the host headroom
 * `remainingFor(ceilings, S)` of the current run-wide spend S, and each
 * child's sample is the LIFETIME-WINDOW delta S(settle) − S(dispatch) (AD-3),
 * never less than its own cost. M is the per-axis maximum of those samples
 * (seeded samples included).
 *
 * Asserted:
 *   (a) spend after the projection-refusal decision ≤ (C−1)·M — always, under
 *       any estimator.
 *   (b) spike-free runs (every child's sample ≤ the estimate in force at its
 *       admission — for a probe child, the first estimate the machine applies
 *       at or after its dispatch) with at least one projected admission never
 *       end above any ceiling. A coverage guard pins that such runs occur.
 *   (c) the unprojected probe batch is at most C children, spending ≤ C·M; and
 *       the projection gate law — an admit means R × e ≤ max(0, L − S) — so
 *       once the probe overshot (S ≥ L) any child with a non-zero estimate is
 *       refused.
 *   (d) is an example in fan-machine.test.ts: a cost spike is bounded only by
 *       the host per-call meter.
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { fanStep, initFan, isFanDone, type FanCommand, type FanEvent, type ProjectionRecord } from "../fan-machine.js";
import { ceilingsOfRemaining } from "../seed.js";
import { remainingFor, type Remaining } from "../../../types/budget-capability.js";
import { ceilings } from "../../../types/budget.js";
import type { FrameworkError } from "../../../types/errors.js";
import {
  childConcurrency,
  FAN_ESTIMATORS,
  fanRefusal,
  type FanEstimator,
  type FanRefusalSeed,
  type SpendSample,
} from "../../../types/fan-scheduling.js";
import { nodeId } from "../../../types/ids.js";
import { mapIndex } from "../../../types/map-index.js";
import { makeSpend, microUsd } from "../../../types/spend.js";

const RUNS = { numRuns: 1_000 } as const;
// Vacuity floor for (b): about 5% of generated scenarios are spike-free with a
// projected admission, so a floor at 5% flakes on sampling noise. 2% still
// fails loudly if the generators stop reaching the property at all.
const MIN_EXERCISED = RUNS.numRuns / 50;
const NODE = nodeId("fan-map");
const CHILD = nodeId("fan-child");
const AXES = ["tokens", "calls"] as const;
type Axis = (typeof AXES)[number];
type Cost = Readonly<Record<Axis, number>>;

const ZERO: Cost = { tokens: 0, calls: 0 };
const add = (a: Cost, b: Cost): Cost => ({ tokens: a.tokens + b.tokens, calls: a.calls + b.calls });
const sub = (a: Cost, b: Cost): Cost => ({ tokens: a.tokens - b.tokens, calls: a.calls - b.calls });
const half = (a: Cost): Cost => ({ tokens: Math.floor(a.tokens / 2), calls: Math.floor(a.calls / 2) });
const maxOf = (cs: readonly Cost[]): Cost =>
  cs.reduce((m, c) => ({ tokens: Math.max(m.tokens, c.tokens), calls: Math.max(m.calls, c.calls) }), ZERO);
const asSample = (c: Cost): SpendSample => ({ tokens: c.tokens, calls: c.calls, usdMicros: microUsd(0), lowerBound: false });
const crash = (i: number): FrameworkError =>
  ({ kind: "node-crash", nodeId: CHILD, message: `child ${i} failed`, retriability: "non-retriable" });

type Scenario = Readonly<{
  width: number;
  effective: number;
  estimator: FanEstimator;
  limits: Cost;
  costs: readonly Cost[];
  fails: ReadonlySet<number>;
  picks: readonly number[];
  seedSamples: readonly Cost[] | null;
}>;

const headroom = (limits: Cost, spent: Cost): Remaining =>
  remainingFor(
    ceilings([{ kind: "tokens", limit: limits.tokens }, { kind: "calls", limit: limits.calls }]),
    makeSpend({ usage: "known", tokens: spent.tokens, calls: spent.calls, usd: { kind: "priced", micros: microUsd(0) } }),
  );

/** A seed whose ceilings are lower than `limits`, so the resume counts as raised and projects every dispatch. */
const seedFor = (s: Scenario, samples: readonly Cost[]): FanRefusalSeed => {
  const cs = [{ kind: "tokens" as const, limit: Math.max(0, s.limits.tokens - 1) }, { kind: "calls" as const, limit: Math.max(0, s.limits.calls - 1) }];
  const canonical = ceilingsOfRemaining(headroom({ tokens: cs[0].limit, calls: cs[1].limit }, ZERO));
  return {
    version: 1, estimator: s.estimator, samples: samples.map(asSample), estimate: asSample(maxOf(samples)), ceilings: canonical,
    refusal: fanRefusal({
      ceiling: canonical[0] ?? cs[0], perChildEstimate: 0, estimatorApplied: "largest-seen",
      effectiveConcurrency: 1, completed: 0, remaining: s.width, lowerBound: false,
    }),
  };
};

type Admission = Readonly<{ child: number; position: number; projectedEstimate: Cost | null }>;
type Outcome = Readonly<{
  spentAtRefusal: Cost | null;
  finalSpend: Cost;
  samples: ReadonlyMap<number, Cost>;
  admissions: readonly Admission[];
  /** Every projection: its command position, the test's largest-seen oracle then, and the record. */
  projections: readonly Readonly<{ position: number; oracle: Cost; spent: Cost; record: ProjectionRecord }>[];
  ownCosts: ReadonlyMap<number, Cost>;
  maxInFlight: number;
  finished: boolean;
}>;

type Slot = { dispatchedAt: Cost; partial: Cost };

/** Play the shell against the spend model; returns everything the bounds are stated over. */
const simulate = (s: Scenario): Outcome => {
  const seed = s.seedSamples === null ? null : seedFor(s, s.seedSamples);
  let state = initFan({
    nodeId: NODE, width: s.width, replayedIndices: new Set(), effective: childConcurrency(s.effective),
    estimator: s.estimator, seed,
  });
  let spent: Cost = ZERO;
  let position = 0;
  let spentAtRefusal: Cost | null = null;
  let maxInFlight = 0;
  const slots = new Map<number, Slot>();
  const samples = new Map<number, Cost>();
  const ownCosts = new Map<number, Cost>();
  const admissions: Admission[] = [];
  const projections: { position: number; oracle: Cost; spent: Cost; record: ProjectionRecord }[] = [];
  const oracle = (): Cost => maxOf([...(s.seedSamples ?? []), ...samples.values()]);

  const apply = (e: FanEvent): void => {
    const { state: next, commands } = fanStep(state, e);
    state = next;
    let pendingEstimate: Cost | null = null;
    commands.forEach((c: FanCommand) => {
      position++;
      if (c.type === "emit-projection") {
        projections.push({ position, oracle: oracle(), spent, record: c.record });
        pendingEstimate = oracle();
        if (c.record.verdict === "refuse" && spentAtRefusal === null) spentAtRefusal = spent;
      }
      if (c.type === "dispatch") {
        slots.set(c.index, { dispatchedAt: spent, partial: ZERO });
        ownCosts.set(c.index, s.costs[c.index % s.costs.length] ?? ZERO);
        admissions.push({ child: c.index, position, projectedEstimate: pendingEstimate });
        pendingEstimate = null;
      }
    });
    maxInFlight = Math.max(maxInFlight, slots.size);
  };

  apply({ type: "start", admission: headroom(s.limits, spent) });
  for (let n = 0; !isFanDone(state) && n < 8 * s.width + 8; n++) {
    const live = [...slots.keys()];
    const pick = s.picks[n % s.picks.length] ?? 0;
    const i = live[pick % Math.max(1, live.length)];
    if (i === undefined) break;
    const slot = slots.get(i);
    const cost = ownCosts.get(i) ?? ZERO;
    if (slot === undefined) break;
    if (pick % 3 === 0 && slot.partial === ZERO) {
      // part of the child's cost lands mid-flight; it stays in flight
      slot.partial = half(cost);
      spent = add(spent, slot.partial);
      continue;
    }
    spent = add(spent, sub(cost, slot.partial));
    slots.delete(i);
    const sample = sub(spent, slot.dispatchedAt);
    samples.set(i, sample);
    const admission = headroom(s.limits, spent);
    apply(s.fails.has(i)
      ? { type: "slot-settled", index: mapIndex(i), admission, outcome: { kind: "failed", error: crash(i), sample: asSample(sample) } }
      : { type: "slot-settled", index: mapIndex(i), admission, outcome: { kind: "completed", value: i, sample: asSample(sample) } });
  }
  return { spentAtRefusal, finalSpend: spent, samples, admissions, projections, ownCosts, maxInFlight, finished: isFanDone(state) };
};

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Costs skewed toward zero and small values, so spike-free runs are common enough to exercise (b). */
const costArb: fc.Arbitrary<Cost> = fc.record({
  tokens: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 3, arbitrary: fc.nat(20) }, { weight: 1, arbitrary: fc.nat(200) }),
  calls: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 2, arbitrary: fc.nat(3) }),
});

const scenarioArb = (opts: Readonly<{ estimator?: fc.Arbitrary<FanEstimator>; seeded?: boolean }> = {}): fc.Arbitrary<Scenario> =>
  fc.record({
    width: fc.integer({ min: 1, max: 14 }),
    effective: fc.integer({ min: 1, max: 5 }),
    estimator: opts.estimator ?? fc.constant<FanEstimator>("largest-seen"),
    limits: fc.record({ tokens: fc.nat(300), calls: fc.nat(20) }),
    costs: fc.array(costArb, { minLength: 1, maxLength: 14 }),
    fails: fc.uniqueArray(fc.nat(14), { maxLength: 2 }).map((xs) => new Set(xs)),
    picks: fc.array(fc.nat(1_000), { minLength: 1, maxLength: 30 }),
    seedSamples: opts.seeded === true ? fc.array(costArb, { maxLength: 4 }) : fc.constant(null),
  });

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("FR-018 (a) — post-refusal spend ≤ (C−1)·M", () => {
  it("holds unconditionally, for every estimator (largest-seen and percentiles)", () => {
    fc.assert(fc.property(scenarioArb({ estimator: fc.constantFrom(...FAN_ESTIMATORS) }), (s) => {
      const o = simulate(s);
      expect(o.finished).toBe(true);
      if (o.spentAtRefusal === null) return;
      const m = maxOf([...(s.seedSamples ?? []), ...o.samples.values()]);
      const after = sub(o.finalSpend, o.spentAtRefusal);
      for (const axis of AXES) expect(after[axis]).toBeLessThanOrEqual((s.effective - 1) * m[axis]);
    }), RUNS);
  });
});

/** Spike-free per AD-12 (b): each child's sample ≤ the estimate in force at its admission. */
const spikeFree = (s: Scenario, o: Outcome): boolean =>
  o.admissions.every((a) => {
    const inForce = a.projectedEstimate
      ?? o.projections.find((p) => p.position > a.position)?.oracle
      ?? null;
    const sample = o.samples.get(a.child);
    return inForce === null || sample === undefined || AXES.every((axis) => sample[axis] <= inForce[axis]);
  }) && s.width > 0;

describe("FR-018 (b) — spike-free post-probe dispatches never cross a ceiling", () => {
  it("ends at or under every ceiling whenever at least one projected admission happened", () => {
    let exercised = 0;
    fc.assert(fc.property(scenarioArb(), (s) => {
      const o = simulate(s);
      const projectedAdmission = o.admissions.some((a) => a.projectedEstimate !== null);
      if (!projectedAdmission || !spikeFree(s, o)) return;
      exercised++;
      for (const axis of AXES) expect(o.finalSpend[axis]).toBeLessThanOrEqual(s.limits[axis]);
    }), RUNS);
    expect(exercised).toBeGreaterThan(MIN_EXERCISED);
  });

  it("holds with a seed and a raised ceiling, where EVERY dispatch is projected (no probe)", () => {
    let exercised = 0;
    fc.assert(fc.property(scenarioArb({ seeded: true }), (s) => {
      const o = simulate(s);
      expect(o.admissions.every((a) => a.projectedEstimate !== null)).toBe(true);
      if (o.admissions.length === 0 || !spikeFree(s, o)) return;
      exercised++;
      for (const axis of AXES) expect(o.finalSpend[axis]).toBeLessThanOrEqual(s.limits[axis]);
    }), RUNS);
    expect(exercised).toBeGreaterThan(MIN_EXERCISED);
  });

  it("C = 1 with the probe child the most expensive is always spike-free and stays within budget", () => {
    const arb = scenarioArb().map((s) => {
      const top = maxOf(s.costs);
      return { ...s, effective: 1, fails: new Set<number>(), costs: [top, ...s.costs] };
    });
    fc.assert(fc.property(arb, (s) => {
      const o = simulate(s);
      expect(spikeFree(s, o)).toBe(true);
      if (o.admissions.some((a) => a.projectedEstimate !== null)) {
        for (const axis of AXES) expect(o.finalSpend[axis]).toBeLessThanOrEqual(s.limits[axis]);
      }
    }), RUNS);
  });
});

describe("FR-018 (c) — the probe carve-out and the projection gate", () => {
  it("the unprojected probe is at most C children, spending at most C·M", () => {
    fc.assert(fc.property(scenarioArb(), (s) => {
      const o = simulate(s);
      const probe = o.admissions.filter((a) => a.projectedEstimate === null);
      expect(probe.length).toBeLessThanOrEqual(Math.min(s.effective, s.width));
      expect(o.maxInFlight).toBeLessThanOrEqual(s.effective);
      const m = maxOf([...o.samples.values()]);
      const probeSpend = probe.reduce((acc, a) => add(acc, o.ownCosts.get(a.child) ?? ZERO), ZERO);
      for (const axis of AXES) expect(probeSpend[axis]).toBeLessThanOrEqual(s.effective * m[axis]);
    }), RUNS);
  });

  it("an admit means R × e ≤ max(0, L − S) on every axis — so after a probe overshoot any non-zero estimate is refused", () => {
    fc.assert(fc.property(scenarioArb({ seeded: false }), (s) => {
      for (const p of simulate(s).projections) {
        const axis = p.record.axis;
        if (axis === "usd") throw new Error("usd is not budgeted in this model");
        expect(p.record.estimate).toBe(p.oracle[axis]);
        const allowance = Math.max(0, s.limits[axis] - p.spent[axis]);
        // The gate law, both directions: admitted ⇔ the projection fits the allowance.
        expect(p.record.remainingChildren * p.record.estimate <= allowance).toBe(p.record.verdict === "admit");
        if (p.spent[axis] >= s.limits[axis] && p.record.estimate > 0) expect(p.record.verdict).toBe("refuse");
      }
    }), RUNS);
  });
});
