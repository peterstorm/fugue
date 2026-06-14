/**
 * HITL run service (ADR-0060) — the durable-requeue engine, provider-agnostic.
 *
 *   startRun       — seed a run's checkpoint, persist it, enqueue it → returns runId
 *   processRun     — the worker handler: run/resume via the executor, fold the
 *                    outcome into the run's status (completed | suspended | failed)
 *   recordDecision — an approval: record the human's action, re-enqueue the run
 *   getRun         — fetch a run record (status poll)
 *
 * The service owns the run-store-backed `JobLike` and the `onHumanReview` hook;
 * the `RunExecutorPort` owns the framework call + NodeContext. Everything is
 * injected, so the whole park → notify → approve → resume → complete loop is
 * unit-testable against the real framework kernel with in-memory fakes.
 */

import { match } from "ts-pattern";
import type { DagId, RunId, NodeId, HumanAction, FrameworkError } from "@fuguejs/framework";
import { ok, err, EXECUTOR_NODE_ID } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { AuthIdentity } from "../domain/auth.js";
import type { LogPort } from "../ports.js";
import type {
  RunStorePort,
  RunQueuePort,
  DecisionStorePort,
  HumanReviewNotifierPort,
  RunExecutorPort,
} from "./ports.js";
import type { RunRecord } from "./types.js";
import { makeRunStoreJobLike } from "./run-store-job.js";
import { makeOnHumanReview, makeOnDecisionConsumed } from "./human-review-hook.js";
import { toPersistedIdentity } from "./identity.js";

export interface HitlRunServiceDeps {
  readonly runStore: RunStorePort;
  readonly runQueue: RunQueuePort;
  readonly decisions: DecisionStorePort;
  readonly notifier: HumanReviewNotifierPort;
  readonly executor: RunExecutorPort;
  readonly clock: () => number;
  readonly newRunId: () => RunId;
  readonly logger?: LogPort;
}

export interface HitlRunService {
  /** Seed + persist + enqueue a fresh HITL run. Returns its run id. */
  startRun(dagId: DagId, input: unknown, identity: AuthIdentity): Promise<Result<{ runId: RunId }, HostError>>;
  /** Worker handler: execute/resume `runId` and fold the outcome into its status. */
  processRun(runId: RunId): Promise<Result<void, HostError>>;
  /** Approval: record a human decision for a parked gate and re-enqueue the run. */
  recordDecision(runId: RunId, nodeId: NodeId, action: HumanAction): Promise<Result<void, HostError>>;
  /** Fetch a run record (status poll), or `ok(null)` if unknown. */
  getRun(runId: RunId): Promise<Result<RunRecord | null, HostError>>;
}

/** Map a host infra failure to a `FrameworkError` so it can settle a run's `failed` status. */
const asRunFailure = (hostError: HostError): FrameworkError => ({
  kind: "node-crash",
  retriability: "retriable",
  nodeId: EXECUTOR_NODE_ID,
  message: `host run execution failed: ${hostError.kind}`,
});

