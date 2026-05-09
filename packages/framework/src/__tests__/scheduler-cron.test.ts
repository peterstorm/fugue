// CronScheduler integration tests — FR-064, SC-007
// Uses injected `now` clock + real short-delay timers for timer-based tests.

import { describe, it, expect, mock } from "bun:test";
import { createCronScheduler } from "../scheduler/scheduler.js";
import { markerFiredKey } from "../scheduler/scheduler.js";
import type { TaskConfig, TaskRegistry } from "../scheduler/types.js";
import type { MarkerStore } from "../queue/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRegistry(
  entries: Array<{ id: string; cron?: string; validForMs?: number; dependsOn?: string[] }>,
): TaskRegistry {
  return new Map(
    entries.map((e) => [
      e.id,
      {
        id: e.id,
        cron: e.cron ?? "* * * * *",
        validForMs: e.validForMs ?? 60_000,
        dependsOn: e.dependsOn,
      } satisfies TaskConfig,
    ]),
  );
}

/** In-memory MarkerStore — stores keys with optional expiry */
function makeMarkerStore(): MarkerStore & { clear(): void } {
  const store = new Map<string, number>(); // key → expiry epoch ms (Infinity = never)

  return {
    async set(key, ttlSeconds) {
      store.set(key, Date.now() + ttlSeconds * 1000);
    },
    async exists(key) {
      const exp = store.get(key);
      if (exp === undefined) return false;
      if (exp === Infinity) return true;
      return Date.now() < exp;
    },
    async delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

/**
 * Fault-injection marker store.
 * `failOn(key, op)` returns true → that call throws instead of succeeding.
 */
function makeFaultyMarkerStore(opts: {
  failOn: (key: string, op: "set" | "exists" | "delete") => boolean;
}): MarkerStore & { clear(): void } {
  const base = makeMarkerStore();
  return {
    async set(key, ttlSeconds) {
      if (opts.failOn(key, "set")) throw new Error(`Injected set failure for key "${key}"`);
      return base.set(key, ttlSeconds);
    },
    async exists(key) {
      if (opts.failOn(key, "exists")) throw new Error(`Injected exists failure for key "${key}"`);
      return base.exists(key);
    },
    async delete(key) {
      if (opts.failOn(key, "delete")) throw new Error(`Injected delete failure for key "${key}"`);
      return base.delete(key);
    },
    clear() {
      base.clear();
    },
  };
}

/**
 * Returns a `now` supplier that makes the next `* * * * *` fire happen in
 * `delayMs` milliseconds of real wall-clock time.
 *
 * Strategy: set the "fake now" to the millisecond just before a minute
 * boundary so that cron-parser's next() returns a date that is roughly
 * `delayMs` ms in the future relative to real time.
 */
function makeNowSupplierForDelay(delayMs: number): () => Date {
  // Find the nearest upcoming minute boundary
  const realNow = Date.now();
  const nextMinuteBoundary = Math.ceil(realNow / 60_000) * 60_000;
  // We want: cronNextDate - fakeNow = delayMs
  // cronNextDate = nextMinuteBoundary (or the one after)
  // fakeNow = nextMinuteBoundary - delayMs
  const fakeNowMs = nextMinuteBoundary - delayMs;
  const fakeDate = new Date(fakeNowMs);
  return () => fakeDate;
}

/** Helper: wait for `ms` real milliseconds */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Timer-based tests (use real short delays via injected now)
// ---------------------------------------------------------------------------

describe("createCronScheduler — reconcile", () => {
  it("arms a timer that fires the task when the cron time arrives", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();

    // Place the next minute boundary 30ms from now (real time)
    const getNow = makeNowSupplierForDelay(30);

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    scheduler.reconcile(makeRegistry([{ id: "A" }]));

    // Before the timer fires
    expect(enqueuedTasks).toHaveLength(0);

    // Wait long enough for the 30ms timer to fire + async settle
    await wait(80);

    // The task must have fired at least once; may fire more if the re-arm delay is short
    expect(enqueuedTasks.length).toBeGreaterThanOrEqual(1);
    expect(enqueuedTasks[0]!.id).toBe("A");

    scheduler.stop();
  }, 500);

  it("does NOT fire before the cron time", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();

    // Place the next fire 200ms away — we'll only wait 50ms
    const getNow = makeNowSupplierForDelay(200);

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    scheduler.reconcile(makeRegistry([{ id: "A" }]));

    await wait(50); // only half the delay

    expect(enqueuedTasks).toHaveLength(0);

    scheduler.stop();
  }, 500);

  it("stop() clears all timers — no fires after stop()", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();

    const getNow = makeNowSupplierForDelay(30);

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    scheduler.reconcile(makeRegistry([{ id: "A" }]));
    scheduler.stop(); // cancel immediately

    await wait(80); // wait past the would-be fire time

    expect(enqueuedTasks).toHaveLength(0);
  }, 500);

  it("reconcile removes a task that is no longer in desired registry", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();

    const getNow = makeNowSupplierForDelay(50);

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    // Arm A and B
    scheduler.reconcile(makeRegistry([{ id: "A" }, { id: "B" }]));
    // Remove A
    scheduler.reconcile(makeRegistry([{ id: "B" }]));

    await wait(120);

    const firedIds = enqueuedTasks.map((t) => t.id);
    expect(firedIds).not.toContain("A");
    expect(firedIds).toContain("B");

    scheduler.stop();
  }, 500);

  it("reconcile re-arms a task with updated config", async () => {
    const enqueuedTasks: Array<{ id: string; cron: string }> = [];
    const markers = makeMarkerStore();

    // First config: fires in 50ms (minute boundary 50ms away)
    const firstNow = makeNowSupplierForDelay(50);

    let currentNow = firstNow;
    const scheduler = createCronScheduler(markers, {
      now: () => currentNow(),
      enqueue: async (task) => {
        enqueuedTasks.push({ id: task.id, cron: task.cron });
      },
    });

    scheduler.reconcile(makeRegistry([{ id: "A", cron: "* * * * *" }]));

    // Update with hourly cron — this re-arms with a 3600s delay, so it won't fire soon
    // cron-parser with hourly cron from near the beginning of the hour → next fire ~3600s
    scheduler.reconcile(makeRegistry([{ id: "A", cron: "0 * * * *" }]));

    // Wait past the original 50ms window
    await wait(100);

    // The hourly task should NOT have fired (delay is ~3600s, not 50ms)
    const hourlyFires = enqueuedTasks.filter((e) => e.cron === "0 * * * *");
    expect(hourlyFires).toHaveLength(0);

    scheduler.stop();
  }, 500);

  it("skips cyclic tasks during reconcile", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();

    const getNow = makeNowSupplierForDelay(30);

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    // Cycle: A→B→A
    const cyclicReg: TaskRegistry = new Map([
      ["A", { id: "A", cron: "* * * * *", validForMs: 60_000, dependsOn: ["B"] }],
      ["B", { id: "B", cron: "* * * * *", validForMs: 60_000, dependsOn: ["A"] }],
    ]);

    scheduler.reconcile(cyclicReg);
    await wait(80);

    // Neither should have been enqueued
    expect(enqueuedTasks).toHaveLength(0);

    scheduler.stop();
  }, 500);
});

