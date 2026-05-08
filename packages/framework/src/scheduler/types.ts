// Scheduler types — FR-060
// MUST NOT import bullmq, ioredis (FR-080)

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
