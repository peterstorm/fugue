// map-fan-interleaving — the fan SHELL's laws over arbitrary interleavings
// (SC-003, SC-006, SC-007; INV-5, INV-6), ≥ 1,000 cases each.
//
// The machine's own property suites prove the admission rules over abstract
// command streams; these prove the interpreter honours them against real
// asynchrony: arbitrary widths, concurrency, pre-saved indices, failure sets
// and completion orders, driven through `runMappedFan` with the deterministic
// harness. Each case then RESUMES the same epoch on the same checkpointer to
// prove every output saved during the run — including drain completions — is
// reused with 0 re-dispatch.

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import type { FrameworkError } from "../types/errors.js";
import type { Result } from "../types/result.js";
import {
  callsCeiling,
  childError,
  cost,
  drive,
  failChild,
  fanHarness,
  okChild,
  presave,
  scriptedBudget,
  type FanHarness,
} from "./fan-test-harness.js";

const RUNS = { numRuns: 1_000 } as const;

const caseArb = fc.record({
  width: fc.integer({ min: 0, max: 10 }),
  c: fc.integer({ min: 1, max: 4 }),
  presaved: fc.uniqueArray(fc.nat(9), { maxLength: 5 }),
  fails: fc.uniqueArray(fc.nat(9), { maxLength: 4 }),
  choices: fc.array(fc.nat(), { minLength: 1, maxLength: 16 }),
});

const chooser = (choices: readonly number[]) => {
  let k = 0;
  return (open: readonly number[]): number => {
    const pick = choices[k % choices.length] ?? 0;
    k += 1;
    return open[pick % open.length] ?? -1;
  };
};

const succeeded = (h: FanHarness, fails: ReadonlySet<number>): number[] =>
  h.dispatched.filter((i) => !fails.has(i));

/** Starts strictly ascending; nothing starts once a terminal failure was observed. */
const assertDispatchDiscipline = (h: FanHarness, fails: ReadonlySet<number>, presaved: ReadonlySet<number>): void => {
  expect(h.dispatched).toEqual([...h.dispatched].sort((a, b) => a - b));
  expect(new Set(h.dispatched).size).toBe(h.dispatched.length);
  expect(h.dispatched.some((i) => presaved.has(i))).toBe(false);
  const firstFailure = h.trace.findIndex((t) => t.startsWith("settle:") && fails.has(Number(t.slice(7))));
  if (firstFailure >= 0) expect(h.trace.slice(firstFailure).some((t) => t.startsWith("dispatch:"))).toBe(false);
};

const assertOutcome = (result: Result<unknown, FrameworkError>, h: FanHarness, width: number, fails: ReadonlySet<number>): void => {
  const observed = h.dispatched.filter((i) => fails.has(i));
  const [lowest, ...rest] = observed;
  if (lowest === undefined) {
    expect(result).toEqual({ ok: true, value: Array.from({ length: width }, (_, i) => i * 10) });
    expect(h.reductions).toHaveLength(1);
    return;
  }
  expect(h.reductions).toEqual([]);
  if (rest.length === 0) {
    expect(result).toEqual({ ok: false, error: childError(lowest) });
    return;
  }
  expect(result).toMatchObject({
    ok: false,
    error: {
      kind: "fan-child-failed",
      primary: { index: lowest, error: childError(lowest) },
      causes: { kind: "secondaries", secondary: rest.map((index) => ({ index, error: childError(index) })) },
    },
  });
};

describe("fan shell over arbitrary interleavings", () => {
  it("SC-003/SC-006/SC-007: bounded, ordered, lowest-index primary, every saved output reused", async () => {
    await fc.assert(fc.asyncProperty(caseArb, async ({ width, c, presaved, fails, choices }) => {
      const cp = new InMemoryCheckpointer();
      const saved = new Set(presaved.filter((i) => i < width));
      const failing = new Set(fails);
      if (saved.size > 0) await presave(cp, [...saved], (i) => i * 10);
      const h = fanHarness({ width, childConcurrency: c, checkpointer: cp });
      const result = await drive(h, h.start(), (i) => (failing.has(i) ? failChild(childError(i)) : okChild(i * 10)), chooser(choices));

      expect(h.maxInFlight).toBeLessThanOrEqual(c);
      expect(h.pendingAtReturn).toBe(0);
      assertDispatchDiscipline(h, failing, saved);
      assertOutcome(result, h, width, failing);
      for (const i of succeeded(h, failing)) expect(h.trace).toContain(`save:dag@fan@${i}@0`);

      // Resume the same epoch with every child healthy: 0 re-dispatch of anything saved.
      const reused = new Set([...saved, ...succeeded(h, failing)]);
      const resumed = fanHarness({ width, childConcurrency: c, checkpointer: cp, auto: (i) => okChild(i * 10) });
      expect(await resumed.start()).toEqual({ ok: true, value: Array.from({ length: width }, (_, i) => i * 10) });
      expect(resumed.dispatched).toEqual(Array.from({ length: width }, (_, i) => i).filter((i) => !reused.has(i)));
    }), RUNS);
  });

  it("budgeted: a refusal counts every saved child, never reduces, and a raised budget resumes with 0 re-dispatch", async () => {
    const budgetedArb = fc.record({
      width: fc.integer({ min: 1, max: 10 }),
      c: fc.integer({ min: 1, max: 4 }),
      limit: fc.integer({ min: 0, max: 30 }),
      costs: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 10, maxLength: 10 }),
      choices: fc.array(fc.nat(), { minLength: 1, maxLength: 16 }),
    });
    await fc.assert(fc.asyncProperty(budgetedArb, async ({ width, c, limit, costs, choices }) => {
      const cp = new InMemoryCheckpointer();
      const budget = scriptedBudget([callsCeiling(limit)]);
      const h = fanHarness({ width, childConcurrency: c, checkpointer: cp, budget });
      const result = await drive(h, h.start(), (i) => okChild(i * 10, cost({ calls: costs[i] ?? 0 })), chooser(choices));

      expect(h.maxInFlight).toBeLessThanOrEqual(c);
      expect(h.pendingAtReturn).toBe(0);
      const completed = h.dispatched.length;
      if (result.ok) {
        expect(result.value).toEqual(Array.from({ length: width }, (_, i) => i * 10));
        expect(h.eventsOf("fan-refused")).toEqual([]);
        return;
      }
      expect(result.error).toMatchObject({ kind: "fan-budget-refused", refusal: { completed, remaining: width - completed } });
      expect(h.reductions).toEqual([]);
      expect(h.eventsOf("fan-refused")).toHaveLength(1);
      expect(h.trace).toContain("save:fan-seed@fan@0@0");

      budget.redeploy(undefined);
      const resumed = fanHarness({ width, childConcurrency: c, checkpointer: cp, budget, auto: (i) => okChild(i * 10) });
      expect(await resumed.start()).toEqual({ ok: true, value: Array.from({ length: width }, (_, i) => i * 10) });
      expect(resumed.dispatched).toEqual(Array.from({ length: width - completed }, (_, k) => completed + k));
    }), RUNS);
  });
});
