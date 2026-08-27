/**
 * Tests for `Ceilings` and the breach decision (types/budget.ts).
 *
 * Two rules here are safety properties rather than conveniences, and both get
 * dedicated coverage: an unpriced model under a dollar ceiling must FAIL CLOSED
 * (otherwise the cheapest route past a dollar budget is a model nobody priced),
 * and `ceilings` must be incapable of RELAXING a limit (otherwise a
 * caller-supplied budget could widen a DAG's).
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import type { Ceiling, MicroUsd } from "../types/index.js";
import {
  NO_SPEND,
  addSpend,
  breachOf,
  ceilings,
  firstBreach,
  formatBreach,
  observedOf,
  pricedCall,
  unpricedCall,
  usdToMicros,
} from "../types/index.js";

const micros = (n: number): MicroUsd => n as MicroUsd;
const tokens = (limit: number): Ceiling => ({ kind: "tokens", limit });
const calls = (limit: number): Ceiling => ({ kind: "calls", limit });
const usd = (dollars: number): Ceiling => ({ kind: "usd", limit: usdToMicros(dollars) });

/** `ceilings` never returns undefined for a non-empty input; unwrap for tests. */
const limitsOf = (declared: readonly Ceiling[]) => {
  const c = ceilings(declared);
  if (c === undefined) throw new Error("expected non-empty ceilings");
  return c;
};

describe("ceilings: the smart constructor", () => {
  it("spells 'no budget' as undefined, not as an empty list", () => {
    // One fact, one spelling. An empty `Ceilings` would be a budget that limits
    // nothing, which every read site would then have to guard against.
    expect(ceilings([])).toBeUndefined();
  });

  it("collapses duplicate axes to the TIGHTER limit", () => {
    expect(limitsOf([tokens(1000), tokens(400)])).toEqual([tokens(400)]);
    expect(limitsOf([tokens(400), tokens(1000)])).toEqual([tokens(400)]);
  });

  it("cannot relax a limit, whatever order the declarations arrive in (FR-B-009)", () => {
    // Composing a DAG's ceilings with a caller-supplied set is just
    // `ceilings([...dag, ...request])`. Because duplicates take a MINIMUM,
    // "raise my budget" is not expressible — deny-by-default is a property of
    // the data structure rather than a check somebody must remember to write.
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }).filter((n) => n > 0),
        fc.nat({ max: 10_000 }).filter((n) => n > 0),
        (dagLimit, requestLimit) => {
          const composed = limitsOf([tokens(dagLimit), tokens(requestLimit)]);
          expect(composed[0].limit).toBeLessThanOrEqual(dagLimit);
          expect(composed[0].limit).toBeLessThanOrEqual(requestLimit);
        },
      ),
    );
  });

  it("orders canonically — usd first — so a refusal is stable across restarts", () => {
    // The usd branch is the only one that can fail for a reason an operator
    // must go and FIX (an unpriced model). Surfacing it first is what gets it
    // fixed, and a fixed order means the reported ceiling does not depend on
    // how a config file happened to list them.
    const ordered = limitsOf([calls(5), tokens(100), usd(1)]);
    expect(ordered.map((c) => c.kind)).toEqual(["usd", "tokens", "calls"]);
    expect(limitsOf([usd(1), calls(5), tokens(100)]).map((c) => c.kind)).toEqual([
      "usd",
      "tokens",
      "calls",
    ]);
  });

  it("clamps a non-finite or negative limit to zero, failing CLOSED", () => {
    // A NaN limit would make `observed >= limit` false forever — a budget that
    // never refuses. Zero grants nothing instead, which is the safe reading of
    // "we could not understand your limit".
    expect(limitsOf([tokens(Number.NaN)])).toEqual([tokens(0)]);
    expect(limitsOf([tokens(-100)])).toEqual([tokens(0)]);
    expect(breachOf(NO_SPEND, tokens(Number.NaN), "settled")).toBeDefined();
  });
});

describe("breachOf: token and call axes", () => {
  it("is within budget below the limit and reached at or above it", () => {
    const spend = pricedCall(999, micros(0));
    expect(breachOf(spend, tokens(1000), "settled")).toBeUndefined();
    expect(breachOf(addSpend(spend, pricedCall(1, micros(0))), tokens(1000), "settled")).toBeDefined();
  });

  it("refuses at a zero limit — a budget granting nothing grants nothing", () => {
    expect(breachOf(NO_SPEND, tokens(0), "settled")).toBeDefined();
  });

  it("counts settled calls independently of their size", () => {
    // The cheap circuit-breaker for a tool loop stuck retrying: three tiny
    // calls trip a call ceiling that a token ceiling would never notice.
    const three = [1, 2, 3].reduce((acc) => addSpend(acc, pricedCall(1, micros(1))), NO_SPEND);
    expect(breachOf(three, calls(3), "settled")).toBeDefined();
    expect(breachOf(three, tokens(1_000_000), "settled")).toBeUndefined();
  });

  it("carries the basis it was handed, never inferring it", () => {
    const over = pricedCall(2000, micros(0));
    expect(breachOf(over, tokens(1000), "settled")?.basis).toBe("settled");
    expect(breachOf(over, tokens(1000), "projected")?.basis).toBe("projected");
  });
});

