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

import { ok, err, runId as makeRunId } from "@fugue/framework";
import type { Result, DagId, GitSha, NodeContext, DagDef, RunOptions, FrameworkError, RunId } from "@fugue/framework";
import { runDag } from "@fugue/framework";
import type { HostConfig } from "./domain/config.js";
import type { HostState } from "./domain/host-state.js";
import { booting, bootComplete, beginDrain, drainComplete, canServeRequests, getRegistry, redisDied, redisRecovered } from "./domain/host-state.js";
import type { RegisteredDag } from "./domain/registry.js";
import { initConcurrency, reconcileDagLimits } from "./domain/concurrency.js";
import type { CircuitState } from "./domain/circuit-breaker.js";
import { initCircuit } from "./domain/circuit-breaker.js";
import type { GitPort } from "./ports.js";
import type { ModuleLoaderPort } from "./ports.js";
import type { SharedInfra } from "./ports.js";
import type { RedisConnectivityPort } from "./ports.js";
import { createNodeContextForDag } from "./adapters/node-context-factory.js";
import { createRedisTokenStore } from "./adapters/token-store.js";
import { createRouter } from "./http/router.js";
import type { RouterDeps } from "./http/router.js";
import { startSyncLoop } from "./sync/sync-loop.js";
import type { SyncLoopHandle, SyncLogger, SyncConfig } from "./sync/sync-loop.js";
import { createSyncCallbacks } from "./sync/sync-callbacks.js";
import { executeStartup, buildSyncConfig } from "./lifecycle/startup.js";
import type { StartupDeps } from "./lifecycle/startup.js";
import { registerSignalHandlers } from "./lifecycle/signals.js";
import type { SignalHandlerHandle } from "./lifecycle/signals.js";
import { startRedisProbe } from "./lifecycle/redis-probe.js";
import type { RedisProbeHandle } from "./lifecycle/redis-probe.js";
import type { ConcurrencyState } from "./domain/concurrency.js";

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

  // Transition to ready
  const readyResult = bootComplete(hostState, registry, sha, Date.now());
  if (!readyResult.ok) {
    return err({ kind: "internal-invariant-violated", message: "Boot → ready transition failed", context: { from: readyResult.error.from, to: readyResult.error.to } });
  }
  hostState = readyResult.value;

  // Fold per-DAG concurrency limits from the loaded registry into the limiter (FR-051).
  // Without this, every DAG would silently collapse to DEFAULT_DAG_CONCURRENCY.
  concurrency = reconcileDagLimits(
    concurrency,
    Array.from(registry.dags.values(), (d) => ({ dagId: d.id, max: d.config.maxConcurrency })),
  );

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
    createContext: (registered: RegisteredDag, signal: AbortSignal): NodeContext => {
      const rid = makeRunId(crypto.randomUUID());
      return createNodeContextForDag(sharedInfra, registered, rid, signal);
    },
    executeDag: async <I, O>(dag: DagDef, input: I, ctx: NodeContext, opts?: RunOptions): Promise<Result<O, FrameworkError>> => {
      return runDag<I, O>(dag, input, ctx, opts);
    },
    clock: Date.now,
    circuitConfig: {
      threshold: config.CIRCUIT_BREAKER_THRESHOLD,
      windowMs: config.CIRCUIT_BREAKER_WINDOW_MS,
    },
    adminToken: config.ADMIN_TOKEN,
    tokenStore,
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
    // Clean up resources acquired during boot before returning error
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
        }
      },
      onAlive: () => {
        if (hostState.phase === "degraded" && hostState.reason === "redis-disconnected") {
          const result = redisRecovered(hostState);
          if (result.ok) {
            hostState = result.value;
            logger.info("Redis recovered — host returned to ready");
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
