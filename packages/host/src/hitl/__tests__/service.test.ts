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
import type { HitlRunService } from "../service.js";

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
  // `clears` counts gate resolutions (decision consumed): the hook's
  // `onDecisionConsumed` clears the gate once the post-gate checkpoint is durable.
  const clears: string[] = [];
  const key = (runId: RunId, nodeId: NodeId) => `${runId}:${nodeId}`;
  const port: DecisionStorePort = {
    async markPending(runId, nodeId) {
      const k = key(runId, nodeId);
      if (pendingMarks.has(k)) return ok(false);
      pendingMarks.add(k);
      return ok(true);
    },
    async isPending(runId, nodeId) {
      return ok(pendingMarks.has(key(runId, nodeId)));
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
      clears.push(k);
      pendingMarks.delete(k);
      decisions.delete(k);
      return ok(undefined);
    },
  };
  return { port, pendingMarks, decisions, clears };
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
        onDecisionConsumed: req.onDecisionConsumed,
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

  it("recordDecision refuses a run not parked at the gate (run-not-suspended)", async () => {
    const dag = twoWaveDag();
    const { service, store, queue } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    // The run is `queued` (worker hasn't run) — nothing to decide yet.
    const tooEarly = await service.recordDecision(runId, "review" as NodeId, { kind: "approve" });
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.error.kind).toBe("run-not-suspended");

    // Parked at `review` — a decision aimed at a DIFFERENT gate is refused too,
    // so a stale card for an earlier gate can't auto-resolve the current one.
    await queue.drain();
    expect(store.runs.get(runId)!.status.kind).toBe("suspended");
    const wrongGate = await service.recordDecision(runId, "draft" as NodeId, { kind: "approve" });
    expect(wrongGate.ok).toBe(false);
    if (!wrongGate.ok) expect(wrongGate.error.kind).toBe("run-not-suspended");

    // The decision for the CURRENT gate still resolves the run.
    const onGate = await service.recordDecision(runId, "review" as NodeId, { kind: "approve" });
    expect(onGate.ok).toBe(true);
  });

  it("recordDecision accepts an approval that lands in the `running` window (no lost wakeup)", async () => {
    // Reproduces the race: the notifier fires from INSIDE the hook, while the
    // worker is still mid-`processRun` (status === "running") and the `suspended`
    // status has NOT yet been folded back into the run store. An approval arriving
    // here must be accepted — gated on the pending marker (written before notify),
    // not the lagging run-store status — or it is dropped and the run is stranded.
    const dag = twoWaveDag();
    const store = inMemoryRunStore();
    const queue = inMemoryRunQueue();
    const dec = inMemoryDecisionStore();
    let counter = 0;
    let service: HitlRunService;
    const observed: { statusAtNotify: string; decisionOk: boolean }[] = [];
    const racyNotifier: HumanReviewNotifierPort = {
      async notify(n) {
        // We are inside the hook → the worker has set `running` but not yet `suspended`.
        const statusAtNotify = store.runs.get(n.runId)!.status.kind;
        const decided = await service.recordDecision(n.runId, n.nodeId, { kind: "approve" });
        observed.push({ statusAtNotify, decisionOk: decided.ok });
        return ok(undefined);
      },
    };
    service = createHitlRunService({
      runStore: store.port,
      runQueue: queue.port,
      decisions: dec.port,
      notifier: racyNotifier,
      executor: realExecutor(dag),
      clock: () => 1_000,
      newRunId: () => mkRunId(`run-${++counter}`),
    });
    queue.setProcessor(service.processRun);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    // park (notify fires + records the decision mid-flight, re-enqueuing) → resume → complete
    await queue.drain();

    expect(observed).toEqual([{ statusAtNotify: "running", decisionOk: true }]);
    expect(store.runs.get(runId)!.status.kind).toBe("completed");
  });

  it("two valid approvals racing the SAME open gate → execute once, notify once, consume once (ADR-0060 duplicate-approval window)", async () => {
    // ADR-0060 "Known timing window → Duplicate approval": two approvals can both
    // observe `isPending === true` and both `enqueue` (the queue is intentionally
    // non-idempotent; resume re-enqueues must never be dropped). The resolved
    // behaviour: the single-flight lock + terminal/already-advanced guard mean the
    // gated node executes EXACTLY ONCE; the second job is a redundant no-op slice,
    // with NO duplicate notification and the decision consumed exactly once.
    let draftRuns = 0;
    let reviewRuns = 0;
    const dag = twoWaveDag({ onDraft: () => { draftRuns++; }, onReview: () => { reviewRuns++; } });
    const { service, store, queue, dec, notif } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    await queue.drain(); // park at the review gate + notify (1)
    expect(store.runs.get(runId)!.status.kind).toBe("suspended");
    expect(notif.sent).toHaveLength(1);

    // TWO approvals race the SAME open gate: both see the pending marker, both
    // record (idempotent — same gate, last write wins), both enqueue a wakeup.
    const first = await service.recordDecision(runId, "review" as NodeId, { kind: "approve", actor: "Alice" });
    const second = await service.recordDecision(runId, "review" as NodeId, { kind: "approve", actor: "Bob" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Both passed `isPending` and both enqueued — TWO wakeup jobs are now queued.
    expect(queue.pending).toHaveLength(2);

    // Drain both jobs. The first resumes → completes + consumes (clears) the gate;
    // the second hits the terminal guard in processRun and is a no-op slice.
    await queue.drain();

    const done = store.runs.get(runId)!;
    expect(done.status.kind).toBe("completed");
    if (done.status.kind === "completed") expect(done.status.output).toBe("review-out");

    // EXACTLY-ONCE effects despite the duplicate approval:
    expect(draftRuns).toBe(1);                                    // upstream node ran once
    expect(reviewRuns).toBe(1);                                   // gated node executed once
    expect(notif.sent).toHaveLength(1);                           // no duplicate notification
    expect(dec.clears).toEqual([`${runId}:review`]);             // decision consumed exactly once
    expect(dec.decisions.has(`${runId}:review`)).toBe(false);     // and not left dangling
    expect(queue.pending).toHaveLength(0);                        // both jobs drained
  });

  it("processRun for a terminal (completed) run is a no-op — never re-executes", async () => {
    let draftRuns = 0;
    let reviewRuns = 0;
    const dag = twoWaveDag({ onDraft: () => { draftRuns++; }, onReview: () => { reviewRuns++; } });
    const { service, store, queue } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    await queue.drain(); // park
    await service.recordDecision(runId, "review" as NodeId, { kind: "approve" });
    await queue.drain(); // resume → complete
    expect(store.runs.get(runId)!.status.kind).toBe("completed");
    expect(draftRuns).toBe(1);
    expect(reviewRuns).toBe(1);

    // A stray double-enqueue AFTER completion (e.g. a duplicate/replayed approval
    // re-waking the run) must hit the terminal guard, not re-run the DAG's
    // side-effecting nodes.
    const replay = await service.processRun(runId);
    expect(replay.ok).toBe(true);
    expect(store.runs.get(runId)!.status.kind).toBe("completed");
    expect(draftRuns).toBe(1); // unchanged — guard held
    expect(reviewRuns).toBe(1);
  });

  it("processRun for an unknown run is an ok no-op (stale enqueue)", async () => {
    const dag = twoWaveDag();
    const { service } = setup(dag);
    const res = await service.processRun(mkRunId("ghost"));
    expect(res.ok).toBe(true);
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
