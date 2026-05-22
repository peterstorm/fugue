/**
 * Startup sequence unit tests — validateRedis, buildSyncConfig, executeStartup.
 */

import { describe, test, expect } from "bun:test";
import { ok, err } from "@fugue/framework";
import type { Result } from "@fugue/framework";
import type { HostError } from "../../domain/host-error.js";
import type { HostConfig } from "../../domain/config.js";
import type { SyncLogger } from "../../sync/sync-loop.js";
import type { GitPort } from "../../adapters/git-sync.js";
import type { ModuleLoaderPort, BulkLoadResult } from "../../adapters/module-loader.js";
import type { RedisConnectivityPort } from "../../lifecycle/startup.js";
import { validateRedis, buildSyncConfig, executeStartup } from "../../lifecycle/startup.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const createTestLogger = (): { logger: SyncLogger; logs: Array<{ level: string; msg: string }> } => {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    logs,
    logger: {
      info: (msg) => logs.push({ level: "info", msg }),
      warn: (msg) => logs.push({ level: "warn", msg }),
      error: (msg) => logs.push({ level: "error", msg }),
    },
  };
};

const testConfig = (overrides?: Partial<HostConfig>): HostConfig => ({
  DAGS_REPO_URL: "https://github.com/test/dags.git",
  DAGS_REPO_BRANCH: "main",
  DAGS_POLL_INTERVAL_MS: 30_000,
  DAGS_LOCAL_PATH: undefined,
  REDIS_URL: "redis://localhost:6379",
  PORT: 3000,
  MAX_GLOBAL_CONCURRENCY: 50,
  DEFAULT_DAG_CONCURRENCY: 10,
  DEFAULT_DAG_TIMEOUT_MS: 60_000,
  MAX_DAG_TIMEOUT_MS: 120_000,
  DRAIN_TIMEOUT_MS: 30_000,
  LLM_PROVIDER: "anthropic" as const,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  AZURE_OPENAI_ENDPOINT: undefined,
  AZURE_OPENAI_API_KEY: undefined,
  AZURE_OPENAI_DEPLOYMENT: undefined,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  MLFLOW_TRACKING_URI: undefined,
  MLFLOW_EXPERIMENT_ID: undefined,
  ASYNC_RESULT_TTL_MS: 3_600_000,
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_WINDOW_MS: 60_000,
  DEFAULT_CACHE_TTL_MS: 300_000,
  DEFAULT_CHECKPOINT_TTL_MS: 86_400_000,
  ...overrides,
});

const fakeGit = (): GitPort => ({
  clone: async () => ok(undefined),
  pull: async () => ok(undefined),
  currentSha: async () => ok("abc123"),
  hasLockfileChanged: async () => ok(false),
  install: async () => ok(undefined),
});

const fakeLoader = (): ModuleLoaderPort => ({
  loadDagModule: async () => err({ kind: "import-failed", path: "x", message: "unused" }),
  discoverDagPaths: async () => ok([]),
  loadAll: async (): Promise<BulkLoadResult> => ({ loaded: [], errors: [] }),
});

// ── validateRedis ──────────────────────────────────────────────────────────

describe("validateRedis", () => {
  test("returns ok and logs success when Redis responds", async () => {
    const { logger, logs } = createTestLogger();
    const redis: RedisConnectivityPort = { ping: async () => ok(undefined) };

    const result = await validateRedis(redis, logger);
    expect(result.ok).toBe(true);
    expect(logs.some((l) => l.msg.includes("Redis connectivity validated"))).toBe(true);
  });

  test("returns err and logs failure when Redis is unreachable", async () => {
    const { logger, logs } = createTestLogger();
    const redis: RedisConnectivityPort = {
      ping: async () => err({ kind: "redis-unavailable", operation: "PING" }),
    };

    const result = await validateRedis(redis, logger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("redis-unavailable");
    }
    expect(logs.some((l) => l.level === "error" && l.msg.includes("Redis is unreachable"))).toBe(true);
  });

  test("logs 'Validating Redis connectivity...' at start", async () => {
    const { logger, logs } = createTestLogger();
    const redis: RedisConnectivityPort = { ping: async () => ok(undefined) };

    await validateRedis(redis, logger);
    expect(logs[0].msg).toBe("Validating Redis connectivity...");
  });
});

// ── buildSyncConfig ────────────────────────────────────────────────────────

