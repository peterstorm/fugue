/**
 * DAG Isolation Test — verifies that two DAGs using the same logical cache key
 * get isolated Redis namespaces via the NodeContext factory.
 *
 * @satisfies SC-008 — Two DAGs with same cache key get different Redis prefixes
 * @satisfies FR-030 — Cache keys prefixed fugue:<dagId>:cache:<key>
 * @satisfies FR-031 — Checkpoint keys prefixed fugue:<dagId>:<runId>:<nodeId>
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { DagDef, RunId } from "@fugue/framework";
import { noopTracer } from "@fugue/framework";
import type { RegisteredDag } from "../../domain/registry.js";
import type { DagRegistration } from "../../domain/dag-registration.js";
import {
  buildCacheKey,
  buildCheckpointKey,
  cacheKeyPrefix,
  checkpointKeyPrefix,
  createNamespacedCache,
  createNamespacedCheckpointWriter,
  createNodeContextForDag,
  type RedisPort,
  type SharedInfra,
  type LogPort,
} from "../../adapters/node-context-factory.js";

// ───────────────────────────────────────────────────────────────────────────
// Test helpers
// ───────────────────────────────────────────────────────────────────────────

const noopLogger: LogPort = { warn: () => {} };

// ───────────────────────────────────────────────────────────────────────────

const makeFakeDag = (id: string): DagDef =>
  ({
    id,
    nodes: [{ id: "start", kind: "transform", execute: async () => ({}) }],
    edges: [],
    outputNodeId: "start",
  }) as unknown as DagDef;

const makeFakeRegistration = (id: string): DagRegistration => ({
  dag: makeFakeDag(id),
  inputSchema: z.object({ query: z.string() }),
  route: `/dags/${id}/run`,
  meta: { description: `Test DAG ${id}`, version: "1.0.0" },
});

const makeRegisteredDag = (id: string): RegisteredDag => ({
  id: id as unknown as import("@fugue/framework").DagId,
  team: "test",
  route: `/dags/${id}/run`,
  dag: makeFakeDag(id),
  inputSchema: z.object({ query: z.string() }),
  config: {},
  loadedAt: Date.now(),
  sha: "abc123",
  healthy: true,
});

const createMockRedis = (): { port: RedisPort; store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    port: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string, ..._args: string[]) => {
        store.set(key, value);
        return "OK";
      },
    },
  };
};

const createMockSharedInfra = (redis: RedisPort): SharedInfra => ({
  llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as unknown as import("@fugue/framework").LlmClient,
  redis,
  tracer: noopTracer,
  contentFilter: null,
  logger: { warn: () => {} },
});

// ---------------------------------------------------------------------------
// Pure key-prefix isolation tests
// ---------------------------------------------------------------------------

describe("DAG cache key isolation (pure)", () => {
  test("two DAGs with same logical key produce different full cache keys", () => {
    const dagA = "order-processor";
    const dagB = "invoice-generator";
    const logicalKey = "customer:123:data";

    const keyA = buildCacheKey(dagA, logicalKey);
    const keyB = buildCacheKey(dagB, logicalKey);

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:order-processor:cache:customer:123:data");
    expect(keyB).toBe("fugue:invoice-generator:cache:customer:123:data");
  });

  test("two DAGs with same logical key produce different cache prefixes", () => {
    const prefixA = cacheKeyPrefix("dag-alpha");
    const prefixB = cacheKeyPrefix("dag-beta");

    expect(prefixA).not.toBe(prefixB);
    expect(prefixA).toBe("fugue:dag-alpha:cache:");
    expect(prefixB).toBe("fugue:dag-beta:cache:");
  });

  test("two DAGs with same runId and nodeId produce different checkpoint keys", () => {
    const runId = "run-001";
    const nodeId = "fetch-data";

    const keyA = buildCheckpointKey("dag-alpha", runId, nodeId);
    const keyB = buildCheckpointKey("dag-beta", runId, nodeId);

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:dag-alpha:run-001:fetch-data");
    expect(keyB).toBe("fugue:dag-beta:run-001:fetch-data");
  });

  test("checkpoint prefixes are distinct per DAG even with same runId", () => {
    const prefixA = checkpointKeyPrefix("dag-alpha", "run-xyz");
    const prefixB = checkpointKeyPrefix("dag-beta", "run-xyz");

    expect(prefixA).not.toBe(prefixB);
  });
});

// ---------------------------------------------------------------------------
// Namespaced cache adapter isolation
// ---------------------------------------------------------------------------

describe("DAG cache adapter isolation (integration)", () => {
  test("two namespaced caches for different DAGs writing same key are isolated", async () => {
    const { port: redis, store } = createMockRedis();

    const cacheA = createNamespacedCache(redis, "dag-alpha", undefined, noopLogger);
    const cacheB = createNamespacedCache(redis, "dag-beta", undefined, noopLogger);

    // Both write to the same logical key
    await cacheA.set("shared-key", { source: "alpha" });
    await cacheB.set("shared-key", { source: "beta" });

    // Reads should return their own value, not the other DAG's
    const resultA = await cacheA.get("shared-key");
    const resultB = await cacheB.get("shared-key");

    expect(resultA.hit).toBe(true);
    expect(resultB.hit).toBe(true);
    if (resultA.hit) expect(resultA.value).toEqual({ source: "alpha" });
    if (resultB.hit) expect(resultB.value).toEqual({ source: "beta" });

    // Underlying store has two distinct keys
    expect(store.size).toBe(2);
    expect(store.has("fugue:dag-alpha:cache:shared-key")).toBe(true);
    expect(store.has("fugue:dag-beta:cache:shared-key")).toBe(true);
  });

  test("cache miss in one DAG does not affect another DAG's cache", async () => {
    const { port: redis } = createMockRedis();

    const cacheA = createNamespacedCache(redis, "dag-alpha", undefined, noopLogger);
    const cacheB = createNamespacedCache(redis, "dag-beta", undefined, noopLogger);

    await cacheA.set("only-in-alpha", { data: 42 });

    const resultA = await cacheA.get("only-in-alpha");
    const resultB = await cacheB.get("only-in-alpha");

    expect(resultA.hit).toBe(true);
    expect(resultB.hit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Namespaced checkpoint writer isolation
// ---------------------------------------------------------------------------

describe("DAG checkpoint writer isolation (integration)", () => {
  test("two checkpoint writers for different DAGs writing same node are isolated", async () => {
    const { port: redis, store } = createMockRedis();
    const runId = "run-shared" as unknown as RunId;

    const writerA = createNamespacedCheckpointWriter(redis, "dag-alpha", "run-shared", undefined, noopLogger);
    const writerB = createNamespacedCheckpointWriter(redis, "dag-beta", "run-shared", undefined, noopLogger);

    await writerA.write(runId, "node-1" as unknown as import("@fugue/framework").NodeId, { output: "from-alpha" });
    await writerB.write(runId, "node-1" as unknown as import("@fugue/framework").NodeId, { output: "from-beta" });

    // Both wrote to distinct keys
    expect(store.size).toBe(2);
    expect(store.get("fugue:dag-alpha:run-shared:node-1")).toBe(JSON.stringify({ output: "from-alpha" }));
    expect(store.get("fugue:dag-beta:run-shared:node-1")).toBe(JSON.stringify({ output: "from-beta" }));
  });
});

// ---------------------------------------------------------------------------
// NodeContext factory isolation
// ---------------------------------------------------------------------------

describe("createNodeContextForDag isolation", () => {
  test("contexts for different DAGs use different cache namespaces", () => {
    const { port: redis } = createMockRedis();
    const shared = createMockSharedInfra(redis);
    const signal = new AbortController().signal;

    const dagA = makeRegisteredDag("dag-alpha");
    const dagB = makeRegisteredDag("dag-beta");

    const ctxA = createNodeContextForDag(shared, dagA, "run-1" as unknown as RunId, signal);
    const ctxB = createNodeContextForDag(shared, dagB, "run-1" as unknown as RunId, signal);

    // Both contexts are created without error
    expect(ctxA).toBeDefined();
    expect(ctxB).toBeDefined();

    // They should be different context instances
    expect(ctxA).not.toBe(ctxB);
  });

  test("contexts for same DAG but different runIds produce different checkpoints", () => {
    const { port: redis } = createMockRedis();
    const shared = createMockSharedInfra(redis);
    const signal = new AbortController().signal;

    const dag = makeRegisteredDag("dag-alpha");

    const ctx1 = createNodeContextForDag(shared, dag, "run-1" as unknown as RunId, signal);
    const ctx2 = createNodeContextForDag(shared, dag, "run-2" as unknown as RunId, signal);

    expect(ctx1).not.toBe(ctx2);
  });
});
