// Structural type for a node's incoming edge sources.
//
// Produced by `computeIncomingByNode` (dag-runtime/conditional.ts) at compile
// time. Consumed by the shared `runNodeShared` to build per-node input.
// Lives in shared/ so it can be referenced from both executor/ and
// dag-runtime/ without forming a cycle.

export interface IncomingSources {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}
