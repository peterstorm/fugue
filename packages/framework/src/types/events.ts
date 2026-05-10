import type { SpanKind } from "./span.js";
import type { Predicate } from "./dag.js";

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

export interface RouteDecidedEvent {
  readonly type: "route-decided";
  readonly runId: string;
  readonly dagId: string;
  readonly fromNodeId: string;
  readonly chosenTargets: readonly string[];
  readonly prunedTargets: readonly string[];
  readonly defaultTaken: boolean;
  /** The predicate that matched, or `null` when the default fired. Serializable JSON. */
  readonly matchedPredicate: Predicate<unknown> | null;
  readonly timestamp: Date;
}

export interface NodePrunedEvent {
  readonly type: "node-pruned";
  readonly runId: string;
  readonly dagId: string;
  readonly nodeId: string;
  readonly reason: "branch-not-taken";
  readonly timestamp: Date;
}

export type ObserverEvent =
  | RunStartEvent
  | NodeStartEvent
  | NodeEndEvent
  | NodeSkippedEvent
  | NodeErrorEvent
  | SubSpanEvent
  | RunEndEvent
  | RouteDecidedEvent
  | NodePrunedEvent;
