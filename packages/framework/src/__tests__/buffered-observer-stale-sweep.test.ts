/**
 * Test that the BufferedObserver's sweep mechanism clears buffers for runs
 * that never emit a `run-end` event (preventing unbounded memory growth).
 */
import { describe, test, expect } from "bun:test";
import { BufferedObserver } from "../observer/buffered.js";
import { NoopObserver } from "../observer/observer.js";
import { alwaysOn } from "../observer/policy.js";
import type { ObserverEvent } from "../types/events.js";
import { N, R, D } from "./_id-helpers.js";

describe("BufferedObserver — stale buffer sweep", () => {
  test("evicts orphaned run buffers after TTL expires", () => {
    let clock = 1000;
    const observer = new BufferedObserver(new NoopObserver(), alwaysOn(), {
      ttlMs: 5000,
      sweepIntervalMs: 0, // disable automatic sweep — we call evictStale() manually
      now: () => clock,
    });

    // Emit run-start + node-start (no run-end — orphaned)
    const runStartEvent: ObserverEvent = {
      type: "run-start",
      runId: R("orphan-run"),
      dagId: D("test"),
      timestamp: new Date(clock),
    };
    observer.observe(runStartEvent);

    const nodeStartEvent: ObserverEvent = {
      type: "node-start",
      runId: R("orphan-run"),
      dagId: D("test"),
      nodeId: N("a"),
      sideEffects: { kind: "none" },
      timestamp: new Date(clock),
    };
    observer.observe(nodeStartEvent);

    // Before TTL: sweep should NOT evict
    clock = 4000;
    observer.evictStale();
    expect(observer.evicted).toBe(0);

    // After TTL: sweep should evict the orphaned buffer
    clock = 7000;
    observer.evictStale();
    expect(observer.evicted).toBe(1);

    observer.close();
  });

  test("does not evict buffers that receive run-end within TTL", () => {
    let clock = 1000;
    const events: ObserverEvent[] = [];
    const inner = { observe: (e: ObserverEvent) => { events.push(e); } };
    const observer = new BufferedObserver(inner, alwaysOn(), {
      ttlMs: 5000,
      sweepIntervalMs: 0,
      now: () => clock,
    });

    // Start a run
    observer.observe({
      type: "run-start",
      runId: R("healthy-run"),
      dagId: D("test"),
      timestamp: new Date(clock),
    });

    // Complete before TTL
    clock = 3000;
    observer.observe({
      type: "run-end",
      runId: R("healthy-run"),
      dagId: D("test"),
      status: "ok",
      duration: 2000,
      timestamp: new Date(clock),
    });

    // Sweep after TTL — buffer should already be flushed & removed
    clock = 7000;
    observer.evictStale();
    expect(observer.evicted).toBe(0);
    // run-end should have been replayed to inner
    expect(events.some(e => e.type === "run-end")).toBe(true);

    observer.close();
  });

  test("multiple orphaned runs are all evicted", () => {
    let clock = 1000;
    const observer = new BufferedObserver(new NoopObserver(), alwaysOn(), {
      ttlMs: 3000,
      sweepIntervalMs: 0,
      now: () => clock,
    });

    // Start 3 orphaned runs
    for (const id of ["r1", "r2", "r3"]) {
      observer.observe({
        type: "run-start",
        runId: R(id),
        dagId: D("test"),
        timestamp: new Date(clock),
      });
    }

    clock = 5000;
    observer.evictStale();
    expect(observer.evicted).toBe(3);

    observer.close();
  });
});
