// hitl-suspend-resume.test.ts — the durable suspend/resume primitive (ADR-0060).
//
// Covers the new "park the worker, resume later" path:
//   - onHumanReview returning { kind: "pending" } parks the run as `suspended`
//   - the kernel HALTS (isHalted) and persists the parked state durably
//   - runResumableDagJob surfaces { kind: "suspended" } WITHOUT throwing
//   - re-running the SAME durable job resumes at the gate and re-dispatches the
//     hook (decision now present -> completes; still pending -> re-parks)
//   - the gated node does NOT re-run on resume (its output is preserved)
//   - synchronous runDag treats a pending hook as a misuse (invariant err)

import { NoopObserver, RecordingObserver } from "../observer/observer.js";
import type { HumanInterventionEvent } from "../types/events.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { describe, it, expect, mock } from "bun:test";
import { z } from "zod";
import { runResumableDagJob, runDag } from "../executor/run-dag.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import { compileDagToMachine } from "../dag-runtime/machine.js";
import { defineDag } from "../executor/define-dag.js";
import type { DagDef, EdgeDefRawInput } from "../types/dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import { type NodeOverride, brandedOverride } from "./_node-override.js";
import type { HumanReviewOutcome, DagPhase, DagMachineContext } from "../dag-runtime/types.js";
import { ok } from "../types/result.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors dag-runtime-stateful.test.ts)
// ---------------------------------------------------------------------------

const noop = async (_input: unknown, _ctx: NodeContext) => ok(undefined as unknown);

const makeNode = (
  id: string,
  overrides: NodeOverride = {},
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
  ...brandedOverride(overrides),
});

const makeCtx = (): NodeContext => ({
  runId: "test-run-id" as RunId,
  dagId: "test-dag" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  http: null,
  clock: null,
  logger: { warn: () => {}, error: () => {} },
});

const makeDag = (nodes: readonly NodeDef<unknown, unknown>[], edges: readonly EdgeDefRawInput[], outputNodeId?: string): DagDef =>
  defineDag({
    id: "test-dag",
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges,
    outputNodeId,
  });

/** A durable job seeded from the compiled DAG — survives across run calls. */
const durableJob = (dag: DagDef, input: unknown) => {
  const compiled = compileDagToMachine(dag, input);
  if (!compiled.ok) throw new Error("compile failed in test setup");
  return createInMemoryJob({ state: compiled.value.initialState, context: compiled.value.initialContext });
};

const PENDING: HumanReviewOutcome = { kind: "pending" };

// ---------------------------------------------------------------------------
// 1. pending -> suspended (park)
// ---------------------------------------------------------------------------

describe("HITL suspend (ADR-0060) — pending parks the run", () => {
  it("onHumanReview returning pending suspends; runResumableDagJob returns suspended without throwing", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Approve?" }, run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
    );
    const job = durableJob(dag, null);
    const onHumanReview = mock(async (): Promise<HumanReviewOutcome> => PENDING);

    const outcome = await runResumableDagJob<unknown, string>(dag, null, makeCtx(), { jobLike: job, onHumanReview });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind === "suspended") {
      expect(outcome.nodeId).toBe("a" as NodeId);
      expect(outcome.prompt).toBe("Approve?");
    }
    expect(onHumanReview).toHaveBeenCalledTimes(1);
  });

  it("the parked state is persisted durably as `suspended` with the node output preserved", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Approve?" }, run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
    );
    const job = durableJob(dag, null);

    await runResumableDagJob(dag, null, makeCtx(), { jobLike: job, onHumanReview: async () => PENDING });

    expect(job.data.state.kind).toBe("suspended");
    if (job.data.state.kind === "suspended") {
      expect(job.data.state.nodeId).toBe("a" as NodeId);
      expect(job.data.state.output).toBe("a-out");
    }
    // Review-phase progress, NOT a terminal 100.
    expect(job.progress).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 2. resume -> completion (decision now present)
// ---------------------------------------------------------------------------

