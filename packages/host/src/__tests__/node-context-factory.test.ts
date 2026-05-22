/**
 * Unit tests for node-context-factory.ts
 *
 * Tests resolveTtl, createNamespacedCache (error degradation, corrupted JSON),
 * and createNamespacedCheckpointWriter (best-effort writes).
 */

import { describe, it, expect } from "bun:test";
import { ok, err, dagId, runId as makeRunId, nodeId as makeNodeId, gitSha } from "@fugue/framework";
import type { Result, DagId, RunId, NodeId } from "@fugue/framework";
import type { HostError } from "../domain/host-error.js";
import type { RedisPort, LogPort } from "../ports.js";
import type { RegisteredDag } from "../domain/registry.js";
import { z } from "zod";
import {
  resolveTtl,
  createNamespacedCache,
  createNamespacedCheckpointWriter,
  buildCacheKey,
  buildCheckpointKey,
} from "../adapters/node-context-factory.js";

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
  };
  return { redis, calls };
};

const failingRedis = (): RedisPort => ({
  get: async () => err({ kind: "redis-unavailable", operation: "get" } as HostError),
  set: async () => err({ kind: "redis-unavailable", operation: "set" } as HostError),
  del: async () => err({ kind: "redis-unavailable", operation: "del" } as HostError),
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
