/**
 * LC-1 fan scheduler — scripted scenarios (AD-1, AD-2, AD-6, AD-11).
 *
 * One scenario per LC-1 transition row, plus the absorbing `fan-done`, the
 * ignored-event cases, the seed paths (sticky refusal, raised ceilings, seed
 * content) and the FR-018 (d) cost-spike example. The machine is driven
 * black-box through `initFan` / `fanStep`: every assertion reads the emitted
 * commands or the exported phase guard.
 */

import { describe, expect, it } from "bun:test";
import { fanStep, initFan, isFanDone, type FanCommand, type FanConfig, type FanEvent, type FanState } from "../fan-machine.js";
import { remainingFor, type Remaining } from "../../../types/budget-capability.js";
import { ceilings, type Ceiling } from "../../../types/budget.js";
import type { FrameworkError } from "../../../types/errors.js";
import {
  childConcurrency,
  fanRefusal,
  FanRefusalSeedSchema,
  type FanRefusalSeed,
  type SpendSample,
} from "../../../types/fan-scheduling.js";
import { nodeId } from "../../../types/ids.js";
import { mapIndex } from "../../../types/map-index.js";
import { makeSpend, microUsd, NO_SPEND } from "../../../types/spend.js";

const NODE = nodeId("fan-map");
const CHILD = nodeId("fan-child");
const UNBUDGETED: Remaining = { kind: "unbudgeted" };

const cfg = (over: Partial<FanConfig> = {}): FanConfig => ({
  nodeId: NODE,
  width: 3,
  replayedIndices: new Set<number>(),
  effective: childConcurrency(1),
  estimator: "largest-seen",
  seed: null,
  ...over,
});

const tokensCeiling = (limit: number): Ceiling => ({ kind: "tokens", limit });
/** A real host headroom snapshot: tokens ceiling `limit`, `spent` tokens already projected. */
const tokens = (limit: number, spent = 0): Remaining =>
  remainingFor(ceilings([tokensCeiling(limit)]), spent === 0 ? NO_SPEND
    : makeSpend({ usage: "known", tokens: spent, calls: 0, usd: { kind: "priced", micros: microUsd(0) } }));

const sample = (t: number): SpendSample => ({ tokens: t, calls: 1, usdMicros: microUsd(0), lowerBound: false });
const crash = (i: number): FrameworkError =>
  ({ kind: "node-crash", nodeId: CHILD, message: `child ${i} failed`, retriability: "non-retriable" });

const start = (admission: Remaining = UNBUDGETED): FanEvent => ({ type: "start", admission });
const completed = (i: number, t = 0, admission: Remaining = UNBUDGETED): FanEvent =>
  ({ type: "slot-settled", index: mapIndex(i), outcome: { kind: "completed", value: `v${i}`, sample: sample(t) }, admission });
const replayed = (i: number, admission: Remaining = UNBUDGETED): FanEvent =>
  ({ type: "slot-settled", index: mapIndex(i), outcome: { kind: "replayed", value: `v${i}` }, admission });
const failed = (i: number, t?: number, admission: Remaining = UNBUDGETED): FanEvent =>
  ({ type: "slot-settled", index: mapIndex(i), outcome: { kind: "failed", error: crash(i), ...(t === undefined ? {} : { sample: sample(t) }) }, admission });
const ABORT: FanEvent = { type: "abort" };

/** Fold events through the machine, returning the final state and every step's commands. */
const run = (config: FanConfig, events: readonly FanEvent[]): Readonly<{ state: FanState; steps: readonly (readonly FanCommand[])[] }> =>
  events.reduce(
    (acc, e) => {
      const next = fanStep(acc.state, e);
      return { state: next.state, steps: [...acc.steps, next.commands] };
    },
    { state: initFan(config), steps: [] as readonly (readonly FanCommand[])[] },
  );

const types = (cs: readonly FanCommand[]): readonly string[] =>
  cs.map((c) => (c.type === "dispatch" || c.type === "replay" ? `${c.type}:${c.index}` : c.type));

const phaseOf = (s: FanState): string => s.phase.phase;

const finishOf = (cs: readonly FanCommand[]) => {
  const f = cs.find((c) => c.type === "finish");
  if (f === undefined || f.type !== "finish") throw new Error(`no finish in ${JSON.stringify(types(cs))}`);
  return f.finish;
};
const failOf = (cs: readonly FanCommand[]): FrameworkError => {
  const f = finishOf(cs);
  if (f.kind !== "fail") throw new Error(`expected fail, got ${f.kind}`);
  return f.error;
};
const seedOf = (cs: readonly FanCommand[]): FanRefusalSeed => {
  const s = cs.find((c) => c.type === "persist-seed");
  if (s === undefined || s.type !== "persist-seed") throw new Error("no persist-seed");
  return s.seed;
};

