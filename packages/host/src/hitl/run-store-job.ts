/**
 * Run-store-backed `JobLike` (ADR-0060). The framework's resumable kernel
 * checkpoints `{state, context}` after every transition through this handle; we
 * back it with the durable `RunStorePort` rather than a queue backend's job
 * data, so a run survives queue retention and resumes from the store.
 *
 * The kernel reads `data` synchronously and writes via async `updateData`. We
 * deserialize the checkpoint once at construction and keep it local, so the
 * sync `data` getter avoids Redis I/O while returning a validated detached
 * snapshot; each `updateData` re-serializes and persists. A
 * persist failure aborts the kernel through JobLike's required throwing shell,
 * while a side channel retains the typed `HostError` so the host executor can
 * terminalize the run with an actionable diagnostic. It must not retry from the
 * prior checkpoint because execution may already have produced side effects.
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

import {
  PersistedFrameworkErrorSchema,
  isDagPhaseKind,
  toJson,
  tryFromJson,
  tryNodeId,
} from "@fuguejs/framework";
import { parsePersistedDagContext } from "@fuguejs/framework/advanced";
import type {
  DagMachineContextPersisted,
  DagPhase,
  HumanGatePayload,
  JobLike,
  NodeId,
} from "@fuguejs/framework";
import type { Result } from "@fuguejs/framework";
import { ok, err } from "@fuguejs/framework";
import type { HostError } from "../domain/host-error.js";
import { internalInvariantViolated } from "../domain/host-error.js";
import type { RunExecutionJob, RunLease, RunStorePort } from "./ports.js";

type Envelope = { state: DagPhase; context: DagMachineContextPersisted };
type DagPhaseParserMap = {
  readonly [Kind in DagPhase["kind"]]: (
    state: Readonly<Record<string, unknown>>,
  ) => Extract<DagPhase, { readonly kind: Kind }> | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const positiveInteger = (value: unknown): value is number =>
  nonNegativeInteger(value) && value > 0;

const parseNodeId = (value: unknown): NodeId | null => {
  if (typeof value !== "string") return null;
  const parsed = tryNodeId(value);
  return parsed.ok ? parsed.value : null;
};

const parseHumanGatePayload = (
  state: Readonly<Record<string, unknown>>,
): HumanGatePayload | null => {
  const nodeId = parseNodeId(state.nodeId);
  if (
    nodeId === null ||
    !hasOwn(state, "output") ||
    typeof state.prompt !== "string" ||
    !Array.isArray(state.pendingReviews) ||
    !nonNegativeInteger(state.wave)
  ) {
    return null;
  }
  const pendingReviews: NodeId[] = [];
  for (const rawNodeId of state.pendingReviews) {
    const parsed = parseNodeId(rawNodeId);
    if (parsed === null) return null;
    pendingReviews.push(parsed);
  }
  return {
    nodeId,
    output: state.output,
    prompt: state.prompt,
    pendingReviews,
    wave: state.wave,
  };
};

/**
 * Complete wire parsers for every `DagPhase` variant. The record key domain is
 * compiler-checked against `DagPhase["kind"]`, so adding a phase without its
 * required-field parser fails typecheck instead of weakening checkpoint reads.
 */
const DAG_PHASE_PARSERS = {
  pending: () => ({ kind: "pending" }),
  running: (state) =>
    nonNegativeInteger(state.wave) ? { kind: "running", wave: state.wave } : null,
  "awaiting-human": (state) => {
    const payload = parseHumanGatePayload(state);
    return payload === null ? null : { kind: "awaiting-human", ...payload };
  },
  suspended: (state) => {
    const payload = parseHumanGatePayload(state);
    return payload === null ? null : { kind: "suspended", ...payload };
  },
  retrying: (state) => {
    const nodeId = parseNodeId(state.nodeId);
    return nodeId !== null &&
      nonNegativeInteger(state.wave) &&
      positiveInteger(state.attempt) &&
      nonNegativeInteger(state.nextDelayMs)
      ? {
          kind: "retrying",
          wave: state.wave,
          nodeId,
          attempt: state.attempt,
          nextDelayMs: state.nextDelayMs,
        }
      : null;
  },
  "retrying-hook": (state) => {
    const payload = parseHumanGatePayload(state);
    return payload !== null && positiveInteger(state.attempt) && nonNegativeInteger(state.nextDelayMs)
      ? {
          kind: "retrying-hook",
          ...payload,
          attempt: state.attempt,
          nextDelayMs: state.nextDelayMs,
        }
      : null;
  },
  succeeded: (state) =>
    hasOwn(state, "output") ? { kind: "succeeded", output: state.output } : null,
  failed: (state) => {
    const error = PersistedFrameworkErrorSchema.safeParse(state.error);
    return error.success ? { kind: "failed", error: error.data } : null;
  },
} satisfies DagPhaseParserMap;

const parseDagPhase = (value: unknown): DagPhase | null => {
  if (!isRecord(value) || !isDagPhaseKind(value.kind)) return null;
  return DAG_PHASE_PARSERS[value.kind](value);
};

/** Parse a deserialized checkpoint into the trusted execution envelope. */
const parseEnvelope = (value: unknown): Envelope | null => {
  if (!isRecord(value)) return null;
  const state = parseDagPhase(value.state);
  if (state === null) return null;
  const context = parsePersistedDagContext(value.context);
  return context.ok ? { state, context: context.value } : null;
};

const envelopeSnapshot = (serialized: string): Envelope => {
  const parsed = tryFromJson(serialized);
  const envelope = parsed.ok ? parseEnvelope(parsed.value) : null;
  if (envelope === null) {
    throw new Error("makeRunStoreJobLike: framework-authored checkpoint failed its own envelope parser");
  }
  return envelope;
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
  const initialEnvelope = parseEnvelope(parsed.value);
  if (initialEnvelope === null) {
    return err(internalInvariantViolated(
      `corrupt checkpoint for run '${runId}' (invalid envelope shape)`,
      { runId },
    ));
  }

  let envelope = initialEnvelope;
  let failure: HostError | null = null;

  const jobLike: JobLike<DagPhase, unknown, DagMachineContextPersisted> = {
    get data(): { state: DagPhase; context: DagMachineContextPersisted } {
      return envelopeSnapshot(toJson(envelope));
    },
    async updateData(d: { state: DagPhase; context: DagMachineContextPersisted }): Promise<void> {
      const serialized = toJson(d);
      const nextEnvelope = envelopeSnapshot(serialized);
      const persisted = await runStore.saveCheckpoint(lease, serialized);
      if (!persisted.ok) {
        failure = persisted.error;
        // JobLike has no Result channel. Throw only to abort the kernel; the
        // executor reads `checkpointFailure` and restores the typed host error.
        throw new Error(
          `makeRunStoreJobLike: failed to persist checkpoint for run '${runId}': ${persisted.error.kind}`,
          { cause: persisted.error },
        );
      }
      envelope = nextEnvelope;
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
