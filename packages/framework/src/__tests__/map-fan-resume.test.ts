// map-fan-resume — what a fan does on the run AFTER the one that stopped it
// (F1 PR-D T11): resume after a projection refusal (the AD-11 refusal seed),
// after a budget-raising redeploy, after a failure or abort drain, across a
// reroute, and over a corrupt store. Plus the projection surface a refusal is
// built from: lower-bound and unbudgeted axes, the estimators, the FR-018
// overshoot bounds, and the host per-call meter that stays the hard stop.
//
// Every scenario drives the real shell (`runMappedFan`) through the
// deterministic harness: children are hand-settled deferreds, spend is a
// scripted run-wide timeline, and `budget.redeploy` swaps the ceilings in
// force exactly as a redeploy of the DAG's budget would. A "resume" is a
// second fan over the SAME checkpointer, as the next slice of the run is.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { z } from "zod";
import { InMemoryCheckpointer, type Checkpointer } from "../checkpoint/checkpointer.js";
import { dagFingerprint } from "../checkpoint/fingerprint.js";
import { defineDag, runDag } from "../executor/index.js";
import { createFileCheckpointer } from "../file/checkpointer.js";
import { keyDigest } from "../file/layout.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createMapNode } from "../nodes/map.js";
import { makeNodeContext } from "../shared/make-node-context.js";
import type { Ceiling } from "../types/budget.js";
import { formatFrameworkError } from "../types/errors.js";
import { FanRefusalSeedSchema, type FanEstimator, type FanRefusal, type FanRefusalSeed } from "../types/fan-scheduling.js";
import { DAG_INPUT } from "../types/ids.js";
import { ok } from "../types/result.js";
import { makeSpend, microUsd, unpricedModel, type Spend } from "../types/spend.js";
import {
  FAN,
  RUN,
  START_MS,
  callsCeiling,
  childError,
  cost,
  drive,
  errorOf,
  failChild,
  fanHarness,
  okChild,
  presave,
  quiesce,
  range,
  refusalOf,
  scriptedBudget,
  tenfold,
  tokensCeiling,
  type ChildPlan,
  type FanHarness,
  type ScriptedBudget,
} from "./fan-test-harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED_KEY = "fan-seed@fan@0@0";

/** Each child costs `costs[i]` calls (1 when unlisted) and returns `i × 10`. */
const costedBy = (costs: readonly number[]) => (i: number): ChildPlan => okChild(i * 10, cost({ calls: costs[i] ?? 1 }));

const seedIn = async (cp: Checkpointer, key = SEED_KEY): Promise<FanRefusalSeed> => {
  const loaded = await cp.load(RUN);
  const entry = loaded.ok ? loaded.value?.nodes[key] : undefined;
  return FanRefusalSeedSchema.parse(entry?.output);
};

const savedIndices = async (cp: Checkpointer, epoch = 0): Promise<number[]> => {
  const loaded = await cp.load(RUN);
  const keys = loaded.ok ? Object.keys(loaded.value?.nodes ?? {}) : [];
  const suffix = `@${epoch}`;
  return keys
    .filter((k) => k.startsWith("dag@fan@") && k.endsWith(suffix))
    .map((k) => Number(k.split("@")[2]))
    .sort((a, b) => a - b);
};

const dispatchesIn = (h: FanHarness): string[] => h.trace.filter((t) => t.startsWith("dispatch:"));

type RefusedRun = Readonly<{ cp: Checkpointer; budget: ScriptedBudget; first: FanHarness; refusal: FanRefusal }>;

/** Run a fan to a projection refusal; the store and budget are the next slice's. */
const refusedRun = async (o: Readonly<{
  width: number;
  c: number;
  costs: readonly number[];
  ceilings: readonly Ceiling[];
  cp?: Checkpointer;
  choose?: (open: readonly number[]) => number;
}>): Promise<RefusedRun> => {
  const cp = o.cp ?? new InMemoryCheckpointer({ now: () => START_MS });
  const budget = scriptedBudget(o.ceilings);
  const first = fanHarness({ width: o.width, childConcurrency: o.c, budget, checkpointer: cp });
  const result = await drive(first, first.start(), costedBy(o.costs), o.choose);
  return { cp, budget, first, refusal: refusalOf(result) };
};

/** The next slice of the same run: same store, same budget, same epoch. */
const resume = (r: RefusedRun, o: Readonly<{ width: number; c: number; costs: readonly number[]; estimator?: FanEstimator }>) =>
  fanHarness({
    width: o.width, childConcurrency: o.c, budget: r.budget, checkpointer: r.cp, auto: costedBy(o.costs),
    ...(o.estimator !== undefined ? { estimator: o.estimator } : {}),
  });

