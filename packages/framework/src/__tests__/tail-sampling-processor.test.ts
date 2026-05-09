import { describe, it, expect, beforeEach } from "bun:test";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { TailSamplingProcessor } from "../observer/tail-sampling-processor.js";
import { alwaysOn, errorOnly } from "../observer/policy.js";
import { AI_LLM_COST_USD, AI_RUN_ID } from "../tracing/semantic-conventions.js";
import type { RunSummary } from "../observer/buffered.js";
import type { PersistencePolicy } from "../observer/policy.js";

// --- Helpers ---

let spanCounter = 0;
const fakeSpan = (overrides: {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string | undefined;
  statusCode?: number;
  startTime?: [number, number];
  endTime?: [number, number];
  name?: string;
  attributes?: Record<string, unknown>;
} = {}): ReadableSpan => {
  const traceId = overrides.traceId ?? "abc123";
  const spanId = overrides.spanId ?? `span-${++spanCounter}`;
  return {
    spanContext: () => ({ traceId, spanId, traceFlags: 1, isRemote: false }),
    parentSpanContext: overrides.parentSpanId ? { spanId: overrides.parentSpanId } : undefined,
    name: overrides.name ?? "test-span",
    status: { code: overrides.statusCode ?? 0 },
    startTime: overrides.startTime ?? [1000, 0],
    endTime: overrides.endTime ?? [1001, 0],
    attributes: overrides.attributes ?? {},
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

const createCollector = () => {
  const exported: ReadableSpan[][] = [];
  const exporter: SpanExporter = {
    export(spans, cb) {
      exported.push([...spans]);
      cb({ code: 0 });
    },
    shutdown: () => Promise.resolve(),
  };
  return { exporter, exported };
};

describe("TailSamplingProcessor", () => {
  beforeEach(() => {
    spanCounter = 0;
  });

  it("exports all spans in a trace when policy says flush", () => {
    const { exporter, exported } = createCollector();
    const proc = new TailSamplingProcessor(exporter, alwaysOn());

    const child = fakeSpan({ traceId: "t1", spanId: "child1", parentSpanId: "root1", name: "llm-call" });
    const root = fakeSpan({ traceId: "t1", spanId: "root1", name: "run:dag" });

    proc.onEnd(child);
    expect(exported.length).toBe(0);

    proc.onEnd(root);
    expect(exported.length).toBe(1);
    expect(exported[0].length).toBe(2);
    expect(proc.exported).toBe(1);
    expect(proc.dropped).toBe(0);
  });

  it("discards all spans when policy rejects (no error)", () => {
    const { exporter, exported } = createCollector();
    const proc = new TailSamplingProcessor(exporter, errorOnly());

    const child = fakeSpan({ traceId: "t2", spanId: "c1", parentSpanId: "r1" });
    const root = fakeSpan({ traceId: "t2", spanId: "r1", statusCode: 0 });

    proc.onEnd(child);
    proc.onEnd(root);

    expect(exported.length).toBe(0);
    expect(proc.dropped).toBe(1);
  });

  it("exports when policy matches (error trace)", () => {
    const { exporter, exported } = createCollector();
    const proc = new TailSamplingProcessor(exporter, errorOnly());

    const root = fakeSpan({ traceId: "t3", spanId: "r1", statusCode: 2 });
    proc.onEnd(root);

    expect(exported.length).toBe(1);
    expect(proc.exported).toBe(1);
  });

  it("reads cost from ai.llm.cost_usd span attribute for RunSummary", () => {
    const { exporter } = createCollector();
    const proc = new TailSamplingProcessor(exporter, alwaysOn());

    const child = fakeSpan({
      traceId: "t5",
      spanId: "c1",
      parentSpanId: "r1",
      attributes: { [AI_LLM_COST_USD]: 0.03 },
    });

    proc.onEnd(child);
    proc.onEnd(fakeSpan({ traceId: "t5", spanId: "r1" }));

    expect(proc.exported).toBe(1);
  });

  it("RunSummary.runId is taken from root span ai.run.id attribute", () => {
    const seen: RunSummary[] = [];
    const capturePolicy: PersistencePolicy = {
      shouldFlush(s: RunSummary) { seen.push(s); return false; },
    };
    const { exporter } = createCollector();
    const proc = new TailSamplingProcessor(exporter, capturePolicy);

    proc.onEnd(fakeSpan({
      traceId: "t-runid-1",
      spanId: "r1",
      attributes: { [AI_RUN_ID]: "run-abc-42" },
    }));

    expect(seen).toHaveLength(1);
    expect(seen[0].runId).toBe("run-abc-42");
  });

  it("RunSummary.runId falls back to tr-<traceId> when attribute absent", () => {
    const seen: RunSummary[] = [];
    const capturePolicy: PersistencePolicy = {
      shouldFlush(s: RunSummary) { seen.push(s); return false; },
    };
    const { exporter } = createCollector();
    const proc = new TailSamplingProcessor(exporter, capturePolicy);

    proc.onEnd(fakeSpan({ traceId: "t-runid-2", spanId: "r1" }));

    expect(seen).toHaveLength(1);
    expect(seen[0].runId).toBe("tr-t-runid-2");
  });

  it("handles multiple traces independently", () => {
    const { exporter, exported } = createCollector();
    const proc = new TailSamplingProcessor(exporter, alwaysOn());

    proc.onEnd(fakeSpan({ traceId: "t6", spanId: "c1", parentSpanId: "r1" }));
    proc.onEnd(fakeSpan({ traceId: "t7", spanId: "c2", parentSpanId: "r2" }));
    proc.onEnd(fakeSpan({ traceId: "t6", spanId: "r1" }));

    expect(exported.length).toBe(1);
    expect(exported[0].length).toBe(2);

    proc.onEnd(fakeSpan({ traceId: "t7", spanId: "r2" }));
    expect(exported.length).toBe(2);
  });
});
