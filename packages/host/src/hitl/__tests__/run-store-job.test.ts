// run-store-job.test.ts — the run-store-backed JobLike (ADR-0060).
//
// The kernel checkpoints {state, context} after every transition through this
// handle. Its load-bearing durability invariant: a PERSIST FAILURE is fatal —
// updateData() throws so the kernel surfaces a run failure and the queue retries
// from the last good checkpoint, rather than silently advancing on an
// unpersisted state. This pins that contract.

import { describe, it, expect } from "bun:test";
import { ok, err, toJson, fromJson } from "@fuguejs/framework";
import type { RunId, DagPhase, DagMachineContextPersisted } from "@fuguejs/framework";
import type { RunStorePort } from "../ports.js";
import type { RunRecord, RunStatus } from "../types.js";
import { makeRunStoreJobLike } from "../run-store-job.js";

const RUN = "run-1" as RunId;
type Envelope = { state: DagPhase; context: DagMachineContextPersisted };
const envelope = (kind: string): Envelope => ({ state: { kind } as unknown as DagPhase, context: {} as DagMachineContextPersisted });
const initial = toJson(envelope("pending"));

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
    const job = makeRunStoreJobLike(port, RUN, initial);
    expect(job.data).toEqual(fromJson(initial) as Envelope);
  });

  it("persists each updateData (serialized) and reflects it in data", async () => {
    const { port, saved } = fakeStore(() => Promise.resolve(ok(undefined)));
    const job = makeRunStoreJobLike(port, RUN, initial);
    const next = envelope("awaiting-human");

    await job.updateData(next);

    expect(saved).toEqual([toJson(next)]);
    expect(job.data).toEqual(next);
  });

  it("THROWS on a persist failure (kernel must not advance on an unpersisted checkpoint)", async () => {
    const { port } = fakeStore(() => Promise.resolve(err({ kind: "redis-unavailable", operation: "saveCheckpoint" })));
    const job = makeRunStoreJobLike(port, RUN, initial);
    await expect(job.updateData(envelope("awaiting-human"))).rejects.toThrow(/failed to persist checkpoint/);
  });
});
