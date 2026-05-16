// Scheduler types
// MUST NOT import bullmq, ioredis (enforced by check-imports.ts)

/** Periodic task configuration */
export interface TaskConfig {
  readonly id: string;
  /** Cron expression (parsed by cron-parser) */
  readonly cron: string;
  /** How long (ms) after a scheduled fire the task is still valid to enqueue */
  readonly validForMs: number;
  /** IDs of tasks this task depends on (dependents run after this task completes) */
  readonly dependsOn?: readonly string[];
}

/** Registry of all known tasks — keyed by task id */
export type TaskRegistry = ReadonlyMap<string, TaskConfig>;

/**
 * Shared task-registry store for cross-process dependent resolution.
 * When provided to `CronSchedulerOpts`, `resolveDependents` reads from the
 * store instead of the process-local `activeRegistry`. This enables
 * multi-process deployments where the scheduler and workers run in separate
 * processes.
 *
 * Single-process callers can omit this — the scheduler falls back to the
 * process-local registry reconciled via `reconcile()`.
 */
export interface TaskRegistryStore {
  /** Retrieve a single task config by id. Returns `null` if not found. */
  get(taskId: string): Promise<TaskConfig | null>;
  /** Retrieve the full registry. */
  getAll(): Promise<TaskRegistry>;
}

/** Result of diffing two registries — three disjoint lists (FR-062) */
export interface RegistryDiff {
  /** Tasks present in desired but not active — must be armed */
  readonly add: readonly TaskConfig[];
  /** Task ids present in active but not desired — must be disarmed */
  readonly remove: readonly string[];
  /** Tasks present in both but with changed config — must be re-armed */
  readonly update: readonly TaskConfig[];
}

/**
 * Post-restart catch-up decision — FR-063
 *
 * Cases:
 *   skip             — task in-flight or outside validity window; no action needed
 *   enqueue-standalone — task did not fire within validity window; enqueue it now
 *   enqueue-dependents — task fired+completed within window but dependents unfired
 */
export type CatchUpDecision =
  | { kind: "skip"; reason: string }
  | { kind: "enqueue-standalone" }
  | { kind: "enqueue-dependents"; dependentIds: readonly string[] };
