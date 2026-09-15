// Structural type for a node's incoming edge sources.
//
// Produced by `computeIncomingByNode` (dag-runtime/topology.ts) at compile
// time. Consumed by the shared `runNodeShared` to build per-node input.
// Lives in shared/ so it can be referenced from both executor/ and
// dag-runtime/ without forming a cycle.
//
// The arrays carry the branded `NodeId` (from the gate-validated `EdgeDef`
// endpoints, with `DAG_INPUT` admissible as the `NodeId` subtype `DagInputId`),
// so the validated-id invariant that `buildNodeInput` advertises as structural
// for its `nodeId` parameter is carried end-to-end instead of dropped at this
// boundary. Importing `types/ids.js` forms no cycle: types/ is a leaf module.

import type { NodeId } from "../types/ids.js";

export interface IncomingSources {
  readonly required: readonly NodeId[];
  readonly optional: readonly NodeId[];
}
