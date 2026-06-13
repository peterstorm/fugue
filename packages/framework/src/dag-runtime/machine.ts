// compileDagToMachine — compiles a DagDef into a state-machine Machine.
// Produces a Machine<DagPhase, DagEvent, DagMachineContext> consumable by runStateMachine.

import type { Machine } from "../state-machine/types.js";
import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { DAG_INPUT } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";
import type { DagPhase, DagEvent, DagMachineContext } from "./types.js";
import { dagTransition } from "./transition.js";
import { topoSort } from "../shared/topo.js";
import { computeIncomingByNode, computeOutgoingByNode, computeUnconditionalAdj, seedInitialActiveSet } from "./topology.js";
import { match } from "ts-pattern";

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
    // Seed the validated DAG input under the reserved `$input` key (C0). A
    // `{ from: DAG_INPUT, to: n }` edge then resolves the request via the
    // ordinary outputs-map lookup in `buildNodeInput` — no node receives the
    // input implicitly. `initialInput` is retained for persistence/replay.
    outputs: new Map<NodeId, unknown>([[DAG_INPUT, initialInput]]),
    retries: new Map(),
    initialInput,
    activeNodeIds: seedInitialActiveSet(dag),
    incomingByNode: computeIncomingByNode(dag),
    outgoingByNode: computeOutgoingByNode(dag),
    unconditionalAdj: computeUnconditionalAdj(dag),
    nodeById: new Map(dag.nodes.map((n) => [n.id, n])),
    retryConfigs,
    // Plain-data fields for the pure transition layer (no closures)
    outputNodeId: dag.outputNodeId,
    defaultRetryLimit: dag.defaultRetryLimit,
    retryLimits: dag.retryLimits,
    humanReviewNodeIds: new Set(dag.nodes.filter(n => n.humanReview !== undefined).map(n => n.id)),
    humanReviewPrompts: new Map(
      dag.nodes
        .filter(n => n.humanReview !== undefined)
        .map(n => [n.id, n.humanReview!.prompt] as const),
    ),
    edges: dag.edges,
    confidenceByNode: new Map(),
  };

  const machine: Machine<DagPhase, DagEvent, DagMachineContext> = {
    transition: (state, event, ctx) => {
      // dagTransition operates on DagMachineContextPersisted (no closures).
      // DagMachineContext structurally satisfies it. The returned context is
      // DagMachineContextPersisted; spread with the live fields to reconstruct
      // the full DagMachineContext.
      const result = dagTransition(state, event, ctx);
      return { state: result.state, context: { ...ctx, ...result.context } };
    },
    isTerminal,
    isFailed,
    stateProgress,
    isRetryTransition,
    // DagPhase key derivation — uses discriminant fields only to avoid
    // serializing large `output: unknown` payloads on every transition.
    // ts-pattern `.exhaustive()` guarantees a compile error if a new
    // DagPhase variant is added without handling it here.
    stateKey: (phase) =>
      match(phase)
        .with({ kind: "pending" }, () => "pending")
        .with({ kind: "running" }, (p) => `running:${p.wave}`)
        .with({ kind: "retrying" }, (p) => `retrying:${p.wave}:${p.nodeId}:${p.attempt}`)
        .with({ kind: "retrying-hook" }, (p) => `retrying-hook:${p.nodeId}:${p.attempt}`)
        .with({ kind: "awaiting-human" }, (p) => `awaiting-human:${p.nodeId}:${p.wave}`)
        .with({ kind: "succeeded" }, () => "succeeded")
        .with({ kind: "failed" }, (p) => `failed:${p.error.kind}`)
        .exhaustive(),
  };

  return ok({ machine, initialContext, initialState: { kind: "pending" } });
};
