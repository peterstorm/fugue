/**
 * LC-1 fan scheduler — behavioural laws (INV-5), ≥ 1,000 cases each.
 *
 * A black-box driver plays the shell: it executes `replay` / `dispatch`
 * commands as outstanding slots, settles them in an ARBITRARY order with
 * arbitrary outcomes (completion, child failure, replay-parse failure), may
 * inject an abort, and feeds arbitrary headroom snapshots. Every law below is
 * read off the emitted command stream, never the machine's internals:
 *   - in-flight ≤ C (FR-003); fan-done only at in-flight = 0; never stalls
 *   - starts strictly ascending, replays never dispatched, each index once
 *   - unseeded probe = min(C, unreplayed) unprojected dispatches (AS-009);
 *     projection precedes every later dispatch, and EVERY dispatch when seeded
 *   - no start once a drain began (AS-019)
 *   - ordered reduce (SC-003, FR-005); no reduce after failure/refusal/abort (FR-016)
 *   - lowest-index primary, complete secondaries, refusal attached (SC-006, FR-021, FR-025)
 *   - refusal `completed` counts drain completions (FR-022)
 *   - persist-seed immediately precedes finish iff a refusal exists, and the
 *     seed round-trips through its wire schema carrying every sample (FR-026)
 *   - sticky refusal: seed + not raised + unreplayed > 0 ⇒ 0 dispatches (SC-008 core)
 *   - fan-done is absorbing; C = 1 is the sequential order (FR-004)
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { fanStep, initFan, isFanDone, type FanCommand, type FanConfig, type FanEvent, type FanState } from "../fan-machine.js";
import { ceilingsOfRemaining } from "../seed.js";
import { remainingFor, type Remaining } from "../../../types/budget-capability.js";
import { ceilings, type Ceiling, type CeilingKind } from "../../../types/budget.js";
import type { FrameworkError } from "../../../types/errors.js";
import {
  childConcurrency,
  FAN_ESTIMATORS,
  fanRefusal,
  FanRefusalSeedSchema,
  type FanRefusalSeed,
  type SpendSample,
} from "../../../types/fan-scheduling.js";
import { nodeId } from "../../../types/ids.js";
import { mapIndex } from "../../../types/map-index.js";
import { makeSpend, microUsd } from "../../../types/spend.js";

const RUNS = { numRuns: 1_000 } as const;
const NODE = nodeId("fan-map");
const CHILD = nodeId("fan-child");

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const ceilingOf = (kind: CeilingKind, limit: number): Ceiling =>
  kind === "usd" ? { kind, limit: microUsd(limit) } : { kind, limit };

const ceilingsArb = fc.uniqueArray(
  fc.record({ kind: fc.constantFrom<CeilingKind>("tokens", "calls", "usd"), limit: fc.nat(500) }),
  { minLength: 1, maxLength: 3, selector: (c) => c.kind },
).map((cs) => cs.map((c) => ceilingOf(c.kind, c.limit)));

const spendArb = fc.record({
  usage: fc.constantFrom<"known" | "unknown">("known", "known", "unknown"),
  tokens: fc.nat(600),
  calls: fc.nat(600),
  micros: fc.nat(600),
}).map((s) => makeSpend({ usage: s.usage, tokens: s.tokens, calls: s.calls, usd: { kind: "priced", micros: microUsd(s.micros) } }));

const budgetedArb: fc.Arbitrary<Remaining> = fc.tuple(ceilingsArb, spendArb)
  .map(([cs, spend]) => remainingFor(ceilings(cs), spend));
const remainingArb: fc.Arbitrary<Remaining> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Remaining>({ kind: "unbudgeted" }) },
  { weight: 4, arbitrary: budgetedArb },
);

const sampleArb: fc.Arbitrary<SpendSample> = fc.record({
  tokens: fc.nat(100), calls: fc.nat(5), usdMicros: fc.nat(1_000).map(microUsd), lowerBound: fc.boolean(),
});

/** A seed whose ceilings are canonical host ceilings and whose refusal names one of them. */
const seedArb: fc.Arbitrary<FanRefusalSeed> = fc.record({
  cs: ceilingsArb,
  samples: fc.array(sampleArb, { maxLength: 8 }),
  estimate: sampleArb,
  pick: fc.nat(),
  estimator: fc.constantFrom(...FAN_ESTIMATORS),
}).map(({ cs, samples, estimate, pick, estimator }) => {
  const canonical = ceilingsOfRemaining(remainingFor(ceilings(cs), makeSpend({ usage: "known", tokens: 0, calls: 0, usd: { kind: "priced", micros: microUsd(0) } })));
  const ceiling = canonical[pick % canonical.length] ?? ceilingOf("tokens", 0);
  return {
    version: 1, estimator, samples, estimate, ceilings: canonical,
    refusal: fanRefusal({
      ceiling, perChildEstimate: 7, estimatorApplied: "largest-seen", effectiveConcurrency: 2,
      completed: 1, remaining: 2, lowerBound: false,
    }),
  };
});

