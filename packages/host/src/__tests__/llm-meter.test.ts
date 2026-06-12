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
  emptyReservation,
  admitWithReservation,
  releaseReservation,
  learnObservedCall,
  type LlmMeter,
  type ReservationState,
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

// ── Concurrency reservation transitions (pure core of I1 / SC-003) ──────────

describe("reservation transitions (admitWithReservation / release / learn)", () => {
  const meterAt = (total: number): LlmMeter =>
    total === 0 ? emptyMeter() : accumulate(emptyMeter(), runA, { tokensIn: total, tokensOut: 0 });

  it("admits with zero reservation when no estimate is learned (the documented first-burst allowance)", () => {
    const d = admitWithReservation(meterAt(0), runA, emptyReservation, 100);
    expect(d.kind).toBe("admit");
    if (d.kind === "admit") {
      expect(d.reserved).toBe(0);
      expect(d.state.reservedInFlight).toBe(0);
    }
  });

  it("reserves the learned estimate on admit and frees exactly it on release", () => {
    const learned = learnObservedCall(emptyReservation, 40);
    const d = admitWithReservation(meterAt(10), runA, learned, 100);
    expect(d.kind).toBe("admit");
    if (d.kind !== "admit") return;
    expect(d.reserved).toBe(40);
    expect(d.state.reservedInFlight).toBe(40);
    const released = releaseReservation(d.state, d.reserved);
    expect(released.reservedInFlight).toBe(0);
    expect(released.maxObservedCall).toBe(40); // learning survives release
  });

  it("refuses when settled cumulative plus the in-flight reservation projects past the budget", () => {
    const state: ReservationState = { reservedInFlight: 40, maxObservedCall: 40 };
    const d = admitWithReservation(meterAt(70), runA, state, 100); // 70 + 40 ≥ 100
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.cumulative).toBe(70); // SETTLED only — the errors.ts contract
      expect(d.reservedInFlight).toBe(40); // log-only figure
      expect(d.budget).toBe(100);
    }
  });

  it("refuses on settled cumulative alone (delegates to budgetDecision) regardless of reservation", () => {
    const d = admitWithReservation(meterAt(100), runA, emptyReservation, 100);
    expect(d.kind).toBe("refuse");
  });

  it("no budget never refuses, whatever the reservation", () => {
    const state: ReservationState = { reservedInFlight: 10_000, maxObservedCall: 10_000 };
    const d = admitWithReservation(meterAt(999_999), runA, state, undefined);
    expect(d.kind).toBe("admit");
  });

  it("learnObservedCall is a monotone max", () => {
    const s1 = learnObservedCall(emptyReservation, 30);
    const s2 = learnObservedCall(s1, 10); // smaller call never lowers the estimate
    expect(s2.maxObservedCall).toBe(30);
    const s3 = learnObservedCall(s2, 55);
    expect(s3.maxObservedCall).toBe(55);
  });

  // ── Regression: provider-sourced callTotal is sanitized (NaN/Infinity/negative → 0),
  // and releaseReservation clamps at 0 — the SC-003 gate can never be poisoned
  // or handed free headroom via a contract breach. ──────────────────────────

  it("learnObservedCall sanitizes a NaN/Infinity/negative callTotal — maxObservedCall stays finite and never lowers", () => {
    const learned = learnObservedCall(emptyReservation, 40);
    for (const poison of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -123]) {
      const after = learnObservedCall(learned, poison);
      // The poison reads as 0 — it neither poisons the max nor lowers it.
      expect(after.maxObservedCall).toBe(40);
      expect(Number.isFinite(after.maxObservedCall)).toBe(true);
    }
    // From an empty state, a NaN callTotal reads as 0, not NaN.
    const fromEmpty = learnObservedCall(emptyReservation, Number.NaN);
    expect(fromEmpty.maxObservedCall).toBe(0);
    expect(Number.isFinite(fromEmpty.maxObservedCall)).toBe(true);
  });

  it("after a NaN callTotal, the budgeted gate still refuses and admits correctly (SC-003 not disabled)", () => {
    // Learn a real estimate, then feed the poison the provider contract breach
    // would deliver. The gate's projected comparison must keep working.
    let state = learnObservedCall(emptyReservation, 40);
    state = learnObservedCall(state, Number.NaN);
    expect(state.maxObservedCall).toBe(40); // not NaN — the estimate survives

    // Refusal path: settled 70 + reserved 40 projects past budget 100.
    const reserving = admitWithReservation(meterAt(10), runA, state, 100);
    expect(reserving.kind).toBe("admit");
    if (reserving.kind !== "admit") return;
    expect(reserving.state.reservedInFlight).toBe(40);
    const refused = admitWithReservation(meterAt(70), runA, reserving.state, 100);
    expect(refused.kind).toBe("refuse"); // NaN would have read `projected >= budget` as false forever
    if (refused.kind === "refuse") {
      expect(refused.cumulative).toBe(70);
      expect(refused.reservedInFlight).toBe(40);
      expect(refused.budget).toBe(100);
    }

    // Admit path still works too: well under budget admits and reserves 40.
    const admitted = admitWithReservation(meterAt(10), runA, state, 1000);
    expect(admitted.kind).toBe("admit");
    if (admitted.kind === "admit") expect(admitted.reserved).toBe(40);
  });

  it("releaseReservation clamps at 0 — a double release never drives reservedInFlight negative", () => {
    const learned = learnObservedCall(emptyReservation, 40);
    const d = admitWithReservation(meterAt(0), runA, learned, 1000);
    expect(d.kind).toBe("admit");
    if (d.kind !== "admit") return;
    const once = releaseReservation(d.state, d.reserved);
    expect(once.reservedInFlight).toBe(0);
    // Contract breach: release the same reservation again.
    const twice = releaseReservation(once, d.reserved);
    expect(twice.reservedInFlight).toBe(0); // clamped — no free budget headroom
    // And the negative state can never grant an over-budget admit it shouldn't:
    // settled 999 >= budget 1000 - anything reserved must still refuse at 1000.
    const gate = admitWithReservation(meterAt(1000), runA, twice, 1000);
    expect(gate.kind).toBe("refuse");
  });

  it("property: reservedInFlight never goes below 0 under arbitrary interleaved release/learn sequences", () => {
    const weirdAmount = fc.oneof(
      fc.integer({ min: -1000, max: 1000 }),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant("admit" as const) }),
            fc.record({ op: fc.constant("release" as const), amount: fc.nat({ max: 500 }) }),
            fc.record({ op: fc.constant("learn" as const), amount: weirdAmount }),
          ),
          { maxLength: 50 },
        ),
        (ops) => {
          let state = emptyReservation;
          for (const o of ops) {
            if (o.op === "admit") {
              const d = admitWithReservation(emptyMeter(), runA, state, undefined);
              if (d.kind !== "admit") throw new Error("unbudgeted admit refused");
              state = d.state;
            } else if (o.op === "release") {
              state = releaseReservation(state, o.amount);
            } else {
              state = learnObservedCall(state, o.amount);
            }
            expect(state.reservedInFlight).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(state.maxObservedCall)).toBe(true);
          }
        },
      ),
    );
  });

  it("property: interleaved admit/release sequences never strand reservation (balanced ops return to zero)", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 500 }), { maxLength: 30 }), (callSizes) => {
        let state = emptyReservation;
        const reservedAmounts: number[] = [];
        for (const size of callSizes) {
          const d = admitWithReservation(emptyMeter(), runA, state, undefined);
          if (d.kind !== "admit") throw new Error("unbudgeted admit refused");
          state = d.state;
          reservedAmounts.push(d.reserved);
          state = learnObservedCall(state, size);
        }
        for (const r of reservedAmounts) state = releaseReservation(state, r);
        expect(state.reservedInFlight).toBe(0);
      }),
    );
  });
});
