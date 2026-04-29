import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";

/**
 * Kahn's algorithm topological sort.
 * Returns waves of node IDs that can execute in parallel.
 */
export const topoSort = (dag: DagDef): Result<string[][], FrameworkError> => {
  const nodeIds = new Set(dag.nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }

  for (const edge of dag.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    successors.get(edge.from)!.push(edge.to);
  }

  const waves: string[][] = [];
  let remaining = nodeIds.size;

  // Seed first wave with zero in-degree nodes
  let currentWave = [...nodeIds].filter((id) => inDegree.get(id) === 0);

  while (currentWave.length > 0) {
    waves.push(currentWave);
    remaining -= currentWave.length;

    const nextWave: string[] = [];
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