const lowered = (c: Ceiling, by: number): Ceiling => ceilingOf(c.kind, Math.max(0, c.limit - by));
/** A current headroom snapshot whose ceilings are pointwise ≤ the seed's: NOT raised. */
const notRaisedArb = (seed: FanRefusalSeed): fc.Arbitrary<Remaining> =>
  fc.tuple(fc.array(fc.nat(50), { minLength: 3, maxLength: 3 }), spendArb)
    .map(([bys, spend]) => remainingFor(ceilings(seed.ceilings.map((c, i) => lowered(c, bys[i] ?? 0))), spend));
/** A current snapshot with at least one seeded ceiling raised. */
const raisedArb = (seed: FanRefusalSeed): fc.Arbitrary<Remaining> =>
  fc.tuple(fc.nat(seed.ceilings.length - 1), fc.integer({ min: 1, max: 1_000 }), spendArb)
    .map(([which, up, spend]) => remainingFor(
      ceilings(seed.ceilings.map((c, i) => (i === which ? ceilingOf(c.kind, c.limit + up) : c))), spend));

const configArb = (seed: fc.Arbitrary<FanRefusalSeed | null>): fc.Arbitrary<FanConfig> =>
  fc.record({
    width: fc.nat(16),
    effective: fc.integer({ min: 1, max: 5 }),
    replayMask: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
    estimator: fc.constantFrom(...FAN_ESTIMATORS),
    seed,
  }).map(({ width, effective, replayMask, estimator, seed: s }) => ({
    nodeId: NODE,
    width,
    replayedIndices: new Set(replayMask.flatMap((r, i) => (r && i < width ? [i] : []))),
    effective: childConcurrency(effective),
    estimator,
    seed: s,
  }));

/** The shell's side of a run: settle order, outcomes, abort and headroom per step. */
type Plan = Readonly<{
  picks: readonly number[];
  fails: ReadonlySet<number>;
  replayFails: ReadonlySet<number>;
  abortAt: number | null;
  costs: readonly SpendSample[];
  admissions: readonly Remaining[];
}>;

const planArb = (admission: fc.Arbitrary<Remaining> = remainingArb): fc.Arbitrary<Plan> => fc.record({
  picks: fc.array(fc.nat(1_000), { minLength: 1, maxLength: 40 }),
  fails: fc.uniqueArray(fc.nat(30), { maxLength: 3 }).map((xs) => new Set(xs)),
  replayFails: fc.uniqueArray(fc.nat(30), { maxLength: 1 }).map((xs) => new Set(xs)),
  abortAt: fc.option(fc.nat(25), { nil: null, freq: 5 }),
  costs: fc.array(sampleArb, { minLength: 1, maxLength: 10 }),
  admissions: fc.array(admission, { minLength: 1, maxLength: 4 }),
});

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type Step = Readonly<{
  event: FanEvent;
  before: FanState;
  after: FanState;
  commands: readonly FanCommand[];
  outstanding: number;
}>;
type Trace = Readonly<{ steps: readonly Step[]; settledSamples: readonly SpendSample[]; stalled: boolean }>;

