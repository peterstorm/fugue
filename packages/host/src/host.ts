/**
 * Host — top-level imperative shell wiring all subsystems together.
 *
 * This is the IMPERATIVE SHELL. It holds mutable `let` references
 * to state and wires everything:
 * - Constructs SharedInfra from config
 * - Creates mutable state references (HostState, ConcurrencyState, CircuitBreaker map)
 * - Wires sync loop → registry swap + circuit breaker force-reset
 * - Wires HTTP router → read current state
 * - Handles SIGTERM → draining state → stop sync → close server → exit
 *
 * @satisfies FR-060 — Host MUST exit cleanly on SIGTERM after draining in-flight requests
 * @satisfies NFR-020 — Host MUST log startup/shutdown lifecycle events
 */

import { ok, err, runId as makeRunId, safeErrorMessage } from "@fuguejs/framework";
import type { Result, DagId, NodeContext, DagDef, FrameworkError } from "@fuguejs/framework";
import { runDag } from "@fuguejs/framework";
import type { HostConfig } from "./domain/config.js";
import type { HostState } from "./domain/host-state.js";
import { booting, bootComplete, beginDrain, drainComplete, redisDied, redisRecovered } from "./domain/host-state.js";
import type { RegisteredDag } from "./domain/registry.js";
import type { AuthIdentity } from "./domain/auth.js";
import { initConcurrency, reconcileDagLimits } from "./domain/concurrency.js";
import type { CircuitState } from "./domain/circuit-breaker.js";
import { initCircuit } from "./domain/circuit-breaker.js";
import type { GitPort } from "./ports.js";
import type { ModuleLoaderPort } from "./ports.js";
import type { SharedInfra } from "./ports.js";
import type { RedisConnectivityPort } from "./ports.js";
import { createNodeContextForDag } from "./adapters/node-context-factory.js";
import type { NodeContextForDag } from "./domain/run-context.js";
import { createRedisTokenStore } from "./adapters/token-store.js";
import { tenantId } from "./domain/tenant.js";
import type { TenantId } from "./domain/tenant.js";
import { formatHostError } from "./domain/host-error.js";
import { verifyTenantHeader, TENANT_HEADER_NAME } from "./domain/tenant-header.js";
import { createRealmJwtVerifier } from "./adapters/realm-jwt-verifier.js";
import type { RealmJwtDeps } from "./http/middleware/auth.js";
import type { AuthenticatedUser, Team } from "./domain/auth.js";
import type { CapabilityBroker, InvocationOrigin } from "@fuguejs/framework";
import { createKeycloakBroker } from "./adapters/keycloak-broker.js";
import { createSubjectTokenRegistry } from "./adapters/subject-token-registry.js";
import type { SubjectTokenRegistry } from "./adapters/subject-token-registry.js";
import { createUnwiredTokenEndpoint } from "./adapters/unwired-token-endpoint.js";
import { createUnwiredEntraWifExchange, createUnwiredGraphHttp } from "./adapters/unwired-entra-wif.js";
import { createKeycloakTokenEndpoint } from "./adapters/keycloak-token-endpoint-http.js";
import { createEntraWifExchange } from "./adapters/entra-wif.js";
import type { EntraWifExchange, EntraWifConfig } from "./adapters/entra-wif.js";
import type { KeycloakTokenEndpoint } from "./adapters/keycloak-token-endpoint.js";
import type { GraphHttp } from "./adapters/graph-capability.js";
import { createFetchHttpPost } from "./adapters/fetch-http-post.js";
import { createFetchGraphHttp } from "./adapters/fetch-graph-http.js";
import { createAgentClientCredentials } from "./adapters/agent-client-credentials.js";
import { createRouter } from "./http/router.js";
import type { RouterDeps } from "./http/router.js";
import { getRegistry } from "./domain/host-state.js";
import { lookupDag } from "./domain/registry.js";
import type { QueueBackend, WorkerHandle } from "@fuguejs/framework";
import { createHitlRunService } from "./hitl/service.js";
import type { HitlRunService } from "./hitl/service.js";
import { createRedisRunStore } from "./hitl/adapters/run-store.js";
import { createRedisDecisionStore } from "./hitl/adapters/decision-store.js";
import { createRunExecutor } from "./hitl/adapters/run-executor.js";
import { createRunQueue } from "./hitl/adapters/run-queue.js";
import { createWebhookNotifier, fetchWebhookHttp } from "./hitl/adapters/webhook-notifier.js";
import type { HumanReviewNotifierPort } from "./hitl/ports.js";
import { createBotFrameworkNotifier } from "./hitl/adapters/bot/notifier.js";
import { createBotConnector } from "./hitl/adapters/bot/connector.js";
import { createBotTokenVerifier } from "./hitl/adapters/bot/verify.js";
import { createRedisConversationStore } from "./hitl/adapters/bot/conversation-store.js";
import type { ConversationStorePort } from "./hitl/adapters/bot/ports.js";
import { handleBotActivity } from "./hitl/adapters/bot/messages-handler.js";
import type { BotResponse } from "./hitl/adapters/bot/messages-handler.js";
import { startSyncLoop } from "./sync/sync-loop.js";
import type { SyncLoopHandle, SyncLogger } from "./sync/sync-loop.js";
import { createSyncCallbacks } from "./sync/sync-callbacks.js";
import { executeStartup } from "./lifecycle/startup.js";
import { registerSignalHandlers } from "./lifecycle/signals.js";
import type { SignalHandlerHandle } from "./lifecycle/signals.js";
import { startRedisProbe } from "./lifecycle/redis-probe.js";
import type { RedisProbeHandle } from "./lifecycle/redis-probe.js";
import type { ConcurrencyState } from "./domain/concurrency.js";
import { topoSortHandles, connectAll, closeAll } from "./domain/capability-manager.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * The UNSET-tenant fallback. When `createHost` is called WITHOUT a `tenant`
 * (the single-tenant entrypoint / main.ts, FR-035), every per-tenant key is
 * scoped under this one constant tenant, `default`, so all keys live
 * consistently under `fugue:default:`. A worker (T6) passes its resolved
 * `Tenant.id`, which then becomes `routedTenant` instead of this fallback.
 *
 * Built once through the canonical `tenantId` smart constructor (the SINGLE
 * `TenantId` source, `domain/tenant.ts`). `"default"` trivially satisfies
 * `TENANT_ID_REGEX` (`{1,64}`, no `:`/glob), so the `Left` branch is unreachable
 * — we throw on it as an internal invariant rather than widen the API with an
 * unsafe constructor just for this constant.
 */
const DEFAULT_TENANT_ID: TenantId = (() => {
  const r = tenantId("default");
  if (!r.ok) {
    throw new Error(
      `unreachable: the constant default tenant id failed validation: ${formatHostError(r.error)}`,
    );
  }
  return r.value;
})();

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * External dependencies injected into the host — enables testing.
 */
