/**
 * Cache Keys — Pure key-building functions for DAG-namespaced Redis keys.
 *
 * Extracted from node-context-factory for proper FC/IS layering:
 * these functions are pure (no I/O) and belong in domain/.
 *
 * @satisfies FR-030 — Cache keys prefixed fugue:<dagId>:cache:<key>
 * @satisfies FR-031 — Checkpoint keys prefixed fugue:<dagId>:<runId>:<nodeId>
 * @satisfies SC-008 — Two DAGs using same cache key string are isolated
 */

/**
 * Build the Redis key prefix for cache entries of a specific DAG.
 * Format: fugue:<dagId>:cache:
 */
export const cacheKeyPrefix = (dagId: string): string =>
  `fugue:${dagId}:cache:`;

/**
 * Build the full cache key for a specific DAG and logical key.
 */
export const buildCacheKey = (dagId: string, key: string): string =>
  `${cacheKeyPrefix(dagId)}${key}`;

/**
 * Build the Redis key prefix for checkpoint entries.
 * Format: fugue:<dagId>:<runId>:
 */
export const checkpointKeyPrefix = (dagId: string, runId: string): string =>
  `fugue:${dagId}:${runId}:`;

/**
 * Build the full checkpoint key for a specific DAG, run, and node.
 * Format: fugue:<dagId>:<runId>:<nodeId>
 */
export const buildCheckpointKey = (dagId: string, runId: string, nodeId: string): string =>
  `${checkpointKeyPrefix(dagId, runId)}${nodeId}`;
