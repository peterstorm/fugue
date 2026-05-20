// DAG runtime types
// DagPhase, DagEvent, DagMachineContext, HumanAction

import type { DagDef, EdgeDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { Decision } from "./routing.js";
import type { IncomingSources } from "./topology.js";
import type { NodeId } from "../types/ids.js";
import { nodeId } from "../types/ids.js";

/**
 * Sentinel node id used by the executor/runner when an ERROR event arrives
 * that cannot be attributed to a specific node. Validated via `nodeId()`
 * so it satisfies the `NodeId` type with proper regex enforcement.
 */
export const EXECUTOR_NODE_ID: NodeId = nodeId("__executor__");

// ---------------------------------------------------------------------------
// HumanAction — the payload a reviewer sends back
// ---------------------------------------------------------------------------

export type HumanAction =
  | { readonly action: "approve"; readonly actor?: string }
  | { readonly action: "approve-with-edit"; readonly newOutput: unknown; readonly actor?: string }
  | { readonly action: "reject"; readonly reason: string; readonly actor?: string }
  | { readonly action: "reroute"; readonly targetNodeId: NodeId; readonly reason?: string; readonly actor?: string };

// ---------------------------------------------------------------------------
// DagPhase — state of the DAG machine
// ---------------------------------------------------------------------------

export type DagPhase =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly wave: number }
  | {
      readonly kind: "awaiting-human";
      readonly nodeId: NodeId;
      readonly output: unknown;
      readonly prompt: string;
      /** Remaining review queue: node ids to review after the current one (ascending order). */
      readonly pendingReviews: readonly NodeId[];
      /** Wave index we paused on. */
      readonly wave: number;
    }
  | {
      readonly kind: "retrying";
      readonly wave: number;
      readonly nodeId: NodeId;
      readonly attempt: number;
      readonly nextDelayMs: number;
    }
  | {
      /**
       * The `onHumanReview` hook threw. The node's output and prompt are preserved.
       * The hook will be retried up to the node's retry budget (shared with node retries).
       * FR-029a: hook-crash retry semantics.
       */
      readonly kind: "retrying-hook";
      readonly nodeId: NodeId;
      /** The node's already-produced output — preserved across hook retries. */
      readonly output: unknown;
      /** The original review prompt — preserved across hook retries. */
      readonly prompt: string;
      /** Hook retry attempt (1-based). */
      readonly attempt: number;
      /** Delay before next hook call. Executor applies jitter. */
      readonly nextDelayMs: number;
      /** Remaining reviews after this node — preserved from the original awaiting-human phase. */
      readonly pendingReviews: readonly NodeId[];
      /** Wave index we paused on — preserved from the original awaiting-human phase. */
      readonly wave: number;
    }
  | { readonly kind: "succeeded"; readonly output: unknown }
  | { readonly kind: "failed"; readonly error: FrameworkError };

// ---------------------------------------------------------------------------
// DagEvent — events the executor/external world can deliver to the machine
// ---------------------------------------------------------------------------

export type DagEvent =
  | { readonly type: "start" }
  | {
      readonly type: "wave-done";
      readonly wave: number;
      readonly outputs: ReadonlyMap<NodeId, unknown>;
      /**
       * Per-source-node routing decision computed once by `runWave` after the
       * wave completes. Computed once per wave to avoid re-evaluating
       * predicates twice — the executor already evaluates them for
       * observer-event emission. Only nodes whose out-edges carry at least
       * one conditional/default edge appear here; unconditional-only sources
       * are omitted (no decision was needed).
       *
       * Mandatory (ADR-0029): the pure transition layer never evaluates
       * predicates — all routing is decided by the executor and carried here.
       */
      readonly routingDecisions: ReadonlyMap<NodeId, Decision>;
      /**
       * Per-node extracted confidence. Populated by the executor’s routing
       * phase so the pure transition layer can pass upstream confidence to
       * `decideRoute` on fallback paths without calling closures.
       */
      readonly confidenceValues?: ReadonlyMap<NodeId, import("../types/confidence.js").Confidence | null>;
    }
  | {
      readonly type: "node-failed";
      readonly nodeId: NodeId;
      readonly error: FrameworkError;
      /**
       * Outputs from sibling nodes that completed successfully in the same wave before
       * this failure. Carried so the transition can persist them into `ctx.outputs` and
       * avoid re-running succeeded siblings on retry.
       */
      readonly partialOutputs?: ReadonlyMap<NodeId, unknown>;
      /**
       * Additional node ids that also failed concurrently in the same wave.
       * The primary failure is `nodeId`; these are co-failed siblings.
       * Carried so `handleNodeFailed` can pre-increment their retry counters,
       * preventing off-by-one retry accounting when multiple nodes fail together.
       */
      readonly coFailedNodeIds?: ReadonlyArray<NodeId>;
    }
  | {
      readonly type: "human-responded";
      readonly nodeId: NodeId;
      readonly action: Exclude<HumanAction, { action: "reroute" }>;
    }
  | {
      readonly type: "human-responded";
      readonly nodeId: NodeId;
      readonly action: Extract<HumanAction, { action: "reroute" }>;
      /**
       * Precomputed active-node set for reroute actions. The executor computes
       * the reseeded active set (re-evaluating predicates for prior waves) and
       * carries it here so the pure transition layer never calls predicate
       * closures. Required for the reroute variant; the type system prevents
       * the executor from ever emitting a reroute event without it.
       */
      readonly rerouteActiveSet: ReadonlySet<NodeId>;
    }
  | { readonly type: "abort"; readonly reason: string }
  | { readonly type: "executor-error"; readonly retriable: boolean; readonly error: string };

