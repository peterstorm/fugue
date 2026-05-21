/**
 * Sync Loop — Orchestrates periodic git sync and DAG registry updates.
 *
 * The sync loop:
 * 1. Waits for poll interval
 * 2. Checks current SHA (rev-parse)
 * 3. Compares with last known SHA — short-circuits if unchanged
 * 4. Pulls new changes
 * 5. Checks if lockfile changed → runs bun install
 * 6. Discovers and loads all DAGs
 * 7. Builds new immutable registry snapshot
 * 8. Performs atomic swap of registry reference
 *
 * Error isolation: A single DAG import failure does NOT block others.
 *
 * @satisfies FR-001 — Poll git branch at configurable interval and detect new commits
 * @satisfies FR-002 — Run bun install if bun.lockb changed between commits
 * @satisfies FR-003 — Remove DAGs from registry when removed from git
 * @satisfies FR-005 — Log warning and retry on next interval if git unreachable
 * @satisfies FR-007 — Identify each DAG version by git commit SHA
 * @satisfies NFR-003 — Poll overhead <50ms at P99
 * @satisfies NFR-010 — Failing DAG import MUST NOT affect other registered DAGs
 */

import { ok, err } from "@fugue/framework";
import type { Result, DagId } from "@fugue/framework";
import { dagId } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { Registry, RegisteredDag } from "../domain/registry.js";
import { freeze } from "../domain/registry.js";
import { resolveDefaults } from "../domain/dag-registration.js";
import type { GitPort } from "../adapters/git-sync.js";
import type { ModuleLoaderPort, LoadResult } from "../adapters/module-loader.js";
import { diffDags, diffSummary } from "./diff.js";
import type { DagSnapshot } from "./diff.js";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The result of a single sync cycle.
 */
export interface SyncResult {
  readonly kind: "no-change" | "updated" | "error";
  readonly sha: string;
  readonly registry?: Registry;
  readonly errors?: readonly { readonly path: string; readonly error: HostError }[];
  readonly message?: string;
}

/**
 * Configuration for the sync loop.
 */
export interface SyncConfig {
  readonly repoPath: string;
  readonly repoUrl: string;
  readonly branch: string;
  readonly pollIntervalMs: number;
  readonly isLocalMode: boolean;
}

/**
 * Logger interface for sync operations.
 */
