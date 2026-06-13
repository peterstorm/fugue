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
import type { NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import { DagDefinitionError, defineDagFromArray } from "./define-dag.js";
import { nodeId, DAG_INPUT } from "../types/ids.js";
import { zodToJsonSchema } from "../llm/zod-schema.js";
import type { NonEmptyNodeList } from "./define-fan-out.js";

export interface SourcesDagConfig {
  readonly id: string;
  /** Parallel root source nodes (built with `createSourceNode`). */
  readonly sources: NonEmptyNodeList;
  /** Fan-in node keyed by the source node ids. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly join: NodeDef<any, any, any>;
  /** Optional second-stage fan-in over the join. When present, it is the output node. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly assemble?: NodeDef<any, any, any>;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly defaultRetryLimit?: number;
  readonly retryLimits?: Readonly<Record<string, number>>;
}

/**
 * Whether a node's `inputSchema` is an object schema declaring a `"$input"`
 * property — the signal that the node wants the DAG request as a fan-in slot.
 * Non-object schemas (`z.unknown()`, unions, …) return `false`: a node that
 * consumes the request as its *sole* input belongs in a single-edge shape
 * helper, not as a `defineSources` fan-in.
 */
const declaresInputKey = (schema: unknown): boolean => {
  if (
    schema === null ||
    typeof schema !== "object" ||
    typeof (schema as { parse?: unknown }).parse !== "function"
  ) {
    return false;
  }
  let json: Record<string, unknown>;
  try {
    json = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0]);
  } catch {
    return false;
  }
  if (json.type !== "object") return false;
  const props = json.properties;
  if (props === null || typeof props !== "object") return false;
  return Object.prototype.hasOwnProperty.call(props, DAG_INPUT as string);
};

/**
 * Define a multi-source DAG: N parallel source roots → keyed fan-in join →
 * optional assemble.
 *
 * ```ts
 * const dag = defineSources({
 *   id: "lead-scoring",
 *   sources: [fetchWeights, fetchBrancheliste, fetchGamleKunder],
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
  const requestEdges: { from: string; to: string }[] = [];
  if (declaresInputKey(config.join.inputSchema)) {
    requestEdges.push({ from: DAG_INPUT as string, to: joinId });
  }
  if (assembleNode && declaresInputKey(assembleNode.inputSchema)) {
    requestEdges.push({ from: DAG_INPUT as string, to: assembleNode.id as string });
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