const seedWith = (over: Partial<{ ceiling: number; estimate: number; samples: readonly number[]; effective: number }> = {}): FanRefusalSeed => {
  const ceiling = tokensCeiling(over.ceiling ?? 100);
  return {
    version: 1,
    estimator: "largest-seen",
    samples: (over.samples ?? [30, 40]).map(sample),
    estimate: sample(over.estimate ?? 40),
    ceilings: [ceiling],
    refusal: fanRefusal({
      ceiling, perChildEstimate: over.estimate ?? 40, estimatorApplied: "largest-seen",
      effectiveConcurrency: over.effective ?? 2, completed: 2, remaining: 3, lowerBound: false,
    }),
  };
};

describe("LC-1 start transitions", () => {
  it("start (seed, ceilings not raised, unreplayed > 0) → fan-done with a sticky refusal and 0 dispatches", () => {
    const { state, steps } = run(cfg({ width: 5, replayedIndices: new Set([0, 1]), effective: childConcurrency(4), seed: seedWith() }), [start(tokens(100, 90))]);
    const cs = steps[0] ?? [];
    expect(types(cs)).toEqual(["emit-refused", "persist-seed", "finish"]);
    expect(isFanDone(state)).toBe(true);
    const refused = cs[0];
    expect(refused?.type === "emit-refused" && refused.sticky && !refused.attachedToChildFailure).toBe(true);
    const error = failOf(cs);
    if (error.kind !== "fan-budget-refused") throw new Error(error.kind);
    expect(error.refusal).toMatchObject({
      axis: "tokens", ceiling: tokensCeiling(100), perChildEstimate: 40,
      effectiveConcurrency: 4, completed: 2, remaining: 3,
    });
  });

  it("a LOWERED ceiling keeps the refusal sticky and reports the ceiling now in force", () => {
    const { steps } = run(cfg({ width: 2, seed: seedWith({ ceiling: 100 }) }), [start(tokens(80))]);
    const error = failOf(steps[0] ?? []);
    expect(error.kind === "fan-budget-refused" && error.refusal.ceiling).toEqual(tokensCeiling(80));
    expect(seedOf(steps[0] ?? []).ceilings).toEqual([tokensCeiling(80)]);
  });

  it("start (no work at all) → fan-done, reducing an empty fan, seeded or not", () => {
    for (const seed of [null, seedWith()]) {
      const { state, steps } = run(cfg({ width: 0, seed }), [start(tokens(100))]);
      expect(isFanDone(state)).toBe(true);
      expect(finishOf(steps[0] ?? [])).toEqual({ kind: "reduce", ordered: [] });
    }
  });

  it("seed present but unreplayed = 0: replays and reduces normally (the drain finished everything)", () => {
    const { state, steps } = run(cfg({ width: 2, effective: childConcurrency(2), replayedIndices: new Set([0, 1]), seed: seedWith() }),
      [start(tokens(100)), replayed(1), replayed(0)]);
    expect(types(steps[0] ?? [])).toEqual(["replay:0", "replay:1"]);
    expect(isFanDone(state)).toBe(true);
    expect(finishOf(steps[2] ?? [])).toEqual({ kind: "reduce", ordered: ["v0", "v1"] });
  });

  it("start (unseeded) dispatches the probe batch min(C, unreplayed) with no projection (AS-009)", () => {
    const { state, steps } = run(cfg({ width: 5, effective: childConcurrency(3) }), [start(tokens(10))]);
    expect(types(steps[0] ?? [])).toEqual(["dispatch:0", "dispatch:1", "dispatch:2"]);
    expect(phaseOf(state)).toBe("fan-dispatching");
    const small = run(cfg({ width: 2, effective: childConcurrency(3) }), [start(tokens(10))]);
    expect(types(small.steps[0] ?? [])).toEqual(["dispatch:0", "dispatch:1"]);
  });

  it("start (seeded, ceiling raised) projects before EVERY dispatch, the first included (AS-056)", () => {
    const { state, steps } = run(cfg({ width: 5, effective: childConcurrency(2), seed: seedWith() }), [start(tokens(1_000))]);
    expect(types(steps[0] ?? [])).toEqual(["emit-projection", "dispatch:0", "emit-projection", "dispatch:1"]);
    expect(phaseOf(state)).toBe("fan-dispatching");
    const record = steps[0]?.[0];
    expect(record?.type === "emit-projection" && record.record).toEqual({
      axis: "tokens", estimate: 40, estimatorApplied: "largest-seen", effectiveConcurrency: 2,
      remainingChildren: 5, verdict: "admit", lowerBound: false,
    });
  });

  it("start (seeded, raised, first projection breaches) → fan-done with a fresh, non-sticky refusal", () => {
    const { state, steps } = run(cfg({ width: 5, seed: seedWith() }), [start(tokens(150))]);
    expect(types(steps[0] ?? [])).toEqual(["emit-projection", "emit-refused", "persist-seed", "finish"]);
    expect(isFanDone(state)).toBe(true);
    const refused = steps[0]?.[1];
    expect(refused?.type === "emit-refused" && refused.sticky).toBe(false);
    expect(seedOf(steps[0] ?? []).samples).toEqual([sample(30), sample(40)]);
  });
});

