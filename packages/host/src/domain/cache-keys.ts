/**
 * Cache Keys — Pure key-building functions for TENANT-and-DAG-namespaced Redis keys.
 *
 * Extracted from node-context-factory for proper FC/IS layering:
 * these functions are pure (no I/O) and belong in domain/.
 *
 * SECURITY INVARIANT (load-bearing for AD-4 / US2 / SC-001):
 *   EVERY key produced here is prefixed `fugue:<tenant>:…`. A per-tenant Redis
 *   ACL user is scoped to `~fugue:<tenant>:*`; that scoping is only SOUND if no
 *   key built here can escape the tenant prefix. `TenantId` is therefore a
 *   REQUIRED, hard-branded first argument on every builder — a bare string does
 *   not satisfy it, so a caller cannot accidentally emit an unscoped key.
 *
 * @satisfies FR-013 — Per-tenant cache/checkpoint isolation; the dagId-prefixed
 *   scheme is preserved BENEATH the tenant prefix so per-DAG scoping continues
 *   to hold WITHIN a tenant.
 * @satisfies SC-008 (host spec) — Two DAGs using the same cache key string are
 *   isolated (now also across tenants).
 */

import type { DagId, RunId, NodeId } from "@fuguejs/framework";

// `TenantId` is the SINGLE canonical, hard-branded tenant identifier defined in
// `./tenant` (the supervisor's resolved security principal). Importing the type
// here — rather than re-declaring a structurally-identical brand — keeps exactly
// one `unique symbol` brand in the codebase, so the routed `Tenant.id` the
// supervisor resolves at the boundary is the SAME type the key builders demand.
// A second local brand would be nominally incompatible and would silently break
// the moment a real resolved `TenantId` was passed into a builder.
import type { TenantId } from "./tenant.js";

export type { TenantId };

// ── Tenant prefix chokepoint ─────────────────────────────────────────────────

/**
 * The SINGLE definition site of the `fugue:<tenant>:` namespace prefix. EVERY
 * key builder below routes through this helper, so the load-bearing
 * `fugue:<tenant>:` invariant (AD-4 / US2 / SC-001) has exactly ONE place it is
 * spelled. A future builder physically cannot emit an unscoped key without
 * either calling this or duplicating it (which review would catch). The
 * `TenantId` argument is hard-branded, so a bare string cannot reach it.
 */
const tenantPrefix = (t: TenantId): string => `fugue:${t}:`;

// ── Key Builders (every key carries the tenant prefix) ──────────────────────

/**
 * Build the Redis key prefix for cache entries of a specific tenant + DAG.
 * Format: `fugue:<tenant>:<dagId>:cache:`
 */
export const cacheKeyPrefix = (tenant: TenantId, dagId: DagId): string =>
  `${tenantPrefix(tenant)}${dagId}:cache:`;

/**
 * Build the full cache key for a specific tenant, DAG, and logical key.
 * Format: `fugue:<tenant>:<dagId>:cache:<key>`
 */
export const buildCacheKey = (tenant: TenantId, dagId: DagId, key: string): string =>
  `${cacheKeyPrefix(tenant, dagId)}${key}`;

/**
 * Build the Redis key prefix for checkpoint entries.
 * Format: `fugue:<tenant>:<dagId>:<runId>:`
 */
export const checkpointKeyPrefix = (tenant: TenantId, dagId: DagId, runId: RunId): string =>
  `${tenantPrefix(tenant)}${dagId}:${runId}:`;

/**
 * Build the full checkpoint key for a specific tenant, DAG, run, and node.
 * Format: `fugue:<tenant>:<dagId>:<runId>:<nodeId>`
 */
export const buildCheckpointKey = (
  tenant: TenantId,
  dagId: DagId,
  runId: RunId,
  nodeId: NodeId,
): string => `${checkpointKeyPrefix(tenant, dagId, runId)}${nodeId}`;
