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
} from "@fuguejs/framework";
import type { Invocation, InvocationOrigin } from "@fuguejs/framework";
import { makeNodeContext, ok, createPassthroughBroker, nodeId as makeNodeId } from "@fuguejs/framework";
import { match } from "ts-pattern";
import type { RegisteredDag } from "../domain/registry.js";
import type { AuthIdentity } from "../domain/auth.js";
import type { RedisPort, SharedInfra, LogPort } from "../ports.js";
import { extractClients } from "../domain/capability-manager.js";
import { createMeteredLlm } from "./metered-llm.js";


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
 * Build the `Invocation.origin` for a run from its resolved inbound identity
 * (FR-W3-007). PURE and exported so the sub-threading is directly assertable
 * without standing up the whole context factory:
 *
 *  - `user`  → `{ kind: "user", sub, agentClientId: azp }`. The user's `sub`
 *    lands on the origin verbatim; `azp` is the authorized agent client. This
 *    is the case that was previously dead-ended (every user run mis-attributed
 *    as `agent`).
 *  - `team` / `admin` → `{ kind: "agent", agentClientId: dagId }`. There is no
 *    user subject for these, so the agent placeholder keyed on the DAG id stands
 *    in — identical to the pre-fix behaviour.
 *
 * Exhaustive over `AuthIdentity`; a new identity kind is a compile error here.
 */
export const invocationOriginForIdentity = (
  identity: AuthIdentity,
  dagId: DagId,
): InvocationOrigin =>
  match(identity)
    .with({ kind: "user" }, (u) => ({ kind: "user" as const, sub: u.sub, agentClientId: u.azp }))
    .with({ kind: "team" }, () => ({ kind: "agent" as const, agentClientId: dagId }))
    .with({ kind: "admin" }, () => ({ kind: "agent" as const, agentClientId: dagId }))
    .exhaustive();

/**
 * Construct a NodeContext for a specific DAG execution.
 *
 * Given inputs, constructs context deterministically.
 * - Shared infra (LLM, tracer) -> passed through as singleton references
 * - Cache -> wrapped with DAG-namespaced key prefix
 * - Checkpoint -> wrapped with DAG + run namespaced key prefix
 * - runId, signal -> per-request unique values
 * - capabilities -> resolved through a `CapabilityBroker` (pass-through default,
 *   reproducing today's behavior byte-identically). `async` because brokers in
 *   later waves reach a token endpoint; the pass-through default does no I/O.
 *
 * @satisfies FR-030 — Cache key isolation
 * @satisfies FR-031 — Checkpoint key isolation
 * @satisfies FR-032 — Per-request runId + AbortSignal
 * @satisfies FR-041 — Per-DAG TTL overrides
 * @satisfies SC-008 — Cross-DAG cache isolation
 * @satisfies FR-W2-003 — capabilities now flow through a broker; the pass-through
 *   default preserves byte-identical client behavior with zero migration steps
 * @satisfies FR-W2-005 — only authority resolution moved behind the broker;
 *   pools (connect/close/healthCheck) remain boot-scoped and untouched
 * @satisfies SC-005 — pass-through broker hands back the exact `extractClients`
 *   client references
 */
export const createNodeContextForDag = async (
  shared: SharedInfra,
  dag: RegisteredDag,
  runId: RunId,
  signal: AbortSignal,
  identity: AuthIdentity,
): Promise<NodeContext> => {
  const dagId = dag.id;
  const ttl = resolveTtl(dag);

  // Wrap the shared LLM client in a per-run metered decorator: every call is
  // attributed (dagId, runId, nodeId), aggregated, and budget-checked in-process
  // (no network round trip). When `llmBudgetTokens` is unset the decorator meters
  // but never refuses (FR-W1-006). One decorator per NodeContext → run-scoped
  // counter. @satisfies FR-W0-001 FR-W0-004 FR-W1-001..006 FR-W2-009
  const llm = createMeteredLlm(shared.llm, {
    dagId,
    runId,
    ...(dag.config.llmBudgetTokens !== undefined ? { budget: dag.config.llmBudgetTokens } : {}),
    logger: shared.logger,
  });

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

  // ADR-0051 / per-invocation authority axis: custom capability clients from
  // registered handles are resolved through a `CapabilityBroker`, not passed to
  // `makeNodeContext` directly. The pass-through default reproduces today's
  // behavior exactly — it hands back the SAME client references `extractClients`
  // produced (the single trust-boundary cast; see capability-manager.ts). Later
  // waves swap in a host broker that mints narrowly-scoped clients per
  // invocation; the seam is the only thing that changes here, not the wiring.
  //
  // Pools stay boot-scoped (FR-W2-005): only authority resolution moved behind
  // the broker. `Invocation.origin` is now built FROM the resolved inbound
  // identity (FR-W3-007): an OIDC `user` carries its `sub` (and `azp` as the
  // authorized agent client) so attribution is correct; `team`/`admin` runs map
  // to the agent placeholder keyed on `dagId`, preserving prior behaviour. The
  // pass-through broker still ignores origin, so runtime behaviour is unchanged
  // — only attribution becomes honest. `nodeId` is run-scoped context here (not
  // per-node), so a stable sentinel stands in.
  const origin: InvocationOrigin = invocationOriginForIdentity(identity, dagId);
  const broker = createPassthroughBroker(extractClients(shared.capabilities));
  const invocation: Invocation = {
    origin,
    runId,
    dagId,
    nodeId: makeNodeId("__run__"),
  };
  const minted = await broker.mintFor(invocation, []);
  if (!minted.ok) {
    // Impossible for the pass-through broker (it never returns Err). Fail loudly
    // on this internal-invariant violation rather than silently falling back —
    // a non-pass-through broker reaching here is a wiring bug, not a runtime
    // condition to swallow.
    throw new Error(
      `createNodeContextForDag: capability broker returned Err for dag '${dagId}' run '${runId}' — ` +
        `the pass-through broker never fails; this is an internal wiring invariant violation. ` +
        `error.kind=${minted.error.kind}`,
    );
  }

  return makeNodeContext({
    runId,
    dagId,
    tracer: shared.tracer,
    llm,
    cache,
    checkpointWriter,
    signal,
    contentFilter: shared.contentFilter,
    prompts: promptAccess,
    capabilities: minted.value,
  });
};