export interface HostDeps {
  readonly config: HostConfig;
  readonly git: GitPort;
  readonly loader: ModuleLoaderPort;
  readonly redis: RedisConnectivityPort;
  readonly sharedInfra: SharedInfra;
  readonly logger: SyncLogger;
  /**
   * Queue backend for the durable HITL run engine (ADR-0060). Constructed by
   * the binary (BullMQ over Redis) and injected so the host stays testable with
   * an in-memory backend. HITL requires BOTH this queue backend AND a notifier
   * transport (TEAMS_WEBHOOK_URL or the Bot Framework BOT_APP_ID/BOT_APP_PASSWORD
   * pair); absent either, HITL is off and a `humanReview` DAG is refused with 501.
   */
  readonly queueBackend?: QueueBackend;
  /** Called during graceful shutdown to clean up infrastructure (e.g., close Redis). */
  readonly onShutdown?: () => Promise<void>;
  /**
   * The tenant this host is bound to (T6, FR-007). When provided, every
   * per-tenant Redis key/ACL namespace (`fugue:<tenant>:*`) is scoped to THIS
   * tenant instead of the constant `default`. The worker entrypoint
   * (`worker-main.ts`) passes its resolved `Tenant.id`.
   *
   * OPTIONAL — UNSET preserves the legacy single-tenant `createHost` behaviour
   * (FR-035 extend-not-replace): keys live under `fugue:default:` exactly as
   * before. main.ts does not pass it.
   */
  readonly tenant?: TenantId;
  /**
   * HTTP listener bind mode (T6). DEFAULT (unset) = bind a TCP port
   * (`config.PORT`) — the legacy `createHost`/main.ts path, unchanged.
   *
   * `{ unix: path }` = bind a Unix-domain socket instead (the worker path,
   * FR-001/FR-007): the worker serves on its per-tenant socket and the
   * supervisor reverse-proxies inbound HTTP to it. After bind the socket is
   * chmod'd 0600 so only the supervisor + worker (same uid) can reach it.
   */
  readonly bind?: { readonly unix: string };
}

/**
 * Running host instance — exposes control handles for testing/shutdown.
 */
export interface HostInstance {
  readonly getState: () => HostState;
  readonly getConcurrency: () => ConcurrencyState;
  readonly getCircuitBreakers: () => ReadonlyMap<DagId, CircuitState>;
  readonly shutdown: () => Promise<void>;
  readonly triggerSync: () => Promise<void>;
  readonly server: { port: number; stop: () => void } | null;
}

/**
 * Stop a listener acquired before a later bind-finalization failure (notably
 * UDS chmod). The returned diagnostic is evidence that the listener may still
 * be live; logging is secondary and can never interrupt the remaining cleanup.
 */
export const stopBoundServerAfterBindFailure = (
  server: { readonly stop: () => void } | undefined,
  bindDescription: string,
  logger: Pick<SyncLogger, "error">,
): string | undefined => {
  if (server === undefined) return undefined;
  try {
    server.stop();
    return undefined;
  } catch (error) {
    const diagnostic = safeErrorMessage(error);
    try {
      logger.error("Failed to stop HTTP server after bind finalization failure — listener may still be live", {
        bind: bindDescription,
        error: diagnostic,
      });
    } catch {
      // The returned HostError remains the authoritative cleanup diagnostic.
    }
    return diagnostic;
  }
};

// ── Capability Broker selection (T8 / per-node minting) ───────────────────

/**
 * The fail-safe default `resolveSubjectToken`: resolves NO token for any run, so
 * a broker constructed without the live `SubjectTokenRegistry` fails the user
 * RFC 8693 exchange CLOSED (no `subject_token` proof → no exchange) rather than
 * minting a proof-less token. Named (not an inline literal) so `createHost` can
 * detect when this inert default would back a LIVE broker — a wiring slip that
 * would silently close every user hop — and warn (defense-in-depth; the
 * fail-closed behaviour itself is unchanged).
 */
const inertResolveSubjectToken = (
  _runId: import("@fuguejs/framework").RunId,
): import("./domain/auth.js").SubjectToken | undefined => undefined;

/**
 * Run `execute`, then ALWAYS `release(runId)` from the registry — on the normal
 * return AND when `execute` throws. This bounds a user run's in-memory subject
 * token to its run (NFR-014): the token must not outlive the run on any exit,
 * including a crash. `release` is a no-op for non-user runs (never bound) and for
 * a never-bound id, so this is safe to call unconditionally at every teardown.
 *
 * The `finally` is the load-bearing invariant — extracted and exported so the
 * release-on-both-paths wiring is asserted directly against the real registry,
 * rather than re-implemented in a test that could drift from `executeDag`.
 */
export const withSubjectTokenRelease = async <T>(
  registry: Pick<SubjectTokenRegistry, "release">,
  runId: import("@fuguejs/framework").RunId,
  execute: () => Promise<T>,
): Promise<T> => {
  try {
    return await execute();
  } finally {
    registry.release(runId);
  }
};

/**
 * Select the capability broker for this boot — the per-invocation AUTHORITY
 * seam. Exported so the selection logic (config → broker, `AGENT_CLIENT_SCOPES`
 * → `assignedScopes` closure, unwired fail-closed endpoints) is testable
 * without booting a full host.
 *
 * When the Keycloak realm config is present (`REALM_JWT_ISSUER` set) this
 * returns the live Keycloak-backed broker: it fails closed on an unassigned
 * scope BEFORE any Entra call, mints narrowly-scoped operation handles PER
 * NODE (the framework calls `mintFor` at dispatch with that node's real
 * `requires`), and emits a correlated audit record for every mint and refusal.
 * The minted handles are merged OVER the boot-scoped static client set.
 *
 * When realm config is ABSENT this returns `undefined` — no minting authority
 * is wired into `runDag`, so the framework skips per-node minting entirely and
 * every node runs against the boot-scoped static client set, byte-identical to
 * today (SC-005), zero regression. Pools stay boot-scoped either way
 * (FR-W2-005); only authority resolution moves behind the broker.
 *
 * AD-3 config-presence gating (FR-011): each authority leg is wired LIVE only
 * when ITS OWN config is present — there is no single global enable flag.
 *   - live Keycloak token endpoint  ⟸ `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` present;
 *   - live Entra WIF exchange + live Graph transport ⟸ `ENTRA_TENANT_ID` AND
 *     `ENTRA_CLIENT_ID` present (validated as an inseparable pair at boot);
 *   - otherwise EACH leg retains its fail-closed unwired stub.
 * When a leg is partially/unwired, EXACTLY ONE boot warning is emitted naming the
 * unwired leg(s) (FR-011). An assigned-but-not-yet-wired scope still surfaces
 * `infra-unreachable` (retriable), never a silent success — and an un-granted
 * scope is refused at the local gate BEFORE either leg (zero Entra egress, FR-012).
 */
