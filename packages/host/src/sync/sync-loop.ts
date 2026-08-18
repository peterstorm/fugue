/**
 * Sync Loop — Orchestrates periodic git sync and DAG registry updates.
 *
 * The sync loop:
 * 1. Waits for poll interval
 * 2. Pulls remote changes (remote mode only, after initial sync)
 * 3. Reads current SHA (rev-parse HEAD — now reflects remote state)
 * 4. Compares with last known SHA — short-circuits if unchanged
 * 5. Checks if lockfile changed → runs bun install
 * 6. Discovers and loads all DAGs
 * 7. Builds new immutable registry snapshot
 * 8. Returns SyncResult to caller (registry swap performed externally by host.ts)
 *
 * Error isolation: A single DAG import failure does NOT block others.
 *
 * @satisfies FR-001 — Poll git branch at configurable interval and detect new commits
 * @satisfies FR-005 — Run bun install if the lockfile (bun.lock / bun.lockb) changed between commits
 * @satisfies FR-002 — Discover DAGs by scanning dags/{team}/{name}/dag.ts convention
 * @satisfies FR-003 — Dynamically import discovered DAG modules with SHA cache-busting
 * @satisfies NFR-003 — Git sync detection MUST complete within poll interval + 5s (individual ops timeout at 30s; overall cycle timeout TBD — tracked for future enforcement)
 * @satisfies NFR-010 — Failing DAG import MUST NOT affect other registered DAGs
 */

import { ok } from "@fuguejs/framework";
import type { Result, GitSha } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { Registry } from "../domain/registry.js";
import { freeze } from "../domain/registry.js";
import type { GitPort, ModuleLoaderPort, Clock } from "../ports.js";
import { loadResultToRegisteredDag } from "../domain/dag-factory.js";
import type { HostTimeoutDefaults } from "../domain/dag-factory.js";

// Re-export for test convenience (tests import from sync-loop)
export { loadResultToRegisteredDag, loadResultsToSnapshots } from "../domain/dag-factory.js";
export type { HostTimeoutDefaults } from "../domain/dag-factory.js";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The result of a single sync cycle — proper discriminated union.
 * Each variant carries exactly the fields relevant to its outcome.
 *
 * SHA semantics per variant:
 * - no-change: `currentSha` — the confirmed-unchanged SHA
 * - updated: `newSha` — the newly synced SHA
 * - error: `previousSha` — the last known-good SHA, or `null` if the failure happened
 *   before any successful sync
 * - skipped: `previousSha` — the last known SHA (or `null` if never synced)
 */
type SyncResult =
  | { readonly kind: "no-change"; readonly currentSha: GitSha }
  | { readonly kind: "updated"; readonly newSha: GitSha; readonly registry: Registry; readonly errors: readonly { readonly path: string; readonly error: HostError }[] }
  | { readonly kind: "error"; readonly previousSha: GitSha | null; readonly syncError: HostError }
  | { readonly kind: "skipped"; readonly previousSha: GitSha | null; readonly reason: "already-in-progress" };

/**
 * Configuration for the sync loop.
 */
export interface SyncConfig {
  readonly repoPath: string;
  readonly repoUrl: string;
  readonly branch: string;
  readonly pollIntervalMs: number;
  readonly isLocalMode: boolean;
  /** Host-level timeout defaults for DAG factory. */
  readonly hostTimeoutDefaults?: HostTimeoutDefaults;
}

/**
 * Logger interface for sync operations.
 * Identical to LogPort — kept as a named alias for clarity at call sites.
 */
export type SyncLogger = import("../ports.js").LogPort;

/**
 * Callback invoked when a sync cycle begins (before pulling).
 */
type OnSyncStarted = () => void;

/**
 * Callback invoked when sync completes with a new registry.
 */
type OnSyncComplete = (registry: Registry, sha: GitSha) => void;

/**
 * Callback invoked when sync completes with no changes (SHA unchanged).
 */
type OnSyncNoChange = (sha: GitSha) => void;

/**
 * Callback invoked when sync fails.
 */
type OnSyncError = (error: HostError) => void;

/**
 * Clock function — re-exported from ports for backward compatibility.
 */
export type { Clock } from "../ports.js";

/**
 * Handle returned from startSyncLoop to control the loop.
 */
export interface SyncLoopHandle {
  readonly stop: () => void;
  readonly triggerSync: () => Promise<SyncResult>;
}