export interface SyncLogger {
  readonly info: (msg: string, data?: Record<string, unknown>) => void;
  readonly warn: (msg: string, data?: Record<string, unknown>) => void;
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Callback invoked when a sync cycle begins (before pulling).
 */
export type OnSyncStarted = () => void;

/**
 * Callback invoked when sync completes with a new registry.
 */
export type OnSyncComplete = (registry: Registry, sha: string) => void;

/**
 * Callback invoked when sync fails.
 */
export type OnSyncError = (error: HostError) => void;

/**
 * Clock function — injectable time source for deterministic testing.
 */
export type Clock = () => number;

/**
 * Handle returned from startSyncLoop to control the loop.
 */
export interface SyncLoopHandle {
  readonly stop: () => void;
  readonly triggerSync: () => Promise<SyncResult>;
}

// ── Core Sync Logic (Pure-ish — depends on ports) ──────────────────────────

/**
 * Convert LoadResults to DagSnapshots for diff comparison.
 */
export const loadResultsToSnapshots = (results: readonly LoadResult[], sha: string): DagSnapshot[] =>
  results.map((r) => ({
    id: r.id,
    path: r.modulePath,
    sha,
  }));

/**
 * Convert a LoadResult to a RegisteredDag for the registry.
 */
export const loadResultToRegisteredDag = (
  result: LoadResult,
  sha: string,
  now: number,
): RegisteredDag => {
  const resolved = resolveDefaults(result.registration);
  // Extract team from path: dags/{team}/{dag-name}/dag.ts
  const pathParts = result.modulePath.split("/");
  const dagsDirIndex = pathParts.lastIndexOf("dags");
  const team = dagsDirIndex >= 0 && dagsDirIndex + 1 < pathParts.length
    ? pathParts[dagsDirIndex + 1]
    : "unknown";

  return {
    id: result.id,
    team,
    route: resolved.route,
    dag: resolved.dag,
    inputSchema: resolved.inputSchema,
    config: {
      route: resolved.route,
      timeout: resolved.config.timeoutMs,
      maxConcurrency: resolved.config.maxConcurrent,
    },
    loadedAt: now,
    sha,
    healthy: true,
  };
};

/**
 * Execute a single sync cycle. This is the core logic without timer management.
 *
 * Steps:
 * 1. Get current SHA
 * 2. Compare with last SHA — skip if unchanged
 * 3. Pull changes
 * 4. Check lockfile changes → bun install
 * 5. Discover + load all DAGs
 * 6. Build new registry
 */
export const executeSyncCycle = async (
  git: GitPort,
  loader: ModuleLoaderPort,
  config: SyncConfig,
  lastSha: string,
  logger: SyncLogger,
  clock: Clock = Date.now,
): Promise<SyncResult> => {
  // Step 1: Get current SHA
  const shaResult = await git.currentSha(config.repoPath);
  if (!shaResult.ok) {
    logger.warn("Failed to get current SHA, will retry next interval", {
      error: shaResult.error,
    });
    return {
      kind: "error",
      sha: lastSha,
      message: `SHA check failed: ${shaResult.error.kind}`,
    };
  }

  const currentSha = shaResult.value;

  // Step 2: Skip if unchanged
  if (currentSha === lastSha) {
    return { kind: "no-change", sha: currentSha };
  }

  // Step 3: Pull changes (skip in local mode)
  if (!config.isLocalMode) {
    const pullResult = await git.pull(config.repoPath);
    if (!pullResult.ok) {
      logger.warn("Git pull failed, existing DAGs remain active", {
        error: pullResult.error,
      });
      return {
        kind: "error",
        sha: lastSha,
        message: `pull failed: ${pullResult.error.kind}`,
      };
    }
  }

  // Step 4: Check lockfile changes (skip in local mode)
  if (!config.isLocalMode && lastSha !== "") {
    const lockResult = await git.hasLockfileChanged(config.repoPath, lastSha, currentSha);
    if (!lockResult.ok) {
      logger.warn("Failed to check lockfile changes — skipping bun install", {
        error: lockResult.error,
        fromSha: lastSha,
        toSha: currentSha,
      });
    } else if (lockResult.value) {
      logger.info("bun.lockb changed, running bun install");
      const installResult = await git.install(config.repoPath);
      if (!installResult.ok) {
        logger.error("bun install failed", { error: installResult.error });
        return {
          kind: "error",
          sha: lastSha,
          message: `bun install failed: ${installResult.error.kind}`,
        };
      }
    }
  }

  // Step 5: Discover and load all DAGs
  const bulkResult = await loader.loadAll(config.repoPath, currentSha);

  if (bulkResult.errors.length > 0) {
    for (const loadError of bulkResult.errors) {
      logger.warn(`DAG load failed (isolated): ${loadError.path}`, {
        error: loadError.error,
      });
    }
  }

  // Step 6: Build new registry
  const now = clock();
  const registeredDags = bulkResult.loaded.map((lr) =>
    loadResultToRegisteredDag(lr, currentSha, now),
  );
  const registry = freeze(registeredDags, currentSha, now);

  logger.info(`Sync complete: ${bulkResult.loaded.length} DAGs loaded`, {
    sha: currentSha,
    loaded: bulkResult.loaded.length,
    errors: bulkResult.errors.length,
    diff: diffSummary(
      diffDags([], loadResultsToSnapshots(bulkResult.loaded, currentSha)),
    ),
  });

  return {
    kind: "updated",
    sha: currentSha,
    registry,
    errors: bulkResult.errors.length > 0 ? bulkResult.errors : undefined,
  };
};

// ── Timer-Based Sync Loop ──────────────────────────────────────────────────

/**
 * Start the sync loop. Returns a handle to stop the loop or trigger manual sync.
 */
export const startSyncLoop = (
  git: GitPort,
  loader: ModuleLoaderPort,
  config: SyncConfig,
  logger: SyncLogger,
  onStarted: OnSyncStarted,
  onComplete: OnSyncComplete,
  onError: OnSyncError,
  initialSha: string = "",
): SyncLoopHandle => {
  let lastSha = initialSha;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const doSync = async (): Promise<SyncResult> => {
    if (running) {
      return { kind: "no-change", sha: lastSha, message: "sync already in progress" };
    }

    running = true;
    onStarted();
    try {
      const result = await executeSyncCycle(git, loader, config, lastSha, logger);

      if (result.kind === "updated" && result.registry) {
        lastSha = result.sha;
        onComplete(result.registry, result.sha);
      } else if (result.kind === "no-change") {
        lastSha = result.sha;
      } else if (result.kind === "error") {
        onError({
          kind: "git-pull-failed",
          message: result.message || "sync cycle failed",
        });
      }

      return result;
    } finally {
      running = false;
    }
  };

  // Start the polling timer
  timer = setInterval(() => {
    doSync().catch((e) => {
      logger.error("Unhandled error in sync loop", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }, config.pollIntervalMs);

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    triggerSync: doSync,
  };
};

/**
 * Perform a single initial sync (used at startup before starting the loop).
 * Clones the repo if not in local mode, then loads all DAGs.
 */
export const initialSync = async (
  git: GitPort,
  loader: ModuleLoaderPort,
  config: SyncConfig,
  logger: SyncLogger,
  clock: Clock = Date.now,
): Promise<Result<{ registry: Registry; sha: string }, HostError>> => {
  // Clone if not local mode
  if (!config.isLocalMode) {
    const cloneResult = await git.clone(config.repoUrl, config.repoPath, {
      branch: config.branch,
      depth: 1,
    });
    if (!cloneResult.ok) {
      return cloneResult;
    }
  }

  // Get initial SHA
  const shaResult = await git.currentSha(config.repoPath);
  if (!shaResult.ok) {
    return shaResult;
  }

  const sha = shaResult.value;

  // Load all DAGs
  const bulkResult = await loader.loadAll(config.repoPath, sha);

  if (bulkResult.errors.length > 0) {
    for (const loadError of bulkResult.errors) {
      logger.warn(`DAG load failed (isolated): ${loadError.path}`, {
        error: loadError.error,
      });
    }
  }

  const now = clock();
  const registeredDags = bulkResult.loaded.map((lr) =>
    loadResultToRegisteredDag(lr, sha, now),
  );
  const registry = freeze(registeredDags, sha, now);

  logger.info(`Initial sync complete: ${bulkResult.loaded.length} DAGs loaded`, {
    sha,
    loaded: bulkResult.loaded.length,
    errors: bulkResult.errors.length,
  });

  return ok({ registry, sha });
};
