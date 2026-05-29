/**
 * Startup sequence — validates preconditions and performs initial sync.
 *
 * This module handles:
 * 1. Validate Redis connectivity (PING) — exit with error if unreachable (FR-006)
 * 2. Build sync config from HostConfig (local vs remote mode)
 * 3. Initial clone + load all DAGs into Registry
 *
 * The full host boot sequence (config parse, SharedInfra, HTTP server,
 * signal handlers, state transitions) is orchestrated in host.ts.
 *
 * @satisfies FR-006 — Host MUST refuse to start if Redis is unreachable
 * @satisfies NFR-020 — Host MUST log startup/shutdown lifecycle events
 */

import { ok, err } from "@fugue/framework";
import type { Result, GitSha } from "@fugue/framework";
import { gitSha } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { HostConfig } from "../domain/config.js";
import type { Registry } from "../domain/registry.js";
import type { GitPort, ModuleLoaderPort, RedisConnectivityPort } from "../ports.js";
import { initialSync } from "../sync/sync-loop.js";
import type { SyncConfig, SyncLogger } from "../sync/sync-loop.js";

// Re-export for backwards compatibility
export type { RedisConnectivityPort } from "../ports.js";

/**
 * The boot result — everything needed to wire the host together.
 */
export interface BootResult {
  readonly registry: Registry;
  readonly sha: GitSha;
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
 * Clock parameter enables deterministic testing of repo path generation.
 */
export const buildSyncConfig = (config: HostConfig, clock: () => number = Date.now): SyncConfig => {
  const isLocalMode = config.DAGS_LOCAL_PATH !== undefined && config.DAGS_LOCAL_PATH !== "";
  const repoPath = isLocalMode
    ? config.DAGS_LOCAL_PATH!
    : `/tmp/fugue-dags-${clock()}`;

  return {
    repoPath,
    repoUrl: config.DAGS_REPO_URL,
    branch: config.DAGS_REPO_BRANCH,
    pollIntervalMs: config.DAGS_POLL_INTERVAL_MS,
    isLocalMode,
    hostTimeoutDefaults: {
      defaultTimeoutMs: config.DEFAULT_DAG_TIMEOUT_MS,
      maxTimeoutMs: config.MAX_DAG_TIMEOUT_MS,
      defaultMaxConcurrent: config.DEFAULT_DAG_CONCURRENCY,
      defaultCacheTtlMs: config.DEFAULT_CACHE_TTL_MS,
      defaultCheckpointTtlMs: config.DEFAULT_CHECKPOINT_TTL_MS,
    },
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
 * @satisfies FR-006, NFR-020
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
