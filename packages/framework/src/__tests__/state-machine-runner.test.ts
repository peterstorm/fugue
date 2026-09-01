import { describe, it, expect } from "bun:test";
import { runStateMachine } from "../state-machine/runner.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import type { Machine, Executor, KernelRunOpts, TraceEvent } from "../state-machine/types.js";

// ---------------------------------------------------------------------------
// Simple 3-state machine: pending -> running -> succeeded | failed
// ---------------------------------------------------------------------------

type State = { kind: "pending" } | { kind: "running" } | { kind: "succeeded" } | { kind: "failed"; reason: string };
type Event = { type: "START" } | { type: "DONE" } | { type: "FAIL"; reason: string } | { type: "ERROR"; retriable: boolean; message: string };
type Context = { count: number };

const simpleMachine: Machine<State, Event, Context> = {
  transition(state, event, context) {
    if (state.kind === "pending" && event.type === "START") {
      return { state: { kind: "running" }, context: { count: context.count + 1 } };
    }
    if (state.kind === "running" && event.type === "DONE") {
      return { state: { kind: "succeeded" }, context };
    }
    if (state.kind === "running" && event.type === "FAIL") {
      return { state: { kind: "failed", reason: event.reason }, context };
    }
    if (event.type === "ERROR") {
      return { state: { kind: "failed", reason: event.message }, context };
    }
    return { state, context };
  },
  isTerminal(state) {
    return state.kind === "succeeded" || state.kind === "failed";
  },
  isFailed(state) {
    return state.kind === "failed";
  },
  stateProgress(state) {
    switch (state.kind) {
      case "pending": return 0;
      case "running": return 50;
      case "succeeded": return 100;
      case "failed": return 0;
    }
  },
  stateKey: (s) => JSON.stringify(s),
};

// ---------------------------------------------------------------------------
// Retry machine: running can retry (stay in running) up to N times
// The machine itself tracks retry count in context.
// pending -> running -> (retry running N times) -> succeeded | failed
// ---------------------------------------------------------------------------

type RetryState = { kind: "pending" } | { kind: "running" } | { kind: "succeeded" } | { kind: "failed"; reason: string };
type RetryEvent =
  | { type: "START" }
  | { type: "DONE" }
  | { type: "FAIL"; reason: string }
  | { type: "ERROR"; retriable: boolean; message: string };
type RetryContext = { count: number; retries: number };

/**
 * Machine where ERROR events cause a retry (stay in "running") if retries < 2,
 * otherwise fail. Used to verify US2 S2: error wrapped into ERROR event,
 * machine transitions to retry state (NOT terminal-failed).
 */
