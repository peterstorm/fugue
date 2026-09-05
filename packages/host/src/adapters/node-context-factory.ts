/**
 * NodeContext Factory — constructs per-request NodeContext instances.
 *
 * Key responsibilities:
 * - Tenant-and-DAG-namespaced Redis key prefixes for cache and checkpoint isolation (FR-013)
 * - Caller-supplied run identity + AbortSignal threaded into each context (FR-032)
 * - Per-DAG TTL overrides for cache/checkpoint entries (FR-041)
 * - Shared underlying clients reused; per-run metering decorators and budget state allocated
 *
 * @satisfies FR-013 — Cache keys prefixed fugue:<tenant>:<dagId>:cache:<key>
 * @satisfies FR-013 — Checkpoint keys prefixed fugue:<tenant>:<dagId>:<runId>:<nodeId>
 * @satisfies FR-032 — Caller-created runId and AbortSignal are threaded unchanged
 * @satisfies FR-041 — Per-DAG TTL overrides apply to cache/checkpoint entries
 * @satisfies SC-008 (host spec: cross-DAG cache isolation) — Two DAGs using the
 *   same cache key string are isolated. NOT the identity-scoped-capabilities
 *   spec's SC-008 (token-mint dedup), which lives in token-cache.ts /
 *   keycloak-broker.ts — same tag, different spec namespace.
 */

import { isDeepStrictEqual } from "node:util";
import type {
  ContextCacheAdapter,
  CheckpointWriter,
  CacheLookup,
  DagId,
  RunId,
  NodeId,
  Result,
  FrameworkError,
  Ceilings,
  InvocationOrigin,
} from "@fuguejs/framework";
import {
  err,
  fromJson,
  makeNodeContext,
  ok,
  isErr,
  parseSpend,
  safeErrorMessage,
  toJson,
} from "@fuguejs/framework";
import { assertLosslessEvent } from "@fuguejs/framework/file";
import type { RegisteredDag } from "../domain/registry.js";
import type { AuthIdentity, AgentClientMap } from "../domain/auth.js";
import type { RedisPort, SharedInfra, LogPort, SpendLedgerPort } from "../ports.js";
import {
  extractClients,
  runScopedLlmFacade,
} from "../domain/capability-manager.js";
import { invocationOriginForIdentity, subjectTokenForIdentity } from "../domain/run-context.js";
import type { NodeContextForDag } from "../domain/run-context.js";
import type { SubjectToken } from "../domain/auth.js";
import { createMeteredLlm } from "./metered-llm.js";
import { createRunSpendAuthority } from "./run-spend-authority.js";
import type { HydratedSpend } from "./run-spend-authority.js";
import { ceilingsOf } from "../domain/llm-budget.js";
import { createRedisSpendLedger, spendLedgerRedis } from "./spend-ledger-redis.js";
import { logWithoutThrowing } from "../hitl/diagnostic-logging.js";


// ── Types ──────────────────────────────────────────────────────────────────

/**
 * TTL configuration resolved solely from one DAG's fugue.yaml overrides.
 */
interface ResolvedTtl {
  readonly cacheTtlSec: number | undefined;
  readonly checkpointTtlSec: number | undefined;
}

// ── Key Prefixing (delegated to domain/cache-keys.ts) ─────────────────────

export { cacheKeyPrefix, buildCacheKey, checkpointKeyPrefix, buildCheckpointKey } from "../domain/cache-keys.js";
import { buildCacheKey, buildCheckpointKey, buildSpendKey } from "../domain/cache-keys.js";
import type { TenantId } from "../domain/cache-keys.js";
import { tenantId } from "../domain/tenant.js";
import { formatHostError } from "../domain/host-error.js";
import type { HostError } from "../domain/host-error.js";

// ── Adapters (wrap Redis with namespacing) ─────────────────────────────────

/** Failure count at which consecutive Redis diagnostics escalate from warn to error. */
const FAILURE_ESCALATION_THRESHOLD = 10;

/**
 * Track consecutive failures of one Redis-backed operation and escalate the log
 * level once they stop looking like a blip.
 *
 * ONE definition for the three sites that need it (cache `get`, cache `set`,
 * checkpoint `write`), which each declared their own counter, threshold constant
 * and warn/error branch. The distinction it encodes is the point: a single failed
 * Redis call is normal operational noise and warns; ten in a row is Redis being
 * down and must reach `error`, where alerting looks. Three hand-maintained copies
 * of that rule could drift to three different thresholds — and a counter that a
 * copy forgot to RESET on success would escalate forever after one bad minute.
 */
