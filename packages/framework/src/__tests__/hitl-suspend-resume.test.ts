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

import { NoopObserver } from "../observer/observer.js";
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
import type { HumanReviewOutcome } from "../dag-runtime/types.js";
import { ok } from "../types/result.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors dag-runtime-stateful.test.ts)
// ---------------------------------------------------------------------------

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
