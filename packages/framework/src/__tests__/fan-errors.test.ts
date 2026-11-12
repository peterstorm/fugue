/**
 * The fan error kinds (F1 PR-D, AD-6): `fan-budget-refused` and
 * `fan-child-failed`.
 *
 * Pins the human-facing line (FR-014: redeploy hint, effective concurrency,
 * lower-bound wording), the retry classification (refusal non-retriable,
 * child-failed follows its primary), the factory invariant (FR-021: the
 * primary is the unique lowest failure index), and the persisted round-trip of
 * the refusal kind and of every `FanFailureCauses` arm (FR-015, FR-025).
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { frameworkError } from "../types/error-factories.js";
import {
  asFrameworkError,
  asNodeFrameworkError,
  formatFrameworkError,
  isFrameworkError,
  isFrameworkErrorKind,
  messageOf,
  PersistedFrameworkErrorSchema,
  retriabilityOf,
  usageOfError,
  type FrameworkError,
} from "../types/errors.js";
import {
  FAN_ESTIMATORS,
  FAN_REFUSAL_HINT,
  fanRefusal,
  type FanFailureCauses,
  type FanRefusal,
  type FanRefusalFacts,
  type IndexedError,
} from "../types/fan-scheduling.js";
import { nodeId as makeNodeId } from "../types/ids.js";
import { mapIndex } from "../types/map-index.js";
import { microUsd } from "../types/spend.js";
import { tokensOnly } from "../types/token-usage.js";

const mapNode = makeNodeId("fan-map");
const childNode = makeNodeId("fan-child");

const refusalFacts: FanRefusalFacts = {
  ceiling: { kind: "usd", limit: microUsd(2_000_000) },
  perChildEstimate: 250_000,
  estimatorApplied: "p90",
  effectiveConcurrency: 4,
  completed: 6,
  remaining: 10,
  lowerBound: false,
};
const refusal = fanRefusal(refusalFacts);
const lowerBoundRefusal = fanRefusal({ ...refusalFacts, lowerBound: true });

const failed = (index: number, error: FrameworkError): IndexedError<FrameworkError> =>
  ({ index: mapIndex(index), error });
const crash = (message: string): FrameworkError =>
  ({ kind: "node-crash", nodeId: childNode, message, retriability: "non-retriable" });
const transient = (message: string): FrameworkError =>
  ({ kind: "transient", nodeId: childNode, message });

/** JSON on the wire and back through the framework's own parser. */
const roundTrip = (e: FrameworkError): FrameworkError =>
  PersistedFrameworkErrorSchema.parse(JSON.parse(JSON.stringify(e)));

