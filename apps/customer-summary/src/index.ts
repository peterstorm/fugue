import { bootstrap } from "./bootstrap.js";
import { consoleAppLogger } from "./logger.js";

const log = consoleAppLogger;
let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

try {
  bootstrapResult = await bootstrap(log);
} catch (e) {
  log.error("Fatal: bootstrap failed", e);
  process.exit(1);
}

const { app, config, shutdown } = bootstrapResult;

// Graceful shutdown — flush pending traces on SIGTERM/SIGINT
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    log.info(`Received ${sig}, shutting down...`);
    await shutdown();
    process.exit(0);
  });
}

export default {
  port: config.PORT,
  fetch: app.fetch,
};

log.info(`Customer summary server running on port ${config.PORT}`);
