/**
 * Host — top-level imperative shell wiring all subsystems together.
 *
 * This is the IMPERATIVE SHELL. It holds mutable `let` references
 * to state and wires everything:
 * - Receives SharedInfra from the injected HostDeps (the entrypoint constructs
 *   it; this file only destructures and threads it)
 * - Creates mutable state references (HostState, ConcurrencyState, CircuitBreaker map)
 * - Wires sync loop → registry swap + circuit breaker force-reset
 * - Wires HTTP router → read current state
 * - Handles SIGTERM → stop sync loop + Redis probe → draining state → await
 *   in-flight drain → close server → stopped → exit (see `performShutdown`)
 *
 * @satisfies FR-060 — Host MUST exit cleanly on SIGTERM after draining in-flight requests
 * @satisfies NFR-020 — Host MUST log startup/shutdown lifecycle events
 */

import { match } from "ts-pattern";
import { ok, err, runId as makeRunId, safeErrorMessage } from "@fuguejs/framework";
import type { Result, DagId, NodeContext, DagDef, FrameworkError, RunId, CapabilityHandle, FanConcurrencyCap, RunOptions, GitSha } from "@fuguejs/framework";
import { runDag } from "@fuguejs/framework";
import type { HostConfig } from "./domain/config.js";
import type { HostState } from "./domain/host-state.js";
import { booting, bootComplete, beginDrain, drainComplete, redisDied, redisRecovered } from "./domain/host-state.js";
import type { RegisteredDag, Registry } from "./domain/registry.js";
import type { AuthIdentity, SubjectToken } from "./domain/auth.js";
import { initConcurrency, reconcileDagLimits } from "./domain/concurrency.js";
import type { CircuitState } from "./domain/circuit-breaker.js";
import { initCircuit } from "./domain/circuit-breaker.js";
import type { GitPort } from "./ports.js";
import type { ModuleLoaderPort } from "./ports.js";
import type { SharedInfra } from "./ports.js";
import type { LogPort } from "./ports.js";

import type { RedisConnectivityPort } from "./ports.js";
import { requireHitlRedisPort } from "./adapters/redis-connectivity.js";
import { createNodeContextForDag } from "./adapters/node-context-factory.js";
import type { NodeContextForDag } from "./domain/run-context.js";
import { createRedisTokenStore } from "./adapters/token-store.js";
import { tenantId } from "./domain/tenant.js";
import type { TenantId } from "./domain/tenant.js";
import { formatHostError } from "./domain/host-error.js";
import type { HostError } from "./domain/host-error.js";
import { verifyTenantHeader, TENANT_HEADER_NAME } from "./domain/tenant-header.js";
import { createRealmJwtVerifier } from "./adapters/realm-jwt-verifier.js";
import type { RealmJwtDeps } from "./http/middleware/auth.js";
import type { AuthenticatedUser, Team } from "./domain/auth.js";
import type {
  CapabilityBroker,
  InvocationOrigin,
  ScopedLlmMeter,
} from "@fuguejs/framework";
import { createKeycloakBroker } from "./adapters/keycloak-broker.js";
import type { AssignedScopes } from "./adapters/keycloak-broker.js";
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
import { logWithoutThrowing } from "./hitl/diagnostic-logging.js";
import type { HitlRunService } from "./hitl/service.js";
import { createRedisRunStore } from "./hitl/adapters/run-store.js";
import { createRedisDecisionStore } from "./hitl/adapters/decision-store.js";
import { createRunExecutor } from "./hitl/adapters/run-executor.js";
import { createRunQueue } from "./hitl/adapters/run-queue.js";
import { createWebhookNotifier, fetchWebhookHttp } from "./hitl/adapters/webhook-notifier.js";
import { createRunLeaseAuthority } from "./hitl/ports.js";
import type { HumanReviewNotifierPort, RunExecutorPort } from "./hitl/ports.js";
import { createBotFrameworkNotifier } from "./hitl/adapters/bot/notifier.js";
import { createBotConnector } from "./hitl/adapters/bot/connector.js";
import { createBotTokenVerifier } from "./hitl/adapters/bot/verify.js";
import { createRedisConversationStore } from "./hitl/adapters/bot/conversation-store.js";
import type { ConversationStorePort } from "./hitl/adapters/bot/ports.js";
import { handleBotActivity } from "./hitl/adapters/bot/messages-handler.js";
import type { BotResponse } from "./hitl/adapters/bot/messages-handler.js";
import { startSyncLoop } from "./sync/sync-loop.js";
import type { SyncLoopHandle, SyncLogger, SyncConfig } from "./sync/sync-loop.js";
import { createSyncCallbacks } from "./sync/sync-callbacks.js";
import { executeStartup } from "./lifecycle/startup.js";
import { registerSignalHandlers } from "./lifecycle/signals.js";
import type { SignalHandlerHandle } from "./lifecycle/signals.js";
import { startRedisProbe } from "./lifecycle/redis-probe.js";
import type { RedisProbeHandle } from "./lifecycle/redis-probe.js";
import type { ConcurrencyState } from "./domain/concurrency.js";
import { topoSortHandles, connectAll, closeAll } from "./domain/capability-manager.js";

/** Preserve a boot failure and every subordinate cleanup failure in one HostError. */
const bootAbortWithCleanup = (
  primary: HostError,
  cleanupFailures: readonly unknown[],
): HostError => {
  if (cleanupFailures.length === 0) return primary;
  const diagnostics = cleanupFailures.map(safeErrorMessage);
  return {
    kind: "internal-invariant-violated",
    message:
      `${formatHostError(primary)}; boot-abort cleanup also failed: ` +
      diagnostics.join("; "),
    context: {
      primary: formatHostError(primary),
      cleanupFailures: diagnostics,
    },
  };
};

const capabilityCleanupErrors = (
  failures: readonly { readonly name: string; readonly error: string }[],
  context: string,
): readonly Error[] => failures.map((failure) =>
  new Error(`Capability '${failure.name}' failed to close during ${context}: ${failure.error}`));

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
  /** Optional embedder/test authority; production defaults to config selection. */
  readonly capabilityBroker?: CapabilityBroker;
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
    // The returned HostError remains the authoritative cleanup diagnostic.
    logWithoutThrowing(logger, "error",
      "Failed to stop HTTP server after bind finalization failure — listener may still be live",
      { bind: bindDescription, error: diagnostic });
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
  _runId: RunId,
): SubjectToken | undefined => undefined;

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
  runId: RunId,
  execute: () => Promise<T>,
): Promise<T> => {
  try {
    return await execute();
  } finally {
    registry.release(runId);
  }
};

/**
 * Kernel options for a synchronous (non-HITL) HTTP run. The operator fan cap is
 * a REQUIRED argument, so `executeDag` cannot start a run without it: the
 * host-wide `FAN_CHILD_CONCURRENCY_MAX` ceiling (FR-030) applies to sync runs
 * exactly as it does to resumable ones, and is never a per-run input (FR-034).
 * `minting` is passed through unchanged (`undefined` when no broker is wired).
 *
 * Pure and exported so the cap-reaches-the-kernel wiring is asserted directly,
 * the same way `withSubjectTokenRelease` pins the teardown.
 */
export const syncRunOptions = (
  operatorFanCap: FanConcurrencyCap,
  minting: RunOptions["minting"],
): Pick<RunOptions, "minting" | "fanConcurrencyCap"> => ({
  minting,
  fanConcurrencyCap: operatorFanCap,
});

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
/**
 * Operability (mirror of the empty-policy warning in `warnLiveBrokerMisconfig`):
 * a scope POLICY is configured but no broker is enabled, so the policy is
 * silently inert — every `requires` resolves against the static base context,
 * unguarded by the per-node gate the operator evidently intended. Surface it once.
 * Defensive `?? {}`: hand-built test configs may bypass the zod default.
 */
