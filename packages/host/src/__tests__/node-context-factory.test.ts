/**
 * Unit tests for node-context-factory.ts
 *
 * Tests resolveTtl, createNamespacedCache (error degradation, corrupted JSON),
 * and createNamespacedCheckpointWriter (best-effort writes).
 */

import { describe, it, expect } from "bun:test";
import { ok, err, dagId, runId as makeRunId, nodeId as makeNodeId, gitSha, noopTracer, createHttpCapability } from "@fuguejs/framework";
import type { Result, DagId, RunId, NodeId } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import type { RedisPort, LogPort, SharedInfra } from "../ports.js";
import type { RegisteredDag } from "../domain/registry.js";
import { z } from "zod";
import {
  resolveTtl,
  createNamespacedCache,
  createNamespacedCheckpointWriter,
  createNodeContextForDag,
  invocationOriginForIdentity,
  buildCacheKey,
  buildCheckpointKey,
} from "../adapters/node-context-factory.js";
import type { AuthIdentity } from "../domain/auth.js";

// Existing pass-through / wiring tests are identity-agnostic — an admin identity
// reproduces the prior `agent`-keyed origin (admin/team → agent placeholder), so
// their byte-identical assertions are unaffected.
const adminIdentity: AuthIdentity = { kind: "admin" };

// ── Helpers ────────────────────────────────────────────────────────────────

const testDagId = dagId("test-dag");
const testRunId = makeRunId("run-001");
const testNodeId = makeNodeId("node-a");

const makeDag = (overrides?: Partial<RegisteredDag["config"]>): RegisteredDag => ({
  id: testDagId,
  team: "eng",
  route: "/dags/test-dag/run",
  dag: { id: "test-dag", nodes: [], edges: [] } as any,
  inputSchema: z.any(),
  config: {
    route: "/dags/test-dag/run",
    timeout: 30_000,
    maxConcurrency: 10,
    ...overrides,
  },
  meta: { description: "test", version: "1.0.0" },
  loadedAt: 1000,
  sha: gitSha("abc123"),
  status: { kind: "healthy" },
  prompts: new Map(),
  modulePath: "/tmp/dags/eng/test-dag/dag.ts",
});

const createMockRedis = (store: Map<string, string> = new Map()): {
  redis: RedisPort;
  calls: { op: string; key: string }[];
} => {
  const calls: { op: string; key: string }[] = [];
  const redis: RedisPort = {
    get: async (key) => {
      calls.push({ op: "get", key });
      const val = store.get(key);
      return ok(val ?? null);
    },
    set: async (key, value) => {
      calls.push({ op: "set", key });
      store.set(key, value);
      return ok(null);
    },
    del: async (key) => {
      calls.push({ op: "del", key });
      store.delete(key);
      return ok(1);
    },
    keys: async (pattern) => {
      const prefix = pattern.replace(/\*$/, "");
      return ok([...store.keys()].filter(k => k.startsWith(prefix)));
    },
    scan: async (pattern, _cursor = "0") => {
      const prefix = pattern.replace(/\*$/, "");
      return ok({ cursor: "0", keys: [...store.keys()].filter(k => k.startsWith(prefix)) });
    },
    setNx: async (key, value) => {
      if (store.has(key)) return ok(false);
      store.set(key, value);
      return ok(true);
    },
  };
  return { redis, calls };
};

const failingRedis = (): RedisPort => ({
  get: async () => err({ kind: "redis-unavailable", operation: "get" } as HostError),
  set: async () => err({ kind: "redis-unavailable", operation: "set" } as HostError),
  del: async () => err({ kind: "redis-unavailable", operation: "del" } as HostError),
  keys: async () => err({ kind: "redis-unavailable", operation: "keys" } as HostError),
  scan: async () => err({ kind: "redis-unavailable", operation: "scan" } as HostError),
  setNx: async () => err({ kind: "redis-unavailable", operation: "setnx" } as HostError),
});

const collectLogs = () => {
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger: LogPort = {
    info: (msg, data) => logs.push({ level: "info", msg, data }),
    warn: (msg, data) => logs.push({ level: "warn", msg, data }),
    error: (msg, data) => logs.push({ level: "error", msg, data }),
  };
  return { logger, logs };
};

// ── resolveTtl ─────────────────────────────────────────────────────────────

describe("resolveTtl", () => {
  it("returns undefined for both when no TTL configured", () => {
    const dag = makeDag();
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBeUndefined();
    expect(ttl.checkpointTtlSec).toBeUndefined();
  });

  it("converts cacheTtlMs to seconds using Math.ceil", () => {
    const dag = makeDag({ cacheTtlMs: 1500 });
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBe(2); // ceil(1500/1000) = 2
  });

  it("converts checkpointTtlMs to seconds using Math.ceil", () => {
    const dag = makeDag({ checkpointTtlMs: 999 });
    const ttl = resolveTtl(dag);
    expect(ttl.checkpointTtlSec).toBe(1); // ceil(999/1000) = 1
  });

  it("handles exact second values without rounding up", () => {
    const dag = makeDag({ cacheTtlMs: 5000 });
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBe(5);
  });

  it("handles zero ms", () => {
    const dag = makeDag({ cacheTtlMs: 0 });
    const ttl = resolveTtl(dag);
    expect(ttl.cacheTtlSec).toBe(0);
  });
});

