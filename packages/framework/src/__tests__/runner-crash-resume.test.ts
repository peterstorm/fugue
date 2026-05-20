import { describe, it, expect } from "bun:test";
import { runStateMachine } from "../state-machine/runner.js";
import type { JobLike, Machine } from "../state-machine/types.js";

/**
 * Simulates a worker crash *between* a successful `appendEvent` and the
 * subsequent `updateData`. The next worker attempt re-derives the same
 * transition; with a deterministic `dedupKey`, the adapter must collapse
 * the duplicate so the event log shows exactly one entry per transition.
 */
describe("runStateMachine — appendEvent dedup across simulated crash", () => {
  type S = { kind: "pending" } | { kind: "succeeded" };
  type E = { type: "DONE" } | { type: "ERROR"; retriable: boolean; message: string };
  type C = { value: number };

  const machine: Machine<S, E, C> = {
    transition(state, event, context) {
      if (state.kind === "pending" && event.type === "DONE") {
        return { state: { kind: "succeeded" }, context: { value: context.value + 1 } };
      }
      return { state, context };
    },
    isTerminal: (s) => s.kind === "succeeded",
    isFailed: () => false,
    stateProgress: (s) => (s.kind === "pending" ? 0 : 100),
    stateKey: (s) => JSON.stringify(s),
  };

  /**
   * In-memory crash-simulating job. Tracks last `dedupKey` for the most
   * recent appended event and exposes a `simulateCrashAfterAppend` toggle so
   * the test can interrupt between `appendEvent` and `updateData`.
   */
  function createCrashingJob(initial: { state: S; context: C }): JobLike<S, unknown, C> & {
    events: Array<{ event: unknown; dedupKey?: string }>;
    snapshot: { state: S; context: C };
    simulateCrashAfterAppend: boolean;
  } {
    let lastDedupKey: string | undefined;
    const events: Array<{ event: unknown; dedupKey?: string }> = [];
    let snapshot = { ...initial };
    const handle: any = {
      events,
      get snapshot() {
        return snapshot;
      },
      simulateCrashAfterAppend: false,
      get data() {
        return { ...snapshot };
      },
      async updateData(d: { state: S; context: C }): Promise<void> {
        snapshot = { ...d };
      },
      async updateProgress(): Promise<void> {},
      async appendEvent(event: unknown, dedupKey?: string): Promise<void> {
        if (dedupKey !== undefined && dedupKey === lastDedupKey) return;
        events.push({ event, dedupKey });
        if (dedupKey !== undefined) lastDedupKey = dedupKey;
        if (handle.simulateCrashAfterAppend) {
          handle.simulateCrashAfterAppend = false;
          throw new Error("simulated crash between appendEvent and updateData");
        }
      },
    };
    return handle;
  }

  it("re-derived transition produces exactly one event in the log", async () => {
    const job = createCrashingJob({ state: { kind: "pending" }, context: { value: 0 } });

    // First worker invocation: append succeeds, then crash interrupts updateData.
    job.simulateCrashAfterAppend = true;
    await expect(
      runStateMachine<S, E, C>(
        job,
        machine,
        async () => ({ type: "DONE" }),
        { errorEventOf: (c) => ({ type: "ERROR", retriable: c.retriable, message: c.message }) },
      ),
    ).rejects.toThrow(/simulated crash/);

    // Snapshot is still pending — updateData never ran.
    expect(job.snapshot.state.kind).toBe("pending");
    expect(job.events).toHaveLength(1);

    // Second invocation re-derives the same transition. The dedupKey matches
    // the one we appended pre-crash, so the adapter no-ops the second append
    // and the log stays at exactly one entry.
    const result = await runStateMachine<S, E, C>(
      job,
      machine,
      async () => ({ type: "DONE" }),
      { errorEventOf: (c) => ({ type: "ERROR", retriable: c.retriable, message: c.message }) },
    );

    expect(result.state.kind).toBe("succeeded");
    expect(job.events).toHaveLength(1);
  });
});
