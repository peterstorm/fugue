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
import { formatHostError } from "./domain/host-error.js";
import { createHost } from "./host.js";
import { createBunGitAdapter, createLocalGitAdapter } from "./adapters/git-sync.js";
import { createModuleLoader } from "./adapters/module-loader.js";
import { createRedisConnectivity } from "./adapters/redis-connectivity.js";
import { buildCdratorCapability } from "./adapters/cdrator-capability.js";
import { buildDocumentsCapability, describeDocumentsAdapter } from "./adapters/documents-capability.js";
import { buildOracleCapability, connectStringHost } from "./adapters/oracle-capability.js";
import { closeHitlQueueBackend, createHitlQueueBackend } from "./hitl/queue-backend.js";
import type { SharedInfra } from "./ports.js";
import { noopTracer, createHttpCapability, systemClock } from "@fuguejs/framework";
import type { CapabilityHandle } from "@fuguejs/framework";
import { createHostLlmClient, createJsonConsoleLogger } from "./entrypoint-wiring.js";

// ── Main ───────────────────────────────────────────────────────────────────

const main = async () => {
  const logger = createJsonConsoleLogger();

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

    // ADR-0052: optional `documents` capability, selected by environment
    // (fs / ms-graph). buildDocumentsCapability is the SINGLE wiring shared
    // with the multi-tenant worker entry, so the adapter selection can never
    // drift between the topologies; the adapter package loads only when
    // configured. createHost calls connect() on the handle at boot (validates
    // the mount / auth wiring) and close() at shutdown.
    const documents = await buildDocumentsCapability(config);
    if (documents !== undefined) {
      capabilities.push(documents);
      logger.info(`documents capability: ${describeDocumentsAdapter(config)}`);
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
      llm: await createHostLlmClient(config),
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

    // Step 6: Wire the optional HITL queue. The shared helper keeps the feature
    // gate, lazy BullMQ import, and ownership log identical in both entrypoints.
    const queueBackend = await createHitlQueueBackend(config, logger);

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
        await closeHitlQueueBackend(queueBackend, logger);
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
