/**
 * NodeContext Factory — constructs per-request NodeContext instances.
 *
 * Key responsibilities:
 * - DAG-namespaced Redis key prefixes for cache and checkpoint isolation (FR-030, FR-031)
 * - Fresh runId + independent AbortSignal per request (FR-032)
 * - Per-DAG TTL overrides for cache/checkpoint entries (FR-041)
 * - Shared infrastructure (LLM, tracer) passed through without per-request init
 *
 * @satisfies FR-031 — Cache keys prefixed fugue:<dagId>:cache:<key>
 * @satisfies FR-031 — Checkpoint keys prefixed fugue:<dagId>:<runId>:<nodeId>
 * @satisfies FR-032 — Each request gets unique runId and independent AbortSignal
 * @satisfies FR-041 — Per-DAG TTL overrides apply to cache/checkpoint entries
 * @satisfies SC-008 — Two DAGs using same cache key string are isolated
 */

import type {
  NodeContext,
  ContextCacheAdapter,
  CheckpointWriter,
  CacheLookup,
  LlmClient,
  Tracer,
  DagId,
  RunId,
  NodeId,
  Result,
  FrameworkError,
} from "@fugue/framework";
import { makeNodeContext, ok } from "@fugue/framework";
import type { RegisteredDag } from "../domain/registry.js";
import type { RedisPort, SharedInfra, LogPort } from "../ports.js";
import { extractClients } from "../domain/capability-manager.js";


// ── Types ──────────────────────────────────────────────────────────────────

/**
 * TTL configuration resolved for a specific DAG — combines host defaults
 * with per-DAG overrides from fugue.yaml.
 */
export interface ResolvedTtl {
  readonly cacheTtlSec: number | undefined;
  readonly checkpointTtlSec: number | undefined;
}

// ── Key Prefixing (delegated to domain/cache-keys.ts) ─────────────────────

export { cacheKeyPrefix, buildCacheKey, checkpointKeyPrefix, buildCheckpointKey } from "../domain/cache-keys.js";
import { buildCacheKey, buildCheckpointKey } from "../domain/cache-keys.js";

// ── Adapters (wrap Redis with namespacing) ─────────────────────────────────

/**
 * Create a ContextCacheAdapter that prefixes all keys with DAG namespace.
 * Applies per-DAG TTL override when set is called without an explicit TTL.
 *
 * @satisfies FR-031 — Keys prefixed with DAG namespace
 * @satisfies FR-041 — Per-DAG TTL override applied
 */
export const createNamespacedCache = (
  redis: RedisPort,
  dagId: DagId,
  defaultTtlSec: number | undefined,
  logger: LogPort,
): ContextCacheAdapter => {
  let consecutiveGetFailures = 0;
  let consecutiveSetFailures = 0;
  const FAILURE_ESCALATION_THRESHOLD = 10;

  return {
    get: async (key: string): Promise<CacheLookup> => {
      const fullKey = buildCacheKey(dagId, key);
      const result = await redis.get(fullKey);
      if (!result.ok) {
        consecutiveGetFailures++;
        if (consecutiveGetFailures >= FAILURE_ESCALATION_THRESHOLD) {
          logger.error("Cache get failures exceeded threshold — Redis may be degraded", {
            key: fullKey, dagId, consecutiveFailures: consecutiveGetFailures,
          });
        } else {
          logger.warn("Cache get failed — graceful degradation to miss", {
            key: fullKey, dagId, error: result.error.kind,
          });
        }
        return { hit: false };
      }
      consecutiveGetFailures = 0;
      const raw = result.value;
      if (raw === null) return { hit: false };
      try {
        return { hit: true, value: JSON.parse(raw) };
      } catch (e) {
        // Corrupted entry — treat as miss
        logger.warn("Cache entry corrupted — treating as miss", {
          key: fullKey,
          dagId,
          rawPreview: raw?.slice(0, 100),
          parseError: e instanceof Error ? e.message : String(e),
        });
        return { hit: false };
      }
    },

    /**
     * DESIGN: Cache writes are best-effort. Failures are logged but never propagated
     * to callers via the Result return. Returning err() would abort the DAG run for
     * a non-critical cache failure — worse than stale data.
     *
     * The return type `Promise<Result<void, FrameworkError>>` is dictated by the
     * framework's ContextCacheAdapter interface — we cannot narrow it to `Promise<void>`.
     * Callers should NOT pattern-match on the error branch; it is never populated.
     */
    set: async (
      key: string,
      value: unknown,
      ttlSec?: number,
    ): Promise<Result<void, FrameworkError>> => {
      const fullKey = buildCacheKey(dagId, key);
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch (e) {
        logger.warn("Cache set failed — value not serializable", { key: fullKey, dagId, error: e instanceof Error ? e.message : String(e) });
        return ok(undefined); // Don't kill the request for a cache write failure
      }
      const effectiveTtl = ttlSec ?? defaultTtlSec;
      const setResult = effectiveTtl !== undefined
        ? await redis.set(fullKey, serialized, { expiresInSec: effectiveTtl })
        : await redis.set(fullKey, serialized);
      if (!setResult.ok) {
        consecutiveSetFailures++;
        if (consecutiveSetFailures >= FAILURE_ESCALATION_THRESHOLD) {
          logger.error("Cache set failures exceeded threshold — Redis may be degraded", {
            key: fullKey, dagId, consecutiveFailures: consecutiveSetFailures,
          });
        } else {
          logger.warn("Cache set failed — Redis error", { key: fullKey, dagId, error: setResult.error.kind });
        }
      } else {
        consecutiveSetFailures = 0;
      }
      return ok(undefined);
    },
  };
};

