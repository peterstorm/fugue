/**
 * @fugue/host — Entry point.
 *
 * Parses host config from environment, creates the host, boots it.
 * Catches config errors, logs them, and exits.
 *
 * @satisfies NFR-031 — Host MUST log startup/shutdown lifecycle events
 */

import { parseHostConfig } from "./domain/config.js";
import { formatHostError } from "./domain/host-error.js";
import { createHost } from "./host.js";
import { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
import { createModuleLoader } from "./adapters/module-loader.js";
import type { RedisConnectivityPort } from "./lifecycle/startup.js";
import type { SharedInfra, RedisPort } from "./adapters/node-context-factory.js";
import type { SyncLogger } from "./sync/sync-loop.js";
import { ok, err, noopTracer } from "@fugue/framework";
import type { LlmClient, Tracer } from "@fugue/framework";

// ── Logger ─────────────────────────────────────────────────────────────────

const createLogger = (): SyncLogger => ({
  info: (msg, data) => console.log(JSON.stringify({ level: "info", msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: "warn", msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data) => console.error(JSON.stringify({ level: "error", msg, ...data, ts: new Date().toISOString() })),
});

// ── Redis Connectivity ─────────────────────────────────────────────────────

const createRedisConnectivity = (redisUrl: string): { port: RedisConnectivityPort; redis: RedisPort; disconnect: () => Promise<unknown> } => {
  // Lazy import to avoid loading ioredis at module-level for tests
  const Redis = require("ioredis");
  const client = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });

  const port: RedisConnectivityPort = {
    ping: async () => {
      try {
        await client.connect();
        await client.ping();
        return ok(undefined);
      } catch (e) {
        return err({
          kind: "redis-unavailable" as const,
          operation: `PING at startup (${e instanceof Error ? e.message : String(e)})`,
        });
      }
    },
  };

  const redis: RedisPort = {
    get: (key) => client.get(key),
    set: (key, value, ...args) => client.set(key, value, ...args),
  };

  return { port, redis, disconnect: () => client.quit() };
};

// ── LLM Client Stub ────────────────────────────────────────────────────────

const createLlmClient = (config: { LLM_PROVIDER: string; ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string }): LlmClient => {
  // This is a placeholder — actual LLM wiring depends on framework's LlmClient interface
  return {
    chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }),
  } as unknown as LlmClient;
};

// ── Main ───────────────────────────────────────────────────────────────────

const main = async () => {
  const logger = createLogger();

  // Step 1: Parse config from environment
  logger.info("Parsing host configuration from environment...");
  const configResult = parseHostConfig(process.env as Record<string, string | undefined>);
  if (!configResult.ok) {
    logger.error(`Configuration error: ${formatHostError(configResult.error)}`);
    logger.error("Host cannot start due to invalid configuration. Set required environment variables and retry.");
    process.exit(1);
  }

  const config = configResult.value;

  // Step 2: Create Redis connectivity
  const { port: redisPort, redis, disconnect: disconnectRedis } = createRedisConnectivity(config.REDIS_URL);

  // Step 3: Create shared infrastructure
  const sharedInfra: SharedInfra = {
    llm: createLlmClient(config),
    redis,
    tracer: noopTracer,
    contentFilter: null,
  };

  // Step 4: Create git adapter (local or remote)
  const isLocalMode = config.DAGS_LOCAL_PATH !== undefined && config.DAGS_LOCAL_PATH !== "";
  const git = isLocalMode ? createLocalGitAdapter() : createBunGitAdapter();

  // Step 5: Create module loader
  const loader = createModuleLoader();

  // Step 6: Create and boot host
  const hostResult = await createHost({
    config,
    git,
    loader,
    redis: redisPort,
    sharedInfra,
    logger,
  });

  if (!hostResult.ok) {
    logger.error(`Host failed to start: ${formatHostError(hostResult.error)}`);
    await disconnectRedis();
    process.exit(1);
  }

  logger.info("Fugue host is running");
};

// Execute main — catch any unhandled error
main().catch((e) => {
  console.error("Fatal error during host startup:", e);
  process.exit(1);
});

export type { DagRegistration, DagRegistrationConfig, DagRegistrationMeta, ResolvedDagRegistration } from "./domain/dag-registration.js";
export { DagRegistrationSchema, validateDagRegistration, resolveDefaults, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT } from "./domain/dag-registration.js";

// ── Re-exports for library usage ───────────────────────────────────────────
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

export type { Registry, RegisteredDag, DagConfig } from "./domain/registry.js";
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

export { createHost } from "./host.js";
export type { HostDeps, HostInstance } from "./host.js";
export { executeStartup, validateRedis, buildSyncConfig } from "./lifecycle/startup.js";
export type { StartupDeps, BootResult, RedisConnectivityPort } from "./lifecycle/startup.js";
export { registerSignalHandlers } from "./lifecycle/signals.js";
export type { SignalHandlerDeps, SignalHandlerHandle } from "./lifecycle/signals.js";
