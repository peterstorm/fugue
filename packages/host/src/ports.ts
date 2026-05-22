/**
 * Shared port interfaces used across host subsystems.
 * Lives outside domain/ because ports are boundary contracts, not domain logic.
 */

import type { Result, DagId } from "@fugue/framework";
import type { HostError } from "./domain/host-error.js";
import type { DagRegistration } from "./domain/dag-registration.js";

// ── Logger ──────────────────────────────────────────────────────────────────

/**
 * Unified logger port for all host subsystems.
 * Avoids coupling to a specific logging library.
 */
export interface LogPort {
  readonly info: (msg: string, data?: Record<string, unknown>) => void;
  readonly warn: (msg: string, data?: Record<string, unknown>) => void;
  readonly error: (msg: string, data?: Record<string, unknown>) => void;
}

// ── Module Loader ────────────────────────────────────────────────────────────

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