// ── Core Sync Logic (depends on ports) ─────────────────────────────────────

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
  lastSha: GitSha | null,
  logger: SyncLogger,
  clock: Clock = Date.now,
): Promise<SyncResult> => {
  // Step 1: Pull changes first in remote mode (so rev-parse reflects remote state)
  if (!config.isLocalMode && lastSha !== null) {
    const pullResult = await git.pull(config.repoPath);
    if (!pullResult.ok) {
      logger.warn("Git pull failed, existing DAGs remain active", {
        error: pullResult.error,
      });
      return {
        kind: "error",
        previousSha: lastSha,
        syncError: pullResult.error,
      };
    }
  }

  // Step 2: Get current SHA (now reflects remote state after pull)
  const shaResult = await git.currentSha(config.repoPath);
  if (!shaResult.ok) {
    logger.warn("Failed to get current SHA, will retry next interval", {
      error: shaResult.error,
    });
    return {
      kind: "error",
      previousSha: lastSha,
      syncError: shaResult.error,
    };
  }

  const currentSha = shaResult.value;

  // Step 3: Skip if unchanged
  if (currentSha === lastSha) {
    return { kind: "no-change", currentSha };
  }

  // Step 4: Check lockfile changes (skip in local mode and on first sync)
  if (!config.isLocalMode && lastSha !== null) {
    const lockResult = await git.hasLockfileChanged(config.repoPath, lastSha, currentSha);
    if (!lockResult.ok) {
      // Fail-safe: when we can't determine if lockfile changed, run install defensively.
      // Skipping could cause "Cannot find module" errors for new dependencies.
      logger.warn("Failed to check lockfile changes — running bun install defensively", {
        error: lockResult.error,
        fromSha: lastSha,
        toSha: currentSha,
      });
      const installResult = await git.install(config.repoPath);
      if (!installResult.ok) {
        logger.error("bun install failed (defensive)", { error: installResult.error });
        return {
          kind: "error",
          previousSha: lastSha,
          syncError: installResult.error,
        };
      }
    } else if (lockResult.value) {
      logger.info("lockfile changed, running bun install");
      const installResult = await git.install(config.repoPath);
      if (!installResult.ok) {
        logger.error("bun install failed", { error: installResult.error });
        return {
          kind: "error",
          previousSha: lastSha,
          syncError: installResult.error,
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
    loadResultToRegisteredDag(lr, currentSha, now, config.hostTimeoutDefaults),
  );
  const registry = freeze(registeredDags, currentSha, now);

  logger.info(`Sync complete: ${bulkResult.loaded.length} DAGs loaded`, {
    sha: currentSha,
    loaded: bulkResult.loaded.length,
    errors: bulkResult.errors.length,
  });

  return {
    kind: "updated",
    newSha: currentSha,
    registry,
    errors: bulkResult.errors,
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
  onNoChange: OnSyncNoChange,
  onError: OnSyncError,
  initialSha: GitSha | null = null,
  clock: Clock = Date.now,
): SyncLoopHandle => {
  let lastSha: GitSha | null = initialSha;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const doSync = async (): Promise<SyncResult> => {
    if (running) {
      return { kind: "skipped", previousSha: lastSha, reason: "already-in-progress" };
    }

    running = true;
    try {
      onStarted();
      const result = await executeSyncCycle(git, loader, config, lastSha, logger, clock);

      if (result.kind === "updated") {
        // Call onComplete BEFORE advancing SHA — if onComplete throws,
        // SHA stays at lastSha so the next cycle will retry this commit.
        onComplete(result.registry, result.newSha);
        lastSha = result.newSha;
      } else if (result.kind === "no-change") {
        lastSha = result.currentSha;
        // Transition syncing → ready (sync succeeded, nothing changed)
        onNoChange(result.currentSha);
      } else if (result.kind === "error") {
        onError(result.syncError);
      }

      return result;
    } catch (e) {
      // Recover state machine from "syncing" on unexpected throw.
      // Without this, the host remains stuck in syncing phase permanently.
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error("Unexpected error in sync cycle", { error: errMsg });
      const syncError: HostError = {
        kind: "git-pull-failed",
        message: `Unexpected error in sync cycle: ${errMsg}`,
      };
      try {
        onError(syncError);
      } catch (callbackErr) {
        logger.error("onError callback threw", {
          error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
        });
      }
      return {
        kind: "error",
        previousSha: lastSha,
        syncError,
      };
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
 * Clones the repo and installs its dependencies if not in local mode, then
 * loads all DAGs.
 */
export const initialSync = async (
  git: GitPort,
  loader: ModuleLoaderPort,
  config: SyncConfig,
  logger: SyncLogger,
  clock: Clock = Date.now,
): Promise<Result<{ registry: Registry; sha: GitSha }, HostError>> => {
  // Clone if not local mode
  if (!config.isLocalMode) {
    const cloneResult = await git.clone(config.repoUrl, config.repoPath, {
      branch: config.branch,
      depth: 1,
    });
    if (!cloneResult.ok) {
      return cloneResult;
    }

    // A fresh clone has no node_modules — install before the first dynamic
    // import, or every dag.ts with a dependency fails to load (import-failed)
    // and the host boots with 0 DAGs. Fail closed instead: a refused start
    // names the real problem. (No-op when the repo has no package.json.)
    logger.info("Installing DAG repo dependencies (initial clone)...");
    const installResult = await git.install(config.repoPath);
    if (!installResult.ok) {
      return installResult;
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
    loadResultToRegisteredDag(lr, sha, now, config.hostTimeoutDefaults),
  );
  const registry = freeze(registeredDags, sha, now);

  logger.info(`Initial sync complete: ${bulkResult.loaded.length} DAGs loaded`, {
    sha,
    loaded: bulkResult.loaded.length,
    errors: bulkResult.errors.length,
  });

  return ok({ registry, sha });
};
