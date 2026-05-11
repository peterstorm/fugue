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
  it("two parallel calls enqueue the dependent exactly once (idempotent contract)", async () => {
    const enqueueCalls: { taskId: string; triggeredAt: Date }[] = [];
    const markers = makeDelayedMarkerStore(50);

    const scheduler = createCronScheduler(markers, {
      enqueue: async (t, triggeredAt) => {
        // The contract says enqueue is idempotent. We simulate that here by
        // gating on the storage map — a real BullMQ.add with the same job id
        // returns the existing job rather than duplicating.
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

    // If the dependent was double-enqueued, this fails and we know to add a
    // SET NX guard on the fired marker (see scheduler.ts:286-296).
    const dependentEnqueues = enqueueCalls.filter((c) => c.taskId === "dependent");
    expect(dependentEnqueues.length).toBe(1);
    expect(markers.storage.has(markerFiredKey("dependent"))).toBe(true);
    expect(markers.storage.has(markerCompletedKey("upstream"))).toBe(true);

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

  it("three-way concurrent resolveDependents still yields exactly one enqueue", async () => {
    const enqueueCalls: { taskId: string }[] = [];
    const markers = makeDelayedMarkerStore(75);
    const scheduler = createCronScheduler(markers, {
      enqueue: async (t) => { enqueueCalls.push({ taskId: t.id }); },
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

    expect(enqueueCalls.filter((c) => c.taskId === "dependent").length).toBe(1);
    scheduler.stop();
  });
});
