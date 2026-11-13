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

import { buildRuntimeDeps } from "./adapters/runtime-capabilities.js";
import { parseHostConfig, type HostConfig } from "./domain/config.js";
import { formatHostError } from "./domain/host-error.js";
import { createHost } from "./host.js";
import { createRedisConnectivity, disconnectRedisQuietly } from "./adapters/redis-connectivity.js";
import { closeHitlQueueBackend, createHitlQueueBackend } from "./hitl/queue-backend.js";
import { createJsonConsoleLogger } from "./entrypoint-wiring.js";
import type { LogPort } from "./ports.js";

// ── Main ───────────────────────────────────────────────────────────────────

type RedisConnectivityBundle = Extract<
  Awaited<ReturnType<typeof createRedisConnectivity>>,
  { readonly ok: true }
>["value"];

const parseConfigOrExit = (logger: LogPort): HostConfig => {
  logger.info("Parsing host configuration from environment...");
  const configResult = parseHostConfig(process.env as Record<string, string | undefined>);
  if (!configResult.ok) {
    logger.error(`Configuration error: ${formatHostError(configResult.error)}`);
    logger.error("Host cannot start due to invalid configuration. Set required environment variables and retry.");
    process.exit(1);
  }
  return configResult.value;
};

const connectRedisOrExit = async (config: HostConfig, logger: LogPort): Promise<RedisConnectivityBundle> => {
  const redisResult = await createRedisConnectivity(config.REDIS_URL);
  if (!redisResult.ok) {
    logger.error(`Redis connectivity failed: ${formatHostError(redisResult.error)}`);
    process.exit(1);
  }
  return redisResult.value;
};

const bootHost = async (
  config: HostConfig,
  redis: RedisConnectivityBundle,
  logger: LogPort,
): Promise<void> => {
  // Steps 1-5: the runtime every host presents to DAGs — built-in and
  // gated optional capabilities, shared infrastructure, git adapter and module
  // loader. Shared verbatim with `worker-main.ts` so the two topologies can
  // never disagree about which capabilities a DAG may declare.
  const { sharedInfra, git, loader } = await buildRuntimeDeps(config, redis.redis, logger);

  // Step 6: Wire the optional HITL queue. The shared helper keeps the feature
  // gate, lazy BullMQ import, and ownership log identical in both entrypoints.
  const queueBackend = await createHitlQueueBackend(config, logger);

  // Step 7: Create and boot host
  const hostResult = await createHost({
    config,
    git,
    loader,
    redis: redis.port,
    sharedInfra,
    logger,
    queueBackend,
    onShutdown: async () => {
      await closeHitlQueueBackend(queueBackend, logger);
      await redis.disconnect();
    },
  });

  if (!hostResult.ok) {
    logger.error(`Host failed to start: ${formatHostError(hostResult.error)}`);
    await redis.disconnect();
    process.exit(1);
  }

  logger.info("Fugue host is running");
};

const main = async () => {
  const logger = createJsonConsoleLogger();

  // Step 1: Parse config from environment
  const config = parseConfigOrExit(logger);

  // Step 2: Create Redis connectivity
  const redis = await connectRedisOrExit(config, logger);

  try {
    await bootHost(config, redis, logger);
  } catch (e) {
    await disconnectRedisQuietly(redis.disconnect);
    throw e;
  }
};

// Execute main — catch any unhandled error
main().catch((e) => {
  console.error("Fatal error during host startup:", e);
  process.exit(1);
});
