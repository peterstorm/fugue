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
 * LIMITATION: Git operations have individual timeouts, but the sync cycle has no
 * enclosing deadline and therefore does not yet satisfy NFR-003's poll interval + 5s bound.
 * @satisfies NFR-010 — Failing DAG import MUST NOT affect other registered DAGs
 */

import { match } from "ts-pattern";
import { ok } from "@fuguejs/framework";
import type { Result, GitSha } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { Registry } from "../domain/registry.js";
import { freeze } from "../domain/registry.js";
import type { GitPort, ModuleLoaderPort, Clock, BulkLoadResult } from "../ports.js";
import { loadResultToRegisteredDag } from "../domain/dag-factory.js";
import type { HostTimeoutDefaults } from "../domain/dag-factory.js";

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
 * Handle returned from startSyncLoop to control the loop.
 */
export interface SyncLoopHandle {
  readonly stop: () => void;
  readonly triggerSync: () => Promise<SyncResult>;
}

// ── Core Sync Logic (depends on ports) ─────────────────────────────────────

/**
 * Load every DAG at `sha`, isolate per-DAG load failures, and freeze the result
 * into an immutable registry.
 *
 * ONE definition shared by `initialSync` and `executeSyncCycle`. Both perform the
 * same four steps — loadAll, warn per isolated failure, map to registered DAGs,
 * freeze — and both then log the same counts. Keeping two copies risked the
 * initial boot and the steady-state refresh disagreeing about what a "loaded"
 * registry is, which is precisely the drift that would show up as a DAG present
 * after boot but absent after the first sync (or the reverse).
 *
 * `label` distinguishes the two completion log lines ("Sync complete" vs
 * "Initial sync complete"), which operators grep for separately.
 */
const loadRegistryAt = async (
  sha: GitSha,
  label: string,
  deps: {
    readonly loader: ModuleLoaderPort;
    readonly config: SyncConfig;
    readonly clock: Clock;
    readonly logger: SyncLogger;
  },
): Promise<{
  readonly registry: Registry;
  /** The isolated per-DAG load failures, forwarded verbatim to the sync outcome. */
  readonly errors: BulkLoadResult["errors"];
}> => {
  const { loader, config, clock, logger } = deps;
  const bulkResult = await loader.loadAll(config.repoPath, sha);

  // Per-DAG load failures are ISOLATED: one broken DAG must not take the whole
  // registry down, so each is warned and the rest still load.
  for (const loadError of bulkResult.errors) {
    logger.warn(`DAG load failed (isolated): ${loadError.path}`, { error: loadError.error });
  }

  const now = clock();
  const registeredDags = bulkResult.loaded.map((lr) =>
    loadResultToRegisteredDag(lr, sha, now, config.hostTimeoutDefaults),
  );
  const registry = freeze(registeredDags, sha, now);

  logger.info(`${label}: ${bulkResult.loaded.length} DAGs loaded`, {
    sha,
    loaded: bulkResult.loaded.length,
    errors: bulkResult.errors.length,
  });

  return { registry, errors: bulkResult.errors };
};

/**
 * Execute a single sync cycle. This is the core logic without timer management.
 *
 * Steps:
 * 1. Pull changes in remote mode after the initial sync
 * 2. Get the current SHA
 * 3. Compare with the last SHA — skip if unchanged
 * 4. Check lockfile changes → bun install
 * 5. Discover + load all DAGs
 * 6. Build the new registry
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

  // Steps 5 + 6: discover, load (isolating per-DAG failures) and freeze.
  const { registry, errors } = await loadRegistryAt(currentSha, "Sync complete", {
    loader,
    config,
    clock,
    logger,
  });

  return {
    kind: "updated",
    newSha: currentSha,
    registry,
    errors,
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

      // Exhaustive: a new SyncCycleResult variant is a compile error here
      // rather than a cycle that silently notifies no one.
      match(result)
        .with({ kind: "updated" }, (updated) => {
          // Call onComplete BEFORE advancing SHA — if onComplete throws,
          // SHA stays at lastSha so the next cycle will retry this commit.
          onComplete(updated.registry, updated.newSha);
          lastSha = updated.newSha;
        })
        .with({ kind: "no-change" }, (unchanged) => {
          lastSha = unchanged.currentSha;
          // Transition syncing → ready (sync succeeded, nothing changed)
          onNoChange(unchanged.currentSha);
        })
        .with({ kind: "error" }, (failed) => {
          onError(failed.syncError);
        })
        .with({ kind: "skipped" }, () => {
          // Not reachable here: `skipped` is produced by doSync's re-entrancy
          // guard ABOVE, before executeSyncCycle runs. It shares the SyncResult
          // type but not this path — the in-progress cycle owns the callbacks,
          // so firing any of them again would double-report one sync. The
          // if-chain this replaced omitted the case silently; stating it is the
          // whole point of `.exhaustive()`.
        })
        .exhaustive();

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

  const { registry } = await loadRegistryAt(sha, "Initial sync complete", {
    loader,
    config,
    clock,
    logger,
  });

  return ok({ registry, sha });
};
