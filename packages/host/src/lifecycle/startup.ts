/**
 * Startup sequence — validates preconditions, performs initial sync,
 * and boots the host into a ready state.
 *
 * Steps:
 * 1. Parse config (HostConfigSchema from env)
 * 2. Validate Redis connectivity (PING) — exit with error if unreachable (FR-006)
 * 3. Clone dags repo (or use DAGS_LOCAL_PATH for dev)
 * 4. Initial sync (discover + load all DAGs into Registry)
 * 5. Construct SharedInfra (LLM client, Redis, tracer)
 * 6. Boot HTTP server (Hono)
 * 7. Start sync loop poll timer
 * 8. Mark host state as "ready"
 *
 * @satisfies FR-006 — Host MUST refuse to start if Redis is unreachable
 * @satisfies NFR-031 — Host MUST log startup/shutdown lifecycle events
 */

import { ok, err } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { HostConfig } from "../domain/config.js";
import type { Registry } from "../domain/registry.js";
import type { RedisPort, SharedInfra } from "../adapters/node-context-factory.js";
import type { GitPort } from "../adapters/git-sync.js";
import type { ModuleLoaderPort } from "../adapters/module-loader.js";
import { initialSync } from "../sync/sync-loop.js";
import type { SyncConfig, SyncLogger } from "../sync/sync-loop.js";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Port for Redis connectivity validation (PING command).
 */
export interface RedisConnectivityPort {
  readonly ping: () => Promise<Result<void, HostError>>;
}

/**
 * The boot result — everything needed to wire the host together.
 */
export interface BootResult {
  readonly registry: Registry;
  readonly sha: string;
  readonly syncConfig: SyncConfig;
}

/**
 * Dependencies for the startup sequence — injected for testability.
 */
export interface StartupDeps {
  readonly config: HostConfig;
  readonly redis: RedisConnectivityPort;
  readonly git: GitPort;
  readonly loader: ModuleLoaderPort;
  readonly logger: SyncLogger;
}

// ── Startup Sequence ───────────────────────────────────────────────────────

/**
 * Validate Redis connectivity by sending PING.
 * Exits with actionable error message if unreachable.
 *
 * @satisfies FR-006 — Host MUST refuse to start if Redis is unreachable
 */
export const validateRedis = async (
  redis: RedisConnectivityPort,
  logger: SyncLogger,
): Promise<Result<void, HostError>> => {
  logger.info("Validating Redis connectivity...");
  const result = await redis.ping();
  if (!result.ok) {
    logger.error("Redis is unreachable — host cannot start", {
      error: result.error,
    });
    return result;
  }
  logger.info("Redis connectivity validated");
  return ok(undefined);
};

/**
 * Build the SyncConfig from HostConfig.
 */
export const buildSyncConfig = (config: HostConfig): SyncConfig => {
  const isLocalMode = config.DAGS_LOCAL_PATH !== undefined && config.DAGS_LOCAL_PATH !== "";
  const repoPath = isLocalMode
    ? config.DAGS_LOCAL_PATH!
    : `/tmp/fugue-dags-${Date.now()}`;

  return {
    repoPath,
    repoUrl: config.DAGS_REPO_URL,
    branch: config.DAGS_REPO_BRANCH,
    pollIntervalMs: config.DAGS_POLL_INTERVAL_MS,
    isLocalMode,
  };
};

/**
 * Execute the full startup sequence:
 * 1. Validate Redis
 * 2. Build sync config
 * 3. Initial clone + load DAGs
 *
 * Returns the BootResult needed for the host to wire together.
 *
 * @satisfies FR-006, NFR-031
 */
export const executeStartup = async (
  deps: StartupDeps,
): Promise<Result<BootResult, HostError>> => {
  const { config, redis, git, loader, logger } = deps;

  // Step 1: Validate Redis connectivity
  logger.info("Starting host boot sequence...", { port: config.PORT });
  const redisResult = await validateRedis(redis, logger);
  if (!redisResult.ok) {
    return redisResult as Result<never, HostError>;
  }

  // Step 2: Build sync config
  const syncConfig = buildSyncConfig(config);
  logger.info("Sync config resolved", {
    isLocalMode: syncConfig.isLocalMode,
    repoPath: syncConfig.repoPath,
    pollIntervalMs: syncConfig.pollIntervalMs,
  });

  // Step 3: Initial clone + load all DAGs
  logger.info("Performing initial sync...");
  const syncResult = await initialSync(git, loader, syncConfig, logger);
  if (!syncResult.ok) {
    logger.error("Initial sync failed — host cannot start", {
      error: syncResult.error,
    });
    return syncResult as Result<never, HostError>;
  }

  logger.info("Boot sequence complete", {
    dagCount: syncResult.value.registry.dags.size,
    sha: syncResult.value.sha,
  });

  return ok({
    registry: syncResult.value.registry,
    sha: syncResult.value.sha,
    syncConfig,
  });
};
