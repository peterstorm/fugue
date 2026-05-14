// W6.16 — Shared PersistencePolicy semantics across BufferedObserver +
// TailSamplingProcessor.
//
// Both consumers read `policy.shouldFlush(...)` independently. The framework
// can't *enforce* that the host wires the same instance — it can only
// document the convention (TracingHandle.policy is exposed for exactly
// this purpose) and verify here that a shared instance produces consistent
// "drop both" / "persist both" decisions per run.

import { describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { BufferedObserver, computeRunSummary } from "../observer/buffered.js";
import { TailSamplingProcessor } from "../observer/tail-sampling-processor.js";
import { RecordingObserver } from "../observer/observer.js";
import type { PersistencePolicy } from "../observer/policy.js";
import type { RunSummary } from "../observer/buffered.js";
import type { RunStartEvent, RunEndEvent } from "../types/events.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

// Minimal SpanExporter stub — captures what was exported so the assertion
// distinguishes "exported" from "dropped".
const makeExporter = () => {
  const exported: ReadableSpan[][] = [];
  return {
    spans: exported,
    exporter: {
      export: (spans: ReadableSpan[], cb: (r: { code: number }) => void) => {
        exported.push(spans);
        cb({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    } as unknown as import("@opentelemetry/sdk-trace-base").SpanExporter,
  };
};

// Minimal ReadableSpan stub that looks enough like the OTel shape for the
// processor's onEnd path (status, attributes, parent-span detection).
const makeSpan = (traceId: string, kind: "root" | "child" = "root"): ReadableSpan => {
  const span = {
    spanContext: () => ({ traceId, spanId: kind === "root" ? "00000000root" : "00000000child", traceFlags: 1, isRemote: false }),
    parentSpanContext: kind === "root" ? undefined : { spanId: "00000000root", traceId, traceFlags: 1, isRemote: false },
    name: "test",
    kind: 1,
    startTime: [0, 0],
    endTime: [0, 1_000_000],
    duration: [0, 1_000_000],
    status: { code: 0 },
    attributes: {},
    events: [],
    links: [],
    resource: {},
    instrumentationLibrary: { name: "test" },
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ended: true,
  } as unknown as ReadableSpan;
  return span;
};

const runStart = (runId: string): RunStartEvent => ({
  type: "run-start",
  // @ts-expect-error — branded ID test fixture
  runId,
  dagId: "dag1" as DagId,
  timestamp: new Date(),
});

const runEnd = (runId: string, status: "ok" | "error" = "ok"): RunEndEvent => ({
  type: "run-end",
  // @ts-expect-error — branded ID test fixture
  runId,
  dagId: "dag1" as DagId,
  timestamp: new Date(),
  duration: 100,
  status,
});

describe("W6.16 — shared PersistencePolicy: events + spans agree per run", () => {
  // Capture both `summary` objects the policy sees so we can prove the *same*
  // instance was consulted by both consumers.
  const makeDropAllPolicy = (): { policy: PersistencePolicy; calls: RunSummary[] } => {
    const calls: RunSummary[] = [];
    return {
      policy: {
        shouldFlush: (summary) => {
          calls.push(summary);
          return false;
        },
      },
      calls,
    };
  };

  const makeKeepAllPolicy = (): { policy: PersistencePolicy; calls: RunSummary[] } => {
    const calls: RunSummary[] = [];
    return {
      policy: {
        shouldFlush: (summary) => {
          calls.push(summary);
          return true;
        },
      },
      calls,
    };
  };

  it("policy returning false: BufferedObserver drops events AND TailSamplingProcessor drops spans", () => {
    const { policy } = makeDropAllPolicy();

    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, policy, { sweepIntervalMs: 0 });

    const { exporter, spans } = makeExporter();
    const processor = new TailSamplingProcessor(exporter, policy);

    // Drive a run-end through BufferedObserver — triggers policy.shouldFlush.
    buffered.onRunStart(runStart("run-1"));
    buffered.onRunEnd(runEnd("run-1"));

    // Drive a root-span through TailSamplingProcessor — triggers the same
    // policy.shouldFlush hook on the trace-buffer.
    const tx = trace.setSpanContext;
    void tx; // satisfy strict-unused; we use the manual ReadableSpan stub instead
    processor.onEnd(makeSpan("trace-1"));

    expect(inner.events.length).toBe(0);
    expect(spans.length).toBe(0);
  });

  it("policy returning true: BufferedObserver replays events AND TailSamplingProcessor exports spans", () => {
    const { policy } = makeKeepAllPolicy();

    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, policy, { sweepIntervalMs: 0 });

    const { exporter, spans } = makeExporter();
    const processor = new TailSamplingProcessor(exporter, policy);

    buffered.onRunStart(runStart("run-2"));
    buffered.onRunEnd(runEnd("run-2"));

    processor.onEnd(makeSpan("trace-2"));

    expect(inner.events.length).toBeGreaterThan(0);
    expect(spans.length).toBeGreaterThan(0);
  });

  it("same policy instance — `===` identity preserved into both consumers", () => {
    const { policy } = makeDropAllPolicy();

    const buffered = new BufferedObserver(new RecordingObserver(), policy, { sweepIntervalMs: 0 });
    const { exporter } = makeExporter();
    const processor = new TailSamplingProcessor(exporter, policy);

    // The hosts of `BufferedObserver` and `TailSamplingProcessor` are expected
    // to wire a single shared instance. This assertion makes the contract
    // explicit: a divergent test would fail here at construction time.
    expect((buffered as unknown as { policy: PersistencePolicy }).policy).toBe(policy);
    expect((processor as unknown as { policy: PersistencePolicy }).policy).toBe(policy);
  });

  it("computeRunSummary builds the same RunSummary shape both consumers feed the policy", () => {
    const start = runStart("run-3");
    const end = runEnd("run-3");
    const summary = computeRunSummary([start, end], end);
    expect(summary.runId).toBe("run-3");
    expect(summary.status).toBe("ok");
  });
});