/** Assert the AD-11 sticky refusal: same kind and refusal, 0 dispatches, 0 spend. */
const expectStickyRefusal = async (r: RefusedRun, o: Readonly<{ width: number; c: number; costs: readonly number[] }>) => {
  const spentBefore = r.budget.spent();
  const resumed = resume(r, o);
  const again = refusalOf(await resumed.start());
  expect(resumed.dispatched).toEqual([]);
  expect(dispatchesIn(resumed)).toEqual([]);
  // The same refusal, field for field: no ceiling moved, so nothing about it may differ.
  expect(again).toEqual(r.refusal);
  expect(r.budget.spent()).toEqual(spentBefore);
  expect(resumed.eventsOf("fan-start")[0]).toMatchObject({ seeded: true, replayed: r.refusal.completed });
  expect(resumed.eventsOf("fan-refused")).toEqual([expect.objectContaining({ sticky: true, attachedToChildFailure: false })]);
  expect(resumed.eventsOf("fan-projection")).toEqual([]);
  expect(resumed.pendingAtReturn).toBe(0);
  return { resumed, again };
};

// ---------------------------------------------------------------------------
// AS-014 / AS-056 / SC-008: resume without a redeploy refuses again
// ---------------------------------------------------------------------------

describe("resume after a refusal, no redeploy (FR-017, FR-026, SC-008)", () => {
  it("AS-014: a remainder larger than C refuses again with 0 dispatches", async () => {
    const shape = { width: 10, c: 2, costs: range(10, () => 1) };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(4)] });
    expect(r.refusal.remaining).toBeGreaterThan(shape.c);
    await expectStickyRefusal(r, shape);
  });

  it("AS-014: a remainder of C or fewer refuses again — the probe that would fit is never spent", async () => {
    const shape = { width: 5, c: 4, costs: range(5, () => 1) };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(4)] });
    // Only the probe batch (4) ran; 1 index is left — an unseeded resume would
    // dispatch it unprojected. The seed makes the refusal sticky instead.
    expect(r.refusal).toMatchObject({ completed: 4, remaining: 1 });
    expect(r.refusal.remaining).toBeLessThanOrEqual(shape.c);
    await expectStickyRefusal(r, shape);
  });

  it("AS-014: non-constant per-child costs refuse again, and the resumed fan never re-dispatches a saved child", async () => {
    const shape = { width: 8, c: 2, costs: [2, 1, 7, 1, 3, 1, 1, 5] };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(10)] });
    const saved = await savedIndices(r.cp);
    expect(saved.length).toBe(r.refusal.completed);
    const { resumed } = await expectStickyRefusal(r, shape);
    for (const i of saved) expect(resumed.dispatched).not.toContain(i);
  });

  it("AS-014: property — for arbitrary widths, C, cost vectors, ceilings and completion orders, every resume refuses with 0 dispatches", async () => {
    let refusals = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }).chain((c) => fc.record({
          c: fc.constant(c),
          costs: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: c + 1, maxLength: 12 }),
          ceilingShare: fc.double({ min: 0.05, max: 0.9, noNaN: true }),
          picks: fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 16 }),
        })),
        async ({ c, costs, ceilingShare, picks }) => {
          const total = costs.reduce((a, b) => a + b, 0);
          const ceiling = Math.max(1, Math.floor(total * ceilingShare));
          let k = 0;
          const choose = (open: readonly number[]) => open[(picks[k++ % picks.length] ?? 0) % open.length] ?? -1;
          const cp = new InMemoryCheckpointer({ now: () => START_MS });
          const budget = scriptedBudget([callsCeiling(ceiling)]);
          const first = fanHarness({ width: costs.length, childConcurrency: c, budget, checkpointer: cp });
          const result = await drive(first, first.start(), costedBy(costs), choose);
          // A fan whose remaining children all fit the probe batch may legitimately finish.
          if (result.ok || result.error.kind !== "fan-budget-refused") return;
          refusals += 1;
          const r: RefusedRun = { cp, budget, first, refusal: result.error.refusal };
          const spentBefore = budget.spent();
          // Twice: a sticky refusal stays sticky (it re-persists the same seed).
          for (const _ of [1, 2]) {
            const resumed = resume(r, { width: costs.length, c, costs });
            const again = refusalOf(await resumed.start());
            expect(resumed.dispatched).toEqual([]);
            expect(again).toMatchObject({ completed: r.refusal.completed, remaining: r.refusal.remaining, axis: "calls" });
          }
          expect(budget.spent()).toEqual(spentBefore);
        },
      ),
      { numRuns: 120 },
    );
    expect(refusals).toBeGreaterThan(30);
  });
});