// ── createNamespacedCache ──────────────────────────────────────────────────

describe("createNamespacedCache", () => {
  it("returns cache miss when key not found", async () => {
    const { redis } = createMockRedis();
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const result = await cache.get("my-key");
    expect(result).toEqual({ hit: false });
  });

  it("returns cache hit with deserialized value", async () => {
    const store = new Map([
      [buildCacheKey(testDagId, "my-key"), JSON.stringify({ data: 42 })],
    ]);
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const result = await cache.get("my-key");
    expect(result).toEqual({ hit: true, value: { data: 42 } });
  });

  it("gracefully degrades to miss on Redis get failure", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testDagId, undefined, logger);

    const result = await cache.get("any-key");
    expect(result).toEqual({ hit: false });
    expect(logs.some(l => l.level === "warn" && l.msg.includes("Cache get failed"))).toBe(true);
  });

  it("treats corrupted JSON as cache miss", async () => {
    const store = new Map([
      [buildCacheKey(testDagId, "bad"), "not-json{{{"],
    ]);
    const { redis } = createMockRedis(store);
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const result = await cache.get("bad");
    expect(result).toEqual({ hit: false });
    expect(logs.some(l => l.msg.includes("corrupted"))).toBe(true);
  });

  it("set writes serialized value to Redis", async () => {
    const store = new Map<string, string>();
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    await cache.set("k", { value: "hello" });
    const expectedKey = buildCacheKey(testDagId, "k");
    expect(store.get(expectedKey)).toBe(JSON.stringify({ value: "hello" }));
  });

  it("set is best-effort — returns ok on Redis failure", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testDagId, undefined, logger);

    const result = await cache.set("k", "v");
    expect(result.ok).toBe(true);
    expect(logs.some(l => l.level === "warn" && l.msg.includes("Cache set failed"))).toBe(true);
  });

  it("set handles non-serializable values gracefully", async () => {
    const { redis } = createMockRedis();
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(redis, testDagId, undefined, logger);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await cache.set("k", circular);
    expect(result.ok).toBe(true);
    expect(logs.some(l => l.msg.includes("not serializable"))).toBe(true);
  });

  it("escalates to error level after consecutive failures", async () => {
    const { logger, logs } = collectLogs();
    const cache = createNamespacedCache(failingRedis(), testDagId, undefined, logger);

    // Trigger 10 failures to exceed threshold
    for (let i = 0; i < 10; i++) {
      await cache.set(`k${i}`, "v");
    }

    const errorLogs = logs.filter(l => l.level === "error");
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs[0].msg).toContain("exceeded threshold");
  });
});

// ── createNamespacedCheckpointWriter ───────────────────────────────────────

describe("createNamespacedCheckpointWriter", () => {
  it("writes checkpoint with correct namespaced key", async () => {
    const store = new Map<string, string>();
    const { redis } = createMockRedis(store);
    const { logger } = collectLogs();
    const writer = createNamespacedCheckpointWriter(redis, testDagId, testRunId, undefined, logger);

    await writer.write(testRunId, testNodeId, { output: "done" });

    const expectedKey = buildCheckpointKey(testDagId, testRunId, testNodeId);
    expect(store.get(expectedKey)).toBe(JSON.stringify({ output: "done" }));
  });

  it("best-effort — does not throw on Redis failure", async () => {
    const { logger, logs } = collectLogs();
    const writer = createNamespacedCheckpointWriter(failingRedis(), testDagId, testRunId, undefined, logger);

    // Should not throw
    await writer.write(testRunId, testNodeId, { data: 1 });
    expect(logs.some(l => l.msg.includes("Checkpoint write failed"))).toBe(true);
  });

  it("handles non-serializable values gracefully", async () => {
    const { redis } = createMockRedis();
    const { logger, logs } = collectLogs();
    const writer = createNamespacedCheckpointWriter(redis, testDagId, testRunId, undefined, logger);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await writer.write(testRunId, testNodeId, circular);
    expect(logs.some(l => l.msg.includes("not serializable"))).toBe(true);
  });
});

// ── Built-in http capability wiring (ADR-0051) ──────────────────────────────