const crash = (i: number): FrameworkError =>
  ({ kind: "node-crash", nodeId: CHILD, message: `child ${i} failed`, retriability: "non-retriable" });
const at = <T,>(xs: readonly T[], i: number, fallback: T): T => xs[i % xs.length] ?? fallback;
const UNBUDGETED: Remaining = { kind: "unbudgeted" };

const outcomeFor = (i: number, config: FanConfig, plan: Plan): FanEvent & { type: "slot-settled" } => {
  const index = mapIndex(i);
  const admission = at(plan.admissions, i, UNBUDGETED);
  const sample = at(plan.costs, i, { tokens: 0, calls: 0, usdMicros: microUsd(0), lowerBound: false });
  if (config.replayedIndices.has(i)) {
    return plan.replayFails.has(i)
      ? { type: "slot-settled", index, admission, outcome: { kind: "failed", error: crash(i) } }
      : { type: "slot-settled", index, admission, outcome: { kind: "replayed", value: `v${i}` } };
  }
  return plan.fails.has(i)
    ? { type: "slot-settled", index, admission, outcome: { kind: "failed", error: crash(i), sample } }
    : { type: "slot-settled", index, admission, outcome: { kind: "completed", value: `v${i}`, sample } };
};

const drive = (config: FanConfig, plan: Plan): Trace => {
  let state = initFan(config);
  let outstanding: readonly number[] = [];
  const steps: Step[] = [];
  const settledSamples: SpendSample[] = [];
  const apply = (event: FanEvent): void => {
    const before = state;
    const { state: after, commands } = fanStep(state, event);
    const started = commands.flatMap((c) => (c.type === "dispatch" || c.type === "replay" ? [c.index as number] : []));
    outstanding = [...outstanding, ...started];
    state = after;
    steps.push({ event, before, after, commands, outstanding: outstanding.length });
  };
  apply({ type: "start", admission: at(plan.admissions, 0, UNBUDGETED) });
  for (let n = 0; !isFanDone(state); n++) {
    if (n > 4 * config.width + 8) return { steps, settledSamples, stalled: true };
    if (plan.abortAt === n) { apply({ type: "abort" }); continue; }
    if (outstanding.length === 0) return { steps, settledSamples, stalled: true };
    const i = at(outstanding, at(plan.picks, n, 0), 0);
    outstanding = outstanding.filter((x) => x !== i);
    const event = outcomeFor(i, config, plan);
    if (event.outcome.kind !== "replayed" && "sample" in event.outcome && event.outcome.sample !== undefined) {
      settledSamples.push(event.outcome.sample);
    }
    apply(event);
  }
  return { steps, settledSamples, stalled: false };
};

const allCommands = (t: Trace): readonly FanCommand[] => t.steps.flatMap((s) => s.commands);
const startsOf = (cs: readonly FanCommand[]) =>
  cs.flatMap((c) => (c.type === "dispatch" || c.type === "replay" ? [c] : []));
const finishesOf = (cs: readonly FanCommand[]) => cs.flatMap((c) => (c.type === "finish" ? [c.finish] : []));
const unreplayedOf = (c: FanConfig): number => c.width - c.replayedIndices.size;

const isBudgeted = (r: Remaining): boolean => r.kind === "budgeted" && r.headroom.length > 0;

/** Index of each dispatch in the flat command stream, paired with its step's admission. */
const dispatchSites = (t: Trace) =>
  t.steps.flatMap((s) => s.commands.flatMap((c, k) => (c.type === "dispatch"
    ? [{ previous: s.commands[k - 1], admission: s.event.type === "abort" ? UNBUDGETED : s.event.admission }]
    : [])));

