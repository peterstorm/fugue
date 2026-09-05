// Regression suite for the 2026-05-11 framework review remediation pass 3.
// Each describe block maps to a Wave-N fix in
// docs/plans/2026-05-11-framework-review-remediation-pass-3.md.

import { describe, it, expect } from "bun:test";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { z } from "zod";

import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { runStateMachine } from "../state-machine/runner.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import { compileDagToMachine } from "../dag-runtime/machine.js";
import { buildDagExecutor } from "../dag-runtime/executor.js";
import { defineDag } from "../executor/define-dag.js";
import { handleNodeFailed } from "../dag-runtime/retry-policy.js";

import { createCronScheduler } from "../scheduler/scheduler.js";
import type { TaskConfig, TaskRegistry } from "../scheduler/types.js";
import type { MarkerStore } from "../queue/types.js";

import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import { judgePassed, judgeCrashed } from "../nodes/eval-judge.js";
import type { DagDef, EdgeDefRawInput } from "../types/dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { brandAsValidatedNodeContext } from "../types/node.js";
import type { DagPhase, DagMachineContext } from "../dag-runtime/types.js";
import { ok, err } from "../types/result.js";
import { NoopObserver } from "../observer/observer.js";
import { DAG_INPUT } from "../types/ids.js";
import { N } from "./_id-helpers.js";
import { setFrameworkTracer, __resetFrameworkTracer } from "../tracing/global-tracer.js";
import { setFrameworkLogger, __resetFrameworkLogger } from "../logger.js";
import { nonEmptyString } from "../types/non-empty-string.js";
import { testNodeContext } from "./_context-factories.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const makeBaseCtx = (overrides: Partial<NodeContext> = {}): NodeContext =>
  testNodeContext(overrides);

const noop = async (_input: unknown, _ctx: NodeContext) => ok(undefined as unknown);

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown>> = {},
): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded ID test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...overrides,
});

const makeDag = (
  nodes: readonly NodeDef<unknown, unknown>[],
  edges: readonly EdgeDefRawInput[] = [],
  extras: Partial<{ outputNodeId: string; defaultRetryLimit: number; retryLimits: Readonly<Record<string, number>>; evalJudges: DagDef["evalJudges"] }> = {},
): DagDef =>
  defineDag({
    id: "test-dag",
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges,
    ...extras,
  });

// ---------------------------------------------------------------------------
// Wave 1.1 / Test 6.1 — `aborted` fast-fail
// ---------------------------------------------------------------------------