/**
 * Create a CheckpointWriter that prefixes all keys with DAG + run namespace.
 * Applies per-DAG checkpoint TTL.
 *
 * @satisfies FR-031 — Keys prefixed with DAG + run namespace
 * @satisfies FR-041 — Per-DAG checkpoint TTL applied
 */
export const createNamespacedCheckpointWriter = (
  redis: RedisPort,
  dagId: DagId,
  runId: RunId,
  checkpointTtlSec: number | undefined,
  logger: LogPort,
): CheckpointWriter => ({
  write: async (_runId: RunId, nodeId: NodeId, value: unknown): Promise<void> => {
    const fullKey = buildCheckpointKey(dagId, runId, nodeId);
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (e) {
      logger.warn("Checkpoint write failed — value not serializable", { key: fullKey, dagId, runId, nodeId: nodeId as string, error: e instanceof Error ? e.message : String(e) });
      return; // Best-effort — don't kill the DAG execution
    }
    const setResult = checkpointTtlSec !== undefined
      ? await redis.set(fullKey, serialized, { expiresInSec: checkpointTtlSec })
      : await redis.set(fullKey, serialized);
    if (!setResult.ok) {
      logger.warn("Checkpoint write failed — Redis error", { key: fullKey, dagId, runId, nodeId: nodeId as string, error: setResult.error.kind });
      // Best-effort — don't kill the DAG execution
    }
  },
});

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Resolve TTL values for a DAG — per-DAG overrides (from fugue.yaml) take
 * precedence. Values converted from ms (config) to seconds (Redis EX).
 *
 * @satisfies FR-041
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
 * @satisfies FR-041 — Per-DAG TTL overrides
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

  const cache = createNamespacedCache(shared.redis, dagId, ttl.cacheTtlSec, shared.logger);
  const checkpointWriter = createNamespacedCheckpointWriter(
    shared.redis,
    dagId,
    runId,
    ttl.checkpointTtlSec,
    shared.logger,
  );

  // Per-DAG prompts take precedence; fall back to shared (host-level) prompts.
  const dagPrompts = dag.prompts;
  const promptAccess = dagPrompts.size > 0
    ? { get: (name: string) => dagPrompts.get(name) ?? null }
    : shared.prompts ?? { get: () => null };

  return makeNodeContext({
    runId,
    dagId,
    tracer: shared.tracer,
    llm: shared.llm,
    cache,
    checkpointWriter,
    signal,
    contentFilter: shared.contentFilter,
    prompts: promptAccess,
    // ADR-0051: Custom capability clients from registered handles are passed
    // via the capabilities record. The type cast is sound because
    // `extractClients` returns the exact client instances from typed handles.
    capabilities: extractClients(shared.capabilities) as unknown as Record<string, never>,
  });
};
