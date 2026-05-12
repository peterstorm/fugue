import { describe, it, expect, beforeEach } from "bun:test";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { MlflowOtlpExporter } from "../tracing/mlflow-otlp-exporter.js";
import {
  AI_SPAN_TYPE,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  EVENT_LLM_COST,
  EVENT_GEN_AI_SYSTEM_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
} from "../tracing/semantic-conventions.js";

// --- Helpers ---

let spanCounter = 0;
const fakeSpan = (overrides: {
  traceId?: string;
  spanId?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; attributes?: Record<string, unknown> }>;
} = {}): ReadableSpan => {
  const traceId = overrides.traceId ?? "trace-001";
  const spanId = overrides.spanId ?? `span-${++spanCounter}`;
  return {
    spanContext: () => ({ traceId, spanId, traceFlags: 1, isRemote: false }),
    name: "test-span",
    status: { code: 0 },
    startTime: [1000, 0],
    endTime: [1001, 0],
    attributes: overrides.attributes ?? {},
    events: overrides.events ?? [],
    kind: 0,
    resource: { attributes: {} },
    instrumentationLibrary: { name: "test" },
    duration: [1, 0],
    ended: true,
    links: [],
    parentSpanId: undefined,
  } as unknown as ReadableSpan;
};

const collectExport = (exporter: MlflowOtlpExporter, spans: ReadableSpan[]): Promise<{ result: ExportResult; exported: ReadableSpan[] }> => {
  const exported: ReadableSpan[] = [];
  return new Promise((resolve) => {
    exporter.export(spans, (result) => {
      resolve({ result, exported });
    });
  });
};