describe("buildSyncConfig", () => {
  test("local mode: uses DAGS_LOCAL_PATH as repoPath", () => {
    const config = testConfig({ DAGS_LOCAL_PATH: "/my/local/dags" });
    const sync = buildSyncConfig(config);

    expect(sync.repoPath).toBe("/my/local/dags");
    expect(sync.isLocalMode).toBe(true);
  });

  test("remote mode: generates /tmp/ path", () => {
    const config = testConfig({ DAGS_LOCAL_PATH: undefined });
    const sync = buildSyncConfig(config);

    expect(sync.repoPath).toStartWith("/tmp/fugue-dags-");
    expect(sync.isLocalMode).toBe(false);
  });

  test("remote mode: empty string DAGS_LOCAL_PATH is treated as remote", () => {
    const config = testConfig({ DAGS_LOCAL_PATH: "" });
    const sync = buildSyncConfig(config);

    expect(sync.isLocalMode).toBe(false);
    expect(sync.repoPath).toStartWith("/tmp/fugue-dags-");
  });

  test("clock injection produces deterministic path", () => {
    const config = testConfig({ DAGS_LOCAL_PATH: undefined });
    const fixedClock = () => 1234567890;
    const sync = buildSyncConfig(config, fixedClock);

    expect(sync.repoPath).toBe("/tmp/fugue-dags-1234567890");
  });

  test("propagates repoUrl, branch, pollIntervalMs from config", () => {
    const config = testConfig({
      DAGS_REPO_URL: "https://example.com/dags.git",
      DAGS_REPO_BRANCH: "develop",
      DAGS_POLL_INTERVAL_MS: 5000,
      DAGS_LOCAL_PATH: "/local",
    });
    const sync = buildSyncConfig(config);

    expect(sync.repoUrl).toBe("https://example.com/dags.git");
    expect(sync.branch).toBe("develop");
    expect(sync.pollIntervalMs).toBe(5000);
  });
});

// ── executeStartup ─────────────────────────────────────────────────────────

describe("executeStartup", () => {
  test("returns err if Redis validation fails", async () => {
    const { logger } = createTestLogger();
    const result = await executeStartup({
      config: testConfig({ DAGS_LOCAL_PATH: "/tmp/x" }),
      redis: { ping: async () => err({ kind: "redis-unavailable", operation: "PING" }) },
      git: fakeGit(),
      loader: fakeLoader(),
      logger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("redis-unavailable");
    }
  });

  test("returns err if initial sync (clone) fails", async () => {
    const { logger } = createTestLogger();
    const failGit: GitPort = {
      ...fakeGit(),
      clone: async () => err({ kind: "git-clone-failed", url: "test", message: "denied" }),
    };

    const result = await executeStartup({
      config: testConfig({ DAGS_LOCAL_PATH: undefined }), // force remote mode → clone
      redis: { ping: async () => ok(undefined) },
      git: failGit,
      loader: fakeLoader(),
      logger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("git-clone-failed");
    }
  });

  test("returns BootResult with registry on success", async () => {
    const { logger } = createTestLogger();
    const result = await executeStartup({
      config: testConfig({ DAGS_LOCAL_PATH: "/tmp/test-dags" }),
      redis: { ping: async () => ok(undefined) },
      git: fakeGit(),
      loader: fakeLoader(),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registry).toBeDefined();
    expect(result.value.sha).toBe("abc123");
    expect(result.value.syncConfig.isLocalMode).toBe(true);
  });

  test("logs lifecycle events at each step", async () => {
    const { logger, logs } = createTestLogger();
    await executeStartup({
      config: testConfig({ DAGS_LOCAL_PATH: "/tmp/test" }),
      redis: { ping: async () => ok(undefined) },
      git: fakeGit(),
      loader: fakeLoader(),
      logger,
    });

    const infoMsgs = logs.filter((l) => l.level === "info").map((l) => l.msg);
    expect(infoMsgs.some((m) => m.includes("Starting host boot sequence"))).toBe(true);
    expect(infoMsgs.some((m) => m.includes("Validating Redis connectivity"))).toBe(true);
    expect(infoMsgs.some((m) => m.includes("Redis connectivity validated"))).toBe(true);
    expect(infoMsgs.some((m) => m.includes("Sync config resolved"))).toBe(true);
    expect(infoMsgs.some((m) => m.includes("Performing initial sync"))).toBe(true);
    expect(infoMsgs.some((m) => m.includes("Boot sequence complete"))).toBe(true);
  });

  test("logs error when initial sync fails", async () => {
    const { logger, logs } = createTestLogger();
    const failGit: GitPort = {
      ...fakeGit(),
      currentSha: async () => err({ kind: "git-pull-failed", message: "not a repo" }),
    };

    await executeStartup({
      config: testConfig({ DAGS_LOCAL_PATH: "/tmp/x" }), // local mode skips clone
      redis: { ping: async () => ok(undefined) },
      git: failGit,
      loader: fakeLoader(),
      logger,
    });

    const errorMsgs = logs.filter((l) => l.level === "error").map((l) => l.msg);
    expect(errorMsgs.some((m) => m.includes("Initial sync failed"))).toBe(true);
  });
});
