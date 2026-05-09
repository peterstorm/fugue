// compileDagToMachine — FR-023 (DAG layer)
// Produces a Machine<DagPhase, DagEvent, DagMachineContext> consumable by runStateMachine.

import type { Machine } from "../state-machine/types.js";
import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import { dagTransition } from "./transition.js";
import { topoSort } from "../executor/topo.js";
import { validateDagShape } from "../executor/validate-dag.js";

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

// ---------------------------------------------------------------------------
// compileDagToMachine
// ---------------------------------------------------------------------------

export interface CompiledDagMachine {
  readonly machine: Machine<DagPhase, DagEvent, DagMachineContext>;
  readonly initialContext: DagMachineContext;
  readonly initialState: DagPhase;
}

/**
 * Compile a DagDef into a Machine<DagPhase, DagEvent, DagMachineContext>.
 *
 * The returned machine is consumed by runStateMachine from the state-machine kernel.
 * topoSort is called eagerly and embedded in the returned context factory so the
 * executor can reference waves without re-sorting.
 *
 * Returns `err` on topological failure (cycle, dangling edge). Callers must
 * propagate this through their normal error path so the caller-visible
 * behavior matches the legacy fast path — a malformed DAG must produce a
 * `FrameworkError`, an emitted `run-end` event, and a closed root span,
 * never an unhandled promise rejection.
 */
export const compileDagToMachine = (
  dag: DagDef,
  initialInput: unknown,
): Result<CompiledDagMachine, FrameworkError> => {
  const shapeResult = validateDagShape(dag);
  if (!shapeResult.ok) return shapeResult;

  const sortResult = topoSort(dag);
  if (!sortResult.ok) return sortResult;

  const waves: readonly (readonly string[])[] = sortResult.value;

  const initialContext: DagMachineContext = {
    dag,
    waves,
    outputs: new Map(),
    retries: new Map(),
    initialInput,
  };

  const machine: Machine<DagPhase, DagEvent, DagMachineContext> = {
    transition: dagTransition,
    isTerminal,
    isFailed,
    stateProgress,
    maxRetries: {}, // retry budget is tracked inside the context.retries map; kernel maxRetries not used
  };

  return ok({ machine, initialContext, initialState: { kind: "pending" } });
};
