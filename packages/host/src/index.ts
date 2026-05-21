/**
 * @fugue/host — Library surface.
 *
 * Pure re-exports only. NO side effects, NO process control.
 * Consumers can import types and utilities without triggering boot.
 *
 * For the binary entry point (boots the host), see src/main.ts.
 */

// ── Domain ─────────────────────────────────────────────────────────────────

export type { DagRegistration, DagRegistrationConfig, DagRegistrationMeta, ResolvedDagRegistration } from "./domain/dag-registration.js";
export { DagRegistrationSchema, validateDagRegistration, resolveDefaults, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT } from "./domain/dag-registration.js";

export type { HostState, DegradedReason, TransitionError } from "./domain/host-state.js";
export {
  booting,
  bootComplete,
  syncStarted,
  syncCompleted,
  syncFailed,
  beginDrain,
  drainComplete,
  redisDied,
  redisRecovered,
  getRegistry,
  canServeRequests,
  invalidTransition,
} from "./domain/host-state.js";

export type { Registry, RegisteredDag, DagConfig, DagStatus } from "./domain/registry.js";
export {
  emptyRegistry,
  withDag,
  withoutDag,
  freeze,
  lookupDag,
  healthyCount,
  isEmpty,
} from "./domain/registry.js";

export type { HostError, HostErrorKind } from "./domain/host-error.js";
export { httpStatusFor, formatHostError } from "./domain/host-error.js";

// ── Host Factory ───────────────────────────────────────────────────────────

export { createHost } from "./host.js";
export type { HostDeps, HostInstance } from "./host.js";

// ── Lifecycle ──────────────────────────────────────────────────────────────

export { executeStartup, validateRedis, buildSyncConfig } from "./lifecycle/startup.js";
export type { StartupDeps, BootResult, RedisConnectivityPort } from "./lifecycle/startup.js";
export { registerSignalHandlers } from "./lifecycle/signals.js";
export type { SignalHandlerDeps, SignalHandlerHandle } from "./lifecycle/signals.js";

// ── Adapters ───────────────────────────────────────────────────────────────

export { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
export type { GitPort } from "./adapters/git-sync.js";
export { createModuleLoader } from "./adapters/module-loader.js";
export type { ModuleLoaderPort, LoadResult, BulkLoadResult, LoadError } from "./adapters/module-loader.js";
export type { SharedInfra, RedisPort, LogPort } from "./adapters/node-context-factory.js";
