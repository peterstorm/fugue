import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { InMemoryCheckpointer, TTL_SECONDS } from "../checkpoint/checkpointer.js";
import type { Checkpointer, CheckpointerLoadOpts, InMemoryStoredMeta, RunMeta } from "../checkpoint/checkpointer.js";
import type { DagId, NodeId, RunId } from "../types/ids.js";
import { FRAMEWORK_VERSION } from "../checkpoint/fingerprint.js";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import { checkpointerSuite, type CheckpointerSuiteRaw } from "./_checkpointer-suite.js";
import { redisDriverFake } from "./_redis-driver-fake.js";
import { D, N, R } from "./_id-helpers.js";
import { formatFrameworkError, retriabilityOf } from "../types/errors.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";

// The backend-neutral contract lives in `_checkpointer-suite.ts`. This file
// supplies each backend's raw-state bypass and retains only Redis-specific
// behavior (the NOSCRIPT/EVAL recovery path).

// Test-owned meta store adopted by the checkpointer (the deepening-round seam
// that replaced `__testRawMetas`): the suite seeds stored records DIRECTLY —
// the Redis-raw-set analog — so the in-memory leg mirrors the Redis leg's
// bypass shape, and nothing on the adapter exposes its internals.
const inMemoryStore = new Map<string, InMemoryStoredMeta>();

/**
 * The one bypass that is not a bypass: every OTHER hook in the raw objects
 * below reaches durable state a backend-specific way (the in-memory test store
 * for one leg, a raw `redis.set`/`hset` for the other), which is why the suite
 * asks for them at all. A stale version is different — `setMeta` stamps
 * whatever `frameworkVersion` it is handed, so both legs get there through the
 * public port and the two copies were identical by nothing but coincidence.
 */
const setStaleVersionViaSetMeta: CheckpointerSuiteRaw["setStaleVersion"] = async (
  cp,
  runId,
  { startedAt, nodeCount },
) => {
  await cp.setMeta(R(runId), {
    dagId: D("d"),
    startedAt,
    nodeCount,
    frameworkVersion: "1",
  });
};

