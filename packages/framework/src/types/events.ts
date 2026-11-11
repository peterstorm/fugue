import type { SpanKind } from "./span.js";
import type { FrameworkError } from "./errors.js";
import type { RunId, NodeId, DagId } from "./ids.js";
import type { SideEffectProfile } from "./side-effects.js";
import type { Confidence } from "./confidence.js";
import type { Witness, WriteEntry, FreshnessExecutionEpoch } from "./witness.js";
import type { SideEffectKind } from "./side-effects.js";
import type { JsonPatch } from "./json-patch.js";
import type {
  ChildConcurrency,
  FanConcurrencyCap,
  FanEstimator,
  FanRefusal,
} from "./fan-scheduling.js";

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
  /** Durable identity of this logical execution; stable across bookkeeping retries. */
  readonly executionEpoch: FreshnessExecutionEpoch;
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
  /** The violation's resource identity is `conditionedOnWitness.resource`. */
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

// ---------------------------------------------------------------------------
// Fan scheduling events (ADR-0087)
// ---------------------------------------------------------------------------

/**
 * Structured observability for concurrent `map` fans (F1 PR-D, ADR-0087):
 * effective concurrency at fan start (including any FR-033 clamp), the
 * projected per-child cost and estimator at each projection, and the refusal
 * point (FR-060).
 *
 * All three variants are ADDITIVE and OUTSIDE the FR-004 trace (AD-13): C=1
 * golden equivalence is defined over dispatch order, checkpoint calls and
 * errors — never these events — so emitting them cannot break trace
 * equivalence and trace consumers are not taught about them.
 *
 * The union stays CLOSED but EXTENSIBLE (AD-2): D3 (adaptive concurrency)
 * later adds a `throttle` event and an `adaptiveTarget` field WITHOUT
 * reshaping any variant. Keep field shapes stable and additive — never
 * repurpose or retype an existing field.
 *
 * These interfaces CARRY facts only: no fan phase literals (INV-1 — those
 * live in the LC-1 machine file), no error objects (INV-2 — errors are minted
 * only by the error factories), no brand casts (INV-3 — the concurrency
 * brands are minted only in `types/fan-scheduling.ts`).
 */

/**
 * Emitted once per fan start — the structured half of the FR-033 clamp. It
 * names the fan (`nodeId`), the authored child concurrency, and the effective
 * concurrency the scheduler runs with, so a clamp is auditable from the event
 * log alone: `clamped: true` means `authored` exceeded the host cap `cap` and
 * `effective` is `min(authored, cap)`; `clamped: false` means
 * `effective === authored`. The VISIBLE warning (a `logger.warn`) is the
 * shell's job (`runMappedFan`), not the event's — this event is the
 * structured half the spec pairs with it.
 *
 * `width` is the fan's child count; `replayed` counts children satisfied from
 * checkpoints; `seeded` is true when a persisted refusal seed was found for
 * this fan (the AD-11 seed lifecycle — a seeded fan resumes with the seed's
 * refused ceilings rather than re-projecting the remaining children from
 * scratch). `estimator` is the estimator the fan's projections apply
 * (largest-seen by default).
 */
export interface FanStartEvent {
  readonly type: "fan-start";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly width: number;
  readonly replayed: number;
  readonly seeded: boolean;
  readonly authored: ChildConcurrency;
  readonly cap: FanConcurrencyCap;
  readonly effective: number;
  readonly clamped: boolean;
  readonly estimator: FanEstimator;
  readonly timestamp: Date;
}

/**
 * Emitted at each whole-fan projection (FR-060): the per-child estimate the
 * projection applied on the budget axis it was evaluated against, the
 * estimator that produced it, and the verdict for the remaining children.
 *
 * `estimate` is the per-child figure on `axis`; `lowerBound` is that axis's
 * under-counting flag (true on `unpriced` / `unknown-usage` usd/token axes,
 * false on priced ones — the AD-4 headroom table), so a consumer can tell a
 * floor estimate from an exact figure without re-deriving ceiling kinds.
 * `estimatorApplied` records what was ACTUALLY applied — a percentile may
 * have fallen back — not what was authored. `effectiveConcurrency` is the
 * fan's running concurrency at the projection; `remainingChildren` is width
 * minus successfully completed children, so it includes in-flight slots and
 * the slot about to start (AD-4).
 *
 * `verdict` is the projection's decision: `admit` when the remaining children
 * fit inside the ceiling on the evaluated axis, `refuse` when they do not —
 * there `axis` is the first breached axis in ceiling order (AD-4) and the
 * companion `fan-refused` event carries the full breach (ceiling, completed
 * and remaining counts) in its embedded `FanRefusal`.
 */
export interface FanProjectionEvent {
  readonly type: "fan-projection";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly effectiveConcurrency: number;
  readonly axis: FanRefusal["axis"];
  readonly estimate: number;
  readonly estimatorApplied: FanEstimator;
  readonly remainingChildren: number;
  readonly verdict: "admit" | "refuse";
  readonly lowerBound: boolean;
  readonly timestamp: Date;
}

/**
 * Emitted at the refusal point — the structured, SELF-CONTAINED half of
 * FR-060 (AS-012). The embedded `FanRefusal` carries the full breach: the
 * breached axis and its ceiling, the per-child estimate, the estimator
 * applied, the effective concurrency, and the completed and remaining
 * counts, so "why was this fan refused?" is answerable from this one event
 * with no join against `fan-start` or `fan-projection`.
 *
 * `sticky` is true when the refusal was replayed from a persisted refusal
 * seed (FR-026) rather than freshly projected — the resume re-refuses until
 * the budget is raised (AD-11). `attachedToChildFailure` is true when the
 * refusal is reported as a cause of a `fan-child-failed` error (a drain on
 * failure that also breached the ceiling) rather than as the sole
 * `fan-budget-refused` outcome; either way the remedy is the refusal's
 * `hint`.
 */
export interface FanRefusedEvent {
  readonly type: "fan-refused";
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly refusal: FanRefusal;
  readonly sticky: boolean;
  readonly attachedToChildFailure: boolean;
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
  | HumanInterventionEvent
  | FanStartEvent
  | FanProjectionEvent
  | FanRefusedEvent;
