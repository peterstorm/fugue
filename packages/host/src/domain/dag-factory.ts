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
 */
export const loadResultToRegisteredDag = (
  result: LoadResult,
  sha: GitSha,
  now: number,
): RegisteredDag => {
  const resolved = resolveDefaults(result.registration);
  const { team } = extractTeam(result.modulePath);

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
    meta: {
      description: resolved.meta.description,
      version: resolved.meta.version,
    },
    loadedAt: now,
    sha,
    status: { kind: "healthy" },
  };
};