describe("LC-1 fan-dispatching slot-settled transitions", () => {
  it("completed with more work → projects, then dispatches the next index", () => {
    const { state, steps } = run(cfg(), [start(tokens(100)), completed(0, 10, tokens(100, 10))]);
    expect(types(steps[1] ?? [])).toEqual(["emit-projection", "dispatch:1"]);
    expect(phaseOf(state)).toBe("fan-dispatching");
  });

  it("replays occupy the ascending cursor: a replayed index is replayed, never dispatched", () => {
    const { steps, state } = run(cfg({ replayedIndices: new Set([1]) }),
      [start(), completed(0), replayed(1), completed(2)]);
    expect(steps.map(types)).toEqual([["dispatch:0"], ["replay:1"], ["dispatch:2"], ["finish"]]);
    expect(finishOf(steps[3] ?? [])).toEqual({ kind: "reduce", ordered: ["v0", "v1", "v2"] });
    expect(isFanDone(state)).toBe(true);
  });

  it("completed with a projection breach → fan-draining; the drain completion is counted (FR-022)", () => {
    const { state, steps } = run(cfg({ width: 4, effective: childConcurrency(2) }),
      [start(tokens(100)), completed(0, 40, tokens(100, 50))]);
    // remainingChildren = 4 − 1 = 3; 3 × 40 = 120 > headroom 50
    expect(types(steps[1] ?? [])).toEqual(["emit-projection"]);
    const record = steps[1]?.[0];
    expect(record?.type === "emit-projection" && record.record.verdict).toBe("refuse");
    expect(phaseOf(state)).toBe("fan-draining");

    const drained = fanStep(state, completed(1, 45, tokens(100, 95)));
    expect(types(drained.commands)).toEqual(["emit-refused", "persist-seed", "finish"]);
    const error = failOf(drained.commands);
    if (error.kind !== "fan-budget-refused") throw new Error(error.kind);
    expect(error.refusal).toMatchObject({ completed: 2, remaining: 2, perChildEstimate: 40, effectiveConcurrency: 2 });
    const seed = seedOf(drained.commands);
    expect(seed.samples).toEqual([sample(40), sample(45)]);
    expect(seed.estimate).toEqual(sample(40));
    expect(seed.ceilings).toEqual([tokensCeiling(100)]);
    expect(FanRefusalSeedSchema.safeParse(JSON.parse(JSON.stringify(seed))).success).toBe(true);
  });

  it("failed (terminal) → fan-draining: no new dispatch, the in-flight sibling drains", () => {
    const { state, steps } = run(cfg({ width: 5, effective: childConcurrency(2) }), [start(), failed(1)]);
    expect(steps[1]).toEqual([]);
    expect(phaseOf(state)).toBe("fan-draining");
    const done = fanStep(state, completed(0));
    expect(failOf(done.commands)).toEqual(crash(1));
    expect(isFanDone(done.state)).toBe(true);
  });

  it("last slot settles with nothing pending → fan-done, reducing in index order whatever the completion order (FR-005)", () => {
    const { state, steps } = run(cfg({ width: 3, effective: childConcurrency(3) }), [start(), completed(2), completed(0), completed(1)]);
    expect(steps.slice(1, 3)).toEqual([[], []]);
    expect(finishOf(steps[3] ?? [])).toEqual({ kind: "reduce", ordered: ["v0", "v1", "v2"] });
    expect(isFanDone(state)).toBe(true);
  });

  it("abort → fan-draining while slots are in flight, then fan-done with today's aborted error", () => {
    const { state, steps } = run(cfg({ width: 4, effective: childConcurrency(2) }), [start(), ABORT]);
    expect(steps[1]).toEqual([]);
    expect(phaseOf(state)).toBe("fan-draining");
    const one = fanStep(state, completed(0));
    expect(one.commands).toEqual([]);
    const done = fanStep(one.state, completed(1));
    expect(failOf(done.commands)).toEqual({ kind: "aborted", reason: "signal" });
  });

  it("draining entered with zero in-flight slots goes straight to fan-done", () => {
    const { state, steps } = run(cfg(), [ABORT]);
    expect(isFanDone(state)).toBe(true);
    expect(failOf(steps[0] ?? [])).toEqual({ kind: "aborted", reason: "signal" });
  });
});

