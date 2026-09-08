import type { DagDef } from "../types/dag.js";
import type { NodeId } from "../types/ids.js";

/**
 * The bounded execution inventory: outer nodes, then each map's direct children.
 * Shared by runtime preflight and describe; this does not project topology or
 * hoist child requirements onto the map's per-invocation authority request.
 */
export const runtimeNodeInventory = (dag: Pick<DagDef, "nodes">): Readonly<{
  nodes: DagDef["nodes"];
  mappedChildren: ReadonlyMap<NodeId, DagDef>;
}> => {
  const mappedChildren = new Map<NodeId, DagDef>();
  const nodes = [...dag.nodes];
  for (const node of dag.nodes) {
    if (node.kind !== "map") continue;
    const child = node.mapping.child;
    mappedChildren.set(node.id, child);
    nodes.push(...child.nodes);
  }
  return Object.freeze({ nodes: Object.freeze(nodes), mappedChildren });
};
