// A map is one immutable outer node. The runtime owns child preparation and
// dispatch; author callbacks never receive root minting or durable-job authority.
import type { z } from "zod";
import type { DagDef, MapNodeDef } from "../types/dag.js";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { nodeId } from "../types/ids.js";
import { resourceName } from "../types/witness.js";
import { maxWidth, widthFrom } from "../types/map-width.js";
import { snapshotMappedChild } from "../shared/validate-dag.js";
import "../checkpoint/capability.js";

export interface MapNodeConfig<I, ChildOut, O> {
  readonly id: string;
  /** Upstream value carrying the array named by widthFrom. */
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  /** One field reference, not a path or an expression. */
  readonly widthFrom: string;
  /** Positive safe integer, enforced before any child work can be spent. */
  readonly maxWidth: number;
  /** A child DAG without nested maps, human gates or freshness extractors. */
  readonly child: DagDef;
  /** Applied to fresh AND replayed child outputs before reduction. */
  readonly childOutputSchema: z.ZodType<ChildOut>;
  /** Metadata for a reducer generated from the closed authored collect gather. */
  readonly authoredGather?: Readonly<{ readonly kind: "collect"; readonly field: string }>;
  /** Ascending index order, including the legal empty fan. */
  readonly reduce: (results: readonly ChildOut[]) => Result<O, FrameworkError>;
}

/** Capture author configuration once; later aliases cannot change execution. */
export const createMapNode = <I, ChildOut, O>(
  config: MapNodeConfig<I, ChildOut, O>,
): MapNodeDef<I, ChildOut, O> => {
  const id = nodeId(config.id);
  const from = widthFrom(config.widthFrom);
  const max = maxWidth(config.maxWidth);
  const child = snapshotMappedChild(id, config.child);
  if (!child.ok) throw new Error(child.error.kind === "validation" ? child.error.message : `invalid mapped child for '${id}'`);
  return Object.freeze({
    id,
    kind: "map",
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    requires: Object.freeze(["checkpointer"] as const),
    sideEffects: Object.freeze({ kind: "writes", resource: resourceName("checkpoint:fan") }),
    confidence: Object.freeze({ mode: "none" }),
    mapping: Object.freeze({
      child: child.value,
      childOutputSchema: config.childOutputSchema,
      widthFrom: from,
      maxWidth: max,
      ...(config.authoredGather !== undefined
        ? { authoredGather: Object.freeze({ ...config.authoredGather }) }
        : {}),
      reduce: config.reduce,
    }),
  });
};