// ---------------------------------------------------------------------------
// Laws
// ---------------------------------------------------------------------------

const anySeed = fc.option(seedArb, { nil: null, freq: 2 });

describe("LC-1 laws over arbitrary interleavings", () => {
  it("in-flight ≤ C at every step; fan-done only at in-flight 0; never stalls (FR-003)", () => {
    fc.assert(fc.property(configArb(anySeed), planArb(), (config, plan) => {
      const t = drive(config, plan);
      expect(t.stalled).toBe(false);
      for (const s of t.steps) expect(s.outstanding).toBeLessThanOrEqual(config.effective);
      const last = t.steps[t.steps.length - 1];
      expect(last !== undefined && isFanDone(last.after) && last.outstanding).toBe(0);
      expect(finishesOf(allCommands(t))).toHaveLength(1);
    }), RUNS);
  });

  it("starts are strictly ascending, each index once; replayed indices are replayed, never dispatched", () => {
    fc.assert(fc.property(configArb(anySeed), planArb(), (config, plan) => {
      const starts = startsOf(allCommands(drive(config, plan)));
      const indices = starts.map((c) => c.index as number);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(new Set(indices).size).toBe(indices.length);
      for (const c of starts) {
        expect(c.type === "replay").toBe(config.replayedIndices.has(c.index));
        expect(c.index).toBeLessThan(config.width);
      }
    }), RUNS);
  });

  it("unseeded: the first min(C, unreplayed) dispatches are unprojected; every later budgeted dispatch is projected (AS-009, AS-010)", () => {
    fc.assert(fc.property(configArb(fc.constant(null)), planArb(), (config, plan) => {
      const t = drive(config, plan);
      const probe = Math.min(config.effective, unreplayedOf(config));
      const cs = allCommands(t);
      const firstProjection = cs.findIndex((c) => c.type === "emit-projection");
      const dispatchPositions = cs.flatMap((c, k) => (c.type === "dispatch" ? [k] : []));
      for (const k of dispatchPositions.slice(0, probe)) {
        if (firstProjection !== -1) expect(k).toBeLessThan(firstProjection);
      }
      for (const site of dispatchSites(t).slice(probe)) {
        if (isBudgeted(site.admission)) {
          expect(site.previous?.type === "emit-projection" && site.previous.record.verdict).toBe("admit");
        }
      }
    }), RUNS);
  });

  it("seeded and raised: no unprojected dispatch — projection precedes every budgeted dispatch, the first included (AS-056)", () => {
    const arb = seedArb.chain((seed) => fc.tuple(
      configArb(fc.constant(seed)),
      raisedArb(seed).chain((first) => planArb(raisedArb(seed)).map((p) => ({ ...p, admissions: [first, ...p.admissions] }))),
    ));
    fc.assert(fc.property(arb, ([config, plan]) => {
      for (const site of dispatchSites(drive(config, plan))) {
        if (isBudgeted(site.admission)) {
          expect(site.previous?.type === "emit-projection" && site.previous.record.verdict).toBe("admit");
        }
      }
    }), RUNS);
  });

  it("no start once a drain began: after a failure, an abort or a refusal verdict (AS-019, AS-010)", () => {
    fc.assert(fc.property(configArb(anySeed), planArb(), (config, plan) => {
      let draining = false;
      for (const s of drive(config, plan).steps) {
        if (s.event.type === "abort") draining = true;
        if (s.event.type === "slot-settled" && s.event.outcome.kind === "failed") draining = true;
        for (const c of s.commands) {
          if (c.type === "dispatch" || c.type === "replay") expect(draining).toBe(false);
          if (c.type === "emit-projection" && c.record.verdict === "refuse") draining = true;
        }
      }
    }), RUNS);
  });

  it("reduces in index order iff no failure, refusal or abort occurred (SC-003, FR-005, FR-016)", () => {
    fc.assert(fc.property(configArb(anySeed), planArb(), (config, plan) => {
      const t = drive(config, plan);
      const cs = allCommands(t);
      const [finish] = finishesOf(cs);
      const disrupted = t.steps.some((s) => s.event.type === "abort"
        || (s.event.type === "slot-settled" && s.event.outcome.kind === "failed"))
        || cs.some((c) => c.type === "emit-refused");
      expect(finish?.kind).toBe(disrupted ? "fail" : "reduce");
      if (finish?.kind === "reduce") {
        expect(finish.ordered).toEqual(Array.from({ length: config.width }, (_, i) => `v${i}`));
      }
    }), RUNS);
  });

  it("primary = lowest failed index, secondaries complete and ascending, refusal attached when present (SC-006, FR-021, FR-025)", () => {
    fc.assert(fc.property(configArb(anySeed), planArb(), (config, plan) => {
      const t = drive(config, plan);
      const cs = allCommands(t);
      const failedIdx = t.steps.flatMap((s) => (s.event.type === "slot-settled" && s.event.outcome.kind === "failed"
        ? [s.event.index as number] : [])).sort((a, b) => a - b);
      const refused = cs.find((c) => c.type === "emit-refused");
      const [finish] = finishesOf(cs);
      if (failedIdx.length === 0) return;
      if (finish?.kind !== "fail") throw new Error("a failure must fail the fan");
      const error = finish.error;
      if (failedIdx.length === 1 && refused === undefined) {
        expect(error).toEqual(crash(failedIdx[0] ?? -1));
        return;
      }
      if (error.kind !== "fan-child-failed") throw new Error(`expected fan-child-failed, got ${error.kind}`);
      const secondary = error.causes.kind === "refusal" ? [] : error.causes.secondary;
      expect([error.primary, ...secondary].map((f) => f.index as number)).toEqual(failedIdx);
      const attached = error.causes.kind === "secondaries" ? null : error.causes.refusal;
      expect(attached).toEqual(refused?.type === "emit-refused" ? refused.refusal : null);
      expect(refused?.type === "emit-refused" && refused.attachedToChildFailure).toBe(refused !== undefined);
    }), RUNS);
  });

  it("a refusal counts every saved child, drain completions included (FR-022), and is persisted before finish (FR-026)", () => {
    fc.assert(fc.property(configArb(anySeed), planArb(), (config, plan) => {
      const t = drive(config, plan);
      const cs = allCommands(t);
      const tail = cs.slice(-3).map((c) => c.type);
      const refused = cs.find((c) => c.type === "emit-refused");
      const persisted = cs.filter((c) => c.type === "persist-seed");
      if (refused === undefined || refused.type !== "emit-refused") {
        expect(persisted).toEqual([]);
        return;
      }
      expect(tail).toEqual(["emit-refused", "persist-seed", "finish"]);
      const completions = t.steps.filter((s) => s.event.type === "slot-settled" && s.event.outcome.kind === "completed").length;
      const replayFailures = t.steps.filter((s) => s.event.type === "slot-settled" && s.event.outcome.kind === "failed"
        && config.replayedIndices.has(s.event.index)).length;
      const completed = config.replayedIndices.size - replayFailures + completions;
      expect(refused.refusal.completed).toBe(completed);
      expect(refused.refusal.remaining).toBe(config.width - completed);
      const seed = persisted[0]?.type === "persist-seed" ? persisted[0].seed : null;
      expect(seed?.refusal).toEqual(refused.refusal);
      expect(seed?.samples).toEqual([...(config.seed?.samples ?? []), ...t.settledSamples]);
      const parsed = FanRefusalSeedSchema.safeParse(JSON.parse(JSON.stringify(seed)));
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(JSON.parse(JSON.stringify(seed)));
    }), RUNS);
  });

  it("fan-done is absorbing: every later event returns the same state and no commands", () => {
    const eventArb: fc.Arbitrary<FanEvent> = fc.oneof(
      remainingArb.map((admission): FanEvent => ({ type: "start", admission })),
      fc.constant<FanEvent>({ type: "abort" }),
      fc.tuple(fc.nat(20), remainingArb, sampleArb).map(([i, admission, sample]): FanEvent =>
        ({ type: "slot-settled", index: mapIndex(i), admission, outcome: { kind: "completed", value: i, sample } })),
    );
    fc.assert(fc.property(configArb(anySeed), planArb(), fc.array(eventArb, { maxLength: 6 }), (config, plan, extra) => {
      const t = drive(config, plan);
      const done = t.steps[t.steps.length - 1]?.after;
      if (done === undefined) throw new Error("empty trace");
      for (const e of extra) {
        const next = fanStep(done, e);
        expect(next.state).toBe(done);
        expect(next.commands).toEqual([]);
      }
    }), RUNS);
  });
});

