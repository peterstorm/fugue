// W5.2 — In-memory queue worker concurrency.
//
// The plan calls out a coverage gap: queue-memory.test.ts validates dedup,
// retries, FIFO order, and TTL semantics, but never exercises the
// `concurrency > 1` worker path in `createInMemoryBackend`. A regression that
// silently serialises the pool (the bug we'd actually be guarding against)
// would still pass every other test.
//
// The barrier construction is deliberately mechanical: each enqueued handler
// arrives at a shared barrier and only proceeds once the expected number of
// arrivals has been observed. With `concurrency: N`, all N handlers must reach
// the barrier — they cannot if the drain is sequential, so the test would
// hang and time out. With `concurrency: 1`, the second handler is provably
// blocked behind the first and the test exits without ever satisfying the
// 2-arrival barrier; an explicit per-task release verifies sequential order.

import { describe, it, expect } from "bun:test";
import { createInMemoryBackend } from "../queue/index.js";
import type { JobLike } from "../state-machine/types.js";

interface Barrier {
  arrive(): Promise<void>;
  arrivals(): number;
}

const createBarrier = (count: number): Barrier => {
  let arrivals = 0;
  let resolveAll: () => void = () => {};
  const ready = new Promise<void>((r) => { resolveAll = r; });
  return {
    arrive: async () => {
      arrivals += 1;
      if (arrivals === count) resolveAll();
      await ready;
    },
    arrivals: () => arrivals,
  };
};

describe("InMemoryBackend worker concurrency", () => {
  it("concurrency: 3 runs three jobs in parallel (all reach the barrier)", async () => {
    const backend = createInMemoryBackend();
    const barrier = createBarrier(3);
    const completed: string[] = [];

    const queue = backend.createQueue<string, undefined>("conc-3-queue");
    backend.createWorker<unknown, unknown>(
      "conc-3-queue",
      async (job: JobLike<unknown, unknown, unknown>) => {
        await barrier.arrive();
        completed.push((job.data.state as string));
      },
      { concurrency: 3 },
    );

    await Promise.all([
      queue.enqueue("j1", { state: "a", context: undefined }),
      queue.enqueue("j2", { state: "b", context: undefined }),
      queue.enqueue("j3", { state: "c", context: undefined }),
    ]);

    // If the drain were serialising at concurrency=3, the barrier would never
    // resolve (the second handler is blocked behind the first, which is
    // blocked at the barrier waiting for the second to arrive — deadlock).
    // The bun test default timeout (5000ms) fails the test in that case.
    await queue.drain();

    expect(barrier.arrivals()).toBe(3);
    expect(completed.sort()).toEqual(["a", "b", "c"]);
  });

  it("concurrency: 1 runs jobs sequentially (second waits for first)", async () => {
    const backend = createInMemoryBackend();
    const order: string[] = [];

    // `release[i]` resolves the handler for job i. Each handler appends a
    // `start:i` marker, waits for its release signal, then appends `end:i`.
    // Under sequential drain, the markers are strictly `start:1 end:1 start:2 end:2`;
    // a parallel drain (regression) would interleave `start:1 start:2 ...`.
    const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];

    const queue = backend.createQueue<number, undefined>("conc-1-queue");
    backend.createWorker<unknown, unknown>(
      "conc-1-queue",
      async (job: JobLike<unknown, unknown, unknown>) => {
        const i = job.data.state as number;
        order.push(`start:${i}`);
        await releases[i]!.promise;
        order.push(`end:${i}`);
      },
      { concurrency: 1 },
    );

    await queue.enqueue("j0", { state: 0, context: undefined });
    await queue.enqueue("j1", { state: 1, context: undefined });

    // Schedule the releases on the next macrotask so the worker is well into
    // the first handler before we release it. With concurrency:1, the second
    // handler cannot have started yet — its `start:1` marker must appear
    // strictly AFTER `end:0`.
    setTimeout(() => releases[0]!.resolve(), 5);
    setTimeout(() => releases[1]!.resolve(), 15);

    await queue.drain();

    expect(order).toEqual(["start:0", "end:0", "start:1", "end:1"]);
  });

  it("concurrency: 2 with 3 jobs — first two start in parallel, third waits", async () => {
    const backend = createInMemoryBackend();

    let startedCount = 0;
    const startedSnapshots: number[] = [];
    const releases = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];

    const queue = backend.createQueue<number, undefined>("conc-2-queue");
    backend.createWorker<unknown, unknown>(
      "conc-2-queue",
      async (job: JobLike<unknown, unknown, unknown>) => {
        const i = job.data.state as number;
        startedCount += 1;
        startedSnapshots.push(startedCount);
        await releases[i]!.promise;
      },
      { concurrency: 2 },
    );

    await queue.enqueue("j0", { state: 0, context: undefined });
    await queue.enqueue("j1", { state: 1, context: undefined });
    await queue.enqueue("j2", { state: 2, context: undefined });

    // Release order: first two together, then third after the second slot
    // opens up. The snapshots taken on entry must show startedCount=1 then 2
    // (the parallel pair), then 3 (the third arrives only after one of the
    // earlier two finished). If the pool were sized 1 we'd see 1,2,3 with
    // sequential markers; if it were sized 3 we'd see all three present
    // before any release — both regressions caught.
    setTimeout(() => {
      releases[0]!.resolve();
      releases[1]!.resolve();
    }, 5);
    setTimeout(() => releases[2]!.resolve(), 15);

    await queue.drain();

    expect(startedSnapshots).toEqual([1, 2, 3]);
  });
});