describe("fan-budget-refused", () => {
  const refused = frameworkError.fanBudgetRefused(mapNode, refusal);

  it("is a distinct kind carrying the whole refusal record (FR-014, FR-015)", () => {
    expect(refused.kind).toBe("fan-budget-refused");
    expect(isFrameworkErrorKind("fan-budget-refused")).toBe(true);
    expect(isFrameworkErrorKind("fan-child-failed")).toBe(true);
    if (refused.kind !== "fan-budget-refused") throw new Error("unreachable");
    expect(refused.nodeId).toBe(mapNode);
    expect(refused.refusal).toBe(refusal);
  });

  it("formats the ceiling, estimate, estimator, counts, effective concurrency and redeploy hint", () => {
    const line = formatFrameworkError(refused);
    expect(line).toContain(`map node '${mapNode}'`);
    expect(line).toContain("usd axis");
    expect(line).toContain("$0.250000 per child");
    expect(line).toContain("$2.000000 ceiling");
    expect(line).toContain("estimator p90");
    expect(line).toContain("completed 6");
    expect(line).toContain("remaining 10");
    expect(line).toContain("effective concurrency 4");
    expect(line).toContain(FAN_REFUSAL_HINT);
    expect(line).toContain("redeploy the DAG with a larger budget");
    expect(line).not.toContain("lower bound");
  });

  it("says the figures are a lower bound exactly when the refusal is one", () => {
    const line = formatFrameworkError(frameworkError.fanBudgetRefused(mapNode, lowerBoundRefusal));
    expect(line).toContain("lower bound");
    expect(line).toContain("true spend may be higher");
  });

  it("renders count axes in their own unit", () => {
    const tokens = fanRefusal({ ...refusalFacts, ceiling: { kind: "tokens", limit: 1000 }, perChildEstimate: 120 });
    const line = formatFrameworkError(frameworkError.fanBudgetRefused(mapNode, tokens));
    expect(line).toContain("tokens axis");
    expect(line).toContain("120 tokens per child");
    expect(line).toContain("1000 tokens ceiling");
  });

  it("renders the calls axis in its own unit too", () => {
    const calls = fanRefusal({ ...refusalFacts, ceiling: { kind: "calls", limit: 10 }, perChildEstimate: 2 });
    const line = formatFrameworkError(frameworkError.fanBudgetRefused(mapNode, calls));
    expect(line).toContain("calls axis");
    expect(line).toContain("2 calls per child");
    expect(line).toContain("10 calls ceiling");
  });

  it("is non-retriable, so the root node retry never loops a refusal", () => {
    expect(retriabilityOf(refused)).toBe("non-retriable");
  });

  it("carries no attributable usage and serialises whole into messageOf", () => {
    expect(usageOfError(refused)).toBeUndefined();
    expect(JSON.parse(messageOf(refused))).toEqual(JSON.parse(JSON.stringify(refused)));
  });

  it("round-trips through the persisted schema losslessly, identity intact", () => {
    expect(roundTrip(refused)).toEqual(refused);
    expect(isFrameworkError(refused)).toBe(true);
  });

  it("recovers a canonical fan error from its wire record via asFrameworkError", () => {
    const wire = JSON.parse(JSON.stringify(refused));
    const recovered = asFrameworkError(wire);
    expect(recovered).toEqual(refused);
    // Recovery returns a NEW canonical value, never the hostile source object.
    expect(recovered).not.toBe(wire);
  });

  it("round-trips any refusal record (property)", () => {
    const facts = fc.record({
      ceiling: fc.oneof(
        fc.record({ kind: fc.constant("tokens" as const), limit: fc.nat() }),
        fc.record({ kind: fc.constant("calls" as const), limit: fc.nat() }),
        fc.record({ kind: fc.constant("usd" as const), limit: fc.nat().map(microUsd) }),
      ),
      perChildEstimate: fc.nat(),
      estimatorApplied: fc.constantFrom(...FAN_ESTIMATORS),
      effectiveConcurrency: fc.integer({ min: 1, max: 64 }),
      completed: fc.nat(),
      remaining: fc.nat(),
      lowerBound: fc.boolean(),
    });
    fc.assert(fc.property(facts, (f) => {
      const e = frameworkError.fanBudgetRefused(mapNode, fanRefusal(f));
      expect(roundTrip(e)).toEqual(e);
      expect(isFrameworkError(e)).toBe(true);
    }));
  });

  it("rejects a persisted refusal whose axis disagrees with its ceiling", () => {
    const wire = JSON.parse(JSON.stringify(refused)) as { refusal: { axis: string } };
    wire.refusal.axis = "tokens";
    expect(PersistedFrameworkErrorSchema.safeParse(wire).success).toBe(false);
    expect(asFrameworkError(wire)).toBeUndefined();
  });

  it("rejects a persisted refusal with an unknown estimator or a non-integer count", () => {
    const badEstimator = JSON.parse(JSON.stringify(refused)) as { refusal: Record<string, unknown> };
    badEstimator.refusal["estimatorApplied"] = "p99";
    expect(PersistedFrameworkErrorSchema.safeParse(badEstimator).success).toBe(false);
    const badCount = JSON.parse(JSON.stringify(refused)) as { refusal: Record<string, unknown> };
    badCount.refusal["remaining"] = -1;
    expect(PersistedFrameworkErrorSchema.safeParse(badCount).success).toBe(false);
  });
});

