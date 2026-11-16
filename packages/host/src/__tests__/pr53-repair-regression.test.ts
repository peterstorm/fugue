/**
 * PR-53 repair regression — the host's SYNCHRONOUS run path threads the
 * operator fan cap end to end (FR-030/FR-031).
 *
 * `fan-cap-wiring.test.ts` pins the seams (`syncRunOptions` /
 * `sliceRunOptions` carry the branded cap), but no test observed the RunOptions
 * the host's REAL `createDagExecutor` hands to the kernel with a non-default
 * cap. This test boots the real host (`createHost`, modelled on
 * `integration/full-lifecycle.test.ts`) with `FAN_CHILD_CONCURRENCY_MAX=2`
 * against the real Redis (`REDIS_URL`), runs a map-fan DAG through the
 * synchronous HTTP path (`POST /dags/:id/run`), and observes the bound
 * BEHAVIOURALLY rather than by spying on options:
 *
 * Every admitted fan child checkpoints its completion through the checkpointer,
 * whose `saveNode` lands as exactly ONE `hSet` on the run's `$nodes` hash — and
 * that hSet is the ONLY `hSet` the run path issues (`setMeta` uses `set`, `load`
 * uses `hGetAll`). Wrapping that single port method therefore counts concurrent
 * in-flight child saves: increment on entry, hold, decrement on exit, track the
 * max.
 *
 * Why the assertion discriminates 2 from the kernel default (8): the fan shell
 * starts each step's dispatches in one microtask burst and every admitted child
 * holds CHILD_HOLD_MS before saving and SAVE_HOLD_MS inside the counted `hSet`,
 * so the observed max concurrent saves equals the effective fan concurrency
 * whenever the width allows it. With the cap threaded, children run in pairs and
 * the observed max is exactly 2; a host that stops threading the configured cap
 * silently runs the fan at the kernel default of 8, where the observed max
 * exceeds 2 — the assertion fails and the regression is visible.
 */

import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { z } from "zod";
import {
  DAG_INPUT,
  createFetchNode,
  createMapNode,
  defineDag,
  dagId,
  fanConcurrencyCap,
  gitSha,
  noopTracer,
  ok,
} from "@fuguejs/framework";
import type { DagDef, LlmPricingModel } from "@fuguejs/framework";
import { createHost } from "../host.js";
import type { HostConfig, HostInstance } from "../host.js";
import type {
  BulkLoadResult,
  GitPort,
  LoadResult,
  ModuleLoaderPort,
  RedisPort,
  SharedInfra,
} from "../ports.js";
import { createRedisConnectivity } from "../adapters/redis-connectivity.js";
import { createInMemorySpendLedger } from "../adapters/spend-ledger-memory.js";
import { testLogger } from "./fixtures/host-boot-fakes.js";

const redisUrl = process.env.REDIS_URL;

// ── Fan timing ──────────────────────────────────────────────────────────────

/** How long each admitted child holds inside its `fetch` before checkpointing. */
const CHILD_HOLD_MS = 30;
/** How long every counted `hSet` holds inside the wrapper, making overlap observable. */
const SAVE_HOLD_MS = 15;
/** Fan width — comfortably above both the cap (2) and the kernel default (8). */
const WIDTH = 12;

const items = z.object({ items: z.array(z.number()) });
const numbers = z.array(z.number());

const fanCapDag = (): DagDef => {
  const child = defineDag({
    id: "fan-cap-child",
    nodes: {
      hold: createFetchNode({
        id: "hold",
        inputSchema: z.number(),
        outputSchema: z.number(),
        fetch: async (n) => {
          await new Promise((resolve) => setTimeout(resolve, CHILD_HOLD_MS));
          return ok(n * 2);
        },
      }),
    },
    edges: [{ from: DAG_INPUT, to: "hold" }],
    outputNodeId: "hold",
  });
  const fan = createMapNode({
    id: "fan",
    inputSchema: items,
    outputSchema: numbers,
    widthFrom: "items",
    maxWidth: 32,
    child,
    childOutputSchema: z.number(),
    reduce: (xs) => ok([...xs]),
    // Author ABOVE the operator cap: the effective concurrency must be
    // min(authored, host cap) = 2, so the HOST cap — not the author's setting —
    // is the binding constraint this test observes. (An absent authored setting
    // defaults to 1, which would make the fan sequential and the assertion
    // vacuous.) If the host stops threading its cap, effective = min(8, 8) = 8
    // and the observed max concurrent saves exceeds 2 — the test fails.
    childConcurrency: 8,
  });
  return defineDag({
    id: "fan-cap-e2e",
    nodes: { fan },
    edges: [{ from: DAG_INPUT, to: "fan" }],
    outputNodeId: "fan",
  });
};

// ── Host boot fakes (modelled on integration/full-lifecycle.test.ts) ───────

const testConfig = (fanCap: number): HostConfig => ({
  DAGS_REPO_URL: "https://github.com/test/dags.git",
  DAGS_REPO_BRANCH: "main",
  DAGS_POLL_INTERVAL_MS: 60_000, // Long interval — the run is triggered over HTTP
  REDIS_PROBE_INTERVAL_MS: 60_000, // Long interval — the probe must not fire mid-run
  DAGS_LOCAL_PATH: "/tmp/pr53-fan-cap-dags",
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
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_WINDOW_MS: 60_000,
  DEFAULT_CACHE_TTL_MS: 300_000,
  DEFAULT_CHECKPOINT_TTL_MS: 86_400_000,
  FAN_CHILD_CONCURRENCY_MAX: fanConcurrencyCap(fanCap),
});