const failureEscalator = (opts: {
  /** Logged while the failure still looks transient. */
  readonly warnMessage: string;
  /** Logged once consecutive failures say the dependency is down. */
  readonly errorMessage: string;
  readonly report: (
    level: "warn" | "error",
    message: string,
    context: Record<string, unknown>,
  ) => void;
}) => {
  let consecutiveFailures = 0;
  return {
    /** Record a failure and report it at the level the current run length earns. */
    failed: (context: Record<string, unknown>): void => {
      consecutiveFailures++;
      const escalated = consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD;
      opts.report(escalated ? "error" : "warn", escalated ? opts.errorMessage : opts.warnMessage, {
        ...context,
        consecutiveFailures,
      });
    },
    /** Record a success — the run of failures is over, so the next one starts at 1. */
    succeeded: (): void => {
      consecutiveFailures = 0;
    },
  };
};

/**
 * Create a ContextCacheAdapter that prefixes all keys with the tenant + DAG
 * namespace. Applies per-DAG TTL override when set is called without an explicit TTL.
 *
 * @satisfies FR-013 — Keys prefixed with tenant + DAG namespace
 * @satisfies FR-041 — Per-DAG TTL override applied
 */
/**
 * One guarded logger binding for an adapter's diagnostics: a failing log port
 * must never take down the operation it was describing. Both namespaced
 * adapters below take theirs from here so neither can quietly lose the guard.
 */
const guardedReporter = (logger: LogPort) =>
  (level: "warn" | "error", message: string, context: Record<string, unknown>): void =>
    logWithoutThrowing(logger, level, message, context);

