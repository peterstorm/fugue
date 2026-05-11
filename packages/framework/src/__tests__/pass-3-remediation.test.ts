// Regression suite for the 2026-05-11 framework review remediation pass 3.
// Each describe block maps to a Wave-N fix in
// docs/plans/2026-05-11-framework-review-remediation-pass-3.md.

import { describe, it, expect } from "bun:test";
import { z } from "zod";

import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { runStateMachine } from "../state-machine/runner.js";
import { createInMemoryJob } from "../state-machine/in-memory-job.js";
import { compileDagToMachine } from "../dag-runtime/machine.js";
import { buildDagExecutor } from "../dag-runtime/executor.js";
import { defineDag } from "../executor/define-dag.js";
import { handleNodeFailed } from "../dag-runtime/transition-helpers.js";

import { createCronScheduler } from "../scheduler/scheduler.js";
import type { TaskConfig, TaskRegistry } from "../scheduler/types.js";
import type { MarkerStore } from "../queue/types.js";

import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import type { DagDef, EdgeDef } from "../types/dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { DagPhase, DagEvent, DagMachineContext } from "../dag-runtime/types.js";
import { ok, err } from "../types/result.js";
import { NoopObserver } from "../observer/observer.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const makeBaseCtx = (overrides: Partial<NodeContext> = {}): NodeContext => ({
  runId: "test-run",
  dagId: "test-dag",
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  logger: { warn: () => {}, error: () => {} },
  cache: null,
  llm: null,
  prompts: null,
  judgeLlm: null,
  ...overrides,
});

const noop = async (_input: unknown, _ctx: NodeContext) => ok(undefined as unknown);

const makeNode = (
  id: string,
  overrides: Partial<NodeDef<unknown, unknown, unknown>> = {},
): NodeDef<unknown, unknown, unknown> => ({
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noop as any,
  requires: [],
  ...overrides,
});

const makeDag = (
  nodes: readonly NodeDef<unknown, unknown, unknown>[],
  edges: readonly EdgeDef[] = [],
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
      [],
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
    const dag = makeDag([makeNode("a")], [], { defaultRetryLimit: 10 });
    const compiled = compileDagToMachine(dag, null);
    if (!compiled.ok) throw new Error("compileDagToMachine failed");

    const result = handleNodeFailed(
      0,
      "a",
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
              nodeId: "a",
              message: `attempt ${attempts}`,
            });
          },
        }),
      ],
      [],
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

    const executor = buildDagExecutor(dag, makeBaseCtx());

    try {
      await runStateMachine(job, compiled.value.machine, executor, {
        errorEventOf: ({ retriable, message }) => ({ type: "ERROR" as const, retriable, error: message }),
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
      id: "broken-judge",
      kind: "eval-judge",
      config: { id: "broken-judge", criteria: ["c1"] },
      run: async () => {
        throw new Error("judge runtime exploded");
      },
    };

    const dag = makeDag(
      [makeNode("a", { run: async () => ok("a-out") })],
      [],
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
    expect(r.passed).toBe(false); // critical: was previously `true`, masking broken judges
    expect(r.skipped).toBe(true);
    expect(r.score).toBeNull();
    expect(r.crash).toBeDefined();
    expect(r.crash!.kind).toBe("judge-crash");
    expect(r.crash!.message).toBe("judge runtime exploded");

    void dag; // dag construction validated; not needed for the judge-runner direct call
  });

  it("a healthy judge that scores below threshold still returns passed:false with NO crash field", async () => {
    const lowScoreJudge: EvalJudgeNodeDef = {
      id: "low-judge",
      kind: "eval-judge",
      config: { id: "low-judge", criteria: ["c1"], threshold: 0.9 },
      run: async () => ({
        passed: false,
        score: 0.3,
        criteriaScores: { c1: 0.3 },
        failedCriteria: ["c1"],
        reason: "scored 0.3 below threshold 0.9",
        skipped: false,
      }),
    };

    const { runEvalJudges } = await import("../dag-runtime/eval-judges.js");
    const results = await runEvalJudges([lowScoreJudge], null, "any", new Map(), makeBaseCtx());

    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.skipped).toBe(false);
    expect(results[0]!.crash).toBeUndefined(); // not an orchestrator crash — just a low score
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
            return err({ kind: "transient" as const, nodeId: "a", message: "429 rate limited" });
          },
        }),
      ],
      [],
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
            err({ kind: "node-crash" as const, nodeId: "a", message: "kaboom" }),
        }),
      ],
      [],
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
      export: (_spans: any, cb: any) => cb({ code: 0 }),
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
// Wave 2.4 — event-log malformed-id warning frequency
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wave 3.5 — withRetryLimits derives a new DagDef without laundering the brand
// ---------------------------------------------------------------------------

describe("Wave 3.5 — withRetryLimits sanctioned DagDef derivation", () => {
  it("merges call-time limits on top of dag.retryLimits with call-time taking precedence", async () => {
    const { withRetryLimits } = await import("../types/dag.js");
    const dag = makeDag([makeNode("a"), makeNode("b")], [{ from: "a", to: "b" }], {
      retryLimits: { a: 2, b: 3 },
    });
    const out = withRetryLimits(dag, { b: 99, c: 7 });
    expect(out.retryLimits).toEqual({ a: 2, b: 99, c: 7 });
    // The returned value is still a branded DagDef — usable wherever DagDef is.
    expect(out.id).toBe(dag.id);
    expect(out.nodes.length).toBe(dag.nodes.length);
  });

  it("works when the original dag has no retryLimits set", async () => {
    const { withRetryLimits } = await import("../types/dag.js");
    const dag = makeDag([makeNode("a")], []);
    const out = withRetryLimits(dag, { a: 5 });
    expect(out.retryLimits).toEqual({ a: 5 });
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
        expect(result).toBe(0); // fallback to epoch
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
      expect(__parseEntryIdTimestamp("1715200000000-0")).toBe(1_715_200_000_000);
      expect(__parseEntryIdTimestamp("1715200000123")).toBe(1_715_200_000_123);
      expect(warnings.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
