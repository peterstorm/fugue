// JobLike persistence adapter for DagMachineContext.
//
// DagMachineContext carries two fields that must NOT round-trip through
// durable storage:
//   - `dag`: contains `run` closures and Zod schemas that JSON-strip to `{}`
//   - `incomingByNode`: derived from `dag.edges`, redundant with `dag`
//
// `wrapDagJobLike` strips both fields on `updateData` and re-injects them
// from the live call-site values on `data` read. The persisted snapshot
// stays compact and schema-stable; transition-time code sees a fully-formed
// context.
//
// On top of the strip/re-inject behaviour, the wrapper stamps the live DAG's
// `dagFingerprint` onto the persisted context. On resume, the wrapper's
// `verifyDagFingerprint()` compares the persisted fingerprint against the
// live one and returns `checkpoint-version-mismatch` when they diverge — a
// redeploy that rewired edges or renamed nodes is no longer undefined
// behaviour (ADR 0024 / pass-4 plan §4.6).

import type { JobLike } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { RunId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import { dagFingerprint } from "../checkpoint/fingerprint.js";
import { computeIncomingByNode } from "./conditional.js";

/**
 * The closure-only fields on `DagMachineContext` that are intentionally NOT
 * persisted by `JobLike` backends — `dag` carries Zod schemas and function
 * predicates, `incomingByNode` is recomputed from edges. Both are re-injected
 * on read via `wrapDagJobLike.get data()` from the live values at the call site.
 *
 * `__dagFingerprint` is stamped by `wrapDagJobLike.updateData` and compared
 * on resume by `verifyDagFingerprint`. Absent on legacy/first-write snapshots —
 * treated as "no prior fingerprint" rather than a mismatch.
 */
export type PersistableDagMachineContext = Omit<
  DagMachineContext,
  "dag" | "incomingByNode"
> & {
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
 * Strip the closure-bearing fields before handing state to the durable
 * backend. The explicit return type makes adding a new non-persistable field
 * to `DagMachineContext` a compile error here, rather than a silent strip.
 *
 * `__dagFingerprint` is added by `wrapDagJobLike.updateData`; this function
 * intentionally does not stamp it, so callers that bypass the wrapper get a
 * fingerprint-free snapshot and the legacy-resume code path applies.
 */
export const stripNonPersistable = (
  ctx: DagMachineContext,
): PersistableDagMachineContext => {
  const { dag: _dag, incomingByNode: _ibn, ...rest } = ctx;
  return rest;
};

/**
 * Wrap a caller-supplied `JobLike` so the persisted snapshot stays compact and
 * schema-stable. The internal type cast on the write side (Omit-then-cast-as-full)
 * is the inverse of the re-injection on read — they compose to identity from
 * the runner's perspective. The wrapper also stamps `__dagFingerprint` on
 * every persisted snapshot; pair with `verifyDagFingerprint()` at run start
 * to detect a redeployed topology mid-run.
 */
export const wrapDagJobLike = (
  inner: JobLike<DagPhase, unknown, DagMachineContext>,
  dag: DagDef,
  runId: RunId,
): WrappedDagJobLike => {
  const incomingByNode = computeIncomingByNode(dag);
  const expectedFingerprint = dagFingerprint(dag);

  const job: JobLike<DagPhase, unknown, DagMachineContext> = {
    get data(): { state: DagPhase; context: DagMachineContext } {
      const raw = inner.data;
      // Re-inject the live dag + incomingByNode. The persisted raw.context
      // is intentionally missing them (post-strip); live values win. The
      // `__dagFingerprint` field stays on the returned context so subsequent
      // `updateData` calls re-stamp it deterministically.
      return {
        state: raw.state,
        context: { ...raw.context, dag, incomingByNode },
      };
    },
    async updateData(d: { state: DagPhase; context: DagMachineContext }): Promise<void> {
      // The inner `JobLike` is typed against the full `DagMachineContext`, but
      // we deliberately persist the stripped form; the live `dag` + `incoming`
      // are re-injected on read. The cast is the boundary between the typed
      // strip and the inner adapter's wider type.
      const persistable: PersistableDagMachineContext = {
        ...stripNonPersistable(d.context),
        __dagFingerprint: expectedFingerprint,
      };
      await inner.updateData({
        state: d.state,
        context: persistable as unknown as DagMachineContext,
      });
    },
    updateProgress: (pct: number) => inner.updateProgress(pct),
    // Tightened from `(event: unknown, ...)` so the wrapper's declared
    // JobLike<…, unknown, DagEvent> contract is honest. Inner's E defaults to unknown,
    // which accepts DagEvent cleanly.
    appendEvent: (event: DagEvent, dedupKey?: string) =>
      inner.appendEvent(event, dedupKey),
  };

  return {
    job,
    verifyDagFingerprint(): Result<void, FrameworkError> {
      const rawContext = inner.data.context as unknown as PersistableDagMachineContext;
      const actual = rawContext.__dagFingerprint;
      // Absent fingerprint = legacy snapshot or first write on a fresh job —
      // accept and let `updateData` stamp the current value on the next
      // checkpoint. Only a stamped *and* divergent value is a mismatch.
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