const retryMachine: Machine<RetryState, RetryEvent, RetryContext> = {
  transition(state, event, context) {
    if (state.kind === "pending" && event.type === "START") {
      return { state: { kind: "running" }, context: { ...context, count: context.count + 1 } };
    }
    if (state.kind === "running" && event.type === "DONE") {
      return { state: { kind: "succeeded" }, context };
    }
    if (state.kind === "running" && event.type === "FAIL") {
      return { state: { kind: "failed", reason: event.reason }, context };
    }
    if (state.kind === "running" && event.type === "ERROR") {
      // Retry up to 2 times; machine tracks count in context
      if (context.retries < 2) {
        return { state: { kind: "running" }, context: { ...context, retries: context.retries + 1 } };
      }
      return { state: { kind: "failed", reason: event.message }, context };
    }
    return { state, context };
  },
  isTerminal(state) {
    return state.kind === "succeeded" || state.kind === "failed";
  },
  isFailed(state) {
    return state.kind === "failed";
  },
  stateProgress(state) {
    switch (state.kind) {
      case "pending": return 0;
      case "running": return 50;
      case "succeeded": return 100;
      case "failed": return 0;
    }
  },
  stateKey: (s) => JSON.stringify(s),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeJob = (state: State = { kind: "pending" }, context: Context = { count: 0 }) =>
  createInMemoryJob<State, Context>({ state, context });

const defaultErrorEventOf = (c: { retriable: boolean; message: string }): Event =>
  ({ type: "ERROR", retriable: c.retriable, message: c.message });

const hostileThrownValues: ReadonlyArray<readonly [string, () => unknown]> = [
  ["throwing Error.message getter", () => {
    const error = new Error("hidden");
    Object.defineProperty(error, "message", {
      get: () => { throw new Error("message getter trap"); },
    });
    return error;
  }],
  ["revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runStateMachine", () => {
  it("drives machine to terminal succeeded state", async () => {
    const job = makeJob();
    let call = 0;
    const executor: Executor<State, Event, Context> = async (state) => {
      call++;
      if (state.kind === "pending") return { type: "START" };
      return { type: "DONE" };
    };

    const opts: KernelRunOpts<State, Event, Context> = { errorEventOf: defaultErrorEventOf };
    const result = await runStateMachine(job, simpleMachine, executor, opts);
    expect(result.state.kind).toBe("succeeded");
    expect(call).toBe(2);
  });

  it("checkpoints after each successful transition (FR-005)", async () => {
    const job = makeJob();
    const executor: Executor<State, Event, Context> = async (state) => {
      if (state.kind === "pending") return { type: "START" };
      return { type: "DONE" };
    };

    const opts: KernelRunOpts<State, Event, Context> = { errorEventOf: defaultErrorEventOf };
    await runStateMachine(job, simpleMachine, executor, opts);

    // Final checkpointed state should be succeeded
    expect(job.data.state.kind).toBe("succeeded");
    // updateData called for both running + succeeded transitions
    expect(job.events.length).toBe(2);
  });

  it("does NOT checkpoint when resulting state is terminal-failed (FR-005)", async () => {
    const job = makeJob({ kind: "running" });
    const executor: Executor<State, Event, Context> = async () => ({
      type: "FAIL",
      reason: "oops",
    });

    const opts: KernelRunOpts<State, Event, Context> = { errorEventOf: defaultErrorEventOf };
    await expect(runStateMachine(job, simpleMachine, executor, opts)).rejects.toThrow();

    // Checkpointed state should remain "running" (before the failure)
    expect(job.data.state.kind).toBe("running");
    // appendEvent should NOT have been called for the failing transition
    expect(job.events.length).toBe(0);
  });

  it("does NOT update progress when resulting state is terminal-failed (FR-005/NFR-002)", async () => {
    const job = makeJob({ kind: "running" });
    const executor: Executor<State, Event, Context> = async () => ({
      type: "FAIL",
      reason: "progress-check",
    });

    // Progress starts at 0; running state has progress 50 (but we start from running)
    // After running->failed, progress should NOT be updated to failed's value (0)
    // Since we start from running and there's no prior updateProgress call, progress stays at 0
    const opts: KernelRunOpts<State, Event, Context> = { errorEventOf: defaultErrorEventOf };
    await expect(runStateMachine(job, simpleMachine, executor, opts)).rejects.toThrow();

    // updateProgress must NOT have been called for the failed transition
    expect(job.progress).toBe(0);
  });

  it("throws after terminal-failed state (FR-007)", async () => {
    const job = makeJob({ kind: "running" });
    const executor: Executor<State, Event, Context> = async () => ({
      type: "FAIL",
      reason: "boom",
    });

    const opts: KernelRunOpts<State, Event, Context> = { errorEventOf: defaultErrorEventOf };
    await expect(runStateMachine(job, simpleMachine, executor, opts)).rejects.toThrow(
      /failed terminal state/i,
    );
  });

  it("wraps executor errors via errorEventOf and delivers ERROR event to machine (FR-006 / US2 S2)", async () => {
    const job = makeJob({ kind: "running" });
    const executor: Executor<State, Event, Context> = async () => {
      throw new Error("network timeout");
    };

    const opts: KernelRunOpts<State, Event, Context> = {
      errorEventOf: (c) => ({ type: "ERROR", retriable: c.retriable, message: c.message }),
    };

    // ERROR event feeds into simpleMachine which transitions running->failed
    await expect(runStateMachine(job, simpleMachine, executor, opts)).rejects.toThrow(
      /failed terminal state/i,
    );
  });

  it("falls back deterministically when classifyError throws and preserves both diagnostics", async () => {
    const job = createInMemoryJob<RetryState, RetryContext>({
      state: { kind: "running" },
      context: { count: 0, retries: 0 },
    });
    let calls = 0;
    const executorFailure = new Error("provider exploded");
    const result = await runStateMachine(job, retryMachine, async () => {
      calls += 1;
      if (calls === 1) throw executorFailure;
      return { type: "DONE" as const };
    }, {
      classifyError: () => { throw new Error("classifier exploded"); },
      errorEventOf: (classified) => ({
        type: "ERROR" as const,
        retriable: classified.retriable,
        message: classified.message,
      }),
    });

    expect(result.state.kind).toBe("succeeded");
    const first = job.events[0]?.event as RetryEvent | undefined;
    expect(first?.type).toBe("ERROR");
    if (first?.type === "ERROR") {
      expect(first.retriable).toBe(false);
      expect(first.message).toContain("provider exploded");
      expect(first.message).toContain("classifier exploded");
    }
  });

  it("aggregates the original executor failure when errorEventOf throws", async () => {
    const executorFailure = new Error("executor exploded");
    const mapperFailure = new Error("event mapper exploded");
    let caught: unknown;
    try {
      await runStateMachine(makeJob({ kind: "running" }), simpleMachine, async () => {
        throw executorFailure;
      }, {
        errorEventOf: () => { throw mapperFailure; },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.cause).toBe(executorFailure);
    expect(aggregate.errors).toEqual([executorFailure, mapperFailure]);
    expect(aggregate.message).toContain("executor exploded");
    expect(aggregate.message).toContain("event mapper exploded");
  });

  for (const [caseName, makeThrown] of hostileThrownValues) {
    it(`FR-006: default classifier delivers an ERROR event for ${caseName}`, async () => {
      const job = createInMemoryJob<RetryState, RetryContext>({
        state: { kind: "running" },
        context: { count: 0, retries: 0 },
      });
      let calls = 0;
      const executor: Executor<RetryState, RetryEvent, RetryContext> = async () => {
        calls += 1;
        if (calls === 1) throw makeThrown();
        return { type: "DONE" };
      };

      const result = await runStateMachine(job, retryMachine, executor, {
        errorEventOf: (classified) => ({
          type: "ERROR" as const,
          retriable: classified.retriable,
          message: classified.message,
        }),
      });

      expect(result.state.kind).toBe("succeeded");
      expect(calls).toBe(2);
      const firstEvent = job.events[0]?.event as RetryEvent | undefined;
      expect(firstEvent?.type).toBe("ERROR");
      if (firstEvent?.type === "ERROR") {
        expect(firstEvent.retriable).toBe(true);
        expect(firstEvent.message.length).toBeGreaterThan(0);
      }
    });
  }

  it("US2 S2: error wrapped into ERROR event, machine transitions to retry state (NOT terminal-failed)", async () => {
    // retryMachine stays in "running" on ERROR when retries < 2
    const job = createInMemoryJob<RetryState, RetryContext>({
      state: { kind: "running" },
      context: { count: 0, retries: 0 },
    });

    let callCount = 0;
    const executor: Executor<RetryState, RetryEvent, RetryContext> = async () => {
      callCount++;
      if (callCount <= 1) {
        // First call: throw an error — should be wrapped and retried
        throw new Error("transient failure");
      }
      // Second call: succeed
      return { type: "DONE" };
    };

    const opts: KernelRunOpts<RetryState, RetryEvent, RetryContext> = {
      errorEventOf: (c) => ({ type: "ERROR", retriable: c.retriable, message: c.message }),
    };

    const result = await runStateMachine(job, retryMachine, executor, opts);
    // Machine retried once (stayed in running), then succeeded
    expect(result.state.kind).toBe("succeeded");
    expect(callCount).toBe(2);
  });

  it("aborts when beforeExecute returns false (FR-012)", async () => {
    const job = makeJob();
    const executor: Executor<State, Event, Context> = async () => ({ type: "START" });

    const opts: KernelRunOpts<State, Event, Context> = {
      errorEventOf: defaultErrorEventOf,
      beforeExecute: () => false,
    };

    await expect(runStateMachine(job, simpleMachine, executor, opts)).rejects.toThrow(
      /aborted by beforeExecute/i,
    );
  });

  it("FR-012 + US7 S3: emits skipped outcome trace before aborting on beforeExecute=false", async () => {
    const job = makeJob();
    const traces: TraceEvent<State, Event>[] = [];
    let called = false;
    const executor: Executor<State, Event, Context> = async () => ({ type: "START" });

    await expect(
      runStateMachine(job, simpleMachine, executor, {
        errorEventOf: defaultErrorEventOf,
        beforeExecute: () => { called = true; return false; },
        onTrace: (t) => traces.push(t),
      }),
    ).rejects.toThrow(/aborted/i);

    expect(called).toBe(true);
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe("skipped");
    expect(traces[0].state.kind).toBe("pending");
    expect(traces[0].nextState.kind).toBe("pending");
    expect(traces[0].event).toBeUndefined();
  });

  it("proceeds when beforeExecute returns true (FR-012)", async () => {
    const job = makeJob();
    const executor: Executor<State, Event, Context> = async (state) => {
      if (state.kind === "pending") return { type: "START" };
      return { type: "DONE" };
    };

    const opts: KernelRunOpts<State, Event, Context> = {
      errorEventOf: defaultErrorEventOf,
      beforeExecute: () => true,
    };

    const result = await runStateMachine(job, simpleMachine, executor, opts);
    expect(result.state.kind).toBe("succeeded");
  });

  it("fires onTrace after each transition (US7)", async () => {
    const job = makeJob();
    const traces: TraceEvent<State, Event>[] = [];
    const executor: Executor<State, Event, Context> = async (state) => {
      if (state.kind === "pending") return { type: "START" };
      return { type: "DONE" };
    };

    await runStateMachine(job, simpleMachine, executor, {
      errorEventOf: defaultErrorEventOf,
      onTrace: (t) => traces.push(t),
    });

    expect(traces.length).toBe(2);
    expect(traces[0].state.kind).toBe("pending");
    expect(traces[0].nextState.kind).toBe("running");
    expect(traces[0].outcome).toBe("success");
    expect(traces[1].state.kind).toBe("running");
    expect(traces[1].nextState.kind).toBe("succeeded");
  });

  it("emits retry outcome in trace when state does not change (FR-011 trace)", async () => {
    // retryMachine stays in "running" on ERROR — trace outcome should be "retry"
    const job = createInMemoryJob<RetryState, RetryContext>({
      state: { kind: "running" },
      context: { count: 0, retries: 0 },
    });

    let callCount = 0;
    const traces: TraceEvent<RetryState, RetryEvent>[] = [];

    const executor: Executor<RetryState, RetryEvent, RetryContext> = async () => {
      callCount++;
      if (callCount <= 1) throw new Error("transient");
      return { type: "DONE" };
    };

    const opts: KernelRunOpts<RetryState, RetryEvent, RetryContext> = {
      errorEventOf: (c) => ({ type: "ERROR", retriable: c.retriable, message: c.message }),
      onTrace: (t) => traces.push(t),
    };

    await runStateMachine(job, retryMachine, executor, opts);

    // First transition: running->running (retry), second: running->succeeded
    expect(traces.length).toBe(2);
    expect(traces[0].outcome).toBe("retry");
    expect(traces[0].state.kind).toBe("running");
    expect(traces[0].nextState.kind).toBe("running");
    expect(traces[1].outcome).toBe("success");
    expect(traces[1].nextState.kind).toBe("succeeded");
  });

  it("appends event on every successful transition (FR-005 + US6)", async () => {
    const job = makeJob();
    const executor: Executor<State, Event, Context> = async (state) => {
      if (state.kind === "pending") return { type: "START" };
      return { type: "DONE" };
    };

    const opts: KernelRunOpts<State, Event, Context> = { errorEventOf: defaultErrorEventOf };
    await runStateMachine(job, simpleMachine, executor, opts);
    expect(job.events).toHaveLength(2);
    expect((job.events[0].event as Event).type).toBe("START");
    expect((job.events[1].event as Event).type).toBe("DONE");
  });

  it("resets retry counters on each invocation — fresh run does not inherit state (FR-011)", async () => {
    // Two separate invocations from same initial state; both must behave identically
    const initial = { state: { kind: "pending" } as State, context: { count: 0 } };
    const opts: KernelRunOpts<State, Event, Context> = { errorEventOf: defaultErrorEventOf };

    const results: string[] = [];
    const traceOutcomes: Array<string[]> = [];

    for (let i = 0; i < 2; i++) {
      const job = createInMemoryJob(initial);
      const traces: TraceEvent<State, Event>[] = [];
      const executor: Executor<State, Event, Context> = async (state) => {
        if (state.kind === "pending") return { type: "START" };
        return { type: "DONE" };
      };
      const r = await runStateMachine(job, simpleMachine, executor, {
        ...opts,
        onTrace: (t) => traces.push(t),
      });
      results.push(r.state.kind);
      traceOutcomes.push(traces.map((t) => t.outcome));
    }

    expect(results).toEqual(["succeeded", "succeeded"]);
    // Both runs must produce identical trace outcomes (no "retry" bleed from prior run)
    expect(traceOutcomes[0]).toEqual(["success", "success"]);
    expect(traceOutcomes[1]).toEqual(["success", "success"]);
  });

  it("US7 S2: durationMs is non-negative and small under a fake clock (W5.10)", async () => {
    const job = makeJob({ kind: "running" });
    const traces: TraceEvent<State, Event>[] = [];

    // Earlier shape: `stamps = [1_000, 1_050]` + `Math.min(idx++, stamps.length - 1)`
    // pinned `durationMs === 50` by coupling the test to the runner's exact
    // `now()` call count. A refactor that adds a single new `now()` call site
    // (or moves trace emission across the duration measurement) would shift
    // the pinned value and break the test for reasons unrelated to behaviour.
    //
    // The load-bearing invariants are:
    //   - the runner USES `opts.now` (i.e. honours the clock seam)
    //   - the resulting `durationMs` is non-negative and finite
    //   - it is small (the fake clock advances by <100 wall-clock ms here)
    // Pin those instead of an exact millisecond value.
    let nowCalls = 0;
    const startWall = Date.now();
    const now = (): number => {
      nowCalls += 1;
      return Date.now();
    };

    const executor: Executor<State, Event, Context> = async () => ({ type: "DONE" });

    await runStateMachine(job, simpleMachine, executor, {
      errorEventOf: defaultErrorEventOf,
      onTrace: (t) => traces.push(t),
      now,
    });

    expect(traces.length).toBe(1);
    const durationMs = traces[0]!.durationMs;
    expect(Number.isFinite(durationMs)).toBe(true);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    // 100ms is generous — the test runs a single synchronous transition.
    expect(durationMs).toBeLessThan(100);
    // The runner must have actually consulted the injected clock — otherwise
    // we are not exercising the seam.
    expect(nowCalls).toBeGreaterThanOrEqual(2);
    // And the test itself finished within its own budget.
    expect(Date.now() - startWall).toBeLessThan(500);
  });

  it("commits a transition before a throwing post-execution trace clock can fail", async () => {
    const job = makeJob({ kind: "running" });
    let executorCalls = 0;
    let clockCalls = 0;
    const traceErrors: unknown[][] = [];
    const executor: Executor<State, Event, Context> = async () => {
      executorCalls += 1;
      return { type: "DONE" };
    };

    const result = await runStateMachine(job, simpleMachine, executor, {
      errorEventOf: defaultErrorEventOf,
      onTrace: () => {
        throw new Error("trace must be suppressed when its clock fails");
      },
      now: () => {
        clockCalls += 1;
        if (clockCalls === 2) throw new Error("trace clock unavailable");
        return 1_000;
      },
      logger: {
        warn: () => {},
        error: (...args) => traceErrors.push(args),
      },
    });

    expect(result.state.kind).toBe("succeeded");
    expect(job.data.state.kind).toBe("succeeded");
    expect(job.events.map(({ event }) => (event as Event).type)).toEqual(["DONE"]);
    expect(executorCalls).toBe(1);
    expect(traceErrors).toHaveLength(1);
    expect(String(traceErrors[0]?.[0])).toContain("trace clock threw");

    // A fresh kernel invocation observes the committed terminal checkpoint and
    // cannot replay the executor work whose diagnostic timing failed.
    await runStateMachine(job, simpleMachine, executor, {
      errorEventOf: defaultErrorEventOf,
    });
    expect(executorCalls).toBe(1);
  });

  // Gap-5 fix: simulated crash + restart test
  describe("crash + restart simulation (Gap-5)", () => {
    it("resumes from last checkpoint after mid-executor crash", async () => {
      // Phase 1: start a run that crashes mid-way (after first transition)
      const initial = { state: { kind: "pending" } as State, context: { count: 0 } };
      const job1 = createInMemoryJob(initial);

      let executorCallCount = 0;
      const executor: Executor<State, Event, Context> = async (state) => {
        executorCallCount++;
        if (state.kind === "pending") {
          // First transition: START succeeds, checkpoint is written
          return { type: "START" };
        }
        // Second call (running state): simulate process crash
        if (executorCallCount === 2) {
          throw new Error("simulated crash");
        }
        return { type: "DONE" };
      };

      const opts: KernelRunOpts<State, Event, Context> = {
        errorEventOf: defaultErrorEventOf,
      };

      // The first run should throw: crash is wrapped into ERROR event,
      // simpleMachine transitions running->failed, runner throws "failed terminal state"
      await expect(runStateMachine(job1, simpleMachine, executor, opts)).rejects.toThrow(
        /failed terminal state/i,
      );

      // After crash: job1 has checkpoint at "running" (the first transition succeeded,
      // the failed transition was NOT checkpointed per FR-005)
      const crashCheckpoint = job1.data;
      expect(crashCheckpoint.state.kind).toBe("running");

      // Phase 2: construct a NEW runner from the same checkpoint (simulates fresh process)
      const job2 = createInMemoryJob(crashCheckpoint);
      let freshCalls = 0;
      const freshExecutor: Executor<State, Event, Context> = async (state) => {
        freshCalls++;
        if (state.kind === "running") return { type: "DONE" };
        return { type: "START" };
      };

      const result = await runStateMachine(job2, simpleMachine, freshExecutor, opts);

      // Should resume from "running" and reach "succeeded"
      expect(result.state.kind).toBe("succeeded");
      expect(freshCalls).toBe(1); // Only one call — we resumed from running, not from pending

      // Verify the final state matches what an uninterrupted run would produce
      const uninterruptedJob = createInMemoryJob(initial);
      let uninterruptedCalls = 0;
      const uninterruptedExecutor: Executor<State, Event, Context> = async (state) => {
        uninterruptedCalls++;
        if (state.kind === "pending") return { type: "START" };
        return { type: "DONE" };
      };
      const uninterruptedResult = await runStateMachine(uninterruptedJob, simpleMachine, uninterruptedExecutor, opts);

      expect(result.state.kind).toBe(uninterruptedResult.state.kind);
      expect(result.context).toEqual(uninterruptedResult.context);
    });
  });
});
