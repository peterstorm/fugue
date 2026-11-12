/**
 * Fan error assembly (AD-6, FR-021, FR-025, SC-006 at helper level).
 *
 * Pins the precedence child failure > refusal > abort, the lowest-index
 * primary with every other failure kept as an ascending secondary, the
 * refusal attached (never dropped) in a mixed drain, and the bare primary
 * error returned UNCHANGED for one failure with no refusal — the C=1 error
 * identity (FR-004).
 */

import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { finishError, orderFailures } from "../error-order.js";
import type { FrameworkError } from "../../../types/errors.js";
import { fanRefusal, type FanRefusal, type IndexedError } from "../../../types/fan-scheduling.js";
import { nodeId } from "../../../types/ids.js";
import { mapIndex } from "../../../types/map-index.js";
import { microUsd } from "../../../types/spend.js";

const RUNS = { numRuns: 1_000 } as const;
const fan = nodeId("fan-map");
const child = nodeId("fan-child");

const crash = (message: string): FrameworkError =>
  ({ kind: "node-crash", nodeId: child, message, retriability: "non-retriable" });
const failed = (index: number): IndexedError<FrameworkError> =>
  ({ index: mapIndex(index), error: crash(`child ${index} failed`) });
const refusal: FanRefusal = fanRefusal({
  ceiling: { kind: "usd", limit: microUsd(1_000_000) },
  perChildEstimate: 200_000,
  estimatorApplied: "largest-seen",
  effectiveConcurrency: 3,
  completed: 4,
  remaining: 6,
  lowerBound: false,
});

describe("orderFailures (FR-021)", () => {
  it("picks the lowest index as primary and keeps the rest ascending", () => {
    expect(orderFailures([failed(7), failed(2), failed(5)])).toEqual({
      primary: failed(2),
      secondary: [failed(5), failed(7)],
    });
  });

  it("drops nothing and orders deterministically over any arrival order", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.nat(500), { minLength: 1, maxLength: 30 }), (indices) => {
      const [head, ...tail] = indices.map(failed);
      const { primary, secondary } = orderFailures([head!, ...tail]);
      const sorted = [...indices].sort((a, b) => a - b);
      expect([primary, ...secondary].map((f) => f.index)).toEqual(sorted.map(mapIndex));
    }), RUNS);
  });
});

describe("finishError — AD-6 precedence table", () => {
  it("returns the bare primary error, unchanged, for one failure and no refusal", () => {
    const only = failed(3);
    expect(finishError(fan, [only], null, false)).toBe(only.error);
    expect(finishError(fan, [only], null, true)).toBe(only.error);
  });

  it("attaches the refusal to a single child failure", () => {
    expect(finishError(fan, [failed(3)], refusal, true)).toEqual({
      kind: "fan-child-failed", nodeId: fan, primary: failed(3), causes: { kind: "refusal", refusal },
    });
  });

  it("carries every other failure as secondaries", () => {
    expect(finishError(fan, [failed(9), failed(1), failed(4)], null, false)).toEqual({
      kind: "fan-child-failed", nodeId: fan, primary: failed(1),
      causes: { kind: "secondaries", secondary: [failed(4), failed(9)] },
    });
  });

  it("carries secondaries and the refusal in a mixed drain (FR-025)", () => {
    expect(finishError(fan, [failed(2), failed(0)], refusal, false)).toEqual({
      kind: "fan-child-failed", nodeId: fan, primary: failed(0),
      causes: { kind: "secondaries-and-refusal", secondary: [failed(2)], refusal },
    });
  });

  it("returns fan-budget-refused for a refusal with no child failure, abort or not", () => {
    const expected: FrameworkError = { kind: "fan-budget-refused", nodeId: fan, refusal };
    expect(finishError(fan, [], refusal, false)).toEqual(expected);
    expect(finishError(fan, [], refusal, true)).toEqual(expected);
  });

  it("returns today's aborted error when abort is the only cause", () => {
    expect(finishError(fan, [], null, true)).toEqual({ kind: "aborted", reason: "signal" });
  });

  it("returns no error for a drain with no cause, so the fan reduces", () => {
    expect(finishError(fan, [], null, false)).toBeNull();
  });
});

describe("finishError — precedence and no-drop laws (FR-021, FR-025, SC-006)", () => {
  const failuresArb = fc.uniqueArray(fc.nat(500), { maxLength: 20 }).map((ix) => ix.map(failed));
  const refusalArb = fc.option(fc.constant(refusal), { nil: null });

  it("keeps every failure exactly once, the lowest as primary, and never drops the refusal", () => {
    fc.assert(fc.property(failuresArb, refusalArb, fc.boolean(), (failures, r, aborted) => {
      const error = finishError(fan, failures, r, aborted);
      const sorted = failures.map((f) => f.index).sort((a, b) => a - b);
      if (failures.length === 0) {
        if (r !== null) expect(error).toEqual({ kind: "fan-budget-refused", nodeId: fan, refusal: r });
        else expect(error).toEqual(aborted ? { kind: "aborted", reason: "signal" } : null);
        return;
      }
      if (failures.length === 1 && r === null) {
        expect(error).toBe(failures[0]!.error);
        return;
      }
      if (error === null || error.kind !== "fan-child-failed") throw new Error(`expected fan-child-failed, got ${JSON.stringify(error)}`);
      const secondary = error.causes.kind === "refusal" ? [] : error.causes.secondary;
      expect([error.primary, ...secondary].map((f) => f.index)).toEqual(sorted);
      expect(error.causes.kind === "secondaries" ? null : error.causes.refusal).toBe(r);
    }), RUNS);
  });
});
