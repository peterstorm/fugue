// defineDiamond — the canonical fan-out + fan-in shape:
//
//             ┌─→ branch[0] ─┐
//   source ──┤   ...          ├─→ join
//             └─→ branch[N-1] ┘
//
// This is `defineFanOut` with a *required* join, expressed as its own
// constructor so the type signature documents the intent ("this is a
// diamond"). Output is always the join node. Sugar over `defineFanOut`.

import type { DagDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import { defineFanOut } from "./define-fan-out.js";

export interface DiamondDagConfig {
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly source: NodeDef<any, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly branches: readonly NodeDef<any, any, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly join: NodeDef<any, any, any>;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly defaultRetryLimit?: number;
  readonly retryLimits?: Readonly<Record<string, number>>;
}

/**
 * Define a diamond DAG: one source, N parallel branches, all converging on a
 * required join node.
 *
 * ```ts
 * const dag = defineDiamond({
 *   id: "enrich",
 *   source: triggerNode,
 *   branches: [enrichA, enrichB],
 *   join: mergeNode,
 * });
 * ```
 *
 * The join node receives a fan-in input keyed by each branch's id. See
 * `mergeInputs` for a helper that builds the matching schema.
 */
export const defineDiamond = (config: DiamondDagConfig): DagDef => {
  if (config.branches.length === 0) {
    throw new Error("[defineDiamond] branches array must not be empty");
  }

  return defineFanOut({
    id: config.id,
    source: config.source,
    branches: config.branches,
    join: config.join,
    evalJudges: config.evalJudges,
    defaultRetryLimit: config.defaultRetryLimit,
    retryLimits: config.retryLimits,
  });
};
