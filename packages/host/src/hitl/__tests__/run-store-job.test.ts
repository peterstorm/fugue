// run-store-job.test.ts — the run-store-backed JobLike (ADR-0060).
//
// The kernel checkpoints {state, context} after every transition through this
// handle. Two load-bearing invariants are pinned here:
//   1. A PERSIST FAILURE is fatal — updateData() throws so the kernel surfaces a
//      run failure and the queue retries from the last good checkpoint, rather
//      than silently advancing on an unpersisted state.
//   2. Parse-don't-validate at deserialization — a corrupt checkpoint (malformed
//      JSON or an invalid envelope shape) is REJECTED as a Result error rather
//      than `as`-cast into a bad `DagPhase` that would later blow up the
//      exhaustive transition with a NonExhaustiveError.

import { describe, it, expect } from "bun:test";
import { ok, err, toJson, fromJson } from "@fuguejs/framework";
import type { RunId, DagPhase, DagMachineContextPersisted, Result } from "@fuguejs/framework";
import { issueRunLease } from "../ports.js";
import type { RunExecutionJob, RunStorePort } from "../ports.js";
import type { RunRecord, RunStatus } from "../types.js";
import { makeRunStoreJobLike } from "../run-store-job.js";

const RUN = "run-1" as RunId;
const LEASE = issueRunLease(RUN, "test-owner", new AbortController().signal);
type Envelope = { state: DagPhase; context: DagMachineContextPersisted };
const envelope = (kind: string): Envelope => ({ state: { kind } as unknown as DagPhase, context: {} as DagMachineContextPersisted });
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
    async create() { return ok(undefined); },
    async get() { return ok(null as RunRecord | null); },
    async saveCheckpoint(_lease, checkpoint) { saved.push(checkpoint); return saveResult(); },
    async setStatus(_lease, _status: RunStatus) { return ok(undefined); },
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

  it("REJECTS a checkpoint whose state.kind is not a known DagPhase (corrupt discriminant)", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const corrupt = toJson({ state: { kind: "totally-bogus" }, context: {} });
    const result = makeRunStoreJobLike(port, LEASE, corrupt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal-invariant-violated");
      expect(result.error).toMatchObject({ message: expect.stringContaining("invalid envelope shape") });
    }
  });

  it("REJECTS a checkpoint missing the state/context envelope shape", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const result = makeRunStoreJobLike(port, LEASE, toJson({ state: { kind: "pending" } }));
    expect(result.ok).toBe(false);
  });
});
