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
import { ok, err } from "@fuguejs/framework";
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
import { makeOnHumanReview } from "./human-review-hook.js";
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
  nodeId: "__executor__" as NodeId,
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

    await runStore.setStatus(runId, { kind: "running" });

    const jobLike = makeRunStoreJobLike(runStore, runId, record.checkpoint);
    const onHumanReview = makeOnHumanReview({
      decisions,
      notifier,
      runId,
      dagId: record.dagId,
      logger,
    });

    const result = await executor.run({
      runId,
      dagId: record.dagId,
      input: record.input,
      identity: record.identity,
      jobLike,
      onHumanReview,
    });

    if (!result.ok) {
      // Host infra failure (unknown DAG, context build) — settle the run failed
      // so a status poll surfaces it rather than leaving it stuck "running".
      await runStore.setStatus(runId, { kind: "failed", error: asRunFailure(result.error) });
      return result;
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
    if (fetched.value === null) {
      return err({ kind: "run-not-found", runId });
    }

    const stored = await decisions.putDecision(runId, nodeId, action);
    if (!stored.ok) return stored;

    return runQueue.enqueue(runId);
  };

  const getRun = (runId: RunId): Promise<Result<RunRecord | null, HostError>> => runStore.get(runId);

  return { startRun, processRun, recordDecision, getRun };
};