describe("HITL resume (ADR-0060) — re-enqueue picks up the decision", () => {
  it("a second run of the same durable job resumes at the gate and completes on approve", async () => {
    let runCount = 0;
    const dag = makeDag(
      [makeNode("a", {
        humanReview: { prompt: "Approve?" },
        run: async () => { runCount++; return ok("a-out"); },
      })],
      [{ from: DAG_INPUT, to: "a" }],
      "a",
    );
    const job = durableJob(dag, null);

    // Attempt 1: no decision yet -> park.
    const parked = await runResumableDagJob<unknown, string>(dag, null, makeCtx(), {
      jobLike: job,
      onHumanReview: async () => PENDING,
    });
    expect(parked.kind).toBe("suspended");

    // Attempt 2 (the re-enqueue): decision present -> resume to completion.
    const resumed = await runResumableDagJob<unknown, string>(dag, null, makeCtx(), {
      jobLike: job,
      onHumanReview: async () => ({ kind: "approve" }),
    });

    expect(resumed.kind).toBe("completed");
    if (resumed.kind === "completed") expect(resumed.output).toBe("a-out");
    expect(job.data.state.kind).toBe("succeeded");
    // The gated node ran exactly once — resume re-dispatches the HOOK, not the node.
    expect(runCount).toBe(1);
  });

  it("approve-with-edit on resume replaces the output", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Edit?" }, run: async () => ok("original") })],
      [{ from: DAG_INPUT, to: "a" }],
      "a",
    );
    const job = durableJob(dag, null);

    await runResumableDagJob(dag, null, makeCtx(), { jobLike: job, onHumanReview: async () => PENDING });
    const resumed = await runResumableDagJob<unknown, string>(dag, null, makeCtx(), {
      jobLike: job,
      onHumanReview: async () => ({ kind: "approve-with-edit", newOutput: "edited" }),
    });

    expect(resumed.kind).toBe("completed");
    if (resumed.kind === "completed") expect(resumed.output).toBe("edited");
  });

  it("reject on resume fails the run with kind=rejected", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Approve?" }, run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
      "a",
    );
    const job = durableJob(dag, null);

    await runResumableDagJob(dag, null, makeCtx(), { jobLike: job, onHumanReview: async () => PENDING });

    // A genuine failure (reject) re-throws so the queue sees it (mirrors runDagAsWorkerJob).
    await expect(
      runResumableDagJob(dag, null, makeCtx(), {
        jobLike: job,
        onHumanReview: async () => ({ kind: "reject", reason: "no good" }),
      }),
    ).rejects.toThrow(/rejected|no good/);
  });
});

// ---------------------------------------------------------------------------
// 3. re-park (still pending on resume)
// ---------------------------------------------------------------------------

describe("HITL re-park (ADR-0060) — resume that finds no decision parks again", () => {
  it("resuming a suspended run with pending stays suspended (idempotent)", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Approve?" }, run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
    );
    const job = durableJob(dag, null);

    const first = await runResumableDagJob(dag, null, makeCtx(), { jobLike: job, onHumanReview: async () => PENDING });
    const second = await runResumableDagJob(dag, null, makeCtx(), { jobLike: job, onHumanReview: async () => PENDING });

    expect(first.kind).toBe("suspended");
    expect(second.kind).toBe("suspended");
    expect(job.data.state.kind).toBe("suspended");
  });
});

// ---------------------------------------------------------------------------
// 3b. elapsed-time semantics (ADR-0060 documented trade-off)
// ---------------------------------------------------------------------------

describe("HITL telemetry (ADR-0060) — elapsedMsSinceAwait excludes park duration", () => {
  it("measures only the final decision-present dispatch, not the durable wait across re-enqueues", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Approve?" }, run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
      "a",
    );
    const job = durableJob(dag, null);
    const observer = new RecordingObserver();
    const ctx: NodeContext = { ...makeCtx(), observer };
    let nowMs = 1_000;
    const now = () => nowMs;

    // Park at base time — no decision yet (no human-intervention event on park).
    const parked = await runResumableDagJob(dag, null, ctx, { jobLike: job, onHumanReview: async () => PENDING, now });
    expect(parked.kind).toBe("suspended");

    // Simulate a long durable wait across re-enqueues (a full day parked).
    const PARK_MS = 86_400_000;
    nowMs += PARK_MS;

    // Resume: decision present -> completes and emits the human-intervention event.
    const resumed = await runResumableDagJob<unknown, string>(dag, null, ctx, { jobLike: job, onHumanReview: async () => ({ kind: "approve" }), now });
    expect(resumed.kind).toBe("completed");

    const evt = observer.events.find(
      (e): e is HumanInterventionEvent => (e as { type?: string }).type === "human-intervention",
    );
    expect(evt).toBeDefined();
    // The day-long park MUST NOT be counted — awaitStartMs is captured fresh on
    // each dispatch, so elapsed reflects only the final (resuming) hook call.
    expect(evt!.elapsedMsSinceAwait).toBeGreaterThanOrEqual(0);
    expect(evt!.elapsedMsSinceAwait).toBeLessThan(PARK_MS);
  });
});

// ---------------------------------------------------------------------------
// 3b. effectively-once consumption — crash before the durable post-gate
//     checkpoint must NOT lose the approval (onDecisionConsumed ordering)
// ---------------------------------------------------------------------------

