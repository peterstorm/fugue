// Topology helpers — pure graph algorithms for DAG structure analysis.
// All functions are pure; no I/O.
//
// Extracted from conditional.ts for separation of concerns:
// - topology.ts: static graph analysis (adjacency, reachability, incoming sources)
// - routing.ts: business-rule evaluation (predicate evaluation, route decisions)

import type { DagDef, EdgeDef } from "../types/dag.js";
import {
  isConditionalEdge,
  isDefaultEdge,
  isUnconditionalEdge,
} from "../types/dag.js";
import type { NodeId } from "../types/ids.js";
import type { IncomingSources } from "../shared/incoming.js";

export type { IncomingSources };

// ---------------------------------------------------------------------------
// Adjacency helpers
// ---------------------------------------------------------------------------

const buildOutgoing = (dag: DagDef): Map<NodeId, EdgeDef[]> => {
  const out = new Map<NodeId, EdgeDef[]>();
  for (const n of dag.nodes) out.set(n.id, []);
  for (const e of dag.edges) {
    const list = out.get(e.from);
    if (list) list.push(e);
  }
  return out;
};

const buildIncoming = (dag: DagDef): Map<NodeId, EdgeDef[]> => {
  const inc = new Map<NodeId, EdgeDef[]>();
  for (const n of dag.nodes) inc.set(n.id, []);
  for (const e of dag.edges) {
    const list = inc.get(e.to);
    if (list) list.push(e);
  }
  return inc;
};

/**
 * Seed the initial active set: every node reachable from a wave-0 entry point
 * along unconditional edges only. Conditional and default targets are added
 * later when their predicate fires.
 *
 * Wave-0 entry points are nodes with no incoming edges of any kind.
 *
 * Accepts either a `DagDef` (for compile-time) or raw `edges` + precomputed
 * `outgoing` map (for the pure transition layer which has no access to `DagDef`).
 */