describe("LC-1 fan-draining transitions", () => {
  it("failures accumulate; lowest index is primary, the rest are secondaries (AS-020, AS-021)", () => {
    const { steps, state } = run(cfg({ width: 6, effective: childConcurrency(3) }),
      [start(), failed(2), failed(0), completed(1)]);
    expect(steps.slice(1, 3)).toEqual([[], []]);
    expect(isFanDone(state)).toBe(true);
    expect(failOf(steps[3] ?? [])).toEqual({
      kind: "fan-child-failed", nodeId: NODE,
      primary: { index: mapIndex(0), error: crash(0) },
      causes: { kind: "secondaries", secondary: [{ index: mapIndex(2), error: crash(2) }] },
    });
  });

  it("abort during a refusal drain is recorded but never overrides the refusal (FR-024)", () => {
    const { steps } = run(cfg({ width: 4, effective: childConcurrency(2) }),
      [start(tokens(100)), completed(0, 40, tokens(100, 50)), ABORT, completed(1, 40, tokens(100, 90))]);
    expect(steps[2]).toEqual([]);
    expect(failOf(steps[3] ?? []).kind).toBe("fan-budget-refused");
  });

  it("abort during a failure drain never overrides the failure", () => {
    const { steps } = run(cfg({ width: 4, effective: childConcurrency(2) }), [start(), failed(0), ABORT, completed(1)]);
    expect(failOf(steps[3] ?? [])).toEqual(crash(0));
  });

  it("mixed drain: refusal then a child failure → fan-child-failed with the refusal attached and still emitted (FR-025)", () => {
    const { steps } = run(cfg({ width: 5, effective: childConcurrency(3) }),
      [start(tokens(100)), completed(0, 30, tokens(100, 60)), failed(2, 10), completed(1, 5)]);
    expect(types(steps[3] ?? [])).toEqual(["emit-refused", "persist-seed", "finish"]);
    const refused = steps[3]?.[0];
    expect(refused?.type === "emit-refused" && refused.attachedToChildFailure).toBe(true);
    const error = failOf(steps[3] ?? []);
    if (error.kind !== "fan-child-failed" || error.causes.kind !== "refusal") throw new Error(JSON.stringify(error));
    expect(error.primary.index).toBe(mapIndex(2));
    expect(error.causes.refusal).toMatchObject({ completed: 2, remaining: 3 });
    expect(seedOf(steps[3] ?? []).samples).toEqual([sample(30), sample(10), sample(5)]);
  });
});

describe("fan-done is absorbing; illegal events are ignored", () => {
  it("returns the same state and no commands for every event once done", () => {
    const { state } = run(cfg({ width: 1 }), [start(), completed(0)]);
    expect(isFanDone(state)).toBe(true);
    for (const e of [start(), completed(0), failed(0), replayed(0), ABORT]) {
      const next = fanStep(state, e);
      expect(next.state).toBe(state);
      expect(next.commands).toEqual([]);
    }
  });

  it("ignores a second start and a settle for an index that is not in flight", () => {
    const { state } = run(cfg({ width: 3 }), [start()]);
    for (const e of [start(), completed(2), completed(1)]) {
      const next = fanStep(state, e);
      expect(next.state).toBe(state);
      expect(next.commands).toEqual([]);
    }
  });

  it("a replay-parse failure is a failed outcome for that index", () => {
    const { steps } = run(cfg({ width: 3, replayedIndices: new Set([0]) }), [start(), failed(0)]);
    expect(types(steps[0] ?? [])).toEqual(["replay:0"]);
    expect(failOf(steps[1] ?? [])).toEqual(crash(0));
  });
});

describe("C = 1 is the sequential fan", () => {
  it("starts exactly one index at a time, in index order, and stops at the first failure", () => {
    const { steps } = run(cfg({ width: 5, replayedIndices: new Set([1]) }), [start(), completed(0), replayed(1), failed(2)]);
    expect(steps.map(types)).toEqual([["dispatch:0"], ["replay:1"], ["dispatch:2"], ["finish"]]);
    expect(failOf(steps[3] ?? [])).toEqual(crash(2));
  });
});

describe("FR-018 (d) — a cost spike is bounded only by the host per-call meter", () => {
  it("admits a child on the estimate in force; its later spike is invisible to the machine until it settles", () => {
    // probe child costs 10; the next child is admitted on estimate 10 (2 × 10 ≤ 90)
    const { steps, state } = run(cfg({ width: 2 }), [start(tokens(100)), completed(0, 10, tokens(100, 10))]);
    expect(types(steps[1] ?? [])).toEqual(["emit-projection", "dispatch:1"]);
    // the admitted child spikes to 500 — far past the ceiling. Nothing in the
    // fan stops it mid-flight: only the host per-call meter can (ADR-0090).
    const done = fanStep(state, completed(1, 500, tokens(100, 510)));
    expect(finishOf(done.commands)).toEqual({ kind: "reduce", ordered: ["v0", "v1"] });
  });
});