// ---------------------------------------------------------------------------
// resolveDependents tests (no timers needed)
// ---------------------------------------------------------------------------

describe("createCronScheduler — resolveDependents", () => {
  it("enqueues a dependent task when upstream completes", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();
    const fakeNow = new Date("2024-01-01T00:00:00.000Z");

    const scheduler = createCronScheduler(markers, {
      now: () => fakeNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    // B depends on A
    const reg = makeRegistry([
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
    ]);
    scheduler.reconcile(reg);

    await scheduler.resolveDependents("A", fakeNow);

    expect(enqueuedTasks.map((t) => t.id)).toContain("B");

    scheduler.stop();
  });

  it("does NOT enqueue a dependent that was already fired", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();
    const fakeNow = new Date("2024-01-01T00:00:00.000Z");

    const scheduler = createCronScheduler(markers, {
      now: () => fakeNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    const reg = makeRegistry([
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
    ]);
    scheduler.reconcile(reg);

    // Pre-set the fired marker for B
    await markers.set(markerFiredKey("B"), 3600);

    await scheduler.resolveDependents("A", fakeNow);

    const bEnqueues = enqueuedTasks.filter((t) => t.id === "B");
    expect(bEnqueues).toHaveLength(0);

    scheduler.stop();
  });

  it("does not enqueue dependent when not all its upstream tasks have completed", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();
    const fakeNow = new Date("2024-01-01T00:00:00.000Z");

    const scheduler = createCronScheduler(markers, {
      now: () => fakeNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    // C depends on both A and B
    const reg = makeRegistry([
      { id: "A" },
      { id: "B" },
      { id: "C", dependsOn: ["A", "B"] },
    ]);
    scheduler.reconcile(reg);

    // Only A completes
    await scheduler.resolveDependents("A", fakeNow);

    // C should NOT be enqueued yet
    expect(enqueuedTasks.map((t) => t.id)).not.toContain("C");

    // B completes
    await scheduler.resolveDependents("B", fakeNow);

    // Now C should be enqueued
    expect(enqueuedTasks.map((t) => t.id)).toContain("C");

    scheduler.stop();
  });

  it("enqueues exactly once when resolveDependents is called twice (idempotent)", async () => {
    const enqueuedTasks: TaskConfig[] = [];
    const markers = makeMarkerStore();
    const fakeNow = new Date("2024-01-01T00:00:00.000Z");

    const scheduler = createCronScheduler(markers, {
      now: () => fakeNow,
      enqueue: async (task) => { enqueuedTasks.push(task); },
    });

    const reg = makeRegistry([
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
    ]);
    scheduler.reconcile(reg);

    await scheduler.resolveDependents("A", fakeNow);
    await scheduler.resolveDependents("A", fakeNow); // duplicate

    const bEnqueues = enqueuedTasks.filter((t) => t.id === "B");
    expect(bEnqueues).toHaveLength(1);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// stop() tests
// ---------------------------------------------------------------------------

describe("createCronScheduler — stop()", () => {
  it("stop() prevents further task execution", async () => {
    const fired: string[] = [];
    const markers = makeMarkerStore();

    const getNow = makeNowSupplierForDelay(50);

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => { fired.push(task.id); },
    });

    scheduler.reconcile(makeRegistry([{ id: "A" }, { id: "B" }, { id: "C" }]));
    scheduler.stop(); // cancel all

    await wait(120);

    expect(fired).toHaveLength(0);
  }, 500);
});

// ---------------------------------------------------------------------------
// Error-path tests
// ---------------------------------------------------------------------------

describe("createCronScheduler — handleFire enqueue error path", () => {
  it("logs error, re-arms task, and writes fired marker on successful retry when first enqueue throws", async () => {
    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };

    let enqueueCallCount = 0;
    const markers = makeMarkerStore();

    // Fire in 30ms real time
    const getNow = makeNowSupplierForDelay(30);

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => {
        enqueueCallCount++;
        if (enqueueCallCount === 1) {
          throw new Error("simulated enqueue failure");
        }
      },
    });

    scheduler.reconcile(makeRegistry([{ id: "A" }]));

    // Wait for the timer to fire
    await wait(80);

    try {
      // After re-arming, the second enqueue succeeds and the fired marker is written for that successful fire.
      const firedMarkerExists = await markers.exists(markerFiredKey("A"));
      expect(firedMarkerExists).toBe(true);

      // error must be logged for the first (failed) enqueue
      const hasEnqueueError = errors.some((e) => e.includes("enqueue failed") && e.includes('"A"'));
      expect(hasEnqueueError).toBe(true);
    } finally {
      console.error = originalConsoleError;
      scheduler.stop();
    }
  }, 500);
});

describe("createCronScheduler — resolveDependents per-dependent error path", () => {
  it("continues processing remaining dependents when one enqueue throws", async () => {
    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };

    const enqueuedIds: string[] = [];
    let enqueueCallCount = 0;
    const markers = makeMarkerStore();
    const fakeNow = new Date("2024-01-01T00:00:00.000Z");

    const scheduler = createCronScheduler(markers, {
      now: () => fakeNow,
      enqueue: async (task) => {
        enqueueCallCount++;
        if (enqueueCallCount === 1) {
          // First dependent enqueue fails
          throw new Error("simulated dep enqueue failure");
        }
        enqueuedIds.push(task.id);
      },
    });

    // A has two dependents: B and C. B's enqueue will throw, C should still be enqueued.
    const reg = makeRegistry([
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
    ]);
    scheduler.reconcile(reg);

    try {
      await scheduler.resolveDependents("A", fakeNow);

      // C must still have been enqueued even though B's enqueue threw
      expect(enqueuedIds).toContain("C");

      // error must be logged
      const hasDepError = errors.some((e) => e.includes("enqueue failed for dependent task"));
      expect(hasDepError).toBe(true);
    } finally {
      console.error = originalConsoleError;
      scheduler.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Fault-injection tests (marker store failures)
// ---------------------------------------------------------------------------

describe("createCronScheduler — markers.set(completed) failure in resolveDependents", () => {
  it("logs error and does not enqueue any dependents when completed marker write fails", async () => {
    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };

    const enqueuedIds: string[] = [];
    const fakeNow = new Date("2024-01-01T00:00:00.000Z");

    // Fail on the completed:* key write
    const markers = makeFaultyMarkerStore({
      failOn: (key, op) => op === "set" && key.includes(":completed"),
    });

    const scheduler = createCronScheduler(markers, {
      now: () => fakeNow,
      enqueue: async (task) => { enqueuedIds.push(task.id); },
    });

    const reg = makeRegistry([
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
    ]);
    scheduler.reconcile(reg);

    try {
      await scheduler.resolveDependents("A", fakeNow);

      // error logged
      const hasCompletedError = errors.some((e) => e.includes("markers.set(completed) failed"));
      expect(hasCompletedError).toBe(true);

      // no dependents enqueued
      expect(enqueuedIds).toHaveLength(0);
    } finally {
      console.error = originalConsoleError;
      scheduler.stop();
    }
  });
});

describe("createCronScheduler — markers.set(fired) failure in handleFire", () => {
  it("logs error but still enqueues the task when fired marker write fails (enqueue is idempotent)", async () => {
    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };

    const enqueuedIds: string[] = [];

    // Fire in 30ms real time; fail the fired marker write
    const getNow = makeNowSupplierForDelay(30);
    const markers = makeFaultyMarkerStore({
      failOn: (key, op) => op === "set" && key.includes(":fired"),
    });

    const scheduler = createCronScheduler(markers, {
      now: getNow,
      enqueue: async (task) => { enqueuedIds.push(task.id); },
    });

    scheduler.reconcile(makeRegistry([{ id: "A" }]));

    // Wait for the timer to fire and async settle
    await wait(80);

    try {
      // error logged
      const hasFiredError = errors.some((e) => e.includes('markers.set(fired) failed for task "A"'));
      expect(hasFiredError).toBe(true);

      // enqueue WAS called — marker write happens after enqueue in the new ordering
      expect(enqueuedIds).toContain("A");
    } finally {
      console.error = originalConsoleError;
      scheduler.stop();
    }
  }, 500);
});

describe("createCronScheduler — dependent markers.set(fired) failure does not block enqueue", () => {
  it("logs error but still enqueues the dependent whose fired marker write fails (enqueue is idempotent)", async () => {
    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[0])); };

    const enqueuedIds: string[] = [];
    const fakeNow = new Date("2024-01-01T00:00:00.000Z");

    // Fail the fired marker write only for dependent "B"
    const markers = makeFaultyMarkerStore({
      failOn: (key, op) => op === "set" && key === "scheduler:B:fired",
    });

    const scheduler = createCronScheduler(markers, {
      now: () => fakeNow,
      enqueue: async (task) => { enqueuedIds.push(task.id); },
    });

    // A has two dependents: B and C. B's fired marker write will fail (after enqueue).
    const reg = makeRegistry([
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
    ]);
    scheduler.reconcile(reg);

    try {
      await scheduler.resolveDependents("A", fakeNow);

      // error logged for B's fired marker failure
      const hasBFiredError = errors.some((e) =>
        e.includes('markers.set(fired) failed for dependent "B"'),
      );
      expect(hasBFiredError).toBe(true);

      // B IS enqueued — enqueue happens before marker write in the new ordering
      expect(enqueuedIds).toContain("B");

      // C is also enqueued
      expect(enqueuedIds).toContain("C");
    } finally {
      console.error = originalConsoleError;
      scheduler.stop();
    }
  });
});
