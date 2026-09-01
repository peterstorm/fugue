/**
 * Tests for the `Spend` value type (types/spend.ts).
 *
 * `Spend` is what a budget compares against, so its algebra is a business rule,
 * not a utility: it gets properties. The load-bearing ones are that `addSpend`
 * is a genuine commutative monoid (a run's total may not depend on the order
 * its calls settled) and that `unpriced` ABSORBS (a run that touched an
 * unpriced model can never report a trustworthy total again).
 */

import { describe, it, expect } from "bun:test";
import * as fc from "fast-check";
import type { MicroUsd, PricedSpend, Spend } from "../types/spend.js";
import {
  NO_MICROS,
  NO_SPEND,
  addSpend,
  costFloor,
  makeSpend,
  maxSpend,
  microUsd,
  microsToUsd,
  parseSpend,
  pricedCall,
  scaleSpend,
  unknownUsageCall,
  unpricedCall,
  unpricedModels,
  usdToMicros,
} from "../types/spend.js";

const micros = (n: number): MicroUsd => microUsd(n);
const modelsOf = (models: readonly string[]) => {
  const canonical = unpricedModels(models);
  if (canonical === undefined) throw new Error("expected non-empty model names");
  return canonical;
};

/** Arbitrary spends, both priced and unpriced, with realistic magnitudes. */
const arbSpend: fc.Arbitrary<Spend> = fc.oneof(
  fc.record({
    usage: fc.constant("known" as const),
    tokens: fc.nat({ max: 1_000_000 }),
    calls: fc.nat({ max: 100 }),
    usd: fc.nat({ max: 10_000_000 }).map(
      (m): PricedSpend => ({ kind: "priced", micros: micros(m) }),
    ),
  }).map(makeSpend),
  fc.record({
    usage: fc.constant("known" as const),
    tokens: fc.nat({ max: 1_000_000 }),
    calls: fc.nat({ max: 100 }),
    usd: fc
      .tuple(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 3 }),
        fc.nat({ max: 10_000_000 }),
      )
      .map(([models, m]): PricedSpend => ({
        kind: "unpriced",
        // The type guarantees non-emptiness; `uniqueArray` guarantees it at
        // runtime, and sorting matches the canonical form `unionModels` keeps.
        models: modelsOf(models),
        knownMicros: micros(m),
      })),
  }).map(makeSpend),
);

describe("MicroUsd: money as an integer", () => {
  it("rounds every positive USD amount upward so billable calls cannot disappear", () => {
    expect(usdToMicros(1.5)).toBe(micros(1_500_000));
    expect(usdToMicros(0.0000004)).toBe(micros(1));
    expect(usdToMicros(0.0000006)).toBe(micros(1));

    const repeated = Array.from({ length: 10 }, () => pricedCall(0, usdToMicros(0.0000001)))
      .reduce(addSpend, NO_SPEND);
    expect(costFloor(repeated.usd)).toBe(micros(10));
  });

  it("maps every generated positive sub-micro-dollar charge to nonzero spend", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 999 }),
      (nanoUsd) => usdToMicros(nanoUsd / 1_000_000_000) >= micros(1),
    ));
  });

  it("round-trips through the display conversion", () => {
    expect(microsToUsd(usdToMicros(2.5))).toBeCloseTo(2.5, 10);
  });

  it("maps invalid non-positive inputs to zero and positive overflow to saturation", () => {
    // NaN must not poison comparisons and negative values cannot be refunds.
    // Positive infinity/overflow is cost, so it saturates fail-closed.
    expect(usdToMicros(Number.NaN)).toBe(micros(0));
    expect(usdToMicros(Number.POSITIVE_INFINITY)).toBe(microUsd(Number.MAX_SAFE_INTEGER));
    expect(usdToMicros(Number.NEGATIVE_INFINITY)).toBe(micros(0));
    expect(usdToMicros(-5)).toBe(micros(0));
    expect(usdToMicros(Number.MAX_VALUE)).toBe(microUsd(Number.MAX_SAFE_INTEGER));
  });

  it("stays exact under repeated addition where a float would drift", () => {
    const tenth = usdToMicros(0.1);
    const total = [tenth, tenth, tenth]
      .map((amount) => pricedCall(0, amount))
      .reduce(addSpend, NO_SPEND);
    expect(costFloor(total.usd)).toBe(usdToMicros(0.3));
  });

  it("saturates overflowing money and counts at MAX_SAFE_INTEGER (fail closed)", () => {
    const max = pricedCall(Number.MAX_SAFE_INTEGER, microUsd(Number.MAX_SAFE_INTEGER));
    const saturated = addSpend(max, pricedCall(1, microUsd(1)));
    expect(saturated.tokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(saturated.calls).toBe(2);
    expect(costFloor(saturated.usd)).toBe(microUsd(Number.MAX_SAFE_INTEGER));
    expect(scaleSpend(max, 2).tokens).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects forged negative, unsafe, and non-canonical adapter values", () => {
    for (const value of [
      { ...NO_SPEND, tokens: -1 },
      { ...NO_SPEND, calls: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...NO_SPEND,
        usd: { kind: "unpriced", models: ["z", "a"], knownMicros: 0 },
      },
      {
        ...NO_SPEND,
        usd: { kind: "unpriced", models: ["a", "a"], knownMicros: 0 },
      },
    ]) {
      expect(parseSpend(value).ok).toBe(false);
    }
  });
});

