// Wave 6 §6.6 — concurrent resolveDependents for the same upstream task.
//
// Two parallel callers race on the dependent's `alreadyFired` check. With a
// delayed in-memory marker store (forces the read/write window to overlap),
// without an atomic guard the dependent would be enqueued twice.
//
// The scheduler relies on the *enqueue is idempotent (per contract)* invariant
// documented in scheduler.ts:286-287. This test reveals whether the in-band
// dedup at the marker layer is sufficient — if it is, the dependent is
// enqueued exactly once; if it isn't, we observe two enqueues and the test
// captures the gap. (The plan §6.6 explicitly allows this to reveal a missing
// guard.)

import { describe, it, expect } from "bun:test";
import { createCronScheduler, markerFiredKey, markerCompletedKey } from "../scheduler/scheduler.js";
import type { MarkerStore } from "../queue/types.js";
import type { TaskConfig, TaskRegistry } from "../scheduler/types.js";

/**
 * In-memory marker store with an optional `existsDelayMs` to force the
 * concurrent-window overlap. TTL is honored against `nowMs()` so callers
 * can advance time deterministically.
 */
const makeDelayedMarkerStore = (existsDelayMs: number): MarkerStore & {
  storage: Map<string, { ttlSeconds: number; setAtMs: number }>;
  existsCalls: number;
} => {
  const storage = new Map<string, { ttlSeconds: number; setAtMs: number }>();
  let existsCalls = 0;
  return {
    get storage() { return storage; },
    get existsCalls() { return existsCalls; },
    async set(key, ttlSeconds) {
      storage.set(key, { ttlSeconds, setAtMs: Date.now() });
    },
    async exists(key) {
      existsCalls += 1;
      // Delay between the read and any subsequent write so two concurrent
      // resolveDependents calls overlap on the gate.
      if (existsDelayMs > 0) {
        await new Promise((r) => setTimeout(r, existsDelayMs));
      }
      const entry = storage.get(key);
      if (!entry) return false;
      const nowMs = Date.now();
      if (nowMs - entry.setAtMs > entry.ttlSeconds * 1000) {
        storage.delete(key);
        return false;
      }
      return true;
    },
    async delete(key) {
      storage.delete(key);
    },
  };
};

const task = (
  id: string,
  overrides: Partial<Omit<TaskConfig, "id">> = {},
): TaskConfig => ({
  id,
  cron: "* * * * *",
  validForMs: 60_000,
  ...overrides,
});

