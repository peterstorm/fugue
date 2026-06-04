/**
 * Unit tests for lifecycle/startup.ts
 *
 * Tests validateRedis, buildSyncConfig, and executeStartup independently.
 */

import { describe, it, expect } from "bun:test";
import { ok, err, gitSha } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { HostConfig } from "../../domain/config.js";
import type { RedisConnectivityPort, GitPort, ModuleLoaderPort } from "../../ports.js";
import type { SyncLogger } from "../../sync/sync-loop.js";
import { validateRedis, buildSyncConfig, executeStartup } from "../../lifecycle/startup.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const noopLogger: SyncLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testConfig = (overrides?: Partial<HostConfig>): HostConfig => ({
  PORT: 4000,
  REDIS_URL: "redis://localhost:6379",
  DAGS_REPO_URL: "https://github.com/test/dags.git",
  DAGS_REPO_BRANCH: "main",
  DAGS_POLL_INTERVAL_MS: 30_000,
  REDIS_PROBE_INTERVAL_MS: 10_000,
  DAGS_LOCAL_PATH: undefined,
  MAX_GLOBAL_CONCURRENCY: 100,
  DEFAULT_DAG_CONCURRENCY: 10,
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_WINDOW_MS: 60_000,
  DRAIN_TIMEOUT_MS: 15_000,
  ADMIN_TOKEN: "test-admin-token",
  DEFAULT_DAG_TIMEOUT_MS: 60_000,
  MAX_DAG_TIMEOUT_MS: 120_000,
  LLM_PROVIDER: "anthropic" as const,
  ANTHROPIC_API_KEY: "test-key",
  ...overrides,
} as HostConfig);

const fakeRedis = (result: Result<void, HostError>): RedisConnectivityPort => ({
  ping: async () => result,
});

const fakeGit = (): GitPort => ({
  clone: async () => ok(undefined),
  pull: async () => ok(undefined),
  currentSha: async () => ok(gitSha("abc12345")),
  hasLockfileChanged: async () => ok(false),
  install: async () => ok(undefined),
});

const fakeLoader = (): ModuleLoaderPort => ({
  loadDagModule: async () => ok({ id: "test" as any, registration: {} as any, modulePath: "", prompts: new Map() }),
  discoverDagPaths: async () => ok([]),
  loadAll: async () => ({ loaded: [], errors: [] }),
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("validateRedis", () => {
  it("returns ok when Redis is reachable", async () => {
    const result = await validateRedis(fakeRedis(ok(undefined)), noopLogger);
    expect(result.ok).toBe(true);
  });

  it("returns err when Redis ping fails", async () => {
    const redisErr: HostError = { kind: "redis-unavailable", operation: "ping" };
    const result = await validateRedis(fakeRedis(err(redisErr)), noopLogger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("redis-unavailable");
    }
  });
});

describe("buildSyncConfig", () => {
  it("uses remote mode when DAGS_LOCAL_PATH is undefined", () => {
    const config = testConfig({ DAGS_LOCAL_PATH: undefined });
    const clock = () => 12345;
    const syncConfig = buildSyncConfig(config, clock);

    expect(syncConfig.isLocalMode).toBe(false);
    expect(syncConfig.repoPath).toBe("/tmp/fugue-dags-12345");
    expect(syncConfig.repoUrl).toBe("https://github.com/test/dags.git");
    expect(syncConfig.branch).toBe("main");
    expect(syncConfig.pollIntervalMs).toBe(30_000);
  });

  it("uses local mode when DAGS_LOCAL_PATH is set", () => {
    const config = testConfig({ DAGS_LOCAL_PATH: "/my/dags" });
    const syncConfig = buildSyncConfig(config);

    expect(syncConfig.isLocalMode).toBe(true);
    expect(syncConfig.repoPath).toBe("/my/dags");
  });

  it("treats empty DAGS_LOCAL_PATH as remote mode", () => {
    const config = testConfig({ DAGS_LOCAL_PATH: "" });
    const syncConfig = buildSyncConfig(config);

    expect(syncConfig.isLocalMode).toBe(false);
  });

  it("uses injected clock for deterministic repo path", () => {
    const config = testConfig();
    const clock1 = () => 1000;
    const clock2 = () => 2000;

    expect(buildSyncConfig(config, clock1).repoPath).toBe("/tmp/fugue-dags-1000");
    expect(buildSyncConfig(config, clock2).repoPath).toBe("/tmp/fugue-dags-2000");
  });
});

describe("executeStartup", () => {
  it("succeeds with valid Redis and successful initial sync", async () => {
    const result = await executeStartup({
      config: testConfig(),
      redis: fakeRedis(ok(undefined)),
      git: fakeGit(),
      loader: fakeLoader(),
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registry).toBeDefined();
      expect(result.value.sha).toBeDefined();
      expect(result.value.syncConfig).toBeDefined();
    }
  });

  it("fails when Redis is unreachable", async () => {
    const result = await executeStartup({
      config: testConfig(),
      redis: fakeRedis(err({ kind: "redis-unavailable", operation: "ping" })),
      git: fakeGit(),
      loader: fakeLoader(),
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("redis-unavailable");
    }
  });

  it("fails when git clone fails (non-local mode)", async () => {
    const failGit: GitPort = {
      ...fakeGit(),
      clone: async () => err({ kind: "git-clone-failed", url: "https://x.git", message: "timeout" }),
    };

    const result = await executeStartup({
      config: testConfig(),
      redis: fakeRedis(ok(undefined)),
      git: failGit,
      loader: fakeLoader(),
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("git-clone-failed");
    }
  });

  it("fails when currentSha fails", async () => {
    const failGit: GitPort = {
      ...fakeGit(),
      currentSha: async () => err({ kind: "git-spawn-failed", operation: "rev-parse", message: "oops" }),
    };

    const result = await executeStartup({
      config: testConfig(),
      redis: fakeRedis(ok(undefined)),
      git: failGit,
      loader: fakeLoader(),
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("git-spawn-failed");
    }
  });

  it("succeeds with empty DAGs directory", async () => {
    const result = await executeStartup({
      config: testConfig(),
      redis: fakeRedis(ok(undefined)),
      git: fakeGit(),
      loader: fakeLoader(),
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registry.dags.size).toBe(0);
    }
  });
});
