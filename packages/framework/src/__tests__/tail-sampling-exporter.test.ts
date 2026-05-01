import { describe, it, expect } from "bun:test";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { TailSamplingExporter, extractRunSummary, type TraceManager } from "../observer/tail-sampling-exporter.js";
import { alwaysOn, errorOnly, anyOf, hadRetry } from "../observer/policy.js";

// --- Helpers to create fake ReadableSpan objects ---

const fakeSpan = (overrides: {
  traceId?: string;
  parentSpanId?: string | undefined;
  statusCode?: number;
  startTime?: [number, number];
  endTime?: [number, number];
  name?: string;
} = {}): ReadableSpan => {
  const traceId = overrides.traceId ?? "abc123";
  return {
    spanContext: () => ({ traceId, spanId: "span1", traceFlags: 1, isRemote: false }),
    parentSpanContext: overrides.parentSpanId ? { spanId: overrides.parentSpanId } : undefined,
    name: overrides.name ?? "run:test",
    status: { code: overrides.statusCode ?? 0 },
    startTime: overrides.startTime ?? [1000, 0],
    endTime: overrides.endTime ?? [1001, 0],
    attributes: {},
    resource: { attributes: {} },
    instrumentationLibrary: { name: "test" },
    kind: 0,
    links: [],
    events: [],
    duration: [1, 0],
    ended: true,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
};

// --- Stub TraceManager (no real MLflow dependency) ---

const createStubTraceManager = (overrides?: {
  spans?: Map<string, { name: string; getAttribute(key: string): unknown }>;
}): TraceManager & { poppedTraceIds: string[] } => {
  const poppedTraceIds: string[] = [];
  return {
    poppedTraceIds,
    getMlflowTraceIdFromOtelId: (otelTraceId: string) => `mlflow-${otelTraceId}`,
    getTrace: () =>
      overrides?.spans ? { spanDict: overrides.spans } : null,
    popTrace: (otelTraceId: string) => {
      poppedTraceIds.push(otelTraceId);
      return null;
    },
  };
};

const createMockExporter = (): SpanExporter & { exportCalls: ReadableSpan[][]; shutdownCalled: boolean } => {
  const exportCalls: ReadableSpan[][] = [];
  return {
    exportCalls,
    shutdownCalled: false,
    export(spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
      exportCalls.push([...spans]);
      cb({ code: 0 });
    },
    async shutdown() {
      (this as any).shutdownCalled = true;
    },
  };
};

describe("TailSamplingExporter", () => {
  describe("policy-driven forwarding", () => {
    it("alwaysOn policy forwards all root spans to inner exporter", () => {
      const inner = createMockExporter();
      const tm = createStubTraceManager();
      const exporter = new TailSamplingExporter(inner, alwaysOn(), tm);
      const span = fakeSpan();

      exporter.export([span], () => {});

      expect(inner.exportCalls.length).toBe(1);
      expect(exporter.exported).toBe(1);
      expect(exporter.dropped).toBe(0);
    });

    it("errorOnly policy drops ok spans and cleans up trace manager", () => {
      const inner = createMockExporter();
      const tm = createStubTraceManager();
      const exporter = new TailSamplingExporter(inner, errorOnly(), tm);
      const span = fakeSpan({ statusCode: 0 });

      exporter.export([span], () => {});

      expect(inner.exportCalls.length).toBe(0);
      expect(exporter.exported).toBe(0);
      expect(exporter.dropped).toBe(1);
      expect(tm.poppedTraceIds).toEqual(["abc123"]);
    });

    it("errorOnly policy forwards error spans", () => {
      const inner = createMockExporter();
      const tm = createStubTraceManager();
      const exporter = new TailSamplingExporter(inner, errorOnly(), tm);
      const span = fakeSpan({ statusCode: 2 }); // 2 = ERROR in OTel

      exporter.export([span], () => {});

      expect(inner.exportCalls.length).toBe(1);
      expect(exporter.exported).toBe(1);
    });

    it("skips child spans (with parentSpanId)", () => {
      const inner = createMockExporter();
      const tm = createStubTraceManager();
      const exporter = new TailSamplingExporter(inner, alwaysOn(), tm);
      const child = fakeSpan({ parentSpanId: "parent1" });

      exporter.export([child], () => {});

      expect(inner.exportCalls.length).toBe(0);
      expect(exporter.exported).toBe(0);
      expect(exporter.dropped).toBe(0);
    });

    it("shutdown delegates to inner exporter", async () => {
      const inner = createMockExporter();
      const tm = createStubTraceManager();
      const exporter = new TailSamplingExporter(inner, alwaysOn(), tm);
      await exporter.shutdown();
      expect(inner.shutdownCalled).toBe(true);
    });

    it("counters start at zero", () => {
      const inner = createMockExporter();
      const tm = createStubTraceManager();
      const exporter = new TailSamplingExporter(inner, alwaysOn(), tm);
      expect(exporter.exported).toBe(0);
      expect(exporter.dropped).toBe(0);
    });

    it("logs error when inner export throws", () => {
      const inner = createMockExporter();
      inner.export = () => { throw new Error("network down"); };
      const tm = createStubTraceManager();
      const exporter = new TailSamplingExporter(inner, alwaysOn(), tm);
      let callbackCode = -1;

      exporter.export([fakeSpan()], (result) => { callbackCode = result.code; });

      expect(callbackCode).toBe(1);
    });
  });

  describe("extractRunSummary", () => {
    it("extracts summary from root span with trace manager data", () => {
      const spans = new Map<string, { name: string; getAttribute(key: string): unknown }>();
      spans.set("s1", { name: "node:fetch", getAttribute: (k) => k === "cost_usd" ? 0.05 : undefined });
      spans.set("s2", { name: "node:llm", getAttribute: (k) => k === "cost_usd" ? 0.10 : undefined });
      spans.set("s3", { name: "node:fetch", getAttribute: () => undefined }); // duplicate name = retry

      const tm = createStubTraceManager({ spans });
      const span = fakeSpan({ statusCode: 2, startTime: [1000, 0], endTime: [1002, 500000000] });

      const summary = extractRunSummary(span, tm);

      expect(summary.status).toBe("error");
      expect(summary.nodeCount).toBe(3);
      expect(summary.retryCount).toBe(1); // "node:fetch" appeared twice
      expect(summary.totalCostUsd).toBeCloseTo(0.15);
      expect(summary.totalDuration).toBeCloseTo(2500);
    });

    it("returns defaults when trace manager has no data", () => {
      const tm = createStubTraceManager();
      const span = fakeSpan({ statusCode: 0, startTime: [1000, 0], endTime: [1001, 0] });

      const summary = extractRunSummary(span, tm);

      expect(summary.status).toBe("ok");
      expect(summary.nodeCount).toBe(1);
      expect(summary.retryCount).toBe(0);
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.totalDuration).toBeCloseTo(1000);
    });
  });

  describe("policy logic (isolated)", () => {
    it("errorOnly policy returns false for ok runs", () => {
      const policy = errorOnly();
      expect(policy.shouldFlush({
        runId: "r1", status: "ok", totalDuration: 100,
        nodeCount: 3, retryCount: 0, cacheHitCount: 0, totalCostUsd: 0.01,
      })).toBe(false);
    });

    it("errorOnly policy returns true for error runs", () => {
      const policy = errorOnly();
      expect(policy.shouldFlush({
        runId: "r1", status: "error", totalDuration: 100,
        nodeCount: 3, retryCount: 0, cacheHitCount: 0, totalCostUsd: 0.01,
      })).toBe(true);
    });

    it("hadRetry policy returns true when retryCount > 0", () => {
      const policy = hadRetry();
      expect(policy.shouldFlush({
        runId: "r1", status: "ok", totalDuration: 100,
        nodeCount: 3, retryCount: 1, cacheHitCount: 0, totalCostUsd: 0.01,
      })).toBe(true);
    });

    it("anyOf combines policies", () => {
      const policy = anyOf(errorOnly(), hadRetry());
      expect(policy.shouldFlush({
        runId: "r1", status: "ok", totalDuration: 100,
        nodeCount: 3, retryCount: 0, cacheHitCount: 0, totalCostUsd: 0.01,
      })).toBe(false);
      expect(policy.shouldFlush({
        runId: "r1", status: "ok", totalDuration: 100,
        nodeCount: 3, retryCount: 1, cacheHitCount: 0, totalCostUsd: 0.01,
      })).toBe(true);
    });
  });
});
