import type { NodeDef } from "./node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";

export interface EdgeDef {
  readonly from: string;
  readonly to: string;
}

export interface DagDef {
  readonly id: string;
  readonly nodes: readonly NodeDef<any, any, any>[];
  readonly edges: readonly EdgeDef[];
  /** Explicit output node. If omitted, falls back to the last node in the final topo wave. */
  readonly outputNodeId?: string;
  /** Eval-judge nodes — run after output node completes, mark trace ERROR on failure. */
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  /**
   * Per-node retry limits — overrides `defaultRetryLimit` for a specific node.
   * Optional for back-compat; existing callers that omit it get the legacy behavior.
   */
  readonly retryLimits?: Readonly<Record<string, number>>;
  /**
   * Default retry limit applied to all nodes without an entry in `retryLimits`.
   * Optional for back-compat; defaults to 0 (no retries) when not supplied.
   */
  readonly defaultRetryLimit?: number;
}