const warnInertScopePolicy = (config: HostConfig, logger: SyncLogger): void => {
  if (Object.keys(config.AGENT_CLIENT_SCOPES ?? {}).length > 0) {
    logger.warn(
      "AGENT_CLIENT_SCOPES is configured but REALM_JWT_ISSUER is unset — no capability broker " +
        "is wired, so the scope policy is inert (set REALM_JWT_ISSUER to enable the broker)",
    );
  }
};

/**
 * Operability warnings for a LIVE broker selection.
 *
 * An empty scope policy means every mint fails closed (safe but surprising).
 * Surface it once at boot so a misconfigured realm policy is diagnosable from
 * the logs rather than from a wall of per-mint refusals.
 *
 * Defense-in-depth: the LIVE broker is being selected but its
 * `resolveSubjectToken` is the inert fail-safe — the host-side
 * `SubjectTokenRegistry` was not wired in. Every USER hop's RFC 8693 exchange
 * will then fail CLOSED (no `subject_token` proof resolvable), which is safe
 * but, if unintended, looks like an opaque per-run refusal. Surface the
 * misconfiguration ONCE so it is diagnosable from the boot log. The fail-closed
 * behaviour is unchanged — this only names the cause. (In normal `createHost`
 * wiring the live registry's `resolve` is always passed, so this never fires;
 * it guards against a future wiring regression.)
 */
const warnLiveBrokerMisconfig = (
  config: HostConfig,
  logger: SyncLogger,
  resolveSubjectToken: (runId: RunId) => SubjectToken | undefined,
): void => {
  if (Object.keys(config.AGENT_CLIENT_SCOPES ?? {}).length === 0) {
    logger.warn(
      "live capability broker selected with empty scope policy — all mints will fail closed",
    );
  }
  if (resolveSubjectToken === inertResolveSubjectToken) {
    logger.warn(
      "live capability broker selected without a subject-token resolver — user-initiated " +
        "runs will FAIL CLOSED on the RFC 8693 exchange (the SubjectTokenRegistry is not wired)",
    );
  }
};

/**
 * The Entra WIF exchange and the Graph transport are wired TOGETHER (the app-only
 * token from WIF is what the Graph transport presents) — both behind the Entra
 * config (`ENTRA_TENANT_ID` AND `ENTRA_CLIENT_ID`, validated as an inseparable
 * pair at boot, so either-set ⇒ both-set). The SA token is the only credential
 * (SC-011): no static Entra secret.
 *
 * Parse-don't-validate: the pair is lifted into ONE `EntraWifConfig | undefined`
 * so its presence both gates the legs and carries the narrowed (non-undefined)
 * strings — no later non-null assertion needed.
 */
const selectEntraAuthority = (
  config: HostConfig,
): { readonly wired: boolean; readonly entraWif: EntraWifExchange; readonly graphHttp: GraphHttp } => {
  const entraConfig: EntraWifConfig | undefined =
    config.ENTRA_TENANT_ID !== undefined && config.ENTRA_CLIENT_ID !== undefined
      ? { tenantId: config.ENTRA_TENANT_ID, clientId: config.ENTRA_CLIENT_ID }
      : undefined;
  if (entraConfig === undefined) {
    return { wired: false, entraWif: createUnwiredEntraWifExchange(), graphHttp: createUnwiredGraphHttp() };
  }
  return {
    wired: true,
    entraWif: createEntraWifExchange(entraConfig, createFetchHttpPost()),
    graphHttp: createFetchGraphHttp(),
  };
};

/**
 * Keycloak SA-mint leg ⟸ KEYCLOAK_AGENT_CLIENT_CREDENTIALS present (a non-empty
 * credential map). The token URL is the explicit KEYCLOAK_TOKEN_URL (https-
 * validated at boot) or, when unset, derived from the realm issuer.
 */
const selectKeycloakEndpoint = (
  config: HostConfig,
  realmIssuer: string,
): { readonly wired: boolean; readonly endpoint: KeycloakTokenEndpoint } => {
  if (Object.keys(config.KEYCLOAK_AGENT_CLIENT_CREDENTIALS).length === 0) {
    return { wired: false, endpoint: createUnwiredTokenEndpoint() };
  }
  return {
    wired: true,
    endpoint: createKeycloakTokenEndpoint({
      config: {
        tokenUrl:
          config.KEYCLOAK_TOKEN_URL ??
          `${realmIssuer.replace(/\/$/, "")}/protocol/openid-connect/token`,
      },
      http: createFetchHttpPost(),
      credentials: createAgentClientCredentials(config.KEYCLOAK_AGENT_CLIENT_CREDENTIALS),
    }),
  };
};

/**
 * FR-011: emit EXACTLY ONE boot warning naming the unwired leg(s), only when a
 * leg is partially/unwired. Both wired → no warning.
 */
const warnUnwiredLegs = (logger: SyncLogger, keycloakWired: boolean, entraWired: boolean): void => {
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
};

/**
 * Own-property lookup only — never resolve an inherited Object.prototype key
 * (`constructor`, `toString`, …) to a scope set; an unknown agent client
 * resolves to NO scopes (fail-closed), matching the sibling guards in
 * `createAgentClientCredentials` / `approverTeamIdentity`.
 */
