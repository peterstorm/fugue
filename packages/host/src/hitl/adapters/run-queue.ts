/**
 * RunQueue adapter (ADR-0060) — the wake-up trigger over the framework's
 * backend-agnostic `QueueBackend` (BullMQ in production, in-memory in tests).
 *
 * The queue carries only the durable run id plus tenant context, never run state —
 * the durable state lives in the `RunStore`. Each enqueue creates a fresh queue
 * job (no `jobId` dedup),
 * so a re-enqueue to RESUME a parked run always works even after the prior job
 * completed. Concurrency safety (a double-approval enqueuing the same run twice)
 * is enforced by a single-flight Redis lock around `processRun`, so a run is
 * not executed concurrently while its owner keeps the Redis lease alive (which
 * prevents double-running side-effecting nodes).
 */

import { ok, err, safeErrorMessage, tryRunId } from "@fuguejs/framework";
import type { Result, RunId, QueueBackend, WorkerHandle } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import { formatHostError, internalInvariantViolated } from "../../domain/host-error.js";
import { tenantId } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import type { HitlRedisPort, LogPort } from "../../ports.js";
import { issueRunLease } from "../ports.js";
import type { RunLease, RunQueuePort } from "../ports.js";
import { logWithoutThrowing } from "../diagnostic-logging.js";

/** Trigger envelope binds the wakeup to its tenant as well as its durable run id. */
type RunTrigger = { readonly state: RunId; readonly context: { readonly tenant: TenantId } };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse durable queue data before it can name a lock key or issue a lease. */
export const parseRunTrigger = (
  value: unknown,
  expectedTenant: TenantId,
): Result<RunTrigger, HostError> => {
  if (!isRecord(value) || !isRecord(value.context)) {
    return err(internalInvariantViolated("invalid HITL queue trigger envelope", {}));
  }
  if (typeof value.state !== "string") {
    return err(internalInvariantViolated("invalid HITL queue trigger run id", {}));
  }
  const runId = tryRunId(value.state);
  if (!runId.ok) {
    return err(internalInvariantViolated("invalid HITL queue trigger run id", {
      reason: runId.error,
    }));
  }
  if (typeof value.context.tenant !== "string") {
    return err(internalInvariantViolated("invalid HITL queue trigger tenant", {
      runId: runId.value,
    }));
  }
  const parsedTenant = tenantId(value.context.tenant);
  if (!parsedTenant.ok) {
    return err(internalInvariantViolated("invalid HITL queue trigger tenant", {
      runId: runId.value,
      reason: parsedTenant.error.kind,
    }));
  }
  if (parsedTenant.value !== expectedTenant) {
    return err(internalInvariantViolated(`cross-tenant wakeup for '${runId.value}'`, {
      runId: runId.value,
      expectedTenant,
      actualTenant: parsedTenant.value,
    }));
  }
  return ok({ state: runId.value, context: { tenant: parsedTenant.value } });
};

interface RunQueueDeps {
  readonly backend: QueueBackend;
  readonly redis: HitlRedisPort;
  /**
   * The tenant this queue's single-flight locks are scoped to (AD-4 / FR-013 /
   * SC-001). The lock key is forced under `fugue:<tenant>:hitl:lock:`, so under
   * the per-tenant Redis ACL (`~fugue:<tenant>:*`) a queue for tenant A can never
   * name (or contend on) tenant B's run locks. Required, non-optional: a lock key
   * cannot be built without a tenant.
   */
  readonly tenant: TenantId;
  /** Queue name (default is tenant-qualified). */
  readonly queueName?: string;
  /**
   * Single-flight lock TTL (seconds). Bounds how long a crashed worker's lock
   * blocks a run before another worker can pick it up. Should exceed the longest
   * expected execution slice (a resume-to-next-gate run), not the human wait.
   */
  readonly lockTtlSec: number;
  /**
   * Delay (ms) before a wakeup that lost the single-flight lock is re-enqueued.
   * A held lock means another worker is mid-slice for the same run; we defer
   * rather than drop the wakeup (which would strand a decided run). The delay
   * avoids a hot re-enqueue loop while the slice runs. Default 1000ms.
   */
  readonly lockContentionDelayMs?: number;
  /**
   * Max queue attempts per wakeup job (the outer crash-fallback loop). A worker
   * that throws on a transient infra failure is retried up to this many times
   * before the job is exhausted/dead-lettered, instead of silently acked.
   * Default 5.
   */
  readonly maxAttempts?: number;
  /** Fresh ownership token per acquired lease. Defaults to `crypto.randomUUID`. */
  readonly newLockToken?: () => string;
  readonly logger?: LogPort;
}

