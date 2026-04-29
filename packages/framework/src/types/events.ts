import type { SpanKind } from "./span.js";

export interface RunStartEvent {
  readonly type: "run-start";
  readonly runId: string;
  readonly dagId: string;
  readonly timestamp: Date;
}

export interface NodeStartEvent {
  readonly type: "node-start";
  readonly runId: string;
  readonly dagId: string;
  readonly nodeId: string;
  readonly timestamp: Date;
}

export interface NodeEndEvent {
  readonly type: "node-end";
  readonly runId: string;
  readonly dagId: string;
  readonly nodeId: string;
  readonly timestamp: Date;
  readonly duration: number;
  readonly output: unknown;
}

export interface NodeSkippedEvent {
  readonly type: "node-skipped";
  readonly runId: string;
  readonly dagId: string;
  readonly nodeId: string;
  readonly timestamp: Date;
  readonly reason: string;
}

export interface NodeErrorEvent {
  readonly type: "node-error";
  readonly runId: string;
  readonly dagId: string;
  readonly nodeId: string;
  readonly timestamp: Date;
  readonly error: string;
  readonly stack?: string;
}

export interface SubSpanEvent {
  readonly type: "sub-span";
  readonly runId: string;
  readonly dagId: string;
  readonly nodeId: string;
  readonly parentSpanId: string;
  readonly kind: SpanKind;
  readonly timestamp: Date;
  readonly duration: number;
  readonly attributes: Record<string, unknown>;
}

export interface RunEndEvent {
  readonly type: "run-end";
  readonly runId: string;
  readonly dagId: string;
  readonly timestamp: Date;
  readonly duration: number;
  readonly status: "ok" | "error";
}

export type ObserverEvent =
  | RunStartEvent
  | NodeStartEvent
  | NodeEndEvent
  | NodeSkippedEvent
  | NodeErrorEvent
  | SubSpanEvent
  | RunEndEvent;