describe("UnpricedModels canonicalization", () => {
  it("sorts, deduplicates, and is idempotent for arbitrary non-empty inputs", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 24 }), {
        minLength: 1,
        maxLength: 40,
      }),
      (input) => {
        const canonical = unpricedModels(input);
        expect(canonical).toBeDefined();
        if (canonical === undefined) return;
        expect([...canonical]).toEqual([...new Set(input)].sort());
        expect(unpricedModels(canonical)).toEqual(canonical);
      },
    ));
  });
});

describe("addSpend: a commutative monoid", () => {
  it("has NO_SPEND as identity", () => {
    fc.assert(
      fc.property(arbSpend, (s) => {
        expect(addSpend(s, NO_SPEND)).toEqual(s);
        expect(addSpend(NO_SPEND, s)).toEqual(s);
      }),
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(arbSpend, arbSpend, arbSpend, (a, b, c) => {
        expect(addSpend(addSpend(a, b), c)).toEqual(addSpend(a, addSpend(b, c)));
      }),
    );
  });

  it("is commutative — a run's total cannot depend on the order its calls settled", () => {
    // This is why `unionModels` produces a canonically SORTED list rather than
    // an append: without it, `a + b` and `b + a` would differ structurally in
    // the model ordering while meaning the same thing.
    fc.assert(
      fc.property(arbSpend, arbSpend, (a, b) => {
        expect(addSpend(a, b)).toEqual(addSpend(b, a));
      }),
    );
  });

  it("is monotone on every axis — a provider can only ever add consumption", () => {
    fc.assert(
      fc.property(arbSpend, arbSpend, (a, b) => {
        const sum = addSpend(a, b);
        expect(sum.tokens).toBeGreaterThanOrEqual(a.tokens);
        expect(sum.calls).toBeGreaterThanOrEqual(a.calls);
        expect(costFloor(sum.usd)).toBeGreaterThanOrEqual(costFloor(a.usd));
      }),
    );
  });
});

describe("addSpend: unknown usage absorbs", () => {
  it("cannot become known again under either append order", () => {
    fc.assert(fc.property(arbSpend, (known) => {
      const unknown = unknownUsageCall({ kind: "priced", micros: NO_MICROS });
      expect(addSpend(known, unknown).usage).toBe("unknown");
      expect(addSpend(unknown, known).usage).toBe("unknown");
    }));
  });
});

describe("addSpend: `unpriced` absorbs", () => {
  it("makes any total containing an unpriced call unpriced", () => {
    fc.assert(
      fc.property(arbSpend, arbSpend, (a, b) => {
        const eitherUnpriced = a.usd.kind === "unpriced" || b.usd.kind === "unpriced";
        expect(addSpend(a, b).usd.kind).toBe(eitherUnpriced ? "unpriced" : "priced");
      }),
    );
  });

  it("unions the offending model names rather than keeping only the first", () => {
    const sum = addSpend(unpricedCall(10, "model-z"), unpricedCall(10, "model-a"));
    expect(sum.usd.kind).toBe("unpriced");
    if (sum.usd.kind !== "unpriced") return;
    expect([...sum.usd.models]).toEqual(["model-a", "model-z"]);
  });

  it("keeps the priced portion as a genuine lower bound", () => {
    // The refusal message says "at least $X, plus unpriced model Y" — which is
    // actionable — instead of merely "unknown".
    const sum = addSpend(pricedCall(100, micros(750_000)), unpricedCall(50, "mystery"));
    expect(sum.usd.kind).toBe("unpriced");
    if (sum.usd.kind !== "unpriced") return;
    expect(sum.usd.knownMicros).toBe(micros(750_000));
    expect([...sum.usd.models]).toEqual(["mystery"]);
    expect(sum.tokens).toBe(150);
    expect(sum.calls).toBe(2);
  });
});

