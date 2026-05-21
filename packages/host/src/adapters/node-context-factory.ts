/**
 * NodeContext Factory — constructs per-request NodeContext instances.
 *
 * Key responsibilities:
 * - DAG-namespaced Redis key prefixes for cache and checkpoint isolation (FR-030, FR-031)
 * - Fresh runId + independent AbortSignal per request (FR-032)
 * - Per-DAG TTL overrides for cache/checkpoint entries (FR-042)
 * - Shared infrastructure (LLM, tracer) passed through without per-request init
 *
 * @satisfies FR-030 — Cache keys prefixed fugue:<dagId>:cache:<key>
 * @satisfies FR-031 — Checkpoint keys prefixed fugue:<dagId>:<runId>:<nodeId>
 * @satisfies FR-032 — Each request gets unique runId and independent AbortSignal
 * @satisfies FR-042 — Per-DAG TTL overrides apply to cache/checkpoint entries
 * @satisfies SC-008 — Two DAGs using same cache key string are isolated
 */

import type {
  NodeContext,
  ContextCacheAdapter,
  CheckpointWriter,
  CacheLookup,
  LlmClient,
  Tracer,
  RunId,
  NodeId,
  Result,
  FrameworkError,
} from "@fugue/framework";
import { makeNodeContext, ok } from "@fugue/framework";
import type { RegisteredDag } from "../domain/registry.js";
import type { ContentFilter } from "@fugue/framework";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Redis-like interface — only the methods we actually use.
 * Avoids coupling to a specific Redis client library.
 */
export interface RedisPort {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string, ...args: string[]) => Promise<string | null>;
}

/**
 * Shared infrastructure singletons — initialized once at host startup.
 * Passed by reference into every NodeContext (no per-request allocation).
 */
export interface SharedInfra {
  readonly llm: LlmClient;
  readonly redis: RedisPort;
  readonly tracer: Tracer;
  readonly contentFilter: ContentFilter | null;
}

/**
 * TTL configuration resolved for a specific DAG — combines host defaults
 * with per-DAG overrides from fugue.yaml.
 */
export interface ResolvedTtl {
  readonly cacheTtlSec: number | undefined;
  readonly checkpointTtlSec: number | undefined;
}

// ── Key Prefixing (pure) ───────────────────────────────────────────────────

/**
 * Build the Redis key prefix for cache entries of a specific DAG.
 * Format: fugue:<dagId>:cache:<key>
 *
 * @satisfies FR-030
 * @satisfies SC-008 — Each DAG gets its own namespace; same logical key in two DAGs -> different Redis keys
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
 *
 * @satisfies FR-031
 */
export const checkpointKeyPrefix = (dagId: string, runId: string): string =>
  `fugue:${dagId}:${runId}:`;

/**
 * Build the full checkpoint key for a specific DAG, run, and node.
 * Format: fugue:<dagId>:<runId>:<nodeId>
 */
export const buildCheckpointKey = (dagId: string, runId: string, nodeId: string): string =>
  `${checkpointKeyPrefix(dagId, runId)}${nodeId}`;

// ── Adapters (wrap Redis with namespacing) ─────────────────────────────────

/**
 * Create a ContextCacheAdapter that prefixes all keys with DAG namespace.
 * Applies per-DAG TTL override when set is called without an explicit TTL.
 *
 * @satisfies FR-030 — Keys prefixed with DAG namespace
 * @satisfies FR-042 — Per-DAG TTL override applied
 */
export const createNamespacedCache = (
  redis: RedisPort,
  dagId: string,
  defaultTtlSec: number | undefined,
): ContextCacheAdapter => ({
  get: async (key: string): Promise<CacheLookup> => {
    const fullKey = buildCacheKey(dagId, key);
    const raw = await redis.get(fullKey);
    if (raw === null) return { hit: false };
    try {
      return { hit: true, value: JSON.parse(raw) };
    } catch {
      // Corrupted entry — treat as miss
      return { hit: false };
    }
  },

  set: async (
    key: string,
    value: unknown,
    ttlSec?: number,
  ): Promise<Result<void, FrameworkError>> => {
    const fullKey = buildCacheKey(dagId, key);
    const serialized = JSON.stringify(value);
    const effectiveTtl = ttlSec ?? defaultTtlSec;

    if (effectiveTtl !== undefined) {
      await redis.set(fullKey, serialized, "EX", String(effectiveTtl));
    } else {
      await redis.set(fullKey, serialized);
    }
    return ok(undefined);
  },
});

/**
 * Create a CheckpointWriter that prefixes all keys with DAG + run namespace.
 * Applies per-DAG checkpoint TTL.
 *
 * @satisfies FR-031 — Keys prefixed with DAG + run namespace
 * @satisfies FR-042 — Per-DAG checkpoint TTL applied
 */
export const createNamespacedCheckpointWriter = (
  redis: RedisPort,
  dagId: string,
  runId: string,
  checkpointTtlSec: number | undefined,
): CheckpointWriter => ({
  write: async (_runId: RunId, nodeId: NodeId, value: unknown): Promise<void> => {
    const fullKey = buildCheckpointKey(dagId, runId, nodeId as string);
    const serialized = JSON.stringify(value);

    if (checkpointTtlSec !== undefined) {
      await redis.set(fullKey, serialized, "EX", String(checkpointTtlSec));
    } else {
      await redis.set(fullKey, serialized);
    }
  },
});

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Resolve TTL values for a DAG — per-DAG overrides (from fugue.yaml) take
 * precedence. Values converted from ms (config) to seconds (Redis EX).
 *
 * @satisfies FR-042
 */
export const resolveTtl = (dag: RegisteredDag): ResolvedTtl => {
  const cacheTtlMs = dag.config.cacheTtlMs;
  const checkpointTtlMs = dag.config.checkpointTtlMs;

  return {
    cacheTtlSec: cacheTtlMs !== undefined ? Math.ceil(cacheTtlMs / 1000) : undefined,
    checkpointTtlSec: checkpointTtlMs !== undefined ? Math.ceil(checkpointTtlMs / 1000) : undefined,
  };
};

/**
 * Construct a NodeContext for a specific DAG execution.
 *
 * Pure factory: given inputs, constructs context deterministically.
 * - Shared infra (LLM, tracer) -> passed through as singleton references
 * - Cache -> wrapped with DAG-namespaced key prefix
 * - Checkpoint -> wrapped with DAG + run namespaced key prefix
 * - runId, signal -> per-request unique values
 *
 * @satisfies FR-030 — Cache key isolation
 * @satisfies FR-031 — Checkpoint key isolation
 * @satisfies FR-032 — Per-request runId + AbortSignal
 * @satisfies FR-042 — Per-DAG TTL overrides
 * @satisfies SC-008 — Cross-DAG cache isolation
 */
export const createNodeContextForDag = (
  shared: SharedInfra,
  dag: RegisteredDag,
  runId: RunId,
  signal: AbortSignal,
): NodeContext => {
  const dagId = dag.id;
  const ttl = resolveTtl(dag);

  const cache = createNamespacedCache(shared.redis, dagId, ttl.cacheTtlSec);
  const checkpointWriter = createNamespacedCheckpointWriter(
    shared.redis,
    dagId,
    runId,
    ttl.checkpointTtlSec,
  );

  return makeNodeContext({
    runId,
    dagId,
    tracer: shared.tracer,
    llm: shared.llm,
    cache,
    checkpointWriter,
    signal,
    contentFilter: shared.contentFilter,
  });
};
