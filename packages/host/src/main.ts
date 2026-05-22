/**
 * @fugue/host — Binary entry point.
 *
 * Parses host config from environment, creates the host, boots it.
 * Catches config errors, logs them, and exits.
 *
 * This file has side effects (Redis connect, git clone, HTTP server start,
 * process.exit). It is NOT re-exported from the library surface.
 *
 * @satisfies NFR-020 — Host MUST log startup/shutdown lifecycle events
 */

import { parseHostConfig } from "./domain/config.js";
import { formatHostError } from "./domain/host-error.js";
import type { HostError } from "./domain/host-error.js";
import { createHost } from "./host.js";
import { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
import { createModuleLoader } from "./adapters/module-loader.js";
import type { RedisConnectivityPort } from "./lifecycle/startup.js";
import type { SharedInfra, RedisPort } from "./adapters/node-context-factory.js";
import type { SyncLogger } from "./sync/sync-loop.js";
import { ok, err, noopTracer } from "@fugue/framework";
import type { Result, LlmClient, Tracer } from "@fugue/framework";

// ── Logger ─────────────────────────────────────────────────────────────────

const safeStringify = (obj: unknown): string => {
  try { return JSON.stringify(obj); }
  catch { return `[unserializable: ${typeof obj}]`; }
};

const createLogger = (): SyncLogger => ({
  info: (msg, data) => console.log(safeStringify({ level: "info", msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data) => console.warn(safeStringify({ level: "warn", msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data) => console.error(safeStringify({ level: "error", msg, ...data, ts: new Date().toISOString() })),
});

// ── Redis Connectivity ─────────────────────────────────────────────────────

const createRedisConnectivity = async (redisUrl: string): Promise<Result<{ port: RedisConnectivityPort; redis: RedisPort; disconnect: () => Promise<unknown> }, HostError>> => {
  try {
    // Dynamic import avoids loading ioredis at module-level for tests
    const { default: Redis } = await import("ioredis");
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
      set: (key, value, opts) => {
        if (opts?.expiresInSec !== undefined) {
          return client.set(key, value, "EX", opts.expiresInSec);
        }
        return client.set(key, value);
      },
    };

    return ok({ port, redis, disconnect: () => client.quit() });
  } catch (e) {
    return err({
      kind: "redis-unavailable",
      operation: `Redis client initialization: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
};

// ── LLM Client ─────────────────────────────────────────────────────────────

/**
 * Fail-on-use LLM client — surfaces missing configuration on first .chat() call.
 *
 * SAFETY: This is intentional — DAGs that don't use LLM never hit this path.
 * DAGs that do use LLM get an immediate actionable error rather than a silent null.
 * The thrown error carries `frameworkErrorKind` which is caught by error-handler middleware.
 */
const createLlmClient = (config: { LLM_PROVIDER: string; ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string }): LlmClient => {
  const keyVar = config.LLM_PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const message = `LLM client not configured. Set ${keyVar} environment variable to enable LLM calls (provider: ${config.LLM_PROVIDER}).`;
  const stub = {
    chat: async () => {
      throw Object.assign(new Error(message), { frameworkErrorKind: "llm-unavailable" as const });
    },
  };
  return stub as unknown as LlmClient;
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
  const redisResult = await createRedisConnectivity(config.REDIS_URL);
  if (!redisResult.ok) {
    logger.error(`Redis connectivity failed: ${formatHostError(redisResult.error)}`);
    process.exit(1);
  }
  const { port: redisPort, redis, disconnect: disconnectRedis } = redisResult.value;

  try {
    // Step 3: Create shared infrastructure
    const sharedInfra: SharedInfra = {
      llm: createLlmClient(config),
      redis,
      tracer: noopTracer,
      contentFilter: null,
      logger,
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
      onShutdown: async () => { await disconnectRedis(); },
    });

    if (!hostResult.ok) {
      logger.error(`Host failed to start: ${formatHostError(hostResult.error)}`);
      await disconnectRedis();
      process.exit(1);
    }

    logger.info("Fugue host is running");
  } catch (e) {
    await disconnectRedis().catch(() => {});
    throw e;
  }
};

// Execute main — catch any unhandled error
main().catch((e) => {
  console.error("Fatal error during host startup:", e);
  process.exit(1);
});
