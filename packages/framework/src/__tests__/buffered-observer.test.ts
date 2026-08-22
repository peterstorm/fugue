import { afterEach, describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { BufferedObserver, computeRunSummary } from "../observer/buffered.js";
import { RecordingObserver, type Observer } from "../observer/observer.js";
import { alwaysOn } from "../observer/policy.js";
import { __resetFrameworkLogger, setFrameworkLogger } from "../logger.js";
import type {
  RunStartEvent,
  NodeStartEvent,
  NodeEndEvent,
  RunEndEvent,
  ObserverEvent,
} from "../types/events.js";

function runStart(runId = "r1"): RunStartEvent {
  // @ts-expect-error — branded ID test fixture
  return { type: "run-start", runId, dagId: "dag1" as DagId, timestamp: new Date() };
}

function nodeStart(nodeId: string, runId = "r1"): NodeStartEvent {
  return {
    type: "node-start",
    runId: runId as RunId,
    dagId: "dag1" as DagId,
    nodeId: nodeId as NodeId,
    sideEffects: { kind: "none" },
    timestamp: new Date(),
  };
}

function nodeEnd(nodeId: string, _attrs: Record<string, unknown> = {}, runId = "r1"): NodeEndEvent {
  return {
    type: "node-end",
    runId: runId as RunId,
    dagId: "dag1" as DagId,
    nodeId: nodeId as NodeId,
    sideEffects: { kind: "none" },
    timestamp: new Date(),
    duration: 50,
    output: null,
  };
}

function runEnd(status: "ok" | "error" = "ok", runId = "r1"): RunEndEvent {
  // @ts-expect-error — branded ID test fixture
  return { type: "run-end", runId, dagId: "dag1" as DagId, timestamp: new Date(), duration: 200, status };
}

describe("BufferedObserver", () => {
  afterEach(() => {
    __resetFrameworkLogger();
  });

  it("events are buffered until run-end", () => {
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn());

    buffered.observe(runStart());
    buffered.observe(nodeStart("n1"));
    buffered.observe(nodeEnd("n1"));

    expect(inner.events).toHaveLength(0);

    buffered.observe(runEnd());
    expect(inner.events.length).toBeGreaterThan(0);
  });

  it("shouldFlush=true replays all events to inner observer", () => {
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn());

    buffered.observe(runStart());
    buffered.observe(nodeStart("n1"));
    buffered.observe(nodeEnd("n1"));
    buffered.observe(runEnd());

    // 3 buffered + 1 run-end = 4
    expect(inner.events).toHaveLength(4);
    expect(inner.events[0].type).toBe("run-start");
    expect(inner.events[3].type).toBe("run-end");
  });

  it("shouldFlush=false drops events but updates aggregates", () => {
    const inner = new RecordingObserver();
    const neverFlush = { shouldFlush: () => false };
    const buffered = new BufferedObserver(inner, neverFlush);

    buffered.observe(runStart());
    buffered.observe(nodeStart("n1"));
    buffered.observe(nodeEnd("n1"));
    buffered.observe(runEnd());

    expect(inner.events).toHaveLength(0);
    expect(buffered.aggregates.runCount).toBe(1);
  });

  it("aggregate counters update regardless of flush decision", () => {
    const inner = new RecordingObserver();
    const neverFlush = { shouldFlush: () => false };
    const buffered = new BufferedObserver(inner, neverFlush);

    buffered.observe(runStart("r1"));
    buffered.observe(nodeEnd("n1", {}, "r1"));
    buffered.observe(runEnd("ok", "r1"));

    buffered.observe(runStart("r2"));
    buffered.observe(nodeEnd("n1", {}, "r2"));
    buffered.observe(runEnd("ok", "r2"));

    expect(buffered.aggregates.runCount).toBe(2);
  });

  it("metric views cannot mutate observer-managed counters", () => {
    const buffered = new BufferedObserver(new RecordingObserver(), alwaysOn());
    buffered.observe(runStart());
    buffered.observe(runEnd());

    const snapshot = buffered.aggregates;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { runCount: number }).runCount = 999;
    }).toThrow();
    expect(buffered.aggregates.runCount).toBe(1);
    expect(() => {
      (buffered as unknown as { evicted: number }).evicted = 999;
    }).toThrow();
    expect(buffered.evicted).toBe(0);
    buffered.close();
  });

  it("a run-end dispatch failure is accounted like a replay failure (dispatchErrors + onReplayFailure)", () => {
    const prev = process.env.OBSERVER_STRICT;
    process.env.OBSERVER_STRICT = "1"; // dispatchEvent rethrows so the failure is observable
    try {
      const seen: ObserverEvent[] = [];
      const inner: Observer = {
        observe(event: ObserverEvent): void {
          if (event.type === "run-end") throw new Error("run-end sink down");
          seen.push(event);
        },
      };
      const failures: Array<{ event: ObserverEvent; error: unknown }> = [];
      const buffered = new BufferedObserver(inner, alwaysOn(), {
        onReplayFailure: (event, error) => failures.push({ event, error }),
      });

      buffered.observe(runStart());
      buffered.observe(nodeStart("n1"));
      buffered.observe(nodeEnd("n1"));
      buffered.observe(runEnd());

      // The run-end dispatch failure is COUNTED, like the replay loop's.
      expect(buffered.dispatchErrors).toBe(1);
      // ...and ROUTED through the dead-letter seam carrying the run-end event
      // — not logged-and-forgotten.
      expect(failures).toHaveLength(1);
      if (failures[0]) {
        expect(failures[0].event.type).toBe("run-end");
        expect((failures[0].error as Error).message).toBe("run-end sink down");
      }
      // The buffered events were each dispatched exactly once — the failure
      // neither skipped the replay nor leaked/doubled the run's buffer.
      expect(seen.map((e) => e.type)).toEqual(["run-start", "node-start", "node-end"]);
      buffered.close();
    } finally {
      if (prev === undefined) delete process.env.OBSERVER_STRICT;
      else process.env.OBSERVER_STRICT = prev;
    }
  });

  it("a throwing sweep clock is diagnosed and skips eviction (never an uncaught timer exception)", () => {
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn(), {
      now: () => {
        throw new Error("clock exploded");
      },
      ttlMs: 1_000,
    });

    // An old buffer would be evictable under a healthy clock.
    buffered.observe(runStart("r1"));
    // The run buffer was stamped through the same guard: the failed clock
    // accounts the open as a lost event instead of persisting garbage.
    expect(buffered.dispatchErrors).toBe(1);

    // evictStale must not throw out of the sweep timer.
    expect(() => buffered.evictStale()).not.toThrow();
    // Nothing is evicted and no count is fabricated — the no-op is loud, not
    // silent.
    expect(buffered.evicted).toBe(0);
    buffered.close();
  });

  it("a hostile clock and a throwing logger cannot escape the failure path", () => {
    setFrameworkLogger({
      debug: () => { throw new Error("logger down"); },
      info: () => { throw new Error("logger down"); },
      warn: () => { throw new Error("logger down"); },
      error: () => { throw new Error("logger down"); },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const buffered = new BufferedObserver(new RecordingObserver(), alwaysOn(), {
      now: () => { throw revoked.proxy; },
      sweepIntervalMs: 0,
    });

    expect(() => buffered.observe(runStart("hostile-clock"))).not.toThrow();
    expect(() => buffered.evictStale()).not.toThrow();
    expect(buffered.dispatchErrors).toBe(1);
    expect(buffered.evicted).toBe(0);
    buffered.close();
  });

  it("a hostile runtime-forged clock return is diagnosed without coercion", () => {
    const errors: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: (message) => { errors.push(message); },
      error: (message) => { errors.push(message); },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const buffered = new BufferedObserver(new RecordingObserver(), alwaysOn(), {
      now: () => revoked.proxy as unknown as number,
      sweepIntervalMs: 0,
    });

    expect(() => buffered.observe(runStart("hostile-clock-return"))).not.toThrow();
    expect(buffered.dispatchErrors).toBe(1);
    expect(errors.some((message) => message.includes("<unprintable>"))).toBe(true);
    buffered.close();
  });

  it("a throwing dead-letter sink logs both failures and replay accounting continues", () => {
    const previousStrict = process.env.OBSERVER_STRICT;
    process.env.OBSERVER_STRICT = "1";
    const errors: string[] = [];
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => { errors.push(message); },
    });
    try {
      const seen: ObserverEvent[] = [];
      const inner: Observer = {
        observe(event): void {
          if (event.type === "node-start") throw new Error("primary dispatch failed");
          seen.push(event);
        },
      };
      const buffered = new BufferedObserver(inner, alwaysOn(), {
        sweepIntervalMs: 0,
        onReplayFailure: () => { throw new Error("dead-letter failed"); },
      });

      buffered.observe(runStart());
      buffered.observe(nodeStart("n1"));
      buffered.observe(nodeEnd("n1"));
      expect(() => buffered.observe(runEnd())).not.toThrow();

      expect(buffered.dispatchErrors).toBe(1);
      expect(seen.map((event) => event.type)).toEqual(["run-start", "node-end", "run-end"]);
      expect(errors.some((message) =>
        message.includes("primary dispatch failed") && message.includes("dead-letter failed")
      )).toBe(true);
      buffered.close();
    } finally {
      if (previousStrict === undefined) delete process.env.OBSERVER_STRICT;
      else process.env.OBSERVER_STRICT = previousStrict;
    }
  });

  it("a non-finite sweep clock warns and skips eviction instead of NaN-comparing forever", () => {
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn(), {
      now: () => Number.NaN,
      ttlMs: 1_000,
    });
    buffered.observe(runStart("r1"));
    // NaN cannot stamp a buffer — accounted as a lost event, never a
    // permanently-unevictable orphan.
    expect(buffered.dispatchErrors).toBe(1);

    expect(() => buffered.evictStale()).not.toThrow();
    expect(buffered.evicted).toBe(0);
    buffered.close();
  });

  // The injected-clock pair below pins inactivity-based eviction: deleting
  // the `lastActivityAt` refresh in `observe` would silently re-introduce the
  // mid-run summary-zeroing bug (SC-008).
  it("evicts by INACTIVITY, not open time: an active run past the TTL is NOT evicted", () => {
    let nowMs = 0;
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn(), {
      now: () => nowMs,
      ttlMs: 1_000,
    });
    buffered.observe(runStart("r1")); // initial activity = 0
    nowMs = 5_000; // far past the TTL
    buffered.observe(nodeEnd("n1")); // fresh activity refreshes lastActivityAt
    buffered.evictStale();
    // The initial stamp is stale but the buffer is ACTIVE — it must survive.
    expect(buffered.evicted).toBe(0);
    buffered.close();
  });

  it("evicts an IDLE orphan past the TTL", () => {
    let nowMs = 0;
    const inner = new RecordingObserver();
    const buffered = new BufferedObserver(inner, alwaysOn(), {
      now: () => nowMs,
      ttlMs: 1_000,
    });
    buffered.observe(runStart("r1")); // initial activity = 0
    nowMs = 5_000;
    buffered.evictStale();
    // Never touched again — orphaned on BOTH clocks, so it is evicted.
    expect(buffered.evicted).toBe(1);
    buffered.close();
  });
});

describe("computeRunSummary", () => {
  it("computes correct summary from events", () => {
    const events: ObserverEvent[] = [
      runStart(),
      nodeStart("n1"),
      nodeEnd("n1"),
      nodeStart("n2"),
      nodeEnd("n2"),
      // n1 retried
      nodeStart("n1"),
      nodeEnd("n1"),
    ];

    const summary = computeRunSummary(events, runEnd("ok"));

    expect(summary.status).toBe("ok");
    expect(summary.totalDuration).toBe(200);
    expect(summary.nodeCount).toBe(2); // n1 and n2
    expect(summary.retryCount).toBe(1); // n1 started twice
  });
});
