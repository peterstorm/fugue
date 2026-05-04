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
}
