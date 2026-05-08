// CronScheduler — imperative shell — FR-064
// Uses cron-parser (already in monorepo) for next-fire-time calculation.
// MUST NOT import bullmq, ioredis (FR-080)

import { parseExpression } from "cron-parser";
import type { MarkerStore } from "../queue/types.js";
import type { TaskConfig, TaskRegistry } from "./types.js";
import { diffRegistry } from "./diff.js";
import { hasCycle } from "./cycle.js";

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
  /** Injectable `now` supplier for testing — defaults to `() => new Date()` */
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
      console.error(`[CronScheduler] Failed to parse cron "${cron}" after ${after.toISOString()}:`, err);
      return null;
    }
  }

  function scheduleTask(task: TaskConfig): void {
    disarmTask(task.id); // cancel any existing timer first

    const nowDate = now();
    const nextDate = getNextDate(task.cron, nowDate);
    if (nextDate === null) {
      console.warn(`[CronScheduler] Task "${task.id}" will NOT be armed — cron "${task.cron}" yielded no next date after ${nowDate.toISOString()}`);
      return;
    }

    const delayMs = Math.max(0, nextDate.getTime() - nowDate.getTime());

    const handle = setTimeout(() => {
      const triggeredAt = now();
      handleFire(task, triggeredAt)
        .then(() => {
          // Re-arm for the next occurrence
          rescheduleTask(task, triggeredAt);
        })
        .catch((err) => {
          console.error(`[CronScheduler] timer callback failed for "${task.id}":`, err);
          rescheduleTask(task, triggeredAt);
        });
    }, delayMs);

    timers.set(task.id, handle);
  }

  function rescheduleTask(task: TaskConfig, after: Date): void {
    disarmTask(task.id);

    const nowDate = now();
    const nextDate = getNextDate(task.cron, after);
    if (nextDate === null) {
      console.warn(`[CronScheduler] Task "${task.id}" will NOT be re-armed — cron "${task.cron}" yielded no next date after ${after.toISOString()}`);
      return;
    }

    const delayMs = Math.max(0, nextDate.getTime() - nowDate.getTime());

    const handle = setTimeout(() => {
      const triggeredAt = now();
      handleFire(task, triggeredAt)
        .then(() => {
          rescheduleTask(task, triggeredAt);
        })
        .catch((err) => {
          console.error(`[CronScheduler] timer callback failed for "${task.id}":`, err);
          rescheduleTask(task, triggeredAt);
        });
    }, delayMs);

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
    // Mark as fired — guard against Redis/store failures
    const ttlSeconds = Math.ceil(task.validForMs / 1000) + 60; // grace period
    try {
      await markers.set(markerFiredKey(task.id), ttlSeconds);
    } catch (err) {
      console.error(`[CronScheduler] markers.set(fired) failed for task "${task.id}":`, err);
      // Return early: catch-up logic depends on the fired marker existing when the job was actually queued
      return;
    }

    try {
      await enqueue(task, triggeredAt);
    } catch (err) {
      console.error(`[CronScheduler] enqueue failed for task "${task.id}":`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  function reconcile(reg: TaskRegistry): void {
    const diff = diffRegistry(activeRegistry, reg);

    // Disarm removed tasks
    for (const id of diff.remove) {
      disarmTask(id);
    }

    // Arm new and updated tasks (skip cyclic ones)
    for (const task of [...diff.add, ...diff.update]) {
      if (hasCycle(task.id, reg)) {
        console.warn(`[CronScheduler] Skipping task "${task.id}" — dependency cycle detected`);
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
      console.error(`[CronScheduler] markers.set(completed) failed for task "${taskId}":`, err);
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

        const depFiredTtl = Math.ceil(dep.validForMs / 1000) + 60;
        try {
          await markers.set(markerFiredKey(dep.id), depFiredTtl);
        } catch (err) {
          console.error(
            `[CronScheduler] markers.set(fired) failed for dependent "${dep.id}" (upstream "${taskId}") — skipping enqueue to preserve idempotency:`,
            err,
          );
          continue;
        }
        try {
          await enqueue(dep, triggeredAt);
        } catch (err) {
          console.error(`[CronScheduler] enqueue failed for dependent task "${dep.id}":`, err);
        }
      } catch (err) {
        console.error(`[CronScheduler] resolveDependents failed for taskId="${taskId}", dep="${dep.id}":`, err);
        // Continue so remaining dependents still get processed
      }
    }
  }

  function stop(): void {
    for (const handle of timers.values()) {
      clearTimeout(handle);
    }
    timers.clear();
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
