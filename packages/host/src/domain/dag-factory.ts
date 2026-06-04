/**
 * DAG Factory — Pure builders converting loader output to registry types.
 *
 * These functions bridge between ModuleLoader's LoadResult and the
 * Registry's RegisteredDag type. Pure — no I/O, no side effects.
 */

import type { RegisteredDag } from "./registry.js";
import type { LoadResult } from "../ports.js";
import type { DagSnapshot } from "./dag-diff.js";
import type { GitSha } from "@fuguejs/framework";
import { resolveDefaults } from "./dag-registration.js";

// ── Host-level timeout defaults (threaded from HostConfig) ─────────────────

/**
 * Host-level defaults for DAG timeout, concurrency, and TTLs.
 * Threaded from HostConfig so that per-DAG overrides are clamped
 * against the host maximum and unset TTLs fall back to host defaults.
 */
export interface HostTimeoutDefaults {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly defaultMaxConcurrent: number;
  /** Host default cache TTL (ms), applied when a DAG omits its own override. (FR-040) */
  readonly defaultCacheTtlMs: number;
  /** Host default checkpoint TTL (ms), applied when a DAG omits its own override. (FR-040) */
  readonly defaultCheckpointTtlMs: number;
}

/**
 * Fallback defaults used when no HostConfig is available (e.g., tests).
 * Mirror the defaults in HostConfigSchema.
 */
export const DEFAULT_HOST_TIMEOUT_DEFAULTS: HostTimeoutDefaults = {
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 120_000,
  defaultMaxConcurrent: 10,
  defaultCacheTtlMs: 300_000,
  defaultCheckpointTtlMs: 86_400_000,
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
 * Extract team name from a module path following the dags/{team}/{name}/dag.ts
 * convention. Returns "unknown" when the path does not follow it — the caller
 * (sync-callbacks) warns on "unknown", and team drives authorization isolation,
 * so a wrong-but-plausible team must NOT slip through.
 *
 * Uses the FIRST exact "dags" segment (the repo's dags root) rather than the last,
 * and requires the full {team}/{name}/{file} tail to be present, so a stray leaf
 * segment literally named "dags" cannot misattribute a team.
 */
export const extractTeam = (modulePath: string): string => {
  const parts = modulePath.split("/");
  const dagsIdx = parts.indexOf("dags");
  // Need dags/{team}/{name}/{file} — at least three segments after "dags".
  if (dagsIdx >= 0 && dagsIdx + 3 < parts.length) {
    const team = parts[dagsIdx + 1];
    if (team.length > 0) return team;
  }
  return "unknown";
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
  // A fugue.yaml `team` (threaded onto the LoadResult) overrides the path-derived team.
  const team = result.team && result.team.length > 0 ? result.team : extractTeam(result.modulePath);
  const regConfig = result.registration.config;

  // Apply host-level defaults and clamp
  const effectiveTimeout = Math.min(
    regConfig?.timeoutMs ?? hostDefaults.defaultTimeoutMs,
    hostDefaults.maxTimeoutMs,
  );
  const effectiveConcurrency = regConfig?.maxConcurrent ?? hostDefaults.defaultMaxConcurrent;

  // Per-DAG TTL overrides fall back to host defaults so cache/checkpoint entries
  // always carry an expiry (FR-040/FR-041). Previously these were left undefined,
  // meaning entries were written with NO expiry — a latent FR-040 violation.
  const cacheTtlMs = regConfig?.cacheTtlMs ?? hostDefaults.defaultCacheTtlMs;
  const checkpointTtlMs = regConfig?.checkpointTtlMs ?? hostDefaults.defaultCheckpointTtlMs;

  return {
    id: result.id,
    team,
    route: resolved.route,
    dag: resolved.dag,
    inputSchema: resolved.inputSchema,
    config: {
      timeout: effectiveTimeout,
      maxConcurrency: effectiveConcurrency,
      cacheTtlMs,
      checkpointTtlMs,
      // Per-DAG circuit-breaker override is only set when the DAG declares one;
      // run-dag merges it over the host-level CIRCUIT_BREAKER_* config (a partial
      // override — any field the DAG omits falls back to the host default).
      ...(regConfig?.circuitBreaker !== undefined
        ? { circuitBreaker: regConfig.circuitBreaker }
        : {}),
    },
    meta: {
      description: resolved.meta.description,
      version: resolved.meta.version,
      ...(result.owner !== undefined ? { owner: result.owner } : {}),
    },
    loadedAt: now,
    sha,
    status: { kind: "healthy" },
    modulePath: result.modulePath,
    prompts: result.prompts,
  };
};
