// defineSources — the multi-root constructor (C1). The most common real
// topology: N parallel sources fanning into a keyed join.
//
//   source[0] ─┐
//   source[1] ─┤
//   ...        ├─→ join ─(→ assemble)
//   source[N] ─┘
//
//   - `sources`: N parallel root **source nodes** (built with
//     `createSourceNode`). They run concurrently in wave 0 and feed the join.
//   - `join`: a fan-in node receiving an object keyed by the source node ids.
//     Its `inputSchema` keys must equal that set (`fugue lint` checks this).
//   - `assemble` (optional): a second-stage fan-in over the join. Output node.
//
// The request reaches `join`/`assemble` ONLY if that node declares a `"$input"`
// key in its (object) `inputSchema`: then `defineSources` wires a
// `{ from: DAG_INPUT, to: <node> }` edge and the request arrives in the
// `"$input"` slot of the fan-in. No `request:` option, no pass-through root.
//
// Sugar over `defineDagFromArray`: same module-load validation, same brand.

import type { DagDef } from "../types/dag.js";
import type { Capability, NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import { DagDefinitionError, defineDagFromArray } from "./define-dag.js";
import { nodeId, DAG_INPUT } from "../types/ids.js";
import { objectSchemaKeys, objectSchemaRequiredKeys } from "../llm/zod-schema.js";
import { fanInKeyCheck, describeFanInKeyMismatch } from "./fan-in-keys.js";
import type { NonEmptyNodeList } from "./define-fan-out.js";

export interface SourcesDagConfig {
  readonly id: string;
  /** Parallel root source nodes (built with `createSourceNode`). */
  readonly sources: NonEmptyNodeList;
  /** Fan-in node keyed by the source node ids. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional: `run`'s contravariant input rejects NodeDef<unknown> for concrete-input nodes
  readonly join: NodeDef<any, any, any, readonly Capability[]>;
  /** Optional second-stage fan-in over the join. When present, it is the output node. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional: see `join`
  readonly assemble?: NodeDef<any, any, any, readonly Capability[]>;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly defaultRetryLimit?: number;
  readonly retryLimits?: Readonly<Record<string, number>>;
}

/**
 * Whether a node's `inputSchema` is an object schema declaring a `"$input"`
 * property — the signal that the node wants the DAG request as a fan-in slot.
 * Non-object schemas (`z.unknown()`, unions, …) return `false`: a node that
 * consumes the request as its *sole* input belongs in a single-edge shape
 * helper, not as a `defineSources` fan-in. Shares `objectSchemaKeys` with the
 * `fugue lint` B1 check so the two never drift.
 */
const declaresInputKey = (schema: unknown): boolean =>
  objectSchemaKeys(schema)?.includes(DAG_INPUT as string) ?? false;

/**
 * Reject a node that declares `"$input"` as an *optional* key. The DAG request
 * is always delivered over the wired `DAG_INPUT` edge, so an optional `$input`
 * slot has no defined meaning — the framework would force it present anyway. Fail
 * at definition time with a clear message rather than silently treating it as
 * required. A schema the framework can't introspect (`null`) is left to the
 * runtime, matching the rest of `defineSources`' unverifiable bias.
 */
const assertInputKeyRequired = (
  dagId: string,
  fanInId: string,
  schema: unknown,
): void => {
  const required = objectSchemaRequiredKeys(schema);
  if (required === null) return; // unverifiable — leave to the runtime Zod parse
  if (required.includes(DAG_INPUT as string)) return;
  throw new DagDefinitionError(dagId, {
    kind: "validation",
    nodeId: nodeId(fanInId),
    message:
      `Fan-in node '${fanInId}' declares "$input" as an optional key — the DAG request is ` +
      `always delivered, so "$input" must be a required property. Drop the .optional()/.nullish() ` +
      `on the "$input" field of its inputSchema.`,
  });
};

/**
 * Reject a fan-in node whose object-schema keys don't equal the set of ids
 * feeding it — at definition time, not deferred to `fugue lint`. The runtime
 * builds a keyed object only for ≥2 incoming sources, so single-source nodes are
 * skipped (their input is the bare upstream value, no keys to match). A schema
 * the framework can't introspect (`unverifiable`) is left for the runtime Zod
 * parse rather than rejected here.
 */
const assertFanInKeys = (
  dagId: string,
  fanInId: string,
  schema: unknown,
  incomingIds: readonly string[],
): void => {
  if (incomingIds.length < 2) return;
  const check = fanInKeyCheck(schema, incomingIds);
  if (check.kind !== "mismatch") return;
  throw new DagDefinitionError(dagId, {
    kind: "validation",
    nodeId: nodeId(fanInId),
    message: describeFanInKeyMismatch(fanInId, incomingIds, check),
  });
};

/**
 * Define a multi-source DAG: N parallel source roots → keyed fan-in join →
 * optional assemble.
 *
 * ```ts
 * const dag = defineSources({
 *   id: "lead-scoring",
 *   sources: [fetchWeights, fetchBranches, fetchPastCustomers],
 *   join: scoreLeads,      // inputSchema keyed by the three source ids
 *   assemble: assembleLeads, // inputSchema: { "score-leads": …, "$input": Request }
 * });
 * ```
 *
 * `assemble` here consumes the request because its schema declares `"$input"`;
 * `defineSources` adds the `{ from: DAG_INPUT, to: "assemble-leads" }` edge.
 */
export const defineSources = (config: SourcesDagConfig): DagDef => {
  if (config.sources.length === 0) {
    throw new DagDefinitionError(config.id, {
      kind: "validation",
      nodeId: nodeId(config.id),
      message: "defineSources requires at least one source",
    });
  }

  // Friendly upfront error: sources MUST be source nodes (no incoming edges,
  // no input). Otherwise they would land as input-expecting roots and fail
  // later with the more cryptic `root-expects-input`.
  for (const s of config.sources) {
    if (s.isSource !== true) {
      throw new DagDefinitionError(config.id, {
        kind: "root-expects-input",
        nodeId: nodeId(s.id as string),
        message:
          `defineSources source '${s.id as string}' is not a source node — build it with ` +
          `createSourceNode so its fetch is (ctx) => …. A source consumes no DAG input`,
      });
    }
  }

  const joinId = config.join.id as string;
  const sourceIds = config.sources.map((s) => s.id as string);

  // source → join
  const sourceEdges = config.sources.map((s) => ({
    from: s.id as string,
    to: joinId,
  }));

  // join → assemble (if present)
  const assembleNode = config.assemble;
  const joinToAssemble = assembleNode
    ? [{ from: joinId, to: assembleNode.id as string }]
    : [];

  // $input → {join, assemble} when (and only when) that node declares "$input".
  // A declared "$input" must be required — reject the optional form up front.
  const joinWantsInput = declaresInputKey(config.join.inputSchema);
  if (joinWantsInput) assertInputKeyRequired(config.id, joinId, config.join.inputSchema);
  const assembleWantsInput =
    assembleNode !== undefined && declaresInputKey(assembleNode.inputSchema);
  if (assembleNode && assembleWantsInput) {
    assertInputKeyRequired(config.id, assembleNode.id as string, assembleNode.inputSchema);
  }
  const requestEdges: { from: string; to: string }[] = [];
  if (joinWantsInput) {
    requestEdges.push({ from: DAG_INPUT as string, to: joinId });
  }
  if (assembleNode && assembleWantsInput) {
    requestEdges.push({ from: DAG_INPUT as string, to: assembleNode.id as string });
  }

  // Definition-time fan-in key validation. The join receives an object keyed by
  // its incoming ids (source ids, plus "$input" when the request edge is wired);
  // assemble receives the join (plus "$input" when wired). Catch a key/source
  // mismatch here instead of leaving it for `fugue lint` or a runtime parse.
  assertFanInKeys(config.id, joinId, config.join.inputSchema, [
    ...sourceIds,
    ...(joinWantsInput ? [DAG_INPUT as string] : []),
  ]);
  if (assembleNode) {
    assertFanInKeys(config.id, assembleNode.id as string, assembleNode.inputSchema, [
      joinId,
      ...(assembleWantsInput ? [DAG_INPUT as string] : []),
    ]);
  }

  const nodes = assembleNode
    ? [...config.sources, config.join, assembleNode]
    : [...config.sources, config.join];

  const outputNodeId = (assembleNode ?? config.join).id as string;

  return defineDagFromArray({
    id: config.id,
    nodes,
    edges: [...sourceEdges, ...joinToAssemble, ...requestEdges],
    outputNodeId,
    evalJudges: config.evalJudges,
    defaultRetryLimit: config.defaultRetryLimit,
    retryLimits: config.retryLimits,
    provenance: "sources",
  });
};
