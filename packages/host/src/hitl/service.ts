/**
 * HITL run service (ADR-0060) — the durable-requeue engine, provider-agnostic.
 *
 *   startRun       — seed + persist a run, attempt its direct wakeup, return runId;
 *                    reconciliation retries failed wakeups
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
import { formatHostError, tenantOverQuota } from "../domain/host-error.js";
import type { TenantId } from "../domain/tenant.js";
import type { AuthIdentity, Team } from "../domain/auth.js";
import type { LogPort } from "../ports.js";
import type {
  RunStorePort,
  RunQueuePort,
  DecisionStorePort,
  HumanReviewNotifierPort,
  RunExecutorPort,
  RunLease,
} from "./ports.js";
import { tryRunTimestampMs } from "./types.js";
import type { QueuedRunRecord, RunMetadata, RunTimestampMs } from "./types.js";
import { makeRunStoreJobLike } from "./run-store-job.js";
import { makeOnHumanReview, makeOnDecisionConsumed } from "./human-review-hook.js";
import { toPersistedIdentity } from "./identity.js";
import { logWithoutThrowing } from "./diagnostic-logging.js";

interface HitlRunServiceDeps {
  readonly runStore: RunStorePort;
  readonly runQueue: RunQueuePort;
  readonly decisions: DecisionStorePort;
  readonly notifier: HumanReviewNotifierPort;
  readonly executor: RunExecutorPort;
  readonly clock: () => number;
  readonly newRunId: () => RunId;
  /**
   * The worker's resolved tenant (ADR-0074). Names the `tenant-over-quota` error
   * the `maxQueuedRuns` gate returns — its OWN tenant, so no cross-tenant leak.
   */
  readonly tenant: TenantId;
  /**
   * Per-tenant ceiling on outstanding (non-terminal) HITL runs (ADR-0074,
   * `admission.maxQueuedRuns`). `startRun` refuses with `tenant-over-quota` (429)
   * when the active-run count is already at this limit. UNSET → unlimited
   * (backwards compatible: the single-tenant path and pre-field workers don't gate).
   */
  readonly maxQueuedRuns?: number;
  /** Retry-After (seconds) advertised on the `tenant-over-quota` refusal. Default 5. */
  readonly retryAfterSeconds?: number;
  readonly logger?: LogPort;
}

export type ReconciliationAttempt =
  | { readonly kind: "woken"; readonly runId: RunId }
  | { readonly kind: "wakeup-failed"; readonly runId: RunId; readonly error: HostError }
  | { readonly kind: "inspection-failed"; readonly runId: RunId; readonly error: HostError };

export interface HitlRunService {
  /** Seed + persist a fresh run and request its initial wakeup. */
  startRun(dagId: DagId, ownerTeam: Team, input: unknown, identity: AuthIdentity): Promise<Result<{ runId: RunId }, HostError>>;
  /** Worker handler: execute/resume `runId` and fold the outcome into its status. */
  processRun(lease: RunLease): Promise<Result<void, HostError>>;
  /** Approval: atomically resolve a parked gate and request a resume wakeup. */
  recordDecision(runId: RunId, nodeId: NodeId, action: HumanAction): Promise<Result<void, HostError>>;
  /** Idempotently wake queued/running runs and suspended runs with a durable decision. */
  reconcileActiveRuns(): Promise<Result<readonly ReconciliationAttempt[], HostError>>;
  /** Fetch a run record (status poll), or `ok(null)` if unknown. */
  getRun(runId: RunId): Promise<Result<RunMetadata | null, HostError>>;
}

/** Map a host infra failure to a `FrameworkError` so it can settle a run's `failed` status. */
const asRunFailure = (hostError: HostError): FrameworkError => ({
  kind: "node-crash",
  retriability: "retriable",
  nodeId: EXECUTOR_NODE_ID,
  message: `host run execution failed: ${hostError.kind}`,
});

const isTerminalRunStatus = (status: RunMetadata["status"]): boolean =>
  status.kind === "completed" || status.kind === "failed";

/** Clock adapters are untrusted I/O seams; keep both throws and bad values typed. */
const readRunTimestamp = (clock: () => number): Result<RunTimestampMs, HostError> => {
  try {
    const timestamp = tryRunTimestampMs(clock());
    return timestamp.ok
      ? timestamp
      : err({
          kind: "internal-invariant-violated",
          message: `HITL clock returned an invalid timestamp: ${timestamp.error}`,
          context: {},
        });
  } catch {
    return err({
      kind: "internal-invariant-violated",
      message: "HITL clock threw outside its port contract",
      context: {},
    });
  }
};

