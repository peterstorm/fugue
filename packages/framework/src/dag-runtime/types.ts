// DAG runtime types — FR-020
// DagPhase, DagEvent, DagMachineContext, HumanAction

import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { IncomingSources } from "./conditional.js";

// ---------------------------------------------------------------------------
// HumanAction — the payload a reviewer sends back
// ---------------------------------------------------------------------------

export type HumanAction =
  | { readonly action: "approve" }
  | { readonly action: "approve-with-edit"; readonly newOutput: unknown }
  | { readonly action: "reject"; readonly reason: string }
  | { readonly action: "reroute"; readonly targetNodeId: string };

// ---------------------------------------------------------------------------
// DagPhase — state of the DAG machine
// ---------------------------------------------------------------------------

export type DagPhase =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly wave: number }
  | {
      readonly kind: "awaiting-human";
      readonly nodeId: string;
      readonly output: unknown;
      readonly prompt: string;
      /** Remaining review queue: node ids to review after the current one (ascending order). */
      readonly pendingReviews: readonly string[];
      /** Wave index we paused on. */
      readonly wave: number;
    }
  | {
      readonly kind: "retrying";
      readonly wave: number;
      readonly nodeId: string;
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
      readonly nodeId: string;
      /** The node's already-produced output — preserved across hook retries. */
      readonly output: unknown;
      /** The original review prompt — preserved across hook retries. */
      readonly prompt: string;
      /** Hook retry attempt (1-based). */
      readonly attempt: number;
      /** Delay before next hook call. Executor applies jitter. */
      readonly nextDelayMs: number;
      /** Remaining reviews after this node — preserved from the original awaiting-human phase. */
      readonly pendingReviews: readonly string[];
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
  | { readonly type: "wave-done"; readonly wave: number; readonly outputs: ReadonlyMap<string, unknown> }
  | {
      readonly type: "node-failed";
      readonly nodeId: string;
      readonly error: FrameworkError;
      /**
       * Outputs from sibling nodes that completed successfully in the same wave before
       * this failure. Carried so the transition can persist them into `ctx.outputs` and
       * avoid re-running succeeded siblings on retry.
       */
      readonly partialOutputs?: ReadonlyMap<string, unknown>;
      /**
       * Additional node ids that also failed concurrently in the same wave.
       * The primary failure is `nodeId`; these are co-failed siblings.
       * Carried so `handleNodeFailed` can pre-increment their retry counters,
       * preventing off-by-one retry accounting when multiple nodes fail together.
       */
      readonly coFailedNodeIds?: ReadonlyArray<string>;
    }
  | { readonly type: "human-responded"; readonly nodeId: string; readonly action: HumanAction }
  | { readonly type: "abort"; readonly reason: string }
  | { readonly type: "ERROR"; readonly retriable: boolean; readonly error: string };

// ---------------------------------------------------------------------------
// DagMachineContext — immutable context threaded through the machine
// ---------------------------------------------------------------------------

export interface DagMachineContext {
  readonly dag: DagDef;
  readonly waves: readonly (readonly string[])[];
  readonly outputs: ReadonlyMap<string, unknown>;
  readonly retries: ReadonlyMap<string, number>;
  readonly initialInput: unknown;
  /**
   * Subset of node ids that should still run. Seeded at compile time to every
   * node forward-reachable from wave 0 along unconditional edges; expanded as
   * conditional/default edges fire after each wave. Pruned nodes never appear
   * in `outputs` and never get dispatched.
   */
  readonly activeNodeIds: ReadonlySet<string>;
  /**
   * Precomputed `{ required, optional }` source partition per node, derived
   * from the edges at compile time. Used by `runNode` to assemble `nodeInput`
   * without consulting any author-supplied `deps` field (which no longer
   * exists — edges are the single source of truth, see ADR 0017).
   */
  readonly incomingByNode: ReadonlyMap<string, IncomingSources>;
}
