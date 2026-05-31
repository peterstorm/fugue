import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AiFoundryObserver, type FoundryTelemetrySink } from "./ai-foundry-observer.js";
import {
  FOUNDRY_EVENT_RUN_SUMMARY,
  FOUNDRY_EVENT_NODE_PRUNED,
  FOUNDRY_METRIC_NODE_LATENCY,
} from "./foundry-event-mapping.js";
import type { ObserverEvent, RunEndEvent } from "../types/events.js";
import { runId, nodeId, dagId } from "../types/ids.js";
import { setFrameworkLogger, __resetFrameworkLogger, type FrameworkLogger } from "../logger.js";

const RID = runId("run-1");
const DID = dagId("dag-1");
const NID = nodeId("node-1");
const T = new Date(0);

interface Recorder extends FoundryTelemetrySink {
  events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }>;
  metrics: Array<{ name: string; value: number; properties?: Record<string, string> }>;
}

const recorder = (): Recorder => ({
  events: [],
  metrics: [],
  trackEvent(e) {
    this.events.push(e);
  },
  trackMetric(m) {
    this.metrics.push(m);
  },
  async flush() {},
});

let warnings: string[] = [];
const recordingLogger: FrameworkLogger = {
  debug() {},
  info() {},
  warn(msg) {
    warnings.push(msg);
  },
  error() {},
};

beforeEach(() => {
  warnings = [];
  setFrameworkLogger(recordingLogger);
});
afterEach(() => {
  __resetFrameworkLogger();
});

const runEnd: RunEndEvent = {
  type: "run-end",
  runId: RID,
  dagId: DID,
  timestamp: T,
  duration: 100,
  status: "ok",
};

describe("AiFoundryObserver", () => {
  it("forwards mapped emissions to the sink (event + metric)", () => {
    const sink = recorder();
    new AiFoundryObserver(sink).observe(runEnd);

    expect(sink.events.map((e) => e.name)).toContain(FOUNDRY_EVENT_RUN_SUMMARY);
    expect(sink.metrics.length).toBeGreaterThan(0);
  });

  it("forwards a node-pruned event", () => {
    const sink = recorder();
    const ev: ObserverEvent = {
      type: "node-pruned",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      reason: "branch-not-taken",
      timestamp: T,
    };
    new AiFoundryObserver(sink).observe(ev);
    expect(sink.events.map((e) => e.name)).toEqual([FOUNDRY_EVENT_NODE_PRUNED]);
  });

  it("emits nothing for ignored event types", () => {
    const sink = recorder();
    new AiFoundryObserver(sink).observe({ type: "run-start", runId: RID, dagId: DID, timestamp: T });
    expect(sink.events).toHaveLength(0);
    expect(sink.metrics).toHaveLength(0);
  });

  it("never throws when sink.trackEvent throws, and logs", () => {
    const sink: FoundryTelemetrySink = {
      trackEvent() {
        throw new Error("AI down");
      },
      trackMetric() {},
      async flush() {},
    };
    const obs = new AiFoundryObserver(sink);
    expect(() => obs.observe(runEnd)).not.toThrow();
    expect(warnings.some((w) => w.includes("trackEvent"))).toBe(true);
  });

  it("never throws when sink.trackMetric throws, and logs", () => {
    const sink: FoundryTelemetrySink = {
      trackEvent() {},
      trackMetric() {
        throw new Error("metric pipe broken");
      },
      async flush() {},
    };
    const ev: ObserverEvent = {
      type: "node-end",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      sideEffects: { kind: "none" },
      timestamp: T,
      duration: 5,
      output: {},
    };
    const obs = new AiFoundryObserver(sink);
    expect(() => obs.observe(ev)).not.toThrow();
    expect(warnings.some((w) => w.includes("trackMetric"))).toBe(true);
  });

  it("a throwing event call does not prevent subsequent metric emission", () => {
    // run-end produces a summary event THEN a run-latency metric. If trackEvent
    // throws, trackMetric must still be attempted.
    let metricCalled = false;
    const sink: FoundryTelemetrySink = {
      trackEvent() {
        throw new Error("event broken");
      },
      trackMetric() {
        metricCalled = true;
      },
      async flush() {},
    };
    new AiFoundryObserver(sink).observe(runEnd);
    expect(metricCalled).toBe(true);
  });

  it("forwards node-latency metric with nodeId dimension", () => {
    const sink = recorder();
    const ev: ObserverEvent = {
      type: "node-end",
      runId: RID,
      dagId: DID,
      nodeId: NID,
      sideEffects: { kind: "none" },
      timestamp: T,
      duration: 33,
      output: {},
    };
    new AiFoundryObserver(sink).observe(ev);
    const m = sink.metrics.find((x) => x.name === FOUNDRY_METRIC_NODE_LATENCY);
    expect(m).toBeDefined();
    expect(m!.properties).toEqual({ dagId: "dag-1", nodeId: "node-1" });
  });
});
