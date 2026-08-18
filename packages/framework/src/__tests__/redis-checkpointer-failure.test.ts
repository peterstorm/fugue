/**
 * Redis connection failure path tests for RedisCheckpointer.
 * Verifies that IO exceptions from ioredis are wrapped into Result.err({kind: "cache-error"})
 * without propagating as unhandled rejections.
 */
import { describe, test, expect } from "bun:test";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import { dagId, nodeId, runId } from "../types/ids.js";

/** Mock ioredis that throws on all operations. */
const makeFailingRedis = (errorMsg: string) => ({
  get: () => { throw new Error(errorMsg); },
  set: () => { throw new Error(errorMsg); },
  hgetall: () => { throw new Error(errorMsg); },
  hset: () => { throw new Error(errorMsg); },
  hmset: () => { throw new Error(errorMsg); },
  evalsha: () => { throw new Error(errorMsg); },
  eval: () => { throw new Error(errorMsg); },
  script: () => { throw new Error(errorMsg); },
  expire: () => { throw new Error(errorMsg); },
  del: () => { throw new Error(errorMsg); },
  multi: () => ({
    hset: () => ({ exec: () => { throw new Error(errorMsg); } }),
    expire: () => ({ exec: () => { throw new Error(errorMsg); } }),
    exec: () => { throw new Error(errorMsg); },
  }),
});

describe("RedisCheckpointer — connection failure paths", () => {
  test("load() returns cache-error on ECONNREFUSED", async () => {
    const cp = new RedisCheckpointer(makeFailingRedis("ECONNREFUSED") as any);
    const result = await cp.load(runId("run-test-123"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });

  test("load() returns cache-error on ETIMEDOUT", async () => {
    const cp = new RedisCheckpointer(makeFailingRedis("ETIMEDOUT") as any);
    const result = await cp.load(runId("run-test-456"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });

  test("saveNode() returns cache-error on connection failure", async () => {
    const cp = new RedisCheckpointer(makeFailingRedis("ECONNREFUSED") as any);
    const result = await cp.saveNode(runId("run-test-789"), nodeId("node-1"), {
      nodeId: nodeId("node-1"),
      output: { data: "test" },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });

  test("setMeta() returns cache-error on connection failure", async () => {
    const cp = new RedisCheckpointer(makeFailingRedis("ECONNREFUSED") as any);
    const result = await cp.setMeta(runId("run-test-abc"), {
      dagId: dagId("test-dag"),
      startedAt: new Date(),
      nodeCount: 3,
      subject: "cust-001",
      dagFingerprint: "abc123",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });
});
