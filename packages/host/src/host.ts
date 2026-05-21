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
 * @satisfies NFR-030 — Host MUST exit cleanly on SIGTERM after draining in-flight requests
 * @satisfies NFR-031 — Host MUST log startup/shutdown lifecycle events
 */

import { ok, err, runId as makeRunId, dagId } from "@fugue/framework";
import type { Result, DagId, NodeContext, DagDef, RunOptions, FrameworkError, RunId } from "@fugue/framework";
import { runDag } from "@fugue/framework";
import type { HostConfig } from "./domain/config.js";
import type { HostState } from "./domain/host-state.js";
import { booting, bootComplete, beginDrain, drainComplete, syncStarted, syncCompleted, syncFailed, canServeRequests } from "./domain/host-state.js";
import type { Registry } from "./domain/registry.js";
import { emptyRegistry } from "./domain/registry.js";
import type { RegisteredDag } from "./domain/registry.js";
import { initConcurrency } from "./domain/concurrency.js";
import type { CircuitState } from "./domain/circuit-breaker.js";
import { initCircuit, forceReset } from "./domain/circuit-breaker.js";
import type { GitPort } from "./adapters/git-sync.js";
import type { ModuleLoaderPort } from "./adapters/module-loader.js";
import type { SharedInfra, RedisPort } from "./adapters/node-context-factory.js";
import { createNodeContextForDag } from "./adapters/node-context-factory.js";
import { createRouter } from "./http/router.js";
import type { RouterDeps } from "./http/router.js";
import { startSyncLoop } from "./sync/sync-loop.js";
import type { SyncLoopHandle, SyncLogger, SyncConfig } from "./sync/sync-loop.js";
import { executeStartup, buildSyncConfig } from "./lifecycle/startup.js";
import type { RedisConnectivityPort, StartupDeps } from "./lifecycle/startup.js";
import { registerSignalHandlers } from "./lifecycle/signals.js";
import type { SignalHandlerHandle } from "./lifecycle/signals.js";
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
    return err({ kind: "config-invalid", message: `Failed to transition to ready: ${readyResult.error.message}` });
  }
  hostState = readyResult.value;

  // ── Router Dependencies ──────────────────────────────────────────────────
  const routerDeps: RouterDeps = {
    getHostState: () => hostState,
    getConcurrency: () => concurrency,
    setConcurrency: (s) => { concurrency = s; },
    getCircuit: (id) => circuitBreakers.get(id) ?? initCircuit(Date.now()),
    setCircuit: (id, s) => { circuitBreakers.set(id, s); },
    createContext: (registered: RegisteredDag, signal?: AbortSignal): NodeContext => {
      const rid = makeRunId(crypto.randomUUID());
      const effectiveSignal = signal ?? new AbortController().signal;
      return createNodeContextForDag(sharedInfra, registered, rid, effectiveSignal);
    },
    executeDag: async <I, O>(dag: DagDef, input: I, ctx: NodeContext, opts?: RunOptions): Promise<Result<O, FrameworkError>> => {
      return runDag<I, O>(dag, input, ctx, opts);
    },
    clock: Date.now,
  };

  // ── HTTP Server ──────────────────────────────────────────────────────────
  const app = createRouter(routerDeps);
  const bunServer = Bun.serve({
    fetch: app.fetch,
    port: config.PORT,
  });
  server = {
    port: bunServer.port!,
    stop: () => bunServer.stop(),
  };
  logger.info(`HTTP server listening on port ${bunServer.port}`);

  // ── Sync Loop ────────────────────────────────────────────────────────────
  syncLoop = startSyncLoop(
    git,
    loader,
    syncConfig,
    logger,
    // onStarted: transition to syncing via state machine
    () => {
      if (hostState.phase === "draining" || hostState.phase === "stopped") return;
      const result = syncStarted(hostState, Date.now());
      if (result.ok) {
        hostState = result.value;
      } else {
        logger.warn("syncStarted transition failed", {
          currentPhase: hostState.phase,
          error: result.error.message,
        });
      }
    },
    // onComplete: transition syncing → ready
    (newRegistry, newSha) => {
      if (hostState.phase === "draining" || hostState.phase === "stopped") {
        logger.warn("Ignoring sync completion — host is shutting down", { phase: hostState.phase });
        return;
      }

      const result = syncCompleted(hostState, newRegistry, newSha, Date.now());
      if (result.ok) {
        hostState = result.value;
      } else {
        logger.warn("syncCompleted transition failed — state machine violation", {
          currentPhase: hostState.phase,
          error: result.error.message,
        });
      }

      // Force-reset circuit breakers for all DAGs (FR-092)
      const now = Date.now();
      for (const dagId of newRegistry.dags.keys()) {
        circuitBreakers.set(dagId, forceReset(now));
      }
      logger.info("Registry updated via sync", {
        dagCount: newRegistry.dags.size,
        sha: newSha,
      });
    },
    // onError: transition syncing → degraded
    (error) => {
      if (hostState.phase === "draining" || hostState.phase === "stopped") return;

      const result = syncFailed(hostState, Date.now());
      if (result.ok) {
        hostState = result.value;
      } else {
        logger.warn("syncFailed transition failed — state machine violation", {
          currentPhase: hostState.phase,
          error: result.error.message,
        });
      }
      logger.warn("Sync error — existing DAGs remain active", { error });
    },
    sha,
  );

  // ── Shutdown Logic ───────────────────────────────────────────────────────
  const shutdown = async () => {
    logger.info("Shutdown initiated — draining in-flight requests...");

    // Stop sync loop
    if (syncLoop) {
      syncLoop.stop();
      syncLoop = null;
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
    server,
  });
};
