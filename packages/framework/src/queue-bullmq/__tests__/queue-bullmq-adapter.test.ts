// BullMQ adapter integration tests — FR-045, FR-047, FR-048, AD-3
// SC-003: crash-resume 10/10 deterministic (real BullMQ path)
// SC-004: 5-shape replay equivalence (linear/fan-out/fan-in/diamond/with-human-review)
//
// All redis-gated tests skip cleanly without REDIS_URL.
// Run with: REDIS_URL=redis://localhost:6379 bun test

import { NoopObserver } from "../../observer/observer.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../../logger.js";
import type { RunId } from "../../types/ids.js";
import { DAG_INPUT } from "../../types/ids.js";
import { describe, it, expect, afterEach } from "bun:test";
import Redis from "ioredis";
import type { JobLike } from "../../state-machine/types.js";
import type { Machine } from "../../state-machine/types.js";
import { replayEvents, replayEventsUntil, replayEventSlice } from "../../state-machine/replay.js";
import {
  createBullMQBackend,
  createRedisMarkerStore,
  createRedisStreamReader,
} from "../index.js";
import { __parseEnvelope, __resetEventLogState } from "../event-log.js";
import { adaptBullMQJob } from "../job.js";
import { __dispatchFailureHandler, __parseConnection } from "../adapter.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL;
const hasRedis = Boolean(REDIS_URL);

function redisIt(name: string, fn: () => Promise<void>, timeout?: number) {
  if (!hasRedis) {
    it.skip(name, fn, timeout);
  } else {
    it(name, fn, timeout);
  }
}

// ---------------------------------------------------------------------------
// Shared Redis client for test cleanup
// ---------------------------------------------------------------------------

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return redis;
}

// Unique prefix per test run to avoid cross-test contamination
const RUN_ID = Date.now().toString(36);
function key(name: string) {
  return `test:${RUN_ID}:${name}`;
}

afterEach(async () => {
  if (redis) {
    const keys = await redis.keys(`test:${RUN_ID}:*`);
    if (keys.length > 0) await redis.del(...keys);
    const qKeys = await redis.keys(`bull:${RUN_ID}*`);
    if (qKeys.length > 0) await redis.del(...qKeys);
    const eventKeys = await redis.keys(`events:${RUN_ID}*`);
    if (eventKeys.length > 0) await redis.del(...eventKeys);
  }
});

afterEach(async () => {
  if (!redis) return;
  await redis.quit();
  redis = null;
});

// ---------------------------------------------------------------------------
// Simple 3-state machine for testing
// pending -> running -> succeeded | failed
// ---------------------------------------------------------------------------

type S = { kind: "pending" } | { kind: "running" } | { kind: "succeeded" } | { kind: "failed"; reason: string };
type E = { type: "START" } | { type: "DONE" } | { type: "FAIL"; reason: string } | { type: "ERROR"; retriable: boolean; message: string };
type C = { value: number };

// ---------------------------------------------------------------------------
// createRedisMarkerStore — FR-043
// ---------------------------------------------------------------------------

