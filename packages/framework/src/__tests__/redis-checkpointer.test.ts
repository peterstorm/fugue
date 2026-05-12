import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
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
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date("2025-01-01T00:00:00Z"), nodeCount: 3 };
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
      const meta: RunMeta = { dagId: "dag-1" as DagId, startedAt: new Date(), nodeCount: 1 };
      await cp.setMeta("run-2", meta);

      const nodeState: NodeState = { nodeId: "n1" as NodeId, output: { text: "hello" }, completedAt: new Date("2025-06-01T12:00:00Z") };
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
      const meta: RunMeta = { dagId: "dag-2" as DagId, startedAt: new Date(), nodeCount: 3 };
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
//
// Gates on `process.env.REDIS_URL` at module-load time (matches the pattern
// in queue-bullmq tests). The previous version captured `redisAvailable` at
// module load BEFORE `beforeAll` could probe, so it always skipped — even
// with Redis running. Now: set REDIS_URL=redis://localhost:6379 to run.

const REDIS_URL = process.env.REDIS_URL;
const hasRedis = Boolean(REDIS_URL);

let redis: Redis | null = null;

beforeAll(async () => {
  if (!hasRedis) return;
  redis = new Redis(REDIS_URL!, { lazyConnect: true, connectTimeout: 2000 });
  await redis.connect();
});

afterAll(async () => {
  if (redis) await redis.quit();
});

const TEST_PREFIX = "chkpt:test-";

const describeRedis = hasRedis ? describe : describe.skip;

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
    const meta: RunMeta = { dagId: "dag-r1" as DagId, startedAt: new Date("2025-01-01T00:00:00Z"), nodeCount: 5 };
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
    await cp.setMeta(runId, { dagId: "d" as DagId, startedAt: new Date(), nodeCount: 1 });
    await cp.saveNode(runId, "n1", { nodeId: "n1" as NodeId, output: { x: 42 }, completedAt: new Date("2025-06-01T00:00:00Z") });

    const result = await cp.load(runId);
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.nodes["n1"].output).toEqual({ x: 42 });
    }
  });

  test("multiple nodes saved, all present in load", async () => {
    const runId = makeRunId();
    await cp.setMeta(runId, { dagId: "d" as DagId, startedAt: new Date(), nodeCount: 3 });
    for (const id of ["x", "y", "z"]) {
      await cp.saveNode(runId, id, { nodeId: id, output: id, completedAt: new Date() });
    }

    const result = await cp.load(runId);
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(Object.keys(result.value.nodes).sort()).toEqual(["x", "y", "z"]);
    }
  });

  // ADR-0017 — Wave 1 §1.3 regression
  test("load rejects checkpoint with stale frameworkVersion", async () => {
    const runId = makeRunId();
    // Explicit stale version forces the writer to stamp v1 instead of the
    // current FRAMEWORK_VERSION default.
    await cp.setMeta(runId, {
      dagId: "d" as DagId,
      startedAt: new Date(),
      nodeCount: 1,
      frameworkVersion: "1",
    });

    const result = await cp.load(runId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-version-mismatch");
      if (result.error.kind === "checkpoint-version-mismatch") {
        expect(result.error.runId).toBe(runId);
        expect(result.error.expected).toBe("2");
        expect(result.error.actual).toBe("1");
      }
    }
  });

  test("load rejects checkpoint missing frameworkVersion field", async () => {
    const runId = makeRunId();
    // Write a raw meta payload that predates the frameworkVersion field
    // (simulates an upgrade across the boundary).
    await redis!.set(
      `chkpt:${runId}:meta`,
      JSON.stringify({
        dagId: "d" as DagId,
        startedAt: new Date().toISOString(),
        nodeCount: 1,
        createdAt: new Date().toISOString(),
      }),
      "EX",
      300,
    );
    runIds.push(runId);

    const result = await cp.load(runId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-version-mismatch");
      if (result.error.kind === "checkpoint-version-mismatch") {
        expect(result.error.actual).toBeUndefined();
      }
    }
  });

  // Wave 6 §6.2: TTL-expired meta returns checkpoint-expired
  test("load rejects expired checkpoint (createdAt older than TTL)", async () => {
    const runId = makeRunId();
    // Write meta with createdAt 25h in the past — TTL is 24h.
    const expiredCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await redis!.set(
      `chkpt:${runId}:meta`,
      JSON.stringify({
        dagId: "d" as DagId,
        startedAt: new Date().toISOString(),
        nodeCount: 1,
        createdAt: expiredCreatedAt.toISOString(),
        frameworkVersion: "2",
      }),
      "EX",
      300,
    );
    runIds.push(runId);

    const result = await cp.load(runId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-expired");
      if (result.error.kind === "checkpoint-expired") {
        expect(result.error.runId).toBe(runId);
        expect(result.error.expiredAt.getTime()).toBe(expiredCreatedAt.getTime());
      }
    }
  });

  // Wave 6 §6.2: malformed meta payload returns checkpoint-corrupt
  test("load rejects malformed meta JSON with checkpoint-corrupt", async () => {
    const runId = makeRunId();
    await redis!.set(`chkpt:${runId}:meta`, "{ not valid json", "EX", 300);
    runIds.push(runId);

    const result = await cp.load(runId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-corrupt");
      if (result.error.kind === "checkpoint-corrupt") {
        expect(result.error.runId).toBe(runId);
      }
    }
  });

  // Wave 6 §6.1: SCRIPT FLUSH between saves causes NOSCRIPT on EVALSHA;
  // the checkpointer must fall back to inline EVAL and re-prime the SHA.
  test("recovers from server-side SCRIPT FLUSH (NOSCRIPT) via inline EVAL fallback", async () => {
    const runId = makeRunId();
    await cp.setMeta(runId, { dagId: "d" as DagId, startedAt: new Date(), nodeCount: 2 });

    // First save primes the SHA cache.
    await cp.saveNode(runId, "n1", {
      nodeId: "n1" as NodeId,
      output: { v: 1 },
      completedAt: new Date(),
    });
    const shaBefore = (cp as unknown as { saveNodeSha: string | null }).saveNodeSha;
    expect(shaBefore).not.toBeNull();

    // Server-side flush — the cached SHA is now invalid.
    await redis!.script("FLUSH");

    // Second save must recover and re-prime the SHA.
    const result = await cp.saveNode(runId, "n2", {
      nodeId: "n2" as NodeId,
      output: { v: 2 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    // The fallback path clears saveNodeSha at line `this.saveNodeSha = null`;
    // a subsequent saveNode re-LOADs.
    await cp.saveNode(runId, "n3", {
      nodeId: "n3" as NodeId,
      output: { v: 3 },
      completedAt: new Date(),
    });
    const shaAfter = (cp as unknown as { saveNodeSha: string | null }).saveNodeSha;
    expect(shaAfter).not.toBeNull();

    // Verify all three node states landed.
    const loaded = await cp.load(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.value) {
      expect(Object.keys(loaded.value.nodes).sort()).toEqual(["n1", "n2", "n3"]);
    }
  });
});
