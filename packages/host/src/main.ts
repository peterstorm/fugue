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
import { parseHostConfig } from "./domain/config.js";
import { formatHostError } from "./domain/host-error.js";
import { createHost } from "./host.js";
import { createRedisConnectivity } from "./adapters/redis-connectivity.js";
import { closeHitlQueueBackend, createHitlQueueBackend } from "./hitl/queue-backend.js";
import { createJsonConsoleLogger } from "./entrypoint-wiring.js";

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
    // Steps 1-5: the runtime every host presents to DAGs — built-in and
    // gated optional capabilities, shared infrastructure, git adapter and module
    // loader. Shared verbatim with `worker-main.ts` so the two topologies can
    // never disagree about which capabilities a DAG may declare.
    const { sharedInfra, git, loader } = await buildRuntimeDeps(config, redis, logger);

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
