/**
 * Tests for NodeContext Factory.
 *
 * Verifies:
 * - FR-030: Cache keys prefixed `fugue:<dagId>:cache:<key>`
 * - FR-031: Checkpoint keys prefixed `fugue:<dagId>:<runId>:<nodeId>`
 * - FR-032: Each request gets unique runId and independent AbortSignal
 * - FR-042: Per-DAG TTL overrides apply to cache/checkpoint entries
 * - SC-008: Two DAGs using same cache key — entries isolated (no collision)
 */

import { describe, test, expect } from "bun:test";
import type { RunId, NodeId, DagId, LlmClient, Tracer } from "@fugue/framework";
import { runId, dagId, nodeId } from "@fugue/framework";
import type { RegisteredDag, DagConfig } from "../domain/registry.js";
import type { RedisPort, SharedInfra } from "../adapters/node-context-factory.js";
import {
  buildCacheKey,
  buildCheckpointKey,
  cacheKeyPrefix,
  checkpointKeyPrefix,
  createNamespacedCache,
  createNamespacedCheckpointWriter,
  createNodeContextForDag,
  resolveTtl,
} from "../adapters/node-context-factory.js";

// ── Test Helpers ───────────────────────────────────────────────────────────

/** In-memory Redis mock that records all calls for assertion. */
const createMockRedis = (): RedisPort & {
  store: Map<string, string>;
  calls: Array<{ method: string; args: unknown[] }>;
} => {
  const store = new Map<string, string>();
  const calls: Array<{ method: string; args: unknown[] }> = [];

  return {
    store,
    calls,
    get: async (key: string) => {
      calls.push({ method: "get", args: [key] });
      return store.get(key) ?? null;
    },
    set: async (key: string, value: string, ...args: string[]) => {
      calls.push({ method: "set", args: [key, value, ...args] });
      store.set(key, value);
      return "OK";
    },
  };
};

/** Minimal noop LLM client for testing. */
const noopLlm: LlmClient = {
  chat: async () => ({ ok: true, value: { content: "", tokensUsed: { input: 0, output: 0, total: 0 } } }) as any,
} as unknown as LlmClient;

/** Minimal noop Tracer for testing. */
const noopTracer: Tracer = {
  withSpan: async (_name: string, _type: string, fn: () => Promise<any>) => fn(),
};

/** Build a RegisteredDag with minimal required fields for testing. */
const buildRegisteredDag = (
  id: string,
  config: DagConfig = {},
): RegisteredDag => ({
  id: dagId(id),
  team: "test-team",
  route: `/dags/${id}`,
  dag: {} as any,
  inputSchema: {} as any,
  config,
  loadedAt: Date.now(),
  sha: "abc123",
  healthy: true,
});

const buildSharedInfra = (redis: RedisPort): SharedInfra => ({
  llm: noopLlm,
  redis,
  tracer: noopTracer,
  contentFilter: null,
});

// ── Pure Key Prefixing Tests ───────────────────────────────────────────────

describe("Key prefixing (pure functions)", () => {
  test("cacheKeyPrefix returns fugue:<dagId>:cache:", () => {
    expect(cacheKeyPrefix("customer-summary")).toBe("fugue:customer-summary:cache:");
  });

  test("buildCacheKey returns fugue:<dagId>:cache:<key>", () => {
    expect(buildCacheKey("customer-summary", "user:123")).toBe(
      "fugue:customer-summary:cache:user:123",
    );
  });

  test("checkpointKeyPrefix returns fugue:<dagId>:<runId>:", () => {
    expect(checkpointKeyPrefix("customer-summary", "run-001")).toBe(
      "fugue:customer-summary:run-001:",
    );
  });

  test("buildCheckpointKey returns fugue:<dagId>:<runId>:<nodeId>", () => {
    expect(buildCheckpointKey("customer-summary", "run-001", "fetch-orders")).toBe(
      "fugue:customer-summary:run-001:fetch-orders",
    );
  });

  test("SC-008: same key string for different DAGs produces different full keys", () => {
    const key = "shared-lookup";
    const keyA = buildCacheKey("dag-alpha", key);
    const keyB = buildCacheKey("dag-beta", key);
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:dag-alpha:cache:shared-lookup");
    expect(keyB).toBe("fugue:dag-beta:cache:shared-lookup");
  });
});

// ── Namespaced Cache Tests ─────────────────────────────────────────────────