describe("HITL effectively-once consumption (ADR-0060) — crash before commit keeps the approval", () => {
  it("re-reads the decision on resume when a crash lands between read and the durable post-gate checkpoint", async () => {
    let runCount = 0;
    const dag = makeDag(
      [makeNode("a", {
        humanReview: { prompt: "Approve?" },
        run: async () => { runCount++; return ok("a-out"); },
      })],
      [{ from: DAG_INPUT, to: "a" }],
      "a",
    );

    // A decision store proxy modelling the read/consume split: getDecision READS
    // (does not consume); onDecisionConsumed CONSUMES (clears). The fix relies on
    // consume firing only AFTER the durable post-gate checkpoint.
    const decisions = new Map<string, HumanReviewOutcome>();
    const consumed: string[] = [];
    const onHumanReview = async (req: { nodeId: NodeId }): Promise<HumanReviewOutcome> =>
      decisions.get(req.nodeId as string) ?? PENDING;
    const onDecisionConsumed = async (nodeId: NodeId): Promise<void> => {
      decisions.delete(nodeId as string);
      consumed.push(nodeId as string);
    };

    // Durable job that can be told to throw on the NEXT non-suspended (i.e.
    // post-gate / resume) checkpoint write — simulating a worker crash after the
    // kernel reads the decision but before it persists the advanced state.
    const inner = durableJob(dag, null);
    let failNextPostGateWrite = false;
    const job = {
      get data() { return inner.data; },
      async updateData(d: { state: DagPhase; context: DagMachineContext }) {
        if (failNextPostGateWrite && d.state.kind !== "suspended") {
          failNextPostGateWrite = false;
          throw new Error("simulated crash: worker died before the durable post-gate checkpoint");
        }
        return inner.updateData(d);
      },
      async updateProgress(p: number) { return inner.updateProgress(p); },
      async appendEvent(e: unknown, k?: string) { return inner.appendEvent(e, k); },
    };

    // 1. Attempt 1: no decision yet → park at the gate.
    const parked = await runResumableDagJob<unknown, string>(dag, null, makeCtx(), {
      jobLike: job, onHumanReview, onDecisionConsumed,
    });
    expect(parked.kind).toBe("suspended");
    expect(runCount).toBe(1); // the gated node ran once, before parking

    // 2. The human approves (decision now recorded, NOT yet consumed).
    decisions.set("a", { kind: "approve" });

    // 3. Attempt 2: resume, but crash right after the kernel reads the decision
    //    and before it durably persists the post-gate state.
    failNextPostGateWrite = true;
    await expect(
      runResumableDagJob<unknown, string>(dag, null, makeCtx(), { jobLike: job, onHumanReview, onDecisionConsumed }),
    ).rejects.toThrow(/simulated crash/);

    // The approval was NOT consumed (onDecisionConsumed never fired — the write
    // threw first), and the durable checkpoint is still the parked gate.
    expect(consumed).toEqual([]);
    expect(decisions.has("a")).toBe(true);
    expect(inner.data.state.kind).toBe("suspended");

    // 4. Attempt 3: resume cleanly → the decision is RE-READ (not lost) and the
    //    run completes; consumption happens now, after the durable checkpoint.
    const resumed = await runResumableDagJob<unknown, string>(dag, null, makeCtx(), {
      jobLike: job, onHumanReview, onDecisionConsumed,
    });
    expect(resumed.kind).toBe("completed");
    if (resumed.kind === "completed") expect(resumed.output).toBe("a-out");
    expect(runCount).toBe(1); // never re-ran the node across the crash + resumes
    expect(consumed).toEqual(["a"]); // consumed exactly once, only after durability
    expect(decisions.has("a")).toBe(false);
  });

  it("does not consume (clear) the decision until after the post-gate checkpoint on a clean resume", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Approve?" }, run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
      "a",
    );
    const decisions = new Map<string, HumanReviewOutcome>([["a", { kind: "approve" }]]);
    const consumeOrder: string[] = [];
    const job = durableJob(dag, null);
    // Park first so the resume below is a genuine gate resolution.
    await runResumableDagJob(dag, null, makeCtx(), {
      jobLike: job,
      onHumanReview: async () => PENDING,
      onDecisionConsumed: async () => { consumeOrder.push("consumed"); },
    });
    expect(consumeOrder).toEqual([]); // nothing consumed on a park (human-suspend)

    const resumed = await runResumableDagJob<unknown, string>(dag, null, makeCtx(), {
      jobLike: job,
      onHumanReview: async (req: { nodeId: NodeId }) => decisions.get(req.nodeId as string) ?? PENDING,
      onDecisionConsumed: async () => { consumeOrder.push("consumed"); },
    });
    expect(resumed.kind).toBe("completed");
    expect(consumeOrder).toEqual(["consumed"]); // consumed exactly once, on the resolving resume
  });
});

// ---------------------------------------------------------------------------
// 4. synchronous runDag misuse guard
// ---------------------------------------------------------------------------

describe("HITL suspend (ADR-0060) — synchronous runDag rejects a pending hook", () => {
  it("runDag with a pending-returning hook surfaces an invariant error, never a silent pause", async () => {
    const dag = makeDag(
      [makeNode("a", { humanReview: { prompt: "Approve?" }, run: async () => ok("a-out") })],
      [{ from: DAG_INPUT, to: "a" }],
    );

    const result = await runDag(dag, null, makeCtx(), { onHumanReview: async () => PENDING });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("node-crash");
      expect("message" in result.error && result.error.message).toMatch(/suspend/i);
    }
  });
});
