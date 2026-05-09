import type { DagDef } from "../types/dag.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";

const validationErr = (nodeId: string, message: string): FrameworkError => ({
  kind: "validation" as const,
  nodeId,
  message,
});

/**
 * Structural validation of a DAG before topo sort. Catches shape errors that
 * topoSort + the executor would otherwise paper over (silent miscompute):
 *
 *   - empty `dag.nodes`
 *   - duplicate node IDs (would be silently deduped by Set in topoSort)
 *   - `dag.edges` ↔ `node.deps` mismatch (scheduler reads edges, executor reads
 *     deps, so a divergence runs nodes in wrong order or feeds undefined inputs)
 *   - `outputNodeId` references a non-existent node
 *
 * Edge.from / edge.to existence is left to topoSort, which already enforces it.
 */
export const validateDagShape = (dag: DagDef): Result<void, FrameworkError> => {
  if (dag.nodes.length === 0) {
    return err(validationErr("__dag__", `DAG '${dag.id}' has no nodes`));
  }

  const seen = new Set<string>();
  for (const n of dag.nodes) {
    if (seen.has(n.id)) {
      return err(validationErr(n.id, `Duplicate node id '${n.id}' in DAG '${dag.id}'`));
    }
    seen.add(n.id);
  }

  // Build incoming-edge map from dag.edges
  const incoming = new Map<string, Set<string>>();
  for (const n of dag.nodes) incoming.set(n.id, new Set());
  for (const e of dag.edges) {
    const set = incoming.get(e.to);
    if (!set) continue; // unknown target — topoSort handles this
    set.add(e.from);
  }

  // Compare node.deps to incoming-edge set per node
  for (const n of dag.nodes) {
    const declaredDeps = new Set(n.deps);
    const wiredDeps = incoming.get(n.id)!;

    for (const d of declaredDeps) {
      if (!wiredDeps.has(d)) {
        return err(
          validationErr(
            n.id,
            `Node '${n.id}' declares dep '${d}' but no edge '${d}' -> '${n.id}' exists`,
          ),
        );
      }
    }
    for (const d of wiredDeps) {
      if (!declaredDeps.has(d)) {
        return err(
          validationErr(
            n.id,
            `Edge '${d}' -> '${n.id}' has no matching entry in node '${n.id}' deps`,
          ),
        );
      }
    }
  }

  if (dag.outputNodeId !== undefined && !seen.has(dag.outputNodeId)) {
    return err(
      validationErr(
        dag.outputNodeId,
        `outputNodeId '${dag.outputNodeId}' is not a node in DAG '${dag.id}'`,
      ),
    );
  }

  return ok(undefined);
};
