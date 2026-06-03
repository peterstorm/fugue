import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import {
  mapEventToFoundry,
  mapRunSummaryToFoundry,
  FOUNDRY_EVENT_RUN_SUMMARY,
  FOUNDRY_EVENT_ROUTE_DECISION,
  FOUNDRY_EVENT_NODE_PRUNED,
  FOUNDRY_METRIC_RUN_LATENCY,
  FOUNDRY_METRIC_RUN_COST,
  FOUNDRY_METRIC_RUN_TOKENS,
  FOUNDRY_METRIC_NODE_LATENCY,
  FOUNDRY_METRIC_NODE_CACHE_HIT,
  isCacheHit,
  type FoundryEmission,
} from "./foundry-event-mapping.js";
import type { NodeSkippedEvent, ObserverEvent, RunEndEvent } from "../types/events.js";
import type { RunSummary } from "./buffered.js";
import { runId, nodeId, dagId } from "../types/ids.js";
import { confidence } from "../types/confidence.js";
import { witness } from "../types/freshness.js";

const RID = runId("run-1");
const DID = dagId("dag-1");
const NID = nodeId("node-1");
const T = new Date("2026-01-01T00:00:00Z");

const findEvent = (es: readonly FoundryEmission[], name: string) =>
  es.find((e): e is Extract<FoundryEmission, { kind: "event" }> => e.kind === "event" && e.name === name);
const findMetric = (es: readonly FoundryEmission[], name: string) =>
  es.find((e): e is Extract<FoundryEmission, { kind: "metric" }> => e.kind === "metric" && e.name === name);

