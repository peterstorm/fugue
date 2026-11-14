import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { isDagInput } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";

/** Kahn's-algorithm bookkeeping: unmet-predecessor counts and the forward adjacency. */
interface Graph {
  readonly inDegree: Map<NodeId, number>;
  readonly successors: Map<NodeId, NodeId[]>;
}

const unknownEndpoint = (role: "source" | "target", id: NodeId): FrameworkError => ({
  kind: "validation" as const,
  nodeId: id,
  message: `Edge references unknown ${role} node '${id}'`,
});

// Fold the dag's edges into in-degree counts and successor lists, rejecting an
// edge whose endpoint is not a node of the dag.
const buildGraph = (dag: DagDef, nodeIds: ReadonlySet<NodeId>): Result<Graph, FrameworkError> => {
  const inDegree = new Map<NodeId, number>();
  const successors = new Map<NodeId, NodeId[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }

  for (const edge of dag.edges) {
    // `DAG_INPUT` is the virtual request source (wave -1): always satisfied, so
    // it contributes no in-degree and no successor edge. A node fed only by
    // `$input` therefore sorts into wave 0, consistent with `seedInitialActiveSet`.
    if (isDagInput(edge.from)) {
      if (!nodeIds.has(edge.to)) return err(unknownEndpoint("target", edge.to));
      continue;
    }
    if (!nodeIds.has(edge.from)) return err(unknownEndpoint("source", edge.from));
    if (!nodeIds.has(edge.to)) return err(unknownEndpoint("target", edge.to));
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    successors.get(edge.from)!.push(edge.to);
  }
  return ok({ inDegree, successors });
};

// Peel the graph wave by wave; nodes left with unmet predecessors form a cycle.
const peelWaves = (
  nodeIds: ReadonlySet<NodeId>,
  { inDegree, successors }: Graph,
): Result<NodeId[][], FrameworkError> => {
  const waves: NodeId[][] = [];
  let remaining = nodeIds.size;

  // Seed first wave with zero in-degree nodes
  let currentWave = [...nodeIds].filter((id) => inDegree.get(id) === 0);

  while (currentWave.length > 0) {
    waves.push(currentWave);
    remaining -= currentWave.length;

    const nextWave: NodeId[] = [];
    for (const id of currentWave) {
      for (const succ of successors.get(id)!) {
        const newDeg = inDegree.get(succ)! - 1;
        inDegree.set(succ, newDeg);
        if (newDeg === 0) {
          nextWave.push(succ);
        }
      }
    }
    currentWave = nextWave;
  }

  if (remaining > 0) {
    const cycleNodes = [...nodeIds].filter((id) => inDegree.get(id)! > 0);
    return err({ kind: "cycle-detected" as const, nodeIds: cycleNodes });
  }

  return ok(waves);
};

/**
 * Kahn's algorithm topological sort.
 * Returns waves of node IDs that can execute in parallel.
 */
export const topoSort = (dag: DagDef): Result<NodeId[][], FrameworkError> => {
  const nodeIds = new Set(dag.nodes.map((n) => n.id));
  const graph = buildGraph(dag, nodeIds);
  if (!graph.ok) return graph;
  return peelWaves(nodeIds, graph.value);
};