describe("the refusal seed (AD-11, AS-056)", () => {
  it("AS-056: once the drain completes, the seed holds estimator, every sample (drain completions included), estimate and ceilings", async () => {
    const budget = scriptedBudget([callsCeiling(10)]);
    const cp = new InMemoryCheckpointer({ now: () => START_MS });
    const h = fanHarness({ width: 6, childConcurrency: 2, budget, checkpointer: cp });
    const run = h.start();
    await quiesce();
    h.settle(0, okChild(0, cost({ calls: 4 })));
    await quiesce();
    // Refused (5 × 4 > 6 left) while index 1 is still in flight: no seed yet.
    expect(h.eventsOf("fan-projection").at(-1)).toMatchObject({ verdict: "refuse" });
    expect(h.trace).not.toContain(`save:${SEED_KEY}`);
    h.settle(1, okChild(10, cost({ calls: 1 })));
    const refusal = refusalOf(await run);
    const seed = await seedIn(cp);
    expect(seed).toMatchObject({
      version: 1,
      estimator: "largest-seen",
      estimate: { calls: 4 },
      ceilings: [{ kind: "calls", limit: 10 }],
      refusal,
    });
    // Index 1's sample is its lifetime window (dispatch → settle): it saw index
    // 0's 4 calls too, so it over-counts (5) — never under-counts (FR-018 M).
    expect(seed.samples.map((s) => s.calls)).toEqual([4, 5]);
    expect(refusal).toMatchObject({ completed: 2, remaining: 4 });
  });

  it("AS-056: a resume in the same epoch loads and evaluates the seed BEFORE any dispatch", async () => {
    const shape = { width: 6, c: 3, costs: range(6, () => 2) };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(5)] });
    const resumed = resume(r, shape);
    await resumed.start();
    // load → (sticky refusal re-persists the seed) → return. Nothing is dispatched, no metadata seeded.
    expect(resumed.trace).toEqual(["load", `save:${SEED_KEY}`, "return"]);
    expect(resumed.spanAttributes).toMatchObject({ "fugue.fan.seeded": true });
  });

  it("AS-056: after a ceiling raise the seeded estimate is projected before EVERY dispatch — there is no unprojected probe", async () => {
    const shape = { width: 12, c: 4, costs: range(12, () => 1) };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(5)] });
    r.budget.redeploy([callsCeiling(100)]);
    const resumed = resume(r, shape);
    expect(await resumed.start()).toEqual(ok(range(12)));
    const unsaved = shape.width - r.refusal.completed;
    expect(resumed.dispatched).toHaveLength(unsaved);
    expect(unsaved).toBeGreaterThan(shape.c);
    const projections = resumed.eventsOf("fan-projection");
    expect(projections.every((e) => e.verdict === "admit")).toBe(true);
    expect(projections).toHaveLength(resumed.dispatched.length);
    // The first projection, before any child of this slice settled, already
    // estimates from the SEEDED samples (largest-seen over them, drain windows included).
    const seeded = Math.max(...(await seedIn(r.cp)).samples.map((s) => s.calls));
    expect(projections[0]).toMatchObject({ estimate: seeded, remainingChildren: unsaved });

    // Control: the same fan unseeded probes C children with no projection.
    const fresh = fanHarness({ width: 12, childConcurrency: 4, budget: scriptedBudget([callsCeiling(100)]), auto: costedBy(shape.costs) });
    await fresh.start();
    expect(fresh.eventsOf("fan-projection")).toHaveLength(fresh.dispatched.length - shape.c);
  });

  it("AS-056: an insufficient raise proceeds only while projection admits, then refuses with a refreshed seed", async () => {
    const shape = { width: 10, c: 2, costs: range(10, () => 1) };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(4)] });
    const before = await seedIn(r.cp);
    // Enough for the seeded estimate (largest drain window, 2) over the 8 left: 2 + 8 × 2 ≤ 20.
    r.budget.redeploy([callsCeiling(20)]);
    // Index 2 now spikes to 5 calls: admitted on the seeded estimate, it raises the estimate.
    const resumed = resume(r, { ...shape, costs: [1, 1, 5, 1, 1, 1, 1, 1, 1, 1] });
    const refusal = refusalOf(await resumed.start());
    expect(resumed.dispatched.length).toBeGreaterThan(0);
    expect(resumed.dispatched.length).toBeLessThan(shape.width - r.refusal.completed);
    const projections = resumed.eventsOf("fan-projection");
    expect(projections.filter((e) => e.verdict === "admit")).toHaveLength(resumed.dispatched.length);
    expect(projections.at(-1)).toMatchObject({ verdict: "refuse" });
    expect(resumed.eventsOf("fan-refused")).toEqual([expect.objectContaining({ sticky: false })]);
    const after = await seedIn(r.cp);
    expect(after.samples.length).toBe(before.samples.length + resumed.dispatched.length);
    expect(after.ceilings).toEqual([{ kind: "calls", limit: 20 }]);
    expect(after.refusal).toEqual(refusal);
  });
});

// ---------------------------------------------------------------------------
// AS-015 / FR-051: a budget-raising redeploy completes, reusing every save
// ---------------------------------------------------------------------------

