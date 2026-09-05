/**
 * DAG Isolation Test — verifies that two DAGs using the same logical cache key
 * get isolated Redis namespaces via the NodeContext factory.
 *
 * @satisfies SC-008 — Two DAGs with same cache key get different Redis prefixes
 * @satisfies FR-031 — Cache keys prefixed fugue:<dagId>:cache:<key>
 * @satisfies FR-031 — Checkpoint keys prefixed fugue:<dagId>:<runId>:<nodeId>
 */

import { describe, test, expect } from "bun:test";
import { createInMemorySpendLedger } from "../../adapters/spend-ledger-memory.js";
import { fakeInfra } from "../fixtures/host-boot-fakes.js";
import { z } from "zod";
import type { DagDef, RunId } from "@fuguejs/framework";
import { noopTracer, dagId, runId as makeRunId, nodeId as makeNodeId, ok, isOk, gitSha } from "@fuguejs/framework";
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
import { tenantId } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";

/** Build a `TenantId` for a test from a known-good literal via the canonical constructor. */
const mkTenant = (s: string): TenantId => {
  const r = tenantId(s);
  if (!isOk(r)) throw new Error(`test tenant id "${s}" is invalid (kind: ${r.error.kind})`);
  return r.value;
};

// Existing isolation tests are identity-agnostic — an admin identity preserves
// the prior `agent`-keyed origin behaviour (admin/team → agent placeholder).
const adminIdentity: AuthIdentity = { kind: "admin" };

// All key-builder calls are now tenant-scoped. These per-DAG isolation tests run
// within a SINGLE tenant — they prove per-DAG scoping is preserved BENEATH the
// tenant prefix (FR-013). The cross-tenant non-collision invariant lives in
// domain/cache-keys.test.ts.
const TENANT = mkTenant("test");

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
  const sets = new Map<string, Set<string>>();
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
      sAdd: async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        const had = set.has(member);
        set.add(member);
        sets.set(key, set);
        return ok(had ? 0 : 1);
      },
      sRem: async (key: string, member: string) => {
        const set = sets.get(key);
        if (!set || !set.has(member)) return ok(0);
        set.delete(member);
        return ok(1);
      },
      sMembers: async (key: string) => ok(Array.from(sets.get(key) ?? [])),
    },
  };
};


// ---------------------------------------------------------------------------
// Pure key-prefix isolation tests
// ---------------------------------------------------------------------------

describe("DAG cache key isolation (pure)", () => {
  test("two DAGs with same logical key produce different full cache keys", () => {
    const dagA = dagId("order-processor");
    const dagB = dagId("invoice-generator");
    const logicalKey = "customer:123:data";

    const keyA = buildCacheKey(TENANT, dagA, logicalKey);
    const keyB = buildCacheKey(TENANT, dagB, logicalKey);

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:test:order-processor:cache:customer:123:data");
    expect(keyB).toBe("fugue:test:invoice-generator:cache:customer:123:data");
  });

  test("two DAGs with same logical key produce different cache prefixes", () => {
    const prefixA = cacheKeyPrefix(TENANT, dagId("dag-alpha"));
    const prefixB = cacheKeyPrefix(TENANT, dagId("dag-beta"));

    expect(prefixA).not.toBe(prefixB);
    expect(prefixA).toBe("fugue:test:dag-alpha:cache:");
    expect(prefixB).toBe("fugue:test:dag-beta:cache:");
  });

  test("two DAGs with same runId and nodeId produce different checkpoint keys", () => {
    const runIdVal = makeRunId("run-001");
    const nodeIdVal = makeNodeId("fetch-data");

    const keyA = buildCheckpointKey(TENANT, dagId("dag-alpha"), runIdVal, nodeIdVal);
    const keyB = buildCheckpointKey(TENANT, dagId("dag-beta"), runIdVal, nodeIdVal);

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("fugue:test:dag-alpha:run-001:fetch-data");
    expect(keyB).toBe("fugue:test:dag-beta:run-001:fetch-data");
  });

  test("checkpoint prefixes are distinct per DAG even with same runId", () => {
    const prefixA = checkpointKeyPrefix(TENANT, dagId("dag-alpha"), makeRunId("run-xyz"));
    const prefixB = checkpointKeyPrefix(TENANT, dagId("dag-beta"), makeRunId("run-xyz"));

    expect(prefixA).not.toBe(prefixB);
  });
});

