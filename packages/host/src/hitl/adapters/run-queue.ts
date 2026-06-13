/**
 * RunQueue adapter (ADR-0060) — the wake-up trigger over the framework's
 * backend-agnostic `QueueBackend` (BullMQ in production, in-memory in tests).
 *
 * The queue carries ONLY the run id, not the run state — the durable state lives
 * in the `RunStore`. Each enqueue creates a fresh queue job (no `jobId` dedup),
 * so a re-enqueue to RESUME a parked run always works even after the prior job
 * completed. Concurrency safety (a double-approval enqueuing the same run twice)
 * is enforced by a single-flight Redis lock around `processRun`, so a run is
 * never executed by two workers at once (which would double-run side-effecting
 * nodes).
 */

import { ok, err } from "@fuguejs/framework";
import type { Result, RunId, QueueBackend, WorkerHandle } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { RedisPort, LogPort } from "../../ports.js";
import type { RunQueuePort } from "../ports.js";

/** Trigger envelope: the queue only needs the run id. */
type RunTrigger = { state: RunId; context: null };

export interface RunQueueDeps {
  readonly backend: QueueBackend;
  readonly redis: RedisPort;
  /** Queue name (default `fugue-hitl-runs`). */
  readonly queueName?: string;
  /**
   * Single-flight lock TTL (seconds). Bounds how long a crashed worker's lock
   * blocks a run before another worker can pick it up. Should exceed the longest
   * expected execution slice (a resume-to-next-gate run), not the human wait.
   */
  readonly lockTtlSec: number;
  readonly logger?: LogPort;
}

export interface RunQueueHandle {
  readonly queue: RunQueuePort;
  /**
   * Start the worker. The processor is `HitlRunService.processRun`. Returns the
   * framework `WorkerHandle` for lifecycle/shutdown wiring.
   */
  startWorker(
    processRun: (runId: RunId) => Promise<Result<void, HostError>>,
    opts?: { concurrency?: number },
  ): WorkerHandle;
}

const lockKey = (runId: RunId): string => `fugue:hitl:lock:${runId}`;

export const createRunQueue = (deps: RunQueueDeps): RunQueueHandle => {
  const { backend, redis, lockTtlSec, logger } = deps;
  const name = deps.queueName ?? "fugue-hitl-runs";
  const handle = backend.createQueue<RunId, null>(name);

  const queue: RunQueuePort = {
    async enqueue(runId): Promise<Result<void, HostError>> {
      try {
        // No `jobId` → a fresh job every time → resume re-enqueue is never
        // rejected as a duplicate.
        await handle.enqueue(runId, { state: runId, context: null } satisfies RunTrigger);
        return ok(undefined);
      } catch (e) {
        return err({ kind: "redis-unavailable", operation: `HITL enqueue: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
  };

  const startWorker = (
    processRun: (runId: RunId) => Promise<Result<void, HostError>>,
    opts?: { concurrency?: number },
  ): WorkerHandle =>
    backend.createWorker<RunId, null>(
      name,
      async (job) => {
        const runId = job.data.state;

        // Single-flight: only one worker processes a given run at a time. A
        // failed lock acquisition means another worker holds it — skip; that
        // worker will process the latest decision (decisions are persisted).
        const acquired = await redis.setNx(lockKey(runId), "1");
        if (!acquired.ok) {
          logger?.error?.("hitl: lock acquire failed — skipping slice", { runId, error: acquired.error.kind });
          return;
        }
        if (!acquired.value) {
          logger?.warn?.("hitl: run already in flight — skipping duplicate slice", { runId });
          return;
        }
        // Best-effort TTL so a crashed worker's lock self-heals.
        const ttl = await redis.set(lockKey(runId), "1", { expiresInSec: lockTtlSec });
        if (!ttl.ok) logger?.warn?.("hitl: failed to set lock TTL", { runId });

        try {
          const result = await processRun(runId);
          if (!result.ok) {
            logger?.error?.("hitl: processRun returned error", { runId, error: result.error.kind });
          }
        } finally {
          const released = await redis.del(lockKey(runId));
          if (!released.ok) logger?.warn?.("hitl: failed to release lock", { runId });
        }
      },
      { concurrency: opts?.concurrency ?? 4 },
    );

  return { queue, startWorker };
};
