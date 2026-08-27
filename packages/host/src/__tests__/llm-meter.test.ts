/**
 * Tests for the pure llm-meter ADT (domain/llm-meter.ts).
 *
 * Covers accumulation, per-run isolation, immutability, the admission decision,
 * the overshoot-by-one rule (FR-W1-004 / SC-003), the no-budget passthrough
 * (FR-W1-006), the multi-ceiling decision (FR-B-002), the settled-vs-projected
 * basis (FR-B-013), and property-based invariants.
 *
 * The meter accumulates `Spend`, not tokens. The value algebra itself is tested
 * in the framework (`spend.test.ts`, `budget.test.ts`); what is tested here is
 * the per-run bookkeeping and the admission decision built on it.
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import { runId as makeRunId } from "@fuguejs/framework";
import type { Ceiling, MicroUsd, RunId, Spend } from "@fuguejs/framework";
import {
  NO_SPEND,
  addSpend,
  ceilings,
  pricedCall,
  unpricedCall,
  usdToMicros,
} from "@fuguejs/framework";
import {
  emptyMeter,
  accumulate,
  spendFor,
  emptyReservation,
  admit,
  releaseReservation,
  learnObservedCall,
  type LlmMeter,
  type ReservationState,
} from "../domain/llm-meter.js";

const micros = (n: number): MicroUsd => n as MicroUsd;
const tokens = (limit: number): Ceiling => ({ kind: "tokens", limit });
const callsCeiling = (limit: number): Ceiling => ({ kind: "calls", limit });
const usd = (dollars: number): Ceiling => ({ kind: "usd", limit: usdToMicros(dollars) });

/** `ceilings` returns undefined only for an empty list; unwrap for tests. */
const limitsOf = (declared: readonly Ceiling[]) => {
  const c = ceilings(declared);
  if (c === undefined) throw new Error("expected non-empty ceilings");
  return c;
};

/** A free call of `n` tokens — isolates the token axis from cost. */
const freeCall = (n: number): Spend => pricedCall(n, micros(0));

const runA = makeRunId("run-a");
const runB = makeRunId("run-b");

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

