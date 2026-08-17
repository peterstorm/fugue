import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { InMemoryCheckpointer } from "../checkpoint/checkpointer.js";
import type { RunMeta } from "../checkpoint/checkpointer.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import { checkpointerSuite } from "./_checkpointer-suite.js";
import { D, R } from "./_id-helpers.js";
import { formatFrameworkError } from "../types/errors.js";

// The backend-neutral contract lives in `_checkpointer-suite.ts`. This file
// supplies each backend's raw-state bypass and retains only Redis-specific
// behavior (the NOSCRIPT/EVAL recovery path).

checkpointerSuite(
  "InMemoryCheckpointer",
  () => new InMemoryCheckpointer(),
  {
    setStaleVersion: async (cp, runId, { startedAt, nodeCount }) => {
      await cp.setMeta(R(runId), {
        dagId: D("d"),
        startedAt,
        nodeCount,
        frameworkVersion: "1",
      });
    },
    setMissingVersion: async (cp, runId, { startedAt, nodeCount }) => {
      await cp.setMeta(R(runId), { dagId: D("d"), startedAt, nodeCount });
      const rawMap = (cp as InMemoryCheckpointer).__testRawMetas();
      const stored = rawMap.get(runId);
      if (stored === undefined) throw new Error(`missing in-memory test meta for ${runId}`);
      rawMap.set(runId, {
        ...stored,
        meta: {
          dagId: stored.meta.dagId,
          startedAt: stored.meta.startedAt,
          nodeCount: stored.meta.nodeCount,
        },
      });
    },
    setExpired: async (cp, runId, { startedAt, nodeCount, expiredAt }) => {
      await cp.setMeta(R(runId), { dagId: D("d"), startedAt, nodeCount });
      const rawMap = (cp as InMemoryCheckpointer).__testRawMetas();
      const stored = rawMap.get(runId);
      if (stored === undefined) throw new Error(`missing in-memory test meta for ${runId}`);
      rawMap.set(runId, { ...stored, createdAt: expiredAt });
    },
    // Corrupt bytes are unrepresentable in the in-memory map.
  },
);