describe("resume after a budget-raising redeploy (AS-015, FR-050, FR-051)", () => {
  it("AS-015: a raised ceiling completes the fan; only unsaved indices dispatch, each exactly once", async () => {
    const shape = { width: 9, c: 3, costs: [3, 1, 2, 1, 1, 2, 1, 1, 1] };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(6)] });
    const saved = await savedIndices(r.cp);
    expect(saved).toHaveLength(r.refusal.completed);
    r.budget.redeploy([callsCeiling(1_000)]);
    const resumed = resume(r, shape);
    expect(await resumed.start()).toEqual(ok(range(9)));
    expect([...resumed.dispatched].sort((a, b) => a - b)).toEqual(range(9, (i) => i).filter((i) => !saved.includes(i)));
    expect(new Set(resumed.dispatched).size).toBe(resumed.dispatched.length);
    expect(resumed.reductions).toEqual([range(9)]);
    expect(resumed.eventsOf("fan-start")[0]).toMatchObject({ seeded: true, replayed: saved.length });
  });

  it("AS-015: end to end through runDag — a redeployed DAG (new scheduling, larger budget) keeps its fingerprint and reuses every saved child", async () => {
    const dispatched: number[] = [];
    const budget = scriptedBudget([callsCeiling(3)]);
    const dagWith = (scheduling: Readonly<{ childConcurrency: number; estimator: FanEstimator }>) => {
      const work = createFetchNode({
        id: "work", inputSchema: z.number(), outputSchema: z.number(),
        fetch: async (n) => { dispatched.push(n); budget.charge(cost({ calls: 1 })); return ok(n * 10); },
      });
      const child = defineDag({ id: "child", nodes: { work }, edges: [{ from: DAG_INPUT, to: "work" }], outputNodeId: "work" });
      const fan = createMapNode({
        id: "fan", inputSchema: z.object({ items: z.array(z.number()) }), outputSchema: z.array(z.number()),
        widthFrom: "items", maxWidth: 16, child, childOutputSchema: z.number(), reduce: (xs) => ok([...xs]), ...scheduling,
      });
      return defineDag({ id: "outer", nodes: { fan }, edges: [{ from: DAG_INPUT, to: "fan" }], outputNodeId: "fan" });
    };
    const cp = new InMemoryCheckpointer();
    const ctx = makeNodeContext({ runId: RUN, dagId: "outer", capabilities: { checkpointer: cp }, budget: budget.capability });
    const items = { items: range(8, (i) => i) };
    const v1 = dagWith({ childConcurrency: 2, estimator: "largest-seen" });

    const refused = await runDag(v1, items, ctx);
    expect(errorOf(refused).kind).toBe("fan-budget-refused");
    const firstSlice = [...dispatched];
    expect(await runDag(v1, items, ctx)).toEqual(refused);
    expect(dispatched).toEqual(firstSlice);

    // The redeploy: a retuned fan AND a larger budget. Scheduling is not structure (FR-051).
    const v2 = dagWith({ childConcurrency: 4, estimator: "p90" });
    expect(dagFingerprint(v2)).toBe(dagFingerprint(v1));
    budget.redeploy([callsCeiling(100)]);
    expect(await runDag(v2, items, ctx)).toEqual(ok(range(8)));
    const secondSlice = dispatched.slice(firstSlice.length);
    expect([...firstSlice, ...secondSlice].sort((a, b) => a - b)).toEqual(range(8, (i) => i));
  });
});

// ---------------------------------------------------------------------------
// AS-024 / SC-007 / AS-004: drain-saved children are reused, reduce stays ordered
// ---------------------------------------------------------------------------