describe("Wave 1.1 — aborted FrameworkError fast-fails without consuming retry budget", () => {
  it("a node returning err(aborted) terminates with aborted on the first attempt", async () => {
    let attempts = 0;
    const dag = makeDag(
      [
        makeNode("a", {
          run: async () => {
            attempts += 1;
            return err({ kind: "aborted" as const, reason: "user-cancelled" });
          },
        }),
      ],
      [{ from: DAG_INPUT, to: "a" }],
      { defaultRetryLimit: 5 }, // generous budget; the fix must skip it for aborted
    );

    const result = await runDagStateful(dag, null, makeBaseCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
      // Most importantly: not retry-exhausted. The retry budget is intact.
      expect(result.error.kind).not.toBe("retry-exhausted");
    }
    expect(attempts).toBe(1);
  });

  it("handleNodeFailed transitions straight to failed for aborted regardless of budget", () => {
    const dag = makeDag([makeNode("a")], [{ from: DAG_INPUT, to: "a" }], { defaultRetryLimit: 10 });
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compileDagToMachine failed");

    const result = handleNodeFailed(
      0,
      N("a"),
      { kind: "aborted", reason: "signal" },
      compiled.value.initialContext,
    );

    expect(result.state.kind).toBe("failed");
    if (result.state.kind === "failed") {
      expect(result.state.error.kind).toBe("aborted");
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 1.2 / Test 6.2 — scheduler reconcile mid-fire reads live config
// ---------------------------------------------------------------------------

function makeMarkerStore(): MarkerStore {
  const store = new Map<string, number>();
  return {
    async set(key, ttlSeconds) {
      store.set(key, Date.now() + ttlSeconds * 1000);
    },
    async exists(key) {
      const exp = store.get(key);
      return exp !== undefined && Date.now() < exp;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe("Wave 1.2 — scheduler reconcile mid-fire uses live task config", () => {
  it("a reconcile during an in-flight handleFire causes the re-arm to use the new config", async () => {
    const markers = makeMarkerStore();

    // Control point: each enqueue resolves only when the test releases the
    // returned promise. This holds handleFire mid-flight so the test can
    // reconcile before .then() runs.
    type Release = () => void;
    const pendingReleases: Release[] = [];
    const enqueueCalls: Array<{ taskId: string; validForMs: number }> = [];
    const enqueue = (task: TaskConfig, _triggeredAt: Date): Promise<void> => {
      enqueueCalls.push({ taskId: task.id, validForMs: task.validForMs });
      return new Promise<void>((resolve) => {
        pendingReleases.push(resolve);
      });
    };

    const scheduler = createCronScheduler(markers, { enqueue });

    // Arm task X with cron "* * * * * *" (every second) and validForMs=10000.
    const reg1: TaskRegistry = new Map([
      ["x", { id: "x", cron: "* * * * * *", validForMs: 10_000 }],
    ]);
    scheduler.reconcile(reg1);

    // Wait for the first enqueue to land — at most 2s for "every second" cron.
    const waitForEnqueue = async (target: number, timeoutMs = 3000) => {
      const start = Date.now();
      while (enqueueCalls.length < target) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`enqueueCalls didn't reach ${target} within ${timeoutMs}ms (saw ${enqueueCalls.length})`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    await waitForEnqueue(1);
    expect(enqueueCalls[0]!.validForMs).toBe(10_000);

    // handleFire is now suspended on the unresolved enqueue Promise. Reconcile
    // with an updated config (validForMs=99_999) — without the fix, the in-
    // flight `.then(rescheduleTask(closure-captured-task))` would re-arm with
    // the old config.
    const reg2: TaskRegistry = new Map([
      ["x", { id: "x", cron: "* * * * * *", validForMs: 99_999 }],
    ]);
    scheduler.reconcile(reg2);

    // Now release the in-flight enqueue and let .then() run.
    pendingReleases[0]!();
    await waitForEnqueue(2);

    // The re-armed timer fired again. Inspect the second enqueue — it must
    // see the LIVE config (validForMs=99_999), not the captured original.
    expect(enqueueCalls[1]!.validForMs).toBe(99_999);

    // Drain the in-flight handle so the scheduler can stop cleanly.
    for (const r of pendingReleases.slice(1)) r();
    scheduler.stop();
  });

  it("a reconcile that removes a task drops the timer chain and clears the failure counter", async () => {
    const markers = makeMarkerStore();
    let enqueueCalls = 0;
    const scheduler = createCronScheduler(markers, {
      enqueue: async () => {
        enqueueCalls += 1;
        throw new Error("simulated enqueue failure");
      },
    });

    const reg1: TaskRegistry = new Map([
      ["y", { id: "y", cron: "* * * * * *", validForMs: 5_000 }],
    ]);
    scheduler.reconcile(reg1);

    // Wait for the first failed enqueue.
    const start = Date.now();
    while (enqueueCalls === 0) {
      if (Date.now() - start > 3000) throw new Error("no enqueue within 3s");
      await new Promise((r) => setTimeout(r, 20));
    }

    // Remove the task. After the in-flight .catch() runs, onTimerFire's
    // activeRegistry.get(id) === undefined path means the chain stops here —
    // no further rearm / backoff timers are armed.
    scheduler.reconcile(new Map());

    // Give the .catch() a moment to settle.
    await new Promise((r) => setTimeout(r, 100));

    const beforeStop = enqueueCalls;
    // Wait a further short interval — if the chain continued, we'd see more
    // enqueue calls.
    await new Promise((r) => setTimeout(r, 200));
    expect(enqueueCalls).toBe(beforeStop);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Wave 1.3 / Test 6.3 — event log retains every retry's node-failed event
// ---------------------------------------------------------------------------

describe("Wave 1.3 — dedup-key derivation distinguishes (prevState, event-type) cycles", () => {
  it("both non-terminal retry transitions in a 3-attempt run land in the audit log", async () => {
    let attempts = 0;
    const dag = makeDag(
      [
        makeNode("a", {
          run: async () => {
            attempts += 1;
            return err({
              kind: "node-crash" as const,
              retriability: "retriable" as const,
              nodeId: "a" as NodeId,
              message: `attempt ${attempts}`,
            });
          },
        }),
      ],
      [{ from: DAG_INPUT, to: "a" }],
      // attempt 1 + 2 retries = 3 executions = 3 node-failed events; the
      // third resolves into terminal `failed` so it is NOT appended (FR-005).
      // The audit log therefore holds exactly the two non-terminal failures.
      { defaultRetryLimit: 2 },
    );

    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compileDagToMachine failed");

    const job = createInMemoryJob<DagPhase, DagMachineContext>({
      state: compiled.value.initialState,
      context: compiled.value.initialContext,
    });

    const executor = buildDagExecutor(dag, brandAsValidatedNodeContext(makeBaseCtx()));

    try {
      await runStateMachine(job, compiled.value.machine, executor, {
        errorEventOf: ({ retriable, message }) => ({ type: "executor-error" as const, retriable, error: message }),
      });
    } catch {
      /* runner throws on terminal-failed — expected */
    }

    const nodeFailedEvents = job.events.filter(
      (e) => (e.event as { type?: string }).type === "node-failed",
    );
    expect(attempts).toBe(3);
    expect(nodeFailedEvents.length).toBe(2);
  });

  it("a synthetic machine with repeating (prevState, event-type) cycles produces distinct dedup keys", async () => {
    // This is the structural invariant the fix protects: two transitions
    // sharing prevStateKey and event-type MUST produce distinct dedup keys
    // when both flag as retry-transitions. The original implementation keyed
    // the retry counter by stateKey alone, so once the machine had moved past
    // a self-loop the counter never re-incremented for the same prevState.

    type S = { readonly kind: "x"; readonly tag: number } | { readonly kind: "y"; readonly tag: number } | { readonly kind: "done" };
    type E = { readonly type: "step" };
    type C = Record<string, never>;

    let stepCount = 0;
    const machine = {
      transition: (state: S, _event: E, ctx: C) => {
        stepCount += 1;
        if (stepCount >= 6) return { state: { kind: "done" as const }, context: ctx };
        const next: S =
          state.kind === "x"
            ? { kind: "y", tag: stepCount }
            : state.kind === "y"
            ? { kind: "x", tag: stepCount }
            : { kind: "done" };
        return { state: next, context: ctx };
      },
      isTerminal: (s: S) => s.kind === "done",
      isFailed: (_: S) => false,
      stateProgress: (_: S) => 0,
      // Every non-terminal transition is a "retry" for the purpose of this
      // counter; verifies the keyer's composite (prevStateKey::eventType)
      // produces a strictly-increasing attempt number across cycles where
      // prevStateKey recurs.
      isRetryTransition: (_p: S, n: S) => n.kind !== "done",
      stateKey: (s: S) => JSON.stringify(s),
    };

    const captured: string[] = [];
    const job = createInMemoryJob<S, C>(
      { state: { kind: "x", tag: 0 }, context: {} },
    );
    // Wrap appendEvent to capture every dedupKey rather than relying on
    // last-seen dedup (which would falsely report no collisions).
    const recorder: typeof job = {
      ...job,
      appendEvent: async (event: unknown, dedupKey?: string) => {
        if (dedupKey !== undefined) captured.push(dedupKey);
        await job.appendEvent(event, dedupKey);
      },
    };

    const executor = async (_state: S, _ctx: C): Promise<E> => ({ type: "step" as const });
    await runStateMachine(recorder, machine, executor, {
      errorEventOf: () => ({ type: "step" as const }),
    });

    // 5 retry-flagged step transitions x→y, y→x, x→y, y→x, x→y plus one
    // terminal transition x→done (non-retry). All six dedup keys must be
    // unique — the previous keying-by-stateKey-only would collapse the
    // x→y / y→x cycles into a single slot each, dropping the second and
    // third pair under a strict-dedup adapter (the BullMQ Lua script in
    // particular checks the most recent stream entry).
    expect(captured.length).toBe(6);
    expect(new Set(captured).size).toBe(captured.length);
  });
});

// ---------------------------------------------------------------------------
// Wave 1.4 / Test 6.4 — eval-judge exceptions surface as passed:false
// ---------------------------------------------------------------------------

describe("Wave 1.4 — eval-judge orchestrator exception flips passed to false", () => {
  it("a judge that throws past its own internal handler returns passed:false with crash field", async () => {
    const throwingJudge: EvalJudgeNodeDef = {
      id: N("broken-judge"),
      kind: "eval-judge",
      config: { id: N("broken-judge"), criteria: [N("c1")] },
      run: async () => {
        throw new Error("judge runtime exploded");
      },
    };

    const dag = makeDag(
      [makeNode("a", { run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
      { evalJudges: [throwingJudge] as DagDef["evalJudges"] },
    );

    // Run with synchronous (non-background) judges so the judge result is
    // surfaced to the caller via meta on rootSpan / observer. We need to
    // observe the EvalJudgeResult shape; the simplest seam is to invoke the
    // judge runner directly.
    const { runEvalJudges } = await import("../dag-runtime/eval-judges.js");
    const results = await runEvalJudges([throwingJudge], null, "a-out", new Map(), makeBaseCtx());

    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.outcome).toBe("crash"); // critical: was previously `passed: true`, masking broken judges
    expect(judgePassed(r)).toBe(false);
    expect(r.score).toBeNull();
    if (r.outcome === "crash") {
      expect(r.crashMessage).toBe("judge runtime exploded");
    }

    void dag; // dag construction validated; not needed for the judge-runner direct call
  });

  it("a tracer setup failure cannot replace or suppress the judge outcome", async () => {
    let runCalls = 0;
    const judge: EvalJudgeNodeDef = {
      id: N("tracer-failure-judge"),
      kind: "eval-judge",
      config: { id: N("tracer-failure-judge"), criteria: [N("c1")] },
      run: async () => {
        runCalls += 1;
        return {
          outcome: "passed",
          score: 1,
          criteriaScores: { c1: 1 },
          failedCriteria: [],
          reason: "authoritative judge result",
        };
      },
    };
    setFrameworkTracer({
      startActiveSpan: () => { throw new Error("tracer unavailable"); },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);

    try {
      const { runEvalJudges } = await import("../dag-runtime/eval-judges.js");
      const results = await runEvalJudges([judge], null, null, new Map(), makeBaseCtx());
      expect(results[0]?.outcome).toBe("passed");
      expect(runCalls).toBe(1);
    } finally {
      __resetFrameworkTracer();
    }
  });

  it("a throwing span.addEvent is best-effort and leaves the judge result authoritative", async () => {
    const judge: EvalJudgeNodeDef = {
      id: N("span-event-failure-judge"),
      kind: "eval-judge",
      config: { id: N("span-event-failure-judge"), criteria: [N("c1")] },
      run: async () => ({
        outcome: "passed",
        score: 1,
        criteriaScores: { c1: 1 },
        failedCriteria: [],
        reason: "passed",
      }),
    };
    const span = {
      addEvent: () => { throw new Error("event exporter down"); },
      setStatus: () => {},
      end: () => {},
    };
    setFrameworkTracer({
      startActiveSpan: (_name: string, _opts: unknown, fn: (activeSpan: typeof span) => unknown) => fn(span),
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);

    try {
      const { runEvalJudges } = await import("../dag-runtime/eval-judges.js");
      const results = await runEvalJudges([judge], null, null, new Map(), makeBaseCtx());
      expect(results[0]?.outcome).toBe("passed");
    } finally {
      __resetFrameworkTracer();
    }
  });

  it("a tracer rejecting after callback invocation does not run the judge twice", async () => {
    let runCalls = 0;
    const judge: EvalJudgeNodeDef = {
      id: N("post-callback-tracer-failure"),
      kind: "eval-judge",
      config: { id: N("post-callback-tracer-failure"), criteria: [N("c1")] },
      run: async () => {
        runCalls += 1;
        return {
          outcome: "passed",
          score: 1,
          criteriaScores: { c1: 1 },
          failedCriteria: [],
          reason: "passed",
        };
      },
    };
    const span = { addEvent: () => {}, setStatus: () => {}, end: () => {} };
    setFrameworkTracer({
      startActiveSpan: async (_name: string, _opts: unknown, fn: (activeSpan: typeof span) => Promise<unknown>) => {
        await fn(span);
        throw new Error("tracer rejected after callback");
      },
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);

    try {
      const { runEvalJudges } = await import("../dag-runtime/eval-judges.js");
      const results = await runEvalJudges([judge], null, null, new Map(), makeBaseCtx());
      expect(results[0]?.outcome).toBe("passed");
      expect(runCalls).toBe(1);
    } finally {
      __resetFrameworkTracer();
    }
  });

  it("throwing logger and span cleanup preserve the original judge crash result", async () => {
    const judge: EvalJudgeNodeDef = {
      id: N("hostile-cleanup-judge"),
      kind: "eval-judge",
      config: { id: N("hostile-cleanup-judge"), criteria: [N("c1")] },
      run: async () => { throw new Error("primary judge failure"); },
    };
    const span = {
      addEvent: () => {},
      setStatus: () => { throw new Error("setStatus failed"); },
      end: () => { throw new Error("end failed"); },
    };
    setFrameworkTracer({
      startActiveSpan: (_name: string, _opts: unknown, fn: (activeSpan: typeof span) => unknown) => fn(span),
    } as unknown as Parameters<typeof setFrameworkTracer>[0]);

    try {
      const { runEvalJudges } = await import("../dag-runtime/eval-judges.js");
      const results = await runEvalJudges([judge], null, null, new Map(), makeBaseCtx({
        logger: { warn: () => {}, error: () => { throw new Error("logger failed"); } },
      }));
      expect(results[0]?.outcome).toBe("crash");
      if (results[0]?.outcome === "crash") expect(results[0].crashMessage).toBe("primary judge failure");
    } finally {
      __resetFrameworkTracer();
    }
  });

  it("a throwing background logger cannot abort independent cleanup or reject the typed result", async () => {
    let ended = 0;
    let emitted = 0;
    setFrameworkLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => { throw new Error("logger failed"); },
    });

    try {
      const { runFinalizeInBackground } = await import("../dag-runtime/eval-judges.js");
      const result = await runFinalizeInBackground(
        async () => { throw new Error("finalize failed"); },
        {
          setStatus: () => { throw new Error("setStatus failed"); },
          end: () => { ended += 1; },
        } as unknown as import("@opentelemetry/api").Span,
        () => { emitted += 1; },
      );

      expect(result.judgesPassed).toBe(false);
      expect(result.judgesCrashed).toBe(true);
      expect(ended).toBe(1);
      expect(emitted).toBe(1);
    } finally {
      __resetFrameworkLogger();
    }
  });

  it("a healthy judge that scores below threshold returns outcome:failed (not a crash)", async () => {
    const lowScoreJudge: EvalJudgeNodeDef = {
      id: N("low-judge"),
      kind: "eval-judge",
      config: { id: N("low-judge"), criteria: [N("c1")], threshold: 0.9 },
      run: async () => ({
        outcome: "failed" as const,
        score: 0.3,
        criteriaScores: { c1: 0.3 },
        failedCriteria: ["c1"],
        reason: "scored 0.3 below threshold 0.9",
      }),
    };

    const { runEvalJudges } = await import("../dag-runtime/eval-judges.js");
    const results = await runEvalJudges([lowScoreJudge], null, "any", new Map(), makeBaseCtx());

    expect(results[0]!.outcome).toBe("failed");
    expect(judgePassed(results[0]!)).toBe(false);
    expect(judgeCrashed(results[0]!)).toBe(false); // not an orchestrator crash — just a low score
  });
});

// ---------------------------------------------------------------------------
// Wave 2.1 — retry-exhausted carries rootErrorKind for programmatic dispatch
// ---------------------------------------------------------------------------

describe("Wave 2.1 — retry-exhausted preserves the underlying error kind", () => {
  it("transient-driven exhaustion sets rootErrorKind=transient and unwraps message into lastError", async () => {
    let attempts = 0;
    const dag = makeDag(
      [
        makeNode("a", {
          run: async () => {
            attempts += 1;
            return err({ kind: "transient" as const, nodeId: "a" as NodeId, message: "429 rate limited" });
          },
        }),
      ],
      [{ from: DAG_INPUT, to: "a" }],
      { defaultRetryLimit: 1 },
    );

    const result = await runDagStateful(dag, null, makeBaseCtx());
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "retry-exhausted") {
      expect(result.error.rootErrorKind).toBe("transient");
      // lastError contains the underlying message, NOT JSON.stringify(...)
      expect(result.error.lastError).toBe("429 rate limited");
    }
    expect(attempts).toBe(2);
  });

  it("node-crash-driven exhaustion sets rootErrorKind=node-crash", async () => {
    const dag = makeDag(
      [
        makeNode("a", {
          run: async () =>
            err({ kind: "node-crash" as const, nodeId: "a" as NodeId, retriability: "retriable" as const, message: "kaboom" }),
        }),
      ],
      [{ from: DAG_INPUT, to: "a" }],
      { defaultRetryLimit: 0 },
    );

    const result = await runDagStateful(dag, null, makeBaseCtx());
    if (!result.ok && result.error.kind === "retry-exhausted") {
      expect(result.error.rootErrorKind).toBe("node-crash");
      expect(result.error.lastError).toBe("kaboom");
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 2.3 — TailSamplingProcessor.forceFlush swallows inner exporter
// rejections rather than letting them escape into OTel SDK shutdown.
// ---------------------------------------------------------------------------

describe("Wave 2.3 — tail-sampling forceFlush isolates inner exporter rejection", () => {
  it("an exporter whose forceFlush rejects bumps exportFailed and resolves cleanly", async () => {
    const { TailSamplingProcessor } = await import("../observer/tail-sampling-processor.js");
    const exporter = {
      export: (_spans: unknown, cb: (result: { code: number }) => void) => cb({ code: 0 }),
      shutdown: async () => undefined,
      forceFlush: async () => {
        throw new Error("transport down");
      },
    } as any;
    const policy = { shouldFlush: () => true } as any;
    const proc = new TailSamplingProcessor(exporter, policy);

    // forceFlush MUST resolve, not reject — otherwise the OTel SDK shutdown
    // sequence surfaces the rejection and a clean app stop looks like a crash.
    await expect(proc.forceFlush()).resolves.toBeUndefined();
    expect(proc.exportFailed).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Wave 6.6 — BufferedObserver clears the buffer even when policy.shouldFlush
// throws. Without the try/finally, a throwing policy strands the buffer.
// ---------------------------------------------------------------------------

describe("Wave 6.6 — BufferedObserver policy-throw still clears the run buffer", () => {
  it("a policy whose shouldFlush throws does not leak the run's buffered events", async () => {
    const { BufferedObserver } = await import("../observer/buffered.js");
    const innerEvents: unknown[] = [];
    const inner = { observe: (e: unknown) => { innerEvents.push(e); } };
    const policy = {
      shouldFlush: () => {
        throw new Error("policy exploded");
      },
    } as any;
    const buf = new BufferedObserver(inner, policy, { sweepIntervalMs: 0 });

    buf.observe({ type: "run-start", runId: "X" as RunId, dagId: "d" as DagId, timestamp: new Date() });
    expect((buf as any).buffers.has("X")).toBe(true);

    // shouldFlush throws — fail-open: events are flushed and buffer cleared.
    // observe() does NOT re-throw (production observers must be failure-tolerant).
    buf.observe({
      type: "run-end",
      runId: "X" as RunId,
      dagId: "d" as DagId,
      timestamp: new Date(),
      duration: 0,
      status: "ok",
    } as any);

    // Buffer cleared even on policy failure
    expect((buf as any).buffers.has("X")).toBe(false);
    // Fail-open: events flushed to inner observer (run-start + run-end)
    expect(innerEvents.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Wave 6.7 — BufferedObserver.evictStale drops orphaned buffers and bumps
// the `evicted` counter.
// ---------------------------------------------------------------------------

describe("Wave 6.7 — BufferedObserver.evictStale", () => {
  it("drops a run buffer whose age exceeds ttlMs and increments evicted", async () => {
    const { BufferedObserver } = await import("../observer/buffered.js");
    const inner = new NoopObserver();
    const policy = { shouldFlush: () => true } as any;
    const buf = new BufferedObserver(inner, policy, { sweepIntervalMs: 0, ttlMs: 1 });

    buf.observe({ type: "run-start", runId: "orphan" as RunId, dagId: "d" as DagId, timestamp: new Date() });
    // Force the buffer to look stale by hand-stamping the activity trackers —
    // avoids relying on real sleep timing. Eviction is INACTIVITY-based
    // (round-22 cr-1): the sweep compares `lastActivityAt`, the per-event
    // refresh, not the open time.
    const entry = (buf as any).buffers.get("orphan");
    entry.createdAt = Date.now() - 5_000;
    entry.lastActivityAt = Date.now() - 5_000;

    (buf as any).evictStale();

    expect((buf as any).buffers.has("orphan")).toBe(false);
    expect((buf as any).evicted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Wave 6.8 — advanceToNextWave walks back through fully-pruned waves to find
// a fallback active node.
// ---------------------------------------------------------------------------

describe("Wave 6.8 — advanceToNextWave multi-wave fallback traversal", () => {
  it("when the last two waves are pruned, the fallback uses an active node from an earlier wave", async () => {
    const { advanceToNextWave } = await import("../dag-runtime/wave-resolution.js");
    const dag = makeDag(
      [makeNode("a"), makeNode("b"), makeNode("c")],
      [{ from: DAG_INPUT, to: "a" }, { from: "a", to: "b" }, { from: "b", to: "c" }],
    );
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed");

    // Construct a context where:
    //   - 3 waves: [[a], [b], [c]]
    //   - only `a` produced output
    //   - b, c pruned from activeNodeIds
    const ctx: DagMachineContext = {
      ...compiled.value.initialContext,
      outputs: new Map([["a", "a-result"]]) as any,
      activeNodeIds: new Set(["a"]) as any,
    };

    const result = advanceToNextWave(2, ctx);
    expect(result.state.kind).toBe("succeeded");
    if (result.state.kind === "succeeded") {
      expect(result.state.output).toBe("a-result");
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 6.9 — handleNodeFailed merges partialOutputs from succeeded siblings
// before evaluating retry budget.
// ---------------------------------------------------------------------------

describe("Wave 6.9 — handleNodeFailed merges partialOutputs into retry ctx", () => {
  it("succeeded siblings carried via partialOutputs are present in the retry context", async () => {
    const { handleNodeFailed } = await import("../dag-runtime/retry-policy.js");
    const dag = makeDag(
      [makeNode("a"), makeNode("b")],
      [{ from: DAG_INPUT, to: "a" }, { from: DAG_INPUT, to: "b" }],
      { defaultRetryLimit: 2 },
    );
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed");

    const partials = new Map<string, unknown>([["b", "b-out"]]);
    const result = handleNodeFailed(
      0,
      N("a"),
      { kind: "node-crash", nodeId: "a" as NodeId, retriability: "retriable", message: "boom" },
      compiled.value.initialContext,
      // @ts-expect-error — branded ID test fixture
      partials,
    );

    expect(result.state.kind).toBe("retrying");
    expect(result.context.outputs.get(N("b"))).toBe(N("b-out"));
  });
});

// ---------------------------------------------------------------------------
// Wave 6.10 — computeBackoffMs property: monotonically non-decreasing on
// successive attempts (catches off-by-one in the Math.min clamp).
// ---------------------------------------------------------------------------

describe("Wave 6.10 — computeBackoffMs clamping + monotonicity-when-array-monotone", () => {
  it("for a monotone non-decreasing backoff array, delay is monotone in attempts (catches off-by-one in the Math.min clamp)", async () => {
    const fc = await import("fast-check");
    const { computeBackoffMs } = await import("../dag-runtime/retry-policy.js");

    fc.assert(
      fc.property(
        // Generate a monotone non-decreasing array — the realistic exponential-backoff shape.
        fc
          .array(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 6 })
          .map((arr) => arr.slice().sort((a, b) => a - b)),
        fc.integer({ min: 0, max: 100 }),
        (backoffMs, attempt) => {
          const dag = makeDag([
            makeNode("n", { retry: { backoffMs, jitterRatio: 0 } } as any),
          ], [{ from: DAG_INPUT, to: "n" }]);
          const compiled = compileDagToMachine(dag, null);
          if (!compiled.ok) return false;
          const d0 = computeBackoffMs(N("n"), attempt, compiled.value.initialContext.retryConfigs);
          const d1 = computeBackoffMs(N("n"), attempt + 1, compiled.value.initialContext.retryConfigs);
          return d1 >= d0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("clamps to the last array entry when attempt exceeds array length", async () => {
    const { computeBackoffMs } = await import("../dag-runtime/retry-policy.js");
    const dag = makeDag([
      makeNode("n", { retry: { backoffMs: [100, 200, 400] as const, jitterRatio: 0 } } as any),
    ], [{ from: DAG_INPUT, to: "n" }]);
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed");

    // attempt 0 → 100, attempt 1 → 200, attempt 2 → 400, attempt 3+ → 400
    expect(computeBackoffMs(N("n"), 0, compiled.value.initialContext.retryConfigs)).toBe(100);
    expect(computeBackoffMs(N("n"), 2, compiled.value.initialContext.retryConfigs)).toBe(400);
    expect(computeBackoffMs(N("n"), 99, compiled.value.initialContext.retryConfigs)).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Wave 6.12 — buildDagExecutor returns node-failed when awaiting-human is
// reached without an onHumanReview hook.
// ---------------------------------------------------------------------------

describe("Wave 6.12 — buildDagExecutor without onHumanReview hook", () => {
  it("when awaiting-human is reached without a hook, executor returns node-failed with the expected message", async () => {
    const dag = makeDag(
      [
        makeNode("a", {
          run: async () => ok("a-out"),
          humanReview: { prompt: "approve?" } as any,
        }),
      ],
      [{ from: DAG_INPUT, to: "a" }],
      { defaultRetryLimit: 0 },
    );
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compile failed");

    const executor = buildDagExecutor(dag, brandAsValidatedNodeContext(makeBaseCtx()));
    const event = await executor(
      {
        kind: "awaiting-human",
        nodeId: "a" as NodeId,
        output: "a-out",
        prompt: nonEmptyString("approve?"),
        pendingReviews: [],
        wave: 0,
      },
      compiled.value.initialContext,
    );
    expect(event.type).toBe("node-failed");
    if (event.type === "node-failed") {
      expect(event.nodeId).toBe(N("a"));
      expect(event.error.kind).toBe("node-crash");
      if (event.error.kind === "node-crash") {
        expect(event.error.message).toContain("no onHumanReview hook supplied");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 4.7 — Machine.stateKey hook (replaces JSON.stringify default per-machine)
// ---------------------------------------------------------------------------

describe("Wave 4.7 — Machine.stateKey hook", () => {
  it("a machine supplying its own stateKey controls the runner's dedup-key derivation", async () => {
    type S = { readonly kind: "x"; readonly seenAt: Map<string, number> } | { readonly kind: "done" };
    type E = { readonly type: "step" };
    type C = Record<string, never>;

    const machine = {
      transition: (state: S, _event: E, ctx: C) =>
        state.kind === "done"
          ? { state, context: ctx }
          : { state: { kind: "done" as const }, context: ctx },
      isTerminal: (s: S) => s.kind === "done",
      isFailed: () => false,
      stateProgress: () => 0,
      // Custom keyer ignores the Map field (which JSON.stringify can't stably
      // represent across runs). Verifies the hook is invoked instead of
      // defaulting to JSON.stringify.
      stateKey: (s: S) => s.kind,
    };

    const job = createInMemoryJob<S, C>({
      state: { kind: "x", seenAt: new Map([["a", 1], ["b", 2]]) },
      context: {},
    });
    const executor = async (): Promise<E> => ({ type: "step" as const });
    await runStateMachine(job, machine, executor, {
      errorEventOf: () => ({ type: "step" as const }),
    });
    expect(job.data.state.kind).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Wave 4.10 — DeadLetterOpts.formatMessage receives raw err (unknown)
// ---------------------------------------------------------------------------

describe("Wave 4.10 — DeadLetterOpts.formatMessage receives raw err", () => {
  it("formatMessage observes an Error object directly (not pre-stringified)", async () => {
    const { attachDeadLetterHandler } = await import("../queue/dead-letter.js");
    let observedErr: unknown = undefined;

    // The dead-letter handler now routes through onExhausted (the queue
    // backend signals exhaustion directly). Capture the exhaustion handler
    // and trigger it manually.
    const exhaustedHandlers: Array<(id: string, err: unknown, attempts: number) => Promise<void>> = [];
    const worker = {
      onFailed: (_handler: unknown) => {
        // Not used by the dead-letter handler after the onExhausted split.
      },
      onExhausted: (handler: (id: string, err: unknown, attempts: number) => Promise<void>) => {
        exhaustedHandlers.push(handler);
      },
      onError: (_handler: unknown) => {},
      close: async () => {},
    } as any;

    attachDeadLetterHandler(worker, { notify: async () => undefined }, {
      getRecipients: () => ["a@x"],
      formatMessage: (_id, err) => {
        observedErr = err;
        return "ok";
      },
    });

    const original = new Error("boom");
    await exhaustedHandlers[0]!("job-1", original, 1);

    expect(observedErr).toBe(original); // identity preserved
    expect((observedErr as Error).message).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// Wave 3.5 — withRetryLimits derives only through the DagDef parser
// ---------------------------------------------------------------------------

describe("Wave 3.5 — withRetryLimits revalidates DagDef derivation", () => {
  it("merges valid call-time limits and returns a freshly validated DagDef", async () => {
    const { withRetryLimits } = await import("../executor/validate-dag.js");
    const dag = makeDag([makeNode("a"), makeNode("b")], [{ from: DAG_INPUT, to: "a" }, { from: "a", to: "b" }], {
      retryLimits: { a: 2, b: 3 },
    });
    const out = withRetryLimits(dag, { b: 99 });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error.kind);
    expect(out.value.retryLimits).toEqual({ a: 2, b: 99 });
    expect(out.value.id).toBe(dag.id);
    expect(out.value.nodes.length).toBe(dag.nodes.length);
  });

  it("rejects unknown nodes and invalid counts instead of laundering the brand", async () => {
    const { withRetryLimits } = await import("../executor/validate-dag.js");
    const dag = makeDag([makeNode("a")], [{ from: DAG_INPUT, to: "a" }]);

    const unknown = withRetryLimits(dag, { typo: 5 });
    const negative = withRetryLimits(dag, { a: -1 });
    expect(unknown.ok).toBe(false);
    expect(negative.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.kind).toBe("validation");
    if (!negative.ok) expect(negative.error.kind).toBe("validation");
  });
});

describe("Wave 2.4 — malformed Redis Stream entry IDs log at decaying frequency", () => {
  it("logs the first 10 occurrences and every 100th thereafter (no silent suppression)", async () => {
    const { __resetEventLogState, __parseEntryIdTimestamp } = await import(
      "../queue-bullmq/event-log.js"
    );
    __resetEventLogState();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === "string") warnings.push(msg);
    };

    try {
      // Drive 215 malformed parses. Contract: log occurrences 1..10 plus 100 and 200.
      for (let i = 0; i < 215; i++) {
        const result = __parseEntryIdTimestamp(`not-a-valid-id-${i}`);
        expect(result.recordedAtMs).toBe(0); // fallback to epoch
        expect(result.synthetic).toBe(true);
      }

      // First 10 + 100th + 200th = 12 warnings.
      expect(warnings.length).toBe(12);
      // The 10th warning should reference the total seen so far.
      expect(warnings[9]).toContain("total malformed seen: 10");
      // The 11th warning is the 100th occurrence.
      expect(warnings[10]).toContain("total malformed seen: 100");
      // The 12th warning is the 200th occurrence.
      expect(warnings[11]).toContain("total malformed seen: 200");

      // Reset clears the count so a follow-up parse logs again.
      __resetEventLogState();
      warnings.length = 0;
      __parseEntryIdTimestamp("post-reset");
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("a valid entry id returns the millisecond prefix without logging", async () => {
    const { __resetEventLogState, __parseEntryIdTimestamp } = await import(
      "../queue-bullmq/event-log.js"
    );
    __resetEventLogState();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === "string") warnings.push(msg);
    };
    try {
      expect(__parseEntryIdTimestamp("1715200000000-0")).toEqual({
        recordedAtMs: 1_715_200_000_000,
        synthetic: false,
      });
      expect(__parseEntryIdTimestamp("1715200000123")).toEqual({
        recordedAtMs: 1_715_200_000_123,
        synthetic: false,
      });
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
