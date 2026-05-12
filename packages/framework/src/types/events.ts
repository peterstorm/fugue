import type { SpanKind } from "./span.js";
import type { Predicate } from "./dag.js";
import type { FrameworkError } from "./errors.js";
import type { RunId, NodeId, DagId } from "./ids.js";

export interface RunStartEvent {
  readonly type: "run-start";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly timestamp: Date;
}

export interface NodeStartEvent {
  readonly type: "node-start";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly timestamp: Date;
}

export interface NodeEndEvent {
  readonly type: "node-end";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly timestamp: Date;
  readonly duration: number;
  readonly output: unknown;
}

export interface NodeSkippedEvent {
  readonly type: "node-skipped";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly timestamp: Date;
  /**
   * Why the node was skipped. The two producers are `runNodeShared` on a
   * checkpoint hit and `runWave` when an already-succeeded sibling is
   * encountered on a retry pass. Narrowing the type lets observers
   * exhaustively match — and keeps the contract aligned with
   * `NodePrunedEvent.reason: "branch-not-taken"`, the only other narrow-reason
   * event variant.
   */
  readonly reason: "checkpoint" | "already-completed";
}

export interface NodeErrorEvent {
  readonly type: "node-error";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly timestamp: Date;
  /** Human-readable summary for display. */
  readonly error: string;
  readonly stack?: string;
  /**
   * Structured framework error. Required at the event boundary so consumers
   * can pattern-match on `kind` without parsing `error` text. The discriminant
   * carries `retriability`, `nodeId`, and the full FrameworkError union shape.
   */
  readonly frameworkError: FrameworkError;
}

export interface SubSpanEvent {
  readonly type: "sub-span";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly parentSpanId: string;
  readonly kind: SpanKind;
  readonly timestamp: Date;
  readonly duration: number;
  readonly attributes: Record<string, unknown>;
}

export interface RunEndEvent {
  readonly type: "run-end";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly timestamp: Date;
  readonly duration: number;
  readonly status: "ok" | "error";
}

export interface RouteDecidedEvent {
  readonly type: "route-decided";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly fromNodeId: NodeId;
  readonly chosenTargets: readonly NodeId[];
  readonly prunedTargets: readonly NodeId[];
  readonly defaultTaken: boolean;
  /** The predicate that matched, or `null` when the default fired. Serializable JSON. */
  readonly matchedPredicate: Predicate<unknown> | null;
  readonly timestamp: Date;
}

export interface NodePrunedEvent {
  readonly type: "node-pruned";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
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
