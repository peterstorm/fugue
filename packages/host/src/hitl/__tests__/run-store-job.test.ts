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
import type { RunId, DagPhase, DagMachineContextPersisted, Result, JobLike } from "@fuguejs/framework";
import type { RunStorePort } from "../ports.js";
import type { RunRecord, RunStatus } from "../types.js";
import { makeRunStoreJobLike } from "../run-store-job.js";

const RUN = "run-1" as RunId;
type Envelope = { state: DagPhase; context: DagMachineContextPersisted };
const envelope = (kind: string): Envelope => ({ state: { kind } as unknown as DagPhase, context: {} as DagMachineContextPersisted });
const initial = toJson(envelope("pending"));

/** Unwrap a successful construction, failing the test loudly otherwise. */
const expectJob = (r: Result<JobLike<DagPhase, unknown, DagMachineContextPersisted>, unknown>): JobLike<DagPhase, unknown, DagMachineContextPersisted> => {
  if (!r.ok) throw new Error(`expected ok JobLike, got err: ${JSON.stringify(r.error)}`);
  return r.value;
};

/** A run store whose saveCheckpoint outcome is configurable; records the last persisted string. */
const fakeStore = (saveResult: () => ReturnType<RunStorePort["saveCheckpoint"]>) => {
  const saved: string[] = [];
  const port: RunStorePort = {
    async create() { return ok(undefined); },
    async get() { return ok(null as RunRecord | null); },
    async saveCheckpoint(_runId, checkpoint) { saved.push(checkpoint); return saveResult(); },
    async setStatus(_runId, _status: RunStatus) { return ok(undefined); },
  };
  return { port, saved };
};

describe("makeRunStoreJobLike", () => {
  it("exposes the initial checkpoint via the sync data getter", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const job = expectJob(makeRunStoreJobLike(port, RUN, initial));
    expect(job.data).toEqual(fromJson(initial) as Envelope);
  });

  it("persists each updateData (serialized) and reflects it in data", async () => {
    const { port, saved } = fakeStore(() => Promise.resolve(ok(undefined)));
    const job = expectJob(makeRunStoreJobLike(port, RUN, initial));
    const next = envelope("awaiting-human");

    await job.updateData(next);

    expect(saved).toEqual([toJson(next)]);
    expect(job.data).toEqual(next);
  });

  it("THROWS on a persist failure (kernel must not advance on an unpersisted checkpoint)", async () => {
    const { port } = fakeStore(() => Promise.resolve(err({ kind: "redis-unavailable", operation: "saveCheckpoint" })));
    const job = expectJob(makeRunStoreJobLike(port, RUN, initial));
    await expect(job.updateData(envelope("awaiting-human"))).rejects.toThrow(/failed to persist checkpoint/);
  });

  it("REJECTS a checkpoint with malformed JSON (parse-don't-validate)", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const result = makeRunStoreJobLike(port, RUN, "{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal-invariant-violated");
      expect(result.error).toMatchObject({ message: expect.stringContaining("malformed JSON") });
    }
  });

  it("REJECTS a checkpoint whose state.kind is not a known DagPhase (corrupt discriminant)", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    // Structurally an envelope, but `state.kind` is not a real phase — exactly
    // the value that would otherwise throw NonExhaustiveError inside dagTransition.
    const corrupt = toJson({ state: { kind: "totally-bogus" }, context: {} });
    const result = makeRunStoreJobLike(port, RUN, corrupt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal-invariant-violated");
      expect(result.error).toMatchObject({ message: expect.stringContaining("invalid envelope shape") });
    }
  });

  it("REJECTS a checkpoint missing the state/context envelope shape", () => {
    const { port } = fakeStore(() => Promise.resolve(ok(undefined)));
    const result = makeRunStoreJobLike(port, RUN, toJson({ state: { kind: "pending" } })); // no context
    expect(result.ok).toBe(false);
  });
});
