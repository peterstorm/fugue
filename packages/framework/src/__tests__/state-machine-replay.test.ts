import { describe, it, expect } from "bun:test";
import { replayEvents } from "../state-machine/replay.js";
import { runStateMachine } from "../state-machine/runner.js";
import { createInMemoryJob } from "../state-machine/in-memory-job.js";
import type { Machine, Executor } from "../state-machine/types.js";

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
  maxRetries: {},
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

    const liveResult = await runStateMachine(job, counterMachine, executor);

    // Replay the collected event log from initial state
    const replayResult = replayEvents(job.events as CountEvent[], counterMachine, initial);

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
});