describe("createNamespacedCache", () => {
  test("get: prefixes key and returns hit on existing data", async () => {
    const redis = createMockRedis();
    redis.store.set("fugue:my-dag:cache:item-1", JSON.stringify({ foo: "bar" }));

    const cache = createNamespacedCache(redis, "my-dag", undefined);
    const result = await cache.get("item-1");

    expect(result).toEqual({ hit: true, value: { foo: "bar" } });
    expect(redis.calls[0]).toEqual({ method: "get", args: ["fugue:my-dag:cache:item-1"] });
  });

  test("get: returns miss when key does not exist", async () => {
    const redis = createMockRedis();
    const cache = createNamespacedCache(redis, "my-dag", undefined);
    const result = await cache.get("nonexistent");

    expect(result).toEqual({ hit: false });
  });

  test("get: returns miss for corrupted (non-JSON) data", async () => {
    const redis = createMockRedis();
    redis.store.set("fugue:my-dag:cache:broken", "not-valid-json{{{");

    const cache = createNamespacedCache(redis, "my-dag", undefined);
    const result = await cache.get("broken");

    expect(result).toEqual({ hit: false });
  });

  test("set: writes with prefixed key and no TTL when none configured", async () => {
    const redis = createMockRedis();
    const cache = createNamespacedCache(redis, "my-dag", undefined);
    await cache.set("item-1", { hello: "world" });

    expect(redis.store.get("fugue:my-dag:cache:item-1")).toBe(JSON.stringify({ hello: "world" }));
    // Should NOT include EX args
    expect(redis.calls[0]).toEqual({
      method: "set",
      args: ["fugue:my-dag:cache:item-1", JSON.stringify({ hello: "world" })],
    });
  });

  test("set: applies explicit TTL from caller", async () => {
    const redis = createMockRedis();
    const cache = createNamespacedCache(redis, "my-dag", undefined);
    await cache.set("item-1", "value", 300);

    expect(redis.calls[0]).toEqual({
      method: "set",
      args: ["fugue:my-dag:cache:item-1", JSON.stringify("value"), "EX", "300"],
    });
  });

  test("FR-042: applies default TTL when caller omits TTL", async () => {
    const redis = createMockRedis();
    const cache = createNamespacedCache(redis, "my-dag", 60);
    await cache.set("item-1", "value");

    expect(redis.calls[0]).toEqual({
      method: "set",
      args: ["fugue:my-dag:cache:item-1", JSON.stringify("value"), "EX", "60"],
    });
  });

  test("explicit TTL overrides default TTL", async () => {
    const redis = createMockRedis();
    const cache = createNamespacedCache(redis, "my-dag", 60);
    await cache.set("item-1", "value", 120);

    expect(redis.calls[0]).toEqual({
      method: "set",
      args: ["fugue:my-dag:cache:item-1", JSON.stringify("value"), "EX", "120"],
    });
  });

  test("set returns Ok result", async () => {
    const redis = createMockRedis();
    const cache = createNamespacedCache(redis, "my-dag", undefined);
    const result = await cache.set("item-1", "value");

    expect(result).toEqual({ ok: true, value: undefined });
  });
});

// ── Namespaced Checkpoint Writer Tests ─────────────────────────────────────

describe("createNamespacedCheckpointWriter", () => {
  test("FR-031: writes with prefixed key fugue:<dagId>:<runId>:<nodeId>", async () => {
    const redis = createMockRedis();
    const writer = createNamespacedCheckpointWriter(redis, "my-dag", "run-abc", undefined);

    const rid = runId("run-abc");
    const nid = nodeId("fetch-data");
    await writer.write(rid, nid, { result: 42 });

    expect(redis.store.get("fugue:my-dag:run-abc:fetch-data")).toBe(JSON.stringify({ result: 42 }));
  });

  test("write without TTL: no EX args", async () => {
    const redis = createMockRedis();
    const writer = createNamespacedCheckpointWriter(redis, "my-dag", "run-1", undefined);

    await writer.write(runId("run-1"), nodeId("node-a"), "data");

    expect(redis.calls[0]).toEqual({
      method: "set",
      args: ["fugue:my-dag:run-1:node-a", JSON.stringify("data")],
    });
  });

  test("FR-042: applies checkpoint TTL when configured", async () => {
    const redis = createMockRedis();
    const writer = createNamespacedCheckpointWriter(redis, "my-dag", "run-1", 3600);

    await writer.write(runId("run-1"), nodeId("node-a"), "data");

    expect(redis.calls[0]).toEqual({
      method: "set",
      args: ["fugue:my-dag:run-1:node-a", JSON.stringify("data"), "EX", "3600"],
    });
  });
});

// ── resolveTtl Tests ───────────────────────────────────────────────────────

describe("resolveTtl", () => {
  test("returns undefined when no TTL configured", () => {
    const dag = buildRegisteredDag("test-dag", {});
    const ttl = resolveTtl(dag);

    expect(ttl.cacheTtlSec).toBeUndefined();
    expect(ttl.checkpointTtlSec).toBeUndefined();
  });

  test("converts ms to seconds (ceiling)", () => {
    const dag = buildRegisteredDag("test-dag", {
      cacheTtlMs: 60_000,
      checkpointTtlMs: 3_600_000,
    });
    const ttl = resolveTtl(dag);

    expect(ttl.cacheTtlSec).toBe(60);
    expect(ttl.checkpointTtlSec).toBe(3600);
  });

  test("rounds up fractional seconds", () => {
    const dag = buildRegisteredDag("test-dag", {
      cacheTtlMs: 1500, // 1.5s -> ceil to 2
      checkpointTtlMs: 2999, // 2.999s -> ceil to 3
    });
    const ttl = resolveTtl(dag);

    expect(ttl.cacheTtlSec).toBe(2);
    expect(ttl.checkpointTtlSec).toBe(3);
  });
});

