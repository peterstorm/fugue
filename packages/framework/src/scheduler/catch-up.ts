// Catch-up decision — FR-063
// Pure function: no I/O, no Date.now()

import type { CatchUpDecision } from "./types.js";

/**
 * Decides what to do for a task after a scheduler restart.
 *
 * FR-063 four cases:
 *
 *   1. fired=true,  completed=false → skip (worker is in-flight; it handles the job)
 *   2. fired=true,  completed=true, withinValidity=true, dependents present
 *      → enqueue-dependents (task done, dependents didn't fire within window)
 *   3. fired=false, withinValidity=true → enqueue-standalone (missed fire, still valid)
 *   4. all other cases → skip (outside window or no actionable dependents)
 *
 * SC-007: 100% branch coverage required.
 *
 * @param fired           - true if the task was observed to have fired (marker present)
 * @param completed       - true if the task completed (completion marker present)
 * @param withinValidity  - true if the current time is still within task.validForMs of scheduled time
 * @param dependentIds    - ids of tasks that depend on this task (empty if none)
 */
export function decideCatchUp(
  fired: boolean,
  completed: boolean,
  withinValidity: boolean,
  dependentIds: readonly string[],
): CatchUpDecision {
  if (fired && !completed) {
    return { kind: "skip", reason: "task is in-flight; worker will complete it" };
  }
  if (fired && completed && withinValidity && dependentIds.length > 0) {
    return { kind: "enqueue-dependents", dependentIds };
  }
  if (!fired && withinValidity) {
    return { kind: "enqueue-standalone" };
  }
  return { kind: "skip", reason: "outside validity window or no actionable catch-up needed" };
}
