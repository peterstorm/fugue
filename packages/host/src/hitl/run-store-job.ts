/**
 * Run-store-backed `JobLike` (ADR-0060). The framework's resumable kernel
 * checkpoints `{state, context}` after every transition through this handle; we
 * back it with the durable `RunStorePort` rather than a queue backend's job
 * data, so a run survives queue retention and resumes from the store.
 *
 * The kernel reads `data` synchronously and writes via async `updateData`. We
 * deserialize the checkpoint once at construction and keep it in a local, so the
 * sync `data` getter is cheap; each `updateData` re-serializes and persists. A
 * persist failure is fatal to the run (it throws) — the kernel surfaces it as a
 * run failure and the queue can retry from the last good checkpoint, which is
 * strictly safer than silently advancing on an unpersisted state.
 *
 * `wrapDagJobLike` (applied inside the kernel) strips closures before calling
 * our `updateData` and re-injects the live DAG on read, so the context we
 * serialize is plain data — `toJson`/`fromJson` round-trip its Maps/Sets.
 */

import { toJson, fromJson } from "@fuguejs/framework";
import type { JobLike, DagPhase, DagMachineContextPersisted, RunId } from "@fuguejs/framework";
import type { RunStorePort } from "./ports.js";

type Envelope = { state: DagPhase; context: DagMachineContextPersisted };

/**
 * Build a `JobLike` over the run store for `runId`, seeded from the run's
 * serialized checkpoint. The returned handle persists each checkpoint back to
 * the store; `updateProgress`/`appendEvent` are intentional no-ops here (run
 * progress is derived from `RunStatus`, and the durable event journal is a
 * production-adapter concern, not required for suspend/resume correctness).
 */
export const makeRunStoreJobLike = (
  runStore: RunStorePort,
  runId: RunId,
  initialCheckpoint: string,
): JobLike<DagPhase, unknown, DagMachineContextPersisted> => {
  let envelope = fromJson(initialCheckpoint) as Envelope;

  return {
    get data(): { state: DagPhase; context: DagMachineContextPersisted } {
      return envelope;
    },
    async updateData(d: { state: DagPhase; context: DagMachineContextPersisted }): Promise<void> {
      envelope = d;
      const persisted = await runStore.saveCheckpoint(runId, toJson(d));
      if (!persisted.ok) {
        // Fatal: the kernel must not advance on a checkpoint we failed to
        // persist. Throwing surfaces as a run failure (handleKernelError) and
        // the queue retries from the last durably-persisted state.
        throw new Error(
          `makeRunStoreJobLike: failed to persist checkpoint for run '${runId}': ${persisted.error.kind}`,
        );
      }
    },
    async updateProgress(): Promise<void> {
      // No-op: run progress is surfaced via RunStatus, not a 0–100 percent.
    },
    async appendEvent(): Promise<void> {
      // No-op: the durable per-run event journal (Redis Streams) is wired by the
      // production adapter; it is not required for suspend/resume correctness.
    },
  };
};
