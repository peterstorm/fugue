// CronScheduler — imperative shell — FR-064
// Uses cron-parser for next-fire-time calculation.
// MUST NOT import bullmq, ioredis, or queue-bullmq/** (FR-080) —
// enforced by scripts/check-imports.ts.

import { parseExpression } from "cron-parser";
import type { MarkerStore } from "../queue/types.js";
import type { TaskConfig, TaskRegistry } from "./types.js";
import { diffRegistry } from "./diff.js";
import { hasCycle } from "./cycle.js";
import { fwLogger } from "../logger.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CronScheduler {
  /**
   * Reconcile active timers with the desired registry.
   * Arms new tasks, disarms removed tasks, re-arms updated tasks.
   * Silently skips tasks that have a dependency cycle (logs a warning).
   */
  reconcile(reg: TaskRegistry): void;

  /**
   * Called after a task completes — enqueues dependent tasks whose upstream
   * tasks have all completed within their validity windows.
   */
  resolveDependents(taskId: string, triggeredAt: Date): Promise<void>;

  /** Cancel all active timers and clear internal state. */
  stop(): void;
}

export interface CronSchedulerOpts {
  /**
   * Enqueue a single task.  Implementations should be idempotent (use
   * marker-based dedup so duplicate enqueues are no-ops).
   */
  enqueue: (task: TaskConfig, triggeredAt: Date) => Promise<void>;
  /**
   * Injectable wall-clock supplier. Defaults to `() => new Date()`. The
   * scheduler keeps the `() => Date` shape (not `() => number`) because
   * cron-parser and the `triggeredAt` arguments downstream want `Date`
   * values directly; carrying the number through and re-wrapping at every
   * call site costs more than the framework-wide uniformity buys. The
   * `() => number` convention applies to observer + queue clocks.
   */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Marker key helpers (exported for tests)
// ---------------------------------------------------------------------------

export function markerFiredKey(taskId: string): string {
  return `scheduler:${taskId}:fired`;
}

export function markerCompletedKey(taskId: string): string {
  return `scheduler:${taskId}:completed`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a `CronScheduler` that reconciles cron timers per `diffRegistry`,
 * arms setTimeout-based timers for the next scheduled fire of each task, and
 * enqueues dependents when an upstream task completes.
 *
 * FR-064: reconcile(registry), resolveDependents(taskId, triggeredAt), stop()
 */
export function createCronScheduler(
  markers: MarkerStore,
  opts: CronSchedulerOpts,
): CronScheduler {
  const { enqueue, now = () => new Date() } = opts;

  // Map from taskId → active timer handle
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-task consecutive unexpected-failure count, drives the exponential
  // backoff (capped at BACKOFF_CAP_MS). Reset on any successful handleFire.
  const consecutiveFailures = new Map<string, number>();
  // Current active registry (tasks currently armed)
  let activeRegistry: TaskRegistry = new Map();

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function getNextDate(cron: string, after: Date): Date | null {
    try {
      const interval = parseExpression(cron, { currentDate: after });
      return interval.next().toDate();
    } catch (err) {
      fwLogger().error(`[CronScheduler] Failed to parse cron "${cron}" after ${after.toISOString()}:`, err);
      return null;
    }
  }

  // On every timer fire, re-read the current task from `activeRegistry` rather
  // than the closure-captured value. If `reconcile` updated the task between
  // arm and fire, the live config wins — without this, a stale closure can
  // permanently re-arm the scheduler with retired cron / validForMs values.
  // Returns null if the task has been removed entirely; the caller should
  // simply stop the chain in that case.
  function onTimerFire(taskId: string): void {
    const current = activeRegistry.get(taskId);
    if (current === undefined) return; // task was removed mid-fire — drop the chain
    const triggeredAt = now();
    handleFire(current, triggeredAt)
      .then(() => {
        consecutiveFailures.delete(current.id);
        const stillActive = activeRegistry.get(current.id);
        if (stillActive !== undefined) rescheduleTask(stillActive, triggeredAt);
      })
      .catch((err) => {
        fwLogger().error(`[CronScheduler] timer callback failed for "${current.id}":`, err);
        const n = (consecutiveFailures.get(current.id) ?? 0) + 1;
        consecutiveFailures.set(current.id, n);
        const stillActive = activeRegistry.get(current.id);
        if (stillActive !== undefined) rescheduleTaskWithBackoff(stillActive, n);
      });
  }

  function scheduleTask(task: TaskConfig): void {
    disarmTask(task.id); // cancel any existing timer first

    const nowDate = now();
    const nextDate = getNextDate(task.cron, nowDate);
    if (nextDate === null) {
      fwLogger().warn(`[CronScheduler] Task "${task.id}" will NOT be armed — cron "${task.cron}" yielded no next date after ${nowDate.toISOString()}`);
      return;
    }

    const delayMs = Math.max(0, nextDate.getTime() - nowDate.getTime());

    const handle = setTimeout(() => onTimerFire(task.id), delayMs);
    timers.set(task.id, handle);
  }

  function rescheduleTask(task: TaskConfig, after: Date): void {
    disarmTask(task.id);

    const nowDate = now();
    const nextDate = getNextDate(task.cron, after);
    if (nextDate === null) {
      fwLogger().warn(`[CronScheduler] Task "${task.id}" will NOT be re-armed — cron "${task.cron}" yielded no next date after ${after.toISOString()}`);
      return;
    }

    const delayMs = Math.max(0, nextDate.getTime() - nowDate.getTime());

    const handle = setTimeout(() => onTimerFire(task.id), delayMs);
    timers.set(task.id, handle);
  }

  // When handleFire fails unexpectedly, re-arm at an exponentially-growing
  // delay (capped at 30 minutes) instead of the normal cron-tick interval.
  // Resets to normal scheduling on first success.
  const BACKOFF_BASE_MS = 1000;
  const BACKOFF_CAP_MS = 30 * 60 * 1000;
  function rescheduleTaskWithBackoff(
    task: TaskConfig,
    failureCount: number,
  ): void {
    disarmTask(task.id);
    const backoffMs = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, failureCount - 1),
      BACKOFF_CAP_MS,
    );
    fwLogger().warn(
      `[CronScheduler] backing off task "${task.id}" by ${backoffMs}ms (consecutive failures: ${failureCount})`,
    );
    const handle = setTimeout(() => onTimerFire(task.id), backoffMs);
    timers.set(task.id, handle);
  }