describe("breachOf: the usd axis fails closed on an unpriced model", () => {
  it("refuses when cost cannot be evaluated, whatever the priced portion", () => {
    // Treating an unknown cost as zero would make the cheapest way past a
    // dollar budget "use a model we forgot to price".
    const spend = addSpend(pricedCall(10, micros(1)), unpricedCall(10, "mystery-model"));
    const breach = breachOf(spend, usd(1000), "settled");
    expect(breach?.kind).toBe("unpriced");
    if (breach?.kind !== "unpriced") return;
    expect([...breach.models]).toEqual(["mystery-model"]);
    expect(breach.observedAtLeast).toBe(micros(1));
  });

  it("does NOT refuse an unpriced model under token/call ceilings only (FR-B-005)", () => {
    // The budget that cannot be evaluated is the dollar one. A token ceiling is
    // perfectly evaluable on an unpriced model, so refusing there would be
    // fail-closed applied where nothing is unknown.
    const spend = unpricedCall(10, "mystery-model");
    expect(firstBreach(spend, limitsOf([tokens(1000), calls(50)]), "settled")).toBeUndefined();
  });

  it("compares priced spend exactly, in integer micro-dollars", () => {
    const spend = pricedCall(10, usdToMicros(0.99));
    expect(breachOf(spend, usd(1), "settled")).toBeUndefined();
    expect(breachOf(addSpend(spend, pricedCall(0, usdToMicros(0.01))), usd(1), "settled")).toBeDefined();
  });
});

describe("firstBreach: any ceiling refuses", () => {
  it("returns undefined only when the run is within EVERY declared ceiling", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5000 }),
        fc.nat({ max: 20 }),
        fc.nat({ max: 5000 }),
        (tokenSpend, callCount, costMicros) => {
          const spend = { tokens: tokenSpend, calls: callCount, usd: { kind: "priced" as const, micros: micros(costMicros) } };
          const limits = limitsOf([tokens(2000), calls(10), { kind: "usd", limit: micros(2000) }]);
          const over =
            tokenSpend >= 2000 || callCount >= 10 || costMicros >= 2000;
          // The BICONDITIONAL: neither over-refusal nor under-refusal survives.
          expect(firstBreach(spend, limits, "settled") !== undefined).toBe(over);
        },
      ),
    );
  });

  it("reports the usd ceiling first when several are breached at once", () => {
    const spend = { tokens: 10_000, calls: 99, usd: { kind: "priced" as const, micros: micros(10_000) } };
    const breach = firstBreach(spend, limitsOf([tokens(10), calls(1), { kind: "usd", limit: micros(10) }]), "settled");
    expect(breach?.ceiling.kind).toBe("usd");
  });
});

describe("formatBreach + observedOf", () => {
  it("names the axis, the figure, and the limit", () => {
    const breach = breachOf(pricedCall(2000, micros(0)), tokens(1000), "settled");
    expect(breach).toBeDefined();
    if (breach === undefined) return;
    expect(formatBreach(breach)).toBe("settled tokens 2000 reached the 1000 budget");
    expect(observedOf(breach)).toBe(2000);
  });

  it("renders money as dollars", () => {
    const breach = breachOf(pricedCall(1, usdToMicros(2.5)), usd(1), "projected");
    expect(breach).toBeDefined();
    if (breach === undefined) return;
    expect(formatBreach(breach)).toContain("$2.500000");
    expect(formatBreach(breach)).toContain("$1.000000");
    expect(formatBreach(breach)).toContain("projected");
  });

  it("names the model to price when cost is unevaluable", () => {
    // The message has to be actionable: the fix is to add a PRICE_TABLE entry,
    // and the operator should not have to go and find which model.
    const breach = breachOf(unpricedCall(1, "brand-new-model"), usd(1), "settled");
    expect(breach).toBeDefined();
    if (breach === undefined) return;
    expect(formatBreach(breach)).toContain("brand-new-model");
    expect(formatBreach(breach)).toContain("no price-table entry");
    expect(observedOf(breach)).toBe(0);
  });
});