describe("mapEventToFoundry", () => {
  it("run-end → summary event (status+duration) + run-latency metric by dagId", () => {
    const ev: RunEndEvent = {
      type: "run-end",
      runId: RID,
      dagId: DID,
      timestamp: T,
      duration: 1234,
      status: "ok",
    };
    const out = mapEventToFoundry(ev);

    const summary = findEvent(out, FOUNDRY_EVENT_RUN_SUMMARY);
    expect(summary).toBeDefined();
    expect(summary!.properties).toEqual({ dagId: "dag-1", runId: "run-1", status: "ok" });
    expect(summary!.measurements as Record<string, number>).toEqual({ durationMs: 1234 });

    const latency = findMetric(out, FOUNDRY_METRIC_RUN_LATENCY);
    expect(latency).toBeDefined();
    expect(latency!.value as number).toBe(1234);
    expect(latency!.properties).toEqual({ dagId: "dag-1" });
  });

  it("route-decided → route-decision event with chosen + pruned targets", () => {
    const ev: ObserverEvent = {
      type: "route-decided",
      runId: RID,
      dagId: DID,
      fromNodeId: NID,
      chosenTargets: [nodeId("a"), nodeId("b")],
      prunedTargets: [nodeId("c")],
      defaultTaken: false,
      evidence: {
        upstreamOutput: null,
        upstreamConfidence: null,
        predicateResults: [],
        decidedAtMs: 0,
      },
      timestamp: T,
    };
    const out = mapEventToFoundry(ev);
    const event = findEvent(out, FOUNDRY_EVENT_ROUTE_DECISION);
    expect(event).toBeDefined();
    expect(event!.properties.chosenTargets).toBe("a,b");
    expect(event!.properties.prunedTargets).toBe("c");
    expect(event!.properties.defaultTaken).toBe("false");
    expect(event!.measurements as Record<string, number>).toEqual({ chosenCount: 2, prunedCount: 1 });
  });

  it("node-pruned → node-pruned event with reason", () => {
    const ev: ObserverEvent = {
      type: "node-pruned",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      reason: "branch-not-taken",
      timestamp: T,
    };
    const out = mapEventToFoundry(ev);
    const event = findEvent(out, FOUNDRY_EVENT_NODE_PRUNED);
    expect(event).toBeDefined();
    expect(event!.properties).toEqual({
      dagId: "dag-1",
      runId: "run-1",
      nodeId: "node-1",
      reason: "branch-not-taken",
    });
    expect(out.length).toBe(1);
  });

  it("node-end → node-latency metric dimensioned by nodeId", () => {
    const ev: ObserverEvent = {
      type: "node-end",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      sideEffects: { kind: "none" },
      timestamp: T,
      duration: 42,
      output: {},
    };
    const out = mapEventToFoundry(ev);
    const m = findMetric(out, FOUNDRY_METRIC_NODE_LATENCY);
    expect(m).toBeDefined();
    expect(m!.value as number).toBe(42);
    expect(m!.properties).toEqual({ dagId: "dag-1", nodeId: "node-1" });
  });

  it("node-end with non-finite duration → no metric", () => {
    const ev: ObserverEvent = {
      type: "node-end",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      sideEffects: { kind: "none" },
      timestamp: T,
      duration: Number.NaN,
      output: {},
    };
    expect(mapEventToFoundry(ev)).toEqual([]);
  });

  it("node-skipped checkpoint → cache-hit metric (value 1) by nodeId", () => {
    const ev: ObserverEvent = {
      type: "node-skipped",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      timestamp: T,
      reason: "checkpoint",
    };
    const out = mapEventToFoundry(ev);
    const m = findMetric(out, FOUNDRY_METRIC_NODE_CACHE_HIT);
    expect(m).toBeDefined();
    expect(m!.value as number).toBe(1);
    expect(m!.properties).toEqual({ dagId: "dag-1", nodeId: "node-1" });
  });

  it("node-skipped already-completed → no emission (not a cache hit)", () => {
    const ev: ObserverEvent = {
      type: "node-skipped",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      timestamp: T,
      reason: "already-completed",
    };
    expect(mapEventToFoundry(ev)).toEqual([]);
  });

  it("run-end with non-finite duration → summary event WITHOUT measurements bag, no latency metric", () => {
    // All-non-finite measurements path on the EVENT channel: the run-summary
    // event is still emitted (status/dagId are always present) but carries no
    // `measurements` bag, and the latency metric is dropped.
    const ev: RunEndEvent = {
      type: "run-end",
      runId: RID,
      dagId: DID,
      timestamp: T,
      duration: Number.POSITIVE_INFINITY,
      status: "error",
    };
    const out = mapEventToFoundry(ev);
    const summary = findEvent(out, FOUNDRY_EVENT_RUN_SUMMARY);
    expect(summary).toBeDefined();
    expect(summary!.properties).toEqual({ dagId: "dag-1", runId: "run-1", status: "error" });
    expect(summary!.measurements).toBeUndefined();
    expect(findMetric(out, FOUNDRY_METRIC_RUN_LATENCY)).toBeUndefined();
    expect(out).toHaveLength(1);
  });

  it.each([
    "run-start",
    "node-start",
    "node-error",
    "sub-span",
    "witness-captured",
    "write-attempted",
    "freshness-violation",
    "human-intervention",
  ] as const)("ignored event type %s → []", (type) => {
    const base = { runId: RID, dagId: DID, nodeId: NID, timestamp: T };
    const w = witness("version", "res", "v1");
    const c = confidence("high", "heuristic", "x");
    const events: Record<string, ObserverEvent> = {
      "run-start": { type: "run-start", runId: RID, dagId: DID, timestamp: T },
      "node-start": { type: "node-start", ...base, sideEffects: { kind: "none" } },
      "node-error": {
        type: "node-error",
        ...base,
        error: "boom",
        frameworkError: {
          kind: "node-execution-failed",
          nodeId: NID,
          retriability: "retriable",
          message: "boom",
        } as never,
      },
      "sub-span": { type: "sub-span", ...base, parentSpanId: "p", kind: "llm" as never, duration: 1, attributes: {} },
      "witness-captured": { type: "witness-captured", ...base, witness: w, capturedAtMs: 0 },
      "write-attempted": { type: "write-attempted", ...base, conditionedOn: w, newWitness: w, succeededAtMs: 0 },
      "freshness-violation": {
        type: "freshness-violation",
        ...base,
        resource: "res",
        conditionedOnWitness: w,
        conflictingWrite: { runId: RID, nodeId: NID, newWitness: w, succeededAtMs: 0 },
        detectedAtMs: 0,
      },
      "human-intervention": {
        type: "human-intervention",
        ...base,
        action: { kind: "approve" },
        actor: "alice",
        elapsedMsSinceAwait: 0,
        context: { nodeConfidence: c, nodeSideEffects: "none", priorWitnesses: [] },
      },
    };
    expect(mapEventToFoundry(events[type]!)).toEqual([]);
  });
});