export const createHitlRunService = (deps: HitlRunServiceDeps): HitlRunService => {
  const { runStore, runQueue, decisions, notifier, executor, clock, newRunId, tenant, maxQueuedRuns, logger } = deps;
  const retryAfterSeconds = deps.retryAfterSeconds ?? 5;

  /**
   * Request the low-latency wakeup after durable acceptance. Failure is
   * intentionally non-fatal: lifecycle reconciliation owns eventual delivery.
   */
  const requestDirectWakeup = async (
    runId: RunId,
    failureMessage: string,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    const enqueued = await runQueue.enqueue(runId);
    if (enqueued.ok) return;
    logWithoutThrowing(logger, "error", failureMessage, {
      runId,
      ...context,
      error: enqueued.error.kind,
      message: formatHostError(enqueued.error),
    });
  };

  const startRun = async (
    dagId: DagId,
    ownerTeam: Team,
    input: unknown,
    identity: AuthIdentity,
  ): Promise<Result<{ runId: RunId }, HostError>> => {
    const seeded = await executor.seedCheckpoint(dagId, input);
    if (!seeded.ok) return seeded;

    // QUEUE-DEPTH ADMISSION (ADR-0074, FR-032/SC-011 for the durable path): a HITL
    // run returns 202 and continues durably, so the supervisor's request-scoped
    // `maxConcurrentRuns` slot cannot bound it. Gate the per-tenant count of
    // outstanding (non-terminal) runs here, AFTER the DAG is validated (so an
    // unknown DAG still 404s) and BEFORE the run is created (so a refused run
    // consumes no slot). Refuse with the tenant's OWN `tenant-over-quota` (429 +
    // Retry-After). UNSET limit → unlimited (backwards compatible).
    //
    // SOFT CEILING (by design): this is a non-atomic check-then-create over the
    // active-run SET — the per-tenant Redis ACL denies `eval`/Lua (ADR-0067), so
    // there is no atomic check-and-reserve. Concurrent durable starters can each
    // read `active < maxQueuedRuns` before any creates, transiently overshooting
    // the bound by at most the number of concurrent starters. The overshoot
    // self-heals as runs settle and `countActiveRuns` prunes, and is acceptable:
    // a counter-based hard ceiling
    // (`INCR`/`DECR`) would add a counter-vs-SET consistency invariant that drifts
    // on crashes. Non-durable load is bounded separately by the supervisor's
    // request-scoped `maxConcurrentRuns` gate.
    if (maxQueuedRuns !== undefined) {
      const active = await runStore.countActiveRuns();
      if (!active.ok) return active;
      if (active.value >= maxQueuedRuns) {
        return err(tenantOverQuota(tenant, retryAfterSeconds));
      }
    }

    const runId = newRunId();
    const timestamp = readRunTimestamp(clock);
    if (!timestamp.ok) return timestamp;
    const record: QueuedRunRecord = {
      runId,
      dagId,
      ownerTeam,
      input,
      identity: toPersistedIdentity(identity),
      status: { kind: "queued" },
      checkpoint: seeded.value,
      createdAtMs: timestamp.value,
      updatedAtMs: timestamp.value,
    };

    const created = await runStore.create(record);
    if (!created.ok) return created;
    if (created.value.kind === "publication-uncertain") {
      logWithoutThrowing(logger, "error", "hitl: run creation acknowledgement was lost — treating run as accepted", {
        runId,
        dagId,
      });
    }

    // The run is already durably accepted. Do not destroy it merely because
    // the direct wakeup fails: reconciliation enumerates the active record.
    await requestDirectWakeup(
      runId,
      "hitl: run accepted but initial wakeup failed — reconciliation will retry",
    );

    return ok({ runId });
  };

  const processRun = async (lease: RunLease): Promise<Result<void, HostError>> => {
    const runId = lease.runId;
    if (lease.signal.aborted) return err({ kind: "run-lease-lost", runId });
    const fetched = await runStore.get(runId);
    if (!fetched.ok) return fetched;
    const record = fetched.value;
    if (record === null) {
      // Nothing to process — a stale enqueue (run deleted/expired). Not an error.
      logWithoutThrowing(logger, "warn", "hitl: processRun for unknown run — ignoring", { runId });
      return ok(undefined);
    }

    // Terminal runs are never re-processed (a double-enqueue after completion).
    if (isTerminalRunStatus(record.status)) {
      logWithoutThrowing(logger, "warn", "hitl: processRun for terminal run — ignoring", {
        runId,
        status: record.status.kind,
      });
      return ok(undefined);
    }

    // Fail closed before executing: the running write proves both metadata
    // writability and current lease ownership. Side effects never start after a
    // known persistence/fencing failure.
    const marked = await runStore.setStatus(lease, { kind: "running" });
    if (!marked.ok) return marked;

    const jobLikeResult = makeRunStoreJobLike(runStore, lease, record.checkpoint);
    if (!jobLikeResult.ok) {
      // A corrupt checkpoint will not heal on retry — settle the run `failed`
      // (terminal) so a status poll surfaces it, and return `ok` so the worker
      // does NOT re-process (a retry would only hit the same corrupt state).
      logWithoutThrowing(logger, "error", "hitl: corrupt checkpoint — settling run failed", {
        runId,
        error: jobLikeResult.error.kind,
      });
      const settled = await runStore.setStatus(lease, { kind: "failed", error: asRunFailure(jobLikeResult.error) });
      if (!settled.ok) return settled;
      return ok(undefined);
    }
    const job = jobLikeResult.value;
    const onHumanReview = makeOnHumanReview({
      decisions,
      notifier,
      runId,
      dagId: record.dagId,
      ownerTeam: record.ownerTeam,
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
      signal: lease.signal,
      job,
      onHumanReview,
      onDecisionConsumed,
    });

    if (lease.signal.aborted) return err({ kind: "run-lease-lost", runId });

    if (!result.ok) {
      // Infrastructure failures detected before a run outcome exists remain
      // retryable. Post-transition checkpoint failures arrive as a failed run
      // outcome instead, because replaying the prior checkpoint is unsafe.
      return result;
    }

    return match(result.value)
      .with({ kind: "completed" }, (o) =>
        runStore.setStatus(lease, { kind: "completed", output: o.output }))
      // The checkpoint was already persisted by the job handle on suspend; record
      // the gate so a status poll / Teams card can render the prompt.
      .with({ kind: "suspended" }, (o) =>
        runStore.setStatus(lease, { kind: "suspended", nodeId: o.nodeId, prompt: o.prompt }))
      .with({ kind: "failed" }, (o) =>
        runStore.setStatus(lease, { kind: "failed", error: o.error }))
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

    // The pending marker is the authority during the brief `running` window;
    // SET NX inside `resolvePending` makes the action first-writer atomic.
    const resolution = await decisions.resolvePending(runId, nodeId, action);
    if (!resolution.ok) return resolution;
    if (resolution.value.kind === "not-pending") {
      const status = record.status.kind === "suspended" && record.status.nodeId !== nodeId
        ? `suspended at a different gate (${record.status.nodeId})`
        : record.status.kind;
      return err({ kind: "run-not-suspended", runId, status });
    }

    // Both accepted and already-resolved identify durable state that is safe to
    // wake. A failed direct wakeup does not revoke the accepted decision.
    await requestDirectWakeup(
      runId,
      "hitl: decision accepted but resume wakeup failed — reconciliation will retry",
      { nodeId, resolution: resolution.value.kind },
    );
    return ok(undefined);
  };

  const reconcileActiveRuns = async (): Promise<Result<readonly ReconciliationAttempt[], HostError>> => {
    const active = await runStore.listActiveRunIds();
    if (!active.ok) return active;

    const attempts: ReconciliationAttempt[] = [];
    const recordInspectionFailure = (runId: RunId, error: HostError): void => {
      attempts.push({ kind: "inspection-failed", runId, error });
      logWithoutThrowing(logger, "error", "hitl: active-run reconciliation inspection failed", {
        runId,
        error: error.kind,
        message: formatHostError(error),
      });
    };

    for (const runId of active.value) {
      const run = await runStore.get(runId);
      if (!run.ok) {
        recordInspectionFailure(runId, run.error);
        continue;
      }
      if (run.value === null || isTerminalRunStatus(run.value.status)) continue;
      if (run.value.status.kind === "suspended") {
        const decision = await decisions.getDecision(runId, run.value.status.nodeId);
        if (!decision.ok) {
          recordInspectionFailure(runId, decision.error);
          continue;
        }
        if (decision.value === null) continue;
      }

      const woken = await runQueue.enqueue(runId);
      if (woken.ok) {
        attempts.push({ kind: "woken", runId });
      } else {
        attempts.push({ kind: "wakeup-failed", runId, error: woken.error });
        logWithoutThrowing(logger, "error", "hitl: active-run reconciliation wakeup failed", {
          runId,
          error: woken.error.kind,
          message: formatHostError(woken.error),
        });
      }
    }
    return ok(attempts);
  };

  const getRun = (runId: RunId): Promise<Result<RunMetadata | null, HostError>> => runStore.getMetadata(runId);

  return { startRun, processRun, recordDecision, reconcileActiveRuns, getRun };
};
