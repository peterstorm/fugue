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

import { compositeNodeKey } from "@fuguejs/framework";
import type { DagId, RunId, NodeId, MappedChildScope } from "@fuguejs/framework";

// `TenantId` is the SINGLE canonical, hard-branded tenant identifier defined in
// `./tenant-id` (the supervisor's resolved security principal). Importing the type
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
 * Build the full checkpoint key for a specific tenant, DAG, run, and node —
 * optionally addressing a mapped child's node output by map, index and parent
 * execution epoch using the existing composite codec (ADR-0075/0085).
 *
 * Canonical: `fugue:<tenant>:<rootDag>:<run>:<node>` (byte-identical, FR-F1-008).
 * Mapped: `fugue:<tenant>:<rootDag>:<run>:<map>@<node>@<index>@<epoch>`.
 * Structural child DAG identity never rebinds the host's root resource namespace.
 * `@` is outside NodeId's grammar; `$meta`, `$nodes` and `$spend` stay disjoint.
 */
export const buildCheckpointKey = (
  tenant: TenantId,
  dagId: DagId,
  runId: RunId,
  nodeId: NodeId,
  scope?: MappedChildScope,
): string => {
  const address = scope === undefined
    ? nodeId
    : compositeNodeKey(nodeId, {
        namespace: scope.mapNodeId,
        index: scope.index,
        attempt: scope.executionEpoch,
      });
  return `${checkpointKeyPrefix(tenant, dagId, runId)}${address}`;
};

/**
 * Build the Redis STRING key holding one run's checkpoint METADATA record
 * (`RunMeta` plus the write time the FR-027 expiry gate is measured from).
 *
 * Format: `fugue:<tenant>:<dagId>:<runId>:$meta`
 *
 * `$` carries the same weight it does in `buildCheckpointKey` and
 * `buildSpendKey`: it is outside `NodeId`'s grammar (`[A-Za-z0-9_:-]`), so this
 * key is provably disjoint from every canonical and indexed node key beneath
 * the same prefix. No node can be named `$meta`.
 */
export const buildCheckpointMetaKey = (tenant: TenantId, dagId: DagId, runId: RunId): string =>
  `${checkpointKeyPrefix(tenant, dagId, runId)}$meta`;

/**
 * Build the ONE Redis HASH key holding a run's readable node entries, keyed by
 * the framework's stored node address (the bare `nodeId`, or the composite
 * `namespace@nodeId@index@attempt` of ADR-0075).
 *
 * Format: `fugue:<tenant>:<dagId>:<runId>:$nodes`
 *
 * WHY A HASH, next to the per-node STRING keys `buildCheckpointKey` already
 * produces: `Checkpointer.load` must return EVERY entry for a run, and the only
 * enumeration primitive that survives the per-tenant ACL is a read of one key
 * (`scan` is denied on the worker credential — see `ports.ts`). One HGETALL of
 * one key is that read. The two live side by side deliberately: the string keys
 * are the write-only `CheckpointWriter`'s existing address space and stay
 * byte-identical (FR-F1-008), while this hash is the readable one a partial fan
 * resumes from.
 */
export const buildCheckpointNodesKey = (tenant: TenantId, dagId: DagId, runId: RunId): string =>
  `${checkpointKeyPrefix(tenant, dagId, runId)}$nodes`;

/**
 * Build the ONE Redis HASH key holding a run's durable spend.
 *
 * Numeric axes and reserved unpriced-model marker fields share this aggregate,
 * so hydration is one HGETALL and retention is one key TTL. `$` remains
 * load-bearing: it is outside `NodeId`'s grammar, preventing collision with a
 * checkpoint written through Redis `SET` beneath the same prefix.
 *
 * Format: `fugue:<tenant>:<dagId>:<runId>:$spend`
 */
export const buildSpendKey = (tenant: TenantId, dagId: DagId, runId: RunId): string =>
  `${checkpointKeyPrefix(tenant, dagId, runId)}$spend`;