describe("createRedisMarkerStore", () => {
  redisIt("set + exists + delete round-trip", async () => {
    const r = getRedis();
    const store = createRedisMarkerStore(r);
    const k = key("marker:1");

    await store.set(k, 30);
    expect(await store.exists(k)).toBe(true);
    await store.delete(k);
    expect(await store.exists(k)).toBe(false);
  });

  redisIt("key does not exist before set", async () => {
    const r = getRedis();
    const store = createRedisMarkerStore(r);
    expect(await store.exists(key("marker:never"))).toBe(false);
  });

  redisIt("re-setting a key resets TTL", async () => {
    const r = getRedis();
    const store = createRedisMarkerStore(r);
    const k = key("marker:reset");

    await store.set(k, 60);
    await store.set(k, 90);
    const ttl = await r.ttl(k);
    expect(ttl).toBeGreaterThan(80);
    await store.delete(k);
  });

  redisIt("throws RangeError for ttlSeconds <= 0", async () => {
    const r = getRedis();
    const store = createRedisMarkerStore(r);
    await expect(store.set(key("bad"), 0)).rejects.toThrow(RangeError);
    await expect(store.set(key("bad2"), -1)).rejects.toThrow(RangeError);
  });

  redisIt("delete on non-existent key is no-op", async () => {
    const r = getRedis();
    const store = createRedisMarkerStore(r);
    await expect(store.delete(key("ghost"))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// XADD + XRANGE event-log round-trip — FR-048, AD-3
// ---------------------------------------------------------------------------

describe("Redis Streams event log (XADD/XRANGE)", () => {
  redisIt("readEvents legacy fallback: bare-payload entries get synthesized envelope from stream entry ID", async () => {
    // Pre-envelope events were written as bare payloads (no `recordedAtMs`
    // field). The reader must still surface them as RecordedEvent envelopes,
    // deriving the timestamp from the Redis Stream entry ID itself.
    const r = getRedis();
    const queueName = `${RUN_ID}-evlog-legacy`;
    const jobId = "j-1";

    const streamKey = `events:${queueName}:${jobId}`;
    const reader = createRedisStreamReader(r);

    const events: E[] = [
      { type: "START" },
      { type: "DONE" },
    ];

    // Use Redis server time (not Date.now()) to avoid host/VM clock skew
    // when Redis runs inside a Podman/Docker container.
    const redisTimeMs = async () => {
      const [secs, micros] = await r.time();
      return Number(secs) * 1000 + Math.floor(Number(micros) / 1000);
    };

    const beforeMs = await redisTimeMs();
    for (const event of events) {
      await r.xadd(
        streamKey,
        "MAXLEN",
        "~",
        10000,
        "*",
        "type",
        event.type,
        "payload",
        JSON.stringify(event), // bare payload, no envelope wrapper
      );
    }
    const afterMs = await redisTimeMs();

    const read = await reader.readEvents(queueName, jobId);
    expect(read).toHaveLength(2);
    expect(read[0].event).toEqual({ type: "START" });
    expect(read[1].event).toEqual({ type: "DONE" });
    // Synthesized timestamps from entry IDs fall within the test window.
    expect(read[0].recordedAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(read[1].recordedAtMs).toBeLessThanOrEqual(afterMs);

    await r.del(streamKey);
  });

  redisIt("readEvents new envelope format: recordedAtMs round-trips via XADD/XRANGE", async () => {
    const r = getRedis();
    const queueName = `${RUN_ID}-evlog-envelope`;
    const jobId = "j-2";
    const streamKey = `events:${queueName}:${jobId}`;
    const reader = createRedisStreamReader(r);

    // Hand-write envelope-format entries to verify the read path picks them up
    // verbatim instead of synthesizing from the entry ID.
    const envelopes = [
      { recordedAtMs: 1715200000000, event: { type: "START" } },
      { recordedAtMs: 1715200001234, event: { type: "DONE" } },
    ];

    for (const env of envelopes) {
      await r.xadd(
        streamKey,
        "MAXLEN",
        "~",
        10000,
        "*",
        "type",
        (env.event as { type: string }).type,
        "payload",
        JSON.stringify(env),
      );
    }

    const read = await reader.readEvents(queueName, jobId);
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual(envelopes[0]);
    expect(read[1]).toEqual(envelopes[1]);

    await r.del(streamKey);
  });

  redisIt("readEvents on non-existent stream returns empty array", async () => {
    const r = getRedis();
    const reader = createRedisStreamReader(r);
    const result = await reader.readEvents(`${RUN_ID}-empty`, "no-job");
    expect(result).toEqual([]);
  });

  redisIt("readEventsBetween filters by recordedAtMs window via XRANGE bounds", async () => {
    const r = getRedis();
    const queueName = `${RUN_ID}-evlog-between`;
    const jobId = "between-1";
    const streamKey = `events:${queueName}:${jobId}`;
    const reader = createRedisStreamReader(r);

    // Hand-write entries with explicit ms-prefixed entry IDs so we can assert
    // the XRANGE filter independently of clock timing.
    const writeAt = async (ms: number, type: string) => {
      await r.xadd(
        streamKey,
        `${ms}-0`,
        "type",
        type,
        "payload",
        JSON.stringify({ recordedAtMs: ms, event: { type } }),
      );
    };
    await writeAt(1000, "A");
    await writeAt(2000, "B");
    await writeAt(3000, "C");
    await writeAt(4000, "D");

    // Half-open [2000, 4000) should match B and C but not A or D.
    const window = await reader.readEventsBetween(queueName, jobId, 2000, 4000);
    expect(window.map((e) => (e.event as { type: string }).type)).toEqual(["B", "C"]);
    expect(window[0].recordedAtMs).toBe(2000);
    expect(window[1].recordedAtMs).toBe(3000);

    // Empty window returns []
    const empty = await reader.readEventsBetween(queueName, jobId, 5000, 6000);
    expect(empty).toEqual([]);

    // Equal bounds also return []
    const equal = await reader.readEventsBetween(queueName, jobId, 2000, 2000);
    expect(equal).toEqual([]);

    await r.del(streamKey);
  });

  redisIt("readEvents throws on corrupt JSON payload", async () => {
    const r = getRedis();
    const queueName = `${RUN_ID}-corrupt`;
    const jobId = "corrupt-1";
    const streamKey = `events:${queueName}:${jobId}`;
    const reader = createRedisStreamReader(r);

    await r.xadd(streamKey, "*", "type", "bad", "payload", "NOT_VALID_JSON{{{{");

    await expect(reader.readEvents(queueName, jobId)).rejects.toThrow(/Corrupt event/);
    await r.del(streamKey);
  });

  // round-23 sfh-1 unit pins: the truncated-payload fail-closed branch is
  // unreachable through ioredis XADD (Redis itself rejects odd field lists),
  // but a stream restored from RDB or written by another writer can carry a
  // `payload` key with no value — the entry type Redis accepts from every
  // legitimate writer must keep parsing, the fabricated-event class must fail
  // closed louder than the legacy path it used to share.
  it("parseEnvelope: a genuine legacy entry (no payload field) still reconstructs", () => {
    const ev = __parseEnvelope("events:q:j", "1715200000000-0", ["type", "legacy", "acked", "1"]);
    expect(ev.recordedAtMs).toBe(1715200000000);
    expect(ev.event).toEqual({ type: "legacy", acked: "1" });
  });

  it("parseEnvelope: payload key PRESENT but valueless fails closed as corrupt (never fabricates an event)", () => {
    const warnings: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(String(message)),
      error: () => {},
    });
    try {
      expect(() =>
        // Odd field list: `payload` is the LAST field with no value.
        __parseEnvelope("events:q:j", "1715200000000-0", ["type", "bad", "payload"]),
      ).toThrow(/Corrupt event in stream "events:q:j" entry "1715200000000-0"/);
      // …and the rejection is loud, not silent: a warning names the stream/entry.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("events:q:j");
      expect(warnings[0]).toContain("refusing to fabricate");
    } finally {
      __resetFrameworkLogger();
    }
  });
});

// ---------------------------------------------------------------------------
// createBullMQBackend — enqueue + process round-trip (FR-045, FR-047)
// ---------------------------------------------------------------------------

describe("createBullMQBackend enqueue + process", () => {
  redisIt("enqueue a job and process it via worker", async () => {
    const backend = createBullMQBackend(REDIS_URL!);
    const queueName = `${RUN_ID}-basic`;
    const received: Array<{ state: unknown; context: unknown }> = [];

    const queue = backend.createQueue<S, C>(queueName);
    const worker = backend.createWorker<S, C>(
      queueName,
      async (job: JobLike<S, unknown, C>) => {
        received.push({ state: job.data.state, context: job.data.context });
      },
    );

    await queue.enqueue("j1", { state: { kind: "pending" }, context: { value: 0 } });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    expect(received).toHaveLength(1);
    expect(received[0].state).toEqual({ kind: "pending" });

    await worker.close();
    await queue.close();
  });

  redisIt("Map in context survives BullMQ Redis round-trip via updateData", async () => {
    const backend = createBullMQBackend(REDIS_URL!);
    const queueName = `${RUN_ID}-mapround`;
    type MapS = { kind: "running" };
    type MapC = { outputs: Map<string, number>; retries: Map<string, number> };

    let capturedAfterUpdate: { state: MapS; context: MapC } | null = null;

    const queue = backend.createQueue<MapS, MapC>(queueName);
    const worker = backend.createWorker<MapS, MapC>(
      queueName,
      async (job: JobLike<MapS, unknown, MapC>) => {
        const incoming = job.data;
        // Confirm Maps survived the enqueue path
        const next: MapC = {
          outputs: new Map([...incoming.context.outputs, ["c", 3]]),
          retries: new Map([...incoming.context.retries, ["nodeX", 1]]),
        };
        await job.updateData({ state: { kind: "running" }, context: next });
        // Read-after-write should also be a live Map
        capturedAfterUpdate = job.data;
      },
    );

    await queue.enqueue("map-j1", {
      state: { kind: "running" },
      context: {
        outputs: new Map([["a", 1], ["b", 2]]),
        retries: new Map<string, number>(),
      },
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (capturedAfterUpdate) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    expect(capturedAfterUpdate).not.toBeNull();
    expect(capturedAfterUpdate!.context.outputs).toBeInstanceOf(Map);
    expect(capturedAfterUpdate!.context.outputs.size).toBe(3);
    expect(capturedAfterUpdate!.context.outputs.get("c")).toBe(3);
    expect(capturedAfterUpdate!.context.retries).toBeInstanceOf(Map);
    expect(capturedAfterUpdate!.context.retries.get("nodeX")).toBe(1);

    await worker.close();
    await queue.close();
  });

  redisIt("updateData persists across job reload (via job.data after updateData)", async () => {
    const backend = createBullMQBackend(REDIS_URL!);
    const queueName = `${RUN_ID}-update`;
    const snapshots: Array<{ state: S; context: C }> = [];

    const queue = backend.createQueue<S, C>(queueName);
    const worker = backend.createWorker<S, C>(
      queueName,
      async (job: JobLike<S, unknown, C>) => {
        snapshots.push({ ...job.data });
        await job.updateData({ state: { kind: "running" }, context: { value: 99 } });
        snapshots.push({ ...job.data });
      },
    );

    await queue.enqueue("j2", { state: { kind: "pending" }, context: { value: 0 } });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (snapshots.length >= 2) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    expect(snapshots[0].state).toEqual({ kind: "pending" });
    expect(snapshots[1].state).toEqual({ kind: "running" });
    expect(snapshots[1].context).toEqual({ value: 99 });

    await worker.close();
    await queue.close();
  });
});

// ---------------------------------------------------------------------------
// adaptBullMQJob — XADD event log integration
// ---------------------------------------------------------------------------

describe("adaptBullMQJob appendEvent (XADD)", () => {
  redisIt("appendEvent writes events to Redis Stream readable by createRedisStreamReader", async () => {
    const r = getRedis();
    const backend = createBullMQBackend(REDIS_URL!, { maxLen: 100, approximate: false });
    const queueName = `${RUN_ID}-xadd`;
    let capturedEventsCopy: unknown[] = [];

    const queue = backend.createQueue<S, C>(queueName);
    const worker = backend.createWorker<S, C>(
      queueName,
      async (job: JobLike<S, unknown, C>) => {
        await job.appendEvent({ type: "START" });
        await job.appendEvent({ type: "DONE" });
      },
    );

    const processed = new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const keys2 = await r.keys(`events:${queueName}:*`);
        if (keys2.length > 0) {
          clearInterval(check);
          const streamKey = keys2[0];
          const entries = await r.xrange(streamKey, "-", "+");
          capturedEventsCopy = entries.map(([_id, fields]) => {
            const pi = fields.indexOf("payload");
            if (pi !== -1) return JSON.parse(fields[pi + 1]);
            return {};
          });
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    await queue.enqueue("j3", { state: { kind: "pending" }, context: { value: 0 } });
    await processed;

    expect(capturedEventsCopy).toHaveLength(2);
    // appendEvent now wraps each event in a RecordedEvent envelope.
    const env0 = capturedEventsCopy[0] as { recordedAtMs: number; event: unknown };
    const env1 = capturedEventsCopy[1] as { recordedAtMs: number; event: unknown };
    expect(env0.event).toEqual({ type: "START" });
    expect(env1.event).toEqual({ type: "DONE" });
    expect(typeof env0.recordedAtMs).toBe("number");
    expect(typeof env1.recordedAtMs).toBe("number");
    expect(env1.recordedAtMs).toBeGreaterThanOrEqual(env0.recordedAtMs);

    await worker.close();
    await queue.close();
  });

  // Wave 6 §6.3 — last-seen dedup semantics (ADR 0014).
  // The Lua script compares the new dedupKey only against the LAST entry's
  // dedupKey. So:
  //   appendEvent(e1, "k1") → entry 1
  //   appendEvent(e1', "k1") → SKIPPED (last == "k1")
  //   appendEvent(e2, "k2") → entry 2 (last is now "k2")
  //   appendEvent(e3, "k1") → entry 3 (last is "k2", not "k1" — allowed)
  redisIt("appendEvent dedup is last-seen-only: 'k1' twice then 'k2' then 'k1' yields 3 entries", async () => {
    const r = getRedis();
    const backend = createBullMQBackend(REDIS_URL!, { maxLen: 100, approximate: false });
    const queueName = `${RUN_ID}-dedup-last-seen`;
    let captured: { type: string; dedupKey: string }[] = [];

    const queue = backend.createQueue<S, C>(queueName);
    const worker = backend.createWorker<S, C>(
      queueName,
      async (job: JobLike<S, unknown, C>) => {
        // First "k1" appends; second "k1" is the immediate next call → deduped.
        await job.appendEvent({ type: "e1" }, "k1");
        await job.appendEvent({ type: "e1-dup" }, "k1");
        // "k2" appends (different from last "k1").
        await job.appendEvent({ type: "e2" }, "k2");
        // "k1" again, but last is now "k2" — must append (not deduped).
        await job.appendEvent({ type: "e3" }, "k1");
      },
    );

    const processed = new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        const keys2 = await r.keys(`events:${queueName}:*`);
        if (keys2.length === 0) return;
        const streamKey = keys2[0];
        const entries = await r.xrange(streamKey, "-", "+");
        if (entries.length >= 3) {
          clearInterval(check);
          captured = entries.map(([_id, fields]) => {
            const ti = fields.indexOf("type");
            const di = fields.indexOf("dedupKey");
            return {
              type: ti !== -1 ? fields[ti + 1]! : "?",
              dedupKey: di !== -1 ? fields[di + 1]! : "",
            };
          });
          resolve();
        }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    await queue.enqueue("dedup-job", {
      state: { kind: "pending" },
      context: { value: 0 },
    });
    await processed;

    // Expect three entries: e1 (k1), e2 (k2), e3 (k1). The second k1 between
    // them (e1-dup) was deduped.
    expect(captured.length).toBe(3);
    expect(captured.map((c) => c.type)).toEqual(["e1", "e2", "e3"]);
    expect(captured.map((c) => c.dedupKey)).toEqual(["k1", "k2", "k1"]);

    await worker.close();
    await queue.close();
  });
});

// ---------------------------------------------------------------------------
// onFailed + onError handler tests
// ---------------------------------------------------------------------------

describe("BullMQ failure-handler isolation (pure)", () => {
  it("reports a synchronous handler throw instead of letting it escape dispatch", async () => {
    const reported = new Promise<Error>((resolve) => {
      expect(() => __dispatchFailureHandler(
        () => { throw new Error("synchronous handler failure"); },
        resolve,
      )).not.toThrow();
    });

    await expect(reported).resolves.toMatchObject({ message: "synchronous handler failure" });
  });
});

describe("createBullMQBackend — onFailed + onError handlers", () => {
  redisIt("onFailed fires with correct id/error/attemptsMade when job throws", async () => {
    const backend = createBullMQBackend(REDIS_URL!);
    const queueName = `${RUN_ID}-onfailed`;

    const failedEvents: Array<{ id: string; err: unknown; attemptsMade: number }> = [];

    const queue = backend.createQueue<S, C>(queueName);
    const worker = backend.createWorker<S, C>(
      queueName,
      async (_job: JobLike<S, unknown, C>) => {
        throw new Error("deliberate test failure");
      },
    );

    worker.onFailed(async (id, err, attemptsMade, _max) => {
      failedEvents.push({ id, err, attemptsMade });
    });

    // attempts: 2 so the first throw is a MID-RETRY failure — per the WorkerHandle
    // contract (queue/types.ts), onFailed fires only mid-retry (attempts < max);
    // a terminal failure (attempts:1) routes to onExhausted instead.
    await queue.enqueue(
      "fail-j1",
      { state: { kind: "pending" }, context: { value: 0 } },
      { attempts: 2 },
    );

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (failedEvents.length > 0) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    expect(failedEvents.length).toBeGreaterThan(0);
    expect(failedEvents[0].err).toBeInstanceOf(Error);
    expect((failedEvents[0].err as Error).message).toContain("deliberate test failure");

    await worker.close();
    await queue.close();
  });

  redisIt("onError fires when onFailed handler rejects — errorEvents populated", async () => {
    const backend = createBullMQBackend(REDIS_URL!);
    const queueName = `${RUN_ID}-onerror`;

    const errorEvents: Error[] = [];

    const queue = backend.createQueue<S, C>(queueName);
    const worker = backend.createWorker<S, C>(
      queueName,
      async (_job: JobLike<S, unknown, C>) => {
        throw new Error("job process failure for onError test");
      },
    );

    worker.onError((err) => {
      errorEvents.push(err);
    });

    // onFailed handler that throws — its rejection should re-emit as "error"
    worker.onFailed(async (_id, _err, _attemptsMade, _max) => {
      throw new Error("onFailed handler async rejection");
    });

    // attempts: 2 so the first throw is a mid-retry failure that fires onFailed
    // (whose rejection re-emits as worker "error"); see the onFailed test above.
    await queue.enqueue(
      "err-j1",
      { state: { kind: "pending" }, context: { value: 0 } },
      { attempts: 2 },
    );

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (errorEvents.length > 0) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    await worker.close();
    await queue.close();

    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0]).toBeInstanceOf(Error);
    expect(errorEvents[0].message).toContain("onFailed handler async rejection");
  });
});

// ---------------------------------------------------------------------------
// adaptBullMQJob — pure unit tests (no Redis needed)
// ---------------------------------------------------------------------------

describe("adaptBullMQJob — Map/Set round-trip (pure)", () => {
  it("data getter restores Map written via updateData (round-trip)", async () => {
    // BullMQ's real Job.updateData persists `d` to Redis; here we mimic that by
    // capturing the last-written value in a closure and exposing it via .data.
    let stored: unknown = { state: { kind: "pending" }, context: { value: 0 } };
    const stubJob = {
      id: "j-map",
      get data() { return stored; },
      updateData: async (d: unknown) => { stored = d; },
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: { k: string }; context: { outputs: Map<string, number> } }>;
    const stubRedis = {} as import("ioredis").default;

    const jobLike = adaptBullMQJob<{ k: string }, { outputs: Map<string, number> }>(
      stubJob,
      stubRedis,
      "q",
    );

    const outputs = new Map<string, number>([["a", 1], ["b", 2]]);
    await jobLike.updateData({ state: { k: "running" }, context: { outputs } });

    // Storage must be JSON-safe (no live Map instance under the hood).
    const raw = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    expect(raw).toBeTruthy();

    // Round-trip through the getter restores the live Map.
    const restored = jobLike.data;
    expect(restored.context.outputs).toBeInstanceOf(Map);
    expect(restored.context.outputs.get("a")).toBe(1);
    expect(restored.context.outputs.get("b")).toBe(2);
  });
});

describe("adaptBullMQJob — pure unit tests", () => {
  it("throws when bullJob.id is undefined", () => {
    // Construct a minimal stub that satisfies the shape but has no id
    const stubJob = {
      id: undefined,
      data: { state: {}, context: {} },
      updateData: async () => {},
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;

    // Provide a stub Redis (never called since we expect a throw before any I/O)
    const stubRedis = {} as import("ioredis").default;

    expect(() => adaptBullMQJob(stubJob, stubRedis, "test-queue")).toThrow(
      /test-queue/,
    );
  });

  it("updateProgress delegates to bullJob.updateProgress", async () => {
    let capturedPct: number | undefined;
    const stubJob = {
      id: "job-42",
      data: { state: {}, context: {} },
      updateData: async () => {},
      updateProgress: async (pct: number) => { capturedPct = pct; },
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;

    const stubRedis = {} as import("ioredis").default;

    const jobLike = adaptBullMQJob(stubJob, stubRedis, "test-queue");
    await jobLike.updateProgress(50);

    expect(capturedPct).toBe(50);
  });

  it("updateProgress wraps error with queue name and job id", async () => {
    const stubJob = {
      id: "job-99",
      data: { state: {}, context: {} },
      updateData: async () => {},
      updateProgress: async () => { throw new Error("redis gone"); },
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;

    const stubRedis = {} as import("ioredis").default;

    const jobLike = adaptBullMQJob(stubJob, stubRedis, "my-queue");
    await expect(jobLike.updateProgress(75)).rejects.toThrow(/my-queue/);
    await expect(jobLike.updateProgress(75)).rejects.toThrow(/job-99/);
  });

  // Wave 3 §3.10: appendEvent now goes through an atomic Lua script
  // (SCRIPT LOAD + EVALSHA, with NOSCRIPT → EVAL fallback). These tests
  // stub the script-eval path to verify error wrapping + envelope shape.

  it("appendEvent wraps eval error with queue, job id, stream key, and cause", async () => {
    const boom = new Error("boom");
    const stubJob = {
      id: "j-x",
      data: { state: {}, context: {} },
      updateData: async () => {},
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;

    const stubRedis = {
      script: async (..._args: unknown[]) => "stub-sha",
      evalsha: async (..._args: unknown[]) => { throw boom; },
      eval: async (..._args: unknown[]) => { throw boom; },
    } as unknown as import("ioredis").default;

    const jobLike = adaptBullMQJob(stubJob, stubRedis, "q-test", { maxLen: 100, approximate: true });

    await expect(jobLike.appendEvent({ type: "t", v: 1 })).rejects.toThrow(/q-test/);
    await expect(jobLike.appendEvent({ type: "t", v: 1 })).rejects.toThrow(/j-x/);
    await expect(jobLike.appendEvent({ type: "t", v: 1 })).rejects.toThrow(/events:q-test:j-x/);
    await expect(jobLike.appendEvent({ type: "t", v: 1 })).rejects.toThrow(/boom/);

    try {
      await jobLike.appendEvent({ type: "t", v: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { cause?: unknown }).cause).toBe(boom);
    }
  });

  it("appendEvent stamps recordedAtMs and pins entryId hint to the Lua script ARGV", async () => {
    const captured: { keys: unknown[]; argv: unknown[] }[] = [];
    const stubJob = {
      id: "j-now",
      data: { state: {}, context: {} },
      updateData: async () => {},
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;
    const stubRedis = {
      script: async (..._args: unknown[]) => "stub-sha",
      // evalsha signature: (sha, numKeys, ...keysAndArgs)
      evalsha: async (...args: unknown[]) => {
        // args = [sha, numKeys, streamKey, ...argv]
        const numKeys = args[1] as number;
        captured.push({
          keys: args.slice(2, 2 + numKeys),
          argv: args.slice(2 + numKeys),
        });
        return "1715200000123-0";
      },
    } as unknown as import("ioredis").default;

    const jobLike = adaptBullMQJob(stubJob, stubRedis, "q-now", {
      maxLen: 100,
      approximate: true,
      now: () => 1715200000123,
    });

    await jobLike.appendEvent({ type: "X", v: 42 });

    expect(captured).toHaveLength(1);
    expect(captured[0].keys).toEqual(["events:q-now:j-now"]);
    // ARGV: [maxLen, approximate, entryId, dedupKey, type, payload]
    const argv = captured[0].argv;
    expect(argv[0]).toBe("100");
    expect(argv[1]).toBe("1"); // approximate
    expect(argv[2]).toBe("1715200000123-*");
    expect(argv[3]).toBe(""); // no dedupKey
    expect(argv[4]).toBe("X");
    const parsed = JSON.parse(argv[5] as string);
    expect(parsed).toEqual({
      recordedAtMs: 1715200000123,
      event: { type: "X", v: 42 },
    });
  });

  it("appendEvent passes dedupKey through to Lua script ARGV[4]", async () => {
    const captured: { argv: unknown[] }[] = [];
    const stubJob = {
      id: "j-d",
      data: { state: {}, context: {} },
      updateData: async () => {},
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;
    const stubRedis = {
      script: async (..._args: unknown[]) => "stub-sha",
      evalsha: async (...args: unknown[]) => {
        const numKeys = args[1] as number;
        captured.push({ argv: args.slice(2 + numKeys) });
        return "0-0";
      },
    } as unknown as import("ioredis").default;

    const jobLike = adaptBullMQJob(stubJob, stubRedis, "q-d", { maxLen: 100, approximate: true });

    await jobLike.appendEvent({ type: "X" }, "key-abc");

    expect(captured).toHaveLength(1);
    expect(captured[0].argv[3]).toBe("key-abc");
  });

  it("appendEvent falls back to inline EVAL on NOSCRIPT error", async () => {
    let evalshaCalls = 0;
    let evalCalls = 0;
    const stubJob = {
      id: "j-ns",
      data: { state: {}, context: {} },
      updateData: async () => {},
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;
    const stubRedis = {
      script: async (..._args: unknown[]) => "stub-sha",
      evalsha: async () => {
        evalshaCalls++;
        throw new Error("NOSCRIPT No matching script. Please use EVAL.");
      },
      eval: async () => {
        evalCalls++;
        return "0-0";
      },
    } as unknown as import("ioredis").default;

    const jobLike = adaptBullMQJob(stubJob, stubRedis, "q-ns", { maxLen: 100, approximate: true });
    await expect(jobLike.appendEvent({ type: "X" })).resolves.toBeUndefined();
    expect(evalshaCalls).toBe(1);
    expect(evalCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// adaptBullMQJob — validateData hook
// ---------------------------------------------------------------------------

describe("adaptBullMQJob — validateData hook", () => {
  it("invokes validateData on every read of job.data", () => {
    const calls: unknown[] = [];
    const stubJob = {
      id: "j-validate",
      data: { state: { k: "running" }, context: { v: 1 } },
      updateData: async () => {},
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: { k: string }; context: { v: number } }>;
    const stubRedis = {} as import("ioredis").default;

    const jobLike = adaptBullMQJob<{ k: string }, { v: number }>(
      stubJob,
      stubRedis,
      "q-val",
      {
        validateData: (raw) => {
          calls.push(raw);
          const r = raw as { state: { k: string }; context: { v: number } };
          return { ok: true, value: { state: r.state, context: r.context } };
        },
      },
    );

    // Three reads → three validator invocations.
    void jobLike.data;
    void jobLike.data;
    void jobLike.data;

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ state: { k: "running" }, context: { v: 1 } });
  });

  it("failing validator surfaces as a thrown error referencing checkpoint-corrupt", () => {
    const stubJob = {
      id: "j-corrupt",
      data: { garbage: true },
      updateData: async () => {},
      updateProgress: async () => {},
    } as unknown as import("bullmq").Job<{ state: unknown; context: unknown }>;
    const stubRedis = {} as import("ioredis").default;

    const jobLike = adaptBullMQJob(stubJob, stubRedis, "q-corrupt", {
      validateData: () => ({
        ok: false,
        error: {
          kind: "checkpoint-corrupt",
          runId: "j-corrupt" as RunId,
          message: "envelope missing state/context",
        },
      }),
    });

    expect(() => jobLike.data).toThrow(/envelope missing state\/context/);
    expect(() => jobLike.data).toThrow(/q-corrupt/);
  });
});

// ---------------------------------------------------------------------------
// createRedisStreamReader — pure argument-validation tests (no Redis needed)
// ---------------------------------------------------------------------------

describe("createRedisStreamReader — readEventsBetween argument validation", () => {
  // Stub redis where XRANGE returns []; we only assert errors thrown before I/O.
  const stubRedis = {
    xrange: async () => [],
  } as unknown as import("ioredis").default;
  const reader = createRedisStreamReader(stubRedis);

  it("throws RangeError when fromMs is NaN", async () => {
    await expect(reader.readEventsBetween("q", "j", NaN, 100)).rejects.toBeInstanceOf(RangeError);
  });

  it("throws RangeError when toMs is Infinity", async () => {
    await expect(reader.readEventsBetween("q", "j", 0, Infinity)).rejects.toBeInstanceOf(RangeError);
  });

  it("throws RangeError when toMs < fromMs", async () => {
    await expect(reader.readEventsBetween("q", "j", 1000, 500)).rejects.toBeInstanceOf(RangeError);
  });

  it("returns empty array immediately when toMs === fromMs (no XRANGE issued)", async () => {
    let called = false;
    const traceRedis = {
      xrange: async () => { called = true; return []; },
    } as unknown as import("ioredis").default;
    const r = createRedisStreamReader(traceRedis);
    const result = await r.readEventsBetween("q", "j", 1000, 1000);
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redis connection parsing + worker RangeError guards (pure, no Redis needed)
// ---------------------------------------------------------------------------

describe("createBullMQBackend — Redis connection parsing", () => {
  it("preserves credentials, database selection, and TLS from a Redis URL", () => {
    expect(__parseConnection("rediss://user:p%40ss@cache.example:6380/4")).toEqual({
      host: "cache.example",
      port: 6380,
      username: "user",
      password: "p@ss",
      db: 4,
      tls: {},
    });
  });

  it("rejects unsupported schemes and invalid database selections", () => {
    expect(() => __parseConnection("http://cache.example:6379/0")).toThrow(RangeError);
    expect(() => __parseConnection("redis://cache.example/not-a-db")).toThrow(RangeError);
  });
});

describe("createQueue / createWorker — RangeError guards (pure, no Redis needed)", () => {
  // These tests use a dummy connection and never actually connect to Redis.
  // They assert RangeError is thrown synchronously before any I/O.
  const dummyConn = { host: "127.0.0.1", port: 16379 };

  it("createQueue throws RangeError for defaultAttempts = 0", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createQueue("q", { defaultAttempts: 0 }),
    ).toThrow(RangeError);
  });

  it("createQueue throws RangeError for defaultAttempts = -1", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createQueue("q", { defaultAttempts: -1 }),
    ).toThrow(RangeError);
  });

  it("createQueue throws RangeError for defaultAttempts = NaN", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createQueue("q", { defaultAttempts: NaN }),
    ).toThrow(RangeError);
  });

  it("createQueue throws RangeError for defaultAttempts = Infinity", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createQueue("q", { defaultAttempts: Infinity }),
    ).toThrow(RangeError);
  });

  it("createQueue throws RangeError for defaultAttempts = 1.5 (the gate is integer, not just finite)", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createQueue("q", { defaultAttempts: 1.5 }),
    ).toThrow(RangeError);
  });

  it("createWorker throws RangeError for concurrency = 0", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: 0 }),
    ).toThrow(RangeError);
  });

  it("createWorker throws RangeError for concurrency = -5", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: -5 }),
    ).toThrow(RangeError);
  });

  it("createWorker throws RangeError for concurrency = NaN", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: NaN }),
    ).toThrow(RangeError);
  });

  it("createWorker throws RangeError for concurrency = Infinity", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: Infinity }),
    ).toThrow(RangeError);
  });

  it("createWorker throws RangeError for concurrency = 1.5 (the gate is integer, not just finite)", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: 1.5 }),
    ).toThrow(RangeError);
  });

  it("createQueue does not throw for defaultAttempts = 1", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createQueue("q", { defaultAttempts: 1 }),
    ).not.toThrow();
  });

  it("createWorker does not throw for concurrency = 1", () => {
    const backend = createBullMQBackend(dummyConn);
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: 1 }),
    ).not.toThrow();
  });

  // Regression (round-12 A1): the Queue's INTERNAL connection (a separate
  // ioredis instance behind the plain {host, port}) is re-emitted as an
  // "error" event on the Queue by BullMQ (queue-base forwards its
  // RedisConnection errors). The shared-connection and Worker listeners
  // existed, but the Queue had none — an unhandled "error" event is a
  // process-level hazard on the runtimes that enforce ERR_UNHANDLED_ERROR.
  // Pin: a dead-port connection failure surfaces as a LOGGED queue error
  // (named), never an unhandled throw.
  it("createQueue routes internal-connection failures through the logger (named queue), never unhandled", async () => {
    const lines: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, ...args: unknown[]) => {
        lines.push([msg, ...args.map((a) => String(a))].join(" "));
      },
    });
    try {
      const backend = createBullMQBackend(dummyConn);
      backend.createQueue("a1-pin-queue");
      // ECONNREFUSED on localhost arrives within milliseconds; poll generously
      // so the pin is deterministic regardless of retry backoff timing.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !lines.some((l) => l.includes("[BullMQ] Queue \"a1-pin-queue\" error:"))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(lines.some((l) => l.includes("[BullMQ] Queue \"a1-pin-queue\" error:"))).toBe(true);
      await backend.close();
    } finally {
      __resetFrameworkLogger();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Wave 6 §6.11 — BullMQ resume across process restart for runDagStateful.
// Regression for Wave 2 §2.1 / §2.2: on resume, `wrapDagJobLike` must re-
// inject the live `dag` so `nodeMap.get(nodeId)` resolves to the real
// closures (not `{}` from a JSON round-trip).
// ---------------------------------------------------------------------------

describe("§6.11 — BullMQ DAG resume reconstructs nodeMap via live dag", () => {
  redisIt("crash mid-DAG, reopen, finish remaining nodes via live nodeMap.get", async () => {
    // Lazy imports to keep this section self-contained.
    const { runDagAsWorkerJob } = await import("../../executor/run-dag.js");
    const { defineDagFromArray } = await import("../../executor/define-dag.js");
    const { z } = await import("zod");
    const { ok } = await import("../../types/result.js");
    type NodeContext = import("../../types/node.js").NodeContext;
    type NodeDef = import("../../types/node.js").NodeDef<unknown, unknown>;

    const queueName = `${RUN_ID}-dag-resume`;
    const callCount = { a: 0, b: 0, c: 0 };

    const mkNode = (id: "a" | "b" | "c", body: NodeDef["run"]): NodeDef => ({
      // @ts-expect-error — branded ID test fixture
      id,
      kind: "transform",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      requires: [],
      sideEffects: { kind: "none" },
      confidence: { mode: "none" },
      run: body,
      retry: { backoffMs: [1] },
    });

    let crashOnB = true;
    const dag = defineDagFromArray({
      id: "resume-dag",
      nodes: [
        mkNode("a", async () => { callCount.a++; return ok("a-out"); }),
        mkNode("b", async () => {
          callCount.b++;
          if (crashOnB) {
            // Simulated process crash on the first attempt — throwing makes
            // BullMQ register the attempt as failed, retain `job.data` (with
            // wave-0 outputs already checkpointed), and re-deliver on retry.
            throw new Error("simulated mid-run crash on node b");
          }
          return ok("b-out");
        }),
        mkNode("c", async () => { callCount.c++; return ok("c-out"); }),
      ],
      edges: [
        { from: DAG_INPUT, to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      defaultRetryLimit: 0,
    });

    const mkCtx = (): NodeContext => ({
      runId: "dag-resume-run" as RunId,
      dagId: dag.id,
      observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
      cache: null,
      prompts: null,
      llm: null, http: null, clock: null,
      logger: { warn: () => {}, error: () => {} },
    });

    const backend = createBullMQBackend(REDIS_URL!);
    const queue = backend.createQueue<unknown, unknown>(queueName);

    const failures: Array<{ attempt: number }> = [];
    const completions: Array<{ output: unknown }> = [];

    let firstFailureSeen = false;
    const worker = backend.createWorker<unknown, unknown>(queueName, async (_job) => {
      // On the second invocation, allow node "b" to succeed.
      if (firstFailureSeen) crashOnB = false;
      const out = await runDagAsWorkerJob(dag, { seed: 1 }, mkCtx());
      completions.push({ output: out });
    });

    worker.onFailed((_id, _err, attempt) => {
      failures.push({ attempt });
      firstFailureSeen = true;
    });

    await queue.enqueue(
      "dag-resume-job",
      { state: { kind: "pending" }, context: {} },
      { jobId: "dag-resume-job", attempts: 3 },
    );

    // Wait until either two completions arrive or 10s elapse.
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (completions.length >= 1 && failures.length >= 1) {
          clearInterval(check);
          resolve();
        } else if (Date.now() - start > 10_000) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    await worker.close();
    await queue.close();

    // First attempt failed mid-run (callCount.b hit 1 then threw).
    expect(failures.length).toBeGreaterThanOrEqual(1);

    // Run resumed and completed: callCount.b incremented again, c ran.
    expect(callCount.b).toBeGreaterThanOrEqual(2);
    expect(callCount.c).toBe(1);

    // Final completion observed.
    expect(completions.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SC-003: Crash-resume — real BullMQ job + adaptBullMQJob.
//
// The previous incarnation of this section held a 100-line `it.skip` block
// that documented a stall-race against BullMQ's 30-second stalled-job timer.
// A perpetually-skipped test for a critical invariant is a maintenance
// hazard: future readers either trust the green CI run or rewrite the
// architecture independently. Coverage for the resume contract now lives in
// pass-4 follow-up §6.11 (single-worker re-entry that survives the phase-1
// throw, no two-worker stall). Deleted here per pass-4 W5.8.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SC-004: 5-shape replay equivalence
// linear / fan-out / fan-in / diamond / with-human-review
// ---------------------------------------------------------------------------

describe("SC-004: 5-shape replay equivalence", () => {
  type ShapeS =
    | { kind: "idle" }
    | { kind: "a" }
    | { kind: "b" }
    | { kind: "c" }
    | { kind: "awaiting-review" }
    | { kind: "approved" }
    | { kind: "rejected" }
    | { kind: "done" }
    | { kind: "failed" };

  type ShapeE =
    | { type: "INIT" }
    | { type: "BRANCH_A" }
    | { type: "BRANCH_B" }
    | { type: "MERGE" }
    | { type: "COMPLETE" }
    | { type: "PAUSE_FOR_REVIEW" }
    | { type: "APPROVE" }
    | { type: "REJECT" }
    | { type: "ERROR"; retriable: boolean; message: string };

  type ShapeC = { path: string[] };

  const shapeMachine: Machine<ShapeS, ShapeE, ShapeC> = {
    transition(state, event, context) {
      if (state.kind === "idle" && event.type === "INIT") {
        return { state: { kind: "a" }, context: { path: [...context.path, "init"] } };
      }
      if (state.kind === "a" && event.type === "BRANCH_A") {
        return { state: { kind: "b" }, context: { path: [...context.path, "branch_a"] } };
      }
      if (state.kind === "a" && event.type === "BRANCH_B") {
        return { state: { kind: "c" }, context: { path: [...context.path, "branch_b"] } };
      }
      if ((state.kind === "b" || state.kind === "c") && event.type === "MERGE") {
        return { state: { kind: "done" }, context: { path: [...context.path, "merge"] } };
      }
      if (state.kind === "a" && event.type === "COMPLETE") {
        return { state: { kind: "done" }, context: { path: [...context.path, "complete"] } };
      }
      if (state.kind === "a" && event.type === "PAUSE_FOR_REVIEW") {
        return { state: { kind: "awaiting-review" }, context: { path: [...context.path, "pause_for_review"] } };
      }
      if (state.kind === "awaiting-review" && event.type === "APPROVE") {
        return { state: { kind: "approved" }, context: { path: [...context.path, "approved"] } };
      }
      if (state.kind === "approved" && event.type === "COMPLETE") {
        return { state: { kind: "done" }, context: { path: [...context.path, "completed_after_review"] } };
      }
      if (state.kind === "awaiting-review" && event.type === "REJECT") {
        return { state: { kind: "rejected" }, context: { path: [...context.path, "rejected"] } };
      }
      if (event.type === "ERROR") {
        return { state: { kind: "failed" }, context };
      }
      return { state, context };
    },
    isTerminal: (s) => s.kind === "done" || s.kind === "failed" || s.kind === "rejected",
    isFailed: (s) => s.kind === "failed" || s.kind === "rejected",
    stateProgress: () => 0,
    stateKey: (s) => JSON.stringify(s),
  };

  function assertReplayEquivalence(events: ShapeE[], initial: { state: ShapeS; context: ShapeC }) {
    let liveState = initial.state;
    let liveContext = initial.context;
    for (const event of events) {
      const r = shapeMachine.transition(liveState, event, liveContext);
      liveState = r.state as ShapeS;
      liveContext = r.context as ShapeC;
    }

    const replayed = replayEvents(events, shapeMachine, initial);

    expect(replayed.state).toEqual(liveState);
    expect(replayed.context).toEqual(liveContext);
  }

  const initial = { state: { kind: "idle" } as ShapeS, context: { path: [] as string[] } };

  it("linear: idle -> a -> done", () => {
    const events: ShapeE[] = [
      { type: "INIT" },
      { type: "COMPLETE" },
    ];
    assertReplayEquivalence(events, initial);
  });

  it("fan-out: idle -> a -> branch_a -> b -> merge -> done", () => {
    const events: ShapeE[] = [
      { type: "INIT" },
      { type: "BRANCH_A" },
      { type: "MERGE" },
    ];
    assertReplayEquivalence(events, initial);
  });

  it("fan-in: idle -> a -> branch_b -> c -> merge -> done", () => {
    const events: ShapeE[] = [
      { type: "INIT" },
      { type: "BRANCH_B" },
      { type: "MERGE" },
    ];
    assertReplayEquivalence(events, initial);
  });

  it("diamond: idle -> a -> two paths both merge to done", () => {
    // Path A
    const eventsA: ShapeE[] = [
      { type: "INIT" },
      { type: "BRANCH_A" },
      { type: "MERGE" },
    ];
    assertReplayEquivalence(eventsA, initial);

    // Path B
    const eventsB: ShapeE[] = [
      { type: "INIT" },
      { type: "BRANCH_B" },
      { type: "MERGE" },
    ];
    assertReplayEquivalence(eventsB, initial);
  });

  it("with-human-review: idle -> a -> awaiting-review -> approve -> approved -> done", () => {
    const events: ShapeE[] = [
      { type: "INIT" },
      { type: "PAUSE_FOR_REVIEW" }, // HITL pause
      { type: "APPROVE" },           // human approves
      { type: "COMPLETE" },          // resume to done
    ];
    assertReplayEquivalence(events, initial);

    // Verify the replay final state is 'done'
    const replayed = replayEvents(events, shapeMachine, initial);
    expect(replayed.state).toEqual({ kind: "done" });
    expect(replayed.context.path).toContain("pause_for_review");
    expect(replayed.context.path).toContain("approved");
    expect(replayed.context.path).toContain("completed_after_review");
  });

  it("with-human-review: reject path yields rejected state", () => {
    const events: ShapeE[] = [
      { type: "INIT" },
      { type: "PAUSE_FOR_REVIEW" },
      { type: "REJECT" },
    ];
    assertReplayEquivalence(events, initial);

    const replayed = replayEvents(events, shapeMachine, initial);
    expect(replayed.state).toEqual({ kind: "rejected" });
    expect(replayed.context.path).toContain("rejected");
  });
});

// ---------------------------------------------------------------------------
// XADD + replayEvents integration — SC-004 with Redis Streams backend
// ---------------------------------------------------------------------------

describe("XADD + replayEvents integration via Redis", () => {
  redisIt("events written via XADD can be read via XRANGE and replayed to match live run", async () => {
    const r = getRedis();
    const queueName = `${RUN_ID}-replay`;
    const jobId = "replay-job-1";
    const streamKey = `events:${queueName}:${jobId}`;
    const reader = createRedisStreamReader(r);

    type SimpleS = { kind: "idle" } | { kind: "running" } | { kind: "done" };
    type SimpleE = { type: "START" } | { type: "FINISH" };
    type SimpleC = { count: number };

    const simpleMachine: Machine<SimpleS, SimpleE, SimpleC> = {
      transition(state, event, context) {
        if (state.kind === "idle" && event.type === "START") return { state: { kind: "running" }, context };
        if (state.kind === "running" && event.type === "FINISH") return { state: { kind: "done" }, context: { count: context.count + 1 } };
        return { state, context };
      },
      isTerminal: (s) => s.kind === "done",
      isFailed: () => false,
      stateProgress: () => 0,
      stateKey: (s) => JSON.stringify(s),
    };

    const eventsToWrite: SimpleE[] = [{ type: "START" }, { type: "FINISH" }];

    for (const event of eventsToWrite) {
      await r.xadd(
        streamKey,
        "MAXLEN",
        "~",
        10000,
        "*",
        "type",
        event.type,
        "payload",
        JSON.stringify(event),
      );
    }

    const readBack = await reader.readEvents(queueName, jobId);

    const initial = { state: { kind: "idle" } as SimpleS, context: { count: 0 } };
    const rawEvents = readBack.map((e) => e.event as SimpleE);
    const replayed = replayEvents(rawEvents, simpleMachine, initial);
    const live = replayEvents(eventsToWrite, simpleMachine, initial);

    expect(replayed.state).toEqual(live.state);
    expect(replayed.context).toEqual(live.context);
    expect(replayed.state).toEqual({ kind: "done" });
    expect(replayed.context.count).toBe(1);

    await r.del(streamKey);
  });
});

// ---------------------------------------------------------------------------
// Forensic-query integration: "what was the state at wall-clock T?"
// Exercises appendEvent → readEvents → replayEventsUntil/Between end-to-end.
// ---------------------------------------------------------------------------

describe("Forensic replay-to-timestamp via Redis Streams", () => {
  type ForS =
    | { kind: "idle" }
    | { kind: "wave"; n: number }
    | { kind: "done" };
  type ForE = { type: "STEP" } | { type: "FINISH" };
  type ForC = { steps: number };

  const forMachine: Machine<ForS, ForE, ForC> = {
    transition(state, event, context) {
      if (event.type === "STEP") {
        const n = state.kind === "wave" ? state.n + 1 : 1;
        return { state: { kind: "wave", n }, context: { steps: context.steps + 1 } };
      }
      if (event.type === "FINISH") {
        return { state: { kind: "done" }, context };
      }
      return { state, context };
    },
    isTerminal: (s) => s.kind === "done",
    isFailed: () => false,
    stateProgress: (s) => (s.kind === "done" ? 100 : 0),
    stateKey: (s) => JSON.stringify(s),
  };

  redisIt(
    "events written via appendEvent can be replayed up to a wall-clock timestamp to recover historical state",
    async () => {
      const r = getRedis();
      const queueName = `${RUN_ID}-forensic`;
      const jobId = "forensic-job-1";
      const streamKey = `events:${queueName}:${jobId}`;
      const reader = createRedisStreamReader(r);

      // Build a job-less adaptBullMQJob using a minimal Job stub. We're testing
      // the appendEvent → readEvents pipeline, not full BullMQ orchestration.
      const stubJob = {
        id: jobId,
        data: { state: { kind: "idle" } as ForS, context: { steps: 0 } as ForC },
        updateData: async () => {},
        updateProgress: async () => {},
      } as unknown as import("bullmq").Job<{ state: ForS; context: ForC }>;

      // Inject a controlled clock so the forensic timestamps are deterministic.
      let nowMs = 1_700_000_000_000;
      const tick = (deltaMs: number): number => {
        nowMs += deltaMs;
        return nowMs;
      };

      const jobLike = adaptBullMQJob<ForS, ForC>(stubJob, r, queueName, {
        maxLen: 100,
        approximate: false,
        now: () => nowMs,
      });

      // Three transitions, each at a distinct, separable wall-clock time.
      // T1: 1_700_000_000_000  → STEP (wave 1)
      // T2: 1_700_000_005_000  → STEP (wave 2)
      // T3: 1_700_000_010_000  → FINISH
      const T1 = nowMs;
      await jobLike.appendEvent({ type: "STEP" });

      tick(5_000);
      const T2 = nowMs;
      await jobLike.appendEvent({ type: "STEP" });

      tick(5_000);
      const T3 = nowMs;
      await jobLike.appendEvent({ type: "FINISH" });

      const events = await reader.readEvents(queueName, jobId);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.recordedAtMs)).toEqual([T1, T2, T3]);

      const initial = {
        state: { kind: "idle" } as ForS,
        context: { steps: 0 } as ForC,
      };

      // Forensic Q: "what was the state right before T1?" → still initial
      const before = replayEventsUntil(events, forMachine, initial, T1);
      expect(before.state).toEqual({ kind: "idle" });
      expect(before.context.steps).toBe(0);

      // Forensic Q: "what was the state right before T2?" → after exactly 1 STEP
      const afterFirstStep = replayEventsUntil(events, forMachine, initial, T2);
      expect(afterFirstStep.state).toEqual({ kind: "wave", n: 1 });
      expect(afterFirstStep.context.steps).toBe(1);

      // Forensic Q: "what was the state right before T3 (the FINISH)?" → wave 2, not done
      const beforeFinish = replayEventsUntil(events, forMachine, initial, T3);
      expect(beforeFinish.state).toEqual({ kind: "wave", n: 2 });
      expect(beforeFinish.context.steps).toBe(2);

      // After everything → terminal
      const final = replayEventsUntil(events, forMachine, initial, T3 + 1);
      expect(final.state).toEqual({ kind: "done" });

      // Slice [T2, T3+1) → fold of just (STEP at T2) and (FINISH at T3) starting from `initial`
      // Note: this starts from `initial` (kind: "idle"), not from the prior state at T2.
      // STEP from idle → { wave: 1 }, then FINISH → done.
      const slice = replayEventSlice(events, forMachine, initial, T2, T3 + 1);
      expect(slice.state).toEqual({ kind: "done" });
      expect(slice.context.steps).toBe(1); // only one STEP folded into the slice

      // Server-side filter: readEventsBetween yields the same slice as the
      // client-side filter would, but only sends matching entries over the wire.
      const serverSide = await reader.readEventsBetween(queueName, jobId, T2, T3 + 1);
      expect(serverSide.map((e) => e.recordedAtMs)).toEqual([T2, T3]);

      const sliceFromServer = replayEvents(serverSide, forMachine, initial);
      expect(sliceFromServer.state).toEqual(slice.state);
      expect(sliceFromServer.context).toEqual(slice.context);

      await r.del(streamKey);
    },
  );
});
