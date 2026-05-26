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
import type { HostConfig } from "./domain/config.js";
import { formatHostError } from "./domain/host-error.js";
import type { HostError } from "./domain/host-error.js";
import { createHost } from "./host.js";
import { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
import { createModuleLoader } from "./adapters/module-loader.js";
import type { RedisConnectivityPort, SharedInfra, RedisPort } from "./ports.js";
import type { SyncLogger } from "./sync/sync-loop.js";
import { ok, err, noopTracer, AnthropicLlmClient, OpenAILlmClient } from "@fugue/framework";
import type { Result, LlmClient } from "@fugue/framework";

// ── Logger ─────────────────────────────────────────────────────────────────

const safeStringify = (obj: unknown): string => {
  try { return JSON.stringify(obj); }
  catch (_e) { return `[unserializable: ${typeof obj}]`; }
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
    const { Redis } = await import("ioredis");
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
      get: async (key) => {
        try {
          const val = await client.get(key);
          return ok(val);
        } catch (e) {
          return err({ kind: "redis-unavailable" as const, operation: `GET ${key}: ${e instanceof Error ? e.message : String(e)}` });
        }
      },
      set: async (key, value, opts) => {
        try {
          const result = opts?.expiresInSec !== undefined
            ? await client.set(key, value, "EX", opts.expiresInSec)
            : await client.set(key, value);
          return ok(result);
        } catch (e) {
          return err({ kind: "redis-unavailable" as const, operation: `SET ${key}: ${e instanceof Error ? e.message : String(e)}` });
        }
      },
      del: async (key) => {
        try {
          const count = await client.del(key);
          return ok(count);
        } catch (e) {
          return err({ kind: "redis-unavailable" as const, operation: `DEL ${key}: ${e instanceof Error ? e.message : String(e)}` });
        }
      },
      keys: async (pattern) => {
        try {
          const keys = await client.keys(pattern);
          return ok(keys);
        } catch (e) {
          return err({ kind: "redis-unavailable" as const, operation: `KEYS ${pattern}: ${e instanceof Error ? e.message : String(e)}` });
        }
      },
      scan: async (pattern, cursor = "0") => {
        try {
          const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
          return ok({ cursor: nextCursor, keys });
        } catch (e) {
          return err({ kind: "redis-unavailable" as const, operation: `SCAN ${pattern}: ${e instanceof Error ? e.message : String(e)}` });
        }
      },
      setNx: async (key, value) => {
        try {
          const result = await client.setnx(key, value);
          return ok(result === 1);
        } catch (e) {
          return err({ kind: "redis-unavailable" as const, operation: `SETNX ${key}: ${e instanceof Error ? e.message : String(e)}` });
        }
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
 * Create the LLM client from config.
 *
 * - Anthropic: wraps `@anthropic-ai/sdk` via AnthropicLlmClient (framework export).
 *   Dynamic import mirrors the ioredis pattern — avoids loading the SDK at module
 *   evaluation time (useful for tests that never call LLM).
 * - OpenAI: OpenAILlmClient uses fetch directly — no vendor SDK import needed.
 * - Azure: OpenAILlmClient with Azure endpoint + api-version auth.
 *
 * Config validation (superRefine in config.ts) guarantees the required keys are
 * present for the selected provider before this function is called.
 */
const createLlmClient = async (config: HostConfig): Promise<LlmClient> => {
  if (config.LLM_PROVIDER === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new AnthropicLlmClient(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }));
  }

  if (config.LLM_PROVIDER === "azure") {
    // Config validation (superRefine) guarantees these fields are set when provider is 'azure'.
    // We read them with fallback to empty string to satisfy the linter — Zod already validated.
    const endpoint = (config.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/$/, "");
    const deployment = config.AZURE_OPENAI_DEPLOYMENT ?? "";
    const apiKey = config.AZURE_OPENAI_API_KEY ?? "";
    // Construct the full deployment URL Azure OpenAI expects:
    // https://<resource>.openai.azure.com/openai/deployments/<deployment>
    const baseUrl = `${endpoint}/openai/deployments/${deployment}`;
    return new OpenAILlmClient({ apiKey, baseUrl, apiVersion: config.AZURE_OPENAI_API_VERSION, modelOverride: deployment });
  }

  // LLM_PROVIDER === "openai"
  return new OpenAILlmClient({
    apiKey: config.OPENAI_API_KEY!,
    baseUrl: "https://api.openai.com/v1",
  });
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
      llm: await createLlmClient(config),
      redis,
      tracer: noopTracer,
      contentFilter: null,
      prompts: null,
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
    await disconnectRedis().catch((disconnectErr: unknown) => {
      console.error(JSON.stringify({
        level: "error",
        msg: "Failed to disconnect Redis during error cleanup",
        error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        ts: new Date().toISOString(),
      }));
    });
    throw e;
  }
};

// Execute main — catch any unhandled error
main().catch((e) => {
  console.error("Fatal error during host startup:", e);
  process.exit(1);
});