describe("sticky refusal (AD-11, SC-008 core, FR-017)", () => {
  it("seed + ceilings not raised + unreplayed > 0 ⇒ 0 dispatches and fan-budget-refused, for any remainder and samples", () => {
    const arb = seedArb.chain((seed) => fc.tuple(
      configArb(fc.constant(seed)).filter((c) => unreplayedOf(c) > 0),
      notRaisedArb(seed),
    ));
    fc.assert(fc.property(arb, ([config, admission]) => {
      const { state, commands } = fanStep(initFan(config), { type: "start", admission });
      expect(commands.map((c) => c.type)).toEqual(["emit-refused", "persist-seed", "finish"]);
      expect(isFanDone(state)).toBe(true);
      const [refused, , finish] = commands;
      if (refused?.type !== "emit-refused" || finish?.type !== "finish" || finish.finish.kind !== "fail") throw new Error("shape");
      expect(refused.sticky).toBe(true);
      const error = finish.finish.error;
      if (error.kind !== "fan-budget-refused") throw new Error(error.kind);
      expect(error.refusal).toMatchObject({
        completed: config.replayedIndices.size,
        remaining: unreplayedOf(config),
        effectiveConcurrency: config.effective,
        axis: config.seed?.refusal.axis,
      });
      const seeded = config.seed?.estimate;
      const onAxis = { usd: seeded?.usdMicros, tokens: seeded?.tokens, calls: seeded?.calls }[error.refusal.axis];
      expect(error.refusal.perChildEstimate).toBe(onAxis ?? -1);
    }), RUNS);
  });

  it("is deterministic: the same seed and snapshot refuse identically on every resume", () => {
    const arb = seedArb.chain((seed) => fc.tuple(
      configArb(fc.constant(seed)).filter((c) => unreplayedOf(c) > 0),
      notRaisedArb(seed),
    ));
    fc.assert(fc.property(arb, ([config, admission]) => {
      const a = fanStep(initFan(config), { type: "start", admission }).commands;
      const b = fanStep(initFan(config), { type: "start", admission }).commands;
      expect(a).toEqual(b);
    }), RUNS);
  });
});

describe("C = 1 is the sequential fan (FR-004)", () => {
  it("starts 0, 1, 2, … one at a time and stops at the first failure", () => {
    const arb = configArb(fc.constant(null)).map((c) => ({ ...c, effective: childConcurrency(1) }));
    fc.assert(fc.property(arb, planArb(fc.constant<Remaining>(UNBUDGETED)).map((p) => ({ ...p, abortAt: null })), (config, plan) => {
      const t = drive(config, plan);
      for (const s of t.steps) expect(s.outstanding).toBeLessThanOrEqual(1);
      const indices = startsOf(allCommands(t)).map((c) => c.index as number);
      expect(indices).toEqual(indices.map((_, k) => k));
      const firstFailure = Array.from({ length: config.width }, (_, i) => i).find((i) =>
        config.replayedIndices.has(i) ? plan.replayFails.has(i) : plan.fails.has(i));
      expect(indices.length).toBe(firstFailure === undefined ? config.width : firstFailure + 1);
    }), RUNS);
  });
});
