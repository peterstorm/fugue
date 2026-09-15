// Topology helpers — pure graph algorithms for DAG structure analysis.
// All functions are pure; no I/O.
//
// Runtime routing is split by responsibility:
// - topology.ts: static graph analysis (adjacency, reachability, incoming sources)
// - route-emission.ts / reroute.ts: route decisions, emission, and reroute validation

import type { DagDef, EdgeDef } from "../types/dag.js";
import {
  isConditionalEdge,
  isDefaultEdge,
  isUnconditionalEdge,
} from "../types/dag.js";
import type { NodeId } from "../types/ids.js";
import { isDagInput } from "../types/ids.js";
import type { IncomingSources } from "../shared/incoming.js";

export type { IncomingSources };

// ---------------------------------------------------------------------------
// Adjacency helpers
// ---------------------------------------------------------------------------

/**
 * Seed the initial active set: every node reachable from a wave-0 entry point
 * along unconditional edges only. Conditional and default targets are added
 * later when their predicate fires.
 *
 * Wave-0 entry points are nodes with no incoming edges from real nodes;
 * virtual `DAG_INPUT` edges are already satisfied and do not count.
 */
export function seedInitialActiveSet(dag: DagDef): ReadonlySet<NodeId> {
  const edges = dag.edges;
  const outgoing = computeOutgoingByNode(dag);
  const nodeIds = dag.nodes.map(n => n.id);

  // Build incoming count. `DAG_INPUT` edges DON'T count: `$input` is a virtual
  // wave-(-1) source, always satisfied, so a node whose only inbound is a
  // `$input` edge is a wave-0 seed exactly like a true root.
  const incomingCount = new Map<NodeId, number>();
  for (const id of nodeIds) incomingCount.set(id, 0);
  for (const e of edges) {
    if (isDagInput(e.from)) continue;
    incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
  }

  const seeds = nodeIds.filter((id) => (incomingCount.get(id) ?? 0) === 0);

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
 * Compile-time adjacency builder. Walk all edges once and bucket by `from`;
 * only nodes with at least one outgoing (non-`$input`) edge receive a bucket —
 * sink nodes are absent from the map, so consumers guard with `?? []` (O(1)
 * lookup against the precomputed map).
 */
export const computeOutgoingByNode = (
  dag: DagDef,
): ReadonlyMap<NodeId, readonly EdgeDef[]> => {
  const map = new Map<NodeId, EdgeDef[]>();
  for (const e of dag.edges) {
    if (isDagInput(e.from)) continue; // virtual source has no node to dispatch from
    const bucket = map.get(e.from);
    if (bucket) bucket.push(e);
    else map.set(e.from, [e]);
  }
  return map;
};

/**
 * Compile-time closure-free adjacency builder. Buckets the target node IDs of
 * unconditional out-edges by `from`; only nodes with at least one unconditional
 * (non-`$input`) out-edge receive a bucket. Consumed by `expandActive`
 * (wave-resolution.ts, reroute.ts), which never evaluates predicate closures;
 * `seedInitialActiveSet` derives its own outgoing instead. Serializable.
 */
export const computeUnconditionalAdj = (
  dag: DagDef,
): ReadonlyMap<NodeId, readonly NodeId[]> => {
  const map = new Map<NodeId, NodeId[]>();
  for (const e of dag.edges) {
    if (!isUnconditionalEdge(e)) continue;
    if (isDagInput(e.from)) continue; // virtual source; activation seeds $input-fed nodes directly
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
// Input shape depends on total source count, not bucket: one required or
// selected optional source is bare; two or more are keyed by
// `required ∪ optional`, with absent optional sources represented as undefined.
// ---------------------------------------------------------------------------


const incomingSourcesFor = (
  dag: DagDef,
  toNodeId: NodeId,
  alwaysActive: ReadonlySet<NodeId>,
): IncomingSources => {
  // Branded from the gate-validated `EdgeDef` endpoints — the validated-id
  // invariant `buildNodeInput` advertises as structural for its `nodeId`
  // parameter is carried end-to-end instead of dropped at this boundary.
  const required: NodeId[] = [];
  const optional: NodeId[] = [];
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
    // Unconditional edge. `DAG_INPUT` is always-active by construction (seeded
    // at run start), so a `$input` edge is always a required source carrying
    // the request — it never lands in `optional`.
    if (isDagInput(e.from) || alwaysActive.has(e.from)) {
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
 * Called once per `compileDagToMachine` (dag-runtime/machine.ts, stashed on
 * the machine context as `incomingByNode`) and per `wrapDagJobLike`
 * (dag-runtime/persistence.ts); `fugue lint` (cli/lint-checks.ts) also derives
 * the same map for its key-set checks.
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