const assignedScopesFor = (config: HostConfig): AssignedScopes => (agentClientId) => {
  const scopes = config.AGENT_CLIENT_SCOPES ?? {};
  return new Set(
    Object.prototype.hasOwnProperty.call(scopes, agentClientId) ? scopes[agentClientId] : [],
  );
};

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
  resolveSubjectToken: (runId: RunId) => SubjectToken | undefined = inertResolveSubjectToken,
): CapabilityBroker | undefined => {
  if (config.REALM_JWT_ISSUER === undefined) {
    warnInertScopePolicy(config, logger);
    return undefined;
  }
  warnLiveBrokerMisconfig(config, logger, resolveSubjectToken);

  // ── AD-3 config-presence gating (FR-011): wire each leg LIVE only when its own
  //    config is present. No single global enable flag — a leg without its config
  //    keeps the fail-closed unwired stub.
  const keycloak = selectKeycloakEndpoint(config, config.REALM_JWT_ISSUER);
  const entra = selectEntraAuthority(config);
  warnUnwiredLegs(logger, keycloak.wired, entra.wired);

  return createKeycloakBroker({
    endpoint: keycloak.endpoint,
    entraWif: entra.entraWif,
    graphHttp: entra.graphHttp,
    assignedScopes: assignedScopesFor(config),
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

/** Stops the periodic HITL reconciliation sweep and awaits any in-flight one. */
export interface HitlReconciliationHandle {
  /** Stop scheduling further sweeps. Idempotent. */
  readonly stop: () => void;
  /** Resolve once the sweep currently in flight (if any) has finished. */
  readonly settle: () => Promise<void>;
}

/** Everything the HITL durable run engine contributes to a booted host. */
export interface HitlWiring {
  readonly service: HitlRunService | undefined;
  readonly worker: WorkerHandle | undefined;
  readonly reconciliation: HitlReconciliationHandle | undefined;
  readonly teamsBotHandle:
    | ((input: { authHeader: string | undefined; activity: unknown }) => Promise<BotResponse>)
    | undefined;
  readonly notifier: HumanReviewNotifierPort | undefined;
  readonly conversations: ConversationStorePort | undefined;
}

/** The inputs every HITL wiring step reads. */
interface HitlWiringArgs {
  readonly config: HostConfig;
  readonly sharedInfra: SharedInfra;
  readonly routedTenant: TenantId;
  readonly logger: LogPort;
  readonly broker: CapabilityBroker | undefined;
  readonly queueBackend: QueueBackend | undefined;
  readonly getHostState: () => HostState;
}

type TeamsBotHandle = (input: { authHeader: string | undefined; activity: unknown }) => Promise<BotResponse>;

/** The notifier (and, for the Bot Framework transport, its conversation store) a selection yields. */
interface NotifierWiring {
  readonly notifier: HumanReviewNotifierPort | undefined;
  readonly conversations: ConversationStorePort | undefined;
}

/**
 * Build the notifier for the selected transport. Exhaustive over the selection
 * union: a fourth transport cannot be added without the compiler demanding its
 * wiring here.
 */
const buildHitlNotifier = (selection: HitlNotifierSelection, args: HitlWiringArgs): NotifierWiring =>
  match(selection)
    .with({ kind: "bot-framework" }, (bot): NotifierWiring => {
      // SECURITY (FR-013 / SC-001): the HITL conversation store is bound to the
      // `routedTenant` so every `fugue:<tenant>:hitl:*` key is scoped under that
      // tenant's Redis ACL. `routedTenant` is the worker's resolved `Tenant.id`
      // when one is injected, falling back to the constant `default` only in the
      // single-tenant `createHost`/main.ts path where no tenant is passed (FR-035).
      const { sharedInfra } = args;
      const conversations = createRedisConversationStore(sharedInfra.redis, args.routedTenant, sharedInfra.logger);
      const connector = createBotConnector(
        {
          appId: bot.appId,
          appPassword: bot.appPassword,
          ...(bot.tokenUrl !== undefined ? { tokenUrl: bot.tokenUrl } : {}),
        },
        sharedInfra.logger,
      );
      return { notifier: createBotFrameworkNotifier({ connector, conversations }), conversations };
    })
    .with({ kind: "webhook" }, (webhook): NotifierWiring => ({
      notifier: createWebhookNotifier(
        { webhookUrl: webhook.webhookUrl, approvalBaseUrl: webhook.approvalBaseUrl },
        fetchWebhookHttp(),
      ),
      conversations: undefined,
    }))
    .with({ kind: "disabled", reason: "bot-password-missing" }, (): NotifierWiring => {
      args.logger.warn("BOT_APP_ID is set but BOT_APP_PASSWORD is not — Bot Framework transport disabled");
      return { notifier: undefined, conversations: undefined };
    })
    // Nothing configured at all is a silent, expected outcome — HITL is opt-in.
    .with({ kind: "disabled", reason: "unconfigured" }, (): NotifierWiring => ({
      notifier: undefined,
      conversations: undefined,
    }))
    .exhaustive();

/**
 * Durable queue delivery is a wakeup optimization, not the ownership source.
 * Reconcile once AFTER the worker exists (restart recovery), then periodically
 * for direct enqueue failures. Never overlap sweeps; one active-index walk is
 * sufficient because every wakeup is idempotent at processRun + lock seams.
 *
 * The sweep's in-flight promise is owned by the closure that creates it, so
 * teardown asks the returned handle to `stop()`/`settle()` rather than reaching
 * into its state.
 */
const startHitlReconciliation = async (
  service: HitlRunService,
  logger: LogPort,
  intervalMs: number,
): Promise<HitlReconciliationHandle> => {
  let inFlight: Promise<void> | undefined;
  const reconcileHitlRuns = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      try {
        const reconciled = await service.reconcileActiveRuns();
        if (!reconciled.ok) {
          logWithoutThrowing(logger, "error", "HITL active-run reconciliation failed", {
            error: reconciled.error.kind,
          });
        }
      } catch (error) {
        // Adapter contracts are no-throw, but lifecycle supervision must remain
        // total if a non-conforming dependency rejects unexpectedly.
        logWithoutThrowing(logger, "error", "HITL active-run reconciliation threw", {
          error: safeErrorMessage(error),
        });
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
  await reconcileHitlRuns();
  const timer = setInterval(
    () => { void reconcileHitlRuns(); },
    intervalMs,
  );
  return {
    stop: () => { clearInterval(timer); },
    settle: async () => { await inFlight; },
  };
};

/** The durable run service + its queue worker + the reconciliation sweep. */
interface DurableRunEngine {
  readonly service: HitlRunService;
  readonly worker: WorkerHandle;
  readonly reconciliation: HitlReconciliationHandle;
}

/**
 * Compose the HITL run executor over the host's DAG registry. FR-013 / SC-001
 * tenancy: it is bound to the `routedTenant`. `getHostState` is read at RUN time
 * so the executor always resolves DAGs against the current registry.
 */
const createHitlExecutor = (args: HitlWiringArgs): RunExecutorPort => {
  const { config, sharedInfra, routedTenant, broker, getHostState } = args;
  return createRunExecutor({
    sharedInfra,
    getRegisteredDag: (id) => {
      const reg = getRegistry(getHostState());
      return reg ? lookupDag(reg, id as DagId) : undefined;
    },
    broker,
    agentClientMap: config.AGENT_CLIENT_MAP,
    tenant: routedTenant,
    runRetentionTtlSec: config.HITL_RUN_TTL_SEC,
    // FR-030: the operator ceiling on map-fan child concurrency, branded by
    // the config parse; the executor applies it to every resumable slice.
    fanConcurrencyCap: config.FAN_CHILD_CONCURRENCY_MAX,
    logger: sharedInfra.logger,
  });
};

/**
 * Compose the HITL stores, executor, queue and service. Every HITL store is
 * bound to the `routedTenant` (FR-013 / SC-001) so every `fugue:<tenant>:hitl:*`
 * key stays under that tenant's Redis ACL.
 */
const composeHitlRunService = (
  args: HitlWiringArgs,
  queueBackend: QueueBackend,
  notifier: HumanReviewNotifierPort,
): { readonly service: HitlRunService; readonly runQueue: ReturnType<typeof createRunQueue> } => {
  const { config, sharedInfra, routedTenant } = args;
  // Parse the generic Redis adapter once at composition. Every HITL adapter
  // below receives a required transaction capability; incomplete wiring fails
  // before a queue worker can acquire or execute any run.
  const hitlRedis = requireHitlRedisPort(sharedInfra.redis);
  const leaseAuthority = createRunLeaseAuthority();
  const runStore = createRedisRunStore(
    hitlRedis,
    routedTenant,
    { ttlSec: config.HITL_RUN_TTL_SEC },
    leaseAuthority.verifier,
    sharedInfra.logger,
  );
  const decisions = createRedisDecisionStore(hitlRedis, routedTenant, { ttlSec: config.HITL_RUN_TTL_SEC }, sharedInfra.logger);
  const executor = createHitlExecutor(args);
  const runQueue = createRunQueue({
    backend: queueBackend,
    redis: hitlRedis,
    leaseIssuer: leaseAuthority.issuer,
    // FR-013 / SC-001: scope the single-flight lock key to the `routedTenant`
    // (`fugue:<tenant>:hitl:lock:*`).
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
  return { service, runQueue };
};

/** Compose the run service, start its queue worker, and start reconciling. */
const startDurableRunEngine = async (
  args: HitlWiringArgs,
  queueBackend: QueueBackend,
  notifier: HumanReviewNotifierPort,
): Promise<DurableRunEngine> => {
  const { config, logger } = args;
  const { service, runQueue } = composeHitlRunService(args, queueBackend, notifier);
  const worker = runQueue.startWorker(service.processRun, { concurrency: config.HITL_WORKER_CONCURRENCY });
  const reconciliation = await startHitlReconciliation(service, logger, config.HITL_RECONCILE_INTERVAL_MS);
  return { service, worker, reconciliation };
};

/**
 * Connect the selected transport's inbound side and log which transport is live.
 * The in-Teams transport also needs its inbound endpoint: verify the Bot
 * Framework token, then dispatch button clicks to the run service.
 */
const connectInboundTransport = (
  selection: HitlNotifierSelection,
  args: HitlWiringArgs,
  service: HitlRunService,
  conversations: ConversationStorePort | undefined,
): TeamsBotHandle | undefined => {
  const { config, sharedInfra, logger } = args;
  if (selection.kind === "bot-framework" && conversations !== undefined) {
    const verify = createBotTokenVerifier({ appId: selection.appId });
    logger.info("HITL durable run engine enabled (Bot Framework in-Teams transport)");
    return (input) =>
      handleBotActivity(
        {
          verify,
          hitl: service,
          conversations,
          // FR-041: authorize the Teams approver against the immutable owning
          // team persisted on the run, at parity with the HTTP path.
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
  }
  if (selection.kind === "webhook") {
    // The webhook branch is the only other selection that reaches here: a
    // `disabled` selection never defines a notifier. Name the resolved approval
    // base in the boot log and flag the DERIVED `http://localhost:<PORT>` default,
    // whose card Review deep-link is unreachable outside the host machine.
    logger.info(
      `HITL durable run engine enabled (Teams webhook transport) — approval base ${selection.approvalBaseUrl}` +
        (config.HITL_APPROVAL_BASE_URL === undefined
          ? " (derived localhost default: HITL_APPROVAL_BASE_URL is unset — Review deep-links are unreachable outside the host machine)"
          : ""),
    );
  }
  return undefined;
};

/**
 * Wire the HITL durable run engine (ADR-0060).
 *
 * Enabled when a notifier transport is configured (Bot Framework cards, or the
 * webhook smoke-test) AND a queue backend is wired. HITL DAGs (those declaring
 * `humanReview`) run on this durable queue and park for human review; non-HITL
 * DAGs keep the synchronous inline path. Bot Framework (in-Teams buttons) takes
 * precedence over the webhook (link-out) when both are configured
 * (`selectHitlNotifierTransport`).
 *
 * `getHostState` is a thunk, not a value: the executor resolves DAGs through the
 * registry at RUN time, long after boot, and must see the current state.
 */
const wireHitlRunEngine = async (args: HitlWiringArgs): Promise<HitlWiring> => {
  const { config, logger, queueBackend } = args;
  const selection = selectHitlNotifierTransport(config);
  const { notifier, conversations } = buildHitlNotifier(selection, args);
  const off = { service: undefined, worker: undefined, reconciliation: undefined, teamsBotHandle: undefined };

  if (notifier === undefined) return { ...off, notifier, conversations };
  if (queueBackend === undefined) {
    logger.warn("A HITL notifier is configured but no queue backend was wired — HITL is disabled");
    return { ...off, notifier, conversations };
  }

  const engine = await startDurableRunEngine(args, queueBackend, notifier);
  const teamsBotHandle = connectInboundTransport(selection, args, engine.service, conversations);
  return { ...engine, teamsBotHandle, notifier, conversations };
};

// ── Host shell state ─────────────────────────────────────────────────────

/**
 * The host's per-instance mutable state (imperative shell). Every lifecycle step
 * below takes this explicitly; the field set is exactly the mutable `let`s the
 * host owns. Teardown clears the HITL/capability fields so it stays idempotent.
 */
interface HostShell {
  hostState: HostState;
  concurrency: ConcurrencyState;
  readonly circuitBreakers: Map<DagId, CircuitState>;
  syncLoop: SyncLoopHandle | null;
  redisProbe: RedisProbeHandle | null;
  signalHandle: SignalHandlerHandle | null;
  server: { port: number; stop: () => void } | null;
  sortedHandles: readonly CapabilityHandle[];
  hitlWorker: WorkerHandle | undefined;
  hitlReconciliation: HitlReconciliationHandle | undefined;
}

const createHostShell = (config: HostConfig): HostShell => ({
  hostState: booting(Date.now()),
  concurrency: initConcurrency(config.MAX_GLOBAL_CONCURRENCY, config.DEFAULT_DAG_CONCURRENCY),
  circuitBreakers: new Map<DagId, CircuitState>(),
  syncLoop: null,
  redisProbe: null,
  signalHandle: null,
  server: null,
  sortedHandles: [],
  hitlWorker: undefined,
  hitlReconciliation: undefined,
});

// ── Capability connection + readiness ────────────────────────────────────

/**
 * Connect External Capabilities (ADR-0051). Topologically sort handles so
 * dependencies connect first, then connect all. Failure here aborts boot — a
 * missing capability at runtime is worse than a clean boot failure.
 */
const connectCapabilities = async (deps: HostDeps, shell: HostShell): Promise<Result<void, HostError>> => {
  const { sharedInfra, logger } = deps;
  const capHandles = sharedInfra.capabilities;
  if (capHandles.length === 0) return ok(undefined);

  const sortResult = topoSortHandles(capHandles);
  if (!sortResult.ok) {
    return sortResult as Result<never, HostError>;
  }
  const sortedHandles = sortResult.value;
  shell.sortedHandles = sortedHandles;
  const connectResult = await connectAll(sortedHandles, logger);
  if (!connectResult.ok) {
    // Boot aborts — close the handles that already connected so a
    // crash-loop boot doesn't leak pools/sockets on every restart. Cleanup
    // failures remain subordinate to, but cannot disappear behind, the
    // authoritative connect failure.
    const prefixCleanup = await closeAll(connectResult.error.connected, logger);
    return err(bootAbortWithCleanup(connectResult.error.error, [
      ...capabilityCleanupErrors(
        connectResult.error.cleanupFailures,
        "failed capability connect",
      ),
      ...capabilityCleanupErrors(prefixCleanup, "failed capability connect"),
    ]));
  }
  logger.info(`${sortedHandles.length} external capabilities connected`);
  return ok(undefined);
};

/** Transition to ready; a rejected transition aborts boot after closing the capabilities. */
const markHostReady = async (
  deps: HostDeps,
  shell: HostShell,
  registry: Registry,
  sha: GitSha,
): Promise<Result<void, HostError>> => {
  const readyResult = bootComplete(shell.hostState, registry, sha, Date.now());
  if (!readyResult.ok) {
    // Capabilities already connected — close them before aborting boot so a
    // crash-loop boot doesn't leak pools/sockets (same guarantee as the
    // connect-failure path).
    const cleanupFailures = shell.sortedHandles.length > 0
      ? await closeAll(shell.sortedHandles, deps.logger)
      : [];
    const primary: HostError = {
      kind: "internal-invariant-violated",
      message: "Boot → ready transition failed",
      context: { from: readyResult.error.from, to: readyResult.error.to },
    };
    return err(bootAbortWithCleanup(
      primary,
      capabilityCleanupErrors(cleanupFailures, "failed ready transition"),
    ));
  }
  shell.hostState = readyResult.value;
  return ok(undefined);
};

// ── Inbound identity + router wiring ─────────────────────────────────────

/**
 * Inbound user (OIDC) JWT path (FR-020/021/022/023, SC-005).
 * Wired LIVE as ONE inseparable group (verifier + iss/aud policy + run-auth
 * policy) exactly when the realm issuer is configured (`REALM_JWT_ISSUER`).
 * Grouping makes "verifier wired but user-run authorization undecided"
 * UNREPRESENTABLE — `RealmJwtDeps.authorizeUserRun` is REQUIRED (AD-5/FR-021),
 * so constructing the group forces the decision here.
 *
 * The authorization decision is STATELESS (FR-022): it tests the run's
 * DAG-owning team against the user's VERIFIED `teams` claim — no per-request
 * datastore lookup. A user whose `teams` does not include the DAG's team is
 * denied (SC-005), and that denial happens in `canAccessDag` BEFORE any
 * concurrency/slot acquisition in the run path (run-dag.ts).
 *
 * When `REALM_JWT_ISSUER` is unset the group is `undefined`: the JWT path is
 * disabled and a JWT-shaped token fails closed (no signature can be verified →
 * 401). The admin and opaque `fug_` team-token paths are untouched (FR-023).
 */
const buildRealmJwtDeps = (config: HostConfig): RealmJwtDeps | undefined =>
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

/** The boot-selected authority a run is executed under. */
interface RunAuthority {
  readonly broker: CapabilityBroker | undefined;
  readonly subjectTokens: SubjectTokenRegistry;
  readonly routedTenant: TenantId;
}

/**
 * Build the per-run NodeContext factory. The resolved inbound identity is
 * threaded through to the factory (FR-W3-007), which derives `Invocation.origin`
 * from it: an OIDC `user` carries its `sub` (with the DAG's agent-type client as
 * `agentClientId`) so the run is correctly attributed to the user instead of
 * being silently re-labelled `agent`. The origin is returned alongside the base
 * context and threaded into `executeDag` so the broker can authorize each node.
 *
 * The factory also binds the user run's verified subject token host-side
 * (FR-030/FR-032): it reads it off the identity via the pure seam and stores it
 * under the run id so the broker can resolve it for the RFC 8693 exchange.
 * Non-user runs bind nothing. `executeDag` releases it on completion.
 */
const createRunContextFactory = (
  config: HostConfig,
  sharedInfra: SharedInfra,
  authority: RunAuthority,
): RouterDeps["createContext"] =>
  (registered: RegisteredDag, rid: RunId, signal: AbortSignal, identity: AuthIdentity): Promise<NodeContextForDag> =>
    createNodeContextForDag(sharedInfra, registered, rid, signal, identity, {
      agentClientMap: config.AGENT_CLIENT_MAP,
      mintingActive: authority.broker !== undefined,
      bindSubjectToken: authority.subjectTokens.bind,
      routedTenant: authority.routedTenant,
    });

/**
 * Build the synchronous DAG executor. Injects the boot-selected broker + run
 * origin (as one MintingAuthority — the framework's option type makes
 * broker-without-origin unrepresentable) so the framework mints each node's
 * declared scopes PER NODE at dispatch. When `broker` is undefined (no realm
 * config) no minting authority is wired and the framework skips minting —
 * byte-identical to today. `origin` is guaranteed defined whenever `broker` is
 * wired (the factory fails closed on an unmapped DAG, FR-040); the
 * `origin !== undefined` guard is the type-honest, fail-closed expression of
 * that invariant.
 *
 * The teardown that releases the run's subject token (NFR-014) is the exported
 * `withSubjectTokenRelease` seam, so the release-on-BOTH-paths wiring (resolve
 * AND throw) is unit-testable against the real registry.
 */
const createDagExecutor = (config: HostConfig, authority: RunAuthority): RouterDeps["executeDag"] =>
  async <I, O>(
    dag: DagDef,
    input: I,
    ctx: NodeContext,
    origin: InvocationOrigin | undefined,
    meterMintedLlm: ScopedLlmMeter,
  ): Promise<Result<O, FrameworkError>> => {
    const { broker, subjectTokens } = authority;
    return withSubjectTokenRelease(subjectTokens, ctx.runId, () =>
      runDag<I, O>(dag, input, ctx, syncRunOptions(
        // FR-030 / FR-032: the operator fan cap, branded by the host config
        // parse (its only mint site) — the same value every resumable slice gets.
        config.FAN_CHILD_CONCURRENCY_MAX,
        broker !== undefined && origin !== undefined
          ? { broker, origin, meterLlm: meterMintedLlm }
          : undefined,
      )),
    );
  };

/**
 * Assemble the router dependencies.
 *
 * SECURITY (FR-013 / US2 / SC-001): the token store is bound to the
 * `routedTenant` so every `fugue:<tenant>:tokens:*` / `fugue:<tenant>:teams:*`
 * key is scoped under that tenant's Redis ACL. `routedTenant` is the worker's
 * resolved `Tenant.id` when injected, falling back to the constant `default`
 * only in the single-tenant `createHost`/main.ts path (FR-035).
 *
 * The fugue-platform OIDC (`user`) inbound path is the grouped `realmJwt` dep
 * (JWKS verifier + iss/aud policy + the REQUIRED `authorizeUserRun` policy,
 * AD-5): when `REALM_JWT_ISSUER` is unset it is absent and the JWT path is
 * disabled (fail-closed).
 */
const buildRouterDeps = (
  deps: HostDeps,
  shell: HostShell,
  authority: RunAuthority,
  hitl: HitlWiring,
  realmJwt: RealmJwtDeps | undefined,
): RouterDeps => {
  const { config, sharedInfra, logger } = deps;
  const tokenStore = createRedisTokenStore(sharedInfra.redis, authority.routedTenant, sharedInfra.logger);
  return {
    hitl: hitl.service,
    teamsBot: hitl.teamsBotHandle,
    getHostState: () => shell.hostState,
    getConcurrency: () => shell.concurrency,
    setConcurrency: (s) => { shell.concurrency = s; },
    circuit: {
      get: (id) => shell.circuitBreakers.get(id) ?? initCircuit(Date.now()),
      set: (id, s) => { shell.circuitBreakers.set(id, s); },
    },
    createContext: createRunContextFactory(config, sharedInfra, authority),
    executeDag: createDagExecutor(config, authority),
    clock: Date.now,
    newRunId: () => makeRunId(crypto.randomUUID()),
    circuitConfig: {
      threshold: config.CIRCUIT_BREAKER_THRESHOLD,
      windowMs: config.CIRCUIT_BREAKER_WINDOW_MS,
      cooldownMs: config.CIRCUIT_BREAKER_COOLDOWN_MS,
    },
    adminToken: config.ADMIN_TOKEN,
    tokenStore,
    ...(realmJwt !== undefined ? { realmJwt } : {}),
    adminHandlerDeps: {
      tokenStore,
      clock: Date.now,
      generateRandomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
    },
    // Read through a thunk, not by value: capabilities are connected before this
    // router is built, but teardown reassigns `sortedHandles` to `[]`. Capturing
    // it by value would freeze the diagnostic at the boot-time list.
    capabilityHealthDeps: { getHandles: () => shell.sortedHandles },
    logger,
  };
};

// ── Teardown (shared by boot abort and shutdown) ─────────────────────────

/** Records each teardown failure (logged, never thrown) so every later step still runs. */
interface TeardownRecorder {
  readonly failures: unknown[];
  readonly recordFailure: (message: string, error: unknown) => void;
  readonly attempt: (message: string, effect: () => unknown) => Promise<void>;
}

const createTeardownRecorder = (logger: LogPort): TeardownRecorder => {
  const failures: unknown[] = [];
  const recordFailure = (message: string, error: unknown): void => {
    const diagnostic = safeErrorMessage(error);
    failures.push(new Error(`${message}: ${diagnostic}`, { cause: error }));
    logWithoutThrowing(logger, "error", message, { error: diagnostic });
  };
  // Sibling of `performShutdown`'s `attempt`, but awaiting: each teardown step
  // must record its own failure and let EVERY later resource still be
  // attempted, so no step may propagate. Hand-rolling the try/catch per step
  // is how one of them would eventually be written without the fence.
  const attempt = async (message: string, effect: () => unknown): Promise<void> => {
    try {
      await effect();
    } catch (error) {
      recordFailure(message, error);
    }
  };
  return { failures, recordFailure, attempt };
};

/**
 * Stop server-owned reconciliation, then close the HITL worker. Clears ownership
 * before each operation so teardown remains idempotent even when a
 * non-conforming port throws. Every later resource is still attempted.
 */
const stopHitlEngine = async (shell: HostShell, rec: TeardownRecorder, context: string): Promise<void> => {
  const reconciliation = shell.hitlReconciliation;
  shell.hitlReconciliation = undefined;
  if (reconciliation !== undefined) {
    await rec.attempt(
      `Failed to stop HITL reconciliation during ${context}`,
      () => reconciliation.stop(),
    );
    await rec.attempt(
      `Failed to settle HITL reconciliation during ${context}`,
      () => reconciliation.settle(),
    );
  }

  const worker = shell.hitlWorker;
  shell.hitlWorker = undefined;
  if (worker !== undefined) {
    await rec.attempt(`Failed to close HITL worker during ${context}`, () => worker.close());
  }
};

const closeCapabilityHandles = async (
  shell: HostShell,
  logger: LogPort,
  rec: TeardownRecorder,
  context: string,
): Promise<void> => {
  const handles = shell.sortedHandles;
  shell.sortedHandles = [];
  if (handles.length === 0) return;
  try {
    const closeFailures = await closeAll(handles, logger);
    for (const failure of closeFailures) {
      rec.recordFailure(
        `Capability '${failure.name}' failed to close during ${context}`,
        new Error(failure.error),
      );
    }
  } catch (error) {
    rec.recordFailure(`Capability shutdown threw during ${context}`, error);
  }
};

/**
 * Tear down everything acquired after the HTTP server, in reverse acquisition
 * order: server-owned reconciliation → HITL worker → capabilities →
 * infrastructure (`deps.onShutdown`).
 *
 * ONE definition shared by the boot-abort path and `shutdown()`. The two used
 * to open-code the same five steps and had already drifted on two points; this
 * keeps the STRONGER behavior from each side, because each divergence had a
 * correct half:
 *   - Guarded logging + `safeErrorMessage` (from the boot-abort path). A
 *     broken logger, or a hostile thrown value whose `toString` throws, must
 *     never abort the remaining teardown — the resource leak that would cause
 *     is worse than the lost log line.
 *   - Surfacing `closeAll`'s failures (from `shutdown`). The boot-abort path
 *     discarded the returned list, so a capability that failed to close during
 *     a failed boot left no record of WHICH one.
 *
 * Stopping the server is deliberately NOT part of this: the two callers stop
 * it differently on purpose (`shutdown` fences `server.stop()` and continues;
 * the boot-abort path uses `stopBoundServerAfterBindFailure`, whose failure
 * string is folded into the returned error). Callers stop the server, then
 * call this.
 */
const teardownAfterServerStop = async (
  deps: HostDeps,
  shell: HostShell,
  context: string,
): Promise<readonly unknown[]> => {
  const rec = createTeardownRecorder(deps.logger);
  await stopHitlEngine(shell, rec, context);
  await closeCapabilityHandles(shell, deps.logger, rec, context);

  // Captured so the closure keeps the narrowing — a property access would
  // need a non-null assertion here, which the type rules rule out.
  const onShutdown = deps.onShutdown;
  if (onShutdown) {
    await rec.attempt(
      `Infrastructure cleanup failed during ${context} — resources may be leaked`,
      () => onShutdown(),
    );
  }
  return rec.failures;
};

// ── HTTP server ──────────────────────────────────────────────────────────

type FetchHandler = (req: Request) => Response | Promise<Response>;

/**
 * Worker-side tenant-header verification (defense-in-depth, FR-007).
 * The PRIMARY per-tenant boundary is the 0600 socket: a request arriving on
 * this worker's UDS is, by construction, for this worker's tenant. As a cheap
 * SECONDARY check, when the platform-internal `FUGUE_SUPERVISOR_HMAC_KEY` is set
 * AND this host is in UDS/worker mode, verify the supervisor-signed
 * `X-Fugue-Tenant` header against the routed tenant before dispatch and REJECT
 * every non-`ok` outcome (absent / malformed / tenant-mismatch / bad-signature)
 * fail-CLOSED. The supervisor is the sole signer (it strips any client value),
 * so a request reaching here without a valid header for THIS tenant did not
 * transit the supervisor and must not be served.
 *
 * When the key is UNSET we skip verification entirely and serve `app.fetch`
 * unchanged — preserving the legacy single-tenant/TCP path (FR-035). The
 * verification is also skipped on the TCP path even if a key is set, since the
 * signed-header contract only applies to the supervisor→worker UDS hop.
 */
const createFetchHandler = (
  app: { readonly fetch: FetchHandler },
  deps: HostDeps,
  routedTenant: TenantId,
): FetchHandler => {
  const hmacKey = deps.config.FUGUE_SUPERVISOR_HMAC_KEY;
  if (deps.bind?.unix === undefined || hmacKey === undefined) return app.fetch;
  return (req: Request): Response | Promise<Response> => {
    const outcome = verifyTenantHeader(hmacKey, routedTenant, req.headers.get(TENANT_HEADER_NAME) ?? undefined);
    if (outcome.kind !== "ok") {
      // 401 for absent/malformed (no usable principal proof); 403 for a
      // present-but-wrong principal (tenant-mismatch / bad-signature) —
      // the request authenticated as the wrong/forged tenant. Never name
      // another tenant; the worker only knows its own routed tenant.
      const status = outcome.kind === "absent" || outcome.kind === "malformed" ? 401 : 403;
      deps.logger.warn("[worker] rejected request — tenant-header verification failed (fail-closed)", {
        tenant: routedTenant,
        reason: outcome.kind,
      });
      return new Response(
        JSON.stringify({ error: "tenant principal verification failed", reason: outcome.kind }),
        { status, headers: { "Content-Type": "application/json" } },
      );
    }
    return app.fetch(req);
  };
};

/**
 * Bind the listener. Two bind modes (FR-001/FR-035 extend-not-replace):
 *   - DEFAULT (`unixPath` unset): bind a TCP port — the legacy main.ts path.
 *   - `unixPath`: bind a per-tenant Unix-domain socket (the worker, T6). It is
 *     NOT an inbound public listener; the supervisor reverse-proxies inbound
 *     HTTP to it. After bind the socket is chmod'd 0600 so only the supervisor
 *     + worker (same uid) can reach it (FR-007 socket isolation).
 */
const listen = (
  config: HostConfig,
  unixPath: string | undefined,
  fetchHandler: FetchHandler,
): { stop: () => void; port?: number } => {
  const maxRequestBodySize = 10 * 1024 * 1024; // 10MB — prevents request body DoS
  return unixPath !== undefined
    ? Bun.serve({ fetch: fetchHandler, unix: unixPath, maxRequestBodySize })
    : Bun.serve({ fetch: fetchHandler, port: config.PORT, maxRequestBodySize });
};

/**
 * Lock the socket down to the owning uid BEFORE announcing readiness. NOTE:
 * `Bun.serve` binds the socket as soon as it returns, so there is a brief
 * window between bind and this chmod where the path exists at the default
 * umask — the chmod closes it before readiness is announced, and the parent
 * `WORKER_UDS_DIR` perms + the HMAC `X-Fugue-Tenant` check (when configured)
 * backstop that window. A chmod failure is a fail-closed boot abort: an
 * un-restricted tenant socket is worse than a clean boot failure (FR-007).
 */
const restrictSocket = async (unixPath: string | undefined): Promise<void> => {
  if (unixPath === undefined) return;
  const { chmodSync } = await import("node:fs");
  chmodSync(unixPath, 0o600);
};

/**
 * Boot abort after a bind/chmod failure. Tear down everything already acquired
 * before returning the error, mirroring the happy-path shutdown ORDER
 * (server → HITL worker → capabilities).
 * CRITICAL (FR-007): `Bun.serve` binds the socket as soon as it returns, so a
 * chmod failure AFTER a successful bind reaches here with the server LISTENING at
 * the default umask. Stop it (and the already-started HITL worker) explicitly —
 * depending only on the OPTIONAL `onShutdown` would otherwise leave a
 * mis-permissioned tenant socket listening, worse than a clean boot failure.
 */
const abortBootAfterBindFailure = async (
  deps: HostDeps,
  shell: HostShell,
  bunServer: { readonly stop: () => void } | undefined,
  bindDesc: string,
  cause: unknown,
): Promise<Result<never, HostError>> => {
  const unixPath = deps.bind?.unix;
  const serverStopFailure = stopBoundServerAfterBindFailure(bunServer, bindDesc, deps.logger);
  const teardownFailures = await teardownAfterServerStop(
    deps,
    shell,
    "boot abort after server bind failure",
  );
  const primary: HostError = {
    kind: "internal-invariant-violated",
    message: `Failed to bind HTTP server on ${bindDesc}: ${safeErrorMessage(cause)}`,
    context: unixPath !== undefined ? { unix: unixPath } : { port: deps.config.PORT },
  };
  return err(bootAbortWithCleanup(primary, [
    ...(serverStopFailure === undefined
      ? []
      : [new Error(
          `Failed to stop the bound server; listener may still be live: ${serverStopFailure}`,
        )]),
    ...teardownFailures,
  ]));
};

/**
 * Make the security posture observable at boot: whether the worker-side
 * tenant-header check is enforcing (key set + UDS mode) or relying on socket
 * isolation alone (FR-007 defense-in-depth).
 */
const logHeaderVerificationPosture = (deps: HostDeps, routedTenant: TenantId): void => {
  if (deps.bind?.unix === undefined) return;
  deps.logger.info(
    deps.config.FUGUE_SUPERVISOR_HMAC_KEY !== undefined
      ? "Worker tenant-header verification ACTIVE (fail-closed) — supervisor-signed X-Fugue-Tenant required and bound to this tenant"
      : "Worker tenant-header verification INACTIVE (no FUGUE_SUPERVISOR_HMAC_KEY) — relying on 0600 socket isolation alone",
    { tenant: routedTenant },
  );
};

const bindHttpServer = async (
  deps: HostDeps,
  shell: HostShell,
  app: { readonly fetch: FetchHandler },
  routedTenant: TenantId,
): Promise<Result<void, HostError>> => {
  const { config, logger } = deps;
  const unixPath = deps.bind?.unix;
  const bindDesc = unixPath !== undefined ? `unix socket ${unixPath}` : `port ${config.PORT}`;
  const fetchHandler = createFetchHandler(app, deps, routedTenant);

  // `| undefined` is type-honest: `Bun.serve` may throw before assigning (a bind
  // failure), and the catch below must be able to ask "did we bind?".
  let bunServer: { stop: () => void; port?: number } | undefined;
  try {
    bunServer = listen(config, unixPath, fetchHandler);
    await restrictSocket(unixPath);
  } catch (e) {
    return abortBootAfterBindFailure(deps, shell, bunServer, bindDesc, e);
  }
  // The catch above returns on any bind/chmod failure, so reaching here means the
  // server is bound and `bunServer` is assigned.
  const listening = bunServer;
  shell.server = {
    // A UDS server has no TCP port; report 0 so the handle stays well-typed
    // without claiming a port the worker is not listening on.
    port: listening?.port ?? (unixPath !== undefined ? 0 : config.PORT),
    stop: () => listening?.stop(),
  };
  logger.info(`HTTP server listening on ${bindDesc}`);
  logHeaderVerificationPosture(deps, routedTenant);
  return ok(undefined);
};

// ── Sync loop + Redis liveness probe ─────────────────────────────────────

const startHostSyncLoop = (
  deps: HostDeps,
  shell: HostShell,
  syncConfig: SyncConfig,
  sha: GitSha,
): SyncLoopHandle => {
  const syncCallbacks = createSyncCallbacks({
    getState: () => shell.hostState,
    setState: (s) => { shell.hostState = s; },
    getCircuitBreakers: () => shell.circuitBreakers,
    getConcurrency: () => shell.concurrency,
    setConcurrency: (s) => { shell.concurrency = s; },
    logger: deps.logger,
    clock: Date.now,
  });

  return startSyncLoop(
    deps.git,
    deps.loader,
    syncConfig,
    deps.logger,
    syncCallbacks.onStarted,
    syncCallbacks.onComplete,
    syncCallbacks.onNoChange,
    syncCallbacks.onError,
    sha,
  );
};

/**
 * Redis Liveness Probe. Drives the redis-disconnected degraded state after boot.
 * Transitions are attempted on every tick and applied only when valid (redisDied
 * is valid from ready/syncing; redisRecovered only from degraded:redis-disconnected),
 * so the edge-vs-level distinction is handled by the pure state machine, not here.
 */
const startHostRedisProbe = (deps: HostDeps, shell: HostShell): RedisProbeHandle => {
  const { logger } = deps;
  return startRedisProbe(
    deps.redis,
    deps.config.REDIS_PROBE_INTERVAL_MS,
    {
      onDead: () => {
        const result = redisDied(shell.hostState, Date.now());
        if (result.ok) {
          shell.hostState = result.value;
          logger.warn("Redis liveness probe failed — host degraded (redis-disconnected)");
        } else if (shell.hostState.phase !== "degraded") {
          // Already-degraded is the expected no-op; any other rejection is a real
          // state-machine surprise worth surfacing (mirrors the sync-callbacks pattern).
          logger.warn("redisDied transition unexpectedly rejected", {
            currentPhase: shell.hostState.phase,
            error: result.error.message,
          });
        }
      },
      onAlive: () => {
        if (shell.hostState.phase === "degraded" && shell.hostState.reason === "redis-disconnected") {
          const result = redisRecovered(shell.hostState);
          if (result.ok) {
            shell.hostState = result.value;
            logger.info("Redis recovered — host returned to ready");
          } else {
            logger.warn("redisRecovered transition unexpectedly rejected", {
              currentPhase: shell.hostState.phase,
              error: result.error.message,
            });
          }
        }
      },
    },
    logger,
  );
};

// ── Shutdown ─────────────────────────────────────────────────────────────

/** Records each shutdown failure so the host still completes every step. */
interface ShutdownRecorder {
  readonly failures: unknown[];
  readonly recordFailure: (operation: string, error: unknown) => void;
  readonly attempt: (operation: string, effect: () => void) => void;
}

const createShutdownRecorder = (logger: LogPort): ShutdownRecorder => {
  const failures: unknown[] = [];
  const recordFailure = (operation: string, error: unknown): void => {
    failures.push(new Error(`Shutdown step failed: ${operation}`, { cause: error }));
    logWithoutThrowing(logger, "error", `Shutdown step failed: ${operation}`, {
      error: safeErrorMessage(error),
    });
  };
  const attempt = (operation: string, effect: () => void): void => {
    try {
      effect();
    } catch (error) {
      recordFailure(operation, error);
    }
  };
  return { failures, recordFailure, attempt };
};

/** Stop the sync loop and the Redis liveness probe (each cleared before it is stopped). */
const stopBackgroundLoops = (shell: HostShell, rec: ShutdownRecorder): void => {
  const stoppingSyncLoop = shell.syncLoop;
  shell.syncLoop = null;
  if (stoppingSyncLoop !== null) {
    rec.attempt("stop sync loop", () => stoppingSyncLoop.stop());
  }

  const stoppingRedisProbe = shell.redisProbe;
  shell.redisProbe = null;
  if (stoppingRedisProbe !== null) {
    rec.attempt("stop Redis liveness probe", () => stoppingRedisProbe.stop());
  }
};

/** Begin draining and wait (bounded by `DRAIN_TIMEOUT_MS`) for in-flight requests to finish. */
const drainInflightRequests = async (
  deps: HostDeps,
  shell: HostShell,
  rec: ShutdownRecorder,
): Promise<void> => {
  const inflightCount = shell.concurrency.global.current;
  const drainResult = beginDrain(shell.hostState, inflightCount, Date.now());
  if (drainResult.ok) {
    shell.hostState = drainResult.value;
  } else {
    const transitionError = new Error(drainResult.error.message);
    rec.recordFailure("transition host to draining", transitionError);
  }

  const drainDeadline = Date.now() + deps.config.DRAIN_TIMEOUT_MS;
  while (shell.concurrency.global.current > 0 && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (shell.concurrency.global.current > 0) {
    rec.attempt("log drain timeout", () =>
      deps.logger.warn(`Drain timeout — ${shell.concurrency.global.current} requests still in-flight`));
  }
};

/** Land the stopped transition, report, and throw if any step failed. */
const completeShutdown = (deps: HostDeps, shell: HostShell, rec: ShutdownRecorder): void => {
  const { logger } = deps;
  const stoppedResult = drainComplete(shell.hostState);
  if (stoppedResult.ok) {
    shell.hostState = stoppedResult.value;
  } else {
    rec.recordFailure("transition host to stopped", new Error(stoppedResult.error.message));
  }

  if (rec.failures.length === 0) {
    rec.attempt("log host stopped", () => logger.info("Host stopped"));
  } else {
    logWithoutThrowing(logger, "warn", `Host stopped with ${rec.failures.length} shutdown failure(s)`, {});
  }
  if (rec.failures.length > 0) {
    throw new AggregateError(rec.failures, "Host shutdown completed with failures");
  }
};

const performShutdown = async (deps: HostDeps, shell: HostShell): Promise<void> => {
  const rec = createShutdownRecorder(deps.logger);

  rec.attempt("log shutdown start", () =>
    deps.logger.info("Shutdown initiated — draining in-flight requests..."));
  stopBackgroundLoops(shell, rec);
  await drainInflightRequests(deps, shell, rec);

  const stoppingServer = shell.server;
  shell.server = null;
  if (stoppingServer !== null) {
    rec.attempt("stop HTTP server", () => stoppingServer.stop());
  }

  rec.failures.push(...await teardownAfterServerStop(deps, shell, "shutdown"));
  completeShutdown(deps, shell, rec);
};

/** The idempotent shutdown: every caller shares ONE in-flight shutdown. */
const createShutdown = (deps: HostDeps, shell: HostShell): (() => Promise<void>) => {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    shutdownPromise ??= performShutdown(deps, shell);
    return shutdownPromise;
  };
};

// ── Host factory ─────────────────────────────────────────────────────────

/** The host-side `SubjectTokenRegistry` and the capability broker every run executes under. */
const selectRunAuthority = (deps: HostDeps, routedTenant: TenantId): RunAuthority => {
  // Host-side side-channel carrying each user run's verified `subject_token` from
  // the run-context factory (bind at run start) to the broker (resolve at per-node
  // dispatch) — FR-030/FR-032. The raw token travels ONLY through here; it never
  // crosses `InvocationOrigin` (string-only) nor reaches a capability handle.
  const subjectTokens = createSubjectTokenRegistry();
  // Capability Broker selection (T8 / per-node minting): see `selectCapabilityBroker`.
  // A live Keycloak broker is returned when `REALM_JWT_ISSUER` is set, `undefined`
  // otherwise (no minting authority wired — the zero-regression static path).
  const broker: CapabilityBroker | undefined = deps.capabilityBroker ??
    selectCapabilityBroker(
      deps.config,
      deps.sharedInfra,
      deps.logger,
      Date.now,
      subjectTokens.resolve,
    );
  return { broker, subjectTokens, routedTenant };
};

/**
 * Fold per-DAG concurrency limits from the loaded registry into the limiter (FR-051).
 * Without this, every DAG would silently collapse to DEFAULT_DAG_CONCURRENCY.
 */
const foldRegistryConcurrency = (shell: HostShell, registry: Registry): void => {
  shell.concurrency = reconcileDagLimits(
    shell.concurrency,
    Array.from(registry.dags.values(), (d) => ({ dagId: d.id, max: d.config.maxConcurrency })),
  );
};

const logHostBooted = (shell: HostShell, registry: Registry, logger: SyncLogger): void => {
  logger.info("Host fully booted and ready to serve requests", {
    // Use the typed `server.port` handle (0 in UDS/worker mode) rather than the
    // raw `bunServer.port`, which is `undefined` for a UDS listener and would log
    // a misleading absent port on the boot line.
    port: shell.server?.port,
    dagCount: registry.dags.size,
  });
};

const hostInstanceOf = (shell: HostShell, shutdown: () => Promise<void>): HostInstance => ({
  getState: () => shell.hostState,
  getConcurrency: () => shell.concurrency,
  getCircuitBreakers: () => shell.circuitBreakers as ReadonlyMap<DagId, CircuitState>,
  shutdown: () => {
    if (shell.signalHandle) {
      shell.signalHandle.unregister();
      shell.signalHandle = null;
    }
    return shutdown();
  },
  triggerSync: async () => {
    if (shell.syncLoop) {
      await shell.syncLoop.triggerSync();
    }
  },
  get server() { return shell.server; },
});

/**
 * Create and boot the Fugue host.
 *
 * This is the imperative shell — it constructs mutable state, wires subsystems,
 * and manages lifecycle, in a fixed order: startup → capabilities → ready →
 * authority + HITL → router → HTTP server → sync loop → Redis probe → signals.
 */
export const createHost = async (deps: HostDeps): Promise<Result<HostInstance, HostError>> => {
  const { config, git, loader, redis, sharedInfra, logger } = deps;

  // The tenant every per-tenant Redis key/ACL namespace is scoped under. T6: a
  // worker passes its resolved `Tenant.id`; the legacy single-tenant entrypoint
  // (and main.ts) omit it and keep the constant `default` namespace (FR-035).
  const routedTenant: TenantId = deps.tenant ?? DEFAULT_TENANT_ID;
  const shell = createHostShell(config);

  const startupResult = await executeStartup({ config, redis, git, loader, logger });
  if (!startupResult.ok) {
    return startupResult as Result<never, HostError>;
  }
  const { registry, sha, syncConfig } = startupResult.value;

  const connected = await connectCapabilities(deps, shell);
  if (!connected.ok) return connected;
  const ready = await markHostReady(deps, shell, registry, sha);
  if (!ready.ok) return ready;

  foldRegistryConcurrency(shell, registry);

  const authority = selectRunAuthority(deps, routedTenant);
  const realmJwt = buildRealmJwtDeps(config);
  const hitl = await wireHitlRunEngine({
    config,
    sharedInfra,
    routedTenant,
    logger,
    broker: authority.broker,
    queueBackend: deps.queueBackend,
    getHostState: () => shell.hostState,
  });
  shell.hitlWorker = hitl.worker;
  shell.hitlReconciliation = hitl.reconciliation;

  const app = createRouter(buildRouterDeps(deps, shell, authority, hitl, realmJwt));
  const bound = await bindHttpServer(deps, shell, app, routedTenant);
  if (!bound.ok) return bound;

  shell.syncLoop = startHostSyncLoop(deps, shell, syncConfig, sha);
  shell.redisProbe = startHostRedisProbe(deps, shell);

  const shutdown = createShutdown(deps, shell);
  shell.signalHandle = registerSignalHandlers({ onShutdown: shutdown, logger });

  logHostBooted(shell, registry, logger);
  return ok(hostInstanceOf(shell, shutdown));
};
