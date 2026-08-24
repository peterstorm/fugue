// run-store-job.test.ts — the run-store-backed JobLike (ADR-0060).
//
// The kernel checkpoints {state, context} after every transition through this
// handle. Two load-bearing invariants are pinned here:
//   1. A PERSIST FAILURE is fatal — updateData() throws so the kernel aborts and
//      the host terminalizes the run rather than replaying side effects from the
//      last good checkpoint or silently advancing unpersisted state.
//   2. Parse-don't-validate at deserialization — a corrupt checkpoint (malformed
//      JSON or an invalid envelope shape) is REJECTED as a Result error rather
//      than `as`-cast into a bad `DagPhase` that would later blow up the
//      exhaustive transition with a NonExhaustiveError.

import { describe, it, expect } from "bun:test";
import { ok, err, toJson, fromJson } from "@fuguejs/framework";
import type { RunId, NodeId, DagPhase, DagMachineContextPersisted, Result } from "@fuguejs/framework";
import { createRunLeaseAuthority } from "../ports.js";
import type { RunExecutionJob, RunStorePort } from "../ports.js";
import type { RunRecord } from "../types.js";
import { logWithoutThrowing } from "../diagnostic-logging.js";
import { makeRunStoreJobLike } from "../run-store-job.js";

const RUN = "run-1" as RunId;
const LEASE = createRunLeaseAuthority().issuer.issue(
  RUN,
  "test-owner",
  new AbortController().signal,
);
type Envelope = { state: DagPhase; context: DagMachineContextPersisted };
const GATE = {
  nodeId: "review" as NodeId,
  output: null,
  prompt: "Approve?",
  pendingReviews: [],
  wave: 1,
} as const;
const VALID_CONTEXT: DagMachineContextPersisted = {
  waves: [[GATE.nodeId]],
  edges: [],
  unconditionalAdj: new Map(),
  outputNodeId: GATE.nodeId,
  retries: new Map(),
  retryConfigs: new Map(),
  defaultRetryLimit: undefined,
  retryLimits: undefined,
  humanReviewNodeIds: new Set([GATE.nodeId]),
  humanReviewPrompts: new Map([[GATE.nodeId, GATE.prompt]]),
  activeNodeIds: new Set([GATE.nodeId]),
  confidenceByNode: new Map(),
  outputs: new Map(),
  initialInput: null,
  priorWitnesses: new Map(),
};
const VALID_PHASES: Record<DagPhase["kind"], DagPhase> = {
  pending: { kind: "pending" },
  running: { kind: "running", wave: 0 },
  "awaiting-human": { kind: "awaiting-human", ...GATE },
  suspended: { kind: "suspended", ...GATE },
  retrying: { kind: "retrying", wave: 0, nodeId: GATE.nodeId, attempt: 1, nextDelayMs: 10 },
  "retrying-hook": { kind: "retrying-hook", ...GATE, attempt: 1, nextDelayMs: 10 },
  succeeded: { kind: "succeeded", output: null },
  failed: { kind: "failed", error: { kind: "aborted", reason: "test" } },
};
const envelope = (kind: DagPhase["kind"]): Envelope => ({
  state: { ...VALID_PHASES[kind] } as DagPhase,
  context: VALID_CONTEXT,
});
const initial = toJson(envelope("pending"));

/** Unwrap a successful construction, failing the test loudly otherwise. */
const expectJob = (r: Result<RunExecutionJob, unknown>): RunExecutionJob => {
  if (!r.ok) throw new Error(`expected ok JobLike, got err: ${JSON.stringify(r.error)}`);
  return r.value;
};

/** A run store whose saveCheckpoint outcome is configurable; records the last persisted string. */
const fakeStore = (saveResult: () => ReturnType<RunStorePort["saveCheckpoint"]>) => {
  const saved: string[] = [];
  const port: RunStorePort = {
    async create() { return ok({ kind: "created" }); },
    async get() { return ok(null as RunRecord | null); },
    async getMetadata() { return ok(null); },
    async saveCheckpoint(_lease, checkpoint) { saved.push(checkpoint); return saveResult(); },
    async setStatus() { return ok(undefined); },
    async countActiveRuns() { return ok(0); },
    async listActiveRunIds() { return ok([]); },
  };
  return { port, saved };
};

