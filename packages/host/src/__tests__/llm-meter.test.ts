/**
 * Tests for the pure llm-meter ADT (domain/llm-meter.ts).
 *
 * Covers accumulation, per-run isolation, immutability, the budget decision
 * (allow/refuse), the overshoot-by-one rule (FR-W1-004 / SC-003), the
 * no-budget passthrough (FR-W1-006), and property-based invariants.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { runId as makeRunId } from "@fuguejs/framework";
import type { RunId } from "@fuguejs/framework";
import {
  emptyMeter,
  accumulate,
  budgetDecision,
  usageFor,
  runTotal,
  formatBudgetDecision,
  type LlmMeter,
} from "../domain/llm-meter.js";

const runA = makeRunId("run-a");
const runB = makeRunId("run-b");

describe("llm-meter: accumulate + usageFor", () => {
  it("reads an unmetered run as all-zero", () => {
    const usage = usageFor(emptyMeter(), runA);
    expect(usage).toEqual({ tokensIn: 0, tokensOut: 0 });
    expect(runTotal(usage)).toBe(0);
  });

  it("sums tokensIn / tokensOut and keeps runTotal = in + out", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: 100, tokensOut: 50 });
    m = accumulate(m, runA, { tokensIn: 10, tokensOut: 5 });
    expect(usageFor(m, runA)).toEqual({ tokensIn: 110, tokensOut: 55 });
    expect(runTotal(usageFor(m, runA))).toBe(165);
  });

  it("isolates usage per runId", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: 100, tokensOut: 50 });
    m = accumulate(m, runB, { tokensIn: 1, tokensOut: 2 });
    expect(runTotal(usageFor(m, runA))).toBe(150);
    expect(runTotal(usageFor(m, runB))).toBe(3);
  });

  it("does not mutate the input meter (immutability)", () => {
    const m0 = emptyMeter();
    const m1 = accumulate(m0, runA, { tokensIn: 100, tokensOut: 50 });
    expect(runTotal(usageFor(m0, runA))).toBe(0); // m0 untouched
    expect(runTotal(usageFor(m1, runA))).toBe(150);
    expect(m1).not.toBe(m0);
  });

  it("clamps negative deltas to zero (no budget refunds)", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: -100, tokensOut: -50 });
    expect(runTotal(usageFor(m, runA))).toBe(0);
  });

  it("runTotal is unrepresentable-illegal-state-free: always equals in + out", () => {
    const u = usageFor(accumulate(emptyMeter(), runA, { tokensIn: 7, tokensOut: 13 }), runA);
    // No stored `total` field exists to disagree with the derived figure.
    expect(u).not.toHaveProperty("total");
    expect(runTotal(u)).toBe(20);
  });
});

describe("llm-meter: non-finite delta hardening (NaN/Infinity read as 0)", () => {
  it("treats a NaN delta component as 0 — cumulative stays finite (10, not NaN)", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: Number.NaN, tokensOut: 10 });
    const u = usageFor(m, runA);
    expect(u).toEqual({ tokensIn: 0, tokensOut: 10 });
    expect(runTotal(u)).toBe(10);
    expect(Number.isFinite(runTotal(u))).toBe(true);
  });

  it("treats an Infinity delta component as 0 — no never-refusing poisoned cumulative", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: Number.POSITIVE_INFINITY, tokensOut: 5 });
    m = accumulate(m, runA, { tokensIn: 5, tokensOut: Number.NEGATIVE_INFINITY });
    const u = usageFor(m, runA);
    expect(u).toEqual({ tokensIn: 5, tokensOut: 5 });
    expect(runTotal(u)).toBe(10);
  });

  it("cumulative can never go non-finite through accumulate, for any delta sequence (property)", () => {
    const weirdNumber = fc.oneof(
      fc.integer({ min: -10_000, max: 10_000 }),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
    );
    fc.assert(
      fc.property(
        fc.array(fc.record({ tokensIn: weirdNumber, tokensOut: weirdNumber }), { maxLength: 50 }),
        (deltas) => {
          let m: LlmMeter = emptyMeter();
          for (const d of deltas) {
            m = accumulate(m, runA, d);
            const total = runTotal(usageFor(m, runA));
            expect(Number.isFinite(total)).toBe(true);
            expect(total).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });

  it("budgetDecision FAILS CLOSED on a non-finite cumulative (defense in depth): a hand-built poisoned meter REFUSES, never `NaN >= budget` → allow", () => {
    // `accumulate` sanitizes its inputs, so a poisoned meter is only reachable by
    // hand-building one — exactly the defense-in-depth scenario the refusal guards.
    for (const poison of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const poisoned: LlmMeter = {
        usageByRun: new Map([[runA, { tokensIn: poison, tokensOut: 0 }]]),
      };
      const d = budgetDecision(poisoned, runA, 1000);
      expect(d.kind).toBe("refuse"); // fail closed, not fail open forever
      if (d.kind === "refuse") expect(d.budget).toBe(1000);
    }
    // An ABSENT budget still allows (FR-W1-006 outranks the guard — no budget,
    // no enforcement, even on a poisoned meter).
    const poisoned: LlmMeter = {
      usageByRun: new Map([[runA, { tokensIn: Number.NaN, tokensOut: 0 }]]),
    };
    expect(budgetDecision(poisoned, runA, undefined).kind).toBe("allow");
  });
});

describe("llm-meter: budgetDecision", () => {
  it("allows every call when budget is undefined (FR-W1-006)", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: 1_000_000, tokensOut: 0 });
    const d = budgetDecision(m, runA, undefined);
    expect(d.kind).toBe("allow");
  });

  it("allows while cumulative < budget", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: 400, tokensOut: 100 }); // 500
    const d = budgetDecision(m, runA, 1000);
    expect(d.kind).toBe("allow");
    if (d.kind === "allow") expect(d.cumulative).toBe(500);
  });

  it("refuses once cumulative >= budget", () => {
    let m = emptyMeter();
    m = accumulate(m, runA, { tokensIn: 600, tokensOut: 400 }); // 1000
    const d = budgetDecision(m, runA, 1000);
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.cumulative).toBe(1000);
      expect(d.budget).toBe(1000);
    }
  });

  it("refuses the first call for a non-positive budget", () => {
    expect(budgetDecision(emptyMeter(), runA, 0).kind).toBe("refuse");
  });

  it("refuses the first call for a negative budget (cumulative 0 >= negative)", () => {
    const d = budgetDecision(emptyMeter(), runA, -50);
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.cumulative).toBe(0);
      expect(d.budget).toBe(-50);
    }
  });
});

describe("llm-meter: overshoot-by-one (FR-W1-004 / SC-003)", () => {
  it("allows the boundary-crossing call, then refuses the next", () => {
    const budget = 1000;
    let m = emptyMeter();
    // Establish cumulative-so-far at 900 (under budget).
    m = accumulate(m, runA, { tokensIn: 900, tokensOut: 0 });

    // Cumulative 900 < 1000 → this call is allowed (pre-call check).
    expect(budgetDecision(m, runA, budget).kind).toBe("allow");
    // The call returns and overshoots to 1100.
    m = accumulate(m, runA, { tokensIn: 200, tokensOut: 0 }); // 900 -> 1100

    // Now cumulative 1100 >= 1000 → the NEXT call is refused (single overshoot).
    const next = budgetDecision(m, runA, budget);
    expect(next.kind).toBe("refuse");
  });

  it("allows at most one call past budget B regardless of step sizes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }), // budget B
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 200 }), // per-call costs
        (budget, costs) => {
          let m = emptyMeter();
          let allowedCount = 0;
          let crossedAt = -1;
          for (let i = 0; i < costs.length; i++) {
            const d = budgetDecision(m, runA, budget);
            if (d.kind === "refuse") break; // refusal halts the run
            allowedCount++;
            // Every allowed call must have been under budget at decision time
            // (the overshoot invariant: the boundary-crossing call is the LAST
            // call permitted). This was previously only described in a comment.
            expect(d.cumulative).toBeLessThan(budget);
            const before = runTotal(usageFor(m, runA));
            expect(d.cumulative).toBe(before); // decision reflects cumulative-so-far
            m = accumulate(m, runA, { tokensIn: costs[i]!, tokensOut: 0 });
            if (before < budget && runTotal(usageFor(m, runA)) >= budget && crossedAt === -1) {
              crossedAt = i;
            }
          }
          const finalTotal = runTotal(usageFor(m, runA));
          // If we ever crossed the budget, no further call was allowed after the
          // crossing call (at most one call past B).
          if (crossedAt !== -1) {
            // allowedCount counts calls that ran; the crossing call is the last allowed one.
            expect(allowedCount).toBe(crossedAt + 1);
            expect(finalTotal).toBeGreaterThanOrEqual(budget);
          }
          return true;
        },
      ),
    );
  });
});

describe("llm-meter: property — total is always in + out and monotonic", () => {
  it("total equals tokensIn + tokensOut after any sequence of accumulates", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tokensIn: fc.integer({ min: 0, max: 10_000 }),
            tokensOut: fc.integer({ min: 0, max: 10_000 }),
          }),
          { maxLength: 100 },
        ),
        (deltas) => {
          let m: LlmMeter = emptyMeter();
          let prevTotal = 0;
          for (const d of deltas) {
            m = accumulate(m, runA, d);
            const u = usageFor(m, runA);
            const total = runTotal(u);
            expect(total).toBe(u.tokensIn + u.tokensOut);
            expect(total).toBeGreaterThanOrEqual(prevTotal); // monotonic non-decreasing
            prevTotal = total;
          }
        },
      ),
    );
  });

  it("budget decision is purely a function of cumulative vs budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }), // cumulative
        fc.integer({ min: 1, max: 100_000 }), // budget
        (cumulative, budget) => {
          const m = accumulate(emptyMeter(), runA, { tokensIn: cumulative, tokensOut: 0 });
          const d = budgetDecision(m, runA, budget);
          if (cumulative >= budget) {
            expect(d.kind).toBe("refuse");
          } else {
            expect(d.kind).toBe("allow");
          }
        },
      ),
    );
  });
});

describe("llm-meter: formatBudgetDecision", () => {
  it("formats both branches without throwing", () => {
    expect(formatBudgetDecision({ kind: "allow", cumulative: 5 })).toContain("allow");
    expect(formatBudgetDecision({ kind: "refuse", cumulative: 10, budget: 8 })).toContain("refuse");
  });
});