export const selectCapabilityBroker = (
  config: HostConfig,
  sharedInfra: Pick<SharedInfra, "tracer" | "logger">,
  logger: SyncLogger,
  now: () => number = Date.now,
  /**
   * Resolve a user run's verified `subject_token` for the RFC 8693 exchange,
   * threaded from the host-side `SubjectTokenRegistry` the run-context factory
   * binds at run start (FR-030/FR-032). Defaults to the inert fail-safe
   * (`inertResolveSubjectToken`) so a broker constructed without the registry
   * fails the user path CLOSED (no proof → no exchange) — never a proof-less
   * token. `createHost` passes the live registry's `resolve`.
   */
  resolveSubjectToken: (runId: import("@fuguejs/framework").RunId) => import("./domain/auth.js").SubjectToken | undefined = inertResolveSubjectToken,
): CapabilityBroker | undefined => {
  if (config.REALM_JWT_ISSUER === undefined) {
    // Operability (mirror of the empty-policy warning below): a scope POLICY is
    // configured but no broker is enabled, so the policy is silently inert —
    // every `requires` resolves against the static base context, unguarded by
    // the per-node gate the operator evidently intended. Surface it once.
    // Defensive `?? {}`: hand-built test configs may bypass the zod default.
    if (Object.keys(config.AGENT_CLIENT_SCOPES ?? {}).length > 0) {
      logger.warn(
        "AGENT_CLIENT_SCOPES is configured but REALM_JWT_ISSUER is unset — no capability broker " +
          "is wired, so the scope policy is inert (set REALM_JWT_ISSUER to enable the broker)",
      );
    }
    return undefined;
  }

  // Operability: an empty scope policy means every mint fails closed (safe but
  // surprising). Surface it once at boot so a misconfigured realm policy is
  // diagnosable from the logs rather than from a wall of per-mint refusals.
  if (Object.keys(config.AGENT_CLIENT_SCOPES ?? {}).length === 0) {
    logger.warn(
      "live capability broker selected with empty scope policy — all mints will fail closed",
    );
  }
  // Operability (defense-in-depth, mirrors the warnings above): the LIVE broker
  // is being selected but its `resolveSubjectToken` is the inert fail-safe — the
  // host-side `SubjectTokenRegistry` was not wired in. Every USER hop's RFC 8693
  // exchange will then fail CLOSED (no `subject_token` proof resolvable), which is
  // safe but, if unintended, looks like an opaque per-run refusal. Surface the
  // misconfiguration ONCE so it is diagnosable from the boot log. The fail-closed
  // behaviour is unchanged — this only names the cause. (In normal `createHost`
  // wiring the live registry's `resolve` is always passed, so this never fires;
  // it guards against a future wiring regression.)
  if (resolveSubjectToken === inertResolveSubjectToken) {
    logger.warn(
      "live capability broker selected without a subject-token resolver — user-initiated " +
        "runs will FAIL CLOSED on the RFC 8693 exchange (the SubjectTokenRegistry is not wired)",
    );
  }
  // ── AD-3 config-presence gating (FR-011): wire each leg LIVE only when its own
  //    config is present. No single global enable flag — a leg without its config
  //    keeps the fail-closed unwired stub.
  //
  // Keycloak SA-mint leg ⟸ KEYCLOAK_AGENT_CLIENT_CREDENTIALS present (a non-empty
  // credential map). The token URL is the explicit KEYCLOAK_TOKEN_URL (https-
  // validated at boot) or, when unset, derived from the realm issuer.
  const keycloakWired = Object.keys(config.KEYCLOAK_AGENT_CLIENT_CREDENTIALS).length > 0;
  // Entra WIF leg (+ its Graph transport) ⟸ ENTRA_TENANT_ID AND ENTRA_CLIENT_ID
  // present (validated as an inseparable pair at boot, so either-set ⇒ both-set).
  // Parse-don't-validate: lift the pair into ONE `EntraWifConfig | undefined` so
  // its presence both gates the legs and carries the narrowed (non-undefined)
  // strings — no later non-null assertion needed.
  const entraConfig: EntraWifConfig | undefined =
    config.ENTRA_TENANT_ID !== undefined && config.ENTRA_CLIENT_ID !== undefined
      ? { tenantId: config.ENTRA_TENANT_ID, clientId: config.ENTRA_CLIENT_ID }
      : undefined;
  const entraWired = entraConfig !== undefined;

  const endpoint: KeycloakTokenEndpoint = keycloakWired
    ? createKeycloakTokenEndpoint({
        config: {
          tokenUrl:
            config.KEYCLOAK_TOKEN_URL ??
            `${config.REALM_JWT_ISSUER.replace(/\/$/, "")}/protocol/openid-connect/token`,
        },
        http: createFetchHttpPost(),
        credentials: createAgentClientCredentials(config.KEYCLOAK_AGENT_CLIENT_CREDENTIALS),
      })
    : createUnwiredTokenEndpoint();

  // The WIF exchange and the Graph transport are wired TOGETHER (the app-only
  // token from WIF is what the Graph transport presents) — both behind the Entra
  // config. The SA token is the only credential (SC-011): no static Entra secret.
  const entraWif: EntraWifExchange =
    entraConfig !== undefined
      ? createEntraWifExchange(entraConfig, createFetchHttpPost())
      : createUnwiredEntraWifExchange();
  const graphHttp: GraphHttp = entraConfig !== undefined ? createFetchGraphHttp() : createUnwiredGraphHttp();

  // FR-011: emit EXACTLY ONE boot warning naming the unwired leg(s), only when a
  // leg is partially/unwired. Both wired → no warning.
  const unwiredLegs: string[] = [];
  if (!keycloakWired) {
    unwiredLegs.push("Keycloak token endpoint (set KEYCLOAK_AGENT_CLIENT_CREDENTIALS)");
  }
  if (!entraWired) {
    unwiredLegs.push("Entra WIF exchange + Graph transport (set ENTRA_TENANT_ID and ENTRA_CLIENT_ID)");
  }
  if (unwiredLegs.length > 0) {
    logger.warn(
      `capability authority leg(s) not wired — remain fail-closed (assigned scopes surface infra-unreachable): ${unwiredLegs.join("; ")}`,
    );
  }

  return createKeycloakBroker({
    endpoint,
    entraWif,
    graphHttp,
    assignedScopes: (agentClientId) => {
      // Own-property lookup only — never resolve an inherited Object.prototype key
      // (`constructor`, `toString`, …) to a scope set; an unknown agent client
      // resolves to NO scopes (fail-closed), matching the sibling guards in
      // `createAgentClientCredentials` / `approverTeamIdentity`.
      const scopes = config.AGENT_CLIENT_SCOPES ?? {};
      return new Set(
        Object.prototype.hasOwnProperty.call(scopes, agentClientId) ? scopes[agentClientId] : [],
      );
    },
    // Per-org Dynamics/Dataverse host (FR-042) — the `dynamics:read` audience +
    // read URL target `https://<host>/api/data/v9.2`. Unset → that scope fails
    // closed at the broker (zero egress); `msgraph` scopes are unaffected.
    ...(config.DYNAMICS_ORG_HOST !== undefined ? { dynamicsOrgHost: config.DYNAMICS_ORG_HOST } : {}),
    resolveSubjectToken,
    tracer: sharedInfra.tracer,
    logger: sharedInfra.logger,
    now,
  });
};

// ── HITL notifier transport selection (ADR-0060) ──────────────────────────

/**
 * The boot-time HITL notifier transport selection (ADR-0060) — the pure
 * AUTHORITY seam. Exported so the selection logic (config → transport, Bot
 * precedence over webhook, the derived approval base URL, and the
 * `BOT_APP_ID`-without-password classification) is testable without booting a
 * full host — the sibling seam to `selectCapabilityBroker`.
 *
 * Precedence: the Bot Framework in-Teams transport requires the COMPLETE
 * `BOT_APP_ID` + `BOT_APP_PASSWORD` pair and wins when both transports are
 * configured; `TEAMS_WEBHOOK_URL` selects the link-out webhook transport
 * (with the explicit or `http://localhost:<PORT>`-defaulted approval base
 * URL) — a complete webhook therefore beats an INCOMPLETE bot pair, the
 * pre-extraction chain's order, preserved; a lone `BOT_APP_ID` (password
 * missing) classifies as `disabled/bot-password-missing` — the
 * lowest-precedence arm, surfaced only when no webhook is configured, which
 * is exactly when the shell emits its single boot warning; neither configures
 * no transport (HITL stays off).
 */
