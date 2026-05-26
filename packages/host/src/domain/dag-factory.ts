/**
 * DAG Factory — Pure builders converting loader output to registry types.
 *
 * These functions bridge between ModuleLoader's LoadResult and the
 * Registry's RegisteredDag type. Pure — no I/O, no side effects.
 */

import type { RegisteredDag } from "./registry.js";
import type { LoadResult } from "../ports.js";
import type { DagSnapshot } from "./dag-diff.js";
import type { GitSha } from "@fugue/framework";
import { resolveDefaults } from "./dag-registration.js";

// ── Host-level timeout defaults (threaded from HostConfig) ─────────────────

/**
 * Host-level defaults for DAG timeout and concurrency.
 * Threaded from HostConfig so that per-DAG overrides are clamped
 * against the host maximum.
 */
export interface HostTimeoutDefaults {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly defaultMaxConcurrent: number;
}

/**
 * Fallback defaults used when no HostConfig is available (e.g., tests).
 */
export const DEFAULT_HOST_TIMEOUT_DEFAULTS: HostTimeoutDefaults = {
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 120_000,
  defaultMaxConcurrent: 10,
};

/**
 * Convert LoadResults to DagSnapshots for diff comparison.
 */
export const loadResultsToSnapshots = (results: readonly LoadResult[], sha: GitSha): DagSnapshot[] =>
  results.map((r) => ({
    id: r.id,
    path: r.modulePath,
    sha,
  }));

/**
 * Extract team name from module path following dags/{team}/{dag-name}/dag.ts convention.
 * Returns "unknown" when path doesn't follow convention (caller should log a warning).
 */
export const extractTeam = (modulePath: string): { team: string; inferred: boolean } => {
  const pathParts = modulePath.split("/");
  const dagsDirIndex = pathParts.lastIndexOf("dags");
  if (dagsDirIndex >= 0 && dagsDirIndex + 1 < pathParts.length) {
    return { team: pathParts[dagsDirIndex + 1], inferred: true };
  }
  return { team: "unknown", inferred: false };
};

/**
 * Convert a LoadResult to a RegisteredDag for the registry.
 *
 * Resolves defaults, extracts team from path convention, and marks as healthy.
 * Host-level timeout defaults are applied:
 * - Per-DAG config.timeoutMs falls back to hostDefaults.defaultTimeoutMs
 * - Final timeout is clamped to hostDefaults.maxTimeoutMs
 * - Per-DAG config.maxConcurrent falls back to hostDefaults.defaultMaxConcurrent
 */
export const loadResultToRegisteredDag = (
  result: LoadResult,
  sha: GitSha,
  now: number,
  hostDefaults: HostTimeoutDefaults = DEFAULT_HOST_TIMEOUT_DEFAULTS,
): RegisteredDag => {
  const resolved = resolveDefaults(result.registration);
  const { team } = extractTeam(result.modulePath);

  // Apply host-level defaults and clamp
  const effectiveTimeout = Math.min(
    result.registration.config?.timeoutMs ?? hostDefaults.defaultTimeoutMs,
    hostDefaults.maxTimeoutMs,
  );
  const effectiveConcurrency = result.registration.config?.maxConcurrent ?? hostDefaults.defaultMaxConcurrent;

  return {
    id: result.id,
    team,
    route: resolved.route,
    dag: resolved.dag,
    inputSchema: resolved.inputSchema,
    config: {
      timeout: effectiveTimeout,
      maxConcurrency: effectiveConcurrency,
      // NOTE: cacheTtlMs and checkpointTtlMs are declared on ResolvedDagConfig
      // but never populated here. Per-DAG TTL overrides (from fugue.yaml) require loading
      // and merging the fugue.yaml alongside dag.ts during module discovery — not yet wired.
      // Until then, createNamespacedCache/createNamespacedCheckpointWriter fall back to
      // the host-level default TTL from HostConfig.
    },
    meta: {
      description: resolved.meta.description,
      version: resolved.meta.version,
    },
    loadedAt: now,
    sha,
    status: { kind: "healthy" },
    modulePath: result.modulePath,
    prompts: result.prompts,
  };
};
