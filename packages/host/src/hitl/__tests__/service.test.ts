// service.test.ts — end-to-end HITL durable-requeue loop (ADR-0060).
//
// Exercises the REAL framework resumable kernel (`runResumableDagJob`,
// suspend/resume) through the host HITL service, with in-memory fakes for the
// run-store, run-queue, decision-store, and notifier. Proves the whole loop:
//
//   startRun -> worker runs -> gate has no decision -> PARK (suspended) + notify
//            -> approval records decision + re-enqueue
//            -> worker resumes from checkpoint -> COMPLETE
//
// and the key invariants: the gated node does not re-run on resume; re-parking
// does not re-notify; reject settles the run failed.

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  ok,
  err,
  toJson,
  runResumableDagJob,
  defineDag,
  runId as mkRunId,
  DAG_INPUT,
  NoopObserver,
} from "@fuguejs/framework";
import { compileDagToMachine, stripNonPersistable } from "@fuguejs/framework/advanced";
import type {
  DagId,
  RunId,
  NodeId,
  HumanAction,
  DagDef,
  NodeContext,
  NodeDef,
  FrameworkError,
  RunId as RunIdT,
} from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import type { HostError } from "../../domain/host-error.js";
import type { AuthIdentity } from "../../domain/auth.js";
import type { RunRecord, RunStatus, ReviewNotification } from "../types.js";
import type {
  RunStorePort,
  RunQueuePort,
  DecisionStorePort,
  HumanReviewNotifierPort,
  RunExecutorPort,
  RunExecOutcome,
  RunExecutionRequest,
} from "../ports.js";
import { createHitlRunService } from "../service.js";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

const inMemoryRunStore = () => {
  const runs = new Map<string, RunRecord>();
  const port: RunStorePort = {
    async create(record) {
      if (runs.has(record.runId)) return err({ kind: "internal-invariant-violated", message: "dup run", context: {} });
      runs.set(record.runId, record);
      return ok(undefined);
    },
    async get(runId) {
      return ok(runs.get(runId) ?? null);
    },
    async saveCheckpoint(runId, checkpoint) {
      const r = runs.get(runId);
      if (!r) return err({ kind: "run-not-found", runId });
      runs.set(runId, { ...r, checkpoint, updatedAtMs: r.updatedAtMs + 1 });
      return ok(undefined);
    },
    async setStatus(runId, status: RunStatus) {
      const r = runs.get(runId);
      if (!r) return err({ kind: "run-not-found", runId });
      runs.set(runId, { ...r, status, updatedAtMs: r.updatedAtMs + 1 });
      return ok(undefined);
    },
  };
  return { port, runs };
};

/** A queue whose processor is set by the service consumer; drains FIFO. */
const inMemoryRunQueue = () => {
  const pending: RunId[] = [];
  let processor: ((runId: RunId) => Promise<Result<void, HostError>>) | null = null;
  const port: RunQueuePort = {
    async enqueue(runId) {
      pending.push(runId);
      return ok(undefined);
    },
  };
  const setProcessor = (p: (runId: RunId) => Promise<Result<void, HostError>>) => { processor = p; };
  /** Process every queued run (and any enqueued during processing) to completion. */
  const drain = async (): Promise<void> => {
    if (!processor) throw new Error("no processor set");
    while (pending.length > 0) {
      const runId = pending.shift()!;
      await processor(runId);
    }
  };
  return { port, setProcessor, drain, pending };
};

const inMemoryDecisionStore = () => {
  const pendingMarks = new Set<string>();
  const decisions = new Map<string, HumanAction>();
  const key = (runId: RunId, nodeId: NodeId) => `${runId}:${nodeId}`;
  const port: DecisionStorePort = {
    async markPending(runId, nodeId) {
      const k = key(runId, nodeId);
      if (pendingMarks.has(k)) return ok(false);
      pendingMarks.add(k);
      return ok(true);
    },
    async putDecision(runId, nodeId, action) {
      decisions.set(key(runId, nodeId), action);
      return ok(undefined);
    },
    async getDecision(runId, nodeId) {
      return ok(decisions.get(key(runId, nodeId)) ?? null);
    },
    async clear(runId, nodeId) {
      const k = key(runId, nodeId);
      pendingMarks.delete(k);
      decisions.delete(k);
      return ok(undefined);
    },
  };
  return { port, pendingMarks, decisions };
};