// ---------------------------------------------------------------------------
// Context slice types — focused sub-records of DagMachineContextPersisted.
//
// Each slice groups fields by concern so transition helpers can declare narrow
// dependencies. `DagMachineContextPersisted` extends all slices, so callers
// reading `ctx.waves`, `ctx.retries`, etc. see no shape difference.
//
// Benefits:
//   - Transition helpers declare which slice they need → narrower test fixtures
//   - New features add to a sub-record; unrelated consumers don't see the field
//   - The slice names document what each transition helper depends on
// ---------------------------------------------------------------------------

/** Topology facts computed once at compile time. Immutable after construction. */
export interface DagTopology {
  readonly waves: readonly (readonly NodeId[])[];
  readonly edges: readonly EdgeDef[];
  /**
   * Closure-free unconditional adjacency. Maps each node to the targets of its
   * unconditional out-edges. Used by `expandActive` and `seedInitialActiveSet`
   * in the transition layer for forward-reachability walks without evaluating
   * predicate closures. Computed once at compile time.
   */
  readonly unconditionalAdj: ReadonlyMap<NodeId, readonly NodeId[]>;
  /** Explicit output node. If omitted, falls back to last active node. */
  readonly outputNodeId: NodeId | undefined;
}

/** Per-node retry configuration and accumulated attempt state. */
export interface DagRetryState {
  readonly retries: ReadonlyMap<NodeId, number>;
  /**
   * Per-node retry configuration (plain data, serializable). Populated at
   * compile time from `NodeDef.retry`. Used by `retry-policy.ts` so the
   * pure transition layer never reaches into live `NodeDef` objects.
   */
  readonly retryConfigs: ReadonlyMap<NodeId, { readonly backoffMs: readonly number[]; readonly jitterRatio: number }>;
  readonly defaultRetryLimit: number | undefined;
  readonly retryLimits: Readonly<Record<string, number>> | undefined;
}

/** Human-review gate configuration (plain data, no closures). */
export interface DagHumanGateConfig {
  /** Node IDs that declare human review (data only — no closures). */
  readonly humanReviewNodeIds: ReadonlySet<NodeId>;
  /** Human review prompts by node ID (plain data, extracted at compile time). */
  readonly humanReviewPrompts: ReadonlyMap<NodeId, string>;
}

/** Routing/active-set state that evolves per wave. */
export interface DagRoutingState {
  /**
   * Subset of node ids that should still run. Seeded at compile time to every
   * node forward-reachable from wave 0 along unconditional edges; expanded as
   * conditional/default edges fire after each wave.
   */
  readonly activeNodeIds: ReadonlySet<NodeId>;
  /**
   * Per-node extracted confidence values. Populated by the executor at wave
   * completion time so the pure transition layer can read precomputed
   * confidence without calling closure-based `confidence.extract()`.
   */
  readonly confidenceByNode: ReadonlyMap<NodeId, import("../types/confidence.js").Confidence | null>;
}

// ---------------------------------------------------------------------------
// DagMachineContextPersisted — the plain-data subset safe for serialization.
// Does NOT contain closures (run functions, Zod schemas, predicate functions).
// `DagMachineContext` extends this with live DAG-derived fields.
//
// The pure transition layer operates on this type directly — no intermediate
// type exists. See ADR-0029 for the rationale.
//
// Composed from focused slice types (DagTopology, DagRetryState,
// DagHumanGateConfig, DagRoutingState) plus per-run state (outputs, initialInput).
// ---------------------------------------------------------------------------

export interface DagMachineContextPersisted extends DagTopology, DagRetryState, DagHumanGateConfig, DagRoutingState {
  readonly outputs: ReadonlyMap<NodeId, unknown>;
  readonly initialInput: unknown;
}

// ---------------------------------------------------------------------------
// DagMachineContext — full runtime context with live DAG-derived fields.
// Used by the executor (imperative shell) which needs `nodeById` for `run()`
// and `outgoingByNode` for predicate evaluation and reroute computation.
//
// The pure transition layer operates on `DagMachineContextPersisted` directly.
// `DagMachineContext` adds closure-carrying fields that cannot survive
// serialization: the live DAG (with `run` functions), the outgoing adjacency
// (with predicate closures), and the node lookup map.
// ---------------------------------------------------------------------------

export interface DagMachineContext extends DagMachineContextPersisted {
  readonly dag: DagDef;
  /**
   * Precomputed adjacency: `nodeId → out-edges` (includes predicate closures).
   * Built once at compile time. Used by the executor for routing-decision
   * computation and reroute active-set reseeding.
   */
  readonly outgoingByNode: ReadonlyMap<NodeId, readonly EdgeDef[]>;
  /**
   * Precomputed `{ required, optional }` source partition per node, derived
   * from the edges at compile time. Used by `runNode` to assemble `nodeInput`
   * without consulting any author-supplied `deps` field (which no longer
   * exists — edges are the single source of truth, see ADR 0017).
   */
  readonly incomingByNode: ReadonlyMap<NodeId, IncomingSources>;
  /**
   * Precomputed node-id → NodeDef lookup. Built once at compile time so
   * the executor can do O(1) lookups for `node.run()` dispatch.
   */
  readonly nodeById: ReadonlyMap<NodeId, import("../types/node.js").NodeDef<unknown, unknown>>;
}