export type HitlNotifierSelection =
  | {
      readonly kind: "bot-framework";
      readonly appId: string;
      readonly appPassword: string;
      readonly tokenUrl?: string;
    }
  | {
      readonly kind: "webhook";
      readonly webhookUrl: string;
      /** Resolved approval base — explicit `HITL_APPROVAL_BASE_URL` or the
       * `http://localhost:<PORT>` default. */
      readonly approvalBaseUrl: string;
    }
  | {
      readonly kind: "disabled";
      readonly reason: "bot-password-missing" | "unconfigured";
    };

export const selectHitlNotifierTransport = (
  config: Pick<
    HostConfig,
    "BOT_APP_ID" | "BOT_APP_PASSWORD" | "BOT_TOKEN_URL" | "TEAMS_WEBHOOK_URL" | "HITL_APPROVAL_BASE_URL" | "PORT"
  >,
): HitlNotifierSelection => {
  if (config.BOT_APP_ID !== undefined && config.BOT_APP_PASSWORD !== undefined) {
    // Parse-don't-validate: lift the pair into ONE narrowed selection so the
    // shell never needs a non-null assertion on the bot credentials.
    return {
      kind: "bot-framework",
      appId: config.BOT_APP_ID,
      appPassword: config.BOT_APP_PASSWORD,
      ...(config.BOT_TOKEN_URL !== undefined ? { tokenUrl: config.BOT_TOKEN_URL } : {}),
    };
  }
  if (config.TEAMS_WEBHOOK_URL !== undefined) {
    return {
      kind: "webhook",
      webhookUrl: config.TEAMS_WEBHOOK_URL,
      approvalBaseUrl: config.HITL_APPROVAL_BASE_URL ?? `http://localhost:${config.PORT}`,
    };
  }
  if (config.BOT_APP_ID !== undefined) {
    return { kind: "disabled", reason: "bot-password-missing" };
  }
  return { kind: "disabled", reason: "unconfigured" };
};

// ── Host Factory ───────────────────────────────────────────────────────────

/**
 * Create and boot the Fugue host.
 *
 * This is the imperative shell — it constructs mutable state,
 * wires subsystems, and manages lifecycle.
 */
