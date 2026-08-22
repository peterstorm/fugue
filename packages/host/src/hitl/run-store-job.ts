/**
 * Run-store-backed `JobLike` (ADR-0060). The framework's resumable kernel
 * checkpoints `{state, context}` after every transition through this handle; we
 * back it with the durable `RunStorePort` rather than a queue backend's job
 * data, so a run survives queue retention and resumes from the store.
 *
 * The kernel reads `data` synchronously and writes via async `updateData`. We
 * deserialize the checkpoint once at construction and keep it in a local, so the
 * sync `data` getter is cheap; each `updateData` re-serializes and persists. A
 * persist failure aborts the kernel through JobLike's required throwing shell,
 * while a side channel retains the typed `HostError` so the host executor can
 * return it to the queue for retry from the last good checkpoint. It is never
 * collapsed into a terminal DAG failure.
 *
 * Parse-don't-validate at the deserialization boundary: the checkpoint is the
 * highest-stakes value read back from Redis (its `state.kind` seeds the
 * exhaustive `dagTransition` match), so it is shape-validated like every other
 * persisted ADT (`RunMeta`, `HumanAction`, `ConversationReference`) rather than
 * `as`-cast. A torn/evicted/hand-edited checkpoint is rejected as
 * `internal-invariant-violated` instead of feeding a bad discriminant into the
 * transition (which would throw a raw `NonExhaustiveError`). Construction is
 * therefore fallible and returns a `Result`.
 *
 * `wrapDagJobLike` (applied inside the kernel) strips closures before calling
 * our `updateData` and re-injects the live DAG on read, so the context we
 * serialize is plain data — `toJson`/`fromJson` round-trip its Maps/Sets.
 */

import { toJson, tryFromJson, isDagPhaseKind } from "@fuguejs/framework";
import type { JobLike, DagPhase, DagMachineContextPersisted } from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import { internalInvariantViolated } from "../domain/host-error.js";
import type { RunExecutionJob, RunLease, RunStorePort } from "./ports.js";

type Envelope = { state: DagPhase; context: DagMachineContextPersisted };

/**
 * Validate a deserialized checkpoint has the `{state, context}` envelope shape,
 * with `state` carrying a known `DagPhase` discriminant and `context` an object.
 * This is the parse step that keeps a corrupt `state.kind` out of the exhaustive
 * transition; it intentionally does not deep-validate every context field (that
 * data is framework-authored), only the discriminant that drives control flow.
 */
const isEnvelope = (v: unknown): v is Envelope => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const state = o.state;
  if (typeof state !== "object" || state === null) return false;
  if (typeof o.context !== "object" || o.context === null) return false;
  return isDagPhaseKind((state as Record<string, unknown>).kind);
};

/**
 * Build a `JobLike` over the run store for `lease.runId`, seeded from the run's
 * serialized checkpoint. The returned handle persists each checkpoint back to
 * the store; `updateProgress`/`appendEvent` are intentional no-ops here (run
 * progress is derived from `RunStatus`; HITL runs carry only the latest
 * `{state, context}` checkpoint, with no per-transition event journal — see
 * ADR-0060 Consequences).
 *
 * Returns `err(internal-invariant-violated)` if the stored checkpoint is corrupt
 * (malformed JSON or an invalid envelope shape) rather than `as`-casting it in.
 */
export const makeRunStoreJobLike = (
  runStore: RunStorePort,
  lease: RunLease,
  initialCheckpoint: string,
): Result<RunExecutionJob, HostError> => {
  const runId = lease.runId;
  const parsed = tryFromJson(initialCheckpoint);
  if (!parsed.ok) {
    return err(internalInvariantViolated(
      `corrupt checkpoint for run '${runId}' (malformed JSON)`,
      { runId, error: parsed.error.message },
    ));
  }
  if (!isEnvelope(parsed.value)) {
    return err(internalInvariantViolated(
      `corrupt checkpoint for run '${runId}' (invalid envelope shape)`,
      { runId },
    ));
  }

  let envelope: Envelope = parsed.value;
  let failure: HostError | null = null;

  const jobLike: JobLike<DagPhase, unknown, DagMachineContextPersisted> = {
    get data(): { state: DagPhase; context: DagMachineContextPersisted } {
      return envelope;
    },
    async updateData(d: { state: DagPhase; context: DagMachineContextPersisted }): Promise<void> {
      const persisted = await runStore.saveCheckpoint(lease, toJson(d));
      if (!persisted.ok) {
        failure = persisted.error;
        // JobLike has no Result channel. Throw only to abort the kernel; the
        // executor reads `checkpointFailure` and restores the typed host error.
        throw new Error(
          `makeRunStoreJobLike: failed to persist checkpoint for run '${runId}': ${persisted.error.kind}`,
          { cause: persisted.error },
        );
      }
      envelope = d;
    },
    async updateProgress(): Promise<void> {
      // No-op: run progress is surfaced via RunStatus, not a 0–100 percent.
    },
    async appendEvent(): Promise<void> {
      // No-op: HITL runs carry only the latest {state, context} checkpoint, not
      // a per-transition event journal. A durable journal (e.g. Redis Streams)
      // is a tracked follow-up (ADR-0060 Consequences); it is not required for
      // suspend/resume correctness.
    },
  };

  return ok({ jobLike, checkpointFailure: () => failure });
};