export const createNamespacedCache = (
  redis: RedisPort,
  tenant: TenantId,
  dagId: DagId,
  defaultTtlSec: number | undefined,
  logger: LogPort,
): ContextCacheAdapter => {
  const report = guardedReporter(logger);

  const getFailures = failureEscalator({
    warnMessage: "Cache get failed — graceful degradation to miss",
    errorMessage: "Cache get failures exceeded threshold — Redis may be degraded",
    report,
  });
  const setFailures = failureEscalator({
    warnMessage: "Cache set failed — Redis error",
    errorMessage: "Cache set failures exceeded threshold — Redis may be degraded",
    report,
  });

  return {
    get: async (key: string): Promise<CacheLookup> => {
      const fullKey = buildCacheKey(tenant, dagId, key);
      let result: Awaited<ReturnType<RedisPort["get"]>>;
      try {
        result = await redis.get(fullKey);
      } catch (error) {
        getFailures.failed({ key: fullKey, dagId, error: safeErrorMessage(error) });
        return { hit: false };
      }
      if (!result.ok) {
        getFailures.failed({ key: fullKey, dagId, error: result.error.kind });
        return { hit: false };
      }
      getFailures.succeeded();
      const raw = result.value;
      if (raw === null) return { hit: false };
      try {
        return { hit: true, value: JSON.parse(raw) };
      } catch (e) {
        // Corrupted entry — treat as miss
        report("warn", "Cache entry corrupted — treating as miss", {
          key: fullKey,
          dagId,
          rawPreview: raw?.slice(0, 100),
          parseError: safeErrorMessage(e),
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
      const fullKey = buildCacheKey(tenant, dagId, key);
      let serialized: string | undefined;
      let serializationError: string | undefined;
      try {
        serialized = JSON.stringify(value);
        if (serialized === undefined) {
          serializationError = "JSON.stringify returned undefined for the top-level value";
        }
      } catch (error) {
        serializationError = safeErrorMessage(error);
      }
      if (serialized === undefined) {
        logWithoutThrowing(logger, "warn", "Cache set failed — value not serializable", {
          key: fullKey,
          dagId,
          error: serializationError ?? "unknown serialization failure",
        });
        return ok(undefined); // Don't kill the request for a cache write failure
      }
      const effectiveTtl = ttlSec ?? defaultTtlSec;
      let setResult: Awaited<ReturnType<RedisPort["set"]>>;
      try {
        setResult = effectiveTtl !== undefined
          ? await redis.set(fullKey, serialized, { expiresInSec: effectiveTtl })
          : await redis.set(fullKey, serialized);
      } catch (error) {
        setFailures.failed({ key: fullKey, error: safeErrorMessage(error) });
        return ok(undefined);
      }
      if (!setResult.ok) {
        setFailures.failed({ key: fullKey, error: setResult.error.kind });
      } else {
        setFailures.succeeded();
      }
      return ok(undefined);
    },
  };
};

/**
 * Create a CheckpointWriter that prefixes all keys with the tenant + DAG + run
 * namespace. Applies per-DAG checkpoint TTL.
 *
 * @satisfies FR-013 — Keys prefixed with tenant + DAG + run namespace
 * @satisfies FR-041 — Per-DAG checkpoint TTL applied
 */
export const createNamespacedCheckpointWriter = (
  redis: RedisPort,
  tenant: TenantId,
  dagId: DagId,
  runId: RunId,
  checkpointTtlSec: number | undefined,
  logger: LogPort,
  commitCheckpointAndRetainSpend?: (
    checkpointKey: string,
    checkpointValue: string,
  ) => Promise<Result<string | null, HostError>>,
): CheckpointWriter => {
  const report = guardedReporter(logger);

  const writeFailures = failureEscalator({
    warnMessage: "Checkpoint write failed — Redis error",
    errorMessage: "Checkpoint write failures exceeded threshold — Redis may be degraded",
    report,
  });

  return {
    write: async (_runId: RunId, nodeId: NodeId, value: unknown): Promise<void> => {
      const fullKey = buildCheckpointKey(tenant, dagId, runId, nodeId);
      let serialized: string;
      try {
        assertLosslessEvent(value, {
          operation: "checkpointWriter.write",
          root: "nodeOutput",
        });
        serialized = toJson(value);
        if (!isDeepStrictEqual(fromJson(serialized), value)) {
          throw new Error("node output failed losslessness round-trip verification");
        }
      } catch (e) {
        const message = safeErrorMessage(e);
        report("warn", "Checkpoint write failed — value not serializable", {
          key: fullKey, dagId, runId, nodeId: nodeId as string, error: message,
        });
        // DELIBERATELY generic, and deliberately NOT `message`. `run-node.ts`
        // turns whatever is thrown here into the DAG-visible
        // `checkpoint-write-failed` via `safeErrorMessage`, so this string
        // crosses the disclosure boundary into API responses. The actionable
        // detail is emitted server-side instead, by the `report()` call above
        // with full structured context. See the sibling throws below and
        // `node-context-factory.test.ts` ("throws no key or driver detail").
        throw new Error("Checkpoint value is not serializable");
      }
      let setResult: Awaited<ReturnType<RedisPort["set"]>>;
      try {
        if (commitCheckpointAndRetainSpend !== undefined) {
          setResult = await commitCheckpointAndRetainSpend(fullKey, serialized);
        } else if (checkpointTtlSec !== undefined) {
          setResult = await redis.set(fullKey, serialized, {
            expiresInSec: checkpointTtlSec,
          });
        } else {
          setResult = await redis.set(fullKey, serialized);
        }
      } catch (error) {
        const message = safeErrorMessage(error);
        writeFailures.failed({
          key: fullKey,
          dagId,
          runId,
          nodeId: nodeId as string,
          error: message,
        });
        // Generic for the same reason as the serialization throw above: the raw
        // driver text (`message`) is logged by `writeFailures.failed` and must
        // not reach the DAG-visible error, which is rendered into HTTP
        // responses. Triage reads the structured log line, not this string.
        throw new Error("Checkpoint persistence failed");
      }
      if (!setResult.ok) {
        writeFailures.failed({
          key: fullKey,
          dagId,
          runId,
          nodeId: nodeId as string,
          error: formatHostError(setResult.error),
        });
        // `formatHostError(setResult.error)` carries the full checkpoint key
        // (tenant/dag/run/node) and raw driver text — logged above, never
        // thrown. Pinned by `node-context-factory.test.ts`.
        throw new Error("Checkpoint persistence failed");
      }
      writeFailures.succeeded();
    },
  };
};

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

const resolveTenantForDag = (
  dag: RegisteredDag,
  routedTenant: TenantId | undefined,
): TenantId => {
  if (routedTenant !== undefined) return routedTenant;
  const parsed = tenantId(dag.team);
  if (isErr(parsed)) {
    throw new Error(
      `createNodeContextForDag: DAG "${dag.id}" has an invalid owning team ` +
        `"${dag.team}" that cannot be used as a tenant key namespace: ${formatHostError(parsed.error)}`,
    );
  }
  return parsed.value;
};

type LedgerReadResult = Awaited<ReturnType<SpendLedgerPort["read"]>>;

/** Enforce the ledger's Result policy at the injected I/O boundary. */
const readSpendLedger = async (
  ledger: SpendLedgerPort,
  runId: RunId,
): Promise<LedgerReadResult> => {
  try {
    const read = await ledger.read(runId);
    if (!read.ok) return read;
    const parsed = parseSpend(read.value);
    return parsed.ok
      ? ok(parsed.value)
      : err({
          kind: "internal-invariant-violated",
          message: `SpendLedgerPort.read returned invalid Spend: ${parsed.error}`,
          context: { operation: "spend-ledger read", error: parsed.error },
        });
  } catch (error) {
    const message = safeErrorMessage(error);
    return err({
      kind: "internal-invariant-violated",
      message: `SpendLedgerPort.read threw across the port boundary: ${message}`,
      context: { operation: "spend-ledger read", error: message },
    });
  }
};

type CheckpointCommit = (
  checkpointKey: string,
  checkpointValue: string,
) => Promise<Result<string | null, HostError>>;

type HydratedLedger = (
  | {
      readonly ledger: SpendLedgerPort;
      readonly limits?: undefined;
      readonly hydrated: HydratedSpend;
    }
  | {
      readonly ledger: SpendLedgerPort;
      readonly limits: Ceilings;
      readonly hydrated: Extract<HydratedSpend, { readonly kind: "known" }>;
    }
) & { readonly checkpointCommit?: CheckpointCommit };

const selectAndHydrateSpendLedger = async (args: {
  readonly shared: SharedInfra;
  readonly tenant: TenantId;
  readonly dagId: DagId;
  readonly runId: RunId;
  readonly ttl: ResolvedTtl;
  readonly limits: Ceilings | undefined;
  readonly resumableRunTtlSec?: number;
}): Promise<HydratedLedger> => {
  const { shared, tenant, dagId, runId, ttl, limits, resumableRunTtlSec } = args;
  let ledger = shared.spendLedger;
  let checkpointCommit: CheckpointCommit | undefined;
  if (ledger.metadata.role === "redis-fallback") {
    const ledgerRedis = spendLedgerRedis(shared.redis);
    if (ledgerRedis.ok) {
      const checkpointTtlSec = ttl.checkpointTtlSec;
      const spendTtlSec = checkpointTtlSec === undefined
        ? undefined
        : Math.max(checkpointTtlSec, resumableRunTtlSec ?? checkpointTtlSec);
      ledger = createRedisSpendLedger({
        redis: ledgerRedis.value,
        tenant,
        dagId,
        ...(spendTtlSec !== undefined ? { ttlSec: spendTtlSec } : {}),
      });
      if (checkpointTtlSec !== undefined && spendTtlSec !== undefined) {
        const spendKey = buildSpendKey(tenant, dagId, runId);
        checkpointCommit = (checkpointKey, checkpointValue) =>
          ledgerRedis.value.commitCheckpointAndRetainSpend({
            checkpointKey,
            checkpointValue,
            spendKey,
            checkpointTtlSec,
            spendTtlSec,
          });
      }
    } else {
      logWithoutThrowing(
        shared.logger,
        "error",
        "Spend ledger is NOT durable — falling back to the in-process backend",
        {
          dagId: dagId as string,
          runId: runId as string,
          backend: shared.spendLedger.metadata.backend,
          durability: shared.spendLedger.metadata.durability,
          reason: formatHostError(ledgerRedis.error),
          consequence: "per-run LLM budgets reset when this process restarts",
        },
      );
    }
  }

  // One binding for the optional field: all three exits below carry it
  // identically, and `checkpointCommit` is fully resolved by this point.
  const commit = checkpointCommit !== undefined ? { checkpointCommit } : {};

  const prior = await readSpendLedger(ledger, runId);
  if (!prior.ok && limits !== undefined) {
    throw new Error(
      `createNodeContextForDag: DAG '${dagId}' declares an LLM budget but its spend ledger ` +
        `could not be read for run '${runId}' — refusing to run a budgeted slice with ` +
        `unknown prior spend: ${formatHostError(prior.error)}`,
    );
  }
  if (!prior.ok) {
    logWithoutThrowing(shared.logger, "warn", "Spend ledger unreadable — metering from zero", {
      dagId: dagId as string,
      runId: runId as string,
      error: formatHostError(prior.error),
    });
    return { ledger, hydrated: { kind: "unknown" }, ...commit };
  }

  const hydrated = { kind: "known" as const, spend: prior.value };
  return limits === undefined
    ? { ledger, hydrated, ...commit }
    : { ledger, limits, hydrated, ...commit };
};

const createSpendBindings = (
  shared: SharedInfra,
  dagId: DagId,
  runId: RunId,
  selection: HydratedLedger,
) => {
  const meterBase = {
    dagId,
    runId,
    ledger: selection.ledger,
    logger: shared.logger,
  };
  const authority = selection.limits === undefined
    ? createRunSpendAuthority({ ...meterBase, hydrated: selection.hydrated })
    : createRunSpendAuthority({
        ...meterBase,
        limits: selection.limits,
        hydrated: selection.hydrated,
      });

  const meterMintedLlm: NodeContextForDag["meterMintedLlm"] = (
    clientKey,
    binding,
    nodeId,
  ) => {
    try {
      const metered = createMeteredLlm(
        binding.client,
        clientKey,
        authority,
        binding.pricingModel,
      );
      return ok(runScopedLlmFacade(metered, binding.runScopedOperations));
    } catch (error) {
      return err({
        kind: "validation",
        nodeId,
        message:
          `broker-delivered LLM capability '${clientKey}' could not be metered: ` +
          safeErrorMessage(error),
      });
    }
  };

  return {
    authority,
    meterMintedLlm,
    llm: createMeteredLlm(
      shared.llm,
      "llm",
      authority,
      shared.llmPricingModel,
    ),
    capabilities: extractClients(shared.capabilities, {
      llm: (clientKey, client, pricingModel) =>
        createMeteredLlm(client, clientKey, authority, pricingModel),
    }),
  };
};

const resolveOriginAndBindSubjectToken = (args: {
  readonly agentClientMap: AgentClientMap;
  readonly identity: AuthIdentity;
  readonly dagId: DagId;
  readonly runId: RunId;
  readonly mintingActive: boolean;
  readonly bindSubjectToken?: (runId: RunId, token: SubjectToken) => void;
}): InvocationOrigin | undefined => {
  const { agentClientMap, identity, dagId, runId, mintingActive, bindSubjectToken } = args;
  const origin = invocationOriginForIdentity(agentClientMap, identity, dagId);
  if (origin === undefined && mintingActive) {
    throw new Error(
      `createNodeContextForDag: DAG '${dagId}' has no agent client mapping in AGENT_CLIENT_MAP ` +
        `(FR-040 fail-closed) — refusing to run with an absent/fabricated agent identity`,
    );
  }

  if (bindSubjectToken !== undefined) {
    const subjectToken = subjectTokenForIdentity(identity);
    if (subjectToken !== undefined) bindSubjectToken(runId, subjectToken);
  }
  return origin;
};

// `NodeContextForDag` and the pure `invocationOriginForIdentity` live in
// `domain/run-context.ts` — the contract of the `createContext` port belongs to
// the domain, not this adapter (the HTTP layer names it without importing
// adapter modules). They are deliberately NOT re-exported here: every consumer
// imports them from the domain module directly, and a pre-release compat alias
// would only give the domain contract a second name to drift under.

/**
 * Construct the BASE NodeContext for a specific DAG execution, plus the run's
 * `origin`.
 *
 * The base context carries boot-scoped static non-LLM clients plus run-scoped
 * metered facades built from boot-scoped LLM authority (`extractClients` over
 * registered handles is the single trust-boundary cast; see
 * capability-manager.ts). Per-invocation AUTHORITY
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
 * and silently dropped every statically-configured client on the realm path.
 *
 * Pools stay boot-scoped (FR-W2-005): only authority resolution moved behind the
 * broker, and it now moves per node, in the framework.
 *
 * @satisfies FR-013 — Cache key isolation
 * @satisfies FR-013 — Checkpoint key isolation
 * @satisfies FR-032 — Caller-supplied runId + AbortSignal
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
   * resolves to `undefined` and FAILS CLOSED here only while `mintingActive` is
   * true, rather than minting as an absent/wrong client. With minting disabled,
   * the origin is unused and an unmapped DAG follows the static-client path.
   * Defaults to the empty map; the separate `mintingActive` flag determines
   * whether that empty mapping refuses the run.
   */
  agentClientMap: AgentClientMap = {},
  /**
   * Whether per-node minting is wired for this boot (`broker !== undefined`).
   * Load-bearing for the fail-closed origin check below: an unmapped DAG is
   * REFUSED (FR-040) only when minting will actually consume the `origin`. When
   * minting is NOT wired the `origin` is discarded by the caller, so an unmapped
   * DAG runs the zero-regression static path (byte-identical to today, SC-005)
   * instead of throwing — a no-realm deployment (`AGENT_CLIENT_MAP` defaults to
   * `{}`) must NOT 500 every run. Defaults to `false` (safe: no throw) so an
   * un-threaded caller never spuriously refuses.
   */
  mintingActive: boolean = false,
  /**
   * HOST-SIDE side-channel sink for a user run's verified `subject_token`
   * (FR-030/FR-032). When the run is user-initiated, the factory binds
   * `runId → SubjectToken` here so the broker can resolve it for the RFC 8693
   * exchange — WITHOUT the token ever crossing the framework `InvocationOrigin`
   * (which stays string-only) or reaching a capability handle (NFR-011). Optional:
   * the no-broker / non-user paths pass nothing and behave byte-identically.
   */
  bindSubjectToken?: (runId: RunId, token: SubjectToken) => void,
  /**
   * The worker's resolved routed `Tenant.id` (FR-013 / SC-001 / ADR-0067). When
   * provided it is the AUTHORITATIVE tenant axis for EVERY Redis key this context
   * produces — the SAME `routedTenant` the token / HITL / run-lock stores key on
   * (`host.ts`), so all of a tenant's keys share ONE `fugue:<tenant>:` namespace.
   * Already a branded `TenantId` (shape-validated at the supervisor boundary), so
   * no re-derivation/parse is needed. When OMITTED (the single-tenant `main.ts`
   * path and unit tests that exercise the derivation directly) the tenant falls
   * back to the `dag.team` derivation below — byte-identical to the prior
   * behaviour for those callers.
   */
  routedTenant?: TenantId,
  /** Retention of authoritative resumable state (for example HITL run TTL). */
  resumableRunTtlSec?: number,
): Promise<NodeContextForDag> => {
  const dagId = dag.id;
  const ttl = resolveTtl(dag);

  const tenant = resolveTenantForDag(dag, routedTenant);
  const limits = ceilingsOf(dag.config);
  const hydratedLedger = await selectAndHydrateSpendLedger({
    shared,
    tenant,
    dagId,
    runId,
    ttl,
    limits,
    ...(resumableRunTtlSec !== undefined ? { resumableRunTtlSec } : {}),
  });
  const { authority, meterMintedLlm, llm, capabilities } = createSpendBindings(
    shared,
    dagId,
    runId,
    hydratedLedger,
  );

  const cache = createNamespacedCache(shared.redis, tenant, dagId, ttl.cacheTtlSec, shared.logger);
  const checkpointWriter = createNamespacedCheckpointWriter(
    shared.redis,
    tenant,
    dagId,
    runId,
    ttl.checkpointTtlSec,
    shared.logger,
    hydratedLedger.checkpointCommit,
  );

  // Per-DAG prompts take precedence; fall back to shared (host-level) prompts.
  const dagPrompts = dag.prompts;
  const promptAccess = dagPrompts.size > 0
    ? { get: (name: string) => dagPrompts.get(name) ?? null }
    : shared.prompts ?? { get: () => null };

  const origin = resolveOriginAndBindSubjectToken({
    agentClientMap,
    identity,
    dagId,
    runId,
    mintingActive,
    ...(bindSubjectToken !== undefined ? { bindSubjectToken } : {}),
  });

  const ctx = makeNodeContext({
    runId,
    dagId,
    tracer: shared.tracer,
    llm,
    budget: authority.budget,
    cache,
    checkpointWriter,
    signal,
    contentFilter: shared.contentFilter,
    prompts: promptAccess,
    // The boot-scoped static client set. Per-node minted scope handles (when a
    // broker is wired) are merged OVER this by the framework at dispatch.
    capabilities,
  });

  return { ctx, origin, meterMintedLlm };
};