interface RunQueueHandle {
  readonly queue: RunQueuePort;
  /**
   * Start the worker. The processor is `HitlRunService.processRun`. Returns the
   * framework `WorkerHandle` for lifecycle/shutdown wiring.
   */
  startWorker(
    processRun: (lease: RunLease) => Promise<Result<void, HostError>>,
    opts?: { concurrency?: number },
  ): WorkerHandle;
}

const lockKey = (tenant: TenantId, runId: RunId): string => `fugue:${tenant}:hitl:lock:${runId}`;

export const hitlQueueName = (tenant: TenantId, configured?: string): string => {
  const name = configured ?? `fugue-${tenant}-hitl-runs`;
  if (name.length === 0 || name.includes(":")) {
    throw new RangeError("HITL queue name must be non-empty and must not contain ':' (BullMQ restriction)");
  }
  return name;
};

export const createRunQueue = (deps: RunQueueDeps): RunQueueHandle => {
  const { backend, tenant, lockTtlSec, logger } = deps;
  const name = hitlQueueName(tenant, deps.queueName);
  const contentionDelayMs = deps.lockContentionDelayMs ?? 1000;
  const maxAttempts = deps.maxAttempts ?? 5;
  const newLockToken = deps.newLockToken ?? (() => crypto.randomUUID());
  // `defaultAttempts` makes a worker that THROWS on a transient infra failure
  // actually retried (the outer crash-fallback loop) instead of acked once.
  const handle = backend.createQueue<RunId, { readonly tenant: TenantId }>(name, { defaultAttempts: maxAttempts });

  const enqueue = async (runId: RunId, opts?: { delayMs?: number }): Promise<Result<void, HostError>> => {
    try {
      // No `jobId` → a fresh job every time → resume re-enqueue is never
      // rejected as a duplicate.
      await handle.enqueue(
        runId,
        { state: runId, context: { tenant } } satisfies RunTrigger,
        opts?.delayMs !== undefined ? { delayMs: opts.delayMs } : undefined,
      );
      return ok(undefined);
    } catch (e) {
      return err({ kind: "redis-unavailable", operation: `HITL enqueue: ${safeErrorMessage(e)}` });
    }
  };

  const queue: RunQueuePort = { enqueue: (runId) => enqueue(runId) };

  const startWorker = (
    processRun: (lease: RunLease) => Promise<Result<void, HostError>>,
    opts?: { concurrency?: number },
  ): WorkerHandle =>
    backend.createWorker<RunId, { readonly tenant: TenantId }>(
      name,
      async (job) => {
        const trigger = parseRunTrigger(job.data, tenant);
        if (!trigger.ok) {
          throw new Error(`hitl: rejected durable wakeup: ${formatHostError(trigger.error)}`, {
            cause: trigger.error,
          });
        }
        const redis = deps.redis;
        const runId = trigger.value.state;

        // Single-flight: only one worker processes a given run at a time. Every
        // lease carries a fresh owner token; release compares that token
        // atomically so an expired holder cannot delete a successor's lease.
        const lockToken = newLockToken();
        const acquired = await redis.setNx(lockKey(tenant, runId), lockToken, { expiresInSec: lockTtlSec });
        if (!acquired.ok) {
          // The lock store is unavailable — throw so the queue retries this
          // wakeup rather than silently acking and dropping it.
          throw new Error(`hitl: lock acquire failed for ${runId}: ${acquired.error.kind}`, { cause: acquired.error });
        }
        if (!acquired.value) {
          // Another worker holds the lock (mid-slice for this run). Do NOT drop
          // this wakeup — the decision that triggered it is durable in Redis but
          // the holding worker may have already read "no decision" and parked,
          // so re-enqueue (deferred) to guarantee the decision is acted on once
          // the lock frees. A bare drop here is the lost-wakeup that strands a
          // decided run.
          logWithoutThrowing(logger, "warn", "hitl: run already in flight — deferring wakeup", { runId });
          const requeued = await enqueue(runId, { delayMs: contentionDelayMs });
          if (!requeued.ok) {
            throw new Error(`hitl: failed to defer wakeup for ${runId}: ${requeued.error.kind}`, { cause: requeued.error });
          }
          return;
        }

        // A lock is a lease, not a permanent mutex. Renew before half its TTL
        // elapses, always with the owner token, and fail closed if ownership
        // cannot be verified by the construction-validated lease port.
        const renewEveryMs = Math.max(1, Math.floor(lockTtlSec * 500));
        const leaseController = new AbortController();
        const lease = issueRunLease(runId, lockToken, leaseController.signal);
        let renewalFailure: HostError | "ownership-lost" | undefined;
        let renewalTail: Promise<void> = Promise.resolve();
        const failLease = (failure: HostError | "ownership-lost"): void => {
          if (renewalFailure !== undefined) return;
          renewalFailure = failure;
          const detail = failure === "ownership-lost" ? failure : failure.kind;
          logWithoutThrowing(logger, "error", "hitl: lock renewal failed — aborting run slice for retry", {
            runId,
            error: detail,
          });
          leaseController.abort(failure);
        };
        const renewLease = (): void => {
          renewalTail = renewalTail.then(async () => {
            if (renewalFailure !== undefined) return;
            try {
              const renewed = await redis.compareAndExpire(lockKey(tenant, runId), lockToken, lockTtlSec);
              if (!renewed.ok) failLease(renewed.error);
              else if (!renewed.value) failLease("ownership-lost");
            } catch (error) {
              failLease({ kind: "redis-unavailable", operation: `HITL lease renewal: ${safeErrorMessage(error)}` });
            }
          });
        };
        const renewalTimer = setInterval(renewLease, renewEveryMs);

        try {
          const result = await processRun(lease);
          await renewalTail;
          if (renewalFailure !== undefined) {
            const detail = renewalFailure === "ownership-lost" ? renewalFailure : renewalFailure.kind;
            throw new Error(`hitl: lock renewal failed for ${runId}: ${detail}`);
          }
          if (!result.ok) {
            // A host-infra failure BEFORE the run settled (e.g. a transient
            // run-store read). Throw so the queue retries; the `finally` below
            // releases the lock first. (A run that settled `failed` returns
            // `ok` from processRun — it is durably recorded, not retried.)
            logWithoutThrowing(logger, "error", "hitl: processRun returned error — retrying", {
              runId,
              error: result.error.kind,
            });
            throw new Error(`hitl: processRun failed for ${runId}: ${result.error.kind}`, { cause: result.error });
          }
        } finally {
          clearInterval(renewalTimer);
          await renewalTail;
          const released = await redis.compareAndDelete(lockKey(tenant, runId), lockToken);
          if (!released.ok) {
            logWithoutThrowing(logger, "warn", "hitl: failed to release owned lock", {
              runId,
              error: released.error.kind,
            });
          } else if (!released.value) {
            // `ok` only says the compare-and-delete RAN; `false` says it did not
            // MATCH — this worker no longer owned the lease. That means the TTL
            // elapsed (a stalled event loop past `lockTtlSec`) and a successor
            // claimed the run while we still believed we held it. Correctness is
            // protected elsewhere by lease-fenced writes in run-store.ts, so this
            // is not a failure to act on — but every other stale-lease path in
            // this file logs, and without this line a lost lease is byte-for-byte
            // indistinguishable from a clean release in the log, removing the one
            // trail an operator has when investigating duplicated node side effects.
            logWithoutThrowing(logger, "warn", "hitl: lock lease was lost to a successor before release", {
              runId,
            });
          }
        }
      },
      { concurrency: opts?.concurrency ?? 4 },
    );

  return { queue, startWorker };
};
