/**
 * DAG Diff — Pure function detecting changes between two registry snapshots.
 *
 * Compares two sets of DAG paths (or registrations) to identify:
 * - Added DAGs (present in new, absent in old)
 * - Removed DAGs (present in old, absent in new)
 * - Changed DAGs (present in both, different SHA or path)
 * - Unchanged DAGs
 *
 * @satisfies FR-003 — Detect removed DAGs for graceful deregistration
 * @satisfies FR-007 — Track DAG versions by git commit SHA
 */

import type { DagId } from "@fugue/framework";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A DAG snapshot entry for diff comparison.
 */
export interface DagSnapshot {
  readonly id: DagId;
  readonly path: string;
  readonly sha: string;
}

/**
 * Result of comparing two sets of DAG snapshots.
 */
export interface DagDiff {
  readonly added: readonly DagSnapshot[];
  readonly removed: readonly DagSnapshot[];
  readonly changed: readonly DagSnapshot[];
  readonly unchanged: readonly DagSnapshot[];
}

// ── Pure Diff Function ─────────────────────────────────────────────────────

/**
 * Compare two sets of DAG snapshots to detect additions, removals, and changes.
 *
 * Pure function — no side effects. Deterministic output for identical inputs.
 *
 * @param previous - DAGs from the previous sync cycle
 * @param current - DAGs from the current sync cycle
 * @returns DagDiff describing the delta between the two snapshots
 */
export const diffDags = (
  previous: readonly DagSnapshot[],
  current: readonly DagSnapshot[],
): DagDiff => {
  const prevMap = new Map<string, DagSnapshot>();
  for (const dag of previous) {
    prevMap.set(dag.id, dag);
  }

  const currMap = new Map<string, DagSnapshot>();
  for (const dag of current) {
    currMap.set(dag.id, dag);
  }

  const added: DagSnapshot[] = [];
  const changed: DagSnapshot[] = [];
  const unchanged: DagSnapshot[] = [];
  const removed: DagSnapshot[] = [];

  // Find added and changed/unchanged
  for (const curr of current) {
    const prev = prevMap.get(curr.id);
    if (!prev) {
      added.push(curr);
    } else if (prev.sha !== curr.sha || prev.path !== curr.path) {
      changed.push(curr);
    } else {
      unchanged.push(curr);
    }
  }

  // Find removed
  for (const prev of previous) {
    if (!currMap.has(prev.id)) {
      removed.push(prev);
    }
  }

  return { added, removed, changed, unchanged };
};

export const hasChanges = (diff: DagDiff): boolean =>
  diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

/**
 * Get a human-readable summary of a diff for logging.
 */
export const diffSummary = (diff: DagDiff): string => {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`+${diff.added.length} added`);
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length} removed`);
  if (diff.changed.length > 0) parts.push(`~${diff.changed.length} changed`);
  if (diff.unchanged.length > 0) parts.push(`=${diff.unchanged.length} unchanged`);
  return parts.join(", ") || "no DAGs";
};