// In-memory-specific hostile-value totality (FR-040/ADR-0080): the port
// methods declare `Promise<Result<_, FrameworkError>>`, so non-cloneable
// values must resolve with a typed `err` — never a raw promise rejection.
// These tests are NOT in the shared suite because the Redis backend silently
// drops non-JSON values at serialize time (pre-existing divergence, out of
// this review's scope); the file backend pins the same class in its own tests.
describe("InMemoryCheckpointer — hostile-value totality", () => {
  test("saveNode refuses non-cloneable state with a typed checkpoint-write-failed, never a raw rejection", async () => {
    const cp = new InMemoryCheckpointer();
    const result = await cp.saveNode(R("hostile-1"), "n1", {
      nodeId: "n1",
      output: { run: () => 42 }, // functions are not cloneable
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected typed refusal");
    expect(result.error.kind).toBe("checkpoint-write-failed");
  });

  test("saveNode truthful branding: an invalid raw nodeId never inhabits the branded field and rendering stays bounded", async () => {
    const cp = new InMemoryCheckpointer();
    const result = await cp.saveNode(R("hostile-2"), "not a valid id!", {
      nodeId: "n1",
      output: { run: () => 42 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind === "checkpoint-write-failed") {
        expect(result.error.invalidNodeId).toBeDefined();
        expect(formatFrameworkError(result.error).length).toBeLessThan(500);
      }
    }
  });

  test("setMeta refuses non-cloneable meta with a typed cache-error, never a raw rejection", async () => {
    const cp = new InMemoryCheckpointer();
    const meta: RunMeta = {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
      subject: (() => "boom") as unknown as string, // hostile JS smuggles a function
    };
    const result = await cp.setMeta(R("hostile-3"), meta);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("cache-error");
  });

  test("load refuses undetachable stored state (smuggled via the raw bypass) with typed checkpoint-corrupt", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("hostile-4"), {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
    });
    const rawMap = cp.__testRawMetas();
    const stored = rawMap.get("hostile-4");
    if (stored === undefined) throw new Error("missing in-memory test meta");
    rawMap.set("hostile-4", {
      ...stored,
      meta: { ...stored.meta, dagId: (() => "boom") as unknown as string },
    });
    const result = await cp.load(R("hostile-4"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("checkpoint-corrupt");
  });

  test("a throwing injected clock fails closed with a typed cache-error on both setMeta and load", async () => {
    const cp = new InMemoryCheckpointer({
      now: () => {
        throw new Error("clock broke");
      },
    });
    const setResult = await cp.setMeta(R("clock-1"), {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
    });
    expect(setResult.ok).toBe(false);
    if (!setResult.ok) expect(setResult.error.kind).toBe("cache-error");

    // Seed the throwing-clock instance's store via the raw bypass (setMeta
    // itself cannot succeed under the broken clock), then load: the TTL probe
    // must fail closed rather than reject.
    cp.__testRawMetas().set("clock-2", {
      meta: {
        dagId: D("d"),
        startedAt: new Date("2025-01-01T00:00:00Z"),
        nodeCount: 1,
        frameworkVersion: FRAMEWORK_VERSION,
      },
      createdAt: new Date(0),
    });
    const loadResult = await cp.load(R("clock-2"));
    expect(loadResult.ok).toBe(false);
    if (!loadResult.ok) expect(loadResult.error.kind).toBe("cache-error");
  });

  // `__proto__` matches ID_PATTERN (`_` is in the charset), so it is a LEGAL
  // nodeId. `saveNode` stores via a computed-key spread
  // (`{ ...existing, [nodeId]: detached }`), which defines an OWN property —
  // but a refactor to plain bracket assignment (`nodes[nodeId] = …`) would
  // hit `Object.prototype`'s `__proto__` SETTER and silently re-parent the
  // map. Pin the own-entry semantics (parity with the file-backend pin at
  // file-checkpointer.test.ts "round-trips prototype-named node ids").
  test("saveNode round-trips a prototype-named nodeId (__proto__) as an OWN entry", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("hostile-proto"), {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
      subject: "s",
      frameworkVersion: FRAMEWORK_VERSION,
    });
    const saved = await cp.saveNode(R("hostile-proto"), "__proto__", {
      nodeId: "__proto__",
      output: { value: 1 },
      completedAt: new Date(),
    });
    expect(saved.ok).toBe(true);
    const loaded = await cp.load(R("hostile-proto"));
    if (!loaded.ok || loaded.value === null) throw new Error("expected a loaded run state");
    expect(Object.hasOwn(loaded.value.nodes, "__proto__")).toBe(true);
    expect(loaded.value.nodes["__proto__"].output).toEqual({ value: 1 });
    expect(loaded.value.nodes["__proto__"].nodeId).toBe("__proto__");
    // The map itself was never re-parented by the `__proto__` entry.
    expect(Object.getPrototypeOf(loaded.value.nodes)).toBe(Object.prototype);
  });
});

// Redis integration is opt-in, matching the queue adapter tests. Set
// REDIS_URL=redis://localhost:6379 to run the shared contract and the
// Redis-specific script-cache regression.
const REDIS_URL = process.env.REDIS_URL;
const hasRedis = REDIS_URL !== undefined && REDIS_URL.length > 0;
const describeRedis = hasRedis ? describe : describe.skip;
let redis: Redis | null = null;

const redisOrThrow = (): Redis => {
  if (redis === null) throw new Error("Redis test client was not initialized");
  return redis;
};

beforeAll(async () => {
  if (!hasRedis || REDIS_URL === undefined) return;
  redis = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2000 });
  await redis.connect();
});

afterAll(async () => {
  if (redis !== null) await redis.quit();
});