describe("makeRunStoreJobLike", () => {
  it("exposes the initial checkpoint via the sync data getter", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const { jobLike } = expectJob(makeRunStoreJobLike(port, LEASE, initial));
    expect(jobLike.data).toEqual(fromJson(initial) as Envelope);
  });

  it("persists each updateData (serialized) and reflects it in data", async () => {
    const { port, saved } = fakeStore(() => Promise.resolve(ok(undefined)));
    const { jobLike } = expectJob(makeRunStoreJobLike(port, LEASE, initial));
    const next = envelope("awaiting-human");

    await jobLike.updateData(next);

    expect(saved).toEqual([toJson(next)]);
    expect(jobLike.data).toEqual(next);
  });

  it("returns detached checkpoint snapshots from data", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const { jobLike } = expectJob(makeRunStoreJobLike(port, LEASE, initial));
    const exposed = jobLike.data as { state: { kind: string } };

    exposed.state.kind = "failed";

    expect(jobLike.data.state.kind).toBe("pending");
  });

  it("detaches the live checkpoint from the updateData caller after persistence", async () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const { jobLike } = expectJob(makeRunStoreJobLike(port, LEASE, initial));
    const next = envelope("awaiting-human") as Envelope & { state: { kind: string } };

    await jobLike.updateData(next);
    next.state.kind = "failed";

    expect(jobLike.data.state.kind).toBe("awaiting-human");
  });

  it("THROWS on a persist failure without advancing the local checkpoint", async () => {
    const { port } = fakeStore(() => Promise.resolve(err({ kind: "redis-unavailable", operation: "saveCheckpoint" })));
    const job = expectJob(makeRunStoreJobLike(port, LEASE, initial));
    await expect(job.jobLike.updateData(envelope("awaiting-human"))).rejects.toThrow(/failed to persist checkpoint/);
    expect(job.jobLike.data).toEqual(fromJson(initial) as Envelope);
    expect(job.checkpointFailure()).toEqual({ kind: "redis-unavailable", operation: "saveCheckpoint" });
  });

  it("REJECTS a checkpoint with malformed JSON (parse-don't-validate)", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const result = makeRunStoreJobLike(port, LEASE, "{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal-invariant-violated");
      expect(result.error).toMatchObject({ message: expect.stringContaining("malformed JSON") });
    }
  });

  it("ACCEPTS complete representatives of every DagPhase variant", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    for (const phase of Object.values(VALID_PHASES)) {
      expect(makeRunStoreJobLike(port, LEASE, toJson({ state: phase, context: VALID_CONTEXT })).ok).toBe(true);
    }
  });

  it("REJECTS a checkpoint whose state.kind is not a known DagPhase (corrupt discriminant)", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const corrupt = toJson({ state: { kind: "totally-bogus" }, context: VALID_CONTEXT });
    const result = makeRunStoreJobLike(port, LEASE, corrupt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal-invariant-violated");
      expect(result.error).toMatchObject({ message: expect.stringContaining("invalid envelope shape") });
    }
  });

  it("REJECTS known DagPhase discriminants whose variant-required fields are missing", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const incompleteKinds = [
      "running",
      "awaiting-human",
      "suspended",
      "retrying",
      "retrying-hook",
      "succeeded",
      "failed",
    ] as const satisfies readonly Exclude<DagPhase["kind"], "pending">[];

    for (const kind of incompleteKinds) {
      const result = makeRunStoreJobLike(port, LEASE, toJson({ state: { kind }, context: VALID_CONTEXT }));
      expect(result.ok, `${kind} was accepted without its required payload`).toBe(false);
    }
  });

  it("REJECTS negative or fractional phase indexes, attempts, and delays", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const invalidStates: readonly unknown[] = [
      { kind: "running", wave: -1 },
      { kind: "running", wave: 0.5 },
      { ...VALID_PHASES.suspended, wave: -1 },
      { ...VALID_PHASES.retrying, attempt: 0 },
      { ...VALID_PHASES.retrying, attempt: 1.5 },
      { ...VALID_PHASES.retrying, nextDelayMs: -1 },
      { ...VALID_PHASES["retrying-hook"], nextDelayMs: 0.5 },
    ];

    for (const state of invalidStates) {
      const result = makeRunStoreJobLike(port, LEASE, toJson({ state, context: VALID_CONTEXT }));
      expect(result.ok, `invalid numeric phase payload was accepted: ${JSON.stringify(state)}`).toBe(false);
    }
  });

  it("REJECTS gate phases carrying an invalid branded node id", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const result = makeRunStoreJobLike(port, LEASE, toJson({
      state: { ...VALID_PHASES.suspended, nodeId: "not a node id" },
      context: VALID_CONTEXT,
    }));
    expect(result.ok).toBe(false);
  });

  it("REJECTS a context missing any required persisted field", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    for (const field of Object.keys(VALID_CONTEXT)) {
      const context: Record<string, unknown> = { ...VALID_CONTEXT };
      delete context[field];
      const result = makeRunStoreJobLike(port, LEASE, toJson({
        state: { kind: "pending" },
        context,
      }));
      expect(result.ok, `context without '${field}' was accepted`).toBe(false);
    }
  });

  it("REJECTS wrong container shapes inside persisted context", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const corruptions: ReadonlyArray<readonly [keyof DagMachineContextPersisted, unknown]> = [
      ["waves", {}],
      ["outputs", {}],
      ["retries", []],
      ["retryConfigs", {}],
      ["activeNodeIds", []],
      ["humanReviewNodeIds", []],
      ["humanReviewPrompts", {}],
      ["unconditionalAdj", {}],
      ["confidenceByNode", {}],
      ["priorWitnesses", {}],
    ];
    for (const [field, value] of corruptions) {
      const result = makeRunStoreJobLike(port, LEASE, toJson({
        state: { kind: "pending" },
        context: { ...VALID_CONTEXT, [field]: value },
      }));
      expect(result.ok, `context with corrupt '${field}' was accepted`).toBe(false);
    }
  });

  it("REJECTS a checkpoint missing the state/context envelope shape", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const result = makeRunStoreJobLike(port, LEASE, toJson({ state: { kind: "pending" } }));
    expect(result.ok).toBe(false);
  });
});

describe("logWithoutThrowing", () => {
  it("uses an independent fallback when the configured logger throws", () => {
    const diagnostics: string[] = [];

    logWithoutThrowing(
      { info() {}, warn() {}, error() { throw new Error("logger transport failed"); } },
      "error",
      "checkpoint failed",
      { runId: RUN },
      (diagnostic) => diagnostics.push(diagnostic),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("[hitl diagnostic fallback] error checkpoint failed");
    expect(diagnostics[0]).toContain("runId=run-1");
    expect(diagnostics[0]).toContain("loggerError=logger transport failed");
  });

  it("never replaces the modeled outcome when the fallback also throws", () => {
    expect(() => logWithoutThrowing(
      { info() {}, warn() { throw new Error("logger failed"); }, error() {} },
      "warn",
      "cleanup failed",
      {},
      () => { throw new Error("stderr failed"); },
    )).not.toThrow();
  });
});
