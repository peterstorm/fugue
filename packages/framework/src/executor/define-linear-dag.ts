// defineLinearDag — convenience for the most common DAG shape: A → B → C → D.
//
// Edges are inferred from array order. The last node is the output. Saves
// authors from writing N-1 edges for a linear pipeline.
//
// This is sugar over `defineDagFromArray`. Same module-load validation,
// same branded result.

import type { DagDef } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import { DagDefinitionError, defineDagFromArray } from "./define-dag.js";
import { nodeId } from "../types/ids.js";
import { dagInputEdgeFor } from "./dag-input-edge.js";

export interface LinearDagConfig {
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly nodes: readonly NodeDef<any, any, any>[];
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly defaultRetryLimit?: number;
  readonly retryLimits?: Readonly<Record<string, number>>;
}

/**
 * Define a linear DAG where nodes execute sequentially in array order.
 *
 * Equivalent to `defineDagFromArray` with edges `[0]→[1]→[2]→...→[N-1]`
 * and `outputNodeId` set to the last node.
 *
 * ```ts
 * const dag = defineLinearDag({
 *   id: "my-pipeline",
 *   nodes: [fetchNode, transformNode, llmNode],
 * });
 * // Produces edges: fetch→transform→llm, output: llm
 * ```
 */
export const defineLinearDag = (config: LinearDagConfig): DagDef => {
  if (config.nodes.length === 0) {
    throw new DagDefinitionError(config.id, {
      kind: "validation",
      nodeId: nodeId(config.id),
      message: "defineLinearDag requires at least one node",
    });
  }

  const chainEdges = config.nodes.slice(0, -1).map((node, i) => ({
    from: node.id as string,
    to: config.nodes[i + 1]!.id as string,
  }));

  // The first node is the entry: feed it the request via a `$input` edge
  // (unless it's a source node that consumes nothing).
  const edges = [...dagInputEdgeFor(config.nodes[0]!), ...chainEdges];

  const lastNode = config.nodes[config.nodes.length - 1]!;

  return defineDagFromArray({
    id: config.id,
    nodes: config.nodes,
    edges,
    outputNodeId: lastNode.id as string,
    evalJudges: config.evalJudges,
    defaultRetryLimit: config.defaultRetryLimit,
    retryLimits: config.retryLimits,
    provenance: "linear",
  });
};
