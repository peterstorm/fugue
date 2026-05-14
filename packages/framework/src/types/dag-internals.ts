// Internal DagDefInput inference machinery.
//
// These types are implementation details of how `defineDag<const Nodes>` infers
// literal-typed edges and outputNodeId. They are referenced by `DagDefInput` /
// `EdgeDefInput` constraints but are NOT part of the public surface — every
// generic shape parameter is hidden from autocomplete by living here rather
// than in `types/dag.ts` and never being re-exported from `types/index.ts`.
//
// Tests and consumers that genuinely need them can import directly from this
// file; that opt-in stays available without polluting the package barrel.

import type { NodeDef } from "./node.js";
import type { NodeId } from "./ids.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak: nodes are heterogeneous
export type NodesRecord = { readonly [id: string]: NodeDef<any, any, any> };

/** Extract the output type of a `NodeDef`, or `unknown` if it isn't one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak: nodes are heterogeneous
export type OutputOf<N> = N extends NodeDef<unknown, infer O, any> ? O : unknown;

/** Map each node id in `Nodes` to its output type — feeds `EdgeDefInput`. */
export type OutputsByNodeId<Nodes extends NodesRecord> = {
  readonly [K in keyof Nodes & string]: OutputOf<Nodes[K]>;
};

/**
 * Mapped type that validates record-key/node-id consistency.
 *
 * With branded `NodeId`, literal narrowing is no longer possible at the type
 * level — `NodeDef.id` is always `NodeId`, never a string literal. The runtime
 * validator in `validateDagShape` still catches key/id mismatches at module
 * load. This type now accepts any entry whose `id` extends `NodeId` (which is
 * always true for well-typed `NodeDef`). The compile-time guard is retained
 * for edge cases where a hand-rolled node has `id: string` instead of `NodeId`.
 */
export type ConsistentNodes<Nodes extends NodesRecord> = {
  readonly [K in keyof Nodes]: Nodes[K]["id"] extends NodeId
    ? Nodes[K]
    : string extends Nodes[K]["id"]
      ? Nodes[K]
      : Nodes[K] extends { readonly id: K }
        ? Nodes[K]
        : { readonly __error: `nodes['${K & string}'].id must equal '${K & string}'` };
};
