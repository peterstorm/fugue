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

/**
 * The sorted, deduplicated capability union of the bounded inventory's nodes —
 * outer and mapped-child requirements in one collection, the complete set the
 * runtime claims during execution (child requirements are hoisted onto the
 * map's per-invocation authority request). Derived here beside the inventory
 * it summarizes so a change to how the inventory is bounded cannot be
 * forgotten in describe.
 */
export const inventoryCapabilities = (dag: Pick<DagDef, "nodes">): string[] =>
  [...new Set(runtimeNodeInventory(dag).nodes.flatMap((node) => node.requires))].sort();