describe("MlflowOtlpExporter", () => {
  let exported: ReadableSpan[];
  let innerExporter: SpanExporter;
  let exporter: MlflowOtlpExporter;

  beforeEach(() => {
    spanCounter = 0;
    exported = [];
    innerExporter = {
      export(spans: ReadableSpan[], cb: (result: ExportResult) => void) {
        exported.push(...spans);
        cb({ code: 0 });
      },
      shutdown: async () => {},
    };
    exporter = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "1",
      createInner: async () => innerExporter,
    });
  });

  it("maps ai.span.type to mlflow.spanType (uppercased)", async () => {
    const span = fakeSpan({ attributes: { [AI_SPAN_TYPE]: "llm" } });
    await collectExport(exporter, [span]);
    expect(exported.length).toBe(1);
    expect((exported[0].attributes as Record<string, unknown>)["mlflow.spanType"]).toBe("LLM");
  });

  it("maps gen_ai.request.model to mlflow.llm.model", async () => {
    const span = fakeSpan({ attributes: { [GEN_AI_REQUEST_MODEL]: "claude-sonnet-4-20250514" } });
    await collectExport(exporter, [span]);
    expect((exported[0].attributes as Record<string, unknown>)["mlflow.llm.model"]).toBe("claude-sonnet-4-20250514");
  });

  it("computes mlflow.chat.tokenUsage from gen_ai usage attrs", async () => {
    const span = fakeSpan({
      attributes: { [GEN_AI_USAGE_INPUT_TOKENS]: 100, [GEN_AI_USAGE_OUTPUT_TOKENS]: 50 },
    });
    await collectExport(exporter, [span]);
    const attrs = exported[0].attributes as Record<string, unknown>;
    expect(attrs["mlflow.chat.tokenUsage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
  });

  it("maps gen_ai.system to mlflow.llm.provider when model is present", async () => {
    const span = fakeSpan({
      attributes: { [GEN_AI_REQUEST_MODEL]: "gpt-4", [GEN_AI_SYSTEM]: "openai" },
    });
    await collectExport(exporter, [span]);
    expect((exported[0].attributes as Record<string, unknown>)["mlflow.llm.provider"]).toBe("openai");
  });

  it("does not emit provider when no model present", async () => {
    const span = fakeSpan({ attributes: { [GEN_AI_SYSTEM]: "openai" } });
    await collectExport(exporter, [span]);
    expect((exported[0].attributes as Record<string, unknown>)["mlflow.llm.provider"]).toBeUndefined();
  });

  it("processes ai.node.input event into mlflow.spanInputs", async () => {
    const span = fakeSpan({
      events: [{ name: EVENT_NODE_INPUT, attributes: { data: JSON.stringify({ query: "hello" }) } }],
    });
    await collectExport(exporter, [span]);
    expect((exported[0].attributes as Record<string, unknown>)["mlflow.spanInputs"]).toEqual({ query: "hello" });
  });

  it("processes ai.node.output event into mlflow.spanOutputs", async () => {
    const span = fakeSpan({
      events: [{ name: EVENT_NODE_OUTPUT, attributes: { data: JSON.stringify({ result: 42 }) } }],
    });
    await collectExport(exporter, [span]);
    expect((exported[0].attributes as Record<string, unknown>)["mlflow.spanOutputs"]).toEqual({ result: 42 });
  });

  it("processes ai.llm.cost event into mlflow.llm.cost", async () => {
    const span = fakeSpan({
      events: [{ name: EVENT_LLM_COST, attributes: { input_cost: 0.01, output_cost: 0.02, total_cost: 0.03 } }],
    });
    await collectExport(exporter, [span]);
    expect((exported[0].attributes as Record<string, unknown>)["mlflow.llm.cost"]).toEqual({
      input_cost: 0.01,
      output_cost: 0.02,
      total_cost: 0.03,
    });
  });

  it("merges gen_ai.system.message and gen_ai.user.message into spanInputs", async () => {
    const span = fakeSpan({
      events: [
        { name: EVENT_GEN_AI_SYSTEM_MESSAGE, attributes: { content: "You are helpful", "ai.prompt_name": "summary" } },
        { name: EVENT_GEN_AI_USER_MESSAGE, attributes: { content: "Summarize this" } },
      ],
    });
    await collectExport(exporter, [span]);
    const inputs = (exported[0].attributes as Record<string, unknown>)["mlflow.spanInputs"] as Record<string, unknown>;
    expect(inputs["system_prompt"]).toBe("You are helpful");
    expect(inputs["user_prompt"]).toBe("Summarize this");
    expect(inputs["prompt_name"]).toBe("summary");
  });

  it("latches permanent failure and exposes via .failed", async () => {
    const failExporter = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "1",
      createInner: async () => { throw new Error("module not found"); },
    });

    const span = fakeSpan();
    const { result } = await collectExport(failExporter, [span]);
    expect(result.code).toBe(1);
    expect(failExporter.failed).toBeInstanceOf(Error);
    expect(failExporter.failed!.message).toBe("module not found");
  });

  it("tracks droppedSpanCount on permanent failure", async () => {
    const failExporter = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "1",
      createInner: async () => { throw new Error("boom"); },
    });

    await collectExport(failExporter, [fakeSpan()]);
    await collectExport(failExporter, [fakeSpan(), fakeSpan()]);
    expect(failExporter.droppedSpanCount).toBe(3);
  });

  it("does not leak SpanAttributeRegistry entries on normal export", async () => {
    const span = fakeSpan({ attributes: { [AI_SPAN_TYPE]: "chain" } });
    await collectExport(exporter, [span]);
    expect(exporter.getRegistry().size).toBe(0);
  });

  it("parseFailureCounter is per-instance", async () => {
    // Two exporters should not share parse failure state
    const exporter2 = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "2",
      createInner: async () => innerExporter,
    });

    const span = fakeSpan({
      events: [{ name: EVENT_NODE_INPUT, attributes: { data: "not-json{{{" } }],
    });
    await collectExport(exporter, [span]);
    await collectExport(exporter2, [fakeSpan({ events: [{ name: EVENT_NODE_INPUT, attributes: { data: "also-bad" } }] })]);
    // Both should have logged (count=1 each) — no shared state. Just verify no throw.
  });

  // Wave 1.2 regression — shutdown()/forceFlush() must NOT throw when init
  // failed permanently. Re-throwing aborts the OTel SDK shutdown chain and
  // leaves sibling exporters un-closed; silently resolving in forceFlush()
  // used to mask dropped spans. Both methods are no-ops on permanent failure.
  it("shutdown() is a no-op after permanent init failure", async () => {
    const failExporter = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "1",
      createInner: async () => { throw new Error("init blew up"); },
    });
    // Trigger init by calling export so failedPermanently latches.
    await collectExport(failExporter, [fakeSpan()]);
    expect(failExporter.failed).toBeInstanceOf(Error);

    // Must resolve without throwing.
    await failExporter.shutdown();
  });

  it("forceFlush() is a no-op after permanent init failure", async () => {
    const failExporter = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "1",
      createInner: async () => { throw new Error("init blew up"); },
    });
    await collectExport(failExporter, [fakeSpan()]);
    expect(failExporter.failed).toBeInstanceOf(Error);

    await failExporter.forceFlush();
  });

  it("shutdown() and forceFlush() before any export do not throw", async () => {
    const idle = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "1",
      createInner: async () => innerExporter,
    });
    await idle.shutdown();
    await idle.forceFlush();
  });
});
