import { bootstrap } from "./bootstrap.js";

let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

try {
  bootstrapResult = await bootstrap();
} catch (e) {
  console.error("Fatal: bootstrap failed", e);
  process.exit(1);
}

const { app, config, shutdown } = bootstrapResult;

// Graceful shutdown — flush pending traces on SIGTERM/SIGINT
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down...`);
    await shutdown();
    process.exit(0);
  });
}

export default {
  port: config.PORT,
  fetch: app.fetch,
};

console.log(`Customer summary server running on port ${config.PORT}`);
