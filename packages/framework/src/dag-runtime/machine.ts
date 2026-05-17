// compileDagToMachine — compiles a DagDef into a state-machine Machine.
// Produces a Machine<DagPhase, DagEvent, DagMachineContext> consumable by runStateMachine.

import type { Machine } from "../state-machine/types.js";
import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import { dagTransition } from "./transition.js";
import { topoSort } from "../shared/topo.js";
import { computeIncomingByNode, computeOutgoingByNode, seedInitialActiveSet } from "./conditional.js";

// ---------------------------------------------------------------------------
// stateProgress — maps DagPhase to a 0–100 progress value
// ---------------------------------------------------------------------------

const stateProgress = (phase: DagPhase): number => {
  switch (phase.kind) {
    case "pending":
      return 0;
    case "running":
      return 10;
    case "retrying":
      return 10;
    case "retrying-hook":
      // Same progress as awaiting-human since we're still in the review phase.
      return 50;
    case "awaiting-human":
      return 50;
    case "succeeded":
      return 100;
    case "failed":
      return 100;
  }
};

// ---------------------------------------------------------------------------
// isTerminal / isFailed
// ---------------------------------------------------------------------------

const isTerminal = (phase: DagPhase): boolean =>
  phase.kind === "succeeded" || phase.kind === "failed";

// retrying-hook is not failed (it's a transient retry state)
const isFailed = (phase: DagPhase): boolean => phase.kind === "failed";

// Retry detection for trace-outcome reporting. The DAG machine signals a retry
// by transitioning *into* a retrying variant (`running → retrying` or
// `awaiting-human → retrying-hook`); the trace consumer sees `outcome: "retry"`
// on that transition. The subsequent transition back to `running` is just the
// wave re-execution and reports as `success`.
const isRetryTransition = (_prev: DagPhase, next: DagPhase): boolean =>
  next.kind === "retrying" || next.kind === "retrying-hook";

// ---------------------------------------------------------------------------
// compileDagToMachine
// ---------------------------------------------------------------------------

export interface CompiledDagMachine {
  readonly machine: Machine<DagPhase, DagEvent, DagMachineContext>;
  readonly initialContext: DagMachineContext;
  readonly initialState: DagPhase;
}

/**
 * Compile a DagDef into a Machine — eagerly sorts waves so the executor doesn't re-sort.
 * Soundness: structural validation is delegated to `defineDag`'s brand; only topological
 * failure (cycle detection) can fail here.
 */
export const compileDagToMachine = (
  dag: DagDef,
  initialInput: unknown,
): Result<CompiledDagMachine, FrameworkError> => {
  const sortResult = topoSort(dag);
  if (!sortResult.ok) return sortResult;

  const waves: readonly (readonly NodeId[])[] = sortResult.value;

  const retryConfigs = new Map(
    dag.nodes
      .filter((n) => n.retry)
      .map((n) => [n.id, {
        backoffMs: n.retry!.backoffMs ?? [1000, 2000, 4000],
        jitterRatio: n.retry!.jitterRatio ?? 0.2,
      }] as const),
  );

  const initialContext: DagMachineContext = {
    dag,
    waves,
    outputs: new Map(),
    retries: new Map(),
    initialInput,
    activeNodeIds: seedInitialActiveSet(dag),
    incomingByNode: computeIncomingByNode(dag),
    outgoingByNode: computeOutgoingByNode(dag),
    nodeById: new Map(dag.nodes.map((n) => [n.id, n])),
    retryConfigs,
  };

  const machine: Machine<DagPhase, DagEvent, DagMachineContext> = {
    transition: dagTransition,
    isTerminal,
    isFailed,
    stateProgress,
    isRetryTransition,
    // DagPhase values are plain JSON-stable objects after Zod validation of
    // outputs. If a non-serializable value ever leaks through (bug), fall back
    // to a distinguishable key rather than throwing inside the runner loop.
    stateKey: (phase) => {
      try {
        return JSON.stringify(phase);
      } catch (e) {
        // DagPhase is always JSON-serializable after Zod validation. A failure
        // here is a framework invariant violation — fail loud rather than
        // silently corrupting retry counters and dedup keys.
        throw new Error(
          `[compileDagToMachine] stateKey serialization INVARIANT VIOLATION for phase kind="${phase.kind}": ` +
            `${e instanceof Error ? e.message : e}. Non-serializable value leaked into DagPhase.`,
          { cause: e },
        );
      }
    },
  };

  return ok({ machine, initialContext, initialState: { kind: "pending" } });
};