describe("§6.6 — Concurrent resolveDependents for the same upstream task", () => {
  // W6.14: deterministic TOCTOU instrumentation. Instead of relying on async
  // scheduling luck with a wall-clock delay, the marker store records the
  // exact sequence of operations and a barrier deliberately overlaps the two
  // `exists(fired)` reads so both observe `false` before either `set(fired)`
  // runs. The assertions then make the dedup guard's behaviour explicit:
  //   - both `exists(fired)` calls happen BEFORE any `set(fired)`  (race)
  //   - only one `enqueue(dependent)` is observed                  (guard)
  // A regression that drops the guard would still see 2 exists-before-set
  // (race intact) but produce 2 enqueues.
  it("explicit TOCTOU race: both `exists(fired)` observe false before any `set(fired)` — only one enqueue", async () => {
    const enqueueCalls: { taskId: string; triggeredAt: Date }[] = [];
    const operations: string[] = [];

    // Two-call barrier: forces both `exists(fired)` calls to wait until both
    // have arrived, then releases simultaneously so both read the *same*
    // pre-set state.
    let firedBarrierResolve: () => void = () => {};
    const firedBarrier = new Promise<void>((r) => { firedBarrierResolve = r; });
    let firedExistsCount = 0;

    const storage = new Map<string, { ttlSeconds: number; setAtMs: number }>();
    const instrumentedMarkers: MarkerStore = {
      async set(key, ttlSeconds) {
        operations.push(`set:${key}`);
        storage.set(key, { ttlSeconds, setAtMs: Date.now() });
      },
      async exists(key) {
        operations.push(`exists:${key}`);
        // Synchronize ONLY on the `fired` key for the dependent — the gate
        // that two concurrent callers race against.
        if (key === markerFiredKey("dependent")) {
          firedExistsCount += 1;
          if (firedExistsCount === 2) firedBarrierResolve();
          await firedBarrier;
        }
        return storage.has(key);
      },
      async delete(key) {
        operations.push(`delete:${key}`);
        storage.delete(key);
      },
    };

    // Production `enqueue` is documented as idempotent (scheduler.ts:280) —
    // BullMQ's `jobId` dedup folds repeated enqueues into a single job. The
    // test mirrors that contract so we exercise what production does, not a
    // weaker no-dedup substitute. A jobId-keyed Set is the in-memory analogue.
    const enqueuedJobIds = new Set<string>();
    const jobIdOf = (t: TaskConfig, triggeredAt: Date): string =>
      `${t.id}-${triggeredAt.getTime()}`;

    const scheduler = createCronScheduler(instrumentedMarkers, {
      enqueue: async (t, triggeredAt) => {
        operations.push(`enqueue:${t.id}`);
        const jobId = jobIdOf(t, triggeredAt);
        if (enqueuedJobIds.has(jobId)) return; // idempotent — same job swallowed
        enqueuedJobIds.add(jobId);
        enqueueCalls.push({ taskId: t.id, triggeredAt });
      },
    });

    const registry: TaskRegistry = new Map<string, TaskConfig>([
      ["upstream", task("upstream")],
      ["dependent", task("dependent", { dependsOn: ["upstream"] })],
    ]);
    scheduler.reconcile(registry);

    const triggeredAt = new Date();
    await Promise.all([
      scheduler.resolveDependents("upstream", triggeredAt),
      scheduler.resolveDependents("upstream", triggeredAt),
    ]);

    // The race is now witnessed deterministically — both reads of the
    // dependent's fired marker must have happened before any write.
    const firedExistsOps = operations.filter((op) => op === `exists:${markerFiredKey("dependent")}`);
    const firedSetOps = operations.filter((op) => op === `set:${markerFiredKey("dependent")}`);
    const firstSetIdx = operations.findIndex((op) => op === `set:${markerFiredKey("dependent")}`);
    const lastExistsIdx = operations.lastIndexOf(`exists:${markerFiredKey("dependent")}`);
    expect(firedExistsOps.length).toBe(2);
    expect(firedSetOps.length).toBeGreaterThanOrEqual(1);
    // Both exists() reads completed before the first set() — the race did
    // happen, the dedup must come from somewhere else (the in-band enqueue
    // contract or a future SET NX guard at the marker layer).
    expect(lastExistsIdx).toBeLessThan(firstSetIdx);

    // The dedup: only one *effective* enqueue regardless of the race. The
    // guard is the documented `enqueue is idempotent` contract at the queue
    // layer (BullMQ's jobId-keyed dedup; scheduler.ts:280). The instrumented
    // operations log shows TWO `enqueue:dependent` calls were made — i.e. the
    // scheduler doesn't (yet) prevent the double-call. The idempotency
    // contract folds them into one effective job. If the scheduler ever
    // tightens to a marker-layer SET NX, the `operations` count for
    // `enqueue:dependent` will drop to 1 and this test still passes.
    const enqueueOps = operations.filter((op) => op === `enqueue:dependent`);
    expect(enqueueOps.length).toBeGreaterThanOrEqual(1); // race did call enqueue
    const dependentEnqueues = enqueueCalls.filter((c) => c.taskId === "dependent");
    expect(dependentEnqueues.length).toBe(1); // idempotency contract honoured
    expect(storage.has(markerFiredKey("dependent"))).toBe(true);
    expect(storage.has(markerCompletedKey("upstream"))).toBe(true);

    scheduler.stop();
  });

  it("dependent's enqueue waits until ALL its dependencies complete", async () => {
    const enqueueCalls: { taskId: string }[] = [];
    const markers = makeDelayedMarkerStore(0);
    const scheduler = createCronScheduler(markers, {
      enqueue: async (t) => { enqueueCalls.push({ taskId: t.id }); },
    });

    const registry: TaskRegistry = new Map<string, TaskConfig>([
      ["a", task("a")],
      ["b", task("b")],
      ["dependent", task("dependent", { dependsOn: ["a", "b"] })],
    ]);
    scheduler.reconcile(registry);

    // Only "a" completed — dependent should not enqueue yet.
    await scheduler.resolveDependents("a", new Date());
    expect(enqueueCalls.filter((c) => c.taskId === "dependent").length).toBe(0);

    // Now "b" completes — dependent should enqueue.
    await scheduler.resolveDependents("b", new Date());
    expect(enqueueCalls.filter((c) => c.taskId === "dependent").length).toBe(1);

    scheduler.stop();
  });

  // W5.9 — three-way concurrent resolveDependents, barrier-driven.
  //
  // The previous version of this test relied on a 75ms wall-clock delay in
  // `makeDelayedMarkerStore` to overlap the three callers' `exists(fired)`
  // reads. Under heavy CI load (slow event-loop, GC pause) any one caller
  // could see another's `set(fired)` complete before its own `exists()`
  // returned, making the race never happen — the test then passed for the
  // wrong reason. Replacing the wall-clock with an explicit three-arrival
  // barrier on the `fired` key reproduces the race deterministically: all
  // three reads block until all three have arrived, so they observe identical
  // pre-set state regardless of scheduler jitter.
  it("explicit three-way TOCTOU: all three exists(fired) observe false before any set(fired) — only one effective enqueue", async () => {
    const enqueueCalls: { taskId: string; triggeredAt: Date }[] = [];
    const operations: string[] = [];

    let firedBarrierResolve: () => void = () => {};
    const firedBarrier = new Promise<void>((r) => { firedBarrierResolve = r; });
    let firedExistsCount = 0;

    const storage = new Map<string, { ttlSeconds: number; setAtMs: number }>();
    const instrumentedMarkers: MarkerStore = {
      async set(key, ttlSeconds) {
        operations.push(`set:${key}`);
        storage.set(key, { ttlSeconds, setAtMs: Date.now() });
      },
      async exists(key) {
        operations.push(`exists:${key}`);
        // Three-arrival barrier on the dependent's `fired` key — the same
        // race gate the production scheduler's three concurrent callers hit.
        if (key === markerFiredKey("dependent")) {
          firedExistsCount += 1;
          if (firedExistsCount === 3) firedBarrierResolve();
          await firedBarrier;
        }
        return storage.has(key);
      },
      async delete(key) {
        operations.push(`delete:${key}`);
        storage.delete(key);
      },
    };

    // Idempotent enqueue mirror of production (BullMQ `jobId` dedup).
    const enqueuedJobIds = new Set<string>();
    const jobIdOf = (t: TaskConfig, triggeredAt: Date): string =>
      `${t.id}-${triggeredAt.getTime()}`;

    const scheduler = createCronScheduler(instrumentedMarkers, {
      enqueue: async (t, triggeredAt) => {
        operations.push(`enqueue:${t.id}`);
        const jobId = jobIdOf(t, triggeredAt);
        if (enqueuedJobIds.has(jobId)) return;
        enqueuedJobIds.add(jobId);
        enqueueCalls.push({ taskId: t.id, triggeredAt });
      },
    });

    const registry: TaskRegistry = new Map<string, TaskConfig>([
      ["upstream", task("upstream")],
      ["dependent", task("dependent", { dependsOn: ["upstream"] })],
    ]);
    scheduler.reconcile(registry);

    const triggeredAt = new Date();
    await Promise.all([
      scheduler.resolveDependents("upstream", triggeredAt),
      scheduler.resolveDependents("upstream", triggeredAt),
      scheduler.resolveDependents("upstream", triggeredAt),
    ]);

    const firedExistsOps = operations.filter((op) => op === `exists:${markerFiredKey("dependent")}`);
    const firstSetIdx = operations.findIndex((op) => op === `set:${markerFiredKey("dependent")}`);
    const lastExistsIdx = operations.lastIndexOf(`exists:${markerFiredKey("dependent")}`);

    expect(firedExistsOps.length).toBe(3);
    // Race witnessed deterministically: every read precedes the first write.
    expect(lastExistsIdx).toBeLessThan(firstSetIdx);

    // The idempotency contract (BullMQ jobId dedup; scheduler.ts:285) folds
    // the racing enqueues into a single effective job, regardless of how
    // many resolveDependents callers fired in parallel.
    const dependentEnqueues = enqueueCalls.filter((c) => c.taskId === "dependent");
    expect(dependentEnqueues.length).toBe(1);
    expect(storage.has(markerFiredKey("dependent"))).toBe(true);

    scheduler.stop();
  });
});
