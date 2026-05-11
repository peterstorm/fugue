import { describe, it, expect } from "bun:test";
import {
  replayEvents,
  replayEventsUntil,
  replayEventSlice,
} from "../state-machine/replay.js";
import { runStateMachine } from "../state-machine/runner.js";
import { createInMemoryJob } from "../state-machine/in-memory-job.js";
import type { Machine, Executor, RecordedEvent } from "../state-machine/types.js";

// ---------------------------------------------------------------------------
// Counter machine — simple accumulator for replay testing
// ---------------------------------------------------------------------------

type CountState = { kind: "idle"; count: number } | { kind: "done"; count: number };
type CountEvent = { type: "ADD"; n: number } | { type: "DONE" };
type CountCtx = Record<string, never>;

const counterMachine: Machine<CountState, CountEvent, CountCtx> = {
  transition(state, event) {
    if (event.type === "ADD") {
      const base = state.kind === "idle" ? state.count : 0;
      return { state: { kind: "idle", count: base + event.n }, context: {} };
    }
    if (event.type === "DONE") {
      const count = state.kind === "idle" ? state.count : 0;
      return { state: { kind: "done", count }, context: {} };
    }
    return { state, context: {} };
  },
  isTerminal(state) { return state.kind === "done"; },
  isFailed() { return false; },
  stateProgress(state) { return state.kind === "done" ? 100 : 50; },
};

describe("replayEvents", () => {
  it("rebuilds the same state as a live run for a known event sequence", async () => {
    const initial = { state: { kind: "idle", count: 0 } as CountState, context: {} as CountCtx };
    const job = createInMemoryJob(initial);

    const events: CountEvent[] = [
      { type: "ADD", n: 5 },
      { type: "ADD", n: 3 },
      { type: "DONE" },
    ];

    let i = 0;
    const executor: Executor<CountState, CountCtx, CountEvent> = async () => events[i++];

    const liveResult = await runStateMachine(job, counterMachine, executor, {
      errorEventOf: (c) => ({ type: "DONE" } as CountEvent),
    });

    // Replay the collected event log from initial state
    const rawEvents = job.events.map((e) => e.event as CountEvent);
    const replayResult = replayEvents(rawEvents, counterMachine, initial);

    expect(replayResult.state).toEqual(liveResult.state);
    expect(replayResult.context).toEqual(liveResult.context);
  });

  it("is a pure fold — applying events one at a time yields same result as batch", () => {
    const initial = { state: { kind: "idle", count: 0 } as CountState, context: {} as CountCtx };
    const events: CountEvent[] = [
      { type: "ADD", n: 10 },
      { type: "ADD", n: 20 },
      { type: "DONE" },
    ];

    const batchResult = replayEvents(events, counterMachine, initial);

    let cur = initial;
    for (const e of events) {
      cur = replayEvents([e], counterMachine, cur);
    }

    expect(batchResult.state).toEqual(cur.state);
  });

  it("returns initial state when event list is empty", () => {
    const initial = { state: { kind: "idle", count: 7 } as CountState, context: {} as CountCtx };
    const result = replayEvents([], counterMachine, initial);
    expect(result.state).toEqual(initial.state);
  });

  it("does not invoke the executor (pure — no side effects)", async () => {
    const initial = { state: { kind: "idle", count: 0 } as CountState, context: {} as CountCtx };
    const events: CountEvent[] = [{ type: "ADD", n: 1 }, { type: "DONE" }];

    // If executor were called this would throw — but replayEvents never calls it
    const result = replayEvents(events, counterMachine, initial);
    expect(result.state.kind).toBe("done");
  });

  it("replay equivalence for a sequence with multiple ADD events", () => {
    const initial = { state: { kind: "idle", count: 0 } as CountState, context: {} as CountCtx };

    const events: CountEvent[] = Array.from({ length: 10 }, (_, i) => ({ type: "ADD" as const, n: i + 1 }));
    const afterAdds = replayEvents(events, counterMachine, initial);
    // sum 1..10 = 55
    expect((afterAdds.state as { kind: "idle"; count: number }).count).toBe(55);

    const withDone = replayEvents([...events, { type: "DONE" }], counterMachine, initial);
    expect(withDone.state.kind).toBe("done");
    expect((withDone.state as { kind: "done"; count: number }).count).toBe(55);
  });

  it("accepts RecordedEvent envelopes interchangeably with raw events", () => {
    const initial = { state: { kind: "idle", count: 0 } as CountState, context: {} as CountCtx };
    const raw: CountEvent[] = [
      { type: "ADD", n: 5 },
      { type: "ADD", n: 3 },
      { type: "DONE" },
    ];
    const wrapped: RecordedEvent<CountEvent>[] = raw.map((event, i) => ({
      recordedAtMs: 1000 + i,
      event,
    }));

    const fromRaw = replayEvents(raw, counterMachine, initial);
    const fromWrapped = replayEvents(wrapped, counterMachine, initial);

    expect(fromWrapped.state).toEqual(fromRaw.state);
    expect(fromWrapped.context).toEqual(fromRaw.context);
  });
});

// ---------------------------------------------------------------------------
// replayEventsUntil — wall-clock-bounded replay (envelopes only)
// ---------------------------------------------------------------------------