export function seedInitialActiveSet(dag: DagDef): ReadonlySet<NodeId>;
export function seedInitialActiveSet(edges: readonly EdgeDef[], outgoing: ReadonlyMap<NodeId, readonly EdgeDef[]>): ReadonlySet<NodeId>;
export function seedInitialActiveSet(
  dagOrEdges: DagDef | readonly EdgeDef[],
  precomputedOutgoing?: ReadonlyMap<NodeId, readonly EdgeDef[]>,
): ReadonlySet<NodeId> {
  let edges: readonly EdgeDef[];
  let outgoing: ReadonlyMap<NodeId, readonly EdgeDef[]>;
  let nodeIds: readonly NodeId[];

  if (Array.isArray(dagOrEdges)) {
    edges = dagOrEdges;
    outgoing = precomputedOutgoing!;
    // Derive node ids from edges (all unique from/to)
    const ids = new Set<NodeId>();
    for (const e of edges) { ids.add(e.from); ids.add(e.to); }
    nodeIds = [...ids];
  } else {
    const dag = dagOrEdges as DagDef;
    edges = dag.edges;
    outgoing = buildOutgoing(dag);
    nodeIds = dag.nodes.map(n => n.id);
  }

  // Build incoming count
  const incomingCount = new Map<NodeId, number>();
  for (const id of nodeIds) incomingCount.set(id, 0);
  for (const e of edges) incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);

  const seeds: NodeId[] = [];
  for (const id of nodeIds) {
    if ((incomingCount.get(id) ?? 0) === 0) seeds.push(id);
  }

  const active = new Set<NodeId>(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const curEdges = outgoing.get(cur) ?? [];
    for (const e of curEdges) {
      if (!isUnconditionalEdge(e)) continue;
      if (!active.has(e.to)) {
        active.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return active;
}

/**
 * Expand `prev` to include `chosenTargets` and every node forward-reachable
 * from those targets along unconditional edges only. Idempotent.
 *
 * Uses `unconditionalAdj` (closure-free, serializable) for the walk.
 */
export const expandActive = (
  unconditionalAdj: ReadonlyMap<NodeId, readonly NodeId[]>,
  prev: ReadonlySet<NodeId>,
  chosenTargets: Iterable<NodeId>,
): ReadonlySet<NodeId> => {
  const next = new Set(prev);
  const stack: NodeId[] = [];
  for (const t of chosenTargets) {
    if (!next.has(t)) {
      next.add(t);
      stack.push(t);
    }
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const to of (unconditionalAdj.get(cur) ?? [])) {
      if (!next.has(to)) {
        next.add(to);
        stack.push(to);
      }
    }
  }
  return next;
};

/**
 * Get all out-edges for a given source node id.
 *
 * Prefer `machineCtx.outgoingByNode.get(id)` from `DagMachineContext` where
 * available — that map is precomputed once in `compileDagToMachine`. This
 * helper is retained for non-runtime callers (validators, tests) that don't
 * have access to a `DagMachineContext`.
 */
export const outgoingOf = (dag: DagDef, fromNodeId: NodeId): readonly EdgeDef[] =>
  dag.edges.filter((e) => e.from === fromNodeId);

/**
 * Compile-time adjacency builder. Walk all edges once and bucket by `from`,
 * giving every node its outgoing list in O(E). Consumers do O(1) lookup.
 */
export const computeOutgoingByNode = (
  dag: DagDef,
): ReadonlyMap<NodeId, readonly EdgeDef[]> => {
  const map = new Map<NodeId, EdgeDef[]>();
  for (const e of dag.edges) {
    const bucket = map.get(e.from);
    if (bucket) bucket.push(e);
    else map.set(e.from, [e]);
  }
  return map;
};

/**
 * Compile-time closure-free adjacency builder. Maps each node to the target
 * node IDs of its unconditional out-edges only. Used by the pure transition
 * layer (`expandActive`, `seedInitialActiveSet`) which never evaluates
 * predicate closures. Serializable.
 */
export const computeUnconditionalAdj = (
  dag: DagDef,
): ReadonlyMap<NodeId, readonly NodeId[]> => {
  const map = new Map<NodeId, NodeId[]>();
  for (const e of dag.edges) {
    if (!isUnconditionalEdge(e)) continue;
    const bucket = map.get(e.from);
    if (bucket) bucket.push(e.to);
    else map.set(e.from, [e.to]);
  }
  return map;
};

// ---------------------------------------------------------------------------
// Per-node incoming sources — derived input-wiring contract.
//
// Replaces the author-supplied `deps` / `optionalDeps` fields. Each edge into
// `toNodeId` lands in one of two buckets:
//
//   required — the upstream is **guaranteed to run** AND its edge always
//              fires when it does. Concretely: edge is unconditional and the
//              upstream is in `seedInitialActiveSet(dag)` (= reachable from
//              wave-0 entries along unconditional edges).
//
//   optional — the upstream might be pruned or the edge might not fire:
//              * conditional edge (only fires if its predicate matches),
//              * default edge (only fires if no predicate matched),
//              * unconditional edge whose source isn't always-active (the
//                source itself sits behind a conditional/default).
//
// When `optional` is non-empty the runtime builds `nodeInput` as an object
// keyed by `required ∪ optional`; absent optional sources surface as
// `undefined` (preserving the legacy `optionalDeps` semantics).
// ---------------------------------------------------------------------------


const incomingSourcesFor = (
  dag: DagDef,
  toNodeId: NodeId,
  alwaysActive: ReadonlySet<NodeId>,
): IncomingSources => {
  const required: string[] = [];
  const optional: string[] = [];
  const seenRequired = new Set<string>();
  const seenOptional = new Set<string>();

  for (const e of dag.edges) {
    if (e.to !== toNodeId) continue;
    if (isConditionalEdge(e) || isDefaultEdge(e)) {
      if (!seenOptional.has(e.from)) {
        seenOptional.add(e.from);
        optional.push(e.from);
      }
      continue;
    }
    // Unconditional edge.
    if (alwaysActive.has(e.from)) {
      if (!seenRequired.has(e.from)) {
        seenRequired.add(e.from);
        required.push(e.from);
      }
    } else {
      if (!seenOptional.has(e.from)) {
        seenOptional.add(e.from);
        optional.push(e.from);
      }
    }
  }

  return { required, optional };
};

/**
 * Precompute `IncomingSources` for every node in the DAG. Returns a Map keyed
 * by node id; lookups are O(1) at wave dispatch time.
 *
 * Called once per `compileDagToMachine` / `runDagInner` and stashed on the
 * machine context (`incomingByNode`).
 */
export const computeIncomingByNode = (
  dag: DagDef,
): Map<NodeId, IncomingSources> => {
  const alwaysActive = seedInitialActiveSet(dag);
  const out = new Map<NodeId, IncomingSources>();
  for (const n of dag.nodes) {
    out.set(n.id, incomingSourcesFor(dag, n.id, alwaysActive));
  }
  return out;
};

/**
 * Look up an `IncomingSources` for one node. Slow path (rebuilds the
 * always-active set each call); reach for `computeIncomingByNode` instead
 * when iterating.
 */
export const incomingSources = (
  dag: DagDef,
  toNodeId: NodeId,
): IncomingSources =>
  incomingSourcesFor(dag, toNodeId, seedInitialActiveSet(dag));
