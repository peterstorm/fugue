import type { NodeDef } from "./node.js";

export interface EdgeDef {
  readonly from: string;
  readonly to: string;
}

export interface DagDef {
  readonly id: string;
  readonly nodes: readonly NodeDef<any, any, any>[];
  readonly edges: readonly EdgeDef[];
}
