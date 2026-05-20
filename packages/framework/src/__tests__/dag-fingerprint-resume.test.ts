// Wave 4.6 — DAG topology fingerprint check on resume.
//
// When a worker enqueues a run against DAG v1 then a redeploy swaps in DAG v2
// (different edges or output node), `wrapDagJobLike.verifyDagFingerprint`
// surfaces the mismatch as `checkpoint-version-mismatch` rather than letting
// stale cached outputs replay against a topology they were not computed under.

import { NoopObserver } from "../observer/observer.js";
import type { RunId, NodeId, DagId } from "../types/ids.js";
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { runDagStateful } from "../dag-runtime/run-dag-stateful.js";
import { createInMemoryJob } from "../queue/in-memory-job.js";
import { compileDagToMachine } from "../dag-runtime/machine.js";
import { wrapDagJobLike } from "../dag-runtime/persistence.js";
import { defineDag } from "../executor/define-dag.js";
import type { DagDef } from "../types/dag.js";
import type { NodeDef, NodeContext } from "../types/node.js";
import type { DagPhase, DagMachineContext } from "../dag-runtime/types.js";
import { ok } from "../types/result.js";
import { N, R, D, nodeMap, nodeSet } from "./_id-helpers.js";

const ctx: NodeContext = {
  runId: "resume-test" as RunId,
  dagId: "fp-test" as DagId,
  observer: new NoopObserver(),
  tracer: { withSpan: <T,>(_n: string, _t: string, fn: () => Promise<T>) => fn() },
  judgeLlm: null,
  cache: null,
  prompts: null,
  llm: null,
  logger: { warn: () => {}, error: () => {} },
};

const transform = (id: string): NodeDef<unknown, unknown> => ({
  id: id as unknown as NodeId,
  kind: "transform",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  requires: [],
  sideEffects: { kind: "none" },
  confidence: { mode: "none" },
  async run(input) {
    return ok(input);
  },
});

const dagV1 = (): DagDef =>
  defineDag({
    id: "fp-test",
    nodes: { A: transform("A"), B: transform("B") },
    edges: [{ from: "A", to: "B" }],
    outputNodeId: "B",
  });

const dagV2 = (): DagDef =>
  defineDag({
    id: "fp-test",
    nodes: { A: transform("A"), B: transform("B"), C: transform("C") },
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ],
    outputNodeId: "C",
  });

describe("§4.6 — DAG fingerprint mismatch on resume", () => {
  it("resuming a v1 checkpoint with v2 returns checkpoint-version-mismatch", async () => {
    // 1. First run: write a checkpoint against DAG v1.
    const v1 = dagV1();
    const compiled = compileDagToMachine(v1, "seed");
    if (!compiled.ok) throw new Error("compile v1 failed");

    const innerJob = createInMemoryJob<DagPhase, DagMachineContext>({
      state: compiled.value.initialState,
      context: compiled.value.initialContext,
    });

    // Drive the run against v1 to populate the persisted snapshot
    // (and stamp the v1 fingerprint into the context).
    const firstRun = await runDagStateful(v1, "seed", ctx, { jobLike: innerJob });
    expect(firstRun.ok).toBe(true);

    // 2. Redeploy: try to resume the same persisted job under DAG v2.
    const v2 = dagV2();
    const resume = await runDagStateful(v2, "seed", ctx, { jobLike: innerJob });
    expect(resume.ok).toBe(false);
    if (!resume.ok) {
      expect(resume.error.kind).toBe("checkpoint-version-mismatch");
      if (resume.error.kind === "checkpoint-version-mismatch") {
        expect(resume.error.expected).not.toBe(resume.error.actual);
        expect(resume.error.runId).toBe("resume-test" as RunId);
      }
    }
  });

  it("legacy snapshot without __dagFingerprint passes (no mismatch)", () => {
    const v1 = dagV1();
    const compiled = compileDagToMachine(v1, "seed");
    if (!compiled.ok) throw new Error("compile v1 failed");

    const innerJob = createInMemoryJob<DagPhase, DagMachineContext>({
      state: compiled.value.initialState,
      context: compiled.value.initialContext,
    });

    const wrapped = wrapDagJobLike(innerJob, v1, "legacy-run" as RunId);
    const check = wrapped.verifyDagFingerprint();
    expect(check.ok).toBe(true);
  });

  it("first wrap-and-write stamps a fingerprint that subsequent verify accepts", async () => {
    const v1 = dagV1();
    const compiled = compileDagToMachine(v1, "seed");
    if (!compiled.ok) throw new Error("compile v1 failed");

    const innerJob = createInMemoryJob<DagPhase, DagMachineContext>({
      state: compiled.value.initialState,
      context: compiled.value.initialContext,
    });

    const wrappedV1 = wrapDagJobLike(innerJob, v1, "rt-run" as RunId);
    await wrappedV1.job.updateData(wrappedV1.job.data);

    // Re-wrap (simulating a reopen on the same DAG) and verify — must accept.
    const wrappedV1Again = wrapDagJobLike(innerJob, v1, "rt-run" as RunId);
    expect(wrappedV1Again.verifyDagFingerprint().ok).toBe(true);

    // Wrap with v2 — must reject.
    const v2 = dagV2();
    const wrappedV2 = wrapDagJobLike(innerJob, v2, "rt-run" as RunId);
    const v2Check = wrappedV2.verifyDagFingerprint();
    expect(v2Check.ok).toBe(false);
    if (!v2Check.ok && v2Check.error.kind === "checkpoint-version-mismatch") {
      expect(v2Check.error.actual).toBeDefined();
    }
  });
});
