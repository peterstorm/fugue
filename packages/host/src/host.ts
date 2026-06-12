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

import { ok, err, runId as makeRunId } from "@fuguejs/framework";
import type { Result, DagId, GitSha, NodeContext, DagDef, FrameworkError, RunId } from "@fuguejs/framework";
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
import type { CapabilityBroker, InvocationOrigin } from "@fuguejs/framework";
import { createKeycloakBroker } from "./adapters/keycloak-broker.js";
import { createUnwiredTokenEndpoint } from "./adapters/unwired-token-endpoint.js";
import { createUnwiredEntraWifExchange, createUnwiredGraphHttp } from "./adapters/unwired-entra-wif.js";
import { createRouter } from "./http/router.js";
import type { RouterDeps } from "./http/router.js";
import { startSyncLoop } from "./sync/sync-loop.js";
import type { SyncLoopHandle, SyncLogger, SyncConfig } from "./sync/sync-loop.js";
import { createSyncCallbacks } from "./sync/sync-callbacks.js";
import { executeStartup } from "./lifecycle/startup.js";
import type { StartupDeps } from "./lifecycle/startup.js";
import { registerSignalHandlers } from "./lifecycle/signals.js";
import type { SignalHandlerHandle } from "./lifecycle/signals.js";
import { startRedisProbe } from "./lifecycle/redis-probe.js";
import type { RedisProbeHandle } from "./lifecycle/redis-probe.js";
import type { ConcurrencyState } from "./domain/concurrency.js";
import { topoSortHandles, connectAll, closeAll } from "./domain/capability-manager.js";

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
  /** Called during graceful shutdown to clean up infrastructure (e.g., close Redis). */
  readonly onShutdown?: () => Promise<void>;
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

// ── Capability Broker selection (T8 / per-node minting, review C1) ─────────

/**
 * Select the capability broker for this boot — the per-invocation AUTHORITY
 * seam. Exported so the selection logic (config → broker, `AGENT_CLIENT_SCOPES`
 * → `assignedScopes` closure, unwired fail-closed endpoints) is testable
 * without booting a full host (review C7.5).
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
 * The token endpoint is the unwired fail-closed default in this wave (the real
 * JWKS/HTTP adapter is a later wave): an assigned-but-not-yet-wired scope
 * surfaces `infra-unreachable` (retriable), never a silent success — mirroring
 * how the `realmJwt` group is left undefined so the JWT inbound path fails closed.
 */
