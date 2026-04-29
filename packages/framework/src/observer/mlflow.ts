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
import type { Observer } from "./observer.js";

// MLflow span types (subset relevant to our mapping)
export type MlflowSpanKind =
  | "LLM"
  | "RETRIEVAL"
  | "CHAIN"
  | "EVALUATOR"
  | "GUARDRAIL"
  | "UNKNOWN";

export interface MlflowSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: MlflowSpanKind;
  readonly startTime: Date;
  readonly endTime: Date | null;
  readonly status: "ok" | "error" | "skipped" | "running";
  readonly attributes: Record<string, unknown>;
}

/**
 * Maps DAG node kinds (inferred from nodeId conventions) to MLflow span kinds.
 * Node-level spans use: fetch → RETRIEVAL, transform → CHAIN, llm → LLM
 */
export function mapNodeKindToMlflow(nodeId: string): MlflowSpanKind {
  const lower = nodeId.toLowerCase();
  if (lower.includes("fetch") || lower.includes("retriev")) return "RETRIEVAL";
  if (lower.includes("llm") || lower.includes("generat") || lower.includes("summariz")) return "LLM";
  return "CHAIN";
}

/**
 * Maps SubSpanEvent SpanKind to MLflow span kind.
 */
export function mapSubSpanKindToMlflow(kind: SpanKind): MlflowSpanKind {
  switch (kind) {
    case "LLM":
      return "LLM";
    case "RETRIEVAL":
    case "FETCH":
      return "RETRIEVAL";
    case "EVALUATOR":
      return "EVALUATOR";
    case "GUARDRAIL":
      return "GUARDRAIL";
    case "CHAIN":
    case "TRANSFORM":
      return "CHAIN";
    case "DECISION":
      return "UNKNOWN";
    default:
      return "UNKNOWN";
  }
}

let spanCounter = 0;
function nextSpanId(): string {
  return `span-${++spanCounter}`;
}

/** Reset span counter (for testing) */
export function resetSpanCounter(): void {
  spanCounter = 0;
}

/**
 * MLflowObserver translates DAG observer events into MLflow-compatible span structures.
 *
 * Currently stores spans in-memory. The actual MLflow REST API transport
 * (POST /api/2.0/mlflow/traces) can be wired in later.
 *
 * TODO: Add MLflow REST API integration (createExperiment, startTrace, logSpans)
 */
export class MLflowObserver implements Observer {
  /** All completed spans for the current run */
  readonly spans: MlflowSpan[] = [];

  private rootSpanId: string | null = null;
  private readonly nodeSpanIds = new Map<string, string>();

  onRunStart(e: RunStartEvent): void {
    const spanId = nextSpanId();
    this.rootSpanId = spanId;
    this.spans.push({
      spanId,
      parentSpanId: null,
      name: `run:${e.dagId}`,
      kind: "CHAIN",
      startTime: e.timestamp,
      endTime: null,
      status: "running",
      attributes: { runId: e.runId, dagId: e.dagId },
    });
  }

  onNodeStart(e: NodeStartEvent): void {
    const spanId = nextSpanId();
    this.nodeSpanIds.set(e.nodeId, spanId);
    this.spans.push({
      spanId,
      parentSpanId: this.rootSpanId,
      name: `node:${e.nodeId}`,
      kind: mapNodeKindToMlflow(e.nodeId),
      startTime: e.timestamp,
      endTime: null,
      status: "running",
      attributes: { nodeId: e.nodeId },
    });
  }

  onNodeEnd(e: NodeEndEvent): void {
    const spanId = this.nodeSpanIds.get(e.nodeId);
    if (!spanId) return;
    this.closeSpan(spanId, {
      endTime: e.timestamp,
      status: "ok",
      extraAttrs: { duration: e.duration, output: e.output },
    });
    this.nodeSpanIds.delete(e.nodeId);
  }

  onNodeSkipped(e: NodeSkippedEvent): void {
    const spanId = nextSpanId();
    this.spans.push({
      spanId,
      parentSpanId: this.rootSpanId,
      name: `node:${e.nodeId}`,
      kind: "CHAIN",
      startTime: e.timestamp,
      endTime: e.timestamp,
      status: "skipped",
      attributes: { nodeId: e.nodeId, reason: e.reason, skipped: true },
    });
  }

  onNodeError(e: NodeErrorEvent): void {
    const spanId = this.nodeSpanIds.get(e.nodeId);
    if (!spanId) return;
    this.closeSpan(spanId, {
      endTime: e.timestamp,
      status: "error",
      extraAttrs: { error: e.error, stack: e.stack },
    });
    this.nodeSpanIds.delete(e.nodeId);
  }

  onSubSpan(e: SubSpanEvent): void {
    const parentSpanId = this.nodeSpanIds.get(e.nodeId) ?? this.rootSpanId;
    const spanId = nextSpanId();
    this.spans.push({
      spanId,
      parentSpanId,
      name: `subspan:${e.nodeId}:${e.kind}`,
      kind: mapSubSpanKindToMlflow(e.kind),
      startTime: e.timestamp,
      endTime: new Date(e.timestamp.getTime() + e.duration),
      status: "ok",
      attributes: { ...e.attributes, parentSpanId: e.parentSpanId, duration: e.duration },
    });
  }

  onRunEnd(e: RunEndEvent): void {
    if (!this.rootSpanId) return;
    this.closeSpan(this.rootSpanId, {
      endTime: e.timestamp,
      status: e.status,
      extraAttrs: { duration: e.duration, status: e.status },
    });
    // TODO: POST spans to MLflow REST API
  }

  private closeSpan(
    spanId: string,
    opts: { endTime: Date; status: MlflowSpan["status"]; extraAttrs?: Record<string, unknown> },
  ): void {
    const idx = this.spans.findIndex((s) => s.spanId === spanId);
    if (idx === -1) return;
    const existing = this.spans[idx]!;
    this.spans[idx] = {
      ...existing,
      endTime: opts.endTime,
      status: opts.status,
      attributes: { ...existing.attributes, ...opts.extraAttrs },
    };
  }
}
