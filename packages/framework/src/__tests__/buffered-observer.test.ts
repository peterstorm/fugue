import { describe, it, expect } from "bun:test";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { BufferedObserver, computeRunSummary } from "../observer/buffered.js";
import { RecordingObserver } from "../observer/observer.js";
import { alwaysOn } from "../observer/policy.js";
import type {
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  RunEndEvent,
  ObserverEvent,
} from "../types/events.js";

function runStart(runId = "r1"): RunStartEvent {
  // @ts-expect-error — branded ID test fixture
  return { type: "run-start", runId, dagId: "dag1" as DagId, timestamp: new Date() };
}

function nodeStart(nodeId: string, runId = "r1"): NodeStartEvent {
  // @ts-expect-error — branded ID test fixture
  return { type: N("node-start"), runId, dagId: N("dag1") as unknown as any, nodeId, timestamp: new Date() };
}

function nodeEnd(nodeId: string, attrs: Record<string, unknown> = {}, runId = "r1"): NodeEndEvent {
  return {
    type: "node-end",
    runId,
    dagId: "dag1" as DagId,
    nodeId,
    timestamp: new Date(),
    duration: 50,
    output: null,
    ...( Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
  } as NodeEndEvent;
}

function runEnd(status: "ok" | "error" = "ok", runId = "r1"): RunEndEvent {
  // @ts-expect-error — branded ID test fixture
  return { type: "run-end", runId, dagId: "dag1" as DagId, timestamp: new Date(), duration: 200, status };
}

describe("BufferedObserver", () => {
  it("events are buffered until onRunEnd", () => {
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn());

    buffered.onRunStart(runStart());
    buffered.onNodeStart(nodeStart("n1"));
    buffered.onNodeEnd(nodeEnd("n1"));

    expect(inner.events).toHaveLength(0);

    buffered.onRunEnd(runEnd());
    expect(inner.events.length).toBeGreaterThan(0);
  });

  it("shouldFlush=true replays all events to inner observer", () => {
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn());

    buffered.onRunStart(runStart());
    buffered.onNodeStart(nodeStart("n1"));
    buffered.onNodeEnd(nodeEnd("n1"));
    buffered.onRunEnd(runEnd());

    // 3 buffered + 1 run-end = 4
    expect(inner.events).toHaveLength(4);
    expect(inner.events[0].type).toBe("run-start");
    expect(inner.events[3].type).toBe("run-end");
  });

  it("shouldFlush=false drops events but updates aggregates", () => {
    const inner = new RecordingObserver();
    const neverFlush = { shouldFlush: () => false };
    const buffered = new BufferedObserver(inner, neverFlush);

    buffered.onRunStart(runStart());
    buffered.onNodeStart(nodeStart("n1"));
    buffered.onNodeEnd(nodeEnd("n1"));
    buffered.onRunEnd(runEnd());

    expect(inner.events).toHaveLength(0);
    expect(buffered.aggregates.runCount).toBe(1);
  });

  it("aggregate counters update regardless of flush decision", () => {
    const inner = new RecordingObserver();
    const neverFlush = { shouldFlush: () => false };
    const buffered = new BufferedObserver(inner, neverFlush);

    buffered.onRunStart(runStart("r1"));
    buffered.onNodeEnd(nodeEnd("n1", {}, "r1"));
    buffered.onRunEnd(runEnd("ok", "r1"));

    buffered.onRunStart(runStart("r2"));
    buffered.onNodeEnd(nodeEnd("n1", {}, "r2"));
    buffered.onRunEnd(runEnd("ok", "r2"));

    expect(buffered.aggregates.runCount).toBe(2);
  });
});

describe("computeRunSummary", () => {
  it("computes correct summary from events", () => {
    const events: ObserverEvent[] = [
      runStart(),
      nodeStart("n1"),
      nodeEnd("n1"),
      nodeStart("n2"),
      nodeEnd("n2"),
      // n1 retried
      nodeStart("n1"),
      nodeEnd("n1"),
    ];

    const summary = computeRunSummary(events, runEnd("ok"));

    expect(summary.status).toBe("ok");
    expect(summary.totalDuration).toBe(200);
    expect(summary.nodeCount).toBe(2); // n1 and n2
    expect(summary.retryCount).toBe(1); // n1 started twice
  });
});