const recordingNotifier = () => {
  const sent: ReviewNotification[] = [];
  const port: HumanReviewNotifierPort = {
    async notify(n) {
      sent.push(n);
      return ok(undefined);
    },
  };
  return { port, sent };
};

// ---------------------------------------------------------------------------
// A REAL executor over runResumableDagJob (single test DAG)
// ---------------------------------------------------------------------------

const noopRun = async (_i: unknown, _c: NodeContext) => ok(undefined as unknown);

const makeNode = (id: string, overrides: Partial<NodeDef<unknown, unknown>> = {}): NodeDef<unknown, unknown> => ({
  // @ts-expect-error — branded id test fixture
  id,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  run: noopRun as never,
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  ...overrides,
});

const makeCtx = (): NodeContext => ({
  runId: "ctx-run" as RunIdT,
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

/** RunExecutor backed by the real framework kernel for one DAG. */
const realExecutor = (dag: DagDef): RunExecutorPort => ({
  async seedCheckpoint(_dagId, input) {
    const compiled = compileDagToMachine(dag, input);
    if (!compiled.ok) return err({ kind: "internal-invariant-violated", message: "compile failed", context: {} });
    const persisted = stripNonPersistable(compiled.value.initialContext);
    return ok(toJson({ state: compiled.value.initialState, context: persisted }));
  },
  async run(req: RunExecutionRequest): Promise<Result<RunExecOutcome, HostError>> {
    try {
      const outcome = await runResumableDagJob<unknown, unknown>(dag, req.input, makeCtx(), {
        jobLike: req.jobLike,
        onHumanReview: req.onHumanReview,
      });
      if (outcome.kind === "suspended") {
        return ok({ kind: "suspended", nodeId: outcome.nodeId, prompt: outcome.prompt });
      }
      return ok({ kind: "completed", output: outcome.output });
    } catch (e) {
      const fe = (e as { cause?: FrameworkError }).cause;
      const error: FrameworkError = fe ?? {
        kind: "node-crash",
        retriability: "non-retriable",
        nodeId: "__executor__" as NodeId,
        message: e instanceof Error ? e.message : String(e),
      };
      return ok({ kind: "failed", error });
    }
  },
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const ADMIN: AuthIdentity = { kind: "admin" };

const setup = (dag: DagDef) => {
  const store = inMemoryRunStore();
  const queue = inMemoryRunQueue();
  const dec = inMemoryDecisionStore();
  const notif = recordingNotifier();
  let counter = 0;
  const service = createHitlRunService({
    runStore: store.port,
    runQueue: queue.port,
    decisions: dec.port,
    notifier: notif.port,
    executor: realExecutor(dag),
    clock: () => 1_000,
    newRunId: () => mkRunId(`run-${++counter}`),
  });
  queue.setProcessor(service.processRun);
  return { service, store, queue, dec, notif };
};

// draft (no review) -> review (humanReview) ; output = review
const twoWaveDag = (drafts: { onDraft?: () => void; onReview?: () => void } = {}): DagDef =>
  defineDag({
    id: "test-dag",
    nodes: {
      draft: makeNode("draft", { run: async () => { drafts.onDraft?.(); return ok("draft-out"); } }),
      review: makeNode("review", {
        humanReview: { prompt: "Approve the draft?" },
        run: async () => { drafts.onReview?.(); return ok("review-out"); },
      }),
    },
    edges: [{ from: DAG_INPUT, to: "draft" }, { from: "draft", to: "review" }],
    outputNodeId: "review",
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HITL run service (ADR-0060) — durable requeue loop", () => {
  it("startRun → park → approve → resume → complete (gated node runs once)", async () => {
    let draftRuns = 0;
    let reviewRuns = 0;
    const dag = twoWaveDag({ onDraft: () => { draftRuns++; }, onReview: () => { reviewRuns++; } });
    const { service, store, queue, dec, notif } = setup(dag);

    // 1. start → queued
    const started = await service.startRun("test-dag" as DagId, { x: 1 }, ADMIN);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const runId = started.value.runId;
    expect(store.runs.get(runId)?.status.kind).toBe("queued");

    // 2. worker processes → parks at the review gate, notifies once
    await queue.drain();
    const parked = store.runs.get(runId)!;
    expect(parked.status.kind).toBe("suspended");
    if (parked.status.kind === "suspended") {
      expect(parked.status.nodeId).toBe("review" as NodeId);
      expect(parked.status.prompt).toBe("Approve the draft?");
    }
    expect(notif.sent).toHaveLength(1);
    expect(notif.sent[0]!.nodeId).toBe("review" as NodeId);
    // The reviewer sees the GATED node's output (what's under review).
    expect(notif.sent[0]!.output).toBe("review-out");

    // 3. approval → records decision + re-enqueues
    const decided = await service.recordDecision(runId, "review" as NodeId, { kind: "approve" });
    expect(decided.ok).toBe(true);

    // 4. worker resumes → completes with the review node's output
    await queue.drain();
    const done = store.runs.get(runId)!;
    expect(done.status.kind).toBe("completed");
    if (done.status.kind === "completed") expect(done.status.output).toBe("review-out");

    // Invariants: each node ran exactly once — resume re-dispatches the HOOK,
    // not the upstream nodes; and the gate notified exactly once.
    expect(draftRuns).toBe(1);
    expect(reviewRuns).toBe(1);
    expect(notif.sent).toHaveLength(1);
  });

  it("a re-park (resume with still no decision) does not re-notify", async () => {
    const dag = twoWaveDag();
    const { service, store, queue, notif } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    await queue.drain(); // park + notify (1)
    // Re-enqueue WITHOUT recording a decision (e.g. a spurious wake-up).
    await queue.port.enqueue(runId);
    await queue.drain(); // resume → still pending → re-park

    expect(store.runs.get(runId)!.status.kind).toBe("suspended");
    expect(notif.sent).toHaveLength(1); // not re-notified
  });

  it("approve-with-edit on resume completes with the edited output", async () => {
    const dag = twoWaveDag();
    const { service, store, queue } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    await queue.drain();
    await service.recordDecision(runId, "review" as NodeId, { kind: "approve-with-edit", newOutput: "edited!" });
    await queue.drain();

    const done = store.runs.get(runId)!;
    expect(done.status.kind).toBe("completed");
    if (done.status.kind === "completed") expect(done.status.output).toBe("edited!");
  });

  it("reject on resume settles the run failed", async () => {
    const dag = twoWaveDag();
    const { service, store, queue } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    await queue.drain();
    await service.recordDecision(runId, "review" as NodeId, { kind: "reject", reason: "not good enough" });
    await queue.drain();

    const done = store.runs.get(runId)!;
    expect(done.status.kind).toBe("failed");
    if (done.status.kind === "failed") expect(done.status.error.kind).toBe("rejected");
  });

  it("recordDecision for an unknown run errs run-not-found", async () => {
    const dag = twoWaveDag();
    const { service } = setup(dag);
    const res = await service.recordDecision(mkRunId("nope"), "review" as NodeId, { kind: "approve" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("run-not-found");
  });

  it("getRun reflects the lifecycle: queued → suspended → completed", async () => {
    const dag = twoWaveDag();
    const { service, queue } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    const q = await service.getRun(runId);
    expect(q.ok && q.value?.status.kind).toBe("queued");

    await queue.drain();
    const s = await service.getRun(runId);
    expect(s.ok && s.value?.status.kind).toBe("suspended");

    await service.recordDecision(runId, "review" as NodeId, { kind: "approve" });
    await queue.drain();
    const c = await service.getRun(runId);
    expect(c.ok && c.value?.status.kind).toBe("completed");
  });
});
