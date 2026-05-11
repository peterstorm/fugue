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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak: nodes are heterogeneous
export type NodesRecord = { readonly [id: string]: NodeDef<any, any, any> };

/** Extract the output type of a `NodeDef`, or `unknown` if it isn't one. */
export type OutputOf<N> = N extends NodeDef<unknown, infer O, unknown> ? O : unknown;

/** Map each node id in `Nodes` to its output type — feeds `EdgeDefInput`. */
export type OutputsByNodeId<Nodes extends NodesRecord> = {
  readonly [K in keyof Nodes & string]: OutputOf<Nodes[K]>;
};

/**
 * Mapped type that flags any record entry whose key disagrees with its
 * `node.id`. The factory helpers (`createTransformNode` etc.) preserve
 * the literal `id` via `<const Id>`, so `Nodes[K]["id"]` is a literal
 * string for any node built with a helper.
 *
 * The `string extends Nodes[K]["id"]` branch means "the id type is the
 * wide `string`, not a literal" — typically because the node was built
 * via a hand-rolled object literal or a custom helper that doesn't
 * preserve literal ids. In that case we can't compare at the type level,
 * so we accept the entry and let the runtime validator catch any
 * mismatch at module load.
 *
 * For literal ids, mismatches turn into a sentinel type that no real
 * `NodeDef` satisfies — the compiler reports the offending entry with a
 * descriptive message in its diagnostic.
 */
export type ConsistentNodes<Nodes extends NodesRecord> = {
  readonly [K in keyof Nodes]: string extends Nodes[K]["id"]
    ? Nodes[K]
    : Nodes[K] extends { readonly id: K }
      ? Nodes[K]
      : { readonly __error: `nodes['${K & string}'].id must equal '${K & string}'` };
};
