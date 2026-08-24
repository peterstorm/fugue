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
  nonEmptyString,
} from "@fuguejs/framework";
import { compileDagToMachine, persistDagContext } from "@fuguejs/framework/advanced";
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
import type { LogPort } from "../../ports.js";
import { markTeam } from "../../domain/auth.js";
import type { AuthIdentity } from "../../domain/auth.js";
import { tenantId } from "../../domain/tenant.js";
import type { TenantId } from "../../domain/tenant.js";
import type { RunRecord, RunStatusUpdate, ReviewNotification } from "../types.js";
import type {
  RunStorePort,
  RunQueuePort,
  DecisionStorePort,
  HumanReviewNotifierPort,
  RunExecutorPort,
  RunExecOutcome,
  RunExecutionRequest,
  RunLease,
} from "../ports.js";
import { createInMemoryRunLeaseAuthority, createInMemoryRunStore } from "../adapters/run-store.js";
import { createHitlRunService } from "../service.js";
import type { HitlRunService } from "../service.js";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

const inMemoryRunStore = () => {
  const leases = createInMemoryRunLeaseAuthority();
  const port = createInMemoryRunStore(leases, () => 1_000);
  return {
    port,
    runs: port._runs as Map<string, RunRecord>,
    active: port._active as Set<string>,
    acquireLease: (runId: RunId, ownerToken = "test-owner"): RunLease =>
      leases.acquire(runId, ownerToken),
  };
};

/** A queue whose processor is set by the service consumer; drains FIFO. */
const inMemoryRunQueue = (acquireLease: (runId: RunId) => RunLease) => {
  const pending: RunId[] = [];
  let processor: ((lease: RunLease) => Promise<Result<void, HostError>>) | null = null;
  const port: RunQueuePort = {
    async enqueue(runId) {
      pending.push(runId);
      return ok(undefined);
    },
  };
  const setProcessor = (p: (lease: RunLease) => Promise<Result<void, HostError>>) => { processor = p; };
  /** Process every queued run (and any enqueued during processing) to completion. */
  const drain = async (): Promise<void> => {
    if (!processor) throw new Error("no processor set");
    while (pending.length > 0) {
      const runId = pending.shift()!;
      await processor(acquireLease(runId));
    }
  };
  return { port, setProcessor, drain, pending };
};