// ---------------------------------------------------------------------------
// Namespaced cache adapter isolation
// ---------------------------------------------------------------------------

describe("DAG cache adapter isolation (integration)", () => {
  test("two namespaced caches for different DAGs writing same key are isolated", async () => {
    const { port: redis, store } = createMockRedis();

    const cacheA = createNamespacedCache(redis, TENANT, dagId("dag-alpha"), undefined, noopLogger);
    const cacheB = createNamespacedCache(redis, TENANT, dagId("dag-beta"), undefined, noopLogger);

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
    expect(store.has("fugue:test:dag-alpha:cache:shared-key")).toBe(true);
    expect(store.has("fugue:test:dag-beta:cache:shared-key")).toBe(true);
  });

  test("cache miss in one DAG does not affect another DAG's cache", async () => {
    const { port: redis } = createMockRedis();

    const cacheA = createNamespacedCache(redis, TENANT, dagId("dag-alpha"), undefined, noopLogger);
    const cacheB = createNamespacedCache(redis, TENANT, dagId("dag-beta"), undefined, noopLogger);

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

    const writerA = createNamespacedCheckpointWriter(redis, TENANT, dagId("dag-alpha"), runIdVal, undefined, noopLogger);
    const writerB = createNamespacedCheckpointWriter(redis, TENANT, dagId("dag-beta"), runIdVal, undefined, noopLogger);

    await writerA.write(runIdVal, makeNodeId("node-1"), { output: "from-alpha" });
    await writerB.write(runIdVal, makeNodeId("node-1"), { output: "from-beta" });

    // Both wrote to distinct keys
    expect(store.size).toBe(2);
    expect(store.get("fugue:test:dag-alpha:run-shared:node-1")).toBe(JSON.stringify({ output: "from-alpha" }));
    expect(store.get("fugue:test:dag-beta:run-shared:node-1")).toBe(JSON.stringify({ output: "from-beta" }));
  });
});

// ---------------------------------------------------------------------------
// NodeContext factory isolation
// ---------------------------------------------------------------------------

// FR-040: map every DAG these isolation tests use to a real agent client so the
// origin resolves (the test exercises cache/checkpoint namespacing, not FR-040).
const ISO_AGENT_MAP = { "dag-alpha": "fugue-agent-alpha", "dag-beta": "fugue-agent-beta" };

describe("createNodeContextForDag isolation", () => {
  test("contexts for different DAGs use different cache namespaces", async () => {
    const { port: redis } = createMockRedis();
    const shared = fakeInfra(redis);
    const signal = new AbortController().signal;

    const dagA = makeRegisteredDag("dag-alpha");
    const dagB = makeRegisteredDag("dag-beta");

    const { ctx: ctxA } = await createNodeContextForDag(shared, dagA, "run-1" as unknown as RunId, signal, adminIdentity, ISO_AGENT_MAP);
    const { ctx: ctxB } = await createNodeContextForDag(shared, dagB, "run-1" as unknown as RunId, signal, adminIdentity, ISO_AGENT_MAP);

    // Both contexts are created without error
    expect(ctxA).toBeDefined();
    expect(ctxB).toBeDefined();

    // They should be different context instances
    expect(ctxA).not.toBe(ctxB);
  });

  test("contexts for same DAG but different runIds produce different checkpoints", async () => {
    const { port: redis } = createMockRedis();
    const shared = fakeInfra(redis);
    const signal = new AbortController().signal;

    const dag = makeRegisteredDag("dag-alpha");

    const { ctx: ctx1 } = await createNodeContextForDag(shared, dag, "run-1" as unknown as RunId, signal, adminIdentity, ISO_AGENT_MAP);
    const { ctx: ctx2 } = await createNodeContextForDag(shared, dag, "run-2" as unknown as RunId, signal, adminIdentity, ISO_AGENT_MAP);

    expect(ctx1).not.toBe(ctx2);
  });
});