const fakeGit = (): GitPort => ({
  clone: async () => ok(undefined),
  pull: async () => ok(undefined),
  currentSha: async () => ok(gitSha("a".repeat(40))),
  hasLockfileChanged: async () => ok(false),
  install: async () => ok(undefined),
});

const fanCapLoadResult = (dag: DagDef): LoadResult => ({
  id: dagId(dag.id),
  registration: {
    dag,
    inputSchema: items,
    route: `/dags/${dag.id}/run`,
    config: { timeoutMs: 30_000, maxConcurrent: 5 },
    meta: { description: "fan cap end-to-end regression", version: "1.0.0" },
  },
  modulePath: "/tmp/pr53-fan-cap-dags/dags/team/fan-cap-e2e/dag.ts",
  prompts: new Map(),
});

const fakeLoader = (dag: DagDef): ModuleLoaderPort => ({
  loadDagModule: async (path) =>
    path.includes("fan-cap-e2e")
      ? ok(fanCapLoadResult(dag))
      : Promise.resolve({ ok: false, error: { kind: "import-failed" as const, path, message: "not found" } }),
  discoverDagPaths: async () => ok([fanCapLoadResult(dag).modulePath]),
  loadAll: async (): Promise<BulkLoadResult> => ({
    loaded: [fanCapLoadResult(dag)],
    errors: [],
  }),
});

/**
 * Wrap the REAL Redis data port so every `hSet` — the checkpointer's `saveNode`
 * — records concurrent in-flight saves. Increment on entry, hold, decrement on
 * exit; track the observed max.
 */
const countingRedis = (base: RedisPort) => {
  if (base.hSet === undefined) throw new Error("the real Redis port must implement hSet");
  const realHSet = base.hSet;
  const stats = { inFlight: 0, maxInFlight: 0 };
  const redis: RedisPort = {
    ...base,
    hSet: async (key, field, value, opts) => {
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, SAVE_HOLD_MS));
        return await realHSet(key, field, value, opts);
      } finally {
        stats.inFlight -= 1;
      }
    },
  };
  return { stats, redis };
};

const sharedInfra = (redis: RedisPort): SharedInfra => ({
  llm: {
    sendStructured: async (req) => ok({ output: req.schema.parse(0), rawText: "0", inputTokens: 0, outputTokens: 0 }),
    sendWithTools: async (req) => ok({ output: req.schema.parse(0), rawText: "0", inputTokens: 0, outputTokens: 0 }),
  },
  llmPricingModel: { kind: "request" } as LlmPricingModel,
  redis,
  spendLedger: createInMemorySpendLedger(),
  tracer: noopTracer,
  contentFilter: null,
  prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  capabilities: [],
});

// ── The regression ──────────────────────────────────────────────────────────

describe.skipIf(!redisUrl)("fan cap end to end — the real createDagExecutor threads FAN_CHILD_CONCURRENCY_MAX (FR-030)", () => {
  it("observes at most 2 concurrent child checkpoint saves when the operator cap is 2", async () => {
    const connected = await createRedisConnectivity(redisUrl!);
    if (!connected.ok) throw new Error(`Redis unreachable: ${JSON.stringify(connected.error)}`);
    const cleanupRedis = new Redis(redisUrl!);
    const { stats, redis } = countingRedis(connected.value.redis);
    let host: HostInstance | null = null;

    try {
      const booted = await createHost({
        config: testConfig(2),
        git: fakeGit(),
        loader: fakeLoader(fanCapDag()),
        redis: connected.value.port,
        sharedInfra: sharedInfra(redis),
        logger: testLogger(),
      });
      if (!booted.ok) throw new Error(`host failed to boot: ${JSON.stringify(booted.error)}`);
      host = booted.value;
      const port = host.server?.port;
      if (port === undefined || port === 0) throw new Error("host did not report a TCP port");

      // The SYNCHRONOUS path: POST /dags/:id/run executes inline through the
      // real createDagExecutor → syncRunOptions → runDag.
      const response = await fetch(`http://localhost:${port}/dags/fan-cap-e2e/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-admin-token-long-enough",
        },
        body: JSON.stringify({ items: Array.from({ length: WIDTH }, (_, i) => i) }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; data: number[] };
      expect(body.ok).toBe(true);
      expect(body.data).toEqual(Array.from({ length: WIDTH }, (_, i) => i * 2));

      // The behavioural bound: fan children save in pairs. ≤2 is the cap;
      // ≥2 proves we actually observed concurrent saves (a serialized fan —
      // or a wrapped save that never overlapped — would make the ≤2 assertion
      // vacuous).
      expect(stats.maxInFlight).toBe(2);
    } finally {
      if (host) await host.shutdown();
      const keys = await cleanupRedis.keys("fugue:default:fan-cap-e2e:*");
      if (keys.length > 0) await cleanupRedis.del(...keys);
      await cleanupRedis.quit();
      await connected.value.disconnect();
    }
  });
});
