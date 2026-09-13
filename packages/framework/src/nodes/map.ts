// A map is one immutable outer node. The runtime owns child preparation and
// dispatch; author callbacks never receive root minting or durable-job authority.
import { z } from "zod";
import {
  authoredCollectGather,
  MAP_FAN_RESOURCE,
  type AuthoredCollectGather,
  type DagDef,
  type MapNodeDef,
} from "../types/dag.js";
import { type Result, ok } from "../types/result.js";
import { formatFrameworkError, type FrameworkError } from "../types/errors.js";
import { nodeId } from "../types/ids.js";
import { maxWidth, widthFrom, type WidthFrom } from "../types/map-width.js";
import { snapshotMappedChild } from "../shared/validate-dag.js";
import "../checkpoint/capability.js";

type ArrayField<I> = {
  readonly [Key in keyof I & string]-?: I[Key] extends readonly unknown[] ? Key : never;
}[keyof I & string];

type MapWidthField<I, Field extends string> =
  Field extends WidthFrom
    ? Field
    : string extends Field
      ? Field
      : Field extends ArrayField<I> ? Field : never;

interface MapExecutionConfig<I, ChildOut, WidthField extends string> {
  readonly id: string;
  /** Upstream value carrying the array named by widthFrom. */
  readonly inputSchema: z.ZodType<I>;
  /** A valid literal array key, a dynamic string, or a parsed WidthFrom proof. */
  readonly widthFrom: MapWidthField<I, WidthField>;
  /** Positive safe integer, enforced before any child work can be spent. */
  readonly maxWidth: number;
  /** A child DAG without nested maps, human gates or freshness extractors. */
  readonly child: DagDef;
  /** Adapts each fresh child DAG result or pre-adaptation fan completion before reduction. */
  readonly childOutputSchema: z.ZodType<ChildOut>;
}

export interface MapNodeConfig<
  I,
  ChildOut,
  O,
  WidthField extends string = string,
> extends MapExecutionConfig<I, ChildOut, WidthField> {
  readonly outputSchema: z.ZodType<O>;
  /** Ascending index order, including the legal empty fan. */
  readonly reduce: (results: readonly ChildOut[]) => Result<O, FrameworkError>;
}

/** Empty-object assignability distinguishes infinite string domains from finite literal keys. */
type IsInfiniteStringDomain<Field extends string> = {} extends Record<Field, never> ? true : false;

/** Ordinary Object.prototype names are never inherited; only the selected gather key is own. */
type ObjectPrototypeKey =
  | keyof Object
  | "__defineGetter__"
  | "__defineSetter__"
  | "__lookupGetter__"
  | "__lookupSetter__"
  | "__proto__";

type NullPrototypeMembers<Field extends string, Value> = Readonly<{
  readonly [Key in ObjectPrototypeKey]?: Key extends Field ? Value : undefined;
}>;

type CollectedFieldValue<ChildOut> = readonly ChildOut[];

export type CollectedMapOutput<Field extends string, ChildOut> =
  Field extends unknown
    ? (
        IsInfiniteStringDomain<Field> extends true
          ? Readonly<Record<Field, CollectedFieldValue<ChildOut> | undefined>>
          : Readonly<Record<Field, CollectedFieldValue<ChildOut>>>
      ) & NullPrototypeMembers<Field, CollectedFieldValue<ChildOut>>
    : never;

export interface CollectMapNodeConfig<
  I,
  ChildOut,
  Field extends string,
  WidthField extends string = string,
> extends MapExecutionConfig<I, ChildOut, WidthField> {
  /** Validates already-parsed ChildOut values in the gathered/root-checkpoint shape. */
  readonly collectedItemSchema: z.ZodType<NoInfer<ChildOut>, NoInfer<ChildOut>>;
  readonly gather: Readonly<{ readonly kind: "collect"; readonly field: Field }>;
}

/** A dictionary whose runtime lookup semantics match its string index signature. */
const collectedOutput = <Field extends string, ChildOut>(
  field: Field,
  results: readonly ChildOut[],
): CollectedMapOutput<Field, ChildOut> => {
  const output = Object.create(null) as Record<string, readonly ChildOut[] | undefined>;
  Object.defineProperty(output, field, {
    value: Object.freeze([...results]),
    enumerable: true,
  });
  return Object.freeze(output) as CollectedMapOutput<Field, ChildOut>;
};

const createCapturedMapNode = <I, ChildOut, O, WidthField extends string>(
  config: MapNodeConfig<I, ChildOut, O, WidthField>,
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
    sideEffects: Object.freeze({ kind: "writes", resource: MAP_FAN_RESOURCE }),
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
export const createMapNode = <I, ChildOut, O, const WidthField extends string>(
  config: MapNodeConfig<I, ChildOut, O, WidthField>,
): MapNodeDef<I, ChildOut, O> => createCapturedMapNode(config, undefined);

/**
 * Honest collect specialization: output schema, reducer, and describe metadata
 * are issued together, so callers cannot claim collect semantics for another reducer.
 */
export const createCollectMapNode = <
  I,
  ChildOut,
  const Field extends string,
  const WidthField extends string,
>(
  config: CollectMapNodeConfig<I, ChildOut, Field, WidthField>,
): MapNodeDef<I, ChildOut, CollectedMapOutput<Field, ChildOut>> => {
  const childOutputSchema = config.childOutputSchema;
  const collectedItemSchema = config.collectedItemSchema;
  const gatherField = config.gather.field;
  const field = widthFrom(gatherField);
  const outputSchema = z.object({
    [field]: z.array(collectedItemSchema),
  }).overwrite((value) =>
    // Zod widens a computed object key to a mutable string record; this
    // constructor still owns the required field and returns its narrower
    // immutable/null-prototype representation of the same parsed shape.
    collectedOutput(gatherField, value[field]!) as unknown as typeof value,
  ) as unknown as z.ZodType<CollectedMapOutput<Field, ChildOut>>;
  const reduce = (
    results: readonly ChildOut[],
  ): Result<CollectedMapOutput<Field, ChildOut>, FrameworkError> =>
    ok(collectedOutput(gatherField, results));

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
