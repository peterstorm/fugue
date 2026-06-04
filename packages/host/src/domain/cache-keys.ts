/**
 * Cache Keys — Pure key-building functions for DAG-namespaced Redis keys.
 *
 * Extracted from node-context-factory for proper FC/IS layering:
 * these functions are pure (no I/O) and belong in domain/.
 *
 * @satisfies FR-031 — Auto-namespace all Redis keys by DAG ID
 * @satisfies SC-008 — Two DAGs using same cache key string are isolated
 */

import type { DagId, RunId, NodeId } from "@fuguejs/framework";

/**
 * Build the Redis key prefix for cache entries of a specific DAG.
 * Format: fugue:<dagId>:cache:
 */
export const cacheKeyPrefix = (dagId: DagId): string =>
  `fugue:${dagId}:cache:`;

/**
 * Build the full cache key for a specific DAG and logical key.
 */
export const buildCacheKey = (dagId: DagId, key: string): string =>
  `${cacheKeyPrefix(dagId)}${key}`;

/**
 * Build the Redis key prefix for checkpoint entries.
 * Format: fugue:<dagId>:<runId>:
 */
export const checkpointKeyPrefix = (dagId: DagId, runId: RunId): string =>
  `fugue:${dagId}:${runId}:`;

/**
 * Build the full checkpoint key for a specific DAG, run, and node.
 * Format: fugue:<dagId>:<runId>:<nodeId>
 */
export const buildCheckpointKey = (dagId: DagId, runId: RunId, nodeId: NodeId): string =>
  `${checkpointKeyPrefix(dagId, runId)}${nodeId}`;