const SHARED_RUN_IDS = [
  "nonexistent",
  "run-1",
  "run-2",
  "run-3",
  "stale-1",
  "missing-1",
  "expired-1",
  "corrupt-1",
  "corrupt-node-1",
  "fingerprint-match",
  "fingerprint-wrong",
  "fingerprint-absent",
] as const;

const redisKeys = (runId: string): readonly [string, string] => [
  `chkpt:${runId}`,
  `chkpt:${runId}:meta`,
];

describeRedis("RedisCheckpointer", () => {
  const ownedRunIds = new Set<string>(SHARED_RUN_IDS);

  const cleanRuns = async (runIds: Iterable<string>): Promise<void> => {
    const keys = [...runIds].flatMap(redisKeys);
    if (keys.length > 0) await redisOrThrow().del(...keys);
  };

  const makeRunId = (): string => {
    const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ownedRunIds.add(id);
    return id;
  };

  checkpointerSuite(
    "shared contract",
    () => new RedisCheckpointer(redisOrThrow()),
    {
      setStaleVersion: async (cp, runId, { startedAt, nodeCount }) => {
        await cp.setMeta(R(runId), {
          dagId: D("d"),
          startedAt,
          nodeCount,
          frameworkVersion: "1",
        });
      },
      setMissingVersion: async (_cp, runId, { startedAt, nodeCount }) => {
        await redisOrThrow().set(
          `chkpt:${runId}:meta`,
          JSON.stringify({
            dagId: "d",
            startedAt: startedAt.toISOString(),
            nodeCount,
            createdAt: new Date().toISOString(),
          }),
          "EX",
          300,
        );
      },
      setExpired: async (_cp, runId, { startedAt, nodeCount, expiredAt }) => {
        await redisOrThrow().set(
          `chkpt:${runId}:meta`,
          JSON.stringify({
            dagId: "d",
            startedAt: startedAt.toISOString(),
            nodeCount,
            createdAt: expiredAt.toISOString(),
            frameworkVersion: FRAMEWORK_VERSION,
          }),
          "EX",
          300,
        );
      },
      setCorrupt: async (_cp, runId) => {
        await redisOrThrow().set(`chkpt:${runId}:meta`, "{ not valid json", "EX", 300);
      },
      setCorruptNode: async (_cp, runId, nodeId) => {
        await redisOrThrow().hset(`chkpt:${runId}`, nodeId, "{ not valid json");
        return { corruptAddress: nodeId };
      },
    },
    async () => cleanRuns(SHARED_RUN_IDS),
  );

  let cp: RedisCheckpointer;

  beforeEach(() => {
    cp = new RedisCheckpointer(redisOrThrow());
  });

  afterAll(async () => {
    await cleanRuns(ownedRunIds);
  });

  // Redis-specific: SCRIPT FLUSH between saves causes NOSCRIPT on EVALSHA;
  // the adapter must fall back to inline EVAL and re-prime the SHA.
  test("recovers from server-side SCRIPT FLUSH (NOSCRIPT) via inline EVAL fallback", async () => {
    const runId = makeRunId();
    await cp.setMeta(R(runId), { dagId: D("d"), startedAt: new Date(), nodeCount: 3 });

    await cp.saveNode(R(runId), "n1", {
      nodeId: "n1",
      output: { v: 1 },
      completedAt: new Date(),
    });
    const shaBefore = (cp as unknown as { readonly saveNodeSha: string | null }).saveNodeSha;
    expect(shaBefore).not.toBeNull();

    await redisOrThrow().script("FLUSH");

    const result = await cp.saveNode(R(runId), "n2", {
      nodeId: "n2",
      output: { v: 2 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    await cp.saveNode(R(runId), "n3", {
      nodeId: "n3",
      output: { v: 3 },
      completedAt: new Date(),
    });
    const shaAfter = (cp as unknown as { readonly saveNodeSha: string | null }).saveNodeSha;
    expect(shaAfter).not.toBeNull();

    const loaded = await cp.load(R(runId));
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.value !== null) {
      expect(Object.keys(loaded.value.nodes).sort()).toEqual(["n1", "n2", "n3"]);
    }
  });
});
