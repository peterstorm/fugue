// Conditional-edge runtime helpers.
// All functions are pure; no I/O.

import type { DagDef, EdgeDef, Predicate } from "../types/dag.js";
import {
  isConditionalEdge,
  isDefaultEdge,
  isUnconditionalEdge,
  evaluatePredicate,
} from "../types/dag.js";
import type { NodeId } from "../types/ids.js";
import type { IncomingSources } from "../shared/incoming.js";
import type { Confidence } from "../types/confidence.js";
import type { RouteEvidence } from "../types/events.js";

export type { IncomingSources };

export type Decision =
  | {
      readonly kind: "decided";
      /** Targets that fire on this routing decision (always-fired unconditional + at most one branch target). */
      readonly chosenTargets: ReadonlySet<NodeId>;
      /** Guarded + default targets that did NOT fire from this source. */
      readonly prunedTargets: ReadonlySet<NodeId>;
      /** True when no predicate matched and the default edge target was selected. */
      readonly defaultTaken: boolean;
      /** Per-predicate evaluation results for evidence recording. */
      readonly predicateResults: RouteEvidence["predicateResults"];
    }
  | {
      readonly kind: "predicate-malformed";
      readonly fromNodeId: NodeId;
      readonly message: string;
    };

/**
 * Decide which targets of a single source node fire after it produces `output`.
 *
 * - All unconditional out-edges always fire.
 * - If any conditional out-edges exist, evaluate them in declaration order.
 *   The first predicate matching selects that target; the default edge only
 *   fires if no predicate matched.
 * - The validator guarantees a default edge exists whenever there is at least
 *   one conditional edge from this source.
 *
 * Each predicate is evaluated via `evaluatePredicate` which handles
 * `minConfidence` gating and exception safety. All results are recorded
 * in `predicateResults` for evidence.
 *
 * @param upstreamConfidence - The confidence signal from the source node.
 *   When the source node declares `confidence: { mode: "value" }`, the
 *   executor extracts it. Pass `null` for nodes with `mode: "none"`.
 */
export const decideRoute = (
  fromNodeId: NodeId,
  output: unknown,
  outgoing: readonly EdgeDef[],
  upstreamConfidence: Confidence | null = null,
): Decision => {
  const unconditional = outgoing.filter(isUnconditionalEdge);
  const guarded = outgoing.filter(isConditionalEdge);
  const defaultEdge = outgoing.find(isDefaultEdge);

  const unconditionalTargets = unconditional.map((e) => e.to);

  if (guarded.length === 0) {
    return {
      kind: "decided",
      chosenTargets: new Set(unconditionalTargets),
      prunedTargets: new Set<NodeId>(),
      defaultTaken: false,
      predicateResults: [],
    };
  }

  // Validate predicate shapes defensively (catches `as` casts at runtime)
  for (const e of guarded) {
    const pred = e.when;
    if (pred === null || typeof pred !== "object") {
      return {
        kind: "predicate-malformed",
        fromNodeId,
        message: "predicate must be a non-null object",
      };
    }
    if (typeof (pred as { check?: unknown }).check !== "function") {
      return {
        kind: "predicate-malformed",
        fromNodeId,
        message: `predicate on edge from '${fromNodeId}' is missing a 'check' function`,
      };
    }
    if (typeof (pred as { label?: unknown }).label !== "string" || (pred as { label: string }).label.length === 0) {
      return {
        kind: "predicate-malformed",
        fromNodeId,
        message: `predicate on edge from '${fromNodeId}' is missing a 'label'`,
      };
    }
  }

  // Evaluate predicates in declaration order; first match wins.
  const predicateResults: RouteEvidence["predicateResults"][number][] = [];
  let matchedEdge: EdgeDef | null = null;

  for (const e of guarded) {
    const result = evaluatePredicate(e.when, output, upstreamConfidence);
    predicateResults.push(result);

    if (result.matched && matchedEdge === null) {
      matchedEdge = e;
      // Continue evaluating remaining predicates for evidence completeness
    }
  }

  // A predicate that throws is a programming error — surface as malformed
  // rather than silently falling to the default edge.
  const threwResult = predicateResults.find(r => r.reason?.startsWith("threw"));
  if (threwResult) {
    const detail = threwResult.reason?.startsWith("threw: ") ? threwResult.reason.slice(7) : "unknown";
    return {
      kind: "predicate-malformed",
      fromNodeId,
      message: `Predicate '${threwResult.predicateLabel}' threw an exception: ${detail}`,
    };
  }

  if (matchedEdge !== null) {
    const pruned = new Set<NodeId>();
    for (const g of guarded) if (g.to !== matchedEdge.to) pruned.add(g.to);
    if (defaultEdge) pruned.add(defaultEdge.to);
    return {
      kind: "decided",
      chosenTargets: new Set([...unconditionalTargets, matchedEdge.to]),
      prunedTargets: pruned,
      defaultTaken: false,
      predicateResults,
    };
  }

  // No predicate matched — validator guarantees defaultEdge exists.
  const pruned = new Set<NodeId>(guarded.map((g) => g.to));
  return {
    kind: "decided",
    chosenTargets: new Set([...unconditionalTargets, defaultEdge!.to]),
    prunedTargets: pruned,
    defaultTaken: true,
    predicateResults,
  };
};

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
 */
export const seedInitialActiveSet = (dag: DagDef): ReadonlySet<NodeId> => {
  const incoming = buildIncoming(dag);
  const outgoing = buildOutgoing(dag);

  const seeds: NodeId[] = [];
  for (const n of dag.nodes) {
    if ((incoming.get(n.id)?.length ?? 0) === 0) seeds.push(n.id);
  }

  const active = new Set<NodeId>(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const edges = outgoing.get(cur) ?? [];
    for (const e of edges) {
      if (!isUnconditionalEdge(e)) continue;
      if (!active.has(e.to)) {
        active.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return active;
};

/**
 * Expand `prev` to include `chosenTargets` and every node forward-reachable
 * from those targets along unconditional edges only. Idempotent.
 *
 * When `outgoing` is provided (from `DagMachineContext.outgoingByNode`), avoids
 * rebuilding the adjacency map. Falls back to `buildOutgoing(dag)` when the
 * caller doesn't have a precomputed map.
 */
export const expandActive = (
  dag: DagDef,
  prev: ReadonlySet<NodeId>,
  chosenTargets: Iterable<NodeId>,
  outgoing?: ReadonlyMap<NodeId, readonly EdgeDef[]>,
): ReadonlySet<NodeId> => {
  const adjacency = outgoing ?? buildOutgoing(dag);
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
    const edges = adjacency.get(cur) ?? [];
    for (const e of edges) {
      if (!isUnconditionalEdge(e)) continue;
      if (!next.has(e.to)) {
        next.add(e.to);
        stack.push(e.to);
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
