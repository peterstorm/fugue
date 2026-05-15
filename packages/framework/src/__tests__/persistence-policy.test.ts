import { describe, it, expect } from "bun:test";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import {
  alwaysOn,
  errorOnly,
  ratio,
  hadRetry,
  coldCache,
  anyOf,
  allOf,
  custom,
} from "../observer/policy.js";
import type { RunSummary } from "../observer/buffered.js";

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r1" as RunId,
    status: "ok",
    totalDuration: 100,
    nodeCount: 3,
    retryCount: 0,
    cacheHitCount: 3,
    totalCostUsd: 0.5,
    freshnessViolationCount: 0,
    humanInterventionCount: 0,
    routeDecisionCount: 0,
    ...overrides,
  };
}

describe("PersistencePolicy", () => {
  it("alwaysOn always returns true", () => {
    expect(alwaysOn().shouldFlush(makeSummary())).toBe(true);
    expect(alwaysOn().shouldFlush(makeSummary({ status: "error" }))).toBe(true);
  });

  it("errorOnly returns true only for error runs", () => {
    expect(errorOnly().shouldFlush(makeSummary({ status: "ok" }))).toBe(false);
    expect(errorOnly().shouldFlush(makeSummary({ status: "error" }))).toBe(true);
  });

  it("ratio(1) always true, ratio(0) always false", () => {
    const always = ratio(1);
    const never = ratio(0);
    for (let i = 0; i < 20; i++) {
      expect(always.shouldFlush(makeSummary())).toBe(true);
      expect(never.shouldFlush(makeSummary())).toBe(false);
    }
  });

  it("hadRetry returns true when retryCount > 0", () => {
    expect(hadRetry().shouldFlush(makeSummary({ retryCount: 0 }))).toBe(false);
    expect(hadRetry().shouldFlush(makeSummary({ retryCount: 2 }))).toBe(true);
  });

  it("coldCache returns true when cacheHitCount < nodeCount", () => {
    expect(coldCache().shouldFlush(makeSummary({ nodeCount: 3, cacheHitCount: 3 }))).toBe(false);
    expect(coldCache().shouldFlush(makeSummary({ nodeCount: 3, cacheHitCount: 1 }))).toBe(true);
  });

  it("anyOf returns true if any sub-policy true", () => {
    const policy = anyOf(errorOnly(), hadRetry());
    expect(policy.shouldFlush(makeSummary({ status: "ok", retryCount: 0 }))).toBe(false);
    expect(policy.shouldFlush(makeSummary({ status: "error", retryCount: 0 }))).toBe(true);
    expect(policy.shouldFlush(makeSummary({ status: "ok", retryCount: 1 }))).toBe(true);
  });

  it("allOf returns true only if all sub-policies true", () => {
    const policy = allOf(errorOnly(), hadRetry());
    expect(policy.shouldFlush(makeSummary({ status: "error", retryCount: 0 }))).toBe(false);
    expect(policy.shouldFlush(makeSummary({ status: "ok", retryCount: 1 }))).toBe(false);
    expect(policy.shouldFlush(makeSummary({ status: "error", retryCount: 1 }))).toBe(true);
  });

  it("custom works with arbitrary function", () => {
    const policy = custom((s) => s.totalCostUsd > 1.0);
    expect(policy.shouldFlush(makeSummary({ totalCostUsd: 0.5 }))).toBe(false);
    expect(policy.shouldFlush(makeSummary({ totalCostUsd: 2.0 }))).toBe(true);
  });
});
