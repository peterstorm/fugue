// Tests for the fan scheduling vocabulary (F1 PR-D, AD-5/6/8/9/11).
//
// Covers: brand constructors and parsers accept/reject, authored defaults and
// their single-source-of-truth rule, the refusal constructor's derived fields
// (property over arbitrary facts), the refusal seed schema's strictness
// (version, extra fields, correlation refinements, the LEGAL estimator
// fallback it must not "correct"), the types barrel's fan-scheduling surface,
// and a lossless encode → JSON → parse round-trip property over generated
// seeds.

import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import type { Ceiling } from "./budget.js";
import type { FrameworkError } from "./errors.js";
import { nodeId } from "./ids.js";
import * as barrel from "./index.js";
import type { Result } from "./result.js";
import { microUsd } from "./spend.js";
import {
  DEFAULT_FAN_CONCURRENCY_CAP,
  FAN_ESTIMATORS,
  FAN_REFUSAL_HINT,
  FAN_SEED_NAMESPACE,
  FanRefusalSeedSchema,
  childConcurrency,
  fanConcurrencyCap,
  fanRefusal,
  parseChildConcurrency,
  parseFanEstimator,
  parseFanScheduling,
  type ChildConcurrency,
  type FanEstimator,
  type FanRefusal,
  type FanRefusalSeed,
  type SpendSample,
} from "./fan-scheduling.js";

const NODE = nodeId("fan");

const INVALID_POSITIVE_INTS: readonly unknown[] = [
  0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3", null, undefined, true, {},
];

