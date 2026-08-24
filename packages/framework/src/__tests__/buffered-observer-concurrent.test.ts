// Wave 6 §6.14: BufferedObserver concurrent flush with shared inner observer.
//
// Two concurrent runs share one BufferedObserver and one inner RecordingObserver.
// Each run emits a distinct event sequence (interleaved at the boundary).
// Property: in the inner observer's event log, each run's events are
// contiguous (no interleaving of within-run events).
//
// This validates the buffer-per-runId invariant: the BufferedObserver is the
// boundary that turns "interleaved per-event" into "atomically replayed
// per-run", which is what downstream sinks (MLflow tracking runs, alerting
// pipelines) depend on.

import { describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { BufferedObserver } from "../observer/buffered.js";
import { alwaysOn } from "../observer/policy.js";
import { RecordingObserver } from "../observer/observer.js";
import type {
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  RunEndEvent,
  ObserverEvent,
} from "../types/events.js";

const mkRunStart = (runId: string): RunStartEvent => ({
  type: "run-start",
  runId: runId as RunId,
  dagId: "d" as DagId,
  timestamp: new Date(),
});

const mkNodeStart = (runId: string, nodeId: string): NodeStartEvent => ({
  type: "node-start",
  runId: runId as RunId,
  dagId: "d" as DagId,
  nodeId: nodeId as NodeId,
  sideEffects: { kind: "none" },
  timestamp: new Date(),
});

const mkNodeEnd = (runId: string, nodeId: string): NodeEndEvent => ({
  type: "node-end",
  runId: runId as RunId,
  dagId: "d" as DagId,
  nodeId: nodeId as NodeId,
  sideEffects: { kind: "none" },
  timestamp: new Date(),
  duration: 1,
  output: null,
});

const mkRunEnd = (runId: string, status: "ok" | "error"): RunEndEvent => ({
  type: "run-end",
  runId: runId as RunId,
  dagId: "d" as DagId,
  timestamp: new Date(),
  duration: 100,
  status,
});

const runIdOf = (e: ObserverEvent): string => e.runId;

describe("§6.14 — BufferedObserver concurrent flush", () => {
  it("per-run events appear contiguously in the inner observer's log", () => {
    const inner = new RecordingObserver();
    const buf = new BufferedObserver(inner, alwaysOn(), { sweepIntervalMs: 0 });

    // Interleave run A and run B emissions.
    buf.observe(mkRunStart("A"));
    buf.observe(mkRunStart("B"));
    buf.observe(mkNodeStart("A", "a1"));
    buf.observe(mkNodeStart("B", "b1"));
    buf.observe(mkNodeEnd("A", "a1"));
    buf.observe(mkNodeEnd("B", "b1"));
    buf.observe(mkNodeStart("A", "a2"));
    buf.observe(mkNodeStart("B", "b2"));
    buf.observe(mkNodeEnd("A", "a2"));
    buf.observe(mkNodeEnd("B", "b2"));

    // Run A ends first, then run B.
    buf.observe(mkRunEnd("A", "ok"));
    buf.observe(mkRunEnd("B", "ok"));

    // Inner sees A's full sequence first, then B's full sequence.
    const log = inner.events;
    // No event for a run other than A appears before run A's run-end.
    const aEndIdx = log.findIndex((e) => e.type === "run-end" && runIdOf(e) === "A");
    expect(aEndIdx).toBeGreaterThan(-1);
    for (let i = 0; i <= aEndIdx; i++) {
      expect(runIdOf(log[i]!)).toBe("A");
    }
    for (let i = aEndIdx + 1; i < log.length; i++) {
      expect(runIdOf(log[i]!)).toBe("B");
    }
  });

  it("reverse end order: B ends before A — B's block appears first in the inner log", () => {
    const inner = new RecordingObserver();
    const buf = new BufferedObserver(inner, alwaysOn(), { sweepIntervalMs: 0 });

    buf.observe(mkRunStart("A"));
    buf.observe(mkRunStart("B"));
    buf.observe(mkNodeStart("A", "a1"));
    buf.observe(mkNodeStart("B", "b1"));
    buf.observe(mkNodeEnd("A", "a1"));
    buf.observe(mkNodeEnd("B", "b1"));
    buf.observe(mkRunEnd("B", "ok"));
    buf.observe(mkRunEnd("A", "ok"));

    const log = inner.events;
    const bEndIdx = log.findIndex((e) => e.type === "run-end" && runIdOf(e) === "B");
    expect(bEndIdx).toBeGreaterThan(-1);
    for (let i = 0; i <= bEndIdx; i++) {
      expect(runIdOf(log[i]!)).toBe("B");
    }
    for (let i = bEndIdx + 1; i < log.length; i++) {
      expect(runIdOf(log[i]!)).toBe("A");
    }
  });

  it("within-run ordering is preserved by the BufferedObserver", () => {
    const inner = new RecordingObserver();
    const buf = new BufferedObserver(inner, alwaysOn(), { sweepIntervalMs: 0 });

    // Emit run A in interleaved order with run B's events between them.
    buf.observe(mkRunStart("A"));
    buf.observe(mkNodeStart("B", "b1")); // B injection
    buf.observe(mkNodeStart("A", "a1"));
    buf.observe(mkRunStart("B"));         // out-of-order B start (still consistent)
    buf.observe(mkNodeEnd("A", "a1"));
    buf.observe(mkRunEnd("A", "ok"));
    buf.observe(mkNodeEnd("B", "b1"));
    buf.observe(mkRunEnd("B", "ok"));

    const aSlice = inner.events.filter((e) => runIdOf(e) === "A").map((e) => e.type);
    expect(aSlice).toEqual(["run-start", "node-start", "node-end", "run-end"]);

    const bSlice = inner.events.filter((e) => runIdOf(e) === "B").map((e) => e.type);
    // B injected `node-start` before its own `run-start` — the buffer flushes
    // them in submission order, so the inner observer sees node-start before
    // run-start for B. That's not the framework's normal ordering (real runs
    // always start with run-start), but the buffer doesn't reorder — it just
    // preserves submission order within a runId.
    expect(bSlice).toEqual(["node-start", "run-start", "node-end", "run-end"]);
  });

  it("inner observer that throws on one run doesn't block the other run's flush", () => {
    let throwOnNodeEndForRun = "A";
    const inner = new RecordingObserver();
    // Wrap the inner to throw on node-end for run A only.
    const throwingInner = {
      observe(event: ObserverEvent): void {
        if (event.type === "node-end" && event.runId === throwOnNodeEndForRun) {
          throw new Error("inner-failed-for-A");
        }
        inner.observe(event);
      },
    };

    const buf = new BufferedObserver(throwingInner, alwaysOn(), { sweepIntervalMs: 0 });

    buf.observe(mkRunStart("A"));
    buf.observe(mkRunStart("B"));
    buf.observe(mkNodeStart("A", "a1"));
    buf.observe(mkNodeStart("B", "b1"));
    buf.observe(mkNodeEnd("A", "a1"));
    buf.observe(mkNodeEnd("B", "b1"));
    buf.observe(mkRunEnd("A", "ok"));
    buf.observe(mkRunEnd("B", "ok"));

    // Run B's node-end made it through despite A's throw.
    const bEnds = inner.events.filter((e) => e.type === "node-end" && runIdOf(e) === "B");
    expect(bEnds.length).toBe(1);
    // Both run-ends made it through too.
    const ends = inner.events.filter((e) => e.type === "run-end");
    expect(ends.length).toBe(2);
  });
});
