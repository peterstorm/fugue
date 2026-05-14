// Test helpers for branded IDs.
// Use these instead of raw string literals in tests where NodeId/RunId/DagId is expected.

import type { NodeId, RunId, DagId } from "../types/ids.js";
import { __brandNodeId, __brandRunId, __brandDagId } from "../types/ids.js";

/** Brand a string as `NodeId` — test shorthand, skips regex validation. */
export const N = (s: string): NodeId => __brandNodeId(s);

/** Brand a string as `RunId` — test shorthand, skips regex validation. */
export const R = (s: string): RunId => __brandRunId(s);

/** Brand a string as `DagId` — test shorthand, skips regex validation. */
export const D = (s: string): DagId => __brandDagId(s);

/**
 * Create a `Map<NodeId, V>` from string-keyed entries. Test convenience so
 * fixture maps don't need `N()` on every key.
 */
export const nodeMap = <V>(entries: readonly (readonly [string, V])[]): Map<NodeId, V> =>
  new Map(entries.map(([k, v]) => [N(k), v]));

/**
 * Create a `Set<NodeId>` from string entries.
 */
export const nodeSet = (ids: readonly string[]): Set<NodeId> =>
  new Set(ids.map(N));