describe("mapRunSummaryToFoundry (FR-019 full summary)", () => {
  const runEnd: RunEndEvent = {
    type: "run-end",
    runId: RID,
    dagId: DID,
    timestamp: T,
    duration: 5000,
    status: "ok",
  };

  it("emits all FR-019 fields when cost + extras are present", () => {
    const summary: RunSummary = {
      runId: "run-1",
      status: "ok",
      totalDuration: 5000,
      nodeCount: 7,
      retryCount: 2,
      totalCostUsd: 0.42,
      freshnessViolationCount: 0,
      humanInterventionCount: 0,
      routeDecisionCount: 3,
    };
    const out = mapRunSummaryToFoundry(summary, runEnd, { cacheHitCount: 4, totalTokens: 9000 });

    const event = findEvent(out, FOUNDRY_EVENT_RUN_SUMMARY)!;
    expect(event.properties).toEqual({ dagId: "dag-1", runId: "run-1", status: "ok" });
    // FR-019: duration, status, nodeCount, retryCount, cacheHitCount, total cost.
    expect(event.measurements as Record<string, number>).toEqual({
      durationMs: 5000,
      nodeCount: 7,
      retryCount: 2,
      cacheHitCount: 4,
      totalCost: 0.42,
    });

    expect(findMetric(out, FOUNDRY_METRIC_RUN_LATENCY)!.value as number).toBe(5000);
    expect(findMetric(out, FOUNDRY_METRIC_RUN_COST)!.value as number).toBe(0.42);
    expect(findMetric(out, FOUNDRY_METRIC_RUN_TOKENS)!.value as number).toBe(9000);
    expect(findMetric(out, FOUNDRY_METRIC_RUN_LATENCY)!.properties).toEqual({ dagId: "dag-1" });
  });

  it("omits cost/token metrics when not supplied", () => {
    const summary: RunSummary = {
      runId: "run-1",
      status: "error",
      totalDuration: 100,
      nodeCount: 1,
      retryCount: 0,
      freshnessViolationCount: 0,
      humanInterventionCount: 0,
      routeDecisionCount: 0,
    };
    const out = mapRunSummaryToFoundry(summary, runEnd);
    expect(findMetric(out, FOUNDRY_METRIC_RUN_COST)).toBeUndefined();
    expect(findMetric(out, FOUNDRY_METRIC_RUN_TOKENS)).toBeUndefined();
    const event = findEvent(out, FOUNDRY_EVENT_RUN_SUMMARY)!;
    expect(event.measurements as Record<string, number>).toEqual({ durationMs: 100, nodeCount: 1, retryCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// Property: mapEventToFoundry never throws for ANY ObserverEvent, and every
// numeric measurement / metric value is finite.
// ---------------------------------------------------------------------------

const arbId = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[A-Za-z0-9_-]{1,128}$/.test(s));
const arbNum = fc.oneof(
  fc.double(),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.integer(),
);

const arbEvent: fc.Arbitrary<ObserverEvent> = fc
  .record({
    rid: arbId,
    did: arbId,
    nid: arbId,
    dur: arbNum,
    status: fc.constantFrom("ok", "error") as fc.Arbitrary<"ok" | "error">,
    chosen: fc.array(arbId),
    pruned: fc.array(arbId),
    defaultTaken: fc.boolean(),
    skipReason: fc.constantFrom("checkpoint", "already-completed") as fc.Arbitrary<"checkpoint" | "already-completed">,
    which: fc.constantFrom(
      "run-start",
      "node-start",
      "node-end",
      "node-skipped",
      "node-error",
      "sub-span",
      "run-end",
      "route-decided",
      "node-pruned",
      "witness-captured",
      "write-attempted",
      "freshness-violation",
      "human-intervention",
    ),
  })
  .map((r): ObserverEvent => {
    const rid = runId(r.rid);
    const did = dagId(r.did);
    const nid = nodeId(r.nid);
    const ts = new Date(0);
    const w = witness("version", "res", "v");
    const c = confidence("high", "heuristic", "x");
    switch (r.which) {
      case "run-start":
        return { type: "run-start", runId: rid, dagId: did, timestamp: ts };
      case "node-start":
        return { type: "node-start", runId: rid, dagId: did, nodeId: nid, sideEffects: { kind: "none" }, timestamp: ts };
      case "node-end":
        return { type: "node-end", runId: rid, dagId: did, nodeId: nid, sideEffects: { kind: "none" }, timestamp: ts, duration: r.dur, output: {} };
      case "node-skipped":
        return { type: "node-skipped", runId: rid, dagId: did, nodeId: nid, timestamp: ts, reason: r.skipReason };
      case "node-error":
        return { type: "node-error", runId: rid, dagId: did, nodeId: nid, timestamp: ts, error: "e", frameworkError: { kind: "node-execution-failed", nodeId: nid, retriability: "retriable", message: "e" } as never };
      case "sub-span":
        return { type: "sub-span", runId: rid, dagId: did, nodeId: nid, parentSpanId: "p", kind: "llm" as never, timestamp: ts, duration: r.dur, attributes: {} };
      case "run-end":
        return { type: "run-end", runId: rid, dagId: did, timestamp: ts, duration: r.dur, status: r.status };
      case "route-decided":
        return { type: "route-decided", runId: rid, dagId: did, fromNodeId: nid, chosenTargets: r.chosen.map(nodeId), prunedTargets: r.pruned.map(nodeId), defaultTaken: r.defaultTaken, evidence: { upstreamOutput: null, upstreamConfidence: null, predicateResults: [], decidedAtMs: 0 }, timestamp: ts };
      case "node-pruned":
        return { type: "node-pruned", runId: rid, dagId: did, nodeId: nid, reason: "branch-not-taken", timestamp: ts };
      case "witness-captured":
        return { type: "witness-captured", runId: rid, dagId: did, nodeId: nid, witness: w, capturedAtMs: 0, timestamp: ts };
      case "write-attempted":
        return { type: "write-attempted", runId: rid, dagId: did, nodeId: nid, conditionedOn: w, newWitness: w, succeededAtMs: 0, timestamp: ts };
      case "freshness-violation":
        return { type: "freshness-violation", runId: rid, dagId: did, nodeId: nid, resource: "res", conditionedOnWitness: w, conflictingWrite: { runId: rid, nodeId: nid, newWitness: w, succeededAtMs: 0 }, detectedAtMs: 0, timestamp: ts };
      case "human-intervention":
        return { type: "human-intervention", runId: rid, dagId: did, nodeId: nid, action: { kind: "approve" }, actor: "a", elapsedMsSinceAwait: 0, context: { nodeConfidence: c, nodeSideEffects: "none", priorWitnesses: [] }, timestamp: ts };
    }
  });

describe("isCacheHit (single source of truth for the cache-hit rule)", () => {
  const skip = (reason: NodeSkippedEvent["reason"]): NodeSkippedEvent => ({
    type: "node-skipped",
    runId: RID,
    dagId: DID,
    nodeId: NID,
    timestamp: T,
    reason,
  });

  it("checkpoint is a cache hit", () => {
    expect(isCacheHit(skip("checkpoint"))).toBe(true);
  });

  it("already-completed is NOT a cache hit", () => {
    expect(isCacheHit(skip("already-completed"))).toBe(false);
  });

  it("agrees with the per-event cache-hit metric mapping", () => {
    // The predicate and mapEventToFoundry must stay coupled: a cache hit emits
    // the metric, a non-cache-hit emits nothing.
    for (const reason of ["checkpoint", "already-completed"] as const) {
      const emitted = mapEventToFoundry(skip(reason)).some(
        (e) => e.kind === "metric" && e.name === FOUNDRY_METRIC_NODE_CACHE_HIT,
      );
      expect(emitted).toBe(isCacheHit(skip(reason)));
    }
  });
});

describe("mapEventToFoundry property", () => {
  it("never throws and all numeric outputs are finite", () => {
    fc.assert(
      fc.property(arbEvent, (event) => {
        const out = mapEventToFoundry(event);
        for (const em of out) {
          if (em.kind === "metric") {
            expect(Number.isFinite(em.value)).toBe(true);
          } else if (em.measurements) {
            for (const v of Object.values(em.measurements)) {
              expect(Number.isFinite(v)).toBe(true);
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
