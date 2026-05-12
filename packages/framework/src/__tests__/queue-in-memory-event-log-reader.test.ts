// Wave 4.3 — symmetric `EventLogReader` over the in-memory backend.
// Mirrors the Redis-backed `createRedisStreamReader` contract so replay-to-
// timestamp tests do not need a live Redis.

import { describe, it, expect } from "bun:test";

import {
  createInMemoryBackend,
  createInMemoryEventLogReader,
} from "../queue/index.js";

describe("createInMemoryEventLogReader", () => {
  it("returns the events appended by the worker on the persisted job", async () => {
    const backend = createInMemoryBackend();
    const queue = backend.createQueue<string, undefined>("evt-queue");
    backend.createWorker<unknown, unknown>("evt-queue", async (job) => {
      await job.appendEvent({ kind: "first" });
      await job.appendEvent({ kind: "second" });
    });

    await queue.enqueue("job-1", { state: "s0", context: undefined });
    await queue.drain();

    const reader = createInMemoryEventLogReader(backend);
    const events = await reader.readEvents("evt-queue", "job-1");

    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.event as { kind: string }).kind)).toEqual([
      "first",
      "second",
    ]);
    for (const e of events) {
      expect(typeof e.recordedAtMs).toBe("number");
      expect(e.recordedAtMs).toBeGreaterThan(0);
    }
  });

  it("returns an empty array for an unknown (queueName, jobId)", async () => {
    const backend = createInMemoryBackend();
    const reader = createInMemoryEventLogReader(backend);

    expect(await reader.readEvents("missing-queue", "missing-job")).toEqual([]);
  });

  it("filters events in [fromMs, toMs) (half-open)", async () => {
    const backend = createInMemoryBackend();
    const queue = backend.createQueue<string, undefined>("range-queue");
    backend.createWorker<unknown, unknown>("range-queue", async (job) => {
      await job.appendEvent({ kind: "a" });
      // sleep one ms so the recordedAtMs separates if Date.now is ticking
      await new Promise((r) => setTimeout(r, 2));
      await job.appendEvent({ kind: "b" });
      await new Promise((r) => setTimeout(r, 2));
      await job.appendEvent({ kind: "c" });
    });

    await queue.enqueue("range-job", { state: "s0", context: undefined });
    await queue.drain();

    const reader = createInMemoryEventLogReader(backend);
    const all = await reader.readEvents("range-queue", "range-job");
    expect(all).toHaveLength(3);

    const midTs = all[1].recordedAtMs;
    const sliced = await reader.readEventsBetween(
      "range-queue",
      "range-job",
      midTs,
      midTs + 1,
    );
    // Half-open: only the entry at exactly midTs is included.
    expect(sliced.map((e) => (e.event as { kind: string }).kind)).toEqual(["b"]);

    const upToMid = await reader.readEventsBetween(
      "range-queue",
      "range-job",
      0,
      midTs,
    );
    expect(upToMid.map((e) => (e.event as { kind: string }).kind)).toEqual(["a"]);
  });

  it("rejects non-finite or reversed [fromMs, toMs] bounds", async () => {
    const backend = createInMemoryBackend();
    const reader = createInMemoryEventLogReader(backend);

    await expect(
      reader.readEventsBetween("q", "j", Number.NaN, 100),
    ).rejects.toThrow(RangeError);
    await expect(
      reader.readEventsBetween("q", "j", 100, 50),
    ).rejects.toThrow(RangeError);
  });

  it("persists events across retries on the same (queue, jobId)", async () => {
    const backend = createInMemoryBackend();
    const queue = backend.createQueue<string, undefined>("retry-queue", {
      defaultAttempts: 3,
    });
    let attempt = 0;
    backend.createWorker<unknown, unknown>("retry-queue", async (job) => {
      attempt += 1;
      await job.appendEvent({ kind: "attempt", n: attempt });
      if (attempt < 3) throw new Error("not yet");
    });

    await queue.enqueue("retry-job", { state: "s0", context: undefined });
    await queue.drain();

    const reader = createInMemoryEventLogReader(backend);
    const events = await reader.readEvents("retry-queue", "retry-job");
    expect(events.map((e) => (e.event as { kind: string; n: number }).n)).toEqual([
      1, 2, 3,
    ]);
  });
});
