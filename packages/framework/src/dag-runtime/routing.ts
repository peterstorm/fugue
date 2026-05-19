// Routing decision logic — predicate evaluation with confidence gating.
// All functions are pure; no I/O.
//
// Extracted from conditional.ts for separation of concerns:
// - topology.ts: static graph analysis (adjacency, reachability, incoming sources)
// - routing.ts: business-rule evaluation (predicate evaluation, route decisions)

import type { EdgeDef, Predicate, PredicateResult } from "../types/dag.js";
import {
  isConditionalEdge,
  isDefaultEdge,
  isUnconditionalEdge,
} from "../types/dag.js";
import type { NodeId } from "../types/ids.js";
import type { Confidence } from "../types/confidence.js";
import { meetsConfidence } from "../types/confidence.js";
import type { RouteEvidence } from "../types/events.js";

// ---------------------------------------------------------------------------
// evaluatePredicate — predicate evaluation with confidence gating.
// Moved here from types/dag.ts (which re-exports for backward compatibility)
// because it contains business logic that belongs in the runtime layer.
// ---------------------------------------------------------------------------

/**
 * Evaluate a predicate against a node's output with confidence gating.
 *
 * Returns a discriminated `PredicateResult`. The `outcome: "threw"` variant
 * signals a predicate implementation bug — the caller should surface a
 * `predicate-malformed` error instead of silently taking the default edge.
 */
export const evaluatePredicate = <T>(
  pred: Predicate<T>,
  output: T,
  confidence: Confidence | null,
): PredicateResult => {
  // Gate on minConfidence before calling check
  if (pred.minConfidence !== undefined) {
    if (confidence === null || !meetsConfidence(confidence.bucket, pred.minConfidence)) {
      return {
        predicateLabel: pred.label,
        predicateVersion: pred.version,
        evaluatedConfidence: confidence,
        outcome: "below-min-confidence",
      };
    }
  }

  try {
    const matched = pred.check(output, confidence);
    return {
      predicateLabel: pred.label,
      predicateVersion: pred.version,
      evaluatedConfidence: confidence,
      outcome: matched ? "matched" : "not-matched",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      predicateLabel: pred.label,
      predicateVersion: pred.version,
      evaluatedConfidence: confidence,
      outcome: "threw",
      message: msg,
    };
  }
};

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

    if (result.outcome === "matched" && matchedEdge === null) {
      matchedEdge = e;
      // Continue evaluating remaining predicates for evidence completeness
    }
  }

  // A predicate that throws is a programming error — surface as malformed
  // rather than silently falling to the default edge.
  const threwResult = predicateResults.find(r => r.outcome === "threw");
  if (threwResult && threwResult.outcome === "threw") {
    return {
      kind: "predicate-malformed",
      fromNodeId,
      message: `Predicate '${threwResult.predicateLabel}' threw an exception: ${threwResult.message}`,
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
