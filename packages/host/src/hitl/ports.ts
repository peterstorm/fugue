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
  NonEmptyString,
} from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { QueuedRunRecord, RunMetadata, RunRecord, RunStatusUpdate, PersistedIdentity } from "./types.js";

const RUN_LEASE: unique symbol = Symbol("RunLease");

/**
 * Runtime-authenticated capability proving which queue worker owns a run's live
 * Redis lease. The random owner token is deliberately absent from the value:
 * only the adapter-internal WeakMap can recover it, so an aborted holder cannot
 * copy the token into a fresh signal and reissue its authority. The WeakMap is
 * also the runtime proof that an assertion-forged shape was never issued.
 */
export type RunLease = Readonly<{
  runId: RunId;
  signal: AbortSignal;
  [RUN_LEASE]: true;
}>;

export type RunLeaseIssuer = Readonly<{
  issue: (runId: RunId, ownerToken: string, signal: AbortSignal) => RunLease;
}>;

export type RunLeaseVerifier = Readonly<{
  ownerToken: (lease: RunLease) => string | null;
}>;

/** Issuance and verification capabilities backed by one private proof registry. */
export type RunLeaseAuthority = Readonly<{
  issuer: RunLeaseIssuer;
  verifier: RunLeaseVerifier;
}>;

/**
 * Create one lease authority for a host composition. Queue code receives only
 * `issuer`; stores receive only `verifier`. A different authority cannot project
 * or reissue an existing lease because its WeakMap has never seen that value.
 */
export const createRunLeaseAuthority = (): RunLeaseAuthority => {
  const owners = new WeakMap<object, string>();
  const issue: RunLeaseIssuer["issue"] = (runId, ownerToken, signal) => {
    if (ownerToken.length === 0) {
      throw new RangeError("RunLease owner token must be non-empty");
    }
    const lease: RunLease = Object.freeze({
      runId,
      signal,
      [RUN_LEASE]: true as const,
    });
    owners.set(lease, ownerToken);
    return lease;
  };
  return Object.freeze({
    issuer: Object.freeze({ issue }),
    verifier: Object.freeze({
      ownerToken: (lease: RunLease) =>
        lease.signal.aborted ? null : owners.get(lease) ?? null,
    }),
  });
};

/**
 * Durable persistence for runs. `checkpoint` is updated on every state-machine
 * transition (via the run-store-backed `JobLike`), so a worker crash resumes
 * from the last persisted state.
 */
export type RunCreationOutcome =
  | { readonly kind: "created" }
  | { readonly kind: "publication-uncertain" };

