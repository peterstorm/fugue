// Registry diff — detect added/removed/changed tasks
// Pure function: no I/O, no Date.now()

import type { TaskConfig, TaskRegistry, RegistryDiff } from "./types.js";

/**
 * Produces a minimal diff from `active` to `desired`.
 *
 * Returns three DISJOINT lists (FR-062):
 *   add    — ids in desired but not in active
 *   remove — ids in active but not in desired
 *   update — ids in both, but with differing config
 *
 * "Differing config" is determined by a shallow structural comparison of all
 * TaskConfig fields: id, cron, validForMs, dependsOn.
 */
export function diffRegistry(
  active: TaskRegistry,
  desired: TaskRegistry,
): RegistryDiff {
  const add: TaskConfig[] = [];
  const remove: string[] = [];
  const update: TaskConfig[] = [];

  // IDs only in desired → add
  for (const [id, config] of desired) {
    if (!active.has(id)) {
      add.push(config);
    } else {
      // Present in both → compare
      const activeConfig = active.get(id)!;
      if (!configsEqual(activeConfig, config)) {
        update.push(config);
      }
    }
  }

  // IDs only in active → remove
  for (const id of active.keys()) {
    if (!desired.has(id)) {
      remove.push(id);
    }
  }

  return { add, remove, update };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configsEqual(a: TaskConfig, b: TaskConfig): boolean {
  if (a.id !== b.id) return false;
  if (a.cron !== b.cron) return false;
  if (a.validForMs !== b.validForMs) return false;
  return dependsOnEqual(a.dependsOn, b.dependsOn);
}

function dependsOnEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  // Order-insensitive: ["A","B"] and ["B","A"] express the same prerequisite set
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}
