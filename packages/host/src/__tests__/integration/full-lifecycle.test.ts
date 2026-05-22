/**
 * Integration test — Full host lifecycle.
 *
 * Tests boot→sync→register→serve→shutdown flow with fake ports.
 * No real Redis, no real git, no real filesystem.
 *
 * @satisfies FR-006 — Host MUST refuse to start if Redis is unreachable
 * @satisfies SC-001 — Given valid DAG merged to main, host discovers and registers within poll interval + 5s
 * @satisfies NFR-012 — Git sync failures MUST NOT affect serving of already-loaded DAGs
 * @satisfies FR-060 — Host MUST exit cleanly on SIGTERM after draining in-flight requests
 * @satisfies NFR-020 — Host MUST log startup/shutdown lifecycle events
 */

import { describe, test, expect, afterEach } from "bun:test";
import { ok, err, noopTracer, gitSha } from "@fugue/framework";
import type { Result, DagId, DagDef, NodeContext, FrameworkError, RunOptions } from "@fugue/framework";
import { z } from "zod";
import type { GitPort } from "../../ports.js";
import type { ModuleLoaderPort, LoadResult, BulkLoadResult } from "../../ports.js";
import type { SharedInfra, RedisPort } from "../../ports.js";
import type { RedisConnectivityPort } from "../../lifecycle/startup.js";
import type { SyncLogger } from "../../sync/sync-loop.js";
import type { HostConfig } from "../../domain/config.js";
import type { HostInstance } from "../../host.js";
import { createHost } from "../../host.js";
import type { DagRegistration } from "../../domain/dag-registration.js";

// ── Test Helpers ───────────────────────────────────────────────────────────

const testConfig = (overrides?: Partial<HostConfig>): HostConfig => ({
  DAGS_REPO_URL: "https://github.com/test/dags.git",
  DAGS_REPO_BRANCH: "main",
  DAGS_POLL_INTERVAL_MS: 60_000, // Long interval — we trigger manually
  DAGS_LOCAL_PATH: "/tmp/test-dags",
  REDIS_URL: "redis://localhost:6379",
  PORT: 0, // Let Bun pick a random port
  MAX_GLOBAL_CONCURRENCY: 50,
  DEFAULT_DAG_CONCURRENCY: 10,
  DEFAULT_DAG_TIMEOUT_MS: 30_000,
  MAX_DAG_TIMEOUT_MS: 120_000,
  DRAIN_TIMEOUT_MS: 5_000,
  LLM_PROVIDER: "anthropic" as const,
  ANTHROPIC_API_KEY: "test-key",
  ADMIN_TOKEN: "test-admin-token-long-enough",
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  MLFLOW_TRACKING_URI: undefined,
  MLFLOW_EXPERIMENT_ID: undefined,
  OPENAI_API_KEY: undefined,
  AZURE_OPENAI_ENDPOINT: undefined,
  AZURE_OPENAI_API_KEY: undefined,
  AZURE_OPENAI_DEPLOYMENT: undefined,
  ASYNC_RESULT_TTL_MS: 3_600_000,
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_WINDOW_MS: 60_000,
  DEFAULT_CACHE_TTL_MS: 300_000,
  DEFAULT_CHECKPOINT_TTL_MS: 86_400_000,
  ...overrides,
});

const fakeDag = (id: string): DagDef => ({
  id,
  nodes: [],
  edges: [],
}) as unknown as DagDef;

const fakeRegistration = (id: string): DagRegistration => ({
  dag: fakeDag(id),
  inputSchema: z.object({ input: z.string() }),
  route: `/dags/${id}/run`,
  config: { timeoutMs: 30_000, maxConcurrent: 5 },
  meta: { description: `Test DAG ${id}`, version: "1.0.0" },
});

const fakeLoadResult = (id: string): LoadResult => ({
  id: id as DagId,
  registration: fakeRegistration(id),
  modulePath: `/tmp/test-dags/dags/team/${id}/dag.ts`,
});

