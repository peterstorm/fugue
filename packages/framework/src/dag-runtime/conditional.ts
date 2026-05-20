// conditional.ts — backward-compatibility re-export shim.
//
// The original contents have been split into:
//   - topology.ts: graph algorithms (adjacency, reachability, incoming sources)
//   - routing.ts: business-rule evaluation (predicate evaluation, route decisions)
//
// This file re-exports everything so existing direct imports from
// `./conditional.js` continue to resolve without changes. New code should
// import from `./topology.js` or `./routing.js` directly.

export type { IncomingSources } from "./topology.js";
export {
  seedInitialActiveSet,
  expandActive,
  outgoingOf,
  computeOutgoingByNode,
  computeUnconditionalAdj,
  computeIncomingByNode,
  incomingSources,
} from "./topology.js";

export type { Decision } from "./routing.js";
export {
  evaluatePredicate,
  decideRoute,
} from "./routing.js";