describe("fan-child-failed", () => {
  const primary = failed(1, transient("rate limited"));
  const secondary = [failed(3, crash("boom")), failed(7, crash("bang"))] as const;
  const arms: ReadonlyArray<readonly [string, FanFailureCauses<FrameworkError>]> = [
    ["secondaries", { kind: "secondaries", secondary }],
    ["refusal", { kind: "refusal", refusal }],
    ["secondaries-and-refusal", { kind: "secondaries-and-refusal", secondary, refusal: lowerBoundRefusal }],
  ];

  for (const [label, causes] of arms) {
    it(`round-trips the '${label}' arm through the persisted schema losslessly (FR-021, FR-025)`, () => {
      const e = frameworkError.fanChildFailed(mapNode, primary, causes);
      expect(e.kind).toBe("fan-child-failed");
      expect(roundTrip(e)).toEqual(e);
      expect(isFrameworkError(e)).toBe(true);
    });
  }

  it("serialises whole into messageOf and round-trips a nested fan-budget-refused primary on the wire", () => {
    // Two separate refusal instances, one per position: the wire parse
    // materialises one canonical per path, and the recursion must hold.
    const nested = frameworkError.fanBudgetRefused(childNode, fanRefusal({ ...refusalFacts }));
    const e = frameworkError.fanChildFailed(mapNode, failed(0, nested), { kind: "refusal", refusal });
    expect(JSON.parse(messageOf(e))).toEqual(JSON.parse(JSON.stringify(e)));
    // The nested primary crosses the recursive (z.lazy) wire arm, so a fan
    // refusal can travel inside a child error without losing its FR-014 record.
    expect(roundTrip(e)).toEqual(e);
    expect(isFrameworkError(e)).toBe(true);
  });

  it("narrows at a boundary even when one refusal object is shared between the primary and the causes (FR-025)", () => {
    // ONE refusal instance referenced from BOTH the nested primary and the
    // attached causes — a DAG-shared subtree the parser materialises twice.
    // The exactness comparison answers per visit, so the typed error narrows
    // instead of being re-wrapped (which would drop the refusal), and the
    // data still round-trips losslessly.
    const e = frameworkError.fanChildFailed(
      mapNode,
      failed(0, frameworkError.fanBudgetRefused(childNode, refusal)),
      { kind: "refusal", refusal },
    );
    expect(isFrameworkError(e)).toBe(true);
    expect(roundTrip(e)).toEqual(e);
    // The same holds for two secondaries sharing one error object.
    const shared = crash("s");
    const sharedSecondaries = frameworkError.fanChildFailed(mapNode, failed(0, crash("p")), {
      kind: "secondaries",
      secondary: [failed(1, shared), failed(2, shared)],
    });
    expect(isFrameworkError(sharedSecondaries)).toBe(true);
    expect(roundTrip(sharedSecondaries)).toEqual(sharedSecondaries);
  });

  it("formats the primary first, then every secondary, then the attached refusal with its hint", () => {
    const line = formatFrameworkError(
      frameworkError.fanChildFailed(mapNode, primary, { kind: "secondaries-and-refusal", secondary, refusal: lowerBoundRefusal }),
    );
    expect(line).toContain(`map node '${mapNode}': child 1 failed: node '${childNode}' transient failure: rate limited`);
    expect(line).toContain("2 further child failures (child 3: node-crash, child 7: node-crash)");
    expect(line).toContain("effective concurrency 4");
    expect(line).toContain("lower bound");
    expect(line).toContain(FAN_REFUSAL_HINT);
    expect(line.indexOf("child 1 failed")).toBeLessThan(line.indexOf("child 3"));
    expect(line.indexOf("child 7")).toBeLessThan(line.indexOf("refused by budget projection"));
  });

  it("an attached refusal renders the full FR-014 story even inside a child-failed error", () => {
    // FR-025's stakes, on the human line: the attached refusal is the whole
    // record, not a stub — the operator reads the same ceiling, estimate,
    // estimator, concurrency, counts and redeploy hint they would from a bare
    // refusal, and the lower-bound wording follows the attached record's flag.
    const line = formatFrameworkError(frameworkError.fanChildFailed(mapNode, primary, { kind: "refusal", refusal }));
    expect(line).toContain("effective concurrency 4");
    expect(line).toContain("estimator p90");
    expect(line).toContain("$2.000000 ceiling");
    expect(line).toContain(FAN_REFUSAL_HINT);
    expect(line).not.toContain("lower bound");
  });

  it("messageOf serialises each causes arm whole, so no refusal field is lost in retry summaries", () => {
    // `messageOf` feeds `retry-exhausted.lastError`; a partial serialisation
    // here would bury FR-014 data in the one string a retried run keeps.
    for (const [, causes] of arms) {
      const e = frameworkError.fanChildFailed(mapNode, primary, causes);
      expect(JSON.parse(messageOf(e))).toEqual(JSON.parse(JSON.stringify(e)));
    }
  });

  it("round-trips a child-failed error whose attached refusal breaches each axis (property)", () => {
    const refusalsPerAxis = [
      fanRefusal({ ...refusalFacts, ceiling: { kind: "tokens", limit: 1000 }, perChildEstimate: 120 }),
      fanRefusal({ ...refusalFacts, ceiling: { kind: "calls", limit: 10 }, perChildEstimate: 2 }),
      refusal, // usd
    ];
    fc.assert(fc.property(fc.constantFrom(...refusalsPerAxis), (attached) => {
      const e = frameworkError.fanChildFailed(mapNode, primary, { kind: "refusal", refusal: attached });
      expect(roundTrip(e)).toEqual(e);
      expect(isFrameworkError(e)).toBe(true);
    }));
  });

  it("formats a nested fan-child-failed primary recursively: the inner story embeds verbatim", () => {
    const inner = frameworkError.fanChildFailed(childNode, failed(0, transient("inner")), { kind: "refusal", refusal });
    const outer = frameworkError.fanChildFailed(mapNode, failed(0, inner), {
      kind: "secondaries",
      secondary: [failed(1, crash("s"))],
    });
    const line = formatFrameworkError(outer);
    expect(line).toContain(
      `map node '${mapNode}': child 0 failed: map node '${childNode}': child 0 failed: node '${childNode}' transient failure: inner`,
    );
    expect(line).toContain("child 1: node-crash");
    expect(line.indexOf("child 0 failed")).toBeLessThan(line.indexOf("child 1: node-crash"));
  });

  it("formats a single secondary in the singular and a refusal-only cause without secondaries", () => {
    const one = formatFrameworkError(
      frameworkError.fanChildFailed(mapNode, primary, { kind: "secondaries", secondary: [failed(2, crash("x"))] }),
    );
    expect(one).toContain("1 further child failure (child 2: node-crash)");
    const refusalOnly = formatFrameworkError(frameworkError.fanChildFailed(mapNode, primary, { kind: "refusal", refusal }));
    expect(refusalOnly).not.toContain("further child failure");
    expect(refusalOnly).toContain("also refused by budget projection");
  });

  it("takes its retriability from the primary child error, whatever the causes (property)", () => {
    const primaries: readonly FrameworkError[] = [
      transient("retry me"),
      crash("deterministic"),
      { kind: "node-crash", nodeId: childNode, message: "flaky", retriability: "retriable" },
      { kind: "validation", nodeId: childNode, message: "bad output" },
      frameworkError.fanBudgetRefused(childNode, refusal),
    ];
    fc.assert(fc.property(
      fc.constantFrom(...primaries),
      fc.constantFrom(...arms.map(([, c]) => c)),
      (error, causes) => {
        const e = frameworkError.fanChildFailed(mapNode, failed(0, error), causes);
        expect(retriabilityOf(e)).toBe(retriabilityOf(error));
      },
    ));
  });

  it("follows its primary recursively: a nested fan-child-failed inherits the innermost primary's retriability (property)", () => {
    const primaries: readonly FrameworkError[] = [
      transient("retry me"),
      crash("deterministic"),
      { kind: "node-crash", nodeId: childNode, message: "flaky", retriability: "retriable" },
      frameworkError.fanBudgetRefused(childNode, refusal),
    ];
    fc.assert(fc.property(
      fc.constantFrom(...primaries),
      fc.constantFrom(...arms.map(([, c]) => c)),
      (innermost, innerCauses) => {
        const innerFan = frameworkError.fanChildFailed(childNode, failed(0, innermost), innerCauses);
        const outer = frameworkError.fanChildFailed(mapNode, failed(0, innerFan), {
          kind: "secondaries",
          secondary: [failed(1, crash("s"))],
        });
        expect(retriabilityOf(outer)).toBe(retriabilityOf(innermost));
      },
    ));
  });

  it("never double-counts a child's usage: the fan error itself carries none", () => {
    const withUsage: FrameworkError = { kind: "transient", nodeId: childNode, message: "t", usage: tokensOnly(5, 5) };
    const e = frameworkError.fanChildFailed(mapNode, failed(0, withUsage), { kind: "refusal", refusal });
    expect(usageOfError(e)).toBeUndefined();
  });

  it("re-correlates a nested checkpoint-write-failed child error on the way back in", () => {
    const nested = frameworkError.checkpointWriteFailed("run-1", "fan-child", "disk full");
    const e = frameworkError.fanChildFailed(mapNode, failed(0, nested), { kind: "refusal", refusal });
    expect(roundTrip(e)).toEqual(e);
  });

  it("round-trips a retry-exhausted child whose rootErrorKind is a fan kind (the wire enum carries both)", () => {
    const wrappedChildFailure = frameworkError.retryExhausted(childNode, 3, "…", "fan-child-failed");
    const e = frameworkError.fanChildFailed(mapNode, failed(0, wrappedChildFailure), { kind: "refusal", refusal });
    expect(roundTrip(e)).toEqual(e);
    expect(isFrameworkError(e)).toBe(true);
    const wrappedRefusal = frameworkError.retryExhausted(childNode, 2, "…", "fan-budget-refused");
    expect(roundTrip(wrappedRefusal)).toEqual(wrappedRefusal);
    expect(isFrameworkError(wrappedRefusal)).toBe(true);
  });

  it("round-trips the nested child's usage through the recursive wire arm (complete TokenUsage restored)", () => {
    const primary: FrameworkError = {
      kind: "transient",
      nodeId: childNode,
      message: "429",
      usage: tokensOnly(5, 5),
    };
    const e = frameworkError.fanChildFailed(mapNode, failed(0, primary), { kind: "refusal", refusal });
    expect(roundTrip(e)).toEqual(e);
    expect(isFrameworkError(e)).toBe(true);
  });

  it("rejects an empty secondaries arm on the wire (one failure, no refusal is unrepresentable)", () => {
    const e = frameworkError.fanChildFailed(mapNode, primary, { kind: "secondaries", secondary });
    const wire = JSON.parse(JSON.stringify(e)) as { causes: { secondary: unknown[] } };
    wire.causes.secondary = [];
    expect(PersistedFrameworkErrorSchema.safeParse(wire).success).toBe(false);
  });

  it("rejects a persisted child index that is not a map index", () => {
    const e = frameworkError.fanChildFailed(mapNode, primary, { kind: "refusal", refusal });
    const wire = JSON.parse(JSON.stringify(e)) as { primary: { index: number } };
    wire.primary.index = -1;
    expect(PersistedFrameworkErrorSchema.safeParse(wire).success).toBe(false);
    wire.primary.index = 1.5;
    expect(PersistedFrameworkErrorSchema.safeParse(wire).success).toBe(false);
  });

  it("rejects a persisted record whose nested child error is not a FrameworkError", () => {
    const e = frameworkError.fanChildFailed(mapNode, primary, { kind: "refusal", refusal });
    const wire = JSON.parse(JSON.stringify(e)) as { primary: { error: unknown } };
    wire.primary.error = { kind: "node-crash" };
    expect(PersistedFrameworkErrorSchema.safeParse(wire).success).toBe(false);
  });

  describe("factory invariant — the primary is the unique lowest failure index (FR-021)", () => {
    it("throws when a secondary has a lower index than the primary", () => {
      expect(() => frameworkError.fanChildFailed(
        mapNode,
        failed(5, crash("p")),
        { kind: "secondaries", secondary: [failed(2, crash("s"))] },
      )).toThrow(/unique lowest failure index/);
    });

    it("throws when an index repeats", () => {
      expect(() => frameworkError.fanChildFailed(
        mapNode,
        failed(1, crash("p")),
        { kind: "secondaries-and-refusal", secondary: [failed(4, crash("a")), failed(4, crash("b"))], refusal },
      )).toThrow(/unique lowest failure index/);
      expect(() => frameworkError.fanChildFailed(
        mapNode,
        failed(1, crash("p")),
        { kind: "secondaries", secondary: [failed(1, crash("s"))] },
      )).toThrow(/unique lowest failure index/);
    });

    it("accepts any set of distinct indices whose minimum is the primary (property)", () => {
      fc.assert(fc.property(
        fc.uniqueArray(fc.nat({ max: 10_000 }), { minLength: 2, maxLength: 12 }),
        (indices) => {
          const [low, ...rest] = [...indices].sort((a, b) => a - b);
          const [first, ...others] = rest.map((i) => failed(i, crash(`c${i}`)));
          if (low === undefined || first === undefined) throw new Error("unreachable");
          const e = frameworkError.fanChildFailed(mapNode, failed(low, crash("p")), {
            kind: "secondaries",
            secondary: [first, ...others],
          });
          expect(roundTrip(e)).toEqual(e);
        },
      ));
    });
  });
});

