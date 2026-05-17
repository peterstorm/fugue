// JobLike persistence adapter for DagMachineContext.
//
// `DagMachineContext` extends `DagMachineContextPersisted` with four
// closure/derived fields that cannot survive JSON serialization:
//   - `dag`: contains `run` closures and Zod schemas
//   - `incomingByNode`: derived from `dag.edges`
//   - `outgoingByNode`: contains Predicate functions on conditional edges
//   - `nodeById`: contains `run` closures and Zod schemas
//
// `wrapDagJobLike` accepts the inner `JobLike` typed against the persisted
// shape and returns a wrapped `JobLike` typed against the full runtime shape.
// On `updateData`, closure fields are stripped (type-safe via `DagMachineContextPersisted`).
// On `get data()`, they are re-injected from the live DAG.
//
// On top of the strip/re-inject behaviour, the wrapper stamps the live DAG's
// `dagFingerprint` onto the persisted context. On resume, the wrapper's
// `verifyDagFingerprint()` compares the persisted fingerprint against the
// live one and returns `checkpoint-version-mismatch` when they diverge — a
// redeploy that rewired edges or renamed nodes is no longer undefined
// behaviour (pass-4 plan §4.6).

import type { JobLike } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext, DagMachineContextPersisted } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { dagFingerprint } from "../checkpoint/fingerprint.js";
import { computeIncomingByNode, computeOutgoingByNode } from "./conditional.js";

/**
 * The persisted shape plus an optional fingerprint stamp. This is the type
 * that actually lives in the durable backend (BullMQ job data, Redis, etc.).
 *
 * `__dagFingerprint` is stamped by `wrapDagJobLike.updateData` and compared
 * on resume by `verifyDagFingerprint`. Absent on first-write snapshots —
 * treated as "no prior fingerprint" rather than a mismatch.
 */
export type PersistedDagContext = DagMachineContextPersisted & {
  readonly __dagFingerprint?: string;
};

/**
 * Wrapped `JobLike` plus an out-of-band fingerprint verifier. The verifier
 * is invoked once at run start (before `runStateMachine` reads `job.data`)
 * so a topology-drift mismatch is surfaced as a structured error rather than
 * propagated to the runner as a corrupt context.
 */
export interface WrappedDagJobLike {
  readonly job: JobLike<DagPhase, unknown, DagMachineContext>;
  verifyDagFingerprint(): Result<void, FrameworkError>;
}

/**
 * Extract the plain-data fields from a full `DagMachineContext`. The return
 * type is `DagMachineContextPersisted` — no cast required because the
 * interface relationship is structural (DagMachineContext extends it).
 */
export const stripNonPersistable = (
  ctx: DagMachineContext,
): DagMachineContextPersisted => ({
  waves: ctx.waves,
  outputs: ctx.outputs,
  retries: ctx.retries,
  initialInput: ctx.initialInput,
  activeNodeIds: ctx.activeNodeIds,
  retryConfigs: ctx.retryConfigs,
});

/**
 * Wrap a caller-supplied `JobLike` (typed against the persisted shape) so the
 * runner sees a fully-formed `DagMachineContext`. The wrapper:
 *
 *   - `get data()`: re-injects `dag`, `incomingByNode`, `outgoingByNode`,
 *     `nodeById` from the live DAG onto the persisted fields.
 *   - `updateData()`: strips closure fields and stamps `__dagFingerprint`.
 *
 * The inner `JobLike` is typed `DagMachineContextPersisted` — the actual
 * shape that survives serialization. No double-casts.
 */
export const wrapDagJobLike = (
  inner: JobLike<DagPhase, unknown, DagMachineContextPersisted>,
  dag: DagDef,
  runId: RunId,
): WrappedDagJobLike => {
  const incomingByNode = computeIncomingByNode(dag);
  const outgoingByNode = computeOutgoingByNode(dag);
  const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));
  const expectedFingerprint = dagFingerprint(dag);

  // Cached result of `get data()` — invalidated on `updateData`.
  let cachedData: { state: DagPhase; context: DagMachineContext } | null = null;

  const job: JobLike<DagPhase, unknown, DagMachineContext> = {
    get data(): { state: DagPhase; context: DagMachineContext } {
      if (cachedData !== null) return cachedData;
      const raw = inner.data;
      // Re-inject the live DAG-derived fields. The persisted raw.context
      // is `DagMachineContextPersisted` — missing closures; live values win.
      cachedData = {
        state: raw.state,
        context: {
          ...raw.context,
          dag,
          incomingByNode,
          outgoingByNode,
          nodeById,
        },
      };
      return cachedData;
    },
    async updateData(d: { state: DagPhase; context: DagMachineContext }): Promise<void> {
      cachedData = null; // invalidate cache
      const persistable: PersistedDagContext = {
        ...stripNonPersistable(d.context),
        __dagFingerprint: expectedFingerprint,
      };
      await inner.updateData({
        state: d.state,
        context: persistable,
      });
    },
    updateProgress: (pct: number) => inner.updateProgress(pct),
    appendEvent: (event: DagEvent, dedupKey?: string) =>
      inner.appendEvent(event, dedupKey),
  };

  return {
    job,
    verifyDagFingerprint(): Result<void, FrameworkError> {
      const rawContext = inner.data.context as PersistedDagContext;
      const actual = rawContext.__dagFingerprint;
      // Absent fingerprint = first write on a fresh job — accept and let
      // `updateData` stamp the current value on the next checkpoint. Only a
      // stamped *and* divergent value is a mismatch.
      if (actual !== undefined && actual !== expectedFingerprint) {
        return err({
          kind: "checkpoint-version-mismatch",
          runId,
          expected: expectedFingerprint,
          actual,
        });
      }
      return ok(undefined);
    },
  };
};
