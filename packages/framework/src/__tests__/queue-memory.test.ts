// Tests for in-memory queue backend — FR-040, FR-043, Gap-4
// Covers: enqueue→drain, FIFO order, onFailed callback, appendEvent,
//         MarkerStore TTL, MarkerStore clear-before-TTL.

import {
  describe,
  it,
  expect,
} from "bun:test";
import {
  createInMemoryBackend,
  adaptInMemoryJob,
  createInMemoryMarkerStore,
} from "../queue/index.js";
import type { JobLike } from "../state-machine/types.js";

// Helper to wait for setTimeout callbacks to fire in real-timer tests.
const tick = (ms = 5): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------------------
// createInMemoryBackend — enqueue → drain
// ---------------------------------------------------------------------------

describe("createInMemoryBackend", () => {
  it("invokes worker with the enqueued job on drain", async () => {
    const backend = createInMemoryBackend();
    const received: unknown[] = [];

    const queue = backend.createQueue<string, undefined>("test-queue");
    backend.createWorker<unknown, unknown>(
      "test-queue",
      async (job) => {
        received.push(job.data.state);
      },
    );

    await queue.enqueue("j1", { state: "hello", context: undefined });
    await queue.drain();

    expect(received).toEqual(["hello"]);
  });

  it("drains multiple jobs in FIFO order", async () => {
    const backend = createInMemoryBackend();
    const order: string[] = [];

    const queue = backend.createQueue<string, undefined>("fifo-queue");
    backend.createWorker<unknown, unknown>("fifo-queue", async (job) => {
      order.push(job.data.state as string);
    });

    await queue.enqueue("j1", { state: "first", context: undefined });
    await queue.enqueue("j2", { state: "second", context: undefined });
    await queue.enqueue("j3", { state: "third", context: undefined });
    await queue.drain();

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("deduplicates when jobId matches an existing entry", async () => {
    const backend = createInMemoryBackend();
    const received: unknown[] = [];

    const queue = backend.createQueue<string, undefined>("dedup-queue");
    backend.createWorker<unknown, unknown>("dedup-queue", async (job) => {
      received.push(job.data.state);
    });

    await queue.enqueue("j1", { state: "original", context: undefined }, { jobId: "dup-key" });
    await queue.enqueue("j2", { state: "duplicate", context: undefined }, { jobId: "dup-key" });
    await queue.drain();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("original");
  });

  it("fires onFailed when worker throws", async () => {
    const backend = createInMemoryBackend();
    const failures: Array<{ id: string; err: unknown; attempts: number; max: number }> = [];

    const queue = backend.createQueue<string, undefined>("fail-queue");
    const worker = backend.createWorker<unknown, unknown>(
      "fail-queue",
      async (_job) => {
        throw new Error("worker boom");
      },
    );

    worker.onFailed((id, err, attempts, max) => {
      failures.push({ id, err, attempts, max });
    });

    await queue.enqueue("j-fail", { state: "data", context: undefined }, { attempts: 1 });
    await queue.drain();

    expect(failures).toHaveLength(1);
    expect(failures[0].id).toBe("j-fail");
    expect(failures[0].err).toBeInstanceOf(Error);
    expect((failures[0].err as Error).message).toBe("worker boom");
  });

  it("retries up to per-job attempts before giving up", async () => {
    const backend = createInMemoryBackend();
    let callCount = 0;
    const failures: number[] = [];

    const queue = backend.createQueue<string, undefined>("retry-queue");
    const worker = backend.createWorker<unknown, unknown>(
      "retry-queue",
      async (_job) => {
        callCount++;
        throw new Error("always fail");
      },
    );

    worker.onFailed((_id, _err, attempts, _max) => {
      failures.push(attempts);
    });

    await queue.enqueue("j-retry", { state: "data", context: undefined }, { attempts: 3 });
    await queue.drain();

    expect(callCount).toBe(3);
    // onFailed called once per attempt
    expect(failures).toEqual([1, 2, 3]);
  });

  it("_events exposes enqueued entries per queue name", async () => {
    const backend = createInMemoryBackend();
    const queue = backend.createQueue<number, undefined>("ev-queue");

    await queue.enqueue("j1", { state: 42, context: undefined });
    await queue.enqueue("j2", { state: 99, context: undefined });

    const entries = backend._events.get("ev-queue");
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(2);
    expect(entries![0].data).toEqual({ state: 42, context: undefined });
    expect(entries![1].data).toEqual({ state: 99, context: undefined });
  });

  it("_events is empty after drain (entries consumed)", async () => {
    const backend = createInMemoryBackend();
    const queue = backend.createQueue<string, undefined>("drain-ev-queue");
    backend.createWorker<unknown, unknown>("drain-ev-queue", async () => {});

    await queue.enqueue("j1", { state: "x", context: undefined });
    await queue.drain();

    const entries = backend._events.get("drain-ev-queue");
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// adaptInMemoryJob — appendEvent stores into event log
// ---------------------------------------------------------------------------

describe("adaptInMemoryJob", () => {
  it("returns a JobLike with correct initial data", () => {
    const job = adaptInMemoryJob({ state: "idle", context: { n: 0 } });
    expect(job.data).toEqual({ state: "idle", context: { n: 0 } });
  });

  it("appendEvent stores events in order, wrapped in RecordedEvent envelopes", async () => {
    const job = adaptInMemoryJob({ state: "start", context: {} });
    await job.appendEvent({ type: "A" });
    await job.appendEvent({ type: "B" });
    await job.appendEvent({ type: "C" });

    const withEvents = job as JobLike<unknown, unknown> & {
      events: readonly { recordedAtMs: number; event: unknown }[];
    };
    expect(withEvents.events.map((e) => e.event)).toEqual([
      { type: "A" },
      { type: "B" },
      { type: "C" },
    ]);
    // Every entry has a numeric recordedAtMs stamped at append time.
    expect(withEvents.events.every((e) => typeof e.recordedAtMs === "number")).toBe(true);
  });

  it("updateData mutates snapshot and data reflects new value", async () => {
    const job = adaptInMemoryJob({ state: "start", context: { x: 1 } });
    await job.updateData({ state: "done", context: { x: 2 } });
    expect(job.data).toEqual({ state: "done", context: { x: 2 } });
  });

  it("updateProgress is observable", async () => {
    const job = adaptInMemoryJob({ state: "s", context: {} });
    await job.updateProgress(75);
    const withProg = job as unknown as JobLike<unknown, unknown> & { progress: number };
    expect(withProg.progress).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// createInMemoryMarkerStore — TTL and immediate delete
// Uses real timers with tiny (ms) TTLs. The implementation uses
// setTimeout/clearTimeout so it is compatible with fake timer injection.
// ---------------------------------------------------------------------------

describe("createInMemoryMarkerStore", () => {
  it("key exists immediately after set", async () => {
    const store = createInMemoryMarkerStore();
    // Use a tiny fractional second so TTL doesn't fire during the test
    await store.set("k1", 100); // 100 s
    expect(await store.exists("k1")).toBe(true);
    await store.delete("k1"); // cleanup
  });

  it("key does not exist before set", async () => {
    const store = createInMemoryMarkerStore();
    expect(await store.exists("missing")).toBe(false);
  });

  it("key expires after TTL elapses (real timers, tiny TTL)", async () => {
    const store = createInMemoryMarkerStore();
    // TTL = 0.005s = 5ms — will fire after at most ~5ms
    await store.set("ttl-key", 0.005);

    // Immediately after set — key should exist
    expect(await store.exists("ttl-key")).toBe(true);

    // Wait for timer to fire (10ms is more than 5ms)
    await tick(20);
    expect(await store.exists("ttl-key")).toBe(false);
  });

  it("key is gone immediately after delete (before TTL)", async () => {
    const store = createInMemoryMarkerStore();
    await store.set("del-key", 100); // won't expire

    expect(await store.exists("del-key")).toBe(true);

    await store.delete("del-key");
    expect(await store.exists("del-key")).toBe(false);
  });

  it("re-setting a key resets its TTL", async () => {
    const store = createInMemoryMarkerStore();
    // Set with 10ms TTL
    await store.set("reset-key", 0.010);

    // Wait 6ms — not yet expired
    await tick(6);
    expect(await store.exists("reset-key")).toBe(true);

    // Re-set with fresh 10ms TTL
    await store.set("reset-key", 0.010);

    // Wait another 6ms — original timer would have fired at 10ms total,
    // but the re-set reset the countdown, so key still alive (only 6ms of new TTL elapsed)
    await tick(6);
    expect(await store.exists("reset-key")).toBe(true);

    // Now wait past the new TTL (10ms more)
    await tick(15);
    expect(await store.exists("reset-key")).toBe(false);
  });

  it("delete on non-existent key is a no-op", async () => {
    const store = createInMemoryMarkerStore();
    await expect(store.delete("ghost")).resolves.toBeUndefined();
    expect(await store.exists("ghost")).toBe(false);
  });

  it("multiple independent keys can coexist with different TTLs", async () => {
    const store = createInMemoryMarkerStore();
    await store.set("short", 0.010); // 10ms
    await store.set("long", 100);    // 100s — effectively permanent during test

    // After 20ms: short expired, long still alive
    await tick(20);
    expect(await store.exists("short")).toBe(false);
    expect(await store.exists("long")).toBe(true);

    await store.delete("long"); // cleanup
  });

  it("throws RangeError when ttlSeconds === 0", async () => {
    const store = createInMemoryMarkerStore();
    await expect(store.set("k", 0)).rejects.toThrow(RangeError);
  });

  it("throws RangeError when ttlSeconds is negative", async () => {
    const store = createInMemoryMarkerStore();
    await expect(store.set("k", -1)).rejects.toThrow(RangeError);
  });

  it("throws RangeError when ttlSeconds is NaN", async () => {
    const store = createInMemoryMarkerStore();
    await expect(store.set("k", NaN)).rejects.toThrow(RangeError);
  });

  it("throws RangeError when ttlSeconds is Infinity", async () => {
    const store = createInMemoryMarkerStore();
    await expect(store.set("k", Infinity)).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// createWorker — input validation
// ---------------------------------------------------------------------------

describe("createQueue validation", () => {
  it("throws RangeError when defaultAttempts is 0", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createQueue("q", { defaultAttempts: 0 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when defaultAttempts is negative", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createQueue("q", { defaultAttempts: -1 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when defaultAttempts is NaN", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createQueue("q", { defaultAttempts: NaN }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when defaultAttempts is Infinity", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createQueue("q", { defaultAttempts: Infinity }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when defaultAttempts is -Infinity", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createQueue("q", { defaultAttempts: -Infinity }),
    ).toThrow(RangeError);
  });

  it("accepts defaultAttempts: 1 without throwing", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createQueue("q", { defaultAttempts: 1 }),
    ).not.toThrow();
  });
});

describe("createWorker validation", () => {
  it("throws RangeError when concurrency is 0", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: 0 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when concurrency is negative", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: -5 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when concurrency is NaN", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: NaN }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when concurrency is Infinity", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: Infinity }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when concurrency is -Infinity", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: -Infinity }),
    ).toThrow(RangeError);
  });

  it("accepts concurrency: 1 without throwing", () => {
    const backend = createInMemoryBackend();
    expect(() =>
      backend.createWorker("q", async () => {}, { concurrency: 1 }),
    ).not.toThrow();
  });
});
