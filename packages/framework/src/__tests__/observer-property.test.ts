import { resourceName, witness, mkWitness, RN } from "./_freshness-helpers.js";
import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { RecordingObserver, createObserver } from "../observer/observer.js";
import { dispatchEvent } from "../observer/buffered.js";
import type { ObserverEvent } from "../types/events.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import type { FrameworkError } from "../types/errors.js";

// ---------------------------------------------------------------------------
// Arbitrary ObserverEvent generator — covers all 13 discriminants
// ---------------------------------------------------------------------------

const rid = "r" as RunId;
const did = "d" as DagId;
const nid = "n" as NodeId;
const ts = new Date(0);

const arbEventType: fc.Arbitrary<ObserverEvent> = fc.oneof(
  fc.constant<ObserverEvent>({ type: "run-start", runId: rid, dagId: did, timestamp: ts }),
  fc.constant<ObserverEvent>({ type: "node-start", runId: rid, dagId: did, nodeId: nid, sideEffects: { kind: "none" }, timestamp: ts }),
  fc.constant<ObserverEvent>({ type: "node-end", runId: rid, dagId: did, nodeId: nid, sideEffects: { kind: "none" }, timestamp: ts, duration: 1, output: null }),
  fc.constant<ObserverEvent>({ type: "node-skipped", runId: rid, dagId: did, nodeId: nid, timestamp: ts, reason: "checkpoint" }),
  fc.constant<ObserverEvent>({
    type: "node-error", runId: rid, dagId: did, nodeId: nid, timestamp: ts,
    error: "boom", frameworkError: { kind: "node-crash", nodeId: nid, message: "boom", retriability: "retriable" },
  }),
  fc.constant<ObserverEvent>({ type: "sub-span", runId: rid, dagId: did, nodeId: nid, parentSpanId: "s1", kind: "CHAIN", timestamp: ts, duration: 0, attributes: {} }),
  fc.constant<ObserverEvent>({ type: "run-end", runId: rid, dagId: did, timestamp: ts, duration: 100, status: "ok" }),
  fc.constant<ObserverEvent>({
    type: "route-decided", runId: rid, dagId: did, fromNodeId: nid,
    chosenTargets: [], prunedTargets: [], defaultTaken: true,
    evidence: { upstreamOutput: null, upstreamConfidence: null, predicateResults: [], decidedAtMs: 0 },
    timestamp: ts,
  }),
  fc.constant<ObserverEvent>({ type: "node-pruned", runId: rid, dagId: did, nodeId: nid, reason: "branch-not-taken", timestamp: ts }),
  fc.constant<ObserverEvent>({
    type: "witness-captured", runId: rid, dagId: did, nodeId: nid,
    witness: witness("version", RN("r"), "1"), capturedAtMs: 0, timestamp: ts,
  }),
  fc.constant<ObserverEvent>({
    type: "write-attempted", runId: rid, dagId: did, nodeId: nid,
    conditionedOn: witness("version", RN("r"), "1"),
    newWitness: witness("version", RN("r"), "2"),
    succeededAtMs: 0, timestamp: ts,
  }),
  fc.constant<ObserverEvent>({
    type: "freshness-violation", runId: rid, dagId: did, nodeId: nid,
    resource: RN("r"), conditionedOnWitness: witness("version", RN("r"), "1"),
    conflictingWrite: { runId: rid, nodeId: nid, newWitness: witness("version", RN("r"), "2"), succeededAtMs: 0 },
    detectedAtMs: 0, timestamp: ts,
  }),
  fc.constant<ObserverEvent>({
    type: "human-intervention", runId: rid, dagId: did, nodeId: nid,
    action: { kind: "approve" }, actor: "test", elapsedMsSinceAwait: 0,
    context: { nodeConfidence: null, nodeSideEffects: "none", priorWitnesses: [] },
    timestamp: ts,
  }),
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Observer property tests", () => {
  it("RecordingObserver captures every event without loss", () => {
    fc.assert(
      fc.property(fc.array(arbEventType, { minLength: 0, maxLength: 50 }), (events) => {
        const rec = new RecordingObserver();
        for (const e of events) rec.observe(e);
        return rec.events.length === events.length;
      }),
      { numRuns: 200 },
    );
  });

  it("createObserver routes each event to the correct handler", () => {
    fc.assert(
      fc.property(arbEventType, (event) => {
        const seen: string[] = [];
        const obs = createObserver({
          "run-start": () => seen.push("run-start"),
          "node-start": () => seen.push("node-start"),
          "node-end": () => seen.push("node-end"),
          "node-skipped": () => seen.push("node-skipped"),
          "node-error": () => seen.push("node-error"),
          "sub-span": () => seen.push("sub-span"),
          "run-end": () => seen.push("run-end"),
          "route-decided": () => seen.push("route-decided"),
          "node-pruned": () => seen.push("node-pruned"),
          "witness-captured": () => seen.push("witness-captured"),
          "write-attempted": () => seen.push("write-attempted"),
          "freshness-violation": () => seen.push("freshness-violation"),
          "human-intervention": () => seen.push("human-intervention"),
        });
        obs.observe(event);
        return seen.length === 1 && seen[0] === event.type;
      }),
      { numRuns: 200 },
    );
  });

  it("dispatchEvent with throwing observer does not propagate", () => {
    fc.assert(
      fc.property(arbEventType, (event) => {
        const throwing = {
          observe() { throw new Error("observer-boom"); },
        };
        // Must not throw (error is caught and logged)
        dispatchEvent(throwing, event);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