describe("replayEventsUntil", () => {
  const initial = { state: { kind: "idle", count: 0 } as CountState, context: {} as CountCtx };

  // Fixture: four events at known timestamps. Each ADD increments by its `n`.
  // Final accumulated count after all four = 1 + 2 + 3 + 4 = 10
  const fixture: RecordedEvent<CountEvent>[] = [
    { recordedAtMs: 1000, event: { type: "ADD", n: 1 } },
    { recordedAtMs: 2000, event: { type: "ADD", n: 2 } },
    { recordedAtMs: 3000, event: { type: "ADD", n: 3 } },
    { recordedAtMs: 4000, event: { type: "ADD", n: 4 } },
  ];

  it("untilMs strictly before any event returns initial state", () => {
    const result = replayEventsUntil(fixture, counterMachine, initial, 500);
    expect(result.state).toEqual(initial.state);
  });

  it("untilMs at exact event timestamp excludes that event (half-open)", () => {
    // untilMs = 3000 → fold events at 1000, 2000 only → count = 1 + 2 = 3
    const result = replayEventsUntil(fixture, counterMachine, initial, 3000);
    expect((result.state as { kind: "idle"; count: number }).count).toBe(3);
  });

  it("untilMs after all events folds the entire stream", () => {
    const result = replayEventsUntil(fixture, counterMachine, initial, Number.MAX_SAFE_INTEGER);
    expect((result.state as { kind: "idle"; count: number }).count).toBe(10);
  });

  it("equivalent to slicing by index when timestamps are monotonic", () => {
    // Pick the 3rd event's timestamp; replayEventsUntil(...,3000) should equal
    // replayEvents(events.slice(0, 2), ...) since timestamps 1000, 2000 are < 3000.
    const sliced = replayEvents(fixture.slice(0, 2), counterMachine, initial);
    const timeBound = replayEventsUntil(fixture, counterMachine, initial, 3000);
    expect(timeBound.state).toEqual(sliced.state);
    expect(timeBound.context).toEqual(sliced.context);
  });

  it("throws RangeError on non-finite untilMs", () => {
    expect(() => replayEventsUntil(fixture, counterMachine, initial, NaN)).toThrow(RangeError);
    expect(() => replayEventsUntil(fixture, counterMachine, initial, Infinity)).toThrow(RangeError);
  });

  it("is deterministic — running twice yields identical state", () => {
    const a = replayEventsUntil(fixture, counterMachine, initial, 3500);
    const b = replayEventsUntil(fixture, counterMachine, initial, 3500);
    expect(a.state).toEqual(b.state);
    expect(a.context).toEqual(b.context);
  });
});

// ---------------------------------------------------------------------------
// replayEventSlice — half-open time window from initial state
// ---------------------------------------------------------------------------

describe("replayEventSlice", () => {
  const initial = { state: { kind: "idle", count: 0 } as CountState, context: {} as CountCtx };

  const fixture: RecordedEvent<CountEvent>[] = [
    { recordedAtMs: 1000, event: { type: "ADD", n: 1 } },
    { recordedAtMs: 2000, event: { type: "ADD", n: 2 } },
    { recordedAtMs: 3000, event: { type: "ADD", n: 3 } },
    { recordedAtMs: 4000, event: { type: "ADD", n: 4 } },
  ];

  it("[fromMs, toMs) is inclusive at fromMs, exclusive at toMs", () => {
    // Window [2000, 4000) → events at 2000, 3000 → count = 2 + 3 = 5
    const result = replayEventSlice(fixture, counterMachine, initial, 2000, 4000);
    expect((result.state as { kind: "idle"; count: number }).count).toBe(5);
  });

  it("starts the fold from `initial`, NOT from a checkpoint at fromMs", () => {
    // This documents the API contract: replayEventSlice is a slice + fresh
    // fold, not a "fast-forward from a known prior state". Caller is
    // responsible for supplying the correct `initial` if they want to chain
    // windows.
    const window = replayEventSlice(fixture, counterMachine, initial, 3000, 5000);
    // Only events at 3000 and 4000 fold → count = 0 (initial) + 3 + 4 = 7
    expect((window.state as { kind: "idle"; count: number }).count).toBe(7);
  });

  it("empty window (toMs === fromMs) returns initial state untouched", () => {
    const result = replayEventSlice(fixture, counterMachine, initial, 2000, 2000);
    expect(result.state).toEqual(initial.state);
    expect(result.context).toEqual(initial.context);
  });

  it("window outside event range returns initial state", () => {
    const before = replayEventSlice(fixture, counterMachine, initial, 0, 500);
    expect(before.state).toEqual(initial.state);

    const after = replayEventSlice(fixture, counterMachine, initial, 5000, 6000);
    expect(after.state).toEqual(initial.state);
  });

  it("entire range == fold of all events from initial", () => {
    const all = replayEventSlice(fixture, counterMachine, initial, 0, Number.MAX_SAFE_INTEGER);
    const direct = replayEvents(fixture, counterMachine, initial);
    expect(all.state).toEqual(direct.state);
  });

  it("throws RangeError on non-finite or inverted bounds", () => {
    expect(() => replayEventSlice(fixture, counterMachine, initial, NaN, 100)).toThrow(RangeError);
    expect(() => replayEventSlice(fixture, counterMachine, initial, 0, Infinity)).toThrow(RangeError);
    expect(() => replayEventSlice(fixture, counterMachine, initial, 5000, 1000)).toThrow(RangeError);
  });

  it("untilMs ≡ Between(0, untilMs) when timestamps are non-negative", () => {
    const untilForm = replayEventsUntil(fixture, counterMachine, initial, 3500);
    const betweenForm = replayEventSlice(fixture, counterMachine, initial, 0, 3500);
    expect(untilForm.state).toEqual(betweenForm.state);
    expect(untilForm.context).toEqual(betweenForm.context);
  });
});
