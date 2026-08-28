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
  GEN_AI_USAGE_CACHE_WRITE_TOKENS,
  GEN_AI_USAGE_CACHE_READ_TOKENS,
  EVENT_NODE_INPUT,
  EVENT_NODE_OUTPUT,
  EVENT_LLM_COST,
  EVENT_GEN_AI_SYSTEM_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  AI_HUMAN_ACTION,
  AI_HUMAN_ACTOR,
  AI_HUMAN_CONFIDENCE_BUCKET,
  AI_HUMAN_CONFIDENCE_SOURCE,
  AI_ROUTE_CONFIDENCE_BUCKET,
  AI_ROUTE_CONFIDENCE_SOURCE,
  AI_FRESHNESS_VIOLATION,
  AI_FRESHNESS_WITNESS_RESOURCE,
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
      cache_write_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
    });
  });

  it("carries the cache split in mlflow.chat.tokenUsage when the span reports it", async () => {
    const span = fakeSpan({
      attributes: {
        [GEN_AI_USAGE_INPUT_TOKENS]: 910,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: 7,
        [GEN_AI_USAGE_CACHE_WRITE_TOKENS]: 900,
        [GEN_AI_USAGE_CACHE_READ_TOKENS]: 0,
      },
    });
    await collectExport(exporter, [span]);
    const attrs = exported[0].attributes as Record<string, unknown>;
    expect(attrs["mlflow.chat.tokenUsage"]).toEqual({
      input_tokens: 910,
      output_tokens: 7,
      cache_write_tokens: 900,
      cache_read_tokens: 0,
      // `tokensIn` is inclusive of cache tokens, so the total is every token
      // that crossed the wire — the cache figures refine it, never add to it.
      total_tokens: 917,
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

  it("latches permanent failure and exposes via .failed after 3 attempts", async () => {
    const failExporter = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "1",
      createInner: async () => { throw new Error("module not found"); },
    });

    // Attempts 1 and 2: retries allowed, not yet permanent
    await collectExport(failExporter, [fakeSpan()]);
    expect(failExporter.failed).toBeNull();
    await collectExport(failExporter, [fakeSpan()]);
    expect(failExporter.failed).toBeNull();

    // Attempt 3: permanent failure latched
    const { result } = await collectExport(failExporter, [fakeSpan()]);
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

    // Exhaust retries (3 attempts)
    await collectExport(failExporter, [fakeSpan()]);
    await collectExport(failExporter, [fakeSpan()]);
    await collectExport(failExporter, [fakeSpan()]);
    // Now permanently failed — count from here
    expect(failExporter.failed).toBeInstanceOf(Error);
    await collectExport(failExporter, [fakeSpan(), fakeSpan()]);
    // 3 spans from retry phase + 2 after permanent = 5 total
    expect(failExporter.droppedSpanCount).toBe(5);
  });

  it("does not leak SpanAttributeRegistry entries on normal export", async () => {
    const span = fakeSpan({ attributes: { [AI_SPAN_TYPE]: "chain" } });
    await collectExport(exporter, [span]);
    expect(exporter.getRegistry().size).toBe(0);
  });

  it("parseFailureCounter is per-instance (W5.5 — isolation observed via counters)", async () => {
    // Pass-3 introduced per-instance parseFailureCounter to break a shared
    // module-level closure, but the regression test only verified "no throw"
    // — it never *observed* the counter to confirm isolation. A future
    // refactor that re-installed shared state would silently slip past.
    // Pass-4 §5.5 adds the missing assertion.
    const exporter2 = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "2",
      createInner: async () => innerExporter,
    });

    expect(exporter.parseFailureCount).toBe(0);
    expect(exporter2.parseFailureCount).toBe(0);

    // Trigger one parse failure on exporter A by feeding malformed JSON on the
    // canonical event the MLflow handler tries to JSON.parse.
    const badSpan = fakeSpan({
      events: [{ name: EVENT_NODE_INPUT, attributes: { data: "not valid json" } }],
    });
    const { exported: outA } = await collectExport(exporter, [badSpan]);
    void outA;

    expect(exporter.parseFailureCount).toBe(1);
    // Exporter B saw no spans yet — its counter must stay at zero. If the
    // counter were shared (the bug we're guarding against), this would read 1.
    expect(exporter2.parseFailureCount).toBe(0);

    // On the failed-parse path the handler falls back to stashing the raw
    // string under `mlflow.spanInputs.raw`. `mlflow.spanInputs` itself MUST
    // still be set (the fallback path), but it MUST NOT carry parsed-shape
    // keys from the malformed payload.
    const exportedAttrs = exported[0].attributes as Record<string, unknown>;
    const inputs = exportedAttrs["mlflow.spanInputs"] as Record<string, unknown>;
    expect(inputs).toBeDefined();
    expect(inputs["raw"]).toBe("not valid json");

    // Drive exporter B with its own parse failure — its counter advances
    // independently of A.
    const exported2: ReadableSpan[] = [];
    const innerExporter2: SpanExporter = {
      export(spans, cb) {
        exported2.push(...spans);
        cb({ code: 0 });
      },
      shutdown: async () => {},
    };
    const exporter2Isolated = new MlflowOtlpExporter({
      url: "http://localhost:5000",
      experimentId: "2-iso",
      createInner: async () => innerExporter2,
    });
    await collectExport(exporter2Isolated, [
      fakeSpan({ events: [{ name: EVENT_NODE_INPUT, attributes: { data: "also-bad" } }] }),
    ]);
    expect(exporter2Isolated.parseFailureCount).toBe(1);
    // A's counter never advances from B's activity.
    expect(exporter.parseFailureCount).toBe(1);
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
    // Exhaust retries (3 attempts) so failedPermanently latches.
    await collectExport(failExporter, [fakeSpan()]);
    await collectExport(failExporter, [fakeSpan()]);
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
    // Exhaust retries (3 attempts) so failedPermanently latches.
    await collectExport(failExporter, [fakeSpan()]);
    await collectExport(failExporter, [fakeSpan()]);
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

  describe("Phase 4 — human intervention tag promotion", () => {
    it("promotes ai.human.action to mlflow.human.action", async () => {
      const span = fakeSpan({ attributes: { [AI_HUMAN_ACTION]: "approve" } });
      await collectExport(exporter, [span]);
      expect((exported[0].attributes as Record<string, unknown>)["mlflow.human.action"]).toBe("approve");
    });

    it("promotes ai.human.actor only when present", async () => {
      const withActor = fakeSpan({ attributes: { [AI_HUMAN_ACTION]: "reject", [AI_HUMAN_ACTOR]: "alice" } });
      await collectExport(exporter, [withActor]);
      expect((exported[0].attributes as Record<string, unknown>)["mlflow.human.actor"]).toBe("alice");

      // Reset for second assertion
      exported = [];
      const withoutActor = fakeSpan({ attributes: { [AI_HUMAN_ACTION]: "reject" } });
      await collectExport(exporter, [withoutActor]);
      expect((exported[0].attributes as Record<string, unknown>)["mlflow.human.actor"]).toBeUndefined();
    });

    it("promotes confidence bucket and source at intervention", async () => {
      const span = fakeSpan({
        attributes: {
          [AI_HUMAN_ACTION]: "approve",
          [AI_HUMAN_CONFIDENCE_BUCKET]: "low",
          [AI_HUMAN_CONFIDENCE_SOURCE]: "self-reported-numeric",
        },
      });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      expect(attrs["mlflow.human.confidence_bucket_at_intervention"]).toBe("low");
      expect(attrs["mlflow.human.confidence_source_at_intervention"]).toBe("self-reported-numeric");
    });

    it("no mlflow.human.* tags without ai.human.action", async () => {
      const span = fakeSpan({ attributes: { [AI_SPAN_TYPE]: "chain" } });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      const humanKeys = Object.keys(attrs).filter((k) => k.startsWith("mlflow.human."));
      expect(humanKeys).toEqual([]);
    });
  });

  describe("Phase 5 — route confidence and freshness tag promotion", () => {
    it("promotes ai.route.confidence_bucket to mlflow.route.confidence_bucket", async () => {
      const span = fakeSpan({ attributes: { [AI_ROUTE_CONFIDENCE_BUCKET]: "high" } });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      expect(attrs["mlflow.route.confidence_bucket"]).toBe("high");
    });

    it("promotes ai.route.confidence_source to mlflow.route.confidence_source", async () => {
      const span = fakeSpan({
        attributes: {
          [AI_ROUTE_CONFIDENCE_BUCKET]: "medium",
          [AI_ROUTE_CONFIDENCE_SOURCE]: "logprob",
        },
      });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      expect(attrs["mlflow.route.confidence_source"]).toBe("logprob");
    });

    it("no mlflow.route.* tags without route confidence attrs", async () => {
      const span = fakeSpan({ attributes: { [AI_SPAN_TYPE]: "chain" } });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      const routeKeys = Object.keys(attrs).filter((k) => k.startsWith("mlflow.route."));
      expect(routeKeys).toEqual([]);
    });

    it("promotes ai.freshness.violation to mlflow.freshness.violation when truthy", async () => {
      const span = fakeSpan({ attributes: { [AI_FRESHNESS_VIOLATION]: "true" } });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      expect(attrs["mlflow.freshness.violation"]).toBe(true);
    });

    it("promotes ai.freshness.witness_resource to mlflow.freshness.resource", async () => {
      const span = fakeSpan({ attributes: { [AI_FRESHNESS_WITNESS_RESOURCE]: "postgres:orders" } });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      expect(attrs["mlflow.freshness.resource"]).toBe("postgres:orders");
    });

    it("no mlflow.freshness.* tags without freshness attrs", async () => {
      const span = fakeSpan({ attributes: { [AI_SPAN_TYPE]: "chain" } });
      await collectExport(exporter, [span]);
      const attrs = exported[0].attributes as Record<string, unknown>;
      const freshnessKeys = Object.keys(attrs).filter((k) => k.startsWith("mlflow.freshness."));
      expect(freshnessKeys).toEqual([]);
    });
  });
});
