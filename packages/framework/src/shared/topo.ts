import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { isDagInput } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";

/**
 * Kahn's algorithm topological sort.
 * Returns waves of node IDs that can execute in parallel.
 */
export const topoSort = (dag: DagDef): Result<NodeId[][], FrameworkError> => {
  const nodeIds = new Set(dag.nodes.map((n) => n.id));
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
      if (!nodeIds.has(edge.to)) {
        return err({
          kind: "validation" as const,
          nodeId: edge.to,
          message: `Edge references unknown target node '${edge.to}'`,
        });
      }
      continue;
    }
    if (!nodeIds.has(edge.from)) {
      return err({
        kind: "validation" as const,
        nodeId: edge.from,
        message: `Edge references unknown source node '${edge.from}'`,
      });
    }
    if (!nodeIds.has(edge.to)) {
      return err({
        kind: "validation" as const,
        nodeId: edge.to,
        message: `Edge references unknown target node '${edge.to}'`,
      });
    }
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    successors.get(edge.from)!.push(edge.to);
  }

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
