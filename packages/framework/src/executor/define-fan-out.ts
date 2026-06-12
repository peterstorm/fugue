// defineFanOut — convenience for the "one source, N parallel siblings,
// optional convergence" shape:
//
//          ┌─→ branch[0]
//   source ┤   ...           (→ join, if provided)
//          └─→ branch[N-1]
//
// Edges are derived: source→each branch, and (if `join` is provided) each
// branch→join. `outputNodeId` is the join when present, otherwise the last
// branch in the array — matching the rule "if a DAG omits outputNodeId, the
// runtime picks the last active node," but explicit is better than implicit.
//
// Sugar over `defineDagFromArray`. Same module-load validation, same brand.

import type { DagDef, DagProvenance } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import { defineDagFromArray } from "./define-dag.js";

/**
 * Fan-out branches must be non-empty. The tuple type makes the empty-array
 * case a compile error rather than a runtime throw.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
export type NonEmptyNodeList = readonly [NodeDef<any, any, any>, ...NodeDef<any, any, any>[]];

export interface FanOutDagConfig {
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly source: NodeDef<any, any, any>;
  readonly branches: NonEmptyNodeList;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly join?: NodeDef<any, any, any>;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly defaultRetryLimit?: number;
  readonly retryLimits?: Readonly<Record<string, number>>;
}

/**
 * Define a fan-out DAG: one source, N parallel branches, optionally
 * converging on a join node.
 *
 * ```ts
 * // Parallel fetches, no convergence — last branch is the output
 * const dag = defineFanOut({
 *   id: "parallel-fetch",
 *   source: triggerNode,
 *   branches: [fetchCrm, fetchBilling, fetchSupport],
 * });
 *
 * // Parallel fetches, converging on merge
 * const dag = defineFanOut({
 *   id: "enrich-customer",
 *   source: triggerNode,
 *   branches: [fetchCrm, fetchBilling, fetchSupport],
 *   join: mergeNode,
 * });
 * ```
 *
 * When `join` is present, it receives a fan-in input keyed by each branch's
 * id: `{ "fetch-crm": ..., "fetch-billing": ..., "fetch-support": ... }`.
 * Design `join.inputSchema` accordingly.
 */
export const defineFanOut = (
  config: FanOutDagConfig,
  // Internal: defineDiamond delegates here but stamps its own provenance.
  provenance: DagProvenance = "fan-out",
): DagDef => {
  const sourceId = config.source.id as string;
  const joinNode = config.join;

  // source → each branch
  const sourceEdges = config.branches.map((branch) => ({
    from: sourceId,
    to: branch.id as string,
  }));

  // each branch → join, if join present
  const joinEdges = joinNode
    ? config.branches.map((branch) => ({
        from: branch.id as string,
        to: joinNode.id as string,
      }))
    : [];

  const nodes = joinNode
    ? [config.source, ...config.branches, joinNode]
    : [config.source, ...config.branches];

  const outputNodeId = joinNode
    ? (joinNode.id as string)
    : (config.branches[config.branches.length - 1]!.id as string);

  return defineDagFromArray({
    id: config.id,
    nodes,
    edges: [...sourceEdges, ...joinEdges],
    outputNodeId,
    evalJudges: config.evalJudges,
    defaultRetryLimit: config.defaultRetryLimit,
    retryLimits: config.retryLimits,
    provenance,
  });
};