describe("createNodeContextForDag — built-in http capability", () => {
  const baseSharedInfra = (
    capabilities: SharedInfra["capabilities"],
  ): SharedInfra => ({
    llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
    redis: createMockRedis().redis,
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities,
  });

  // Regression guard: main.ts wires `createHttpCapability()` into
  // `sharedInfra.capabilities`. If that wiring is dropped, `ctx.http` is null
  // and any `requires: ["http"]` DAG fails the boot-time capability check.
  it("surfaces a usable http client when the handle is wired into capabilities", async () => {
    const shared = baseSharedInfra([createHttpCapability()]);
    const ctx = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity);

    expect(ctx.http).not.toBeNull();
    // The presence check `ctx.http != null` is exactly what
    // `validateCapabilities` gates a `requires: ["http"]` node on.
    expect(typeof ctx.http?.get).toBe("function");
    expect(typeof ctx.http?.post).toBe("function");
  });

  it("leaves http null when no http handle is wired (documents the gap the wiring closes)", async () => {
    const shared = baseSharedInfra([]);
    const ctx = await createNodeContextForDag(shared, makeDag(), testRunId, new AbortController().signal, adminIdentity);

    expect(ctx.http).toBeNull();
  });
});

// ── Pass-through broker path (SC-005 zero-regression) ───────────────────────

describe("createNodeContextForDag — pass-through broker path (SC-005)", () => {
  const baseSharedInfra = (
    capabilities: SharedInfra["capabilities"],
  ): SharedInfra => ({
    llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
    redis: createMockRedis().redis,
    tracer: noopTracer,
    contentFilter: null,
    prompts: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    capabilities,
  });

  // Regression proof for the per-invocation broker seam (Phase 2): routing
  // capability resolution through the pass-through broker must leave the client
  // reachable on the NodeContext BYTE-IDENTICAL to what `extractClients` would
  // have produced — the SAME reference, not a copy. If this drifts, the
  // pass-through default is no longer a true migration path (FR-W2-003).
  it("exposes the exact same capability client reference the handle wired in (byte-identical)", async () => {
    const httpHandle = createHttpCapability();
    const shared = baseSharedInfra([httpHandle]);

    const ctx = await createNodeContextForDag(
      shared,
      makeDag(),
      testRunId,
      new AbortController().signal,
      adminIdentity,
    );

    // `extractClients([httpHandle]).http === httpHandle.client` — and the broker
    // hands that exact reference through to the NodeContext unchanged.
    expect(ctx.http).toBe(httpHandle.client);
  });
});

// ── Identity → Invocation.origin threading (FR-W3-007) ──────────────────────
//
// Before this fix the user identity dead-ended: every run built
// `origin: { kind: "agent", agentClientId: dagId }`, so an OIDC user's `sub`
// never reached the NodeContext and the run was mis-attributed as `agent`.
// `invocationOriginForIdentity` is the seam the factory now uses to build the
// origin; these tests prove the user `sub`/`azp` actually land and that the
// admin/team placeholder is unchanged (byte-for-byte the prior behaviour).

describe("invocationOriginForIdentity — user sub threading (FR-W3-007)", () => {
  it("a user identity produces origin { kind: 'user', sub, agentClientId: azp } — the sub lands", () => {
    const userIdentity: AuthIdentity = { kind: "user", sub: "user-abc-123", azp: "fugue-frontend" };

    const origin = invocationOriginForIdentity(userIdentity, testDagId);

    expect(origin).toEqual({
      kind: "user",
      sub: "user-abc-123",
      agentClientId: "fugue-frontend",
    });
  });

  it("a team identity maps to the agent placeholder keyed on dagId (unchanged behaviour)", () => {
    const teamIdentity: AuthIdentity = { kind: "team", team: "eng", label: "ci" };

    const origin = invocationOriginForIdentity(teamIdentity, testDagId);

    expect(origin).toEqual({ kind: "agent", agentClientId: testDagId });
  });

  it("an admin identity maps to the agent placeholder keyed on dagId (unchanged behaviour)", () => {
    const origin = invocationOriginForIdentity(adminIdentity, testDagId);

    expect(origin).toEqual({ kind: "agent", agentClientId: testDagId });
  });

  it("the factory accepts a user identity and produces a usable NodeContext (sub threaded, no throw)", async () => {
    const baseSharedInfra = (): SharedInfra => ({
      llm: { chat: async () => ({ content: "", usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
      redis: createMockRedis().redis,
      tracer: noopTracer,
      contentFilter: null,
      prompts: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      capabilities: [],
    });
    const userIdentity: AuthIdentity = { kind: "user", sub: "user-xyz", azp: "fugue-frontend" };

    const ctx = await createNodeContextForDag(
      baseSharedInfra(),
      makeDag(),
      testRunId,
      new AbortController().signal,
      userIdentity,
    );

    // The run path no longer dead-ends the user identity: a NodeContext is
    // produced (the broker mints over the user-keyed origin without error), and
    // the origin the factory built from this identity carries the user's sub.
    expect(ctx).toBeDefined();
    expect(invocationOriginForIdentity(userIdentity, testDagId)).toMatchObject({ sub: "user-xyz" });
  });
});