describe("llm-meter: accumulate + spendFor", () => {
  it("reads an unmetered run as NO_SPEND rather than undefined", () => {
    // "Never seen" and "seen, spent nothing" must be indistinguishable to the
    // budget check (FR-W1-002) — otherwise every read site needs an absent
    // branch that means the same thing as zero.
    expect(spendFor(emptyMeter(), runA)).toEqual(NO_SPEND);
  });

  it("adds a settled call to a run's running total", () => {
    const meter = accumulate(emptyMeter(), runA, pricedCall(150, micros(2_000)));
    expect(spendFor(meter, runA)).toEqual({
      tokens: 150,
      calls: 1,
      usd: { kind: "priced", micros: micros(2_000) },
    });
  });

  it("accumulates across calls on every axis", () => {
    const meter = [1, 2, 3].reduce(
      (m) => accumulate(m, runA, pricedCall(100, micros(500))),
      emptyMeter(),
    );
    expect(spendFor(meter, runA)).toEqual({
      tokens: 300,
      calls: 3,
      usd: { kind: "priced", micros: micros(1_500) },
    });
  });

  it("keeps runs isolated", () => {
    const meter = accumulate(accumulate(emptyMeter(), runA, freeCall(100)), runB, freeCall(7));
    expect(spendFor(meter, runA).tokens).toBe(100);
    expect(spendFor(meter, runB).tokens).toBe(7);
  });

  it("never mutates the input meter", () => {
    const first = accumulate(emptyMeter(), runA, freeCall(10));
    const second = accumulate(first, runA, freeCall(90));
    expect(spendFor(first, runA).tokens).toBe(10);
    expect(spendFor(second, runA).tokens).toBe(100);
  });

  it("exposes a read-only view — no mutable Map methods escape the ADT", () => {
    const meter: LlmMeter = accumulate(emptyMeter(), runA, freeCall(10));
    expect(meter.spendByRun.size).toBe(1);
    expect(meter.spendByRun.has(runA)).toBe(true);
    expect((meter.spendByRun as unknown as Record<string, unknown>)["set"]).toBeUndefined();
    expect(Object.isFrozen(meter)).toBe(true);
  });

  it("carries an unpriced call into the run total, absorbing", () => {
    // Once a run has touched a model with no price, no dollar figure for that
    // run can be trusted again — and the stored value says so.
    const meter = accumulate(
      accumulate(emptyMeter(), runA, pricedCall(10, micros(999))),
      runA,
      unpricedCall(5, "mystery"),
    );
    const spend = spendFor(meter, runA);
    expect(spend.usd.kind).toBe("unpriced");
    if (spend.usd.kind !== "unpriced") return;
    expect([...spend.usd.models]).toEqual(["mystery"]);
    expect(spend.usd.knownMicros).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Admission — no budget
// ---------------------------------------------------------------------------

describe("llm-meter: admit with no ceilings (FR-W1-006)", () => {
  it("never refuses, however much has been spent", () => {
    const meter = accumulate(emptyMeter(), runA, pricedCall(10_000_000, micros(999_999_999)));
    expect(admit(meter, runA, emptyReservation).kind).toBe("admit");
  });

  it("still reserves, so the accounting stays consistent when a budget appears", () => {
    const decision = admit(emptyMeter(), runA, emptyReservation);
    if (decision.kind !== "admit") throw new Error("expected admit");
    expect(decision.state.inFlight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Admission — the overshoot-by-one contract
// ---------------------------------------------------------------------------

describe("llm-meter: overshoot-by-one (FR-W1-004 / SC-003)", () => {
  it("admits the call that crosses the boundary and refuses the next one", () => {
    // The check is BEFORE the call and against settled spend, so exactly one
    // call runs past the ceiling. That single overshoot is the documented
    // guarantee, not an accident of the implementation.
    const limits = limitsOf([tokens(1000)]);
    let meter = emptyMeter();
    let admitted = 0;
    for (let i = 0; i < 10; i += 1) {
      if (admit(meter, runA, emptyReservation, limits).kind === "refuse") break;
      admitted += 1;
      meter = accumulate(meter, runA, freeCall(400));
    }
    expect(admitted).toBe(3); // 0, 400, 800 admitted; 1200 refuses
    expect(spendFor(meter, runA).tokens).toBe(1200);
  });

  it("refuses the first call at a zero ceiling", () => {
    const decision = admit(emptyMeter(), runA, emptyReservation, limitsOf([tokens(0)]));
    expect(decision.kind).toBe("refuse");
  });

  it("reports the SETTLED spend on a refusal, so it reconciles against the metered totals", () => {
    const meter = accumulate(emptyMeter(), runA, freeCall(1200));
    const decision = admit(meter, runA, emptyReservation, limitsOf([tokens(1000)]));
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.settled.tokens).toBe(1200);
    expect(decision.breach.basis).toBe("settled");
  });
});

// ---------------------------------------------------------------------------
// Admission — multi-axis
// ---------------------------------------------------------------------------

describe("llm-meter: any declared ceiling refuses (FR-B-002)", () => {
  const limits = limitsOf([tokens(10_000), callsCeiling(3), usd(1)]);

  it("refuses on the call axis while tokens and dollars are still fine", () => {
    // Three tiny calls trip a call ceiling that neither of the other axes
    // notices — the circuit-breaker for a tool loop stuck retrying.
    const meter = [1, 2, 3].reduce((m) => accumulate(m, runA, pricedCall(1, micros(1))), emptyMeter());
    const decision = admit(meter, runA, emptyReservation, limits);
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.breach.ceiling.kind).toBe("calls");
  });

  it("refuses on the dollar axis while tokens are still fine", () => {
    const meter = accumulate(emptyMeter(), runA, pricedCall(10, usdToMicros(1.5)));
    const decision = admit(meter, runA, emptyReservation, limits);
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.breach.ceiling.kind).toBe("usd");
  });

  it("admits while under every axis", () => {
    const meter = accumulate(emptyMeter(), runA, pricedCall(500, usdToMicros(0.1)));
    expect(admit(meter, runA, emptyReservation, limits).kind).toBe("admit");
  });

  it("refuses an unpriced model under a dollar ceiling, naming the model (FR-B-004)", () => {
    // Fail closed: an unknown cost cannot be shown to be under a limit, and
    // treating it as zero would make the cheapest route past a dollar budget
    // "use a model we forgot to price".
    const meter = accumulate(emptyMeter(), runA, unpricedCall(10, "brand-new"));
    const decision = admit(meter, runA, emptyReservation, limitsOf([usd(100)]));
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.breach.kind).toBe("unpriced");
    if (decision.breach.kind !== "unpriced") return;
    expect([...decision.breach.models]).toEqual(["brand-new"]);
  });

  it("does NOT refuse an unpriced model when only token/call ceilings are declared (FR-B-005)", () => {
    const meter = accumulate(emptyMeter(), runA, unpricedCall(10, "brand-new"));
    expect(admit(meter, runA, emptyReservation, limitsOf([tokens(1000)])).kind).toBe("admit");
  });
});

// ---------------------------------------------------------------------------
// Admission — the concurrency reservation
// ---------------------------------------------------------------------------

describe("llm-meter: reservation bounds concurrent overshoot (SC-003)", () => {
  it("lets the first parallel burst through while no estimate has been learned", () => {
    // The documented FR-W1-004 allowance, generalised: with no settled call yet
    // there is nothing to estimate a concurrent call's size from.
    const limits = limitsOf([tokens(1000)]);
    let state: ReservationState = emptyReservation;
    for (let i = 0; i < 5; i += 1) {
      const decision = admit(emptyMeter(), runA, state, limits);
      if (decision.kind !== "admit") throw new Error("expected admit");
      state = decision.state;
    }
    expect(state.inFlight).toBe(5);
  });

  it("refuses on the PROJECTION once an estimate exists and calls are in flight", () => {
    const limits = limitsOf([tokens(1000)]);
    const meter = accumulate(emptyMeter(), runA, freeCall(600));
    // One 600-token call settled, one more of the same size in flight:
    // 600 + 600 projects past 1000 even though settled spend is still under.
    const state = { inFlight: 1, maxObservedCall: freeCall(600) };
    const decision = admit(meter, runA, state, limits);
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.breach.basis).toBe("projected");
    // The SETTLED figure is what the refusal reports, so an operator
    // reconciling `llm.metered` totals never sees a phantom gap.
    expect(decision.settled.tokens).toBe(600);
    expect(decision.inFlight).toBe(1);
  });

  it("prefers the SETTLED reason when both bases breach", () => {
    // A ceiling spend has actually reached is a stronger statement than one an
    // estimate says it is about to.
    const meter = accumulate(emptyMeter(), runA, freeCall(5000));
    const state = { inFlight: 3, maxObservedCall: freeCall(5000) };
    const decision = admit(meter, runA, state, limitsOf([tokens(1000)]));
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.breach.basis).toBe("settled");
  });

  it("does not refuse on a projection when nothing is in flight", () => {
    // With `inFlight: 0` the projection equals settled spend, so a run that is
    // within budget and has nothing outstanding is never refused by the
    // estimate — even a large learned one.
    const meter = accumulate(emptyMeter(), runA, freeCall(100));
    const state = { inFlight: 0, maxObservedCall: freeCall(999_999) };
    expect(admit(meter, runA, state, limitsOf([tokens(1000)])).kind).toBe("admit");
  });

  it("releases by decrementing, clamped at zero on a double release", () => {
    const state = releaseReservation({ inFlight: 1, maxObservedCall: NO_SPEND });
    expect(state.inFlight).toBe(0);
    // A double release is a contract breach; clamping keeps the projection sane
    // rather than letting a negative count grant free headroom.
    expect(releaseReservation(state).inFlight).toBe(0);
  });

  it("widens the learned estimate monotonically, per axis", () => {
    const learned = [freeCall(100), freeCall(50), pricedCall(10, micros(9_000))].reduce(
      learnObservedCall,
      emptyReservation,
    );
    expect(learned.maxObservedCall.tokens).toBe(100);
    if (learned.maxObservedCall.usd.kind !== "priced") throw new Error("priced");
    expect(learned.maxObservedCall.usd.micros).toBe(9_000);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("llm-meter: properties", () => {
  const arbCall = fc.oneof(
    fc.tuple(fc.nat({ max: 5_000 }), fc.nat({ max: 5_000 })).map(([t, m]) => pricedCall(t, micros(m))),
    fc.nat({ max: 5_000 }).map((t) => unpricedCall(t, "unpriced-model")),
  );

  it("a run's total equals the fold of its calls, in any order", () => {
    fc.assert(
      fc.property(fc.array(arbCall, { maxLength: 20 }), (calls) => {
        const metered = calls.reduce((m, c) => accumulate(m, runA, c), emptyMeter());
        const folded = calls.reduce(addSpend, NO_SPEND);
        expect(spendFor(metered, runA)).toEqual(folded);
      }),
    );
  });

  it("is monotone — no sequence of calls ever decreases any axis", () => {
    fc.assert(
      fc.property(fc.array(arbCall, { minLength: 1, maxLength: 20 }), (calls) => {
        let meter = emptyMeter();
        let previous = spendFor(meter, runA);
        for (const call of calls) {
          meter = accumulate(meter, runA, call);
          const next = spendFor(meter, runA);
          expect(next.tokens).toBeGreaterThanOrEqual(previous.tokens);
          expect(next.calls).toBeGreaterThanOrEqual(previous.calls);
          previous = next;
        }
      }),
    );
  });

  it("refuses IFF some declared ceiling is reached — neither over- nor under-refusal", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.nat({ max: 400 }), fc.nat({ max: 400 })).map(([t, m]) => pricedCall(t, micros(m))),
          { maxLength: 15 },
        ),
        (calls) => {
          const limits = limitsOf([tokens(2000), callsCeiling(8), { kind: "usd", limit: micros(2000) }]);
          const meter = calls.reduce((m, c) => accumulate(m, runA, c), emptyMeter());
          const spend = spendFor(meter, runA);
          const over =
            spend.tokens >= 2000 ||
            spend.calls >= 8 ||
            (spend.usd.kind === "priced" && spend.usd.micros >= 2000);
          expect(admit(meter, runA, emptyReservation, limits).kind).toBe(over ? "refuse" : "admit");
        },
      ),
    );
  });

  it("admitting never refuses a run whose spend is strictly under every ceiling", () => {
    fc.assert(
      fc.property(fc.nat({ max: 999 }), (spent) => {
        const meter = accumulate(emptyMeter(), runA, freeCall(spent));
        expect(admit(meter, runA, emptyReservation, limitsOf([tokens(1000)])).kind).toBe("admit");
      }),
    );
  });
});