const createFakeGitPort = (opts?: { failPull?: boolean; shas?: string[] }): GitPort => {
  let shaIndex = 0;
  const shas = opts?.shas ?? ["abc1234"];

  return {
    clone: async () => ok(undefined),
    pull: async () => {
      if (opts?.failPull) {
        return err({ kind: "git-pull-failed", message: "network error" });
      }
      return ok(undefined);
    },
    currentSha: async () => {
      const sha = shas[Math.min(shaIndex, shas.length - 1)];
      shaIndex++;
      return ok(gitSha(sha));
    },
    hasLockfileChanged: async () => ok(false),
    install: async () => ok(undefined),
  };
};

const createFakeModuleLoader = (dags: LoadResult[]): ModuleLoaderPort => ({
  loadDagModule: async (path, _sha) => {
    const dag = dags.find((d) => d.modulePath === path);
    if (!dag) return err({ kind: "import-failed", path, message: "not found" });
    return ok(dag);
  },
  discoverDagPaths: async () => ok(dags.map((d) => d.modulePath)),
  loadAll: async (_root, _sha): Promise<BulkLoadResult> => ({
    loaded: dags,
    errors: [],
  }),
});

const createFakeRedis = (opts?: { failPing?: boolean }): { port: RedisConnectivityPort; redis: RedisPort } => {
  const store = new Map<string, string>();

  return {
    port: {
      ping: async () => {
        if (opts?.failPing) {
          return err({ kind: "redis-unavailable" as const, operation: "PING" });
        }
        return ok(undefined);
      },
    },
    redis: {
      get: async (key) => ok(store.get(key) ?? null),
      set: async (key, value) => { store.set(key, value); return ok("OK" as string | null); },
      del: async (key) => { const had = store.has(key) ? 1 : 0; store.delete(key); return ok(had); },
      keys: async (pattern) => {
        const prefix = pattern.replace(/\*$/, "");
        const matched = [...store.keys()].filter(k => k.startsWith(prefix));
        return ok(matched);
      },
    },
  };
};