describe("ChildConcurrency / FanConcurrencyCap constructors", () => {
  it("accept positive safe integers", () => {
    expect(childConcurrency(1)).toBe(1 as ChildConcurrency);
    expect(childConcurrency(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER as ChildConcurrency);
    expect(fanConcurrencyCap(16) as number).toBe(16);
  });

  it("throw on anything else, naming the setting", () => {
    for (const bad of INVALID_POSITIVE_INTS) {
      expect(() => childConcurrency(bad as number)).toThrow(/childConcurrency: expected a positive safe integer/);
      expect(() => fanConcurrencyCap(bad as number)).toThrow(/fanConcurrencyCap: expected a positive safe integer/);
    }
  });

  it("default the host cap to 8 (FR-030)", () => {
    expect(DEFAULT_FAN_CONCURRENCY_CAP as number).toBe(8);
  });

  it("agree with each other and with the parser on every number (property)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.double()), (n) => {
        const valid = Number.isSafeInteger(n) && n > 0;
        expect(parseChildConcurrency(NODE, n).ok).toBe(valid);
        if (valid) {
          expect(childConcurrency(n) as number).toBe(n);
          expect(fanConcurrencyCap(n) as number).toBe(n);
        } else {
          expect(() => childConcurrency(n)).toThrow();
          expect(() => fanConcurrencyCap(n)).toThrow();
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("agree at the boundary integers beyond fast-check's 32-bit range", () => {
    for (const big of [2 ** 31, Number.MAX_SAFE_INTEGER]) {
      expect(childConcurrency(big) as number).toBe(big);
      expect(fanConcurrencyCap(big) as number).toBe(big);
      expect(parseChildConcurrency(NODE, big)).toEqual({ ok: true, value: big as ChildConcurrency });
    }
    expect(parseChildConcurrency(NODE, Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
  });

  it("reject a hostile valueOf without coercing it, and render forged values into the message", () => {
    const hostile = { valueOf: () => 3 };
    expect(() => childConcurrency(hostile as unknown as number)).toThrow(/childConcurrency/);
    expect(() => fanConcurrencyCap(hostile as unknown as number)).toThrow(/fanConcurrencyCap/);
    expect(parseChildConcurrency(NODE, hostile).ok).toBe(false);
    const forged = parseChildConcurrency(NODE, "3");
    expect(!forged.ok && forged.error.message).toContain('got "3"');
  });
});

describe("parseChildConcurrency", () => {
  it("returns the brand for a positive safe integer", () => {
    expect(parseChildConcurrency(NODE, 4)).toEqual({ ok: true, value: 4 as ChildConcurrency });
  });

  it("rejects with a validation error naming the node, field and value (FR-032)", () => {
    for (const bad of INVALID_POSITIVE_INTS) {
      const r = parseChildConcurrency(NODE, bad);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe("validation");
      expect(r.error.nodeId).toBe(NODE);
      expect(r.error.path).toBe("childConcurrency");
      expect(r.error.message).toContain("'fan'");
      expect(r.error.message).toContain("childConcurrency");
    }
    const zero = parseChildConcurrency(NODE, 0);
    expect(!zero.ok && zero.error.message).toContain("got 0");
  });

  it("produces errors that are FrameworkErrors without conversion", () => {
    const asFramework: Result<ChildConcurrency, FrameworkError> = parseChildConcurrency(NODE, 0);
    expect(asFramework.ok).toBe(false);
  });

  it("renders a hostile valueOf without coercing it (no '3' leaks into the message)", () => {
    const hostile = { valueOf: () => 3 };
    const r = parseChildConcurrency(NODE, hostile);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain("[object Object]");
      expect(r.error.message).not.toContain("3");
    }
  });
});

describe("parseFanEstimator", () => {
  it("accepts exactly the closed set (FR-046)", () => {
    expect(FAN_ESTIMATORS).toEqual(["largest-seen", "p50", "p90", "p95"]);
    for (const e of FAN_ESTIMATORS) expect(parseFanEstimator(NODE, e)).toEqual({ ok: true, value: e });
  });

  it("rejects anything else, naming node, field and value", () => {
    for (const bad of ["p99", "LARGEST-SEEN", "", 50, null, undefined, ["p50"]]) {
      const r = parseFanEstimator(NODE, bad);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toMatchObject({ kind: "validation", nodeId: NODE, path: "estimator" });
      expect(r.error.message).toContain("estimator");
      expect(r.error.message).toContain("largest-seen, p50, p90, p95");
    }
  });

  it("names the offending value in the rejection", () => {
    const textual = parseFanEstimator(NODE, "median");
    expect(!textual.ok && textual.error.message).toContain('got "median"');
    const numeric = parseFanEstimator(NODE, 50);
    expect(!numeric.ok && numeric.error.message).toContain("got 50");
  });
});

describe("parseFanScheduling", () => {
  it("defaults to childConcurrency 1 and largest-seen (FR-001, FR-046)", () => {
    const r = parseFanScheduling(NODE, {});
    expect(r).toEqual({ ok: true, value: { childConcurrency: 1 as ChildConcurrency, estimator: "largest-seen" } });
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });

  it("keeps authored values", () => {
    expect(parseFanScheduling(NODE, { childConcurrency: 6, estimator: "p90" })).toEqual({
      ok: true,
      value: { childConcurrency: 6 as ChildConcurrency, estimator: "p90" },
    });
  });

  it("rejects the first invalid field", () => {
    const badConcurrency = parseFanScheduling(NODE, { childConcurrency: -2, estimator: "p90" });
    expect(!badConcurrency.ok && badConcurrency.error.path).toBe("childConcurrency");
    const badEstimator = parseFanScheduling(NODE, { childConcurrency: 2, estimator: "median" });
    expect(!badEstimator.ok && badEstimator.error.path).toBe("estimator");
  });

  it("treats undefined fields as absent and null as present-invalid, reporting the first invalid field", () => {
    expect(parseFanScheduling(NODE, { childConcurrency: undefined, estimator: undefined })).toEqual({
      ok: true,
      value: { childConcurrency: 1 as ChildConcurrency, estimator: "largest-seen" },
    });
    const nullConcurrency = parseFanScheduling(NODE, { childConcurrency: null, estimator: "p90" });
    expect(!nullConcurrency.ok && nullConcurrency.error.path).toBe("childConcurrency");
    const nullEstimator = parseFanScheduling(NODE, { childConcurrency: 1, estimator: null });
    expect(!nullEstimator.ok && nullEstimator.error.path).toBe("estimator");
    const bothInvalid = parseFanScheduling(NODE, { childConcurrency: null, estimator: null });
    expect(!bothInvalid.ok && bothInvalid.error.path).toBe("childConcurrency");
  });

  it("ignores unrelated extra fields on the authored input (strictness lives in the authored schema, T6)", () => {
    const authored = { childConcurrency: 3, estimator: "p50", unrelated: "junk" };
    const r = parseFanScheduling(NODE, authored);
    expect(r).toEqual({ ok: true, value: { childConcurrency: 3 as ChildConcurrency, estimator: "p50" } });
  });

  it("is idempotent over arbitrary valid authored input (property)", () => {
    const authoredArb = fc.record({
      childConcurrency: fc.option(fc.integer({ min: 1, max: 1024 }), { nil: undefined }),
      estimator: fc.option(fc.constantFrom(...FAN_ESTIMATORS), { nil: undefined }),
    });
    fc.assert(
      fc.property(authoredArb, (authored) => {
        const once = parseFanScheduling(NODE, authored);
        if (!once.ok) throw new Error(`valid authored scheduling rejected: ${once.error.message}`);
        const twice = parseFanScheduling(NODE, once.value);
        if (!twice.ok) throw new Error(`re-parsing a parsed result rejected: ${twice.error.message}`);
        expect(twice.value).toEqual(once.value);
        expect(Object.isFrozen(twice.value)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Refusals and seeds
// ---------------------------------------------------------------------------

const sample = (tokens: number, calls: number, usd: number, lowerBound = false): SpendSample => ({
  tokens, calls, usdMicros: microUsd(usd), lowerBound,
});

const refusalFacts = (ceiling: Ceiling) => ({
  ceiling,
  perChildEstimate: 500,
  estimatorApplied: "largest-seen" as FanEstimator,
  effectiveConcurrency: 4,
  completed: 3,
  remaining: 7,
  lowerBound: true,
});

const tokensCeiling: Ceiling = { kind: "tokens", limit: 2000 };

const validSeed = (): FanRefusalSeed => ({
  version: 1,
  estimator: "p90",
  samples: [sample(400, 1, 120), sample(500, 2, 150, true)],
  estimate: sample(500, 2, 150, true),
  ceilings: [{ kind: "usd", limit: microUsd(1_000_000) }, tokensCeiling],
  refusal: fanRefusal(refusalFacts(tokensCeiling)),
});

const roundTrip = (seed: FanRefusalSeed): unknown => JSON.parse(JSON.stringify(seed));

// Shared generators: arbitrary counts, samples and ceilings (all safe-int
// domains, so every generated value is both valid in memory and JSON-exact).
const count = fc.nat({ max: Number.MAX_SAFE_INTEGER });
const sampleArb = fc.record({
  tokens: count,
  calls: count,
  usdMicros: count.map(microUsd),
  lowerBound: fc.boolean(),
});
const ceilingArb: fc.Arbitrary<Ceiling> = fc.oneof(
  count.map((limit): Ceiling => ({ kind: "tokens", limit })),
  count.map((limit): Ceiling => ({ kind: "calls", limit })),
  count.map((limit): Ceiling => ({ kind: "usd", limit: microUsd(limit) })),
);

describe("fanRefusal", () => {
  it("derives the axis from the ceiling, attaches the hint, pins scopePath, freezes (FR-014)", () => {
    for (const ceiling of [tokensCeiling, { kind: "calls", limit: 9 }, { kind: "usd", limit: microUsd(5) }] as const) {
      const r: FanRefusal = fanRefusal(refusalFacts(ceiling));
      expect(r.axis).toBe(ceiling.kind);
      expect(r.ceiling).toEqual(ceiling);
      expect(r.hint).toBe(FAN_REFUSAL_HINT);
      expect(r.scopePath).toEqual([]);
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.scopePath)).toBe(true);
      expect(r).toMatchObject({ perChildEstimate: 500, effectiveConcurrency: 4, completed: 3, remaining: 7, lowerBound: true, estimatorApplied: "largest-seen" });
    }
  });

  it("names the remedy: redeploy with a larger budget", () => {
    expect(FAN_REFUSAL_HINT).toContain("redeploy the DAG with a larger budget");
  });

  it("is total over arbitrary facts and ceilings (property)", () => {
    const factsArb = fc.record({
      perChildEstimate: fc.nat(),
      estimatorApplied: fc.constantFrom(...FAN_ESTIMATORS),
      effectiveConcurrency: fc.integer({ min: 1, max: 1024 }),
      completed: fc.nat(),
      remaining: fc.nat(),
      lowerBound: fc.boolean(),
    });
    fc.assert(
      fc.property(factsArb, ceilingArb, (facts, ceiling) => {
        const r = fanRefusal({ ...facts, ceiling });
        expect(r.axis).toBe(ceiling.kind);
        expect(r.ceiling).toEqual(ceiling);
        expect(r.hint).toBe(FAN_REFUSAL_HINT);
        expect(r.scopePath).toEqual([]);
        expect(Object.isFrozen(r)).toBe(true);
        expect(Object.isFrozen(r.scopePath)).toBe(true);
        expect(r).toMatchObject(facts);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("FanRefusalSeedSchema", () => {
  it("uses the fan-seed checkpoint namespace", () => {
    expect(FAN_SEED_NAMESPACE).toBe("fan-seed");
  });

  it("parses a valid seed after a JSON round-trip, losslessly", () => {
    const seed = validSeed();
    expect(FanRefusalSeedSchema.parse(roundTrip(seed))).toEqual(seed);
  });

  it("rejects any version other than 1", () => {
    for (const version of [0, 2, "1", undefined]) {
      expect(FanRefusalSeedSchema.safeParse({ ...validSeed(), version }).success).toBe(false);
    }
  });

  it("rejects extra fields at every level", () => {
    const seed = validSeed();
    const variants: readonly unknown[] = [
      { ...seed, extra: true },
      { ...seed, estimate: { ...seed.estimate, extra: 1 } },
      { ...seed, samples: [{ ...seed.samples[0], extra: 1 }] },
      { ...seed, ceilings: [{ ...tokensCeiling, extra: 1 }] },
      { ...seed, refusal: { ...seed.refusal, extra: 1 } },
      { ...seed, refusal: { ...seed.refusal, ceiling: { ...tokensCeiling, extra: 1 } } },
    ];
    for (const v of variants) expect(FanRefusalSeedSchema.safeParse(roundTrip(v as FanRefusalSeed)).success).toBe(false);
  });

  it("rejects a refusal whose axis disagrees with its ceiling", () => {
    const seed = validSeed();
    expect(FanRefusalSeedSchema.safeParse({ ...seed, refusal: { ...seed.refusal, axis: "calls" } }).success).toBe(false);
  });

  it("rejects a refusal ceiling absent from the seed's ceilings", () => {
    const seed = validSeed();
    expect(FanRefusalSeedSchema.safeParse({ ...seed, ceilings: [{ kind: "tokens", limit: 9999 }] }).success).toBe(false);
  });

  it("rejects two ceilings on one axis", () => {
    const seed = validSeed();
    expect(FanRefusalSeedSchema.safeParse({ ...seed, ceilings: [tokensCeiling, { kind: "tokens", limit: 1 }] }).success).toBe(false);
  });

  it("rejects even identical duplicate ceilings on one axis", () => {
    const seed = validSeed();
    expect(
      FanRefusalSeedSchema.safeParse({ ...seed, ceilings: [tokensCeiling, { kind: "tokens", limit: tokensCeiling.limit }] }).success,
    ).toBe(false);
  });

  it("keeps the authored estimator and the applied one uncorrelated — percentile fallback is legal (FR-046)", () => {
    const seed = validSeed();
    // validSeed() already pairs authored "p90" with applied "largest-seen": a
    // percentile that fell back below 5 settled children.
    expect(seed.estimator).toBe("p90");
    expect(seed.refusal.estimatorApplied).toBe("largest-seen");
    const parsed = FanRefusalSeedSchema.parse(roundTrip(seed));
    expect(parsed.estimator).toBe("p90");
    expect(parsed.refusal.estimatorApplied).toBe("largest-seen");
    // The reverse pairing parses just as well.
    const swapped: FanRefusalSeed = {
      ...seed,
      estimator: "p95",
      refusal: fanRefusal({ ...refusalFacts(tokensCeiling), estimatorApplied: "p95" }),
    };
    expect(FanRefusalSeedSchema.parse(roundTrip(swapped)).refusal.estimatorApplied).toBe("p95");
  });

  it("parses a seed with zero samples — the estimate is authoritative, samples are advisory history", () => {
    const seed = validSeed();
    const parsed = FanRefusalSeedSchema.parse(roundTrip({ ...seed, samples: [] }));
    expect(parsed.samples).toEqual([]);
    expect(parsed.estimate).toEqual(seed.estimate);
  });

  it("rejects malformed numbers, estimators and a non-empty scopePath", () => {
    const seed = validSeed();
    const variants: readonly unknown[] = [
      { ...seed, estimate: { ...seed.estimate, tokens: -1 } },
      { ...seed, estimate: { ...seed.estimate, usdMicros: 1.5 } },
      { ...seed, estimator: "p99" },
      { ...seed, refusal: { ...seed.refusal, effectiveConcurrency: 0 } },
      { ...seed, refusal: { ...seed.refusal, scopePath: [{ mapNodeId: "x", index: 0 }] } },
      { ...seed, refusal: { ...seed.refusal, hint: "" } },
    ];
    for (const v of variants) expect(FanRefusalSeedSchema.safeParse(v).success).toBe(false);
  });

  it("rejects malformed numbers at the sample and refusal level", () => {
    const seed = validSeed();
    const first = seed.samples[0]!;
    const variants: readonly unknown[] = [
      { ...seed, samples: [{ ...first, tokens: -1 }] },
      { ...seed, samples: [{ ...first, calls: 1.5 }] },
      { ...seed, samples: [{ ...first, usdMicros: -1 }] },
      { ...seed, samples: [{ ...first, lowerBound: "yes" }] },
      { ...seed, refusal: { ...seed.refusal, completed: -1 } },
      { ...seed, refusal: { ...seed.refusal, perChildEstimate: 1.5 } },
    ];
    for (const v of variants) expect(FanRefusalSeedSchema.safeParse(v).success).toBe(false);
  });

  it("cannot carry a refusal with empty ceilings (correlation)", () => {
    const seed = validSeed();
    const r = FanRefusalSeedSchema.safeParse({ ...seed, ceilings: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const at = r.error.issues.some((i) => JSON.stringify(i.path) === JSON.stringify(["refusal", "ceiling"]));
      expect(at).toBe(true);
    }
  });

  it("rejects micro-USD beyond the safe-integer domain and keeps the maximum lossless", () => {
    const seed = validSeed();
    // The wire boundary refuses out-of-domain values fail-closed (the microUsd
    // saturation is for internal arithmetic, never for a parsed seed).
    const beyond = { ...seed, estimate: { ...seed.estimate, usdMicros: Number.MAX_SAFE_INTEGER + 1 } };
    expect(FanRefusalSeedSchema.safeParse(beyond).success).toBe(false);
    const infinite = { ...seed, estimate: { ...seed.estimate, usdMicros: Number.POSITIVE_INFINITY } };
    expect(FanRefusalSeedSchema.safeParse(infinite).success).toBe(false);
    const maximal = FanRefusalSeedSchema.parse({
      ...seed,
      estimate: { tokens: 1, calls: 1, usdMicros: Number.MAX_SAFE_INTEGER, lowerBound: false },
    });
    expect(maximal.estimate.usdMicros as number).toBe(Number.MAX_SAFE_INTEGER);
    // The maximal seed is itself lossless on the wire (MAX_SAFE_INTEGER is JSON-exact).
    expect(FanRefusalSeedSchema.parse(JSON.parse(JSON.stringify(maximal)))).toEqual(maximal);
  });

  it("rejects non-object payloads", () => {
    for (const bad of ["seed", 42, null, [], true]) {
      expect(FanRefusalSeedSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("round-trips any valid seed through JSON losslessly (property)", () => {
    const ceilingsArb = fc.uniqueArray(ceilingArb, { minLength: 1, maxLength: 3, selector: (c) => c.kind });
    const seedArb = fc
      .record({
        estimator: fc.constantFrom(...FAN_ESTIMATORS),
        samples: fc.array(sampleArb, { maxLength: 20 }),
        estimate: sampleArb,
        ceilings: ceilingsArb,
        pick: fc.nat(),
        perChildEstimate: count,
        estimatorApplied: fc.constantFrom(...FAN_ESTIMATORS),
        effectiveConcurrency: fc.integer({ min: 1, max: 1024 }),
        completed: count,
        remaining: count,
        lowerBound: fc.boolean(),
      })
      .map(({ ceilings, pick, estimator, samples, estimate, ...facts }): FanRefusalSeed => ({
        version: 1,
        estimator,
        samples,
        estimate,
        ceilings,
        refusal: fanRefusal({ ...facts, ceiling: ceilings[pick % ceilings.length]! }),
      }));

    fc.assert(
      fc.property(seedArb, (seed) => {
        const parsed = FanRefusalSeedSchema.parse(roundTrip(seed));
        expect(parsed).toEqual(seed);
        // Idempotent: a second encode → parse cycle is a fixed point.
        expect(JSON.stringify(FanRefusalSeedSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(JSON.stringify(parsed));
      }),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Barrel surface (types/index.ts)
// ---------------------------------------------------------------------------

describe("types barrel surface", () => {
  it("re-exports the fan scheduling vocabulary by name", () => {
    expect(barrel.DEFAULT_FAN_CONCURRENCY_CAP).toBe(DEFAULT_FAN_CONCURRENCY_CAP);
    expect(barrel.childConcurrency).toBe(childConcurrency);
    expect(barrel.fanConcurrencyCap).toBe(fanConcurrencyCap);
    expect(barrel.parseChildConcurrency).toBe(parseChildConcurrency);
    expect(barrel.parseFanEstimator).toBe(parseFanEstimator);
    expect(barrel.parseFanScheduling).toBe(parseFanScheduling);
    expect(barrel.FAN_ESTIMATORS).toBe(FAN_ESTIMATORS);
  });

  it("keeps the refusal constructor, hint and seed persistence internals out of the barrel", () => {
    // The refusal constructor, its hint and the seed trio (schema, namespace,
    // version) are runtime persistence internals consumed via concrete
    // imports; the barrel is the authoring + runtime vocabulary only.
    expect("fanRefusal" in barrel).toBe(false);
    expect("FAN_REFUSAL_HINT" in barrel).toBe(false);
    expect("FanRefusalSeedSchema" in barrel).toBe(false);
    expect("FAN_SEED_NAMESPACE" in barrel).toBe(false);
    expect("FAN_SEED_VERSION" in barrel).toBe(false);
  });
});
