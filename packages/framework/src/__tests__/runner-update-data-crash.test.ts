// Wave 6 §6.5: runStateMachine appendEvent → updateData crash window.
//
// Contract: if updateData throws after appendEvent succeeds, the runner
// surfaces the failure (does not silently advance), the event log retains
// the event, and a re-derived run hits the adapter's lastDedupKey path —
// the event is not duplicated.
//
// Verifies the at-least-once + dedup invariant called out in ADR 0014.

import { describe, it, expect } from "bun:test";
import { runStateMachine } from "../state-machine/runner.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import type { Machine, Executor, JobLike, RunOptions } from "../state-machine/types.js";

// ---------------------------------------------------------------------------
// Minimal machine — pending -> running -> succeeded
// ---------------------------------------------------------------------------

type State = { kind: "pending" } | { kind: "running" } | { kind: "succeeded" } | { kind: "failed"; reason: string };
type Event = { type: "START" } | { type: "DONE" } | { type: "ERROR"; retriable: boolean; message: string };
type Ctx = { count: number };

const machine: Machine<State, Event, Ctx> = {
  transition(state, event, ctx) {
    if (state.kind === "pending" && event.type === "START") {
      return { state: { kind: "running" }, context: { count: ctx.count + 1 } };
    }
    if (state.kind === "running" && event.type === "DONE") {
      return { state: { kind: "succeeded" }, context: ctx };
    }
    if (event.type === "ERROR") {
      return { state: { kind: "failed", reason: event.message }, context: ctx };
    }
    return { state, context: ctx };
  },
  isTerminal(s) { return s.kind === "succeeded" || s.kind === "failed"; },
  isFailed(s) { return s.kind === "failed"; },
  stateProgress(s) { return s.kind === "succeeded" ? 100 : s.kind === "running" ? 50 : 0; },
};

const errorEventOf = (c: { retriable: boolean; message: string }): Event =>
  ({ type: "ERROR", retriable: c.retriable, message: c.message });

const runOpts: RunOptions<State, Event, Ctx> = { errorEventOf };

// ---------------------------------------------------------------------------
// Fault-injecting wrapper — updateData throws on its first N invocations
// ---------------------------------------------------------------------------

const failingUpdateData = <S, C>(
  inner: ReturnType<typeof createInMemoryJob<S, C>>,
  failuresRemaining: { count: number },
): JobLike<S, Event, C> & { readonly inner: ReturnType<typeof createInMemoryJob<S, C>> } => ({
  inner,
  get data() { return inner.data; },
  async updateData(d) {
    if (failuresRemaining.count > 0) {
      failuresRemaining.count -= 1;
      throw new Error("updateData injected failure");
    }
    await inner.updateData(d);
  },
  updateProgress: (p) => inner.updateProgress(p),
  appendEvent: (e, k) => inner.appendEvent(e, k),
});

describe("§6.5 — runStateMachine appendEvent succeeds, updateData throws", () => {
  it("surfaces updateData failure as a runner throw", async () => {
    const inner = createInMemoryJob<State, Ctx>({
      state: { kind: "pending" },
      context: { count: 0 },
    });
    const job = failingUpdateData(inner, { count: 1 });

    // START executor — fires once successfully.
    const executor: Executor<State, Event, Ctx> = async () => ({ type: "START" });

    await expect(
      runStateMachine(job, machine, executor, runOpts),
    ).rejects.toThrow(/updateData injected failure/);
  });

  it("event log retains the event even though updateData failed", async () => {
    const inner = createInMemoryJob<State, Ctx>({
      state: { kind: "pending" },
      context: { count: 0 },
    });
    const job = failingUpdateData(inner, { count: 1 });

    const executor: Executor<State, Event, Ctx> = async () => ({ type: "START" });

    try { await runStateMachine(job, machine, executor, runOpts); } catch { /* expected */ }

    // The append succeeded before the updateData throw — the audit log must
    // not be missing the transition.
    expect(inner.events.length).toBe(1);
    expect((inner.events[0]!.event as Event).type).toBe("START");

    // State did NOT advance (updateData failed) — caller can resume from prior.
    expect(inner.data.state.kind).toBe("pending");
  });

  it("re-derived transition on resume dedups via lastDedupKey (no duplicate append)", async () => {
    const inner = createInMemoryJob<State, Ctx>({
      state: { kind: "pending" },
      context: { count: 0 },
    });
    const failureBudget = { count: 1 };
    const job = failingUpdateData(inner, failureBudget);

    // First executor invocation: START. The runner appendEvents(START, k1);
    // updateData throws; runner throws.
    let invocations = 0;
    const executor: Executor<State, Event, Ctx> = async (state) => {
      invocations += 1;
      if (state.kind === "pending") return { type: "START" };
      return { type: "DONE" };
    };

    try { await runStateMachine(job, machine, executor, runOpts); } catch { /* expected */ }
    expect(inner.events.length).toBe(1);

    // Second attempt: same job (state still pending). The runner re-derives
    // the same (prevStateKey, attempt, event) tuple, so the same dedupKey is
    // computed. The in-memory adapter sees `dedupKey === lastDedupKey` and
    // skips the append — at-most-once delivery preserved.
    const final = await runStateMachine(job, machine, executor, runOpts);

    // appendEvent for the re-derived START was deduped; the DONE event
    // appended fresh.
    expect(inner.events.length).toBe(2);
    expect((inner.events[0]!.event as Event).type).toBe("START");
    expect((inner.events[1]!.event as Event).type).toBe("DONE");
    expect(final.state.kind).toBe("succeeded");
    expect(invocations).toBe(3); // pending(throw), pending(retry), running
    expect(failureBudget.count).toBe(0); // injected failure was consumed
  });
});