// ── createNodeContextForDag (Integration) ──────────────────────────────────

describe("createNodeContextForDag", () => {
  test("FR-032: creates context with given runId and signal", () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("my-dag");
    const rid = runId("run-123");
    const controller = new AbortController();

    const ctx = createNodeContextForDag(shared, dag, rid, controller.signal);

    expect(ctx.runId as string).toBe("run-123");
    expect(ctx.signal).toBe(controller.signal);
  });

  test("shared infra: LLM and tracer are same reference", () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("my-dag");
    const rid = runId("run-123");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);

    expect(ctx.llm).toBe(shared.llm);
    expect(ctx.tracer).toBe(shared.tracer);
  });

  test("dagId is set correctly on context", () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("alpha-dag");
    const rid = runId("run-1");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);

    expect(ctx.dagId as string).toBe("alpha-dag");
  });

  test("cache adapter is namespaced — writes go through prefixed key", async () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("my-dag");
    const rid = runId("run-1");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);
    await ctx.cache!.set("key-1", "value-1");

    expect(redis.store.has("fugue:my-dag:cache:key-1")).toBe(true);
  });

  test("checkpoint writer is namespaced — writes go through prefixed key", async () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("my-dag");
    const rid = runId("run-abc");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);
    await ctx.checkpointWriter!.write(rid, nodeId("step-1"), { done: true });

    expect(redis.store.has("fugue:my-dag:run-abc:step-1")).toBe(true);
  });

  test("SC-008: two DAGs with same cache key — entries are isolated", async () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dagA = buildRegisteredDag("dag-alpha");
    const dagB = buildRegisteredDag("dag-beta");
    const signal = new AbortController().signal;

    const ctxA = createNodeContextForDag(shared, dagA, runId("run-1"), signal);
    const ctxB = createNodeContextForDag(shared, dagB, runId("run-2"), signal);

    // Both use same logical key "shared-key"
    await ctxA.cache!.set("shared-key", "alpha-value");
    await ctxB.cache!.set("shared-key", "beta-value");

    // Each sees only their own value
    const resultA = await ctxA.cache!.get("shared-key");
    const resultB = await ctxB.cache!.get("shared-key");

    expect(resultA).toEqual({ hit: true, value: "alpha-value" });
    expect(resultB).toEqual({ hit: true, value: "beta-value" });

    // Underlying Redis has two distinct keys
    expect(redis.store.size).toBe(2);
    expect(redis.store.has("fugue:dag-alpha:cache:shared-key")).toBe(true);
    expect(redis.store.has("fugue:dag-beta:cache:shared-key")).toBe(true);
  });

  test("FR-042: per-DAG cache TTL applied when set is called without explicit TTL", async () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("ttl-dag", { cacheTtlMs: 120_000 });
    const rid = runId("run-1");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);
    await ctx.cache!.set("item", "val");

    // Should have EX 120 (120000ms -> 120s)
    const setCall = redis.calls.find((c) => c.method === "set");
    expect(setCall!.args).toEqual([
      "fugue:ttl-dag:cache:item",
      JSON.stringify("val"),
      "EX",
      "120",
    ]);
  });

  test("FR-042: per-DAG checkpoint TTL applied", async () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("ttl-dag", { checkpointTtlMs: 86_400_000 });
    const rid = runId("run-1");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);
    await ctx.checkpointWriter!.write(rid, nodeId("node-x"), "checkpoint-data");

    const setCall = redis.calls.find((c) => c.method === "set");
    expect(setCall!.args).toEqual([
      "fugue:ttl-dag:run-1:node-x",
      JSON.stringify("checkpoint-data"),
      "EX",
      "86400",
    ]);
  });

  test("FR-032: different invocations get independent signals", () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis);
    const dag = buildRegisteredDag("my-dag");

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const ctx1 = createNodeContextForDag(shared, dag, runId("run-1"), controller1.signal);
    const ctx2 = createNodeContextForDag(shared, dag, runId("run-2"), controller2.signal);

    // Aborting one does not affect the other
    controller1.abort();
    expect(ctx1.signal!.aborted).toBe(true);
    expect(ctx2.signal!.aborted).toBe(false);
  });

  test("contentFilter is passed through from shared infra", () => {
    const redis = createMockRedis();
    const filter = (s: string) => s.replace(/secret/g, "***");
    const shared: SharedInfra = {
      llm: noopLlm,
      redis,
      tracer: noopTracer,
      contentFilter: filter,
    };
    const dag = buildRegisteredDag("my-dag");
    const rid = runId("run-1");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);

    expect(ctx.contentFilter).toBe(filter);
  });

  test("contentFilter null is handled correctly", () => {
    const redis = createMockRedis();
    const shared = buildSharedInfra(redis); // contentFilter: null
    const dag = buildRegisteredDag("my-dag");
    const rid = runId("run-1");
    const signal = new AbortController().signal;

    const ctx = createNodeContextForDag(shared, dag, rid, signal);

    expect(ctx.contentFilter).toBeNull();
  });
});