export const selectCapabilityBroker = (
  config: HostConfig,
  sharedInfra: Pick<SharedInfra, "tracer" | "logger">,
  logger: SyncLogger,
  now: () => number = Date.now,
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
  if (Object.keys(config.AGENT_CLIENT_SCOPES).length === 0) {
    logger.warn(
      "live capability broker selected with empty scope policy — all mints will fail closed",
    );
  }
  // Operability: the realm issuer is set (broker enabled) but the inbound JWT
  // verifier is NOT yet wired into the router (a later wave). Surface it once
  // so the half-wired state is diagnosable — the user inbound path stays
  // fail-closed (a JWT-shaped token 401s) until the verifier lands.
  logger.warn(
    "live capability broker selected (REALM_JWT_ISSUER set) while the inbound JWT verifier is not wired — " +
      "user-initiated runs are not yet acceptable; agent runs mint per-node",
  );
  return createKeycloakBroker({
    endpoint: createUnwiredTokenEndpoint(),
    // The WIF exchange + Graph transport are the unwired fail-closed defaults
    // in this wave too (awaiting the live `fugue-agents` federated credential):
    // an assigned scope whose Keycloak mint would succeed still surfaces
    // `infra-unreachable` at the WIF hop, never a silent success. No static
    // Entra secret/cert is wired anywhere here (SC-011 holds trivially).
    entraWif: createUnwiredEntraWifExchange(),
    graphHttp: createUnwiredGraphHttp(),
    assignedScopes: (agentClientId) =>
      new Set(config.AGENT_CLIENT_SCOPES[agentClientId] ?? []),
    tracer: sharedInfra.tracer,
    logger: sharedInfra.logger,
    now,
  });
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

  // ── Capability Broker selection (T8 / per-node minting, review C1) ──────────
  // See `selectCapabilityBroker` above: live Keycloak broker when
  // `REALM_JWT_ISSUER` is set (unwired fail-closed endpoints this wave),
  // `undefined` otherwise (no minting authority wired — the zero-regression
  // static path). A node declaring `requires: ["http", "msgraph:mail.send"]`
  // keeps its static `http` client AND gets a freshly minted `mail.send` handle.
  const broker: CapabilityBroker | undefined = selectCapabilityBroker(config, sharedInfra, logger);

  // ── Router Dependencies ──────────────────────────────────────────────────
  const tokenStore = createRedisTokenStore(sharedInfra.redis, sharedInfra.logger);

  const routerDeps: RouterDeps = {
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
      return createNodeContextForDag(sharedInfra, registered, rid, signal, identity);
    },
    executeDag: async <I, O>(
      dag: DagDef,
      input: I,
      ctx: NodeContext,
      origin: InvocationOrigin,
    ): Promise<Result<O, FrameworkError>> => {
      // Inject the boot-selected broker + run origin (as one MintingAuthority —
      // the framework's option type makes broker-without-origin unrepresentable)
      // so the framework mints each node's declared scopes PER NODE at dispatch.
      // When `broker` is undefined (no realm config) no minting authority is
      // wired and the framework skips minting — byte-identical to today.
      return runDag<I, O>(dag, input, ctx, {
        minting: broker !== undefined ? { broker, origin } : undefined,
      });
    },
    clock: Date.now,
    circuitConfig: {
      threshold: config.CIRCUIT_BREAKER_THRESHOLD,
      windowMs: config.CIRCUIT_BREAKER_WINDOW_MS,
      cooldownMs: config.CIRCUIT_BREAKER_COOLDOWN_MS,
    },
    adminToken: config.ADMIN_TOKEN,
    tokenStore,
    // fugue-platform OIDC (`user`) inbound path (FR-W3-006/007). The JWT path
    // is wired as ONE grouped `realmJwt` dep (verifier + iss/aud policy,
    // inseparable) — deliberately ABSENT here: T8 selected the broker but left
    // the JWKS-backed verifier for a later wave, so a JWT-shaped token fails
    // closed (no signature can be verified → 401). The iss/aud policy values
    // live in config (`REALM_JWT_ISSUER`/`REALM_JWT_AUDIENCE`) ready for that
    // wave.
    //
    // SECURITY: `RealmJwtDeps.authorizeUserRun` is a REQUIRED member of the
    // group — constructing `realmJwt` forces deciding which users may run
    // which teams' DAGs at this wiring site (the compiler enforces it; see
    // middleware/auth.ts). There is no half-wired "verifier without user-run
    // policy" state to fall into. Do NOT wire `() => true` without the realm/
    // role check that decision deserves.
    adminHandlerDeps: {
      tokenStore,
      clock: Date.now,
      generateRandomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
    },
    logger,
  };

  // ── HTTP Server ──────────────────────────────────────────────────────────
  const app = createRouter(routerDeps);
  let bunServer;
  try {
    bunServer = Bun.serve({
      fetch: app.fetch,
      port: config.PORT,
      maxRequestBodySize: 10 * 1024 * 1024, // 10MB — prevents request body DoS
    });
  } catch (e) {
    // Clean up resources acquired during boot before returning error.
    // Close connected capabilities first (reverse topological order), then
    // infrastructure — mirrors the happy-path shutdown ordering.
    if (sortedHandles.length > 0) await closeAll(sortedHandles, logger);
    if (deps.onShutdown) {
      await deps.onShutdown().catch((cleanupErr) => {
        logger.error("Failed to clean up resources after port bind failure", {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      });
    }
    return err({
      kind: "internal-invariant-violated",
      message: `Failed to bind HTTP server on port ${config.PORT}: ${e instanceof Error ? e.message : String(e)}`,
      context: { port: config.PORT },
    });
  }
  server = {
    port: bunServer.port ?? config.PORT,
    stop: () => bunServer.stop(),
  };
  logger.info(`HTTP server listening on port ${bunServer.port}`);

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
    port: bunServer.port,
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
