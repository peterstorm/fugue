// DAG runtime types
// DagPhase, DagEvent, DagMachineContext, HumanAction

import type { DagDef, EdgeDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { Decision, IncomingSources } from "./conditional.js";
import type { NodeId } from "../types/ids.js";
import { __brandNodeId } from "../types/ids.js";

/**
 * Sentinel node id used by the executor/runner when an ERROR event arrives
 * that cannot be attributed to a specific node. Branded via `__brandNodeId`
 * so it satisfies the `NodeId` type. The `__executor__` value is already
 * used in `run-dag-stateful.ts` for the same purpose.
 */
export const EXECUTOR_NODE_ID = __brandNodeId("__executor__");

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
       * Optional for forward-compatibility with hand-crafted wave-done events
       * (e.g. event-log replay paths); when omitted the transition falls
       * back to inline `decideRoute` calls.
       */
      readonly routingDecisions?: ReadonlyMap<NodeId, Decision>;
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
  | { readonly type: "human-responded"; readonly nodeId: NodeId; readonly action: HumanAction }
  | { readonly type: "abort"; readonly reason: string }
  | { readonly type: "executor-error"; readonly retriable: boolean; readonly error: string };

// ---------------------------------------------------------------------------
// DagMachineContextPersisted — the plain-data subset safe for serialization.
// Does NOT contain closures (run functions, Zod schemas, predicate functions).
// `DagMachineContext` extends this with live DAG-derived fields.
// ---------------------------------------------------------------------------

export interface DagMachineContextPersisted {
  readonly waves: readonly (readonly NodeId[])[];
  readonly outputs: ReadonlyMap<NodeId, unknown>;
  readonly retries: ReadonlyMap<NodeId, number>;
  readonly initialInput: unknown;
  /**
   * Subset of node ids that should still run. Seeded at compile time to every
   * node forward-reachable from wave 0 along unconditional edges; expanded as
   * conditional/default edges fire after each wave. Pruned nodes never appear
   * in `outputs` and never get dispatched.
   */
  readonly activeNodeIds: ReadonlySet<NodeId>;
  /**
   * Per-node retry configuration (plain data, serializable). Populated at
   * compile time from `NodeDef.retry`. Used by `retry-policy.ts` so the
   * pure transition layer never reaches into live `NodeDef` objects.
   */
  readonly retryConfigs: ReadonlyMap<NodeId, { readonly backoffMs: readonly number[]; readonly jitterRatio: number }>;
  /**
   * Plain-data fields extracted from DagDef at compile time for the pure
   * transition layer. These replace direct `ctx.dag` access — preventing
   * the transition from accidentally capturing live closures.
   */
  readonly outputNodeId: NodeId | undefined;
  readonly defaultRetryLimit: number | undefined;
  readonly retryLimits: Readonly<Record<string, number>> | undefined;
  /** Node IDs that declare human review (data only — no closures). */
  readonly humanReviewNodeIds: ReadonlySet<NodeId>;
  /** Human review prompts by node ID (plain data, extracted at compile time). */
  readonly humanReviewPrompts: ReadonlyMap<NodeId, string>;
  /** Edges (data only — predicates are never called by the transition layer). */
  readonly edges: readonly EdgeDef[];
}

// ---------------------------------------------------------------------------
// DagMachineContext — full runtime context with live DAG-derived fields.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DagTransitionContext — the subset visible to the PURE transition layer.
// Contains persisted state + precomputed maps. Does NOT contain `dag` (which
// carries NodeDef.run closures) or `nodeById` (same closures). This type
// boundary prevents the transition from accidentally serializing live closures.
// ---------------------------------------------------------------------------

export interface DagTransitionContext extends DagMachineContextPersisted {
  /**
   * Precomputed adjacency: `nodeId → out-edges`. Built once at compile time so
   * routing decisions don't pay an O(edges) linear scan each call.
   */
  readonly outgoingByNode: ReadonlyMap<NodeId, readonly EdgeDef[]>;
}

// ---------------------------------------------------------------------------
// DagMachineContext — full runtime context with live DAG-derived fields.
// Used by the executor (imperative shell) which needs `nodeById` for `run()`.
// ---------------------------------------------------------------------------

export interface DagMachineContext extends DagTransitionContext {
  readonly dag: DagDef;
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
