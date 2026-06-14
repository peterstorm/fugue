/**
 * HITL ports (ADR-0060) — the boundary contracts the durable-requeue run engine
 * is built against. Every port returns `Result<T, HostError>` so failure is
 * explicit at the type level; each has a Redis/BullMQ production adapter and an
 * in-memory fake for tests. Keeping the engine port-driven is what lets the
 * full park → notify → approve → resume → complete loop be unit-tested with no
 * Redis, no BullMQ, and no real Teams.
 */

import type {
  DagId,
  RunId,
  NodeId,
  HumanAction,
  HumanReviewOutcome,
  FrameworkError,
  JobLike,
  DagPhase,
  DagMachineContextPersisted,
} from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { RunRecord, RunStatus, PersistedIdentity } from "./types.js";

/**
 * Durable persistence for runs. `checkpoint` is updated on every state-machine
 * transition (via the run-store-backed `JobLike`), so a worker crash resumes
 * from the last persisted state.
 */
export interface RunStorePort {
  /** Create a fresh run record. Errs if the run id already exists. */
  create(record: RunRecord): Promise<Result<void, HostError>>;
  /** Fetch a run, or `ok(null)` if unknown. */
  get(runId: RunId): Promise<Result<RunRecord | null, HostError>>;
  /** Persist the serialized `{state, context}` checkpoint (per-transition). */
  saveCheckpoint(runId: RunId, checkpoint: string): Promise<Result<void, HostError>>;
  /** Update the run's lifecycle status. */
  setStatus(runId: RunId, status: RunStatus): Promise<Result<void, HostError>>;
}

/**
 * The wake-up trigger. `enqueue` schedules a worker to (re)process a run. It is
 * intentionally NON-idempotent — each call creates a fresh queue job (no `jobId`
 * dedup) so a resume re-enqueue is never silently dropped. Safety against running
 * the same parked run twice concurrently comes from the single-flight Redis lock
 * the worker takes around `processRun` (see `run-queue.ts#startWorker`), NOT from
 * enqueue dedup. The durable state lives in the `RunStorePort`, NOT in the queue
 * payload — the queue only carries the id.
 */
export interface RunQueuePort {
  enqueue(runId: RunId): Promise<Result<void, HostError>>;
}

/**
 * Delivers a "please review" notification when a run parks at a human gate. The
 * Teams adapters (webhook smoke-test transport, then Bot Framework cards)
 * implement this; the engine never imports a concrete transport.
 */
export interface HumanReviewNotifierPort {
  notify(notification: import("./types.js").ReviewNotification): Promise<Result<void, HostError>>;
}

/**
 * Records and resolves the human's decision for a parked review, keyed by
 * `(runId, nodeId)`. The `onHumanReview` hook reads it on each (re)dispatch:
 * a decision present resolves the gate; its absence parks the run. `markPending`
 * returns `true` only on the FIRST park for a gate, so a resume-then-re-park
 * loop never re-sends the notification.
 */
export interface DecisionStorePort {
  /** Mark a gate as pending review. Returns `true` if newly created (dedups notifications). */
  markPending(runId: RunId, nodeId: NodeId): Promise<Result<boolean, HostError>>;
  /**
   * Is `(runId, nodeId)` currently the gate the run is parked at? The marker is
   * written by the hook BEFORE it notifies and cleared when the gate resolves,
   * so it is the authoritative "parked here right now" signal — present for the
   * whole window a reviewer could respond, including the brief slice after the
   * notification is delivered but before the worker has folded the `suspended`
   * status back into the run store. Gating an approval on this (not the lagging
   * run status) is what stops a fast approval being dropped and stranding the run.
   */
  isPending(runId: RunId, nodeId: NodeId): Promise<Result<boolean, HostError>>;
  /** Record the human's decision for a parked gate. */
  putDecision(runId: RunId, nodeId: NodeId, action: HumanAction): Promise<Result<void, HostError>>;
  /** Fetch a recorded decision, or `ok(null)` if none yet. */
  getDecision(runId: RunId, nodeId: NodeId): Promise<Result<HumanAction | null, HostError>>;
  /** Remove the pending marker and any decision for a gate (after it resolves). */
  clear(runId: RunId, nodeId: NodeId): Promise<Result<void, HostError>>;
}

/**
 * The outcome of executing (or resuming) a run: a settled result the service
 * folds into a `RunStatus`. `failed` carries the framework error so a status
 * poll surfaces the real cause; a transient infra failure to even start
 * executing is the `err` channel of the enclosing `Result`.
 */
export type RunExecOutcome =
  | { readonly kind: "completed"; readonly output: unknown }
  | { readonly kind: "suspended"; readonly nodeId: NodeId; readonly prompt: string }
  | { readonly kind: "failed"; readonly error: FrameworkError };

/** Inputs the executor needs to run/resume one run. */
export interface RunExecutionRequest {
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly input: unknown;
  readonly identity: PersistedIdentity;
  /** Run-store-backed durable job handle (carries + persists the checkpoint). */
  readonly jobLike: JobLike<DagPhase, unknown, DagMachineContextPersisted>;
  /** The host's review hook (decision-store + notifier closure). Read-only: it
   * resolves a gate by READING the recorded decision; it does NOT consume it. */
  readonly onHumanReview: (req: {
    nodeId: NodeId;
    output: unknown;
    prompt: string;
  }) => Promise<HumanReviewOutcome>;
  /**
   * ADR-0060: consume a decision AFTER the post-gate checkpoint is durable.
   * Called by the kernel (via `onDecisionConsumed`) with the resolved gate's
   * `nodeId` once the transition driven by that decision has been persisted, so
   * the decision is cleared only when a crash can no longer lose it. Splitting
   * read (`onHumanReview`) from consume (this) is what makes the resume
   * effectively-once: a crash between reading and the durable checkpoint
   * re-reads the same decision instead of dropping the approval.
   */
  readonly onDecisionConsumed: (nodeId: NodeId) => Promise<void>;
}

/**
 * Bridges the HITL service to the framework runtime + host NodeContext. Kept a
 * port so the service is testable against the REAL `runResumableDagJob` with a
 * lightweight test context, while production wires `createNodeContextForDag` +
 * the registry + the capability broker.
 */
export interface RunExecutorPort {
  /**
   * Compile a DAG and serialize its initial `{state, context}` envelope — the
   * checkpoint a fresh run starts from. Errs if the DAG is unknown/invalid.
   */
  seedCheckpoint(dagId: DagId, input: unknown): Promise<Result<string, HostError>>;
  /**
   * Run or resume a DAG through the framework's resumable kernel. Never throws:
   * a framework run-failure is mapped onto the `failed` outcome; only a host
   * infra failure (unknown DAG, context build) uses the `err` channel.
   */
  run(req: RunExecutionRequest): Promise<Result<RunExecOutcome, HostError>>;
}