checkpointerSuite(
  "InMemoryCheckpointer",
  () => {
    inMemoryStore.clear();
    return new InMemoryCheckpointer({ testStore: inMemoryStore });
  },
  {
    setStaleVersion: setStaleVersionViaSetMeta,
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

// Redis-specific hostile-value totality (FR-040/ADR-0080). The Redis backend
// serializes with JSON, so its hostile-input class is NOT the in-memory
// backend's (structured-clone) one: `JSON.stringify` tolerates a function by
// dropping it, but THROWS on a cyclic object or a BigInt, and
// `completedAt.toISOString()` throws on an invalid Date. `NodeState.output` is
// typed `unknown`, so every one of those is type-legal input.
//
// These are pinned here rather than in the shared suite because the classes
// genuinely differ per backend (the suite would have to assert a different
// outcome per leg, which is what a shared contract must not do).
//
// The regression they exist for: F1 PR-A's distill pass hoisted
// `serializeNode(state)` above `saveNode`'s try while extracting
// `encodeStoredNodeKey`, so these throws escaped as raw rejections instead of
// the typed `Result` the port declares.
describe("RedisCheckpointer — hostile-value totality (write-side serialization)", () => {
  // No driver call should ever be reached, so the fake overrides NOTHING: every
  // method is the named-throw default, and the refusal has to happen before any
  // of them (fail closed, no write).
  const unusedRedis = () => redisDriverFake();

  test("saveNode resolves a typed err for a CYCLIC output, never a raw rejection", async () => {
    const cp: Checkpointer = new RedisCheckpointer(unusedRedis());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = await cp.saveNode(R("hostile-redis-1"), {
      nodeId: N("n1"),
      output: cyclic,
      completedAt: new Date("2026-08-12T00:00:01Z"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected typed refusal");
    // The tag is asserted, not just the kind: `saveNode` is DELIBERATELY the
    // same tag the driver-failure catch below uses (see that block's banner),
    // and this pins the sharing as a decision rather than a coincidence.
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "saveNode" });
  });

  test("saveNode resolves a typed err for an INVALID completedAt, never a raw rejection", async () => {
    const cp: Checkpointer = new RedisCheckpointer(unusedRedis());

    const result = await cp.saveNode(R("hostile-redis-2"), {
      nodeId: N("n1"),
      output: { ok: true },
      completedAt: new Date(Number.NaN),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected typed refusal");
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "saveNode" });
  });

  test("a serialization refusal issues NO driver call", async () => {
    const calls: string[] = [];
    const recording = redisDriverFake({
      script: async () => {
        calls.push("script");
        return "sha-1";
      },
      evalsha: async () => {
        calls.push("evalsha");
        return "OK";
      },
      eval: async () => {
        calls.push("eval");
        return "OK";
      },
    });
    const cp: Checkpointer = new RedisCheckpointer(recording);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await cp.saveNode(R("hostile-redis-3"), {
      nodeId: N("n1"),
      output: cyclic,
      completedAt: new Date("2026-08-12T00:00:01Z"),
    });

    expect(calls).toEqual([]);
  });
});

// In-memory-specific hostile-value totality (FR-040/ADR-0080): the port
// methods declare `Promise<Result<_, FrameworkError>>`, so non-cloneable
// values must resolve with a typed `err` — never a raw promise rejection.
// These tests are NOT in the shared suite because each backend's hostile-input
// class is different (structured-clone here, JSON above); the file backend
// pins the same discipline in its own tests.
describe("InMemoryCheckpointer — hostile-value totality", () => {
  test("saveNode refuses non-cloneable state with a typed checkpoint-write-failed, never a raw rejection", async () => {
    const cp = new InMemoryCheckpointer();
    const result = await cp.saveNode(R("hostile-1"), {
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
    const result = await cp.saveNode(R("hostile-2"), {
      nodeId: "not a valid id!" as NodeId,
      output: { run: () => 42 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-write-failed");
      if (result.error.kind === "checkpoint-write-failed") {
        expect(result.error.invalidNodeId).toBe("not a valid id!");
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

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "setMeta rejects invalid nodeCount %s before in-memory storage",
    async (nodeCount) => {
      const cp = new InMemoryCheckpointer();
      const result = await cp.setMeta(R("invalid-node-count"), {
        dagId: D("d"),
        startedAt: new Date("2025-01-01T00:00:00Z"),
        nodeCount,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          kind: "cache-error",
          operation: "checkpoint:setMeta",
          failureClass: "permanent",
        });
        if (result.error.kind === "cache-error") {
          expect(result.error.message).toContain("nodeCount must be a non-negative safe integer");
        }
      }
    },
  );

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
    const result = await cp.saveNode(R("hostile-5"), {
      nodeId: hostileNodeId as NodeId,
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

  test("saveNode rejects a brand-bypassed non-string nodeId through the typed boundary", async () => {
    const cp = new InMemoryCheckpointer();
    const coercibleNodeId = { toString: () => "coerced-key" } as unknown as string;
    const result = await cp.saveNode(R("hostile-6"), {
      nodeId: coercibleNodeId as NodeId,
      output: { value: 1 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected typed refusal");
    expect(result.error.kind).toBe("checkpoint-write-failed");
    if (result.error.kind === "checkpoint-write-failed") {
      expect(result.error.invalidNodeId).toBe("coerced-key");
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
    const result = await cp.saveNode(R("hostile-7"), {
      nodeId: longRaw as NodeId,
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
    const result2 = await cp.saveNode(hostileRunId, {
      nodeId: "not a valid id!" as NodeId,
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

describe("RedisCheckpointer — required corruption observability", () => {
  afterEach(() => __resetFrameworkLogger());

  test("a throwing corrupt-entry logger returns typed cache-error(load), never a raw rejection", async () => {
    const meta = JSON.stringify({
      dagId: "d",
      startedAt: "2025-01-01T00:00:00.000Z",
      nodeCount: 1,
      createdAt: new Date().toISOString(),
      frameworkVersion: FRAMEWORK_VERSION,
    });
    const redis = redisDriverFake({
      get: async () => meta,
      hgetall: async () => ({ broken: "{ not json" }),
    });
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => { throw new Error("logger unavailable"); },
      error: () => {},
    });

    const result = await new RedisCheckpointer(redis).load(R("logger-contract"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected required-warning failure");
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "checkpoint:load" });
  });
});

// Driver-failure totality (ADR-0080: "never a raw rejection"). Every hostile
// seam this adapter owns ITSELF — the injected clock, the load-opts getter,
// JSON serialization, the corrupt-entry logger — is pinned above. The seam it
// does NOT own is the one likeliest to fire in production: the driver
// rejecting because the connection dropped mid-call. These pin the five driver
// calls that can reject, and they pin the `operation` tag, not just the kind.
//
// The tag is worth pinning because it is what localizes a production failure —
// but only three of the tags belong to one call each. `saveNode` is shared, ON
// PURPOSE, between the pre-driver serialization guard and the driver catch
// (see `saveNode`'s own comment: keeping one tag is what makes composite
// addressing observably identical to what shipped before it). So for a
// `cache-error(saveNode)`, `message` is what says whether the caller handed us
// an unserializable value or Redis went away — never `operation`. The
// serialization tests above assert the same tag, so that sharing is a recorded
// decision and splitting it has to change a test that explains why.
//
// Untested, these were free to rot: a refactor that moved a driver call out
// from under its try would leak a raw rejection through a port declaring
// `Promise<Result<_, FrameworkError>>`, and a typo'd tag would mislabel the
// failure — both with the whole suite green.
//
// What each fake does NOT override is part of its assertion: `redisDriverFake`
// defaults every other method to a throw naming itself, so a test also proves
// the adapter never reached a call that path should not make.
describe("RedisCheckpointer — driver-failure totality (the driver rejects)", () => {
  // The one shared fixture: four tests need the SAME driver fault, so the fault
  // is never what distinguishes them — only the call it interrupts is.
  const DROPPED = () => new Error("Connection is closed.");

  test("load: a rejecting GET on the meta key is cache-error(load:get-meta)", async () => {
    const redis = redisDriverFake({
      get: async () => {
        throw DROPPED();
      },
    });

    const result = await new RedisCheckpointer(redis).load(R("driver-get-meta"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a typed refusal");
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "load:get-meta" });
  });

  test("load: a rejecting HGETALL on the nodes key is cache-error(load:hgetall-nodes)", async () => {
    // The meta read and every gate must SUCCEED first, or this would pass for
    // the wrong reason — the two load-side tags would be indistinguishable.
    const redis = redisDriverFake({
      get: async () =>
        JSON.stringify({
          dagId: "d",
          startedAt: "2026-01-01T00:00:00.000Z",
          nodeCount: 1,
          createdAt: new Date().toISOString(),
          frameworkVersion: FRAMEWORK_VERSION,
        }),
      hgetall: async () => {
        throw DROPPED();
      },
    });

    const result = await new RedisCheckpointer(redis).load(R("driver-hgetall"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a typed refusal");
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "load:hgetall-nodes" });
  });

  test("saveNode: a NON-NOSCRIPT evalsha rejection is cache-error(saveNode) and does NOT retry via EVAL", async () => {
    // The NOSCRIPT branch matches on error TEXT. A driver fault that is not a
    // flushed script must fall through to the typed boundary — replaying it as
    // an inline EVAL would turn one dropped connection into two.
    const evalCalls: string[] = [];
    const redis = redisDriverFake({
      script: async () => "sha-1",
      evalsha: async () => {
        throw DROPPED();
      },
      eval: async () => {
        evalCalls.push("eval");
        return "OK";
      },
    });

    const result = await new RedisCheckpointer(redis).saveNode(R("driver-evalsha"), {
      nodeId: N("n1"),
      output: { ok: true },
      completedAt: new Date("2026-08-12T00:00:01Z"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a typed refusal");
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "saveNode" });
    expect(evalCalls).toEqual([]);
  });

  test("saveNode: a rejecting SCRIPT LOAD is cache-error(saveNode) and never reaches EVALSHA", async () => {
    // Priming the Lua SHA is a driver call like any other, and it is the FIRST
    // one `saveNode` makes on a cold adapter — so it is the one a production
    // reconnect is likeliest to catch. It shares the outer try (and the tag)
    // with the evalsha path; what this pins is that it is inside that try at
    // all. Hoisting the priming step to its own init helper is the refactor
    // that would leak it, and nothing else in the suite would notice.
    //
    // `evalsha`/`eval` stay at their named-throw defaults: reaching either
    // after the SHA never arrived would fail loudly rather than pass quietly.
    const redis = redisDriverFake({
      script: async () => {
        throw DROPPED();
      },
    });

    const result = await new RedisCheckpointer(redis).saveNode(R("driver-script-load"), {
      nodeId: N("n1"),
      output: { ok: true },
      completedAt: new Date("2026-08-12T00:00:01Z"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a typed refusal");
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "saveNode" });
  });

  test("setMeta: a rejecting SET is cache-error(setMeta)", async () => {
    const redis = redisDriverFake({
      set: async () => {
        throw DROPPED();
      },
    });

    const result = await new RedisCheckpointer(redis).setMeta(R("driver-set-meta"), {
      dagId: D("d"),
      startedAt: new Date("2026-08-12T00:00:00Z"),
      nodeCount: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a typed refusal");
    expect(result.error).toMatchObject({ kind: "cache-error", operation: "setMeta" });
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
      setStaleVersion: setStaleVersionViaSetMeta,
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
        return { corruptAddress: { kind: "node-key" as const, nodeKey: nodeId } };
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

    await cp.saveNode(R(runId), {
      nodeId: N("n1"),
      output: { v: 1 },
      completedAt: new Date(),
    });
    const shaBefore = (cp as unknown as { readonly saveNodeSha: string | null }).saveNodeSha;
    expect(shaBefore).not.toBeNull();

    await redisOrThrow().script("FLUSH");

    const result = await cp.saveNode(R(runId), {
      nodeId: N("n2"),
      output: { v: 2 },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(true);

    await cp.saveNode(R(runId), {
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

  // Round-18 arch-1/arch-2: the Redis leg of the Checkpointer port now shares
  // the in-memory/file hostile-seam contracts — the injected clock and the
  // caller-owned opts bag. These pin that a throwing/non-representable clock
  // settles as a typed `cache-error` (never a raw rejection, never a silently
  // voided FR-027 TTL) and that a stateful `expectedDagFingerprint` getter
  // cannot make the load gate and comparison disagree.
  test("a throwing injected clock settles as a typed cache-error from load and setMeta", async () => {
    // Seed the run with a HEALTHY checkpointer: the assertions are about the
    // read path reaching the clock guard, and a hostile-clock setMeta fails
    // by design — without a seeded meta, load would short-circuit ok(null)
    // before ever touching the clock and the test would silently no-op.
    const seed = new RedisCheckpointer(redisOrThrow());
    await seed.setMeta(R("clock-throw"), { dagId: D("d"), startedAt: new Date(), nodeCount: 1 });

    const hostile = new RedisCheckpointer(redisOrThrow(), {
      now: () => { throw new Error("hostile clock"); },
    });
    const loaded = await hostile.load(R("clock-throw"));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.kind).toBe("cache-error");
      if (loaded.error.kind === "cache-error") {
        expect(loaded.error.operation).toContain("load");
        expect(loaded.error.message).toContain("hostile clock");
        // Deterministic rejection — retry cannot clear a throwing clock.
        expect(retriabilityOf(loaded.error)).toBe("non-retriable");
      }
    }

    const written = await hostile.setMeta(R("clock-throw-2"), { dagId: D("d"), startedAt: new Date(), nodeCount: 1 });
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.error.kind).toBe("cache-error");
      if (written.error.kind === "cache-error") {
        expect(written.error.operation).toContain("setMeta");
      }
    }
  });

  test("a NaN injected clock fails closed — the FR-027 TTL check cannot be silently voided", async () => {
    // Seed with a healthy checkpointer (see the throwing-clock test above).
    const seed = new RedisCheckpointer(redisOrThrow());
    await seed.setMeta(R("clock-nan"), { dagId: D("d"), startedAt: new Date(), nodeCount: 1 });
    const cp = new RedisCheckpointer(redisOrThrow(), { now: () => Number.NaN });
    const result = await cp.load(R("clock-nan"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
      if (result.error.kind === "cache-error") {
        expect(result.error.message).toContain("non-representable timestamp");
        expect(retriabilityOf(result.error)).toBe("non-retriable");
      }
    }
  });

  test("a throwing expectedDagFingerprint getter settles as a typed cache-error, never a raw rejection", async () => {
    // Seed with a healthy checkpointer so the opts inspection is actually
    // reached (a missing meta short-circuits load before the opts guard).
    const seed = new RedisCheckpointer(redisOrThrow());
    await seed.setMeta(R("opts-throw"), { dagId: D("d"), startedAt: new Date(), nodeCount: 1 });
    const cp = new RedisCheckpointer(redisOrThrow());
    const opts = {
      get expectedDagFingerprint(): string {
        throw new Error("hostile opts getter");
      },
    } as CheckpointerLoadOpts;
    const result = await cp.load(R("opts-throw"), opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
      if (result.error.kind === "cache-error") {
        expect(result.error.message).toContain("could not inspect options");
      }
    }
  });

  test("a stateful expectedDagFingerprint getter cannot make the gate and the comparison disagree", async () => {
    const cp = new RedisCheckpointer(redisOrThrow());
    const runId = makeRunId();
    await cp.setMeta(R(runId), {
      dagId: D("d"),
      startedAt: new Date(),
      nodeCount: 1,
      dagFingerprint: "stored-fp",
    });

    // First read returns undefined (gate skipped), later reads return the
    // stored value — a per-read getter would make a fresh gate pass but a
    // fresh comparison pass too; the snapshot-once discipline means the
    // comparison sees exactly what the gate saw.
    const calls = [undefined, "stored-fp", "stored-fp"];
    const opts = {
      get expectedDagFingerprint(): string | undefined {
        return calls.shift();
      },
    } as CheckpointerLoadOpts;
    const result = await cp.load(R(runId), opts);
    // Gate saw undefined → legacy no-check behaviour, exactly one read.
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2); // the getter was read ONCE, not three times
  });

  // Round-19 sfh-2: the Redis read-side codec applies the file codec's shape
  // gates before restoring branded ID domains. Corrupt meta bytes must
  // settle as `checkpoint-corrupt` — never flow negative/Infinity/string
  // counts or non-string ids into consumers as a "valid" checkpoint — and a
  // corrupt node row must drop into `corruptNodeAddresses`, not into the map.
  test.each([
    ["negative nodeCount", { nodeCount: -7 }],
    ["string nodeCount", { nodeCount: "3" }],
    ["non-finite nodeCount (JSON null)", { nodeCount: 1e999 }],
    ["missing nodeCount", { nodeCount: undefined }],
    ["non-string dagId", { dagId: 42 }],
    ["colon-bearing dagId", { dagId: "tenant:dag" }],
    ["non-string startedAt", { startedAt: 123 }],
    ["non-string createdAt", { createdAt: null }],
  ])("corrupt stored meta (%s) settles as typed checkpoint-corrupt", async (_label, mutation) => {
    const runId = makeRunId();
    const meta = {
      dagId: "d",
      startedAt: new Date().toISOString(),
      nodeCount: 1,
      createdAt: new Date().toISOString(),
      frameworkVersion: FRAMEWORK_VERSION,
      ...mutation,
    };
    await redisOrThrow().set(`chkpt:${runId}:meta`, JSON.stringify(meta), "EX", 300);
    const result = await cp.load(R(runId));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("checkpoint-corrupt");
      if (result.error.kind === "checkpoint-corrupt") {
        expect(result.error.message).toContain("deserialize failed");
      }
    }
  });

  test("a non-string nodeId in a stored node row drops the row as corrupt, never into the map", async () => {
    const runId = makeRunId();
    await cp.setMeta(R(runId), { dagId: D("d"), startedAt: new Date(), nodeCount: 2 });
    await cp.saveNode(R(runId), {
      nodeId: N("good"),
      output: { v: 1 },
      completedAt: new Date(),
    });
    await redisOrThrow().hset(
      `chkpt:${runId}`,
      "evil",
      JSON.stringify({ nodeId: 42, output: {}, completedAt: new Date().toISOString() }),
    );

    const result = await cp.load(R(runId));
    expect(result.ok).toBe(true);
    if (result.ok && result.value !== null) {
      // The corrupt row is surfaced, not silently merged.
      expect(result.value.corruptNodeAddresses).toContainEqual({ kind: "node-key", nodeKey: "evil" });
      expect(Object.keys(result.value.nodes)).toEqual(["good"]);
    }
  });
});
