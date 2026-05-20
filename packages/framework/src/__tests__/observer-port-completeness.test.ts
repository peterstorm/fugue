import { describe, test, expect } from "bun:test";
import type { Observer } from "../observer/observer.js";
import type { ObserverEvent } from "../types/events.js";
import { RecordingObserver, createObserver } from "../observer/observer.js";

/**
 * Post-§5 deepening: the Observer interface is a single `observe(event)` method.
 * Exhaustiveness is no longer enforced at the interface level — it's enforced
 * by ts-pattern's `.exhaustive()` in implementations that branch on event type.
 *
 * This test validates:
 * 1. The single-method interface contract works for all event types.
 * 2. `createObserver` routes events to the correct per-type handler.
 * 3. `RecordingObserver` captures all event types.
 */
describe("Observer single-method contract (§5 deepening)", () => {
  test("Observer interface requires only `observe` method", () => {
    const obs: Observer = { observe() {} };
    expect(typeof obs.observe).toBe("function");
  });

  test("RecordingObserver captures all event types via observe()", () => {
    const rec = new RecordingObserver();
    const events: ObserverEvent[] = [
      { type: "run-start", runId: "r1" as any, dagId: "d1" as any, timestamp: new Date() },
      { type: "node-start", runId: "r1" as any, dagId: "d1" as any, nodeId: "n1" as any, sideEffects: { kind: "none" }, timestamp: new Date() },
      { type: "node-end", runId: "r1" as any, dagId: "d1" as any, nodeId: "n1" as any, sideEffects: { kind: "none" }, timestamp: new Date(), duration: 10, output: null },
      { type: "run-end", runId: "r1" as any, dagId: "d1" as any, timestamp: new Date(), duration: 100, status: "ok" },
    ];

    for (const e of events) rec.observe(e);

    expect(rec.events).toHaveLength(4);
    expect(rec.events.map((e) => e.type)).toEqual(["run-start", "node-start", "node-end", "run-end"]);
  });

  test("createObserver routes events to matching handler", () => {
    const seen: string[] = [];
    const obs = createObserver({
      "run-end": (e) => seen.push(`run-end:${e.status}`),
      "node-error": (e) => seen.push(`error:${e.nodeId}`),
    });

    obs.observe({ type: "run-start", runId: "r1" as any, dagId: "d1" as any, timestamp: new Date() });
    obs.observe({ type: "run-end", runId: "r1" as any, dagId: "d1" as any, timestamp: new Date(), duration: 50, status: "error" });
    obs.observe({ type: "node-error", runId: "r1" as any, dagId: "d1" as any, nodeId: "n1" as any, timestamp: new Date(), error: "boom", frameworkError: { kind: "node-crash", nodeId: "n1" as any, message: "boom", retriability: "non-retriable" } } as any);

    // run-start was ignored (no handler)
    expect(seen).toEqual(["run-end:error", "error:n1"]);
  });

  test("createObserver ignores events without a matching handler (no throw)", () => {
    const obs = createObserver({});
    // Should not throw for any event type
    expect(() =>
      obs.observe({ type: "run-start", runId: "r1" as any, dagId: "d1" as any, timestamp: new Date() }),
    ).not.toThrow();
  });
});
