/**
 * HITL run types (ADR-0060). The host runs human-in-the-loop DAGs through a
 * durable queue: `POST /dags/:id/run` enqueues a run and returns `202 + runId`;
 * a worker executes it via the framework's resumable kernel; when a node's
 * `humanReview` gate has no decision yet the run PARKS (`suspended`) and the
 * worker is freed; an approval (e.g. a Teams card action) re-enqueues the run to
 * resume from the durably-persisted checkpoint.
 *
 * These types are the host-side shape of "a parked-or-progressing run": its
 * lifecycle status, the persisted record, and the notification a reviewer sees.
 */

import type { DagId, RunId, NodeId, FrameworkError } from "@fuguejs/framework";
import type { AuthIdentity } from "../domain/auth.js";

/**
 * A run's lifecycle status (an ADT — illegal combinations are unrepresentable).
 * `suspended` carries the gate the run is parked at so a status poll / Teams
 * card can render the prompt; `completed`/`failed` carry the settled result.
 */
export type RunStatus =
  | { readonly kind: "queued" }
  | { readonly kind: "running" }
  | { readonly kind: "suspended"; readonly nodeId: NodeId; readonly prompt: string }
  | { readonly kind: "completed"; readonly output: unknown }
  | { readonly kind: "failed"; readonly error: FrameworkError };

/**
 * The durable record of a run. `checkpoint` is the framework's serialized
 * `{state, context}` envelope (via `toJson`) — the single source of truth for
 * resume, independent of any queue backend's job retention. `identity` is
 * persisted so a worker resuming the run on a fresh process can rebuild the
 * NodeContext and `origin` exactly as the initiating request would have.
 */
export interface RunRecord {
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly input: unknown;
  readonly identity: AuthIdentity;
  readonly status: RunStatus;
  /** Serialized `{state, context}` checkpoint (framework `toJson`). */
  readonly checkpoint: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * What a reviewer is shown when a run parks at a human gate. The notifier
 * adapter (Teams webhook / Bot Framework / …) turns this into a message; the
 * `runId`/`nodeId` are what an approval posts back to resume the run.
 */
export interface ReviewNotification {
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
  readonly prompt: string;
  readonly output: unknown;
}
