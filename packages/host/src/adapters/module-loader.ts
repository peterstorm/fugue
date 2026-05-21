/**
 * Module Loader — Dynamic import of DAG modules with validation.
 *
 * Discovers DAG modules by glob pattern, imports them with cache-busting,
 * and validates each default export against DagRegistrationSchema.
 * All failures are captured as Result.err — loader never throws.
 *
 * @satisfies FR-004 — Validate each module against DagRegistration schema; invalid DAGs MUST NOT be registered
 * @satisfies NFR-010 — A failing DAG import MUST NOT affect other already-registered DAGs
 */

import { ok, err } from "@fugue/framework";
import type { Result, DagId } from "@fugue/framework";
import { dagId } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { DagRegistration } from "../domain/dag-registration.js";
import { validateDagRegistration } from "../domain/dag-registration.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LoadResult {
  readonly id: DagId;
  readonly registration: DagRegistration;
  readonly modulePath: string;
}

export interface LoadError {
  readonly path: string;
  readonly error: HostError;
}

export interface BulkLoadResult {
  readonly loaded: readonly LoadResult[];
  readonly errors: readonly LoadError[];
}

// ── Module Loader Port ─────────────────────────────────────────────────────

/**
 * Port interface for module loading — enables testing with fake loaders.
 */
export interface ModuleLoaderPort {
  readonly loadDagModule: (
    modulePath: string,
    sha: string,
  ) => Promise<Result<LoadResult, HostError>>;

  readonly discoverDagPaths: (dagsRoot: string) => Promise<Result<string[], HostError>>;

  readonly loadAll: (
    dagsRoot: string,
    sha: string,
  ) => Promise<BulkLoadResult>;
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Load a single DAG module from the filesystem.
 *
 * - Uses `import(path + "?v=" + sha)` for cache-busting between versions
 * - Validates default export against DagRegistrationSchema
 * - Catches thrown errors during import (syntax, missing deps)
 * - Never throws — all failures returned as Result.err
 *
 * @satisfies FR-004, NFR-010
 */
export const loadDagModule = async (
  modulePath: string,
  sha: string,
): Promise<Result<LoadResult, HostError>> => {
  let mod: unknown;

  try {
    // Bun treats ?v=X as distinct module specifier → fresh evaluation per SHA
    mod = await import(`${modulePath}?v=${sha}`);
  } catch (e) {
    return err({
      kind: "import-failed",
      path: modulePath,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
  }

  const defaultExport = (mod as Record<string, unknown>)?.default;
  if (defaultExport === undefined || defaultExport === null) {
    return err({
      kind: "no-default-export",
      path: modulePath,
    });
  }

  const validation = validateDagRegistration(defaultExport);
  if (!validation.ok) {
    return validation;
  }

  const registration = validation.value;
  const id = dagId(registration.dag.id);

  return ok({
    id,
    registration,
    modulePath,
  });
};

/**
 * Discover all DAG module paths in the given root directory.
 * Convention: dags/{team}/{dag-name}/dag.ts
 *
 * Returns absolute paths to each discovered dag.ts file.
 * Wraps all I/O in Result — never throws.
 */
export const discoverDagPaths = async (dagsRoot: string): Promise<Result<string[], HostError>> => {
  try {
    const glob = new Bun.Glob("dags/*/*/dag.ts");
    const paths: string[] = [];

    for await (const file of glob.scan({ cwd: dagsRoot, absolute: true })) {
      paths.push(file);
    }

    // Primary + fallback globs may overlap — deduplicate to prevent double-registration
    const altGlob = new Bun.Glob("*/*/dag.ts");
    for await (const file of altGlob.scan({ cwd: dagsRoot, absolute: true })) {
      if (!paths.includes(file)) {
        paths.push(file);
      }
    }

    return ok(paths.sort());
  } catch (e) {
    return err({
      kind: "discovery-failed",
      dagsRoot,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * Load all discovered DAG modules from a root directory.
 * Errors in individual DAGs do NOT affect others (NFR-010).
 * Discovery failures are surfaced as errors, never thrown.
 */
export const loadAll = async (
  dagsRoot: string,
  sha: string,
): Promise<BulkLoadResult> => {
  const pathsResult = await discoverDagPaths(dagsRoot);
  if (!pathsResult.ok) {
    return { loaded: [], errors: [{ path: dagsRoot, error: pathsResult.error }] };
  }

  const paths = pathsResult.value;
  const loaded: LoadResult[] = [];
  const errors: LoadError[] = [];

  for (const path of paths) {
    const result = await loadDagModule(path, sha);
    if (result.ok) {
      loaded.push(result.value);
    } else {
      errors.push({ path, error: result.error });
    }
  }

  return { loaded, errors };
};

/**
 * Create a ModuleLoaderPort using the real filesystem implementations.
 */
export const createModuleLoader = (): ModuleLoaderPort => ({
  loadDagModule,
  discoverDagPaths,
  loadAll,
});
