/**
 * @fuguejs/host — Binary entry point.
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
import { createHost } from "./host.js";
import { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
import { createModuleLoader } from "./adapters/module-loader.js";
import { createRedisConnectivity } from "./adapters/redis-connectivity.js";
import { buildCdratorCapability } from "./adapters/cdrator-capability.js";
import { buildOracleCapability, connectStringHost } from "./adapters/oracle-capability.js";
import type { SharedInfra } from "./ports.js";
import type { SyncLogger } from "./sync/sync-loop.js";
import { noopTracer, AnthropicLlmClient, OpenAILlmClient, createHttpCapability, systemClock } from "@fuguejs/framework";
import type { LlmClient, CapabilityHandle } from "@fuguejs/framework";

// ── Logger ─────────────────────────────────────────────────────────────────

const safeStringify = (obj: unknown): string => {
  try { return JSON.stringify(obj); }
  catch (_e) { return `[unserializable: ${typeof obj}]`; }
};

const createLogger = (): SyncLogger => ({
  info: (msg, data) => console.info(safeStringify({ level: "info", msg, ...data, ts: new Date().toISOString() })),
  warn: (msg, data) => console.warn(safeStringify({ level: "warn", msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data) => console.error(safeStringify({ level: "error", msg, ...data, ts: new Date().toISOString() })),
});

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
    // ADR-0051: the built-in `http` capability ships with the framework so
    // every workflow can declare `requires: ["http"]`. It reaches each node's
    // NodeContext via this `capabilities` array (the handle's name↔client
    // correlation is restored in `extractClients`). Without this wiring
    // `ctx.http` would be null and a `requires: ["http"]` DAG would fail the
    // boot-time capability check.
    // C2: the built-in `clock` capability also ships with the framework, so any
    // node can declare `requires: ["clock"]` and read `ctx.clock.now()` instead
    // of calling `new Date()` directly. `systemClock` is the production adapter;
    // tests inject `fixedClock`. Like `http`, it reaches the NodeContext via this
    // array; without it `ctx.clock` is null and a `requires: ["clock"]` DAG (e.g.
    // golden example 09) fails the boot-time capability check.
    const capabilities: CapabilityHandle[] = [
      createHttpCapability(),
      { name: "clock", client: systemClock },
    ];

    // ADR-0052: optional `documents` capability, selected by environment.
    // Dynamic import mirrors the ioredis/Anthropic pattern — the adapter
    // package loads only when configured. createHost calls connect() on the
    // handle at boot (validates the mount) and close() at shutdown.
    if (config.DOCUMENTS_ADAPTER === "fs") {
      const { createFsAdapter } = await import("@fuguejs/fs");
      // Config validation (superRefine) guarantees DOCUMENTS_FS_ROOT is set.
      capabilities.push(createFsAdapter({ rootDir: config.DOCUMENTS_FS_ROOT! }));
      logger.info(`documents capability: @fuguejs/fs rooted at ${config.DOCUMENTS_FS_ROOT}`);
    }

    // Optional `authedHttp` capability (FR-060): the generic @fuguejs/http-auth
    // adapter configured for the CDRator/Oister REST API from CDRATOR_* env.
    // Returns undefined when CDRATOR_URL is unset, so a `requires: ["authedHttp"]`
    // DAG fails the boot-time capability check exactly as before — same gating as
    // the documents adapter. Credentials come only from config; none are logged.
    const cdrator = buildCdratorCapability(config);
    if (cdrator !== undefined) {
      capabilities.push(cdrator);
      logger.info(`authedHttp capability: @fuguejs/http-auth targeting ${config.CDRATOR_URL}`);
    }

    // Optional `oracle` capability (FR-031/FR-033): the @fuguejs/oracle adapter
    // (a read-only oracledb pool) wired from ORACLE_* env. Returns undefined when
    // ORACLE_CONNECT_STRING is unset, so a `requires: ["oracle"]` DAG fails the
    // boot-time capability check exactly as before — same gating as the documents
    // adapter (zero regression). Credentials come only from config; we log ONLY
    // the non-secret host:port/service of the connect string, never user/password
    // (FR-041/SC-008).
    const oracle = buildOracleCapability(config, logger);
    if (oracle !== undefined) {
      capabilities.push(oracle);
      logger.info(`oracle capability: @fuguejs/oracle targeting ${connectStringHost(config.ORACLE_CONNECT_STRING!)}`);
    }

    // Step 3: Create shared infrastructure
    const sharedInfra: SharedInfra = {
      llm: await createLlmClient(config),
      redis,
      tracer: noopTracer,
      contentFilter: null,
      prompts: null,
      logger,
      capabilities,
    };

    // Step 4: Create git adapter (local or remote)
    const isLocalMode = config.DAGS_LOCAL_PATH !== undefined && config.DAGS_LOCAL_PATH !== "";
    const git = isLocalMode ? createLocalGitAdapter() : createBunGitAdapter();

    // Step 5: Create module loader (pass logger so prompt errors route through structured logging)
    const loader = createModuleLoader(logger);

    // Step 6: Wire the HITL queue backend (ADR-0060) when Teams is configured.
    // BullMQ needs its own Redis connection (separate from the app RedisPort);
    // the framework's backend owns it. Dynamic import mirrors the ioredis/SDK
    // pattern — bullmq loads only when HITL is enabled.
    let queueBackend: import("@fuguejs/framework").QueueBackend | undefined;
    const hitlConfigured = config.TEAMS_WEBHOOK_URL !== undefined || config.BOT_APP_ID !== undefined;
    if (hitlConfigured) {
      const { createBullMQBackend } = await import("@fuguejs/framework/bullmq");
      queueBackend = createBullMQBackend(config.REDIS_URL);
      logger.info("HITL queue backend (BullMQ) constructed");
    }

    // Step 7: Create and boot host
    const hostResult = await createHost({
      config,
      git,
      loader,
      redis: redisPort,
      sharedInfra,
      logger,
      queueBackend,
      onShutdown: async () => {
        if (queueBackend) {
          await queueBackend.close().catch((e: unknown) => {
            logger.error("Failed to close HITL queue backend", { error: e instanceof Error ? e.message : String(e) });
          });
        }
        await disconnectRedis();
      },
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
