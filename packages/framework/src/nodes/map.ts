// A map is one immutable outer node. The runtime owns child preparation and
// dispatch; author callbacks never receive root minting or durable-job authority.
import { z } from "zod";
import {
  authoredCollectGather,
  type AuthoredCollectGather,
  type DagDef,
  type MapNodeDef,
} from "../types/dag.js";
import { type Result, ok } from "../types/result.js";
import { formatFrameworkError, type FrameworkError } from "../types/errors.js";
import { nodeId } from "../types/ids.js";
import { resourceName } from "../types/witness.js";
import { maxWidth, widthFrom } from "../types/map-width.js";
import { snapshotMappedChild } from "../shared/validate-dag.js";
import "../checkpoint/capability.js";

interface MapExecutionConfig<I, ChildOut> {
  readonly id: string;
  /** Upstream value carrying the array named by widthFrom. */
  readonly inputSchema: z.ZodType<I>;
  /** One field reference, not a path or an expression. */
  readonly widthFrom: string;
  /** Positive safe integer, enforced before any child work can be spent. */
  readonly maxWidth: number;
  /** A child DAG without nested maps, human gates or freshness extractors. */
  readonly child: DagDef;
  /** Applied to fresh AND replayed child outputs before reduction. */
  readonly childOutputSchema: z.ZodType<ChildOut>;
}

export interface MapNodeConfig<I, ChildOut, O> extends MapExecutionConfig<I, ChildOut> {
  readonly outputSchema: z.ZodType<O>;
  /** Ascending index order, including the legal empty fan. */
  readonly reduce: (results: readonly ChildOut[]) => Result<O, FrameworkError>;
}

/** Empty-object assignability distinguishes infinite string domains from finite literal keys. */
type IsInfiniteStringDomain<Field extends string> = {} extends Record<Field, never> ? true : false;

export type CollectedMapOutput<Field extends string, ChildOut> =
  Field extends unknown
    ? IsInfiniteStringDomain<Field> extends true
      ? Readonly<Record<Field, readonly ChildOut[] | undefined>>
      : Readonly<Record<Field, readonly ChildOut[]>>
    : never;

export interface CollectMapNodeConfig<I, ChildOut, Field extends string>
  extends MapExecutionConfig<I, ChildOut> {
  readonly gather: Readonly<{ readonly kind: "collect"; readonly field: Field }>;
}

const createCapturedMapNode = <I, ChildOut, O>(
  config: MapNodeConfig<I, ChildOut, O>,
  gather: AuthoredCollectGather | undefined,
): MapNodeDef<I, ChildOut, O> => {
  const id = nodeId(config.id);
  const from = widthFrom(config.widthFrom);
  const max = maxWidth(config.maxWidth);
  const child = snapshotMappedChild(id, config.child);
  if (!child.ok) throw new Error(formatFrameworkError(child.error));
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
      ...(gather !== undefined ? { authoredGather: gather } : {}),
      reduce: config.reduce,
    }),
  });
};

/**
 * Capture references once. Later property reassignment cannot replace them;
 * opaque schema implementations and reducer closure state are not cloned.
 */
export const createMapNode = <I, ChildOut, O>(
  config: MapNodeConfig<I, ChildOut, O>,
): MapNodeDef<I, ChildOut, O> => createCapturedMapNode(config, undefined);

/**
 * Honest collect specialization: output schema, reducer, and describe metadata
 * are issued together, so callers cannot claim collect semantics for another reducer.
 */
export const createCollectMapNode = <I, ChildOut, const Field extends string>(
  config: CollectMapNodeConfig<I, ChildOut, Field>,
): MapNodeDef<I, ChildOut, CollectedMapOutput<Field, ChildOut>> => {
  const childOutputSchema = config.childOutputSchema;
  const field = widthFrom(config.gather.field);
  const outputSchema = z.object({
    [field]: z.array(childOutputSchema),
  }) as unknown as z.ZodType<CollectedMapOutput<Field, ChildOut>>;
  const reduce = (
    results: readonly ChildOut[],
  ): Result<CollectedMapOutput<Field, ChildOut>, FrameworkError> =>
    ok(Object.freeze({ [field]: Object.freeze([...results]) }) as CollectedMapOutput<Field, ChildOut>);

  return createCapturedMapNode(
    {
      id: config.id,
      inputSchema: config.inputSchema,
      outputSchema,
      widthFrom: config.widthFrom,
      maxWidth: config.maxWidth,
      child: config.child,
      childOutputSchema,
      reduce,
    },
    authoredCollectGather(field, {
      outputSchema,
      childOutputSchema,
      reduce,
    }),
  );
};