export const createHitlRunService = (deps: HitlRunServiceDeps): HitlRunService => {
  const { runStore, runQueue, decisions, notifier, executor, clock, newRunId, logger } = deps;

  const startRun = async (
    dagId: DagId,
    input: unknown,
    identity: AuthIdentity,
  ): Promise<Result<{ runId: RunId }, HostError>> => {
    const seeded = await executor.seedCheckpoint(dagId, input);
    if (!seeded.ok) return seeded;

    const runId = newRunId();
    const now = clock();
    const record: RunRecord = {
      runId,
      dagId,
      input,
      identity: toPersistedIdentity(identity),
      status: { kind: "queued" },
      checkpoint: seeded.value,
      createdAtMs: now,
      updatedAtMs: now,
    };

    const created = await runStore.create(record);
    if (!created.ok) return created;

    const enqueued = await runQueue.enqueue(runId);
    if (!enqueued.ok) return enqueued;

    return ok({ runId });
  };

  const processRun = async (runId: RunId): Promise<Result<void, HostError>> => {
    const fetched = await runStore.get(runId);
    if (!fetched.ok) return fetched;
    const record = fetched.value;
    if (record === null) {
      // Nothing to process — a stale enqueue (run deleted/expired). Not an error.
      logger?.warn?.("hitl: processRun for unknown run — ignoring", { runId });
      return ok(undefined);
    }

    // Terminal runs are never re-processed (a double-enqueue after completion).
    if (record.status.kind === "completed" || record.status.kind === "failed") {
      logger?.warn?.("hitl: processRun for terminal run — ignoring", {
        runId,
        status: record.status.kind,
      });
      return ok(undefined);
    }

    // Best-effort transition to `running`. A failed write here does not stop
    // execution (the run is already being processed and the eventual settle
    // write is checked); we surface it so a status poll reporting a stale
    // `queued`/`suspended` during the slice is explainable, rather than silent.
    const marked = await runStore.setStatus(runId, { kind: "running" });
    if (!marked.ok) {
      logger?.warn?.("hitl: failed to mark run running — proceeding best-effort", {
        runId,
        error: marked.error.kind,
      });
    }

    const jobLikeResult = makeRunStoreJobLike(runStore, runId, record.checkpoint);
    if (!jobLikeResult.ok) {
      // A corrupt checkpoint will not heal on retry — settle the run `failed`
      // (terminal) so a status poll surfaces it, and return `ok` so the worker
      // does NOT re-process (a retry would only hit the same corrupt state).
      logger?.error?.("hitl: corrupt checkpoint — settling run failed", {
        runId,
        error: jobLikeResult.error.kind,
      });
      const settled = await runStore.setStatus(runId, { kind: "failed", error: asRunFailure(jobLikeResult.error) });
      if (!settled.ok) return settled;
      return ok(undefined);
    }
    const jobLike = jobLikeResult.value;
    const onHumanReview = makeOnHumanReview({
      decisions,
      notifier,
      runId,
      dagId: record.dagId,
      logger,
    });
    // ADR-0060: decision consumption is deferred to AFTER the post-gate
    // checkpoint is durable (the kernel calls this once the resuming transition
    // is persisted), so a crash mid-resume re-reads the decision instead of
    // losing the approval. The read (onHumanReview) and the consume (here) are
    // deliberately split across the durability boundary.
    const onDecisionConsumed = makeOnDecisionConsumed({ decisions, runId, logger });

    const result = await executor.run({
      runId,
      dagId: record.dagId,
      input: record.input,
      identity: record.identity,
      jobLike,
      onHumanReview,
      onDecisionConsumed,
    });

    if (!result.ok) {
      // Host infra failure (unknown DAG, context build) — settle the run failed
      // so a status poll surfaces it rather than leaving it stuck "running".
      // The run has reached a durable terminal state, so the worker job is DONE:
      // return `ok` (no queue retry — a retry would only no-op on the terminal
      // guard above). Pre-settle transient failures (e.g. the `runStore.get`
      // above) return `err` and ARE retried by the worker.
      const settled = await runStore.setStatus(runId, { kind: "failed", error: asRunFailure(result.error) });
      if (!settled.ok) {
        // Could not even record the failure — leave it to the queue to retry.
        logger?.error?.("hitl: failed to settle run failed", { runId, error: settled.error.kind });
        return settled;
      }
      return ok(undefined);
    }

    return match(result.value)
      .with({ kind: "completed" }, (o) =>
        runStore.setStatus(runId, { kind: "completed", output: o.output }))
      // The checkpoint was already persisted by the job handle on suspend; record
      // the gate so a status poll / Teams card can render the prompt.
      .with({ kind: "suspended" }, (o) =>
        runStore.setStatus(runId, { kind: "suspended", nodeId: o.nodeId, prompt: o.prompt }))
      .with({ kind: "failed" }, (o) =>
        runStore.setStatus(runId, { kind: "failed", error: o.error }))
      .exhaustive();
  };

  const recordDecision = async (
    runId: RunId,
    nodeId: NodeId,
    action: HumanAction,
  ): Promise<Result<void, HostError>> => {
    const fetched = await runStore.get(runId);
    if (!fetched.ok) return fetched;
    const record = fetched.value;
    if (record === null) {
      return err({ kind: "run-not-found", runId });
    }

    // Engine-level invariant: a decision can only resolve the gate the run is
    // CURRENTLY parked at. The authority is the decision store's pending marker,
    // NOT the run-store status: the hook writes the marker (markPending) BEFORE
    // it sends the notification and clears it when the gate resolves, so it is
    // present for the whole window a reviewer could respond — including the brief
    // slice after the notification is delivered but before the worker has folded
    // the `suspended` status back into the run store (`processRun` sets `running`,
    // runs the executor — which notifies — and only then writes `suspended`).
    // Gating on the lagging status field would 409-drop an approval that lands in
    // that window and permanently strand the decided run. The marker absence also
    // covers the cases the status check did: a never-parked (`queued`) run and a
    // stale gate the run already advanced past (its marker was cleared on resolve).
    const pending = await decisions.isPending(runId, nodeId);
    if (!pending.ok) return pending;
    if (!pending.value) {
      const status = record.status.kind === "suspended" && record.status.nodeId !== nodeId
        ? `suspended at a different gate (${record.status.nodeId})`
        : record.status.kind;
      return err({ kind: "run-not-suspended", runId, status });
    }

    const stored = await decisions.putDecision(runId, nodeId, action);
    if (!stored.ok) return stored;

    const enqueued = await runQueue.enqueue(runId);
    if (!enqueued.ok) {
      // The decision is now durably stored but the run was not re-enqueued to
      // act on it. Recoverable (a retried approval re-enqueues; the decision
      // TTL outlives the run), but surface the half-completed approval so the
      // decided-but-not-woken run is diagnosable rather than silently stuck.
      logger?.error?.("hitl: decision stored but resume enqueue failed — run not woken", {
        runId,
        nodeId,
        error: enqueued.error.kind,
      });
      return enqueued;
    }
    return ok(undefined);
  };

  const getRun = (runId: RunId): Promise<Result<RunRecord | null, HostError>> => runStore.get(runId);

  return { startRun, processRun, recordDecision, getRun };
};