describe("resume after a failure or abort drain (AS-024, SC-007, FR-050)", () => {
  it("AS-024: every index saved during a failure drain is reused and never re-dispatched", async () => {
    const cp = new InMemoryCheckpointer();
    const first = fanHarness({ width: 8, childConcurrency: 3, checkpointer: cp });
    const run = first.start();
    await quiesce();
    first.settle(1, failChild(childError(1)));
    await quiesce();
    first.settle(2, tenfold(2));
    first.settle(0, tenfold(0));
    expect(await run).toEqual({ ok: false, error: childError(1) });
    expect(await savedIndices(cp)).toEqual([0, 2]);
    const resumed = fanHarness({ width: 8, childConcurrency: 3, checkpointer: cp, auto: tenfold });
    expect(await resumed.start()).toEqual(ok(range(8)));
    expect(resumed.dispatched).toEqual([1, 3, 4, 5, 6, 7]);
  });

  it("AS-024: every index saved during an abort drain is reused and never re-dispatched", async () => {
    const cp = new InMemoryCheckpointer();
    const first = fanHarness({ width: 7, childConcurrency: 3, checkpointer: cp });
    const run = first.start();
    await quiesce();
    first.abort();
    for (const i of [2, 0, 1]) first.settle(i, tenfold(i));
    expect(errorOf(await run).kind).toBe("aborted");
    expect(await savedIndices(cp)).toEqual([0, 1, 2]);
    const resumed = fanHarness({ width: 7, childConcurrency: 3, checkpointer: cp, auto: tenfold });
    expect(await resumed.start()).toEqual(ok(range(7)));
    expect(resumed.dispatched).toEqual([3, 4, 5, 6]);
  });

  it("AS-022: an abort landing after every child settled but before the reduce decision returns aborted and never reduces; the resume reduces with 0 dispatches", async () => {
    const cp = new InMemoryCheckpointer();
    let abort = (): void => {};
    // The abort lands DURING the final completion's save: every child has
    // settled, the reduce decision has not been taken yet.
    const first = fanHarness({
      width: 4, childConcurrency: 2, checkpointer: cp,
      failSave: (key) => { if (key === "dag@fan@3@0") abort(); return undefined; },
    });
    abort = first.abort;
    const run = first.start();
    expect(await drive(first, run, tenfold)).toEqual({ ok: false, error: { kind: "aborted", reason: "signal" } });
    expect(first.dispatched).toEqual([0, 1, 2, 3]);
    expect(first.reductions).toEqual([]);
    expect(first.pendingAtReturn).toBe(0);
    expect(await savedIndices(cp)).toEqual([0, 1, 2, 3]);
    const resumed = fanHarness({ width: 4, childConcurrency: 2, checkpointer: cp, auto: tenfold });
    expect(await resumed.start()).toEqual(ok(range(4)));
    expect(resumed.dispatched).toEqual([]);
    expect(resumed.reductions).toEqual([range(4)]);
  });

  it("AS-024: property — any failure set and completion order, the resume dispatches exactly the unsaved indices", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.nat({ max: 9 }), { maxLength: 3 }),
        fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 12 }),
        async (c, width, failAt, picks) => {
          const cp = new InMemoryCheckpointer();
          const failing = new Set(failAt.filter((i) => i < width));
          let k = 0;
          const first = fanHarness({ width, childConcurrency: c, checkpointer: cp });
          await drive(first, first.start(), (i) => (failing.has(i) ? failChild(childError(i)) : tenfold(i)),
            (open) => open[(picks[k++ % picks.length] ?? 0) % open.length] ?? -1);
          const saved = await savedIndices(cp);
          const resumed = fanHarness({ width, childConcurrency: c, checkpointer: cp, auto: tenfold });
          expect(await resumed.start()).toEqual(ok(range(width)));
          expect([...resumed.dispatched].sort((a, b) => a - b)).toEqual(range(width, (i) => i).filter((i) => !saved.includes(i)));
        },
      ),
      { numRuns: 150 },
    );
  });

  it("AS-004: a fan resumed over out-of-order completions reduces in index order, identical to an uninterrupted run", async () => {
    const cp = new InMemoryCheckpointer();
    const first = fanHarness({ width: 6, childConcurrency: 3, checkpointer: cp });
    const run = first.start();
    await quiesce();
    first.settle(2, tenfold(2));
    await quiesce();
    first.settle(0, tenfold(0));
    await quiesce();
    first.settle(1, failChild(childError(1)));
    await quiesce();
    for (const i of first.openIndices().reverse()) first.settle(i, tenfold(i));
    await run;
    // Saved out of order, with a gap at index 1.
    expect(first.trace.filter((t) => t.startsWith("save:dag@"))).toEqual(
      ["save:dag@fan@2@0", "save:dag@fan@0@0", "save:dag@fan@4@0", "save:dag@fan@3@0"]);

    const resumed = fanHarness({ width: 6, childConcurrency: 3, checkpointer: cp, auto: tenfold });
    const uninterrupted = fanHarness({ width: 6, childConcurrency: 3, auto: tenfold });
    expect(await resumed.start()).toEqual(await uninterrupted.start());
    expect(resumed.dispatched).toEqual([1, 5]);
    expect(resumed.reductions).toEqual(uninterrupted.reductions);
    expect(resumed.reductions).toEqual([range(6)]);
  });
});

// ---------------------------------------------------------------------------
// AS-008: a reroute advances the epoch — prior saves and the prior seed are not read
// ---------------------------------------------------------------------------

describe("reroute (AS-008, FR-007, FR-026)", () => {
  it("AS-008: a new execution epoch ignores the prior epoch's completions AND its refusal seed", async () => {
    const shape = { width: 6, c: 2, costs: range(6, () => 1) };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(3)] });
    expect((await savedIndices(r.cp, 0)).length).toBeGreaterThan(0);
    await seedIn(r.cp);

    const rerouted = fanHarness({
      width: 6, childConcurrency: 2, checkpointer: r.cp, epoch: 1,
      budget: scriptedBudget([callsCeiling(100)]), auto: costedBy(shape.costs),
    });
    expect(await rerouted.start()).toEqual(ok(range(6)));
    expect(rerouted.eventsOf("fan-start")[0]).toMatchObject({ seeded: false, replayed: 0 });
    expect(rerouted.dispatched).toEqual(range(6, (i) => i));
    expect(rerouted.scopes.every((s) => s.executionEpoch === 1)).toBe(true);
    expect(await savedIndices(r.cp, 1)).toEqual(range(6, (i) => i));
    // Unseeded: the probe batch of C runs unprojected again.
    expect(rerouted.eventsOf("fan-projection")).toHaveLength(6 - 2);
  });

  it("AS-008: the prior epoch's seed is not sticky — the same ceiling in a new epoch probes again instead of refusing", async () => {
    const shape = { width: 6, c: 2, costs: range(6, () => 1) };
    const r = await refusedRun({ ...shape, ceilings: [callsCeiling(3)] });
    const rerouted = fanHarness({
      width: 6, childConcurrency: 2, checkpointer: r.cp, epoch: 1, budget: scriptedBudget([callsCeiling(3)]), auto: costedBy(shape.costs),
    });
    const again = refusalOf(await rerouted.start());
    // A fresh refusal of the new epoch (not the sticky one): the probe was spent.
    expect(rerouted.dispatched.length).toBeGreaterThanOrEqual(2);
    expect(rerouted.eventsOf("fan-refused")).toEqual([expect.objectContaining({ sticky: false })]);
    expect(again.completed).toBe(rerouted.dispatched.length);
    expect(await seedIn(r.cp, "fan-seed@fan@0@1")).toMatchObject({ refusal: again });
  });
});