const inMemoryDecisionStore = () => {
  const pendingMarks = new Set<string>();
  const notified = new Set<string>();
  const decisions = new Map<string, HumanAction>();
  // `clears` counts gate resolutions (decision consumed): the hook's
  // `onDecisionConsumed` clears the gate once the post-gate checkpoint is durable.
  const clears: string[] = [];
  const key = (runId: RunId, nodeId: NodeId) => `${runId}:${nodeId}`;
  const port: DecisionStorePort = {
    async preparePending(runId, nodeId) {
      const k = key(runId, nodeId);
      if (!pendingMarks.has(k)) pendingMarks.add(k);
      return ok(notified.has(k)
        ? { kind: "notified" }
        : { kind: "notification-required", marker: k });
    },
    async markNotified(runId, nodeId, marker) {
      const k = key(runId, nodeId);
      if (!pendingMarks.has(k) || marker !== k) return ok(false);
      notified.add(k);
      return ok(true);
    },
    async resolvePending(runId, nodeId, action) {
      const k = key(runId, nodeId);
      if (!pendingMarks.has(k)) return ok({ kind: "not-pending" });
      if (decisions.has(k)) return ok({ kind: "already-resolved" });
      decisions.set(k, action);
      return ok({ kind: "accepted" });
    },
    async getDecision(runId, nodeId) {
      return ok(decisions.get(key(runId, nodeId)) ?? null);
    },
    async clear(runId, nodeId) {
      const k = key(runId, nodeId);
      clears.push(k);
      pendingMarks.delete(k);
      notified.delete(k);
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
    const persisted = persistDagContext(compiled.value.initialContext, dag);
    return ok(toJson({ state: compiled.value.initialState, context: persisted }));
  },
  async run(req: RunExecutionRequest): Promise<Result<RunExecOutcome, HostError>> {
    try {
      const outcome = await runResumableDagJob<unknown, unknown>(dag, req.input, makeCtx(), {
        jobLike: req.job.jobLike,
        onHumanReview: req.onHumanReview,
        onDecisionConsumed: req.onDecisionConsumed,
      });
      if (outcome.kind === "suspended") {
        return ok({ kind: "suspended", nodeId: outcome.nodeId, prompt: nonEmptyString(outcome.prompt) });
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
const OWNER_TEAM = markTeam("test-team");
const THROWING_ERROR_LOGGER: LogPort = {
  info: () => {},
  warn: () => {},
  error: () => { throw new Error("logger transport failed"); },
};

// The worker's bound tenant — names the `tenant-over-quota` error the
// maxQueuedRuns gate returns (ADR-0074). The service requires it.
const TENANT: TenantId = (() => {
  const t = tenantId("acme-prod");
  if (!t.ok) throw new Error("bad test tenant");
  return t.value;
})();

const setup = (dag: DagDef) => {
  const store = inMemoryRunStore();
  const queue = inMemoryRunQueue(store.acquireLease);
  const dec = inMemoryDecisionStore();
  const notif = recordingNotifier();
  let counter = 0;
  const service = createHitlRunService({
    runStore: store.port,
    runQueue: queue.port,
    decisions: dec.port,
    tenant: TENANT,
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
        humanReview: { prompt: nonEmptyString("Approve the draft?") },
        run: async () => { drafts.onReview?.(); return ok("review-out"); },
      }),
    },
    edges: [{ from: DAG_INPUT, to: "draft" }, { from: "draft", to: "review" }],
    outputNodeId: "review",
  });

// Single ungated node — completes in one processRun slice (no human gate).
const oneNodeDag = (): DagDef =>
  defineDag({
    id: "test-dag",
    nodes: { only: makeNode("only", { run: async () => ok("done") }) },
    edges: [{ from: DAG_INPUT, to: "only" }],
    outputNodeId: "only",
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HITL run service (ADR-0060) — durable requeue loop", () => {
  it("startRun → park → approve → resume → complete (gated node runs once)", async () => {
    let draftRuns = 0;
    let reviewRuns = 0;
    const dag = twoWaveDag({ onDraft: () => { draftRuns++; }, onReview: () => { reviewRuns++; } });
    const { service, store, queue, notif } = setup(dag);

    // 1. start → queued
    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, { x: 1 }, ADMIN);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const runId = started.value.runId;
    expect(store.runs.get(runId)?.status.kind).toBe("queued");
    expect(store.runs.get(runId)?.ownerTeam).toBe(OWNER_TEAM);

    // 2. worker processes → parks at the review gate, notifies once
    await queue.drain();
    const parked = store.runs.get(runId)!;
    expect(parked.status.kind).toBe("suspended");
    if (parked.status.kind === "suspended") {
      expect(parked.status.nodeId).toBe("review" as NodeId);
      expect(parked.status.prompt).toBe(nonEmptyString("Approve the draft?"));
    }
    expect(notif.sent).toHaveLength(1);
    expect(notif.sent[0]!.nodeId).toBe("review" as NodeId);
    expect(notif.sent[0]!.ownerTeam).toBe(OWNER_TEAM);
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

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
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

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
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

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    await queue.drain();
    await service.recordDecision(runId, "review" as NodeId, { kind: "reject", reason: "not good enough" });
    await queue.drain();

    const done = store.runs.get(runId)!;
    expect(done.status.kind).toBe("failed");
    if (done.status.kind === "failed") expect(done.status.error.kind).toBe("rejected");
  });

  it("terminalizes the run when consumed-decision cleanup fails", async () => {
    const dag = twoWaveDag();
    const store = inMemoryRunStore();
    const queue = inMemoryRunQueue(store.acquireLease);
    const baseDecisions = inMemoryDecisionStore();
    const decisions: DecisionStorePort = {
      ...baseDecisions.port,
      async clear() { return err({ kind: "redis-unavailable", operation: "DEL decision" }); },
    };
    const service = createHitlRunService({
      runStore: store.port,
      runQueue: queue.port,
      decisions,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(dag),
      clock: () => 1_000,
      newRunId: () => mkRunId("cleanup-failure-run"),
    });
    queue.setProcessor(service.processRun);

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    await queue.drain();
    await service.recordDecision(started.value.runId, "review" as NodeId, { kind: "approve" });
    await queue.drain();

    const persisted = store.runs.get(started.value.runId);
    expect(persisted?.status.kind).toBe("failed");
    expect(store.active.has(started.value.runId)).toBe(false);
    expect(baseDecisions.decisions.has(`${started.value.runId}:review`)).toBe(true);
  });

  it("maps a throwing startRun clock into the typed HostError channel", async () => {
    const store = inMemoryRunStore();
    const service = createHitlRunService({
      runStore: store.port,
      runQueue: inMemoryRunQueue(store.acquireLease).port,
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(oneNodeDag()),
      clock: () => { throw new Error("clock unavailable"); },
      newRunId: () => mkRunId("throwing-clock-run"),
    });

    const result = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal-invariant-violated");
      if (result.error.kind === "internal-invariant-violated") {
        expect(result.error.message).toContain("clock threw");
      }
    }
    expect(store.runs.size).toBe(0);
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

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
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
    const queue = inMemoryRunQueue(store.acquireLease);
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
      tenant: TENANT,
      notifier: racyNotifier,
      executor: realExecutor(dag),
      clock: () => 1_000,
      newRunId: () => mkRunId(`run-${++counter}`),
    });
    queue.setProcessor(service.processRun);

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    // park (notify fires + records the decision mid-flight, re-enqueuing) → resume → complete
    await queue.drain();

    expect(observed).toEqual([{ statusAtNotify: "running", decisionOk: true }]);
    expect(store.runs.get(runId)!.status.kind).toBe("completed");
  });

  it("two valid approvals racing the SAME open gate → execute once, notify once, consume once (ADR-0060 duplicate-approval window)", async () => {
    // Two approvals can both observe the open gate, but resolvePending's SET NX
    // preserves the first action. Both durable outcomes may enqueue (the queue is
    // intentionally non-idempotent); the single-flight lock + terminal guard mean
    // the gated node executes exactly once and the second slice is a no-op.
    let draftRuns = 0;
    let reviewRuns = 0;
    const dag = twoWaveDag({ onDraft: () => { draftRuns++; }, onReview: () => { reviewRuns++; } });
    const { service, store, queue, dec, notif } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    await queue.drain(); // park at the review gate + notify (1)
    expect(store.runs.get(runId)!.status.kind).toBe("suspended");
    expect(notif.sent).toHaveLength(1);

    // TWO approvals race the SAME open gate: the first action is durable and the
    // second observes `already-resolved`; both may enqueue an idempotent wakeup.
    const first = await service.recordDecision(runId, "review" as NodeId, { kind: "approve", actor: "Alice" });
    const second = await service.recordDecision(runId, "review" as NodeId, { kind: "approve", actor: "Bob" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(dec.decisions.get(`${runId}:review`)).toEqual({ kind: "approve", actor: "Alice" });
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

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
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
    const replay = await service.processRun(store.acquireLease(runId));
    expect(replay.ok).toBe(true);
    expect(store.runs.get(runId)!.status.kind).toBe("completed");
    expect(draftRuns).toBe(1); // unchanged — guard held
    expect(reviewRuns).toBe(1);
  });

  it("processRun for an unknown run is an ok no-op (stale enqueue)", async () => {
    const dag = twoWaveDag();
    const { service, store } = setup(dag);
    const res = await service.processRun(store.acquireLease(mkRunId("ghost")));
    expect(res.ok).toBe(true);
  });

  it("fails closed before executor invocation when the durable running write fails", async () => {
    const dag = oneNodeDag();
    const store = inMemoryRunStore();
    const queue = inMemoryRunQueue(store.acquireLease);
    const baseExecutor = realExecutor(dag);
    let runCalls = 0;
    const executor: RunExecutorPort = {
      seedCheckpoint: baseExecutor.seedCheckpoint,
      async run(req) { runCalls += 1; return baseExecutor.run(req); },
    };
    const failingStore: RunStorePort = {
      ...store.port,
      async setStatus(lease, status) {
        if (status.kind === "running") return err({ kind: "redis-unavailable", operation: "setStatus(running)" });
        return store.port.setStatus(lease, status);
      },
    };
    const service = createHitlRunService({
      runStore: failingStore,
      runQueue: queue.port,
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor,
      clock: () => 1_000,
      newRunId: () => mkRunId("run-running-write-failure"),
    });

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const result = await service.processRun(store.acquireLease(started.value.runId));

    expect(result).toEqual(err({ kind: "redis-unavailable", operation: "setStatus(running)" }));
    expect(runCalls).toBe(0);
    expect(store.runs.get(started.value.runId)?.status.kind).toBe("queued");
  });

  it("settles a corrupt-checkpoint run `failed` and returns ok (no infinite retry)", async () => {
    // service.ts:174-183 — a structurally-corrupt checkpoint cannot heal on
    // retry, so processRun settles the run terminal `failed` (a status poll
    // surfaces it) and returns OK so the worker acks the job rather than
    // re-processing the same corrupt state forever. The unit boundary
    // (makeRunStoreJobLike rejecting the checkpoint) is covered in
    // run-store-job.test.ts; this pins the service-level wiring end-to-end.
    const dag = twoWaveDag();
    const { service, store } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;

    // Corrupt the persisted checkpoint in place (torn / garbage Redis value).
    const rec = store.runs.get(runId)!;
    store.runs.set(runId, { ...rec, checkpoint: "}{ not a valid envelope" });

    const res = await service.processRun(store.acquireLease(runId));
    expect(res.ok).toBe(true); // acked — no queue retry
    expect(store.runs.get(runId)!.status.kind).toBe("failed"); // settled terminal
  });

  it("terminalizes a permanent executor failure so reconciliation cannot retry it forever", async () => {
    const store = inMemoryRunStore();
    const queue = inMemoryRunQueue(store.acquireLease);
    const permanent: FrameworkError = {
      kind: "node-crash",
      retriability: "non-retriable",
      nodeId: "__executor__" as NodeId,
      message: "DAG is no longer registered",
    };
    const seeded = realExecutor(oneNodeDag());
    const executor: RunExecutorPort = {
      seedCheckpoint: seeded.seedCheckpoint,
      async run() { return ok({ kind: "failed", error: permanent }); },
    };
    const service = createHitlRunService({
      runStore: store.port,
      runQueue: queue.port,
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor,
      clock: () => 1_000,
      newRunId: () => mkRunId("removed-dag-run"),
    });
    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");

    expect(await service.processRun(store.acquireLease(started.value.runId))).toEqual(ok(undefined));
    expect(store.runs.get(started.value.runId)?.status).toEqual({ kind: "failed", error: permanent });
    expect(store.active.has(started.value.runId)).toBe(false);
    expect(await service.reconcileActiveRuns()).toEqual(ok([]));
  });

  it("returns executor infrastructure errors for queue retry without terminalizing the run", async () => {
    // A typed executor Err detected before a run outcome exists is not a DAG
    // outcome. Keep the run non-terminal at its running entry fence and let the
    // queue retry. Post-transition checkpoint loss is a separate failed outcome.
    const dag = twoWaveDag();
    const store = inMemoryRunStore();
    const queue = inMemoryRunQueue(store.acquireLease);
    const dec = inMemoryDecisionStore();
    const notif = recordingNotifier();
    let counter = 0;
    const real = realExecutor(dag);
    const executor: RunExecutorPort = {
      seedCheckpoint: real.seedCheckpoint,
      async run() {
        return err({ kind: "internal-invariant-violated", message: "infra boom", context: {} });
      },
    };
    let terminalWrites = 0;
    const trackingStore: RunStorePort = {
      ...store.port,
      async setStatus(lease, status: RunStatusUpdate) {
        if (status.kind === "failed") terminalWrites++;
        return store.port.setStatus(lease, status);
      },
    };
    const service = createHitlRunService({
      runStore: trackingStore, runQueue: queue.port, decisions: dec.port, tenant: TENANT,
      notifier: notif.port, executor, clock: () => 1_000, newRunId: () => mkRunId(`run-${++counter}`),
    });

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const res = await service.processRun(store.acquireLease(started.value.runId));
    expect(res).toEqual(err({ kind: "internal-invariant-violated", message: "infra boom", context: {} }));
    expect(terminalWrites).toBe(0);
    expect(store.runs.get(started.value.runId)?.status.kind).toBe("running");
  });

  it("returns err (queue retry) when folding a `completed` outcome into the store fails", async () => {
    // service.ts:230-231 — the executor completed, but writing the `completed`
    // status fails; the outcome is not durably recorded, so processRun surfaces
    // the err for the worker to retry rather than silently losing the result.
    const dag = oneNodeDag();
    const store = inMemoryRunStore();
    const queue = inMemoryRunQueue(store.acquireLease);
    const dec = inMemoryDecisionStore();
    const notif = recordingNotifier();
    let counter = 0;
    const failingStore: RunStorePort = {
      ...store.port,
      async setStatus(lease, status: RunStatusUpdate) {
        if (status.kind === "completed") return err({ kind: "redis-unavailable", operation: "setStatus(completed)" });
        return store.port.setStatus(lease, status);
      },
    };
    const service = createHitlRunService({
      runStore: failingStore, runQueue: queue.port, decisions: dec.port, tenant: TENANT,
      notifier: notif.port, executor: realExecutor(dag), clock: () => 1_000, newRunId: () => mkRunId(`run-${++counter}`),
    });

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const res = await service.processRun(store.acquireLease(started.value.runId));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("redis-unavailable");
  });

  it("treats publication uncertainty as accepted and requests the normal wakeup", async () => {
    const store = inMemoryRunStore();
    const uncertainStore: RunStorePort = {
      ...store.port,
      async create(record) {
        const created = await store.port.create(record);
        return created.ok ? ok({ kind: "publication-uncertain" }) : created;
      },
    };
    const delivered: RunId[] = [];
    const service = createHitlRunService({
      runStore: uncertainStore,
      runQueue: { async enqueue(runId) { delivered.push(runId); return ok(undefined); } },
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(oneNodeDag()),
      clock: () => 1_000,
      newRunId: () => mkRunId("uncertain-run"),
    });

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);

    expect(started).toEqual(ok({ runId: "uncertain-run" as RunId }));
    expect(delivered).toEqual(["uncertain-run" as RunId]);
    expect(store.runs.has("uncertain-run" as RunId)).toBe(true);
  });

  it("keeps an accepted run durable when the initial wakeup fails, then reconciliation wakes it", async () => {
    const store = inMemoryRunStore();
    const delivered: RunId[] = [];
    let failEnqueue = true;
    const queue: RunQueuePort = {
      async enqueue(runId) {
        if (failEnqueue) return err({ kind: "redis-unavailable", operation: "initial enqueue" });
        delivered.push(runId);
        return ok(undefined);
      },
    };
    const service = createHitlRunService({
      runStore: store.port,
      runQueue: queue,
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(oneNodeDag()),
      clock: () => 1_000,
      newRunId: () => mkRunId("run-enqueue-failure"),
      logger: THROWING_ERROR_LOGGER,
    });

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    expect(started.ok).toBe(true);
    const durable = store.runs.get("run-enqueue-failure" as RunId)!;
    expect(durable.status.kind).toBe("queued");
    expect(store.active.has(durable.runId)).toBe(true);

    failEnqueue = false;
    const reconciled = await service.reconcileActiveRuns();
    expect(reconciled).toEqual(ok([{ kind: "woken", runId: durable.runId }]));
    expect(delivered).toEqual([durable.runId]);
  });

  it("a fresh service instance reconciles an accepted queued run after restart", async () => {
    const store = inMemoryRunStore();
    const decisions = inMemoryDecisionStore();
    const common = {
      runStore: store.port,
      decisions: decisions.port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(oneNodeDag()),
      clock: () => 1_000,
      newRunId: () => mkRunId("restart-run"),
    };
    const beforeRestart = createHitlRunService({
      ...common,
      runQueue: { async enqueue() { return err({ kind: "redis-unavailable", operation: "queue down" }); } },
    });
    expect((await beforeRestart.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(true);

    const delivered: RunId[] = [];
    const afterRestart = createHitlRunService({
      ...common,
      runQueue: { async enqueue(runId) { delivered.push(runId); return ok(undefined); } },
    });
    expect(await afterRestart.reconcileActiveRuns()).toEqual(ok([
      { kind: "woken", runId: "restart-run" as RunId },
    ]));
    expect(delivered).toEqual(["restart-run" as RunId]);
  });

  it("surfaces active enumeration errors through the typed reconciliation result", async () => {
    const store = inMemoryRunStore();
    const brokenStore: RunStorePort = {
      ...store.port,
      async listActiveRunIds() {
        return err({ kind: "redis-unavailable", operation: "SMEMBERS active" });
      },
    };
    const service = createHitlRunService({
      runStore: brokenStore,
      runQueue: inMemoryRunQueue(store.acquireLease).port,
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(oneNodeDag()),
      clock: () => 1_000,
      newRunId: () => mkRunId("unused"),
    });

    const reconciled = await service.reconcileActiveRuns();
    expect(reconciled.ok).toBe(false);
    if (!reconciled.ok) expect(reconciled.error.kind).toBe("redis-unavailable");
  });

  it("continues reconciliation after a run-specific inspection failure", async () => {
    const store = inMemoryRunStore();
    const corruptRunId = mkRunId("corrupt-run");
    const healthyRunId = mkRunId("healthy-run");
    const inspectionError: HostError = {
      kind: "internal-invariant-violated",
      message: "corrupt checkpoint",
      context: { runId: corruptRunId },
    };
    const inspectingStore: RunStorePort = {
      ...store.port,
      async get(runId) {
        return runId === corruptRunId ? err(inspectionError) : store.port.get(runId);
      },
    };
    const delivered: RunId[] = [];
    const ids = [corruptRunId, healthyRunId];
    const service = createHitlRunService({
      runStore: inspectingStore,
      runQueue: { async enqueue(runId) { delivered.push(runId); return ok(undefined); } },
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(oneNodeDag()),
      clock: () => 1_000,
      newRunId: () => ids.shift()!,
      logger: THROWING_ERROR_LOGGER,
    });
    expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(true);
    expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(true);
    delivered.length = 0;

    const reconciled = await service.reconcileActiveRuns();

    expect(reconciled).toEqual(ok([
      { kind: "inspection-failed", runId: corruptRunId, error: inspectionError },
      { kind: "woken", runId: healthyRunId },
    ]));
    expect(delivered).toEqual([healthyRunId]);
  });

  it("reconciliation skips a suspended run with no durable decision", async () => {
    const dag = twoWaveDag();
    const { service, queue, store } = setup(dag);
    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    await queue.drain();
    expect(store.runs.get(started.value.runId)?.status.kind).toBe("suspended");
    expect(queue.pending).toHaveLength(0);

    expect(await service.reconcileActiveRuns()).toEqual(ok([]));
    expect(queue.pending).toHaveLength(0);
  });

  it("a stored decision whose direct wakeup fails completes after reconciliation", async () => {
    // Resolution succeeds durably while the direct queue wakeup fails. The
    // acceptance remains successful; a later server-owned sweep must discover
    // the non-terminal run and resume it without another human request.
    const dag = twoWaveDag();
    const store = inMemoryRunStore();
    const baseQueue = inMemoryRunQueue(store.acquireLease);
    const dec = inMemoryDecisionStore();
    const notif = recordingNotifier();
    let counter = 0;
    let failEnqueue = false;
    const queuePort: RunQueuePort = {
      async enqueue(runId) {
        if (failEnqueue) return err({ kind: "redis-unavailable", operation: "enqueue" });
        return baseQueue.port.enqueue(runId);
      },
    };
    const service = createHitlRunService({
      runStore: store.port, runQueue: queuePort, decisions: dec.port, tenant: TENANT,
      notifier: notif.port, executor: realExecutor(dag), clock: () => 1_000, newRunId: () => mkRunId(`run-${++counter}`),
      logger: THROWING_ERROR_LOGGER,
    });
    baseQueue.setProcessor(service.processRun);

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");
    const runId = started.value.runId;
    await baseQueue.drain(); // park at the review gate
    expect(store.runs.get(runId)!.status.kind).toBe("suspended");

    failEnqueue = true;
    const res = await service.recordDecision(runId, "review" as NodeId, { kind: "approve" });
    expect(res.ok).toBe(true); // durable acceptance is authoritative
    expect(dec.decisions.has(`${runId}:review`)).toBe(true);
    expect(store.runs.get(runId)?.status.kind).toBe("suspended");

    failEnqueue = false;
    const reconciled = await service.reconcileActiveRuns();
    expect(reconciled.ok).toBe(true);
    await baseQueue.drain();
    expect(store.runs.get(runId)?.status.kind).toBe("completed");
  });

  it("a throwing reconciliation logger cannot replace a typed wakeup-failed attempt", async () => {
    const store = inMemoryRunStore();
    const service = createHitlRunService({
      runStore: store.port,
      runQueue: { async enqueue() { return err({ kind: "redis-unavailable", operation: "enqueue" }); } },
      decisions: inMemoryDecisionStore().port,
      tenant: TENANT,
      notifier: recordingNotifier().port,
      executor: realExecutor(oneNodeDag()),
      clock: () => 1_000,
      newRunId: () => mkRunId("reconcile-logger-run"),
      logger: THROWING_ERROR_LOGGER,
    });
    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    if (!started.ok) throw new Error("startRun failed");

    const result = await service.reconcileActiveRuns();

    expect(result.ok && result.value).toEqual([{
      kind: "wakeup-failed",
      runId: started.value.runId,
      error: { kind: "redis-unavailable", operation: "enqueue" },
    }]);
  });

  it("getRun reflects the lifecycle: queued → suspended → completed", async () => {
    const dag = twoWaveDag();
    const { service, queue } = setup(dag);

    const started = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
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

// ---------------------------------------------------------------------------
// maxQueuedRuns admission gate (ADR-0074)
// ---------------------------------------------------------------------------

describe("HitlRunService — per-tenant maxQueuedRuns gate (ADR-0074)", () => {
  const gateService = (maxQueuedRuns: number | undefined) => {
    const store = inMemoryRunStore();
    const queue = inMemoryRunQueue(store.acquireLease);
    const dec = inMemoryDecisionStore();
    const notif = recordingNotifier();
    let counter = 0;
    const service = createHitlRunService({
      runStore: store.port,
      runQueue: queue.port,
      decisions: dec.port,
      tenant: TENANT,
      ...(maxQueuedRuns !== undefined ? { maxQueuedRuns } : {}),
      notifier: notif.port,
      executor: realExecutor(oneNodeDag()),
      clock: () => 1_000,
      newRunId: () => mkRunId(`run-${++counter}`),
    });
    return { service, store };
  };

  it("refuses startRun with `tenant-over-quota` once the active-run count reaches maxQueuedRuns", async () => {
    const { service } = gateService(2);
    expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(true);
    expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(true);
    // At the ceiling (2 outstanding) — the third is refused, scoped to this tenant.
    const third = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.kind).toBe("tenant-over-quota");
      if (third.error.kind === "tenant-over-quota") {
        expect(third.error.tenant).toBe(TENANT);
        expect(third.error.retryAfterSeconds).toBeGreaterThan(0);
      }
    }
  });

  it("frees a slot when a run settles terminal — a subsequent startRun is admitted again", async () => {
    const { service, store } = gateService(1);
    const first = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    expect(first.ok).toBe(true);
    // At the ceiling of 1 — the next is refused.
    expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(false);
    // Settle the first run terminal → it leaves the active index → a slot frees.
    if (first.ok) {
      const lease = store.acquireLease(first.value.runId);
      await store.port.setStatus(lease, { kind: "running" });
      await store.port.setStatus(lease, { kind: "completed", output: 1 });
    }
    expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(true);
  });

  it("a suspended (parked-at-gate) run still occupies a slot — it is non-terminal", async () => {
    const { service, store } = gateService(1);
    const first = await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN);
    expect(first.ok).toBe(true);
    if (first.ok) {
      const lease = store.acquireLease(first.value.runId);
      await store.port.setStatus(lease, { kind: "running" });
      await store.port.setStatus(lease, { kind: "suspended", nodeId: "g" as NodeId, prompt: nonEmptyString("p") });
    }
    // Still at the ceiling — a parked run is outstanding, so the next is refused.
    expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(false);
  });

  it("UNSET maxQueuedRuns means unlimited — the gate never fires (backwards compatible)", async () => {
    const { service } = gateService(undefined);
    for (let i = 0; i < 5; i++) {
      expect((await service.startRun("test-dag" as DagId, OWNER_TEAM, null, ADMIN)).ok).toBe(true);
    }
  });
});
