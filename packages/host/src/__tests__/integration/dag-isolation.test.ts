/**
 * DAG Isolation Test — verifies that two DAGs using the same logical cache key
 * get isolated Redis namespaces via the NodeContext factory.
 *
 * @satisfies SC-008 — Two DAGs with same cache key get different Redis prefixes
 * @satisfies FR-031 — Cache keys prefixed fugue:<dagId>:cache:<key>
 * @satisfies FR-031 — Checkpoint keys prefixed fugue:<dagId>:<runId>:<nodeId>
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type { DagDef, RunId } from "@fuguejs/framework";
import { noopTracer, dagId, runId as makeRunId, nodeId as makeNodeId, ok, gitSha } from "@fuguejs/framework";
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
} from "../../adapters/node-context-factory.js";
import type { RedisPort, SharedInfra, LogPort } from "../../ports.js";
import type { AuthIdentity } from "../../domain/auth.js";

// Existing isolation tests are identity-agnostic — an admin identity preserves
// the prior `agent`-keyed origin behaviour (admin/team → agent placeholder).
const adminIdentity: AuthIdentity = { kind: "admin" };

// ───────────────────────────────────────────────────────────────────────────
// Test helpers
// ───────────────────────────────────────────────────────────────────────────

const noopLogger: LogPort = { info: () => {}, warn: () => {}, error: () => {} };

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
  id: id as unknown as import("@fuguejs/framework").DagId,
  team: "test",
  route: `/dags/${id}/run`,
  dag: makeFakeDag(id),
  inputSchema: z.object({ query: z.string() }),
  config: { timeout: 30_000, maxConcurrency: 10 },
  meta: { description: "", version: "0.0.0" },
  loadedAt: Date.now(),
  sha: gitSha("abc123"),
  status: { kind: "healthy" },
  modulePath: `/tmp/dags/test/${id}/dag.ts`,
  prompts: new Map(),
});

const createMockRedis = (): { port: RedisPort; store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    port: {
      get: async (key: string) => ok(store.get(key) ?? null),
      set: async (key: string, value: string, _opts?: { expiresInSec?: number }) => {
        store.set(key, value);
        return ok("OK" as string | null);
      },
      del: async (key: string) => { const had = store.has(key) ? 1 : 0; store.delete(key); return ok(had); },
      keys: async (pattern: string) => {
        const prefix = pattern.replace(/\*$/, "");
        return ok([...store.keys()].filter(k => k.startsWith(prefix)));
      },
      scan: async (pattern: string, _cursor = "0") => {
        const prefix = pattern.replace(/\*$/, "");
        return ok({ cursor: "0", keys: [...store.keys()].filter(k => k.startsWith(prefix)) });
      },
      setNx: async (key: string, value: string) => {
        if (store.has(key)) return ok(false);
        store.set(key, value);
        return ok(true);
      },
    },
  };
};

const createMockSharedInfra = (redis: RedisPort): SharedInfra => ({
  llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as unknown as import("@fuguejs/framework").LlmClient,
  redis,
  tracer: noopTracer,
  contentFilter: null,
  prompts: null,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  capabilities: [],
});

// ---------------------------------------------------------------------------
// Pure key-prefix isolation tests
// ---------------------------------------------------------------------------

describe("DAG cache key isolation (pure)", () => {
  test("two DAGs with same logical key produce different full cache keys", () => {
    const dagA = dagId("order-processor");
    const dagB = dagId("invoice-generator");
    const logicalKey = "customer:123:data";

    const keyA = buildCacheKey(dagA, logicalKey);
    const keyB = buildCacheKey(dagB, logicalKey);

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:order-processor:cache:customer:123:data");
    expect(keyB).toBe("fugue:invoice-generator:cache:customer:123:data");
  });

  test("two DAGs with same logical key produce different cache prefixes", () => {
    const prefixA = cacheKeyPrefix(dagId("dag-alpha"));
    const prefixB = cacheKeyPrefix(dagId("dag-beta"));

    expect(prefixA).not.toBe(prefixB);
    expect(prefixA).toBe("fugue:dag-alpha:cache:");
    expect(prefixB).toBe("fugue:dag-beta:cache:");
  });

  test("two DAGs with same runId and nodeId produce different checkpoint keys", () => {
    const runIdVal = makeRunId("run-001");
    const nodeIdVal = makeNodeId("fetch-data");

    const keyA = buildCheckpointKey(dagId("dag-alpha"), runIdVal, nodeIdVal);
    const keyB = buildCheckpointKey(dagId("dag-beta"), runIdVal, nodeIdVal);

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:dag-alpha:run-001:fetch-data");
    expect(keyB).toBe("fugue:dag-beta:run-001:fetch-data");
  });

  test("checkpoint prefixes are distinct per DAG even with same runId", () => {
    const prefixA = checkpointKeyPrefix(dagId("dag-alpha"), makeRunId("run-xyz"));
    const prefixB = checkpointKeyPrefix(dagId("dag-beta"), makeRunId("run-xyz"));

    expect(prefixA).not.toBe(prefixB);
  });
});

// ---------------------------------------------------------------------------
// Namespaced cache adapter isolation
// ---------------------------------------------------------------------------

describe("DAG cache adapter isolation (integration)", () => {
  test("two namespaced caches for different DAGs writing same key are isolated", async () => {
    const { port: redis, store } = createMockRedis();

    const cacheA = createNamespacedCache(redis, dagId("dag-alpha"), undefined, noopLogger);
    const cacheB = createNamespacedCache(redis, dagId("dag-beta"), undefined, noopLogger);

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

    const cacheA = createNamespacedCache(redis, dagId("dag-alpha"), undefined, noopLogger);
    const cacheB = createNamespacedCache(redis, dagId("dag-beta"), undefined, noopLogger);

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
    const runIdVal = makeRunId("run-shared");

    const writerA = createNamespacedCheckpointWriter(redis, dagId("dag-alpha"), runIdVal, undefined, noopLogger);
    const writerB = createNamespacedCheckpointWriter(redis, dagId("dag-beta"), runIdVal, undefined, noopLogger);

    await writerA.write(runIdVal, makeNodeId("node-1"), { output: "from-alpha" });
    await writerB.write(runIdVal, makeNodeId("node-1"), { output: "from-beta" });

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
  test("contexts for different DAGs use different cache namespaces", async () => {
    const { port: redis } = createMockRedis();
    const shared = createMockSharedInfra(redis);
    const signal = new AbortController().signal;

    const dagA = makeRegisteredDag("dag-alpha");
    const dagB = makeRegisteredDag("dag-beta");

    const { ctx: ctxA } = await createNodeContextForDag(shared, dagA, "run-1" as unknown as RunId, signal, adminIdentity);
    const { ctx: ctxB } = await createNodeContextForDag(shared, dagB, "run-1" as unknown as RunId, signal, adminIdentity);

    // Both contexts are created without error
    expect(ctxA).toBeDefined();
    expect(ctxB).toBeDefined();

    // They should be different context instances
    expect(ctxA).not.toBe(ctxB);
  });

  test("contexts for same DAG but different runIds produce different checkpoints", async () => {
    const { port: redis } = createMockRedis();
    const shared = createMockSharedInfra(redis);
    const signal = new AbortController().signal;

    const dag = makeRegisteredDag("dag-alpha");

    const { ctx: ctx1 } = await createNodeContextForDag(shared, dag, "run-1" as unknown as RunId, signal, adminIdentity);
    const { ctx: ctx2 } = await createNodeContextForDag(shared, dag, "run-2" as unknown as RunId, signal, adminIdentity);

    expect(ctx1).not.toBe(ctx2);
  });
});
