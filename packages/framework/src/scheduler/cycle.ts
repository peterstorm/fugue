// Cycle detection — FR-061
// Pure function: no I/O, no Date.now()

import type { TaskRegistry } from "./types.js";

/**
 * Returns true if `startId` is part of a dependency cycle in `registry`.
 *
 * Uses iterative DFS with a visited + recursion-stack set to detect back-edges.
 * A task with no entry in the registry is treated as a leaf (no outgoing edges).
 *
 * FR-061: hasCycle(taskId, registry)
 */
export function hasCycle(startId: string, registry: TaskRegistry): boolean {
  // We need to detect if startId participates in ANY cycle reachable from it.
  // Strategy: run DFS from startId; if we ever re-visit a node on the current
  // recursion path, a cycle exists.

  const visited = new Set<string>();
  const onStack = new Set<string>();

  function dfs(id: string): boolean {
    if (onStack.has(id)) return true;   // back-edge → cycle
    if (visited.has(id)) return false;  // already fully explored, no cycle here

    visited.add(id);
    onStack.add(id);

    const task = registry.get(id);
    if (task?.dependsOn) {
      for (const dep of task.dependsOn) {
        if (dfs(dep)) return true;
      }
    }

    onStack.delete(id);
    return false;
  }

  return dfs(startId);
}
