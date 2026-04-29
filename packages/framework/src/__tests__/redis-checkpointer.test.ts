import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import Redis from "ioredis";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import type { Checkpointer, RunMeta, NodeState } from "../checkpoint/checkpointer.js";

// --- Shared test suite for any Checkpointer ---

function checkpointerSuite(name: string, factory: () => Checkpointer, cleanup?: () => Promise<void>) {
  describe(name, () => {
    let cp: Checkpointer;

    beforeEach(async () => {
      cp = factory();
      if (cleanup) await cleanup();
    });

    test("load returns null for non-existent runId", async () => {
      const result = await cp.load("nonexistent");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });

    test("setMeta + load round-trips metadata", async () => {
      const meta: RunMeta = { dagId: "dag-1", startedAt: new Date("2025-01-01T00:00:00Z"), nodeCount: 3 };
      const setResult = await cp.setMeta("run-1", meta);
      expect(setResult.ok).toBe(true);

      const loadResult = await cp.load("run-1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(loadResult.value.meta.dagId).toBe("dag-1");
        expect(loadResult.value.meta.nodeCount).toBe(3);
        expect(loadResult.value.nodes).toEqual({});
      }
    });

    test("saveNode + load round-trips correctly", async () => {
      const meta: RunMeta = { dagId: "dag-1", startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta("run-2", meta);

      const nodeState: NodeState = { nodeId: "n1", output: { text: "hello" }, completedAt: new Date("2025-06-01T12:00:00Z") };
      const saveResult = await cp.saveNode("run-2", "n1", nodeState);
      expect(saveResult.ok).toBe(true);

      const loadResult = await cp.load("run-2");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(loadResult.value.nodes["n1"].nodeId).toBe("n1");
        expect(loadResult.value.nodes["n1"].output).toEqual({ text: "hello" });
      }
    });

    test("multiple nodes saved, all present in load", async () => {
      const meta: RunMeta = { dagId: "dag-2", startedAt: new Date(), nodeCount: 3 };
      await cp.setMeta("run-3", meta);

      for (const id of ["a", "b", "c"]) {
        await cp.saveNode("run-3", id, { nodeId: id, output: id, completedAt: new Date() });
      }

      const loadResult = await cp.load("run-3");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok && loadResult.value) {
        expect(Object.keys(loadResult.value.nodes).sort()).toEqual(["a", "b", "c"]);
      }
    });
  });
}

// --- InMemoryCheckpointer (always runs) ---

checkpointerSuite("InMemoryCheckpointer", () => new InMemoryCheckpointer());

// --- RedisCheckpointer (skip if Redis unavailable) ---

let redis: Redis | null = null;
let redisAvailable = false;

beforeAll(async () => {
  const r = new Redis({ lazyConnect: true, connectTimeout: 2000 });
  try {
    await r.connect();
    redisAvailable = true;
    redis = r;
  } catch {
    r.disconnect();
  }
});

afterAll(async () => {
  if (redis) await redis.quit();
});

const TEST_PREFIX = "chkpt:test-";

const describeRedis = redisAvailable ? describe : describe.skip;

describeRedis("RedisCheckpointer", () => {
  const runIds: string[] = [];

  const makeRunId = () => {
    const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    runIds.push(id);
    return id;
  };

  afterAll(async () => {
    if (!redis) return;
    for (const id of runIds) {
      await redis.del(`chkpt:${id}`, `chkpt:${id}:meta`);
    }
  });

  // Use the shared suite with unique run IDs via a wrapper
  let cp: RedisCheckpointer;

  beforeEach(() => {
    cp = new RedisCheckpointer(redis!);
  });

  test("load returns null for non-existent runId", async () => {
    const result = await cp.load("nonexistent-redis-test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  test("setMeta + load round-trips metadata", async () => {
    const runId = makeRunId();
    const meta: RunMeta = { dagId: "dag-r1", startedAt: new Date("2025-01-01T00:00:00Z"), nodeCount: 5 };
    await cp.setMeta(runId, meta);

    const loadResult = await cp.load(runId);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok && loadResult.value) {
      expect(loadResult.value.meta.dagId).toBe("dag-r1");
      expect(loadResult.value.meta.nodeCount).toBe(5);
    }
  });

  test("saveNode + load round-trips correctly", async () => {
    const runId = makeRunId();
    await cp.setMeta(runId, { dagId: "d", startedAt: new Date(), nodeCount: 1 });
    await cp.saveNode(runId, "n1", { nodeId: "n1", output: { x: 42 }, completedAt: new Date("2025-06-01T00:00:00Z") });

    const result = await cp.load(runId);
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.nodes["n1"].output).toEqual({ x: 42 });
    }
  });

  test("multiple nodes saved, all present in load", async () => {
    const runId = makeRunId();
    await cp.setMeta(runId, { dagId: "d", startedAt: new Date(), nodeCount: 3 });
    for (const id of ["x", "y", "z"]) {
      await cp.saveNode(runId, id, { nodeId: id, output: id, completedAt: new Date() });
    }

    const result = await cp.load(runId);
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(Object.keys(result.value.nodes).sort()).toEqual(["x", "y", "z"]);
    }
  });
});
