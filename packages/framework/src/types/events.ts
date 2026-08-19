import type { SpanKind } from "./span.js";
import type { FrameworkError } from "./errors.js";
import type { RunId, NodeId, DagId } from "./ids.js";
import type { SideEffectProfile } from "./side-effects.js";
import type { Confidence } from "./confidence.js";
import type { Witness, ResourceName, WriteEntry } from "./witness.js";
import type { SideEffectKind } from "./side-effects.js";
import type { JsonPatch } from "./json-patch.js";

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
  readonly sideEffects: SideEffectProfile;
  readonly timestamp: Date;
}

export interface NodeEndEvent {
  readonly type: "node-end";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly sideEffects: SideEffectProfile;
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
  readonly sideEffects?: SideEffectProfile;
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

/**
 * Evidence colocated with a routing decision. Captures the upstream output,
 * confidence signal, and per-predicate evaluation results so that an
 * operator can answer "why did this route fire?" from the event log alone.
 */
export interface RouteEvidence {
  readonly upstreamOutput: unknown;
  readonly upstreamConfidence: Confidence | null;
  readonly predicateResults: ReadonlyArray<import("./dag.js").PredicateResult>;
  readonly decidedAtMs: number;
}

export interface RouteDecidedEvent {
  readonly type: "route-decided";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly fromNodeId: NodeId;
  readonly chosenTargets: readonly NodeId[];
  readonly prunedTargets: readonly NodeId[];
  readonly defaultTaken: boolean;
  readonly evidence: RouteEvidence;
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

// ---------------------------------------------------------------------------
// Freshness witness events
// ---------------------------------------------------------------------------

/**
 * Emitted after a `reads` node completes successfully. Captures the
 * freshness witness extracted from the node's output.
 */
export interface WitnessCapturedEvent {
  readonly type: "witness-captured";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly witness: Witness;
  readonly capturedAtMs: number;
  readonly timestamp: Date;
}

/**
 * Emitted after a `writes` node completes successfully. Records both the
 * witness the write was conditioned on and the new witness produced.
 */
export interface WriteAttemptedEvent {
  readonly type: "write-attempted";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly conditionedOn: Witness;
  readonly newWitness: Witness;
  readonly succeededAtMs: number;
  readonly timestamp: Date;
}

/**
 * Emitted when the framework detects that a write's conditioned-on witness
 * has been superseded by a conflicting write (possibly from another run).
 * The write still proceeds — the policy of "abort vs. proceed on violation"
 * is owned by the node author via routing on `freshness-violation` events.
 */
export interface FreshnessViolationEvent {
  readonly type: "freshness-violation";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  /** Branded — stamped from `conditionedOnWitness.resource`, cannot drift from it. */
  readonly resource: ResourceName;
  readonly conditionedOnWitness: Witness;
  /** The write that superseded the conditioned-on witness (ONE encoding with
   * `FreshnessConflict.conflictingWrite` — round-23 tda-1). */
  readonly conflictingWrite: WriteEntry;
  readonly detectedAtMs: number;
  readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// Human intervention event
// ---------------------------------------------------------------------------

/**
 * Detailed human action with full context for forensic analysis.
 * Extends the DAG-layer `HumanAction` with structural diff for edits
 * and reason fields for reroutes.
 */
export type HumanActionDetailed =
  | { readonly kind: "approve" }
  | {
      readonly kind: "approve-with-edit";
      readonly originalOutput: unknown;
      readonly replacedOutput: unknown;
      readonly diff: JsonPatch;
    }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "reroute"; readonly targetNodeId: NodeId; readonly reason?: string };

/**
 * Emitted when a human reviewer responds to an `awaiting-human` gate.
 * Captures the full decision context — model confidence, side-effects being
 * authorized, freshness state of involved resources — so that the event log
 * answers "what did the human see when they approved this?" without joining
 * across separate events.
 *
 * The `context` field bundles sideEffects, confidence, and freshness state
 * so the event is self-contained — no cross-event joins needed at read time.
 *
 * @see docs/adr/0026-human-intervention-telemetry.md
 */
export interface HumanInterventionEvent {
  readonly type: "human-intervention";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly action: HumanActionDetailed;
  readonly actor: string;
  readonly elapsedMsSinceAwait: number;
  readonly context: {
    readonly nodeConfidence: Confidence | null;
    /** Kind only — the full `SideEffectProfile` (resource, idempotencyKey) is available on the preceding `NodeStartEvent`. */
    readonly nodeSideEffects: SideEffectKind;
    readonly priorWitnesses: readonly Witness[];
  };
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
  | NodePrunedEvent
  | WitnessCapturedEvent
  | WriteAttemptedEvent
  | FreshnessViolationEvent
  | HumanInterventionEvent;
