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

import type { JobLike } from "../state-machine/types.js";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import type { DagDef } from "../types/dag.js";
import { computeIncomingByNode } from "./conditional.js";

/**
 * The closure-only fields on `DagMachineContext` that are intentionally NOT
 * persisted by `JobLike` backends — `dag` carries Zod schemas and function
 * predicates, `incomingByNode` is recomputed from edges. Both are re-injected
 * on read via `wrapDagJobLike.get data()` from the live values at the call site.
 */
export type PersistableDagMachineContext = Omit<DagMachineContext, "dag" | "incomingByNode">;

/**
 * Strip the closure-bearing fields before handing state to the durable
 * backend. The explicit return type makes adding a new non-persistable field
 * to `DagMachineContext` a compile error here, rather than a silent strip.
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
 * the runner's perspective.
 */
export const wrapDagJobLike = (
  inner: JobLike<DagPhase, unknown, DagMachineContext>,
  dag: DagDef,
): JobLike<DagPhase, unknown, DagMachineContext> => {
  const incomingByNode = computeIncomingByNode(dag);
  return {
    get data(): { state: DagPhase; context: DagMachineContext } {
      const raw = inner.data;
      // Re-inject the live dag + incomingByNode. The persisted raw.context
      // is intentionally missing them (post-strip); live values win.
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
      const persistable = stripNonPersistable(d.context);
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
};
