/**
 * Port Interfaces — boundary contracts for all infrastructure adapters.
 *
 * Lives outside domain/ because ports define the shape of external systems,
 * not domain logic. Both domain and adapter layers import from here.
 *
 * Convention: Ports are grouped by subsystem. Each port returns Result<T, HostError>
 * for operations that can fail, making failure explicit at the type level.
 */

import type { Result, DagId, GitSha, LlmClient, Tracer, PromptAccess } from "@fugue/framework";
import type { HostError } from "./domain/host-error.js";
import type { DagRegistration } from "./domain/dag-registration.js";
import type { CircuitState } from "./domain/circuit-breaker.js";
import type { ContentFilter } from "@fugue/framework";
import type { TokenGrant, TokenHash } from "./domain/auth.js";

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

// ── Clock ──────────────────────────────────────────────────────────────────────

/** Injectable time source — enables deterministic testing. */
export type Clock = () => number;

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
    sha: GitSha,
  ) => Promise<Result<LoadResult, HostError>>;

  readonly discoverDagPaths: (dagsRoot: string) => Promise<Result<string[], HostError>>;

  readonly loadAll: (
    dagsRoot: string,
    sha: GitSha,
  ) => Promise<BulkLoadResult>;
}

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * Port interface for git operations — enables testing with fakes.
 * All methods return Result — never throw.
 */
export interface GitPort {
  readonly clone: (
    url: string,
    target: string,
    opts?: { branch?: string; depth?: number },
  ) => Promise<Result<void, HostError>>;

  readonly pull: (repoPath: string) => Promise<Result<void, HostError>>;

  readonly currentSha: (repoPath: string) => Promise<Result<GitSha, HostError>>;

  readonly hasLockfileChanged: (
    repoPath: string,
    fromSha: string,
    toSha: string,
  ) => Promise<Result<boolean, HostError>>;

  readonly install: (repoPath: string) => Promise<Result<void, HostError>>;
}

// ── Redis ────────────────────────────────────────────────────────────────────

/**
 * Redis-like interface for cache/checkpoint operations.
 * Returns Result to make failures explicit — no try/catch required at call sites.
 */
export interface RedisPort {
  readonly get: (key: string) => Promise<Result<string | null, HostError>>;
  readonly set: (key: string, value: string, opts?: { expiresInSec?: number }) => Promise<Result<string | null, HostError>>;
  readonly del: (key: string) => Promise<Result<number, HostError>>;
  /**
   * @deprecated Use `scan()` for production — `keys()` blocks Redis with O(N) scan.
   * Retained for backward compatibility in tests.
   */
  readonly keys: (pattern: string) => Promise<Result<string[], HostError>>;
  /**
   * Cursor-based key scanning — production-safe alternative to `keys()`.
   * Returns a batch of matching keys plus the next cursor. Cursor "0" signals completion.
   * Call iteratively until cursor returns "0" to retrieve all matching keys.
   */
  readonly scan: (pattern: string, cursor?: string) => Promise<Result<{ cursor: string; keys: string[] }, HostError>>;
  /**
   * Set key only if it does not already exist (atomic check-and-set).
   * Returns `true` if the key was set, `false` if it already existed.
   */
  readonly setNx: (key: string, value: string) => Promise<Result<boolean, HostError>>;
}

/**
 * Port for Redis connectivity validation (PING command).
 */
export interface RedisConnectivityPort {
  readonly ping: () => Promise<Result<void, HostError>>;
}

// ── Shared Infrastructure ────────────────────────────────────────────────────

/**
 * Shared infrastructure singletons — initialized once at host startup.
 * Passed by reference into every NodeContext (no per-request allocation).
 */
export interface SharedInfra {
  readonly llm: LlmClient;
  readonly redis: RedisPort;
  readonly tracer: Tracer;
  readonly contentFilter: ContentFilter | null;
  readonly prompts: PromptAccess | null;
  readonly logger: LogPort;
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

/**
 * Minimal read/write handle for circuit breaker state.
 * Injected from the imperative shell's mutable Map.
 */
export interface CircuitPort {
  readonly get: (dagId: DagId) => CircuitState;
  readonly set: (dagId: DagId, s: CircuitState) => void;
}

/**
 * Configuration for circuit breaker thresholds.
 * Threaded from HostConfig.CIRCUIT_BREAKER_THRESHOLD / CIRCUIT_BREAKER_WINDOW_MS.
 */
export interface CircuitConfig {
  readonly threshold: number;
  readonly windowMs: number;
}

// ── Token Store ─────────────────────────────────────────────────────────────

/**
 * Port for team token persistence.
 * Stores token hashes mapped to team grants.
 * Used by auth middleware (resolve) and admin handlers (store/list/revoke).
 */
export interface TokenStorePort {
  /** Look up a token grant by its hash. Returns Ok(null) if not found, Err on infrastructure failure. */
  readonly resolve: (hash: TokenHash) => Promise<Result<TokenGrant | null, HostError>>;
  /** Store a new team token. Returns err if team already has a token. */
  readonly store: (team: string, hash: TokenHash, grant: TokenGrant) => Promise<Result<void, HostError>>;
  /** List all provisioned teams with their grants (excludes hashes). */
  readonly listTeams: () => Promise<Result<readonly TokenGrant[], HostError>>;
  /** Revoke a team's token. Idempotent — revoking non-existent team is ok. */
  readonly revoke: (team: string) => Promise<Result<void, HostError>>;
}