// ---------------------------------------------------------------------------
// SC-009 / AS-006: corruption refuses the whole fan before anything starts
// ---------------------------------------------------------------------------

describe("corruption on resume (FR-008, SC-009)", () => {
  let dir = "";
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "fan-resume-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Overwrite the stored bytes of `nodeKey` in a file-checkpointer store. */
  const corrupt = (store: string, nodeKey: string): void => {
    const name = `${keyDigest(nodeKey)}.json`;
    const hits = readdirSync(store, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(name));
    expect(hits).toHaveLength(1);
    writeFileSync(join(store, hits[0] ?? ""), "{ this is not a checkpoint record");
  };

  it("AS-006: a corrupt refusal seed refuses the whole fan with 0 dispatches", async () => {
    const store = join(dir, "seed");
    const cp = createFileCheckpointer(store, { now: () => START_MS });
    const shape = { width: 6, c: 2, costs: range(6, () => 1) };
    const r = await refusedRun({ ...shape, cp, ceilings: [callsCeiling(3)] });
    corrupt(store, SEED_KEY);
    // Even a raised ceiling cannot read past corruption.
    r.budget.redeploy([callsCeiling(100)]);
    const resumed = resume(r, shape);
    expect(errorOf(await resumed.start())).toMatchObject({ kind: "checkpoint-corrupt", nodeId: FAN });
    expect(resumed.dispatched).toEqual([]);
    expect(resumed.trace).toEqual(["load", "return"]);
    expect(resumed.events).toEqual([]);
  });

  it("AS-006: a corrupt child completion at C>1 refuses the whole fan with 0 dispatches", async () => {
    const store = join(dir, "child");
    const cp = createFileCheckpointer(store, { now: () => START_MS });
    const first = fanHarness({ width: 8, childConcurrency: 4, checkpointer: cp });
    const run = first.start();
    await quiesce();
    first.abort();
    for (const i of first.openIndices()) first.settle(i, tenfold(i));
    await run;
    corrupt(store, "dag@fan@2@0");
    const resumed = fanHarness({ width: 8, childConcurrency: 4, checkpointer: cp, auto: tenfold });
    expect(errorOf(await resumed.start())).toMatchObject({ kind: "checkpoint-corrupt", nodeId: FAN });
    expect(resumed.dispatched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The probe batch, projection axes, estimators, overshoot and the meter
// ---------------------------------------------------------------------------

describe("the unprojected probe batch (FR-010, AS-009)", () => {
  for (const [width, c, presaved] of [[8, 3, [1, 4]], [5, 4, [0, 1, 2]], [4, 8, []]] as const) {
    it(`AS-009: unseeded, width ${width}, C=${c}, ${presaved.length} replayed — the first min(C, remaining) dispatches are unprojected`, async () => {
      const cp = new InMemoryCheckpointer();
      if (presaved.length > 0) await presave(cp, presaved, (i) => i * 10);
      const h = fanHarness({ width, childConcurrency: c, checkpointer: cp, budget: scriptedBudget([callsCeiling(1_000)]),
        auto: (i) => okChild(i * 10, cost({ calls: 1 })) });
      expect(await h.start()).toEqual(ok(range(width)));
      const remaining = width - presaved.length;
      expect(h.dispatched).toHaveLength(remaining);
      expect(h.eventsOf("fan-projection")).toHaveLength(remaining - Math.min(c, remaining));
    });
  }
});

describe("lower-bound and unbudgeted axes (FR-013, AS-016, AS-017)", () => {
  const unknownUsage = (tokens: number): Spend =>
    makeSpend({ usage: "unknown", tokens, calls: 1, usd: { kind: "priced", micros: microUsd(0) } });
  const unpriced = (knownMicros: number): Spend =>
    makeSpend({ usage: "known", tokens: 0, calls: 1, usd: { kind: "unpriced", models: unpricedModel("mystery-model"), knownMicros: microUsd(knownMicros) } });

  it("AS-016: an unknown-usage axis refuses once the known lower bound alone breaches, and says true spend may be higher", async () => {
    const budget = scriptedBudget([tokensCeiling(200)]);
    const h = fanHarness({ width: 6, budget });
    const refusal = refusalOf(await drive(h, h.start(), (i) => okChild(i * 10, unknownUsage(50))));
    expect(refusal).toMatchObject({ axis: "tokens", ceiling: { kind: "tokens", limit: 200 }, lowerBound: true, completed: 1 });
    expect(h.eventsOf("fan-projection").at(-1)).toMatchObject({ verdict: "refuse", lowerBound: true });
    expect(formatFrameworkError({ kind: "fan-budget-refused", nodeId: FAN, refusal })).toContain("true spend may be higher");
  });

  it("AS-016: an unpriced USD axis refuses on the priced floor alone, flagged as a lower bound", async () => {
    const budget = scriptedBudget([{ kind: "usd", limit: microUsd(1_000) }]);
    const h = fanHarness({ width: 5, budget });
    const refusal = refusalOf(await drive(h, h.start(), (i) => okChild(i * 10, unpriced(300))));
    expect(refusal).toMatchObject({ axis: "usd", lowerBound: true, perChildEstimate: 300 });
    expect(refusal.hint).toContain("redeploy");
  });

  it("AS-017: an unbudgeted axis is never projected — huge token spend under a calls-only ceiling completes", async () => {
    const budget = scriptedBudget([callsCeiling(100)]);
    const h = fanHarness({ width: 6, childConcurrency: 2, budget, auto: (i) => okChild(i * 10, cost({ calls: 1, tokens: 1_000_000 })) });
    expect(await h.start()).toEqual(ok(range(6)));
    const projections = h.eventsOf("fan-projection");
    expect(projections.length).toBeGreaterThan(0);
    expect(projections.every((e) => e.axis === "calls" && e.verdict === "admit")).toBe(true);
  });

  it("AS-017: with no budget capability at all, no projection is applied on any axis", async () => {
    const h = fanHarness({ width: 6, childConcurrency: 2, auto: (i) => okChild(i * 10, cost({ calls: 50, tokens: 1_000_000 })) });
    expect(await h.start()).toEqual(ok(range(6)));
    expect(h.eventsOf("fan-projection")).toEqual([]);
    expect(h.eventsOf("fan-refused")).toEqual([]);
  });
});

describe("estimators through the shell (FR-046, AS-040..AS-042)", () => {
  /** Five 1-call children, then 3-call ones: largest-seen and p50 disagree from the 6th settle on. */
  const COSTS = [1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3];

  it("AS-040: with no estimator chosen, the per-child estimate is the largest spend seen so far", async () => {
    const h = fanHarness({ width: COSTS.length, budget: scriptedBudget([callsCeiling(14)]) });
    const refusal = refusalOf(await drive(h, h.start(), costedBy(COSTS)));
    expect(refusal).toMatchObject({ estimatorApplied: "largest-seen", perChildEstimate: 3 });
    expect(h.eventsOf("fan-start")[0]).toMatchObject({ estimator: "largest-seen" });
  });

  it("AS-041: p50 with at least 5 settled children projects the 50th percentile and names it", async () => {
    const h = fanHarness({ width: COSTS.length, estimator: "p50", budget: scriptedBudget([callsCeiling(14)]) });
    const refusal = refusalOf(await drive(h, h.start(), costedBy(COSTS)));
    // Seven settled ([1,1,1,1,1,3,3]): nearest-rank p50 is 1, where largest-seen would say 3.
    expect(refusal).toMatchObject({ estimatorApplied: "p50", perChildEstimate: 1, completed: 7 });
    const projections = h.eventsOf("fan-projection");
    expect(projections.filter((e) => e.estimatorApplied === "p50").length).toBeGreaterThan(0);
  });

  for (const estimator of ["p90", "p95"] as const) {
    it(`AS-041: ${estimator} with at least 5 settled children names ${estimator} in the projection`, async () => {
      const h = fanHarness({ width: 8, estimator, budget: scriptedBudget([callsCeiling(1_000)]), auto: costedBy([1, 2, 3, 4, 5, 6, 7, 8]) });
      expect(await h.start()).toEqual(ok(range(8)));
      const applied = h.eventsOf("fan-projection").map((e) => e.estimatorApplied);
      // Settles 1..4 fall back; from the 5th settled child on the percentile applies.
      expect(applied.slice(0, 4)).toEqual(["largest-seen", "largest-seen", "largest-seen", "largest-seen"]);
      expect(applied.slice(4).every((a) => a === estimator)).toBe(true);
    });
  }

  it("AS-042: a percentile with fewer than 5 settled children falls back to largest-seen, and the refusal names the fallback", async () => {
    const h = fanHarness({ width: 8, estimator: "p90", budget: scriptedBudget([callsCeiling(6)]) });
    const refusal = refusalOf(await drive(h, h.start(), costedBy([1, 4, 1, 1, 1, 1, 1, 1])));
    expect(refusal.completed).toBeLessThan(5);
    expect(refusal).toMatchObject({ estimatorApplied: "largest-seen" });
    expect(h.eventsOf("fan-start")[0]).toMatchObject({ estimator: "p90" });
  });
});

describe("FR-018 overshoot bounds under largest-seen (AS-018)", () => {
  it("AS-018: spike-free — spend after the refusal decision ≤ (C−1)·M, the probe ≤ C·M, and nothing overshoots the ceiling", async () => {
    const c = 3;
    const budget = scriptedBudget([callsCeiling(9)]);
    const cp = new InMemoryCheckpointer();
    const h = fanHarness({ width: 10, childConcurrency: c, budget, checkpointer: cp });
    const run = h.start();
    await quiesce();
    expect(h.openIndices()).toEqual([0, 1, 2]);
    h.settle(0, okChild(0, cost({ calls: 2 })));
    await quiesce();
    expect(h.eventsOf("fan-projection").at(-1)).toMatchObject({ verdict: "refuse" });
    const atDecision = budget.spent().calls;
    for (const i of h.openIndices()) h.settle(i, okChild(i * 10, cost({ calls: 2 })));
    refusalOf(await run);
    const m = Math.max(...(await seedIn(cp)).samples.map((s) => s.calls));
    expect(budget.spent().calls - atDecision).toBeLessThanOrEqual((c - 1) * m);
    expect(budget.spent().calls).toBeLessThanOrEqual(c * m);
    expect(budget.spent().calls).toBeLessThanOrEqual(9);
  });

  it("AS-018: the unprojected probe may overshoot, by at most C·M, and nothing is dispatched after it", async () => {
    const c = 3;
    const budget = scriptedBudget([callsCeiling(3)]);
    const cp = new InMemoryCheckpointer();
    const h = fanHarness({ width: 10, childConcurrency: c, budget, checkpointer: cp });
    refusalOf(await drive(h, h.start(), (i) => okChild(i * 10, cost({ calls: 2 }))));
    expect(h.dispatched).toEqual([0, 1, 2]);
    const m = Math.max(...(await seedIn(cp)).samples.map((s) => s.calls));
    expect(budget.spent().calls - 3).toBeGreaterThan(0);
    expect(budget.spent().calls - 3).toBeLessThanOrEqual(c * m);
  });

  /**
   * Drive a fan of per-index call costs in an arbitrary completion order,
   * recording the run-wide spend at the refusal decision (if any). Spend only
   * moves when a child settles, so the spend right after the settle that
   * triggered the refusal IS the spend at the decision.
   */
  const overshootRun = async (c: number, costs: readonly number[], ceiling: number, picks: readonly number[]) => {
    const budget = scriptedBudget([callsCeiling(ceiling)]);
    const h = fanHarness({ width: costs.length, childConcurrency: c, budget });
    const run = h.start();
    let k = 0;
    let atDecision: number | null = null;
    for (;;) {
      await quiesce();
      if (atDecision === null && h.eventsOf("fan-projection").some((e) => e.verdict === "refuse")) atDecision = budget.spent().calls;
      if (h.returned) break;
      const open = h.openIndices();
      const i = open[(picks[k++ % picks.length] ?? 0) % open.length] ?? -1;
      h.settle(i, okChild(i * 10, cost({ calls: costs[i] ?? 1 })));
    }
    await run;
    // M never under-counts a child (lifetime windows), so the largest COST is a sound lower bound of M.
    const maxCost = Math.max(...costs.slice(0, h.dispatched.length));
    return { final: budget.spent().calls, atDecision, maxCost, admitted: h.eventsOf("fan-projection").some((e) => e.verdict === "admit") };
  };

  const fanShape = fc.record({
    c: fc.integer({ min: 1, max: 4 }),
    costs: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 2, maxLength: 12 }),
    ceiling: fc.integer({ min: 1, max: 60 }),
    picks: fc.array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 12 }),
  });

  it("AS-018: property — (a) spend after the refusal decision ≤ (C−1)·M and (c) any overshoot ≤ C·M, for arbitrary costs and orders", async () => {
    await fc.assert(fc.asyncProperty(fanShape, async ({ c, costs, ceiling, picks }) => {
      // Non-increasing by index: no post-probe child can spike above the
      // largest window already settled (every settled child has a lower index),
      // so whatever overshoot remains is the probe's own carve-out (c).
      const ordered = [...costs].sort((a, b) => b - a);
      const { final, atDecision, maxCost } = await overshootRun(c, ordered, ceiling, picks);
      if (atDecision !== null) expect(final - atDecision).toBeLessThanOrEqual((c - 1) * maxCost);
      expect(final - ceiling).toBeLessThanOrEqual(c * maxCost);
    }), { numRuns: 200 });
  });

  it("AS-018: property — (b) a spike-free fan (no child above the estimate in force at its admission) never ends over the ceiling once projection admitted anything", async () => {
    let exercised = 0;
    await fc.assert(fc.asyncProperty(fanShape, async ({ c, costs, ceiling, picks }) => {
      // Uniform cost is spike-free by AD-12's definition, probe children
      // included: every estimate in force is a window ≥ that one cost.
      const uniform = costs.map(() => costs[0] ?? 1);
      const { final, admitted } = await overshootRun(c, uniform, ceiling, picks);
      if (!admitted) return;
      exercised += 1;
      expect(final).toBeLessThanOrEqual(ceiling);
    }), { numRuns: 200 });
    expect(exercised).toBeGreaterThan(40);
  });
});

describe("the host per-call meter stays the hard stop under every estimator (FR-019, AS-043)", () => {
  for (const estimator of ["largest-seen", "p50", "p90", "p95"] as const) {
    it(`AS-043: ${estimator} — a cost spike admitted on the estimate is stopped by the meter, which checked every call`, async () => {
      const budget = scriptedBudget([callsCeiling(10)]);
      const h = fanHarness({ width: 5, estimator, budget, meter: true });
      const spikes = [1, 1, 100, 1, 1];
      const error = errorOf(await drive(h, h.start(), (i) => okChild(i * 10, cost({ calls: spikes[i] ?? 1 }))));
      expect(error.kind).toBe("llm-budget-exceeded");
      expect(budget.spent().calls).toBeLessThanOrEqual(10);
      expect(h.meterChecks).toBe(h.dispatched.length);
      expect(h.eventsOf("fan-refused")).toEqual([]);
    });
  }
});