export interface RunStorePort {
  /**
   * Create a fresh run record and join the active index. Publication uncertainty
   * is an accepted outcome, never an Err: Redis may have committed metadata even
   * when its acknowledgement was lost, and reconciliation must remain allowed to
   * discover that run.
   */
  create(record: QueuedRunRecord): Promise<Result<RunCreationOutcome, HostError>>;
  /** Fetch a complete execution record, requiring checkpoint bytes. */
  get(runId: RunId): Promise<Result<RunRecord | null, HostError>>;
  /** Fetch lifecycle/auth metadata without coupling status reads to checkpoint availability. */
  getMetadata(runId: RunId): Promise<Result<RunMetadata | null, HostError>>;
  /** Persist a checkpoint only while this worker still owns the run lease. */
  saveCheckpoint(lease: RunLease, checkpoint: string): Promise<Result<void, HostError>>;
  /**
   * Update the run's lifecycle status only while `lease` is still owned. A
   * TERMINAL status (`completed`/`failed`)
   * also removes the run from the per-tenant active-run index (ADR-0074); a
   * non-terminal status leaves the index untouched.
   */
  setStatus(lease: RunLease, status: RunStatusUpdate): Promise<Result<void, HostError>>;
  /**
   * Count this tenant's NON-terminal (queued / running / suspended) runs — the
   * `maxQueuedRuns` admission axis (ADR-0074). Read from the per-tenant active-run
   * index SET (`fugue:<tenant>:hitl:active`) via `sMembers`, NOT `scan` (which the
   * per-tenant ACL denies, ADR-0067). SELF-HEALING: a member whose run record no
   * longer exists (TTL-expired / hard-deleted) is pruned when possible.
   * Successfully pruned missing/terminal members are excluded; checkpoint-only
   * publication remnants, corrupt metadata, and members whose pruning fails are
   * counted conservatively to avoid under-admission. Bounded O(N) in the set size (which
   * `maxQueuedRuns` itself bounds).
   */
  countActiveRuns(): Promise<Result<number, HostError>>;
  /**
   * Enumerate every recoverable NON-terminal run id for server-owned wakeup
   * reconciliation. This includes published metadata, valid creation intents,
   * and corrupt-metadata members so reconciliation can inspect and report them;
   * raw checkpoint-only remnants remain omitted. The active index is the only
   * tenant-safe enumeration source (Redis SCAN is denied); stale/terminal
   * members are self-healed.
   */
  listActiveRunIds(): Promise<Result<readonly RunId[], HostError>>;
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
 * `(runId, nodeId)`. The pending marker carries durable notification-delivery
 * state, so a failed first delivery remains retriable while a delivered review
 * is deduplicated across ordinary re-parks.
 */
export type PendingReview =
  | { readonly kind: "notification-required"; readonly marker: string }
  | { readonly kind: "notified" };

export type DecisionResolution =
  | { readonly kind: "accepted" }
  | { readonly kind: "already-resolved" }
  | { readonly kind: "not-pending" };

export interface DecisionStorePort {
  /** Create/read the durable pending + notification-delivery state for a gate. */
  preparePending(runId: RunId, nodeId: NodeId): Promise<Result<PendingReview, HostError>>;
  /** Atomically mark the matching pending marker notified after delivery succeeds. */
  markNotified(runId: RunId, nodeId: NodeId, marker: string): Promise<Result<boolean, HostError>>;
  /**
   * Resolve a pending gate with first-writer-wins semantics. `accepted` means
   * this action won the atomic create; `already-resolved` preserves the winner;
   * `not-pending` means this gate cannot currently accept a decision.
   */
  resolvePending(
    runId: RunId,
    nodeId: NodeId,
    action: HumanAction,
  ): Promise<Result<DecisionResolution, HostError>>;
  /** Fetch a recorded decision, or `ok(null)` if none yet. */
  getDecision(runId: RunId, nodeId: NodeId): Promise<Result<HumanAction | null, HostError>>;
  /** Remove the pending marker and any decision for a gate (after it resolves). */
  clear(runId: RunId, nodeId: NodeId): Promise<Result<void, HostError>>;
}

/**
 * The outcome of executing (or resuming) a run: a settled result the service
 * folds into a `RunStatus`. `failed` carries the framework error so a status
 * poll surfaces the real cause. Host failures before an authoritative run
 * outcome exists use the enclosing `Result`'s `err` channel for queue retry;
 * post-transition checkpoint failures become terminal `failed` outcomes because
 * replaying the prior checkpoint could duplicate already-completed side effects.
 */
export type RunExecOutcome =
  | { readonly kind: "completed"; readonly output: unknown }
  | { readonly kind: "suspended"; readonly nodeId: NodeId; readonly prompt: NonEmptyString }
  | { readonly kind: "failed"; readonly error: FrameworkError };

/** Durable JobLike paired with the typed failure channel for its writes. */
export interface RunExecutionJob {
  readonly jobLike: JobLike<DagPhase, unknown, DagMachineContextPersisted>;
  readonly checkpointFailure: () => HostError | null;
}

/** Inputs the executor needs to run/resume one run. */
export interface RunExecutionRequest {
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly input: unknown;
  readonly identity: PersistedIdentity;
  /** Aborted immediately when queue lease ownership can no longer be trusted. */
  readonly signal: AbortSignal;
  /** Run-store-backed durable job handle and its typed write-failure channel. */
  readonly job: RunExecutionJob;
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
   * permanent run failures — including context-build faults after the slice
   * begins and a DAG removed after durable acceptance — map onto the `failed`
   * outcome. The `err` channel carries pre-outcome host failures that require
   * queue retry; post-transition checkpoint I/O failures are terminalized as a
   * `failed` outcome to prevent unsafe replay.
   */
  run(req: RunExecutionRequest): Promise<Result<RunExecOutcome, HostError>>;
}
