import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { InMemoryCheckpointer, TTL_SECONDS } from "../checkpoint/checkpointer.js";
import type { CheckpointerLoadOpts, InMemoryStoredMeta, RunMeta } from "../checkpoint/checkpointer.js";
import type { DagId, NodeId, RunId } from "../types/ids.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import { checkpointerSuite } from "./_checkpointer-suite.js";
import { D, N, R } from "./_id-helpers.js";
import { formatFrameworkError, retriabilityOf } from "../types/errors.js";

// The backend-neutral contract lives in `_checkpointer-suite.ts`. This file
// supplies each backend's raw-state bypass and retains only Redis-specific
// behavior (the NOSCRIPT/EVAL recovery path).

// Test-owned meta store adopted by the checkpointer (the deepening-round seam
// that replaced `__testRawMetas`): the suite seeds stored records DIRECTLY —
// the Redis-raw-set analog — so the in-memory leg mirrors the Redis leg's
// bypass shape, and nothing on the adapter exposes its internals.
const inMemoryStore = new Map<string, InMemoryStoredMeta>();

checkpointerSuite(
  "InMemoryCheckpointer",
  () => {
    inMemoryStore.clear();
    return new InMemoryCheckpointer({ testStore: inMemoryStore });
  },
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
      // Stored record with NO frameworkVersion (the ADR-0017 missing-field
      // case) — written directly, bypassing setMeta's version stamping.
      inMemoryStore.set(R(runId), {
        meta: { dagId: D("d"), startedAt, nodeCount },
        createdAt: new Date(),
      });
    },
    setExpired: async (_cp, runId, { startedAt, nodeCount, expiredAt }) => {
      // Current framework version (the version gate runs first) with a
      // backdated `createdAt` so the lazy FR-027 TTL comparison expires it.
      inMemoryStore.set(R(runId), {
        meta: { dagId: D("d"), startedAt, nodeCount, frameworkVersion: FRAMEWORK_VERSION },
        createdAt: expiredAt,
      });
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
    const result = await cp.saveNode(R("hostile-1"), N("n1"), {
      nodeId: N("n1"),
      output: { run: () => 42 }, // functions are not cloneable
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected typed refusal");
    expect(result.error.kind).toBe("checkpoint-write-failed");
  });

  test("saveNode truthful branding: an invalid raw nodeId never inhabits the branded field and rendering stays bounded", async () => {
    const cp = new InMemoryCheckpointer();
    const result = await cp.saveNode(R("hostile-2"), "not a valid id!" as NodeId, {
      nodeId: N("n1"),
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
    const store = new Map<string, InMemoryStoredMeta>();
    const cp = new InMemoryCheckpointer({ testStore: store });
    await cp.setMeta(R("hostile-4"), {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
    });
    const stored = store.get("hostile-4");
    if (stored === undefined) throw new Error("missing in-memory test meta");
    store.set("hostile-4", {
      ...stored,
      meta: { ...stored.meta, dagId: (() => "boom") as unknown as DagId },
    });
    const result = await cp.load(R("hostile-4"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("checkpoint-corrupt");
  });

  test("saveNode with a throwing-toString nodeId never rejects raw — typed refusal on non-cloneable state", async () => {
    const cp = new InMemoryCheckpointer();
    const hostileNodeId = {
      toString: () => {
        throw new Error("hostile toString");
      },
    } as unknown as string;
    // Must RESOLVE with a typed err — a raw rejection (from the catch's own
    // message template) is the FR-040 escape this test pins closed.
    const result = await cp.saveNode(R("hostile-5"), hostileNodeId as NodeId, {
      nodeId: N("n1"),
      output: { run: () => 42 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind === "checkpoint-write-failed") {
        expect(formatFrameworkError(result.error).length).toBeLessThan(500);
      }
    }
  });

  test("saveNode with a brand-bypassed coercible non-string nodeId never rejects raw (total key coercion)", async () => {
    const cp = new InMemoryCheckpointer();
    // A non-string id whose `toString` succeeds coerces exactly as a raw
    // computed key always did — the key is carried by the SAME total
    // renderer (`stringOf`) so a hostile variant can only degrade, never
    // throw out of the async port.
    const coercibleNodeId = { toString: () => "coerced-key" } as unknown as string;
    const result = await cp.saveNode(R("hostile-6"), coercibleNodeId as NodeId, {
      nodeId: N("n1"),
      output: { value: 1 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(true);
    const loaded = await cp.load(R("hostile-6"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.value !== null) {
      expect(Object.hasOwn(loaded.value.nodes, "coerced-key")).toBe(true);
    }
  });

  test("load with a hostile raw runId (throwing toString) + undetachable state is typed checkpoint-corrupt, never raw", async () => {
    const cp = new InMemoryCheckpointer();
    const hostileRunId = {
      toString: () => {
        throw new Error("hostile toString");
      },
    } as unknown as RunId;
    // setMeta stores by object reference (no stringification), so load on the
    // same reference reaches the stored-state catch with a raw runId: the
    // error construction must be total (placeholder + rendered message), not a
    // re-throw from toRunId re-validation.
    const setResult = await cp.setMeta(hostileRunId, {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
    });
    expect(setResult.ok).toBe(true);
    const result = await cp.load(hostileRunId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-corrupt");
      if (result.error.kind === "checkpoint-corrupt") {
        expect(result.error.runId).toBe(R("checkpoint_invalid_run"));
        expect(formatFrameworkError(result.error).length).toBeLessThan(500);
      }
    }
  });

  test("load with a plain non-string runId + undetachable state is typed checkpoint-corrupt (toRunId throw class)", async () => {
    const store = new Map<string, InMemoryStoredMeta>();
    const cp = new InMemoryCheckpointer({ testStore: store });
    const numericRunId = 42 as unknown as RunId;
    store.set(numericRunId, {
      meta: {
        dagId: (() => "boom") as unknown as DagId,
        startedAt: new Date("2025-01-01T00:00:00Z"),
        nodeCount: 1,
        frameworkVersion: FRAMEWORK_VERSION,
      },
      createdAt: new Date(), // current — the TTL check passes, the detach catch is reached
    });
    const result = await cp.load(numericRunId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-corrupt");
      if (result.error.kind === "checkpoint-corrupt") {
        expect(result.error.runId).toBe(R("checkpoint_invalid_run"));
      }
    }
  });

  test("checkpoint-write-failed carries the REJECTED RAW bytes: invalidNodeId unmodified, invalidRunId on hostile runId, bounded single rendering", async () => {
    const cp = new InMemoryCheckpointer();
    // String invalid nodeId: the field preserves the raw string — no JSON
    // quoting, no truncation (formatFrameworkError is the single bounding
    // point and renders it once).
    const longRaw = "bad-node!".padEnd(80, "x");
    const result = await cp.saveNode(R("hostile-7"), longRaw as NodeId, {
      nodeId: N("n1"),
      output: { run: () => 42 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind === "checkpoint-write-failed") {
        expect(result.error.invalidNodeId).toBe(longRaw);
        const rendered = formatFrameworkError(result.error);
        // Bounded by the renderer…
        expect(rendered.length).toBeLessThan(800);
        // …and rendered ONCE: the renderer's truncation marker names the FULL
        // 80-char raw length — if the field had been pre-truncated to 60
        // chars, the marker could not say 80. The raw value appears verbatim
        // inside the renderer's own quoting — never an escaped quote from a
        // double render.
        expect(rendered).toContain(longRaw.slice(0, 60));
        expect(rendered).toContain("…(80 chars)");
        expect(rendered).not.toContain('\\"');
      }
    }
    // Hostile non-string runId: the invalidRunId facet the file backend's
    // writeFailed already emits — parity on both fields.
    const hostileRunId = { toString: () => "<unprintable>" } as unknown as RunId;
    const result2 = await cp.saveNode(hostileRunId, "not a valid id!" as NodeId, {
      nodeId: N("n1"),
      output: { run: () => 42 },
      completedAt: new Date(),
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.error.kind).toBe("checkpoint-write-failed");
      if (result2.error.kind === "checkpoint-write-failed") {
        expect(result2.error.runId).toBe(R("checkpoint_invalid_run"));
        expect(result2.error.invalidRunId).toBe("<unprintable>");
        expect(result2.error.invalidNodeId).toBe("not a valid id!");
      }
    }
  });

  test("a throwing injected clock fails closed with a typed cache-error on both setMeta and load", async () => {
    const store = new Map<string, InMemoryStoredMeta>();
    const cp = new InMemoryCheckpointer({
      now: () => {
        throw new Error("clock broke");
      },
      testStore: store,
    });
    const setResult = await cp.setMeta(R("clock-1"), {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
    });
    expect(setResult.ok).toBe(false);
    if (!setResult.ok) expect(setResult.error.kind).toBe("cache-error");

    // Seed the throwing-clock instance's test-owned store (setMeta itself
    // cannot succeed under the broken clock), then load: the TTL probe must
    // fail closed rather than reject.
    store.set("clock-2", {
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

  // Non-finite clock output (NaN/±Infinity) is the SILENT twin of the
  // throwing-clock class above: `new Date(NaN)` is an invalid `Date` that
  // used to be stored with `ok(undefined)` and no signal, and the `load` TTL
  // comparison became a NaN comparison that is always `false` — an expired
  // checkpoint was served and never expired, while the file backend's twin
  // rejects the identical input as a `permanent` cache-error (pinned in
  // `file-checkpointer.test.ts`). Both rejections are deterministic — every
  // retry reproduces them — so both are pinned permanent.
  test("a non-finite injected clock fails closed with a permanent cache-error on both setMeta and load", async () => {
    const store = new Map<string, InMemoryStoredMeta>();
    const cp = new InMemoryCheckpointer({ now: () => Number.NaN, testStore: store });
    const meta: RunMeta = {
      dagId: D("d"),
      startedAt: new Date("2025-01-01T00:00:00Z"),
      nodeCount: 1,
    };
    const setResult = await cp.setMeta(R("nan-clock-1"), meta);
    expect(setResult.ok).toBe(false);
    if (!setResult.ok) {
      expect(setResult.error.kind).toBe("cache-error");
      if (setResult.error.kind === "cache-error") {
        expect(setResult.error.operation).toBe("checkpoint:setMeta");
        expect(setResult.error.failureClass).toBe("permanent");
        expect(retriabilityOf(setResult.error)).toBe("non-retriable");
      }
    }

    // ±Infinity takes the same branch through the `Number.isFinite` arm.
    const infSetResult = await new InMemoryCheckpointer({
      now: () => Number.POSITIVE_INFINITY,
    }).setMeta(R("inf-clock-1"), meta);
    expect(infSetResult.ok).toBe(false);
    if (!infSetResult.ok) {
      expect(infSetResult.error.kind).toBe("cache-error");
      if (infSetResult.error.kind === "cache-error") {
        expect(infSetResult.error.operation).toBe("checkpoint:setMeta");
        expect(infSetResult.error.failureClass).toBe("permanent");
      }
    }

    // Seed the NaN-clock instance's test-owned store (setMeta cannot succeed
    // under the broken clock), then load: the TTL probe must fail closed
    // rather than silently compare NaN.
    store.set("nan-clock-2", {
      meta: {
        dagId: D("d"),
        startedAt: new Date("2025-01-01T00:00:00Z"),
        nodeCount: 1,
        frameworkVersion: FRAMEWORK_VERSION,
      },
      createdAt: new Date(0),
    });
    const loadResult = await cp.load(R("nan-clock-2"));
    expect(loadResult.ok).toBe(false);
    if (!loadResult.ok) {
      expect(loadResult.error.kind).toBe("cache-error");
      if (loadResult.error.kind === "cache-error") {
        expect(loadResult.error.operation).toBe("checkpoint:load");
        expect(loadResult.error.failureClass).toBe("permanent");
        expect(retriabilityOf(loadResult.error)).toBe("non-retriable");
      }
    }
  });

  // Round-8 (silent-failure-hunter-1): the caller-owned `load` opts bag is a
  // hostile seam — parity with the file backend's `parseLoadOpts` snapshot-once
  // discipline. A throwing `expectedDagFingerprint` getter used to reject the
  // load promise RAW (the reads ran outside any guard), which a host routing
  // all backends through one `load(runId, opts)` helper would see as an
  // unclassifiable rejection while file/Redis handle the same opts fine.
  test("a throwing expectedDagFingerprint getter is a typed cache-error(checkpoint:load), never a raw rejection", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("loadopts-hostile"), {
      dagId: D("d"),
      startedAt: new Date(),
      nodeCount: 1,
    });
    const hostile = {
      get expectedDagFingerprint() {
        throw new Error("opts getter exploded");
      },
    };
    const result = await cp.load(R("loadopts-hostile"), hostile as unknown as CheckpointerLoadOpts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
      if (result.error.kind === "cache-error") {
        expect(result.error.operation).toBe("checkpoint:load");
        expect(result.error.message).toContain("could not inspect options");
      }
    }
  });

  test("load reads expectedDagFingerprint exactly once (a stateful getter cannot make the gate and the comparison disagree)", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.setMeta(R("fingerprint-stateful"), {
      dagId: D("d"),
      startedAt: new Date(),
      nodeCount: 1,
      dagFingerprint: "v1",
    });
    let reads = 0;
    const stateful = {
      get expectedDagFingerprint() {
        reads += 1;
        return reads === 1 ? "v1" : "v2";
      },
    };
    const result = await cp.load(R("fingerprint-stateful"), stateful as unknown as CheckpointerLoadOpts);
    // Snapshot-once: the gate and the comparison both see the FIRST value
    // ("v1" === stored "v1" → accepted). A multi-read implementation would
    // compare the second read ("v2") against the stored "v1" and reject.
    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
  });

  // Round-8 (pr-test-analyzer-4): the shared suite only exercises
  // strictly-past-TTL meta, so a `>` → `>=` regression in the in-memory
  // comparison could not fail any test. Pin the exact boundary the file
  // backend pins (file-checkpointer.test.ts "lazy TTL (FR-027)"): exactly at
  // TTL still live, one millisecond past rejected.
  test("the in-memory TTL boundary: exactly 24h accepted, one millisecond past rejected", async () => {
    const created = new Date("2025-01-01T00:00:00.000Z");
    let nowMs = created.getTime() + TTL_SECONDS * 1000;
    const store = new Map<string, InMemoryStoredMeta>();
    const cp = new InMemoryCheckpointer({ now: () => nowMs, testStore: store });
    await cp.setMeta(R("ttl-boundary"), {
      dagId: D("d"),
      startedAt: created,
      nodeCount: 1,
    });
    const stored = store.get("ttl-boundary");
    if (stored === undefined) throw new Error("missing ttl-boundary meta");
    store.set("ttl-boundary", { ...stored, createdAt: created });

    const atBoundary = await cp.load(R("ttl-boundary"));
    expect(atBoundary.ok).toBe(true); // exactly at TTL: still live (strict >)

    nowMs += 1; // one millisecond past
    const past = await cp.load(R("ttl-boundary"));
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.error.kind).toBe("checkpoint-expired");
      if (past.error.kind === "checkpoint-expired") {
        expect(past.error.expiredAt).toBe(created.toISOString());
      }
    }
  });

  // Round-8 (architecture-tech-lead-5): the setMeta write-failure kind mapping
  // is now an explicit port decision documented on the `Checkpointer.setMeta`
  // interface — for metadata that cannot be stored, in-memory keeps the
  // pre-existing frozen `cache-error` kind while the file backend's ADR-0080
  // row maps the same input class to `checkpoint-write-failed`. Pin the
  // in-memory row here; the file twin is pinned in file-checkpointer.test.ts.
  test("setMeta with unreadable metadata is a typed cache-error(checkpoint:setMeta), never a raw rejection", async () => {
    const cp = new InMemoryCheckpointer();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "dagId", {
      get: () => {
        throw new Error("meta getter exploded");
      },
      enumerable: true,
      configurable: true,
    });
    const result = await cp.setMeta(R("setmeta-hostile"), hostile as unknown as RunMeta);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
      if (result.error.kind === "cache-error") {
        expect(result.error.operation).toBe("checkpoint:setMeta");
      }
    }
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

    await cp.saveNode(R(runId), N("n1"), {
      nodeId: N("n1"),
      output: { v: 1 },
      completedAt: new Date(),
    });
    const shaBefore = (cp as unknown as { readonly saveNodeSha: string | null }).saveNodeSha;
    expect(shaBefore).not.toBeNull();

    await redisOrThrow().script("FLUSH");

    const result = await cp.saveNode(R(runId), N("n2"), {
      nodeId: N("n2"),
      output: { v: 2 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    await cp.saveNode(R(runId), N("n3"), {
      nodeId: N("n3"),
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
