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

import { ok, err } from "@fuguejs/framework";
import type { DagId, RunId, NodeId, FrameworkError, NonEmptyString, Result } from "@fuguejs/framework";

/**
 * The serializable projection of an `AuthIdentity` persisted on a run. The live
 * `user` identity carries a `canRunDag` CLOSURE (the authorization policy) that
 * cannot survive JSON — and the worker never authorizes (a run is authorized
 * once, at submission/approval, at the HTTP boundary). So we persist only the
 * execution-relevant fields; the worker reconstructs the `AuthIdentity` it needs
 * to derive the run `origin` (which uses `sub`/`kind`, never `canRunDag`).
 *
 * `team` is a plain `string`, NOT the branded `Team`: the brand is deliberately
 * ERASED at this JSON persistence boundary and RESTORED via `markTeam` on the way
 * back (`identity.ts` `toExecIdentity`). Do not "fix" it to `Team` — the brand is
 * a phantom property that cannot round-trip through JSON.
 */
export type PersistedIdentity =
  | { readonly kind: "admin" }
  | { readonly kind: "team"; readonly team: string; readonly label: string }
  | { readonly kind: "user"; readonly sub: string; readonly azp: string };

/** A finite millisecond timestamp accepted by the HITL persistence parser. */
declare const runTimestampMsBrand: unique symbol;
export type RunTimestampMs = number & { readonly [runTimestampMsBrand]: "RunTimestampMs" };

/** Parse an untrusted clock reading into the timestamp domain. */
export const tryRunTimestampMs = (value: unknown): Result<RunTimestampMs, string> =>
  typeof value === "number" && Number.isFinite(value)
    ? ok(value as RunTimestampMs)
    : err("expected a finite number");

/**
 * A run's lifecycle status (an ADT — illegal combinations are unrepresentable).
 * `suspended` carries the gate the run is parked at so a status poll / Teams
 * card can render the prompt; `completed`/`failed` carry the settled result.
 *
 * Note: unlike `DagPhase.suspended` / `RunExecOutcome.suspended`, `suspended`
 * here deliberately does NOT carry the `output` under review — a generic status
 * poll must not re-expose it. The output reaches a reviewer once, via the
 * `ReviewNotification` the notifier delivers when the run first parks.
 */
export type RunStatus =
  | { readonly kind: "queued" }
  | { readonly kind: "running" }
  | { readonly kind: "suspended"; readonly nodeId: NodeId; readonly prompt: NonEmptyString }
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
  readonly identity: PersistedIdentity;
  readonly status: RunStatus;
  /** Serialized `{state, context}` checkpoint (framework `toJson`). */
  readonly checkpoint: string;
  readonly createdAtMs: RunTimestampMs;
  readonly updatedAtMs: RunTimestampMs;
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
