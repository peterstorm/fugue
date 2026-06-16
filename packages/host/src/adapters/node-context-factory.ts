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
 * @satisfies SC-008 (host spec: cross-DAG cache isolation) — Two DAGs using the
 *   same cache key string are isolated. NOT the identity-scoped-capabilities
 *   spec's SC-008 (token-mint dedup), which lives in token-cache.ts /
 *   keycloak-broker.ts — same tag, different spec namespace.
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
import type { InvocationOrigin } from "@fuguejs/framework";
import { makeNodeContext, ok } from "@fuguejs/framework";
import type { RegisteredDag } from "../domain/registry.js";
import type { AuthIdentity, AgentClientMap } from "../domain/auth.js";
import type { RedisPort, SharedInfra, LogPort } from "../ports.js";
import { extractClients } from "../domain/capability-manager.js";
import { invocationOriginForIdentity, subjectTokenForIdentity } from "../domain/run-context.js";
import type { NodeContextForDag } from "../domain/run-context.js";
import type { SubjectToken } from "../domain/auth.js";
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

// `NodeContextForDag` and the pure `invocationOriginForIdentity` moved to
// `domain/run-context.ts` — the contract of the `createContext` port belongs
// to the domain, not this adapter (the HTTP layer names it without importing
// adapter modules). Re-exported here for backward compatibility.
export { invocationOriginForIdentity };
export type { NodeContextForDag };

/**
 * Construct the BASE NodeContext for a specific DAG execution, plus the run's
 * `origin`.
 *
 * The base context carries the BOOT-SCOPED static capability clients
 * (`extractClients` over the registered handles — the single trust-boundary
 * cast; see capability-manager.ts) exactly as before. Per-invocation AUTHORITY
 * is layered on TOP of this base, per node, by the framework when a minting
 * broker is wired into `runDag` (the host selects the live Keycloak broker when
 * realm config is present): each node's declared `"<provider>:<operation>"`
 * scopes are minted into narrowed handles AT DISPATCH and merged over this base,
 * while plain capabilities (`http`/`db`/`llm`/…) keep their static client. When
 * no broker is wired (no realm config) the base context is used unchanged —
 * byte-identical to today (SC-005), zero regression.
 *
 * This is why the broker is NO LONGER consulted here: minting must happen
 * per-node (the only place the real `nodeId` and that node's `requires` are
 * known), so resolving it once at context-construction with empty `requires`
 * (the rejected eager-resolution design) could never reach the minting machinery
 * and silently dropped every statically-configured client on the realm path
 * (review C1).
 *
 * Pools stay boot-scoped (FR-W2-005): only authority resolution moved behind the
 * broker, and it now moves per node, in the framework.
 *
 * @satisfies FR-030 — Cache key isolation
 * @satisfies FR-031 — Checkpoint key isolation
 * @satisfies FR-032 — Per-request runId + AbortSignal
 * @satisfies FR-041 — Per-DAG TTL overrides
 * @satisfies SC-008 (host spec: cross-DAG cache isolation — not the
 *   identity-scoped-capabilities token-dedup SC-008)
 * @satisfies FR-W2-005 — pools (connect/close/healthCheck) remain boot-scoped
 * @satisfies FR-W3-007 — `origin` carries the user's `sub` so a user-initiated
 *   run is attributable and per-hop-exchangeable by the broker
 */
export const createNodeContextForDag = async (
  shared: SharedInfra,
  dag: RegisteredDag,
  runId: RunId,
  signal: AbortSignal,
  identity: AuthIdentity,
  /**
   * The DAG-id → REAL Keycloak agent-client-id map (FR-040, `AGENT_CLIENT_MAP`),
   * INJECTED from host config. Threaded into `invocationOriginForIdentity` so the
   * run `origin` carries the DAG's real agent client. A DAG id with NO mapping
   * resolves to `undefined` and FAILS CLOSED here (throws a wiring-defect error
   * caught by both run paths) rather than minting as an absent/wrong client.
   * Defaults to the empty map (every DAG fails closed) so an un-threaded caller is
   * safe-by-default.
   */
  agentClientMap: AgentClientMap = {},
  /**
   * HOST-SIDE side-channel sink for a user run's verified `subject_token`
   * (FR-030/FR-032). When the run is user-initiated, the factory binds
   * `runId → SubjectToken` here so the broker can resolve it for the RFC 8693
   * exchange — WITHOUT the token ever crossing the framework `InvocationOrigin`
   * (which stays string-only) or reaching a capability handle (NFR-011). Optional:
   * the no-broker / non-user paths pass nothing and behave byte-identically.
   */
  bindSubjectToken?: (runId: RunId, token: SubjectToken) => void,
): Promise<NodeContextForDag> => {
  const dagId = dag.id;
  const ttl = resolveTtl(dag);

  // Wrap the shared LLM client in a per-run metered decorator: every call is
  // attributed (dagId, runId, nodeId), aggregated, and budget-checked in-process
  // (no network round trip). When `llmBudgetTokens` is unset the decorator meters
  // but never refuses (FR-W1-006). One decorator per NodeContext → run-scoped
  // counter. @satisfies FR-W0-001 FR-W0-004 FR-W1-001..006 (FR-W2-009
  // groundwork only — LLM authority is run-scoped here, not yet on the
  // broker's mintFor seam; see capability-broker.ts)
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

  // FAIL CLOSED (FR-040): resolve the DAG's REAL agent client via AGENT_CLIENT_MAP.
  // An unmapped DAG id yields `undefined` — the run has no agent identity, so it
  // is refused here rather than minting as a fabricated/absent client. This throw
  // is an adapter-boundary wiring-defect surface (like `wifTokenEndpoint` /
  // `formatToken`); both run paths (`run-dag.ts`, `run-executor.ts`) fence the
  // `createNodeContextForDag` call, so it never escapes as an unhandled rejection.
  const origin: InvocationOrigin | undefined = invocationOriginForIdentity(
    agentClientMap,
    identity,
    dagId,
  );
  if (origin === undefined) {
    throw new Error(
      `createNodeContextForDag: DAG '${dagId}' has no agent client mapping in AGENT_CLIENT_MAP ` +
        `(FR-040 fail-closed) — refusing to run with an absent/fabricated agent identity`,
    );
  }

  // Thread the user's verified subject token HOST-SIDE (FR-032), but ONLY after
  // the fail-closed origin check above has passed — so a registered-but-unmapped
  // DAG throws BEFORE any token is bound, and we never retain a JWT under a runId
  // whose run will not proceed (the run-dag setup-error path does not release;
  // only `withSubjectTokenRelease` around `executeDag` does, NFR-014). Read it
  // off the identity via the pure seam (never off `InvocationOrigin`); an
  // agent/team/admin run has no subject token, so nothing is bound and the
  // broker's user exchange fails closed for any illegitimate user hop claiming
  // this runId. The raw token is carried only through this sink.
  if (bindSubjectToken !== undefined) {
    const subjectToken = subjectTokenForIdentity(identity);
    if (subjectToken !== undefined) bindSubjectToken(runId, subjectToken);
  }

  const ctx = makeNodeContext({
    runId,
    dagId,
    tracer: shared.tracer,
    llm,
    cache,
    checkpointWriter,
    signal,
    contentFilter: shared.contentFilter,
    prompts: promptAccess,
    // The boot-scoped static client set. Per-node minted scope handles (when a
    // broker is wired) are merged OVER this by the framework at dispatch.
    capabilities: extractClients(shared.capabilities),
  });

  return { ctx, origin };
};