describe("FanRefusal attachment never drops FR-014 fields", () => {
  it("an attached refusal carries the same record a bare refusal does", () => {
    const attached = frameworkError.fanChildFailed(mapNode, failed(0, crash("p")), { kind: "refusal", refusal });
    const bare = frameworkError.fanBudgetRefused(mapNode, refusal);
    if (attached.kind !== "fan-child-failed" || attached.causes.kind !== "refusal" || bare.kind !== "fan-budget-refused") {
      throw new Error("unreachable");
    }
    const fields: readonly (keyof FanRefusal)[] = [
      "axis", "ceiling", "perChildEstimate", "estimatorApplied", "effectiveConcurrency",
      "completed", "remaining", "lowerBound", "hint", "scopePath",
    ];
    for (const field of fields) {
      expect(attached.causes.refusal[field]).toEqual(bare.refusal[field]);
    }
  });
});

describe("fan kinds at untyped boundaries — normalization never drops refusal data (FR-025)", () => {
  const boundaryPrimary = failed(0, transient("rate limited"));

  it("asNodeFrameworkError passes a typed fan error through UNCHANGED, by identity (both kinds)", () => {
    // The boundary rule that keeps FR-014 data intact when a fan error crosses
    // an untyped catch (`run-node` / `wave-execution`): an already-typed value
    // is returned AS-IS — same reference, refusal record untouched — because
    // re-wrapping it as a node-crash is precisely the drop FR-025 forbids.
    const refused = frameworkError.fanBudgetRefused(mapNode, refusal);
    expect(asNodeFrameworkError(refused, mapNode)).toBe(refused);
    const childFailed = frameworkError.fanChildFailed(mapNode, boundaryPrimary, { kind: "refusal", refusal });
    expect(asNodeFrameworkError(childFailed, mapNode)).toBe(childFailed);
  });

  it("re-tags a malformed object pretending to be a fan error as a generic crash instead of trusting it", () => {
    // The passthrough is gated by `isFrameworkError`'s exactness: an axis that
    // disagrees with its ceiling parses as NEITHER fan kind, so the boundary
    // normalizes the pretender to a node-crash rather than minting typed
    // refusal authority from a hostile value (INV-2: fan kinds exist only
    // through the factory's validated inputs).
    const pretender = { kind: "fan-budget-refused", nodeId: mapNode, refusal: { ...refusal, axis: "tokens" } };
    expect(isFrameworkError(pretender)).toBe(false);
    const normalized = asNodeFrameworkError(pretender, mapNode);
    expect(normalized.kind).toBe("node-crash");
  });
});