  function disarmTask(id: string): void {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  }

  async function handleFire(task: TaskConfig, triggeredAt: Date): Promise<void> {
    // Enqueue first — only mark as fired on success.
    // Enqueue implementations MUST be idempotent (per CronSchedulerOpts.enqueue contract).
    //
    // A swallowed enqueue failure here used to drop the task back into normal
    // cron-tick scheduling, bypassing the consecutive-failure backoff. Rethrow
    // so the outer setTimeout `.catch` branch increments `consecutiveFailures`
    // and calls `rescheduleTaskWithBackoff` instead — a broken enqueue backend
    // gets exponentially-spaced retries, not a per-cron-tick hammer.
    try {
      await enqueue(task, triggeredAt);
    } catch (err) {
      fwLogger().error(`[CronScheduler] enqueue failed for task "${task.id}" — backing off:`, err);
      throw err;
    }

    const ttlSeconds = Math.ceil(task.validForMs / 1000) + 60; // grace period
    try {
      await markers.set(markerFiredKey(task.id), ttlSeconds);
    } catch (err) {
      // Job is already enqueued; marker write failure means catch-up may re-enqueue, but enqueue is idempotent.
      fwLogger().error(`[CronScheduler] markers.set(fired) failed for task "${task.id}" (job already enqueued):`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  function reconcile(reg: TaskRegistry): void {
    const diff = diffRegistry(activeRegistry, reg);

    // Disarm removed tasks and clear any retained failure-counter state so a
    // re-added task starts with a fresh backoff schedule.
    for (const id of diff.remove) {
      disarmTask(id);
      consecutiveFailures.delete(id);
    }

    // Arm new and updated tasks (skip cyclic ones)
    for (const task of [...diff.add, ...diff.update]) {
      if (hasCycle(task.id, reg)) {
        fwLogger().warn(`[CronScheduler] Skipping task "${task.id}" — dependency cycle detected`);
        continue;
      }
      scheduleTask(task);
    }

    activeRegistry = reg;
  }

  async function resolveDependents(
    taskId: string,
    triggeredAt: Date,
  ): Promise<void> {
    // Mark the upstream task as completed — guard against store failures
    const upstreamTask = activeRegistry.get(taskId);
    const completedTtl = upstreamTask
      ? Math.ceil(upstreamTask.validForMs / 1000) + 60
      : 3600;
    try {
      await markers.set(markerCompletedKey(taskId), completedTtl);
    } catch (err) {
      fwLogger().error(`[CronScheduler] markers.set(completed) failed for task "${taskId}":`, err);
      // Return early: dependents rely on completed marker to gate their enqueue
      return;
    }

    // Find all tasks that directly depend on taskId
    const dependentTasks = findDependents(taskId, activeRegistry);
    if (dependentTasks.length === 0) return;

    // For each dependent, check if ALL its dependencies have completed
    for (const dep of dependentTasks) {
      try {
        if (!dep.dependsOn || dep.dependsOn.length === 0) continue;

        let allDepsCompleted = true;
        for (const depId of dep.dependsOn) {
          const completed = await markers.exists(markerCompletedKey(depId));
          if (!completed) {
            allDepsCompleted = false;
            break;
          }
        }
        if (!allDepsCompleted) continue;

        // Only enqueue if not already fired
        const alreadyFired = await markers.exists(markerFiredKey(dep.id));
        if (alreadyFired) continue;

        // Enqueue first — only mark fired on success. enqueue is idempotent (per contract).
        try {
          await enqueue(dep, triggeredAt);
        } catch (err) {
          fwLogger().error(`[CronScheduler] enqueue failed for dependent task "${dep.id}" — marker not set:`, err);
          continue;
        }
        const depFiredTtl = Math.ceil(dep.validForMs / 1000) + 60;
        try {
          await markers.set(markerFiredKey(dep.id), depFiredTtl);
        } catch (err) {
          fwLogger().error(
            `[CronScheduler] markers.set(fired) failed for dependent "${dep.id}" (upstream "${taskId}", job already enqueued):`,
            err,
          );
        }
      } catch (err) {
        fwLogger().error(`[CronScheduler] resolveDependents failed for taskId="${taskId}", dep="${dep.id}":`, err);
        // Continue so remaining dependents still get processed
      }
    }
  }

  function stop(): void {
    for (const handle of timers.values()) {
      clearTimeout(handle);
    }
    timers.clear();
    consecutiveFailures.clear();
    activeRegistry = new Map();
  }

  return { reconcile, resolveDependents, stop };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function findDependents(
  taskId: string,
  registry: TaskRegistry,
): TaskConfig[] {
  const result: TaskConfig[] = [];
  for (const task of registry.values()) {
    if (task.dependsOn?.includes(taskId)) {
      result.push(task);
    }
  }
  return result;
}