describe("per-call constructors", () => {
  it("counts one call, whatever the token count", () => {
    // A `sendWithTools` loop settles as ONE call: its turns are already folded
    // into a single TokenUsage, and one settled call is the granularity the
    // overshoot-by-one guarantee is stated at.
    expect(pricedCall(50_000, micros(1)).calls).toBe(1);
    expect(unpricedCall(50_000, "m").calls).toBe(1);
  });

  it("sanitizes a non-finite token count to zero", () => {
    expect(pricedCall(Number.NaN, micros(0)).tokens).toBe(0);
    expect(unpricedCall(-10, "m").tokens).toBe(0);
  });
});

describe("scaleSpend: the in-flight projection", () => {
  it("multiplies every axis", () => {
    const scaled = scaleSpend(pricedCall(100, micros(2_000)), 3);
    expect(scaled).toEqual(makeSpend({
      usage: "known",
      tokens: 300,
      calls: 3,
      usd: { kind: "priced", micros: micros(6_000) },
    }));
  });

  it("yields a PRICED zero for zero calls, even from an unpriced estimate", () => {
    // Zero in-flight calls have no unknown cost. Returning `unpriced` here
    // would project an unevaluable cost from nothing at all and refuse a run
    // that has nothing outstanding — a budget failing closed for no reason.
    expect(scaleSpend(unpricedCall(100, "m"), 0)).toEqual(NO_SPEND);
    expect(NO_SPEND.usd.kind).toBe("priced");
  });

  it("keeps an unpriced estimate unpriced for one or more calls", () => {
    expect(scaleSpend(unpricedCall(100, "m"), 2).usd.kind).toBe("unpriced");
  });

  it("treats a negative or non-finite count as zero", () => {
    expect(scaleSpend(pricedCall(100, micros(5)), -3)).toEqual(NO_SPEND);
    expect(scaleSpend(pricedCall(100, micros(5)), Number.NaN)).toEqual(NO_SPEND);
  });
});

describe("maxSpend: the learned per-call estimate", () => {
  it("takes the per-axis maximum", () => {
    const a = makeSpend({
      usage: "known",
      tokens: 10,
      calls: 1,
      usd: { kind: "priced", micros: micros(500) },
    });
    const b = makeSpend({
      usage: "known",
      tokens: 4,
      calls: 3,
      usd: { kind: "priced", micros: micros(900) },
    });
    expect(maxSpend(a, b)).toEqual(makeSpend({
      usage: "known",
      tokens: 10,
      calls: 3,
      usd: { kind: "priced", micros: micros(900) },
    }));
  });

  it("prefers unpriced on the cost axis", () => {
    // Once a call of unknown cost has been seen, the estimate for the next one
    // cannot honestly be a number.
    expect(maxSpend(pricedCall(10, micros(9_999)), unpricedCall(1, "m")).usd.kind).toBe("unpriced");
    expect(maxSpend(unpricedCall(1, "m"), pricedCall(10, micros(9_999))).usd.kind).toBe("unpriced");
  });

  it("is commutative and idempotent", () => {
    fc.assert(
      fc.property(arbSpend, arbSpend, (a, b) => {
        expect(maxSpend(a, b)).toEqual(maxSpend(b, a));
        expect(maxSpend(a, a)).toEqual(a);
      }),
    );
  });

  it("dominates both inputs on every axis", () => {
    fc.assert(
      fc.property(arbSpend, arbSpend, (a, b) => {
        const m = maxSpend(a, b);
        expect(m.tokens).toBeGreaterThanOrEqual(Math.max(a.tokens, b.tokens));
        expect(m.calls).toBeGreaterThanOrEqual(Math.max(a.calls, b.calls));
      }),
    );
  });
});
