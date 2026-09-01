/**
 * @fuguejs/host — Library surface.
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

export type { Registry, RegisteredDag, ResolvedDagConfig, DagStatus } from "./domain/registry.js";
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

export type { HostConfig, FugueYaml } from "./domain/config.js";
export { parseHostConfig, parseFugueYaml, HostConfigSchema, FugueYamlSchema, workerSocketPath } from "./domain/config.js";

// ── Multi-tenant: tenant + worker UDS + supervisor header contract ──────────
export type { TenantId, Tenant, SecretsRef, TenantRegistryView } from "./domain/tenant.js";
export { tenantId, markSecretsRef, resolveTenant, TENANT_ID_REGEX } from "./domain/tenant.js";
export type { TenantHeaderVerification } from "./domain/tenant-header.js";
export { TENANT_HEADER_NAME, signTenantHeader, verifyTenantHeader } from "./domain/tenant-header.js";

// ── Host Factory ───────────────────────────────────────────────────────────

export { createHost } from "./host.js";
export type { HostDeps, HostInstance } from "./host.js";

// ── Lifecycle ──────────────────────────────────────────────────────────────

export { executeStartup, validateRedis, buildSyncConfig } from "./lifecycle/startup.js";
export type { StartupDeps, BootResult } from "./lifecycle/startup.js";
export type { RedisConnectivityPort } from "./ports.js";
export { registerSignalHandlers } from "./lifecycle/signals.js";
export type { SignalHandlerDeps, SignalHandlerHandle } from "./lifecycle/signals.js";

// ── Sync ───────────────────────────────────────────────────────────────────

export type { SyncConfig, SyncLogger, SyncLoopHandle } from "./sync/sync-loop.js";

// ── Adapters ───────────────────────────────────────────────────────────────

export { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
export { createModuleLoader } from "./adapters/module-loader.js";
export type {
  GitPort,
  ModuleLoaderPort,
  LoadResult,
  BulkLoadResult,
  LoadError,
  SharedInfra,
  RedisPort,
  LogPort,
  SpendLedgerPort,
} from "./ports.js";
export { createFileSpendLedger } from "./adapters/spend-ledger-file.js";

// Capability builders — the host's own boot-wiring primitives. Exported so an
// out-of-tree consumer (e.g. a live smoke harness) can wire the SAME capabilities
// the host boots with, through the public surface rather than reaching into
// internal file layout. `connectStringHost` is the credential-stripping helper
// used wherever an Oracle connect string is logged.
export { buildCdratorCapability } from "./adapters/cdrator-capability.js";
export { buildOracleCapability, connectStringHost } from "./adapters/oracle-capability.js";