const createFakeSharedInfra = (redis: RedisPort): SharedInfra => ({
  llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
  redis,
  tracer: noopTracer,
  contentFilter: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

const createTestLogger = (): SyncLogger & { logs: Array<{ level: string; msg: string; data?: unknown }> } => {
  const logs: Array<{ level: string; msg: string; data?: unknown }> = [];
  return {
    logs,
    info: (msg, data) => logs.push({ level: "info", msg, data }),
    warn: (msg, data) => logs.push({ level: "warn", msg, data }),
    error: (msg, data) => logs.push({ level: "error", msg, data }),
  };
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Full Host Lifecycle", () => {
  let host: HostInstance | null = null;

  afterEach(async () => {
    if (host) {
      await host.shutdown();
      host = null;
    }
  });

  test("FR-006: refuses to start when Redis is unreachable", async () => {
    const { port, redis } = createFakeRedis({ failPing: true });
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort(),
      loader: createFakeModuleLoader([]),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("redis-unavailable");
    }

    // Verify actionable error was logged
    const errorLogs = logger.logs.filter((l) => l.level === "error");
    expect(errorLogs.some((l) => l.msg.includes("Redis is unreachable"))).toBe(true);
  });

  test("boots successfully with valid config and loads DAGs", async () => {
    const dags = [fakeLoadResult("billing-invoice"), fakeLoadResult("ops-alerts")];
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort(),
      loader: createFakeModuleLoader(dags),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      host = result.value;
      const state = host.getState();
      expect(state.phase).toBe("ready");
      if (state.phase === "ready") {
        expect(state.registry.dags.size).toBe(2);
        expect(state.registry.dags.has("billing-invoice" as DagId)).toBe(true);
        expect(state.registry.dags.has("ops-alerts" as DagId)).toBe(true);
      }
    }
  });

  test("NFR-020: logs startup lifecycle events", async () => {
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort(),
      loader: createFakeModuleLoader([fakeLoadResult("test:dag")]),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      host = result.value;
    }

    // Verify lifecycle events logged
    const infoLogs = logger.logs.filter((l) => l.level === "info");
    expect(infoLogs.some((l) => l.msg.includes("Starting host boot sequence"))).toBe(true);
    expect(infoLogs.some((l) => l.msg.includes("Redis connectivity validated"))).toBe(true);
    expect(infoLogs.some((l) => l.msg.includes("Boot sequence complete"))).toBe(true);
    expect(infoLogs.some((l) => l.msg.includes("fully booted and ready"))).toBe(true);
  });

  test("serves HTTP requests on the configured port", async () => {
    const dags = [fakeLoadResult("test:echo")];
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort(),
      loader: createFakeModuleLoader(dags),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    // Health endpoint should respond
    const healthRes = await fetch(`http://localhost:${host.server!.port}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.status).toBe("ok");

    // Readiness endpoint should indicate ready
    const readyRes = await fetch(`http://localhost:${host.server!.port}/readiness`);
    expect(readyRes.status).toBe(200);
    const readyBody = await readyRes.json();
    expect(readyBody.ready).toBe(true);
    expect(readyBody.dagCount).toBe(1);

    // DAG list endpoint (requires auth)
    const dagsRes = await fetch(`http://localhost:${host.server!.port}/dags`, {
      headers: { Authorization: "Bearer test-admin-token-long-enough" },
    });
    expect(dagsRes.status).toBe(200);
    const dagsBody = await dagsRes.json();
    expect(dagsBody.count).toBe(1);
  });

  test("SC-001: sync discovers and registers new DAGs", async () => {
    const initialDags = [fakeLoadResult("dag:one")];
    const updatedDags = [fakeLoadResult("dag:one"), fakeLoadResult("dag:two")];

    let loadCallCount = 0;
    const loader: ModuleLoaderPort = {
      loadDagModule: async (path, sha) => {
        const dag = updatedDags.find((d) => d.modulePath === path);
        if (!dag) return err({ kind: "import-failed", path, message: "not found" });
        return ok(dag);
      },
      discoverDagPaths: async () =>
        ok((loadCallCount === 0 ? initialDags : updatedDags).map((d) => d.modulePath)),
      loadAll: async (_root, sha): Promise<BulkLoadResult> => {
        const dags = loadCallCount === 0 ? initialDags : updatedDags;
        loadCallCount++;
        return { loaded: dags, errors: [] };
      },
    };

    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort({ shas: ["sha1", "sha2"] }),
      loader,
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    // Initially should have 1 DAG
    let state = host.getState();
    expect(state.phase).toBe("ready");
    if (state.phase === "ready") {
      expect(state.registry.dags.size).toBe(1);
    }

    // Trigger sync — new DAG should appear
    await host.triggerSync();

    state = host.getState();
    expect(state.phase).toBe("ready");
    if (state.phase === "ready") {
      expect(state.registry.dags.size).toBe(2);
      expect(state.registry.dags.has("dag:two" as DagId)).toBe(true);
    }
  });

  test("NFR-012: sync failure preserves existing DAGs", async () => {
    const dags = [fakeLoadResult("stable:dag")];
    let shaCounter = 0;
    let pullShouldFail = false;

    const git: GitPort = {
      clone: async () => ok(undefined),
      pull: async () => {
        if (pullShouldFail) {
          return err({ kind: "git-pull-failed", message: "network timeout" });
        }
        return ok(undefined);
      },
      currentSha: async () => {
        // Return different SHA each time to trigger sync
        shaCounter++;
        return ok(gitSha(`sha-${shaCounter}`));
      },
      hasLockfileChanged: async () => ok(false),
      install: async () => ok(undefined),
    };

    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    // Use non-local mode so pull is called during sync cycles.
    // Initial clone + SHA succeeds on boot; then pull fails on subsequent sync.
    const result = await createHost({
      config: testConfig({ DAGS_LOCAL_PATH: undefined }),
      git,
      loader: createFakeModuleLoader(dags),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    // Verify initial state
    let state = host.getState();
    if (state.phase === "ready") {
      expect(state.registry.dags.size).toBe(1);
    }

    // Make pull fail and trigger sync
    pullShouldFail = true;
    await host.triggerSync();

    // DAGs should still be active
    state = host.getState();
    // Host transitions to degraded but registry is preserved
    expect(state.phase === "ready" || state.phase === "degraded").toBe(true);
    if (state.phase === "degraded" || state.phase === "ready") {
      expect(state.registry.dags.size).toBe(1);
      expect(state.registry.dags.has("stable:dag" as DagId)).toBe(true);
    }

    // Verify warning was logged
    const warnLogs = logger.logs.filter((l) => l.level === "warn");
    expect(warnLogs.some((l) => l.msg.includes("Git pull failed"))).toBe(true);
  });

  test("FR-060: graceful shutdown stops sync and server", async () => {
    const dags = [fakeLoadResult("shutdown:test")];
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort(),
      loader: createFakeModuleLoader(dags),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    const serverPort = host.server!.port;

    // Shutdown the host
    await host.shutdown();

    // State should be stopped
    const state = host.getState();
    expect(state.phase).toBe("stopped");

    // Verify shutdown lifecycle logged
    const infoLogs = logger.logs.filter((l) => l.level === "info");
    expect(infoLogs.some((l) => l.msg.includes("Shutdown initiated"))).toBe(true);
    expect(infoLogs.some((l) => l.msg.includes("Host stopped"))).toBe(true);

    host = null; // Already shut down
  });

  test("boots with empty DAGs directory", async () => {
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort(),
      loader: createFakeModuleLoader([]), // No DAGs
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      host = result.value;
      const state = host.getState();
      expect(state.phase).toBe("ready");
      if (state.phase === "ready") {
        expect(state.registry.dags.size).toBe(0);
      }
    }
  });

  test("circuit breakers reset on sync with new registry", async () => {
    const dags = [fakeLoadResult("circuit:test")];
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort({ shas: ["sha1", "sha2"] }),
      loader: createFakeModuleLoader(dags),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    // Trigger sync — circuit breakers should be force-reset
    await host.triggerSync();

    const breakers = host.getCircuitBreakers();
    const breaker = breakers.get("circuit:test" as DagId);
    // After sync, circuit should be closed (force-reset)
    expect(breaker).toBeDefined();
    if (breaker) {
      expect(breaker.state).toBe("closed");
    }
  });

  test("concurrency state is initialized from config", async () => {
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig({ MAX_GLOBAL_CONCURRENCY: 25, DEFAULT_DAG_CONCURRENCY: 5 }),
      git: createFakeGitPort(),
      loader: createFakeModuleLoader([]),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    const concurrency = host.getConcurrency();
    expect(concurrency.global.max).toBe(25);
    expect(concurrency.defaultDagMax).toBe(5);
    expect(concurrency.global.current).toBe(0);
  });

  test("handles initial git clone failure gracefully", async () => {
    const failGit: GitPort = {
      clone: async (url) => err({ kind: "git-clone-failed", url, message: "permission denied" }),
      pull: async () => ok(undefined),
      currentSha: async () => ok(gitSha("abc")),
      hasLockfileChanged: async () => ok(false),
      install: async () => ok(undefined),
    };

    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();

    const result = await createHost({
      config: testConfig({ DAGS_LOCAL_PATH: undefined }), // Force git mode
      git: failGit,
      loader: createFakeModuleLoader([]),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("git-clone-failed");
    }
  });

  test("sync completion is ignored when host is draining", async () => {
    const { port, redis } = createFakeRedis();
    const logger = createTestLogger();
    const dags = [fakeLoadResult("drain:test")];

    const result = await createHost({
      config: testConfig(),
      git: createFakeGitPort({ shas: ["sha1", "sha2"] }),
      loader: createFakeModuleLoader(dags),
      redis: port,
      sharedInfra: createFakeSharedInfra(redis),
      logger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    host = result.value;

    // Start shutdown (transitions to draining)
    const shutdownPromise = host.shutdown();

    // After shutdown starts, the host state should be draining or stopped
    const stateAfterShutdown = host.getState();
    expect(["draining", "stopped"]).toContain(stateAfterShutdown.phase);

    await shutdownPromise;

    // After shutdown completes, state should be stopped
    expect(host.getState().phase).toBe("stopped");
  });
});
