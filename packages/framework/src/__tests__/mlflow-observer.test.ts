import { describe, it, expect, beforeEach } from "bun:test";
import {
  MLflowObserver,
  mapNodeKindToMlflow,
  mapSubSpanKindToMlflow,
  resetSpanCounter,
} from "../observer/mlflow.js";
import type {
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  NodeSkippedEvent,
  NodeErrorEvent,
  SubSpanEvent,
  RunEndEvent,
} from "../types/events.js";
import type { SpanKind } from "../types/span.js";
import type { MlflowSpanKind } from "../observer/mlflow.js";
import type { Observer } from "../observer/observer.js";

const ts = () => new Date("2026-01-01T00:00:00Z");

function runStart(): RunStartEvent {
  return { type: "run-start", runId: "r1", dagId: "dag1", timestamp: ts() };
}
function nodeStart(nodeId: string): NodeStartEvent {
  return { type: "node-start", runId: "r1", dagId: "dag1", nodeId, timestamp: ts() };
}
function nodeEnd(nodeId: string): NodeEndEvent {
  return { type: "node-end", runId: "r1", dagId: "dag1", nodeId, timestamp: ts(), duration: 100, output: { text: "hi" } };
}
function nodeSkipped(nodeId: string): NodeSkippedEvent {
  return { type: "node-skipped", runId: "r1", dagId: "dag1", nodeId, timestamp: ts(), reason: "cache hit" };
}
function nodeError(nodeId: string): NodeErrorEvent {
  return { type: "node-error", runId: "r1", dagId: "dag1", nodeId, timestamp: ts(), error: "boom", stack: "stack" };
}
function subSpan(nodeId: string, kind: SpanKind): SubSpanEvent {
  return { type: "sub-span", runId: "r1", dagId: "dag1", nodeId, parentSpanId: "ps1", kind, timestamp: ts(), duration: 50, attributes: { model: "gpt-4" } };
}
function runEnd(): RunEndEvent {
  return { type: "run-end", runId: "r1", dagId: "dag1", timestamp: ts(), duration: 500, status: "ok" };
}