export const createHost = async (deps: HostDeps): Promise<Result<HostInstance, import("./domain/host-error.js").HostError>> => {
  const { config, git, loader, redis, sharedInfra, logger } = deps;

  // The tenant every per-tenant Redis key/ACL namespace is scoped under. T6: a
  // worker passes its resolved `Tenant.id`; the legacy single-tenant entrypoint
  // (and main.ts) omit it and keep the constant `default` namespace (FR-035).
  const routedTenant: TenantId = deps.tenant ?? DEFAULT_TENANT_ID;

  // ── Mutable State ────────────────────────────────────────────────────────
  let hostState: HostState = booting(Date.now());
  let concurrency: ConcurrencyState = initConcurrency(
    config.MAX_GLOBAL_CONCURRENCY,
    config.DEFAULT_DAG_CONCURRENCY,
  );
  let circuitBreakers = new Map<DagId, CircuitState>();
  let syncLoop: SyncLoopHandle | null = null;
  let redisProbe: RedisProbeHandle | null = null;
  let signalHandle: SignalHandlerHandle | null = null;
  let server: { port: number; stop: () => void } | null = null;

  // ── Startup Sequence ─────────────────────────────────────────────────────
  const startupResult = await executeStartup({
    config,
    redis,
    git,
    loader,
    logger,
  });

  if (!startupResult.ok) {
    return startupResult as Result<never, import("./domain/host-error.js").HostError>;
  }

  const { registry, sha, syncConfig } = startupResult.value;

  // ── Connect External Capabilities (ADR-0051) ─────────────────────────────
  // Topologically sort handles so dependencies connect first, then connect all.
  // Failure here aborts boot — a missing capability at runtime is worse than
  // a clean boot failure.
  const capHandles = sharedInfra.capabilities;
  let sortedHandles: readonly import("@fuguejs/framework").CapabilityHandle[] = [];
  if (capHandles.length > 0) {
    const sortResult = topoSortHandles(capHandles);
    if (!sortResult.ok) {
      return sortResult as Result<never, import("./domain/host-error.js").HostError>;
    }
    sortedHandles = sortResult.value;
    const connectResult = await connectAll(sortedHandles, logger);
    if (!connectResult.ok) {
      // Boot aborts — close the handles that already connected so a
      // crash-loop boot doesn't leak pools/sockets on every restart.
      await closeAll(connectResult.error.connected, logger);
      return err(connectResult.error.error);
    }
    logger.info(`${sortedHandles.length} external capabilities connected`);
  }

  // Transition to ready
  const readyResult = bootComplete(hostState, registry, sha, Date.now());
  if (!readyResult.ok) {
    // Capabilities already connected — close them before aborting boot so a
    // crash-loop boot doesn't leak pools/sockets (same guarantee as the
    // connect-failure path above).
    if (sortedHandles.length > 0) await closeAll(sortedHandles, logger);
    return err({ kind: "internal-invariant-violated", message: "Boot → ready transition failed", context: { from: readyResult.error.from, to: readyResult.error.to } });
  }
  hostState = readyResult.value;

  // Fold per-DAG concurrency limits from the loaded registry into the limiter (FR-051).
  // Without this, every DAG would silently collapse to DEFAULT_DAG_CONCURRENCY.
  concurrency = reconcileDagLimits(
    concurrency,
    Array.from(registry.dags.values(), (d) => ({ dagId: d.id, max: d.config.maxConcurrency })),
  );

  // ── Capability Broker selection (T8 / per-node minting) ───────────────────
  // See `selectCapabilityBroker` above: a live Keycloak broker is returned when
  // `REALM_JWT_ISSUER` is set, `undefined` otherwise (no minting authority wired
  // — the zero-regression static path). When the broker IS selected, each
  // authority leg is wired LIVE only when ITS OWN config is present (AD-3): the
  // Keycloak token endpoint ⟸ KEYCLOAK_AGENT_CLIENT_CREDENTIALS, the Entra WIF
  // exchange + Graph transport ⟸ ENTRA_TENANT_ID + ENTRA_CLIENT_ID; any leg
  // lacking its config keeps its fail-closed unwired stub (assigned-but-unwired
  // scopes surface `infra-unreachable`, never silent success). The inbound USER
  // JWT path is wired LIVE independently of this agent per-node minting path —
  // both are gated on `REALM_JWT_ISSUER` but selected separately (the inbound
  // verifier group is constructed just below). A node declaring
  // `requires: ["http", "msgraph:mail.send"]` keeps its static `http` client AND
  // gets a freshly minted `mail.send` handle.
  // Host-side side-channel carrying each user run's verified `subject_token` from
  // the run-context factory (bind at run start) to the broker (resolve at per-node
  // dispatch) — FR-030/FR-032. The raw token travels ONLY through here; it never
  // crosses `InvocationOrigin` (string-only) nor reaches a capability handle.
  const subjectTokens = createSubjectTokenRegistry();
  const broker: CapabilityBroker | undefined = selectCapabilityBroker(
    config,
    sharedInfra,
    logger,
    Date.now,
    subjectTokens.resolve,
  );

  // ── Inbound user (OIDC) JWT path (FR-020/021/022/023, SC-005) ────────────
  // Wired LIVE as ONE inseparable group (verifier + iss/aud policy + run-auth
  // policy) exactly when the realm issuer is configured (`REALM_JWT_ISSUER`).
  // Grouping makes "verifier wired but user-run authorization undecided"
  // UNREPRESENTABLE — `RealmJwtDeps.authorizeUserRun` is REQUIRED (AD-5/FR-021),
  // so constructing the group forces the decision here.
  //
  // The authorization decision is STATELESS (FR-022): it tests the run's
  // DAG-owning team against the user's VERIFIED `teams` claim — no per-request
  // datastore lookup. A user whose `teams` does not include the DAG's team is
  // denied (SC-005), and that denial happens in `canAccessDag` BEFORE any
  // concurrency/slot acquisition in the run path (run-dag.ts).
  //
  // When `REALM_JWT_ISSUER` is unset the group is `undefined`: the JWT path is
  // disabled and a JWT-shaped token fails closed (no signature can be verified →
  // 401). The admin and opaque `fug_` team-token paths are untouched (FR-023).
  const realmJwt: RealmJwtDeps | undefined =
    config.REALM_JWT_ISSUER !== undefined
      ? {
          verify: createRealmJwtVerifier({
            issuer: config.REALM_JWT_ISSUER,
            // Fetch keys over the in-cluster route when given, while `expectedIss`
            // below still pins the public-route identity (split-horizon JWKS).
            ...(config.REALM_JWKS_URL !== undefined ? { jwksUri: config.REALM_JWKS_URL } : {}),
          }),
          expectedIss: config.REALM_JWT_ISSUER,
          expectedAud: config.REALM_JWT_AUDIENCE,
          // FR-021/FR-022: stateless team-membership check against the verified
          // token's `teams`. NOT defaultable to `() => true` (AD-5) — that would
          // be an allow-all grant consuming any team's concurrency/budget.
          authorizeUserRun: (user: AuthenticatedUser, dagTeam: Team): boolean =>
            user.teams.includes(dagTeam),
        }
      : undefined;

  // ── HITL durable run engine (ADR-0060) ──────────────────────────────────
  // Enabled when a notifier transport is configured (Bot Framework cards, or
  // the webhook smoke-test) AND a queue backend is wired. HITL DAGs (those
  // declaring `humanReview`) run on this durable queue and park for human
  // review; non-HITL DAGs keep the synchronous inline path.
  let hitlService: HitlRunService | undefined;
  let hitlWorker: WorkerHandle | undefined;
  let hitlReconciliationTimer: ReturnType<typeof setInterval> | undefined;
  let hitlReconciliationTask: Promise<void> | undefined;
  let teamsBotHandle: ((input: { authHeader: string | undefined; activity: unknown }) => Promise<BotResponse>) | undefined;

  // Select the notifier transport via the pure seam
  // (`selectHitlNotifierTransport`). Bot Framework (in-Teams buttons) takes
  // precedence over the webhook (link-out) when both are configured.
  const notifierSelection = selectHitlNotifierTransport(config);
  const botConfigured = notifierSelection.kind === "bot-framework";
  let notifier: HumanReviewNotifierPort | undefined;
  let conversations: ConversationStorePort | undefined;
  // Resolve a run's DAG id to its OWNING team off the LIVE registry (the same
  // `lookupDag` the HTTP path uses). Shared by the notifier (confidentiality
  // routing — FR-041) and the inbound handler (authz parity — SC-006). `undefined`
  // when the DAG is no longer registered.
  const resolveDagTeam = (dagId: DagId): Team | undefined => {
    const reg = getRegistry(hostState);
    return reg ? lookupDag(reg, dagId)?.team : undefined;
  };
  if (notifierSelection.kind === "bot-framework") {
    // SECURITY (FR-013 / SC-001): the HITL conversation store is bound to the
    // `routedTenant` so every `fugue:<tenant>:hitl:*` key is scoped under that
    // tenant's Redis ACL. `routedTenant` is the worker's resolved `Tenant.id`
    // when one is injected, falling back to the constant `default` only in the
    // single-tenant `createHost`/main.ts path where no tenant is passed (FR-035).
    conversations = createRedisConversationStore(sharedInfra.redis, routedTenant, sharedInfra.logger);
    const connector = createBotConnector(
      {
        appId: notifierSelection.appId,
        appPassword: notifierSelection.appPassword,
        ...(notifierSelection.tokenUrl !== undefined ? { tokenUrl: notifierSelection.tokenUrl } : {}),
      },
      sharedInfra.logger,
    );
    notifier = createBotFrameworkNotifier({ connector, conversations, resolveDagTeam });
  } else if (notifierSelection.kind === "webhook") {
    notifier = createWebhookNotifier(
      {
        webhookUrl: notifierSelection.webhookUrl,
        approvalBaseUrl: notifierSelection.approvalBaseUrl,
      },
      fetchWebhookHttp(),
    );
  } else if (notifierSelection.reason === "bot-password-missing") {
    logger.warn("BOT_APP_ID is set but BOT_APP_PASSWORD is not — Bot Framework transport disabled");
  }

  if (notifier !== undefined && deps.queueBackend !== undefined) {
    // FR-013 / SC-001: bind the durable HITL stores to the `routedTenant` so
    // every `fugue:<tenant>:hitl:*` key stays under that tenant's Redis ACL.
    // `routedTenant` is the worker's resolved `Tenant.id`, or the constant
    // `default` fallback in the single-tenant path where no tenant is injected.
    const runStore = createRedisRunStore(sharedInfra.redis, routedTenant, { ttlSec: config.HITL_RUN_TTL_SEC }, sharedInfra.logger);
    const decisions = createRedisDecisionStore(sharedInfra.redis, routedTenant, { ttlSec: config.HITL_RUN_TTL_SEC }, sharedInfra.logger);
    const executor = createRunExecutor({
      sharedInfra,
      getRegisteredDag: (id) => {
        const reg = getRegistry(hostState);
        return reg ? lookupDag(reg, id as DagId) : undefined;
      },
      broker,
      agentClientMap: config.AGENT_CLIENT_MAP,
      tenant: routedTenant,
      logger: sharedInfra.logger,
    });
    const runQueue = createRunQueue({
      backend: deps.queueBackend,
      redis: sharedInfra.redis,
      // FR-013 / SC-001: scope the single-flight lock key to the `routedTenant`
      // (`fugue:<tenant>:hitl:lock:*`) — the worker's resolved `Tenant.id`, or the
      // constant `default` fallback in the single-tenant path.
      tenant: routedTenant,
      lockTtlSec: config.HITL_LOCK_TTL_SEC,
      logger: sharedInfra.logger,
    });
    const service = createHitlRunService({
      runStore,
      runQueue: runQueue.queue,
      decisions,
      notifier,
      executor,
      clock: Date.now,
      newRunId: () => makeRunId(crypto.randomUUID()),
      // ADR-0074: gate per-tenant outstanding HITL runs at `startRun`. `tenant` is
      // the worker's resolved id (names its OWN over-quota error); `maxQueuedRuns`
      // arrives via the spawn env from the tenant registry config. Unset → unlimited
      // (single-tenant `main.ts` path, or a worker spawned before the field is set).
      tenant: routedTenant,
      ...(config.FUGUE_MAX_QUEUED_RUNS !== undefined ? { maxQueuedRuns: config.FUGUE_MAX_QUEUED_RUNS } : {}),
      logger: sharedInfra.logger,
    });
    hitlService = service;
    hitlWorker = runQueue.startWorker(service.processRun, { concurrency: config.HITL_WORKER_CONCURRENCY });

    // Durable queue delivery is a wakeup optimization, not the ownership source.
    // Reconcile once AFTER the worker exists (restart recovery), then periodically
    // for direct enqueue failures. Never overlap sweeps; one active-index walk is
    // sufficient because every wakeup is idempotent at processRun + lock seams.
    const reconcileHitlRuns = (): Promise<void> => {
      if (hitlReconciliationTask !== undefined) return hitlReconciliationTask;
      hitlReconciliationTask = (async () => {
        try {
          const reconciled = await service.reconcileActiveRuns();
          if (!reconciled.ok) {
            logger.error("HITL active-run reconciliation failed", {
              error: reconciled.error.kind,
            });
          }
        } catch (error) {
          // Adapter contracts are no-throw, but lifecycle supervision must remain
          // total if a non-conforming dependency rejects unexpectedly.
          logger.error("HITL active-run reconciliation threw", {
            error: safeErrorMessage(error),
          });
        } finally {
          hitlReconciliationTask = undefined;
        }
      })();
      return hitlReconciliationTask;
    };
    await reconcileHitlRuns();
    hitlReconciliationTimer = setInterval(
      () => { void reconcileHitlRuns(); },
      config.HITL_RECONCILE_INTERVAL_MS,
    );

    // The in-Teams transport also needs its inbound endpoint: verify the Bot
    // Framework token, then dispatch button clicks to the run service.
    if (botConfigured && conversations !== undefined) {
      const verify = createBotTokenVerifier({ appId: notifierSelection.appId });
      const convs = conversations;
      teamsBotHandle = (input) =>
        handleBotActivity(
          {
            verify,
            hitl: service,
            conversations: convs,
            // FR-041: authorize the Teams approver against the run's DAG-owning
            // team at parity with the HTTP path. The team is resolved from the
            // live registry (same `lookupDag` the HTTP path + notifier use), and
            // the approver's membership from `HITL_APPROVER_TEAMS`.
            resolveDagTeam,
            approverTeams: config.HITL_APPROVER_TEAMS,
            // FR-041 (confidentiality routing): on `conversationUpdate` map the
            // Teams team `aadGroupId` to a fugue team so the captured reference is
            // stored per team and the notifier routes that team's cards to its own
            // channel. Unmapped → default reference only.
            teamChannels: config.HITL_TEAM_CHANNELS,
            logger: sharedInfra.logger,
          },
          input,
        );
      logger.info("HITL durable run engine enabled (Bot Framework in-Teams transport)");
    } else if (notifierSelection.kind === "webhook") {
      // The webhook branch is the only selection that reaches here: a
      // `disabled` selection never defines `notifier`, so the outer
      // `notifier !== undefined` guard is false for it (the former bare
      // `else` was unreachable). Name the resolved approval base in the boot
      // log — the one resolved HITL config value that was previously
      // unlogged — and flag the DERIVED `http://localhost:<PORT>` default,
      // whose card Review deep-link is unreachable outside the host machine;
      // every sibling boot decision logs its resolution the same way.
      // (silent-failure-hunter-1, review run
      // standalone-2026-08-21-181423-f6-file-durable-runtime)
      logger.info(
        `HITL durable run engine enabled (Teams webhook transport) — approval base ${notifierSelection.approvalBaseUrl}` +
          (config.HITL_APPROVAL_BASE_URL === undefined
            ? " (derived localhost default: HITL_APPROVAL_BASE_URL is unset — Review deep-links are unreachable outside the host machine)"
            : ""),
      );
    }
  } else if (notifier !== undefined && deps.queueBackend === undefined) {
    logger.warn("A HITL notifier is configured but no queue backend was wired — HITL is disabled");
  }

  // ── Router Dependencies ──────────────────────────────────────────────────
  // SECURITY (FR-013 / US2 / SC-001): the token store is bound to the
  // `routedTenant` so every `fugue:<tenant>:tokens:*` / `fugue:<tenant>:teams:*`
  // key is scoped under that tenant's Redis ACL. `routedTenant` is the worker's
  // resolved `Tenant.id` when injected, falling back to the constant `default`
  // only in the single-tenant `createHost`/main.ts path (FR-035) where all keys
  // then live consistently under `fugue:default:`.
  const tokenStore = createRedisTokenStore(sharedInfra.redis, routedTenant, sharedInfra.logger);

  const routerDeps: RouterDeps = {
    hitl: hitlService,
    teamsBot: teamsBotHandle,
    getHostState: () => hostState,
    getConcurrency: () => concurrency,
    setConcurrency: (s) => { concurrency = s; },
    circuit: {
      get: (id) => circuitBreakers.get(id) ?? initCircuit(Date.now()),
      set: (id, s) => { circuitBreakers.set(id, s); },
    },
    createContext: (
      registered: RegisteredDag,
      signal: AbortSignal,
      // The resolved inbound identity is threaded through to the NodeContext
      // factory (FR-W3-007), which derives `Invocation.origin` from it: an OIDC
      // `user` carries its `sub` (with the DAG's agent-type client as
      // `agentClientId`) so the run is correctly attributed to the user instead
      // of being silently re-labelled `agent`. The origin is returned alongside
      // the base context and threaded into `executeDag` so the broker (selected
      // at boot) can authorize each node against it.
      identity: AuthIdentity,
    ): Promise<NodeContextForDag> => {
      const rid = makeRunId(crypto.randomUUID());
      // Bind the user run's verified subject token host-side (FR-030/FR-032): the
      // factory reads it off the identity via the pure seam and stores it under
      // `rid` so the broker can resolve it for the RFC 8693 exchange. Non-user
      // runs bind nothing. `executeDag` releases it on completion (below).
      return createNodeContextForDag(sharedInfra, registered, rid, signal, identity, config.AGENT_CLIENT_MAP, broker !== undefined, subjectTokens.bind, routedTenant);
    },
    executeDag: async <I, O>(
      dag: DagDef,
      input: I,
      ctx: NodeContext,
      origin: InvocationOrigin | undefined,
    ): Promise<Result<O, FrameworkError>> => {
      // Inject the boot-selected broker + run origin (as one MintingAuthority —
      // the framework's option type makes broker-without-origin unrepresentable)
      // so the framework mints each node's declared scopes PER NODE at dispatch.
      // When `broker` is undefined (no realm config) no minting authority is
      // wired and the framework skips minting — byte-identical to today. `origin`
      // is guaranteed defined whenever `broker` is wired (the factory fails closed
      // on an unmapped DAG, FR-040); the `origin !== undefined` guard is the
      // type-honest, fail-closed expression of that invariant.
      // The teardown that releases the run's subject token (NFR-014) is the
      // exported `withSubjectTokenRelease` seam, so the release-on-BOTH-paths
      // wiring (resolve AND throw) is unit-testable against the real registry
      // without copy-drift from this call site.
      return withSubjectTokenRelease(subjectTokens, ctx.runId, () =>
        runDag<I, O>(dag, input, ctx, {
          minting: broker !== undefined && origin !== undefined ? { broker, origin } : undefined,
        }),
      );
    },
    clock: Date.now,
    circuitConfig: {
      threshold: config.CIRCUIT_BREAKER_THRESHOLD,
      windowMs: config.CIRCUIT_BREAKER_WINDOW_MS,
      cooldownMs: config.CIRCUIT_BREAKER_COOLDOWN_MS,
    },
    adminToken: config.ADMIN_TOKEN,
    tokenStore,
    // fugue-platform OIDC (`user`) inbound path (FR-020/021/022/023, SC-005),
    // wired LIVE above as ONE grouped `realmJwt` dep (JWKS verifier + iss/aud
    // policy + the REQUIRED `authorizeUserRun` run-authorization policy). When
    // `REALM_JWT_ISSUER` is unset the group is `undefined` and the JWT path is
    // disabled (fail-closed: a JWT-shaped token 401s, no signature verifiable).
    //
    // SECURITY: `RealmJwtDeps.authorizeUserRun` is a REQUIRED member of the
    // group (AD-5) — constructing `realmJwt` forces the run-authorization
    // decision in types. It is wired to a STATELESS team-membership check
    // (`user.teams.includes(dagTeam)`, FR-022) and is NOT defaulted to an
    // allow-all `() => true`.
    ...(realmJwt !== undefined ? { realmJwt } : {}),
    adminHandlerDeps: {
      tokenStore,
      clock: Date.now,
      generateRandomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
    },
    logger,
  };

  // ── HTTP Server ──────────────────────────────────────────────────────────
  // Two bind modes (FR-001/FR-035 extend-not-replace):
  //   - DEFAULT (deps.bind unset): bind a TCP port — the legacy main.ts path.
  //   - `{ unix }`: bind a per-tenant Unix-domain socket (the worker, T6). It is
  //     NOT an inbound public listener; the supervisor reverse-proxies inbound
  //     HTTP to it. After bind the socket is chmod'd 0600 so only the supervisor
  //     + worker (same uid) can reach it (FR-007 socket isolation).
  const app = createRouter(routerDeps);
  const unixPath = deps.bind?.unix;
  const bindDesc = unixPath !== undefined ? `unix socket ${unixPath}` : `port ${config.PORT}`;

  // ── Worker-side tenant-header verification (defense-in-depth, FR-007) ──────
  // The PRIMARY per-tenant boundary is the 0600 socket: a request arriving on
  // this worker's UDS is, by construction, for this worker's tenant. As a cheap
  // SECONDARY check, when the platform-internal `FUGUE_SUPERVISOR_HMAC_KEY` is set
  // AND this host is in UDS/worker mode, verify the supervisor-signed
  // `X-Fugue-Tenant` header against the routed tenant before dispatch and REJECT
  // every non-`ok` outcome (absent / malformed / tenant-mismatch / bad-signature)
  // fail-CLOSED. The supervisor is the sole signer (it strips any client value),
  // so a request reaching here without a valid header for THIS tenant did not
  // transit the supervisor and must not be served.
  //
  // When the key is UNSET we skip verification entirely and serve `app.fetch`
  // unchanged — preserving the legacy single-tenant/TCP path (FR-035). The
  // verification is also skipped on the TCP path even if a key is set, since the
  // signed-header contract only applies to the supervisor→worker UDS hop.
  const headerVerificationActive = unixPath !== undefined && config.FUGUE_SUPERVISOR_HMAC_KEY !== undefined;
  const hmacKey = config.FUGUE_SUPERVISOR_HMAC_KEY;
  const fetchHandler: (req: Request) => Response | Promise<Response> =
    headerVerificationActive && hmacKey !== undefined
      ? (req: Request): Response | Promise<Response> => {
          const outcome = verifyTenantHeader(hmacKey, routedTenant, req.headers.get(TENANT_HEADER_NAME) ?? undefined);
          if (outcome.kind !== "ok") {
            // 401 for absent/malformed (no usable principal proof); 403 for a
            // present-but-wrong principal (tenant-mismatch / bad-signature) —
            // the request authenticated as the wrong/forged tenant. Never name
            // another tenant; the worker only knows its own routed tenant.
            const status = outcome.kind === "absent" || outcome.kind === "malformed" ? 401 : 403;
            logger.warn("[worker] rejected request — tenant-header verification failed (fail-closed)", {
              tenant: routedTenant,
              reason: outcome.kind,
            });
            return new Response(
              JSON.stringify({ error: "tenant principal verification failed", reason: outcome.kind }),
              { status, headers: { "Content-Type": "application/json" } },
            );
          }
          return app.fetch(req);
        }
      : app.fetch;

  // `| undefined` is type-honest: `Bun.serve` may throw before assigning (a bind
  // failure), and the catch below must be able to ask "did we bind?" via `?.`.
  let bunServer: { stop: () => void; port?: number } | undefined;
  try {
    bunServer =
      unixPath !== undefined
        ? Bun.serve({
            fetch: fetchHandler,
            unix: unixPath,
            maxRequestBodySize: 10 * 1024 * 1024, // 10MB — prevents request body DoS
          })
        : Bun.serve({
            fetch: fetchHandler,
            port: config.PORT,
            maxRequestBodySize: 10 * 1024 * 1024, // 10MB — prevents request body DoS
          });
    // Lock the socket down to the owning uid BEFORE announcing readiness. NOTE:
    // `Bun.serve` binds the socket as soon as it returns, so there is a brief
    // window between bind and this chmod where the path exists at the default
    // umask — the chmod closes it before readiness is announced, and the parent
    // `WORKER_UDS_DIR` perms + the HMAC `X-Fugue-Tenant` check (when configured)
    // backstop that window. A chmod failure is a fail-closed boot abort: an
    // un-restricted tenant socket is worse than a clean boot failure (FR-007).
    if (unixPath !== undefined) {
      const { chmodSync } = await import("node:fs");
      chmodSync(unixPath, 0o600);
    }
  } catch (e) {
    // Boot abort. Tear down everything already acquired before returning error,
    // mirroring the happy-path shutdown ORDER (server → HITL worker → capabilities).
    // CRITICAL (FR-007): `Bun.serve` binds the socket as soon as it returns, so a
    // chmod failure AFTER a successful bind reaches here with the server LISTENING at
    // the default umask. Stop it (and the already-started HITL worker) explicitly —
    // depending only on the OPTIONAL `onShutdown` would otherwise leave a
    // mis-permissioned tenant socket listening, worse than a clean boot failure.
    const serverStopFailure = stopBoundServerAfterBindFailure(bunServer, bindDesc, logger);
    if (hitlReconciliationTimer !== undefined) {
      clearInterval(hitlReconciliationTimer);
      hitlReconciliationTimer = undefined;
    }
    if (hitlReconciliationTask !== undefined) await hitlReconciliationTask;
    if (hitlWorker) {
      try {
        await hitlWorker.close();
      } catch (closeError) {
        try {
          logger.error("Failed to close HITL worker after server bind failure", {
            error: safeErrorMessage(closeError),
          });
        } catch {
          // Continue the remaining boot-abort cleanup.
        }
      }
      hitlWorker = undefined;
    }
    // Close connected capabilities (reverse topological order), then infrastructure.
    if (sortedHandles.length > 0) await closeAll(sortedHandles, logger);
    if (deps.onShutdown) {
      try {
        await deps.onShutdown();
      } catch (cleanupError) {
        try {
          logger.error("Failed to clean up resources after server bind failure", {
            error: safeErrorMessage(cleanupError),
          });
        } catch {
          // The primary bind failure remains authoritative.
        }
      }
    }
    const stopContext = serverStopFailure === undefined
      ? ""
      : `; failed to stop the bound server and the listener may still be live: ${serverStopFailure}`;
    return err({
      kind: "internal-invariant-violated",
      message: `Failed to bind HTTP server on ${bindDesc}: ${safeErrorMessage(e)}${stopContext}`,
      context: unixPath !== undefined ? { unix: unixPath } : { port: config.PORT },
    });
  }
  // The catch above returns on any bind/chmod failure, so reaching here means the
  // server is bound and `bunServer` is assigned.
  const listening = bunServer;
  server = {
    // A UDS server has no TCP port; report 0 so the handle stays well-typed
    // without claiming a port the worker is not listening on.
    port: listening?.port ?? (unixPath !== undefined ? 0 : config.PORT),
    stop: () => listening?.stop(),
  };
  logger.info(`HTTP server listening on ${bindDesc}`);
  // Make the security posture observable at boot: whether the worker-side
  // tenant-header check is enforcing (key set + UDS mode) or relying on socket
  // isolation alone (FR-007 defense-in-depth).
  if (unixPath !== undefined) {
    logger.info(
      headerVerificationActive
        ? "Worker tenant-header verification ACTIVE (fail-closed) — supervisor-signed X-Fugue-Tenant required and bound to this tenant"
        : "Worker tenant-header verification INACTIVE (no FUGUE_SUPERVISOR_HMAC_KEY) — relying on 0600 socket isolation alone",
      { tenant: routedTenant },
    );
  }

  // ── Sync Loop ────────────────────────────────────────────────────────────
  const syncCallbacks = createSyncCallbacks({
    getState: () => hostState,
    setState: (s) => { hostState = s; },
    getCircuitBreakers: () => circuitBreakers,
    getConcurrency: () => concurrency,
    setConcurrency: (s) => { concurrency = s; },
    logger,
    clock: Date.now,
  });

  syncLoop = startSyncLoop(
    git,
    loader,
    syncConfig,
    logger,
    syncCallbacks.onStarted,
    syncCallbacks.onComplete,
    syncCallbacks.onNoChange,
    syncCallbacks.onError,
    sha,
  );

  // ── Redis Liveness Probe ───────────────────────────────────────────────────
  // Drives the redis-disconnected degraded state after boot. Transitions are
  // attempted on every tick and applied only when valid (redisDied is valid from
  // ready/syncing; redisRecovered only from degraded:redis-disconnected), so the
  // edge-vs-level distinction is handled by the pure state machine, not here.
  redisProbe = startRedisProbe(
    redis,
    config.REDIS_PROBE_INTERVAL_MS,
    {
      onDead: () => {
        const result = redisDied(hostState, Date.now());
        if (result.ok) {
          hostState = result.value;
          logger.warn("Redis liveness probe failed — host degraded (redis-disconnected)");
        } else if (hostState.phase !== "degraded") {
          // Already-degraded is the expected no-op; any other rejection is a real
          // state-machine surprise worth surfacing (mirrors the sync-callbacks pattern).
          logger.warn("redisDied transition unexpectedly rejected", {
            currentPhase: hostState.phase,
            error: result.error.message,
          });
        }
      },
      onAlive: () => {
        if (hostState.phase === "degraded" && hostState.reason === "redis-disconnected") {
          const result = redisRecovered(hostState);
          if (result.ok) {
            hostState = result.value;
            logger.info("Redis recovered — host returned to ready");
          } else {
            logger.warn("redisRecovered transition unexpectedly rejected", {
              currentPhase: hostState.phase,
              error: result.error.message,
            });
          }
        }
      },
    },
    logger,
  );

  // ── Shutdown Logic ───────────────────────────────────────────────────────
  const shutdown = async () => {
    logger.info("Shutdown initiated — draining in-flight requests...");

    // Stop sync loop
    if (syncLoop) {
      syncLoop.stop();
      syncLoop = null;
    }

    // Stop Redis liveness probe — no more degraded/recovered transitions during drain
    if (redisProbe) {
      redisProbe.stop();
      redisProbe = null;
    }

    // Transition to draining
    const inflightCount = concurrency.global.current;
    const drainResult = beginDrain(hostState, inflightCount, Date.now());
    if (drainResult.ok) {
      hostState = drainResult.value;
    } else {
      logger.warn("Cannot transition to draining", {
        currentPhase: hostState.phase,
        error: drainResult.error.message,
      });
    }

    // Wait for in-flight requests to drain (up to DRAIN_TIMEOUT_MS)
    const drainDeadline = Date.now() + config.DRAIN_TIMEOUT_MS;
    while (concurrency.global.current > 0 && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (concurrency.global.current > 0) {
      logger.warn(`Drain timeout — ${concurrency.global.current} requests still in-flight`);
    }

    // Stop HTTP server
    if (server) {
      server.stop();
      server = null;
    }

    // Stop server-owned reconciliation before closing the worker/Redis it uses.
    if (hitlReconciliationTimer !== undefined) {
      clearInterval(hitlReconciliationTimer);
      hitlReconciliationTimer = undefined;
    }
    if (hitlReconciliationTask !== undefined) await hitlReconciliationTask;

    // Stop the HITL worker (ADR-0060) — drains its in-flight job, then no more
    // run slices are processed. The queue backend itself is closed by the
    // binary via `onShutdown` (it owns the BullMQ/Redis connection).
    if (hitlWorker) {
      try {
        await hitlWorker.close();
      } catch (e) {
        logger.error("Error closing HITL worker", { error: e instanceof Error ? e.message : String(e) });
      }
      hitlWorker = undefined;
    }

    // Clean up external capabilities (ADR-0051) — close in reverse topological order
    if (sortedHandles.length > 0) {
      const closeFailures = await closeAll(sortedHandles, logger);
      if (closeFailures.length > 0) {
        logger.warn(`Capability shutdown completed with ${closeFailures.length} failure(s)`, {
          failures: closeFailures.map((f) => f.name),
        });
      }
    }

    // Clean up infrastructure (e.g., close Redis connections)
    if (deps.onShutdown) {
      try {
        await deps.onShutdown();
      } catch (e) {
        logger.error("Error during infrastructure cleanup — resources may be leaked", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Transition to stopped
    const stoppedResult = drainComplete(hostState);
    if (stoppedResult.ok) {
      hostState = stoppedResult.value;
    } else {
      logger.warn("Cannot transition to stopped", {
        currentPhase: hostState.phase,
        error: stoppedResult.error.message,
      });
    }

    logger.info("Host stopped");
  };

  // ── Signal Handlers ──────────────────────────────────────────────────────
  signalHandle = registerSignalHandlers({
    onShutdown: shutdown,
    logger,
  });

  logger.info("Host fully booted and ready to serve requests", {
    // Use the typed `server.port` handle (0 in UDS/worker mode) rather than the
    // raw `bunServer.port`, which is `undefined` for a UDS listener and would log
    // a misleading absent port on the boot line.
    port: server.port,
    dagCount: registry.dags.size,
  });

  // ── Return Host Instance ─────────────────────────────────────────────────
  return ok({
    getState: () => hostState,
    getConcurrency: () => concurrency,
    getCircuitBreakers: () => circuitBreakers as ReadonlyMap<DagId, CircuitState>,
    shutdown: async () => {
      if (signalHandle) {
        signalHandle.unregister();
        signalHandle = null;
      }
      await shutdown();
    },
    triggerSync: async () => {
      if (syncLoop) {
        await syncLoop.triggerSync();
      }
    },
    get server() { return server; },
  });
};