describe("MLflowObserver", () => {
  beforeEach(() => resetSpanCounter());

  it("implements Observer interface", () => {
    const obs: Observer = new MLflowObserver();
    expect(obs.onRunStart).toBeInstanceOf(Function);
    expect(obs.onNodeStart).toBeInstanceOf(Function);
    expect(obs.onNodeEnd).toBeInstanceOf(Function);
    expect(obs.onNodeSkipped).toBeInstanceOf(Function);
    expect(obs.onNodeError).toBeInstanceOf(Function);
    expect(obs.onSubSpan).toBeInstanceOf(Function);
    expect(obs.onRunEnd).toBeInstanceOf(Function);
  });

  it("creates root span on run start", () => {
    const obs = new MLflowObserver();
    obs.onRunStart(runStart());
    expect(obs.spans).toHaveLength(1);
    expect(obs.spans[0]!.parentSpanId).toBeNull();
    expect(obs.spans[0]!.kind).toBe("CHAIN");
    expect(obs.spans[0]!.name).toBe("run:dag1");
  });

  it("creates child span on node start, closes on node end", () => {
    const obs = new MLflowObserver();
    obs.onRunStart(runStart());
    obs.onNodeStart(nodeStart("fetch-articles"));
    expect(obs.spans).toHaveLength(2);
    expect(obs.spans[1]!.parentSpanId).toBe(obs.spans[0]!.spanId);
    expect(obs.spans[1]!.kind).toBe("RETRIEVAL");
    expect(obs.spans[1]!.status).toBe("running");

    obs.onNodeEnd(nodeEnd("fetch-articles"));
    expect(obs.spans[1]!.status).toBe("ok");
    expect(obs.spans[1]!.endTime).not.toBeNull();
    expect(obs.spans[1]!.attributes).toHaveProperty("duration", 100);
  });

  it("handles skipped nodes", () => {
    const obs = new MLflowObserver();
    obs.onRunStart(runStart());
    obs.onNodeSkipped(nodeSkipped("transform-x"));
    expect(obs.spans).toHaveLength(2);
    expect(obs.spans[1]!.status).toBe("skipped");
    expect(obs.spans[1]!.attributes).toHaveProperty("skipped", true);
    expect(obs.spans[1]!.endTime).toEqual(obs.spans[1]!.startTime);
  });

  it("handles node errors", () => {
    const obs = new MLflowObserver();
    obs.onRunStart(runStart());
    obs.onNodeStart(nodeStart("llm-summarize"));
    obs.onNodeError(nodeError("llm-summarize"));
    expect(obs.spans[1]!.status).toBe("error");
    expect(obs.spans[1]!.attributes).toHaveProperty("error", "boom");
  });

  it("creates sub-spans nested under node span", () => {
    const obs = new MLflowObserver();
    obs.onRunStart(runStart());
    obs.onNodeStart(nodeStart("llm-gen"));
    obs.onSubSpan(subSpan("llm-gen", "LLM"));
    expect(obs.spans).toHaveLength(3);
    const sub = obs.spans[2]!;
    expect(sub.parentSpanId).toBe(obs.spans[1]!.spanId);
    expect(sub.kind).toBe("LLM");
    expect(sub.attributes).toHaveProperty("model", "gpt-4");
  });

  it("closes root span on run end", () => {
    const obs = new MLflowObserver();
    obs.onRunStart(runStart());
    obs.onRunEnd(runEnd());
    expect(obs.spans[0]!.status).toBe("ok");
    expect(obs.spans[0]!.endTime).not.toBeNull();
  });

  it("full lifecycle produces correct span hierarchy", () => {
    const obs = new MLflowObserver();
    obs.onRunStart(runStart());
    obs.onNodeStart(nodeStart("fetch-data"));
    obs.onSubSpan(subSpan("fetch-data", "RETRIEVAL"));
    obs.onNodeEnd(nodeEnd("fetch-data"));
    obs.onNodeStart(nodeStart("llm-summarize"));
    obs.onSubSpan(subSpan("llm-summarize", "LLM"));
    obs.onNodeEnd(nodeEnd("llm-summarize"));
    obs.onNodeSkipped(nodeSkipped("transform-optional"));
    obs.onRunEnd(runEnd());

    // root + fetch-data + subspan + llm-summarize + subspan + skipped = 6
    expect(obs.spans).toHaveLength(6);
    expect(obs.spans[0]!.status).toBe("ok"); // root closed
    expect(obs.spans[0]!.parentSpanId).toBeNull();
    // All node spans have root as parent
    expect(obs.spans[1]!.parentSpanId).toBe(obs.spans[0]!.spanId);
    expect(obs.spans[3]!.parentSpanId).toBe(obs.spans[0]!.spanId);
  });
});

describe("mapNodeKindToMlflow", () => {
  it("maps fetch nodes to RETRIEVAL", () => {
    expect(mapNodeKindToMlflow("fetch-articles")).toBe("RETRIEVAL");
    expect(mapNodeKindToMlflow("retrieve-data")).toBe("RETRIEVAL");
  });
  it("maps llm nodes to LLM", () => {
    expect(mapNodeKindToMlflow("llm-summarize")).toBe("LLM");
    expect(mapNodeKindToMlflow("generate-text")).toBe("LLM");
    expect(mapNodeKindToMlflow("summarize-content")).toBe("LLM");
  });
  it("maps everything else to CHAIN", () => {
    expect(mapNodeKindToMlflow("transform-data")).toBe("CHAIN");
    expect(mapNodeKindToMlflow("merge-results")).toBe("CHAIN");
  });
});

describe("mapSubSpanKindToMlflow", () => {
  const cases: [SpanKind, MlflowSpanKind][] = [
    ["LLM", "LLM"],
    ["RETRIEVAL", "RETRIEVAL"],
    ["FETCH", "RETRIEVAL"],
    ["EVALUATOR", "EVALUATOR"],
    ["GUARDRAIL", "GUARDRAIL"],
    ["CHAIN", "CHAIN"],
    ["TRANSFORM", "CHAIN"],
    ["DECISION", "UNKNOWN"],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${input} → ${expected}`, () => {
      expect(mapSubSpanKindToMlflow(input)).toBe(expected);
    });
  }
});
