// defineDag — the only sanctioned path from authored input to runtime DagDef.
//
// Calling defineDag at module load:
//   - validates structural soundness (edge endpoints reference known nodes,
//     else-totality, output reachability, edge uniqueness, predicate
//     well-formedness),
//   - throws DagDefinitionError on invalid input — the stack points at the
//     DAG file, surfacing the error at boot, not on the first request,
//   - brands the result so `runDag` / `runDagStateful` / `compileDagToMachine`
//     accept it. Hand-rolled object literals typed `DagDef` are type-rejected.
//
// Idiomatic shape: zod.parse / JSON.parse — throw on invalid static config.
//
// Two overloads:
//   - record shape (`Record<NodeId, NodeDef>`) gives literal-typed edges
//     and outputNodeId at edit time. Preferred for new code.
//   - array shape (`readonly NodeDef[]`) preserves legacy ergonomics; edges
//     stay `string`-typed at edit time, but module-load validation is the
//     same. Useful for tests and dynamic constructions.

import type {
  DagDef,
  DagDefInput,
  EdgeDefRawInput,
} from "../types/dag.js";
import type { NodesRecord } from "../types/dag-internals.js";
import type { Capability, NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import type { FrameworkError } from "../types/errors.js";
import { formatFrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { err } from "../types/result.js";
import { validateDagShape } from "./validate-dag.js";

export class DagDefinitionError extends Error {
  readonly dagId: string;
  readonly detail: FrameworkError;

  constructor(dagId: string, detail: FrameworkError) {
    super(`[defineDag] DAG '${dagId}' is unsound: ${formatFrameworkError(detail)}`);
    this.name = "DagDefinitionError";
    this.dagId = dagId;
    this.detail = detail;
  }
}

/**
 * Validate a DAG and return a branded `DagDef`. Throws `DagDefinitionError`
 * on invalid input.
 *
 * `<const Nodes>` infers the literal record so `edges[].from` / `edges[].to`
 * and `outputNodeId` are constrained to known node ids at edit time.
 */
/**
 * Both entry points fail the same way — a shape violation is an authoring
 * error, thrown rather than returned, because a malformed DAG has no valid
 * runtime. Sharing the unwrap keeps the two from drifting to different error
 * types or swallowing one of them.
 */
const orThrow = (id: string, result: ReturnType<typeof validateDagShape>): DagDef => {
  if (!result.ok) throw new DagDefinitionError(id, result.error);
  return result.value;
};

export const defineDag = <const Nodes extends NodesRecord>(
  input: DagDefInput<Nodes>,
): DagDef => {
  // Drop the literal-typed `Nodes` constraint at this single seam so
  // `validateDagShape` operates on the base type. Edit-time constraints from
  // `DagDefInput<Nodes>` were already enforced at the call site.
  return orThrow(input.id, validateDagShape(input as DagDefInput));
};

/**
 * First node id under which the array carries two DIFFERENT definitions.
 *
 * Re-listing the SAME node is legitimate and load-bearing: `defineRouter` names
 * one shared target from several cases, and collapsing those to one entry is
 * exactly right. Two different definitions under one id is the authoring error
 * — `Object.fromEntries` would keep only the last and drop the other in
 * silence.
 */
const firstCollidingNodeId = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the array-shape variance leak
  nodes: readonly NodeDef<any, any, any, readonly Capability[]>[],
): NodeId | undefined => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const seen = new Map<NodeId, NodeDef<any, any, any, readonly Capability[]>>();
  for (const node of nodes) {
    const existing = seen.get(node.id);
    if (existing !== undefined && existing !== node) return node.id;
    seen.set(node.id, node);
  }
  return undefined;
};

/**
 * Convenience for tests / dynamic constructions: convert an array of nodes
 * (variance-leaked via `any`) into a record keyed by `node.id`, then call
 * `defineDag`. Edge endpoints stay `string`-typed at edit time — use the
 * record overload directly when you want literal-typed edges.
 */
export const defineDagFromArray = (input: {
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance leak intentional
  readonly nodes: readonly NodeDef<any, any, any, readonly Capability[]>[];
  readonly edges: readonly EdgeDefRawInput[];
  readonly outputNodeId?: string;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
  /** Stamped by shape helpers (defineLinearDag, …); absent for raw array use. */
  readonly provenance?: DagDef["provenance"];
}): DagDef => {
  // An id collision is unrepresentable in the record shape but not in an array,
  // and `Object.fromEntries` would keep only the last definition and drop the
  // other with no diagnostic. This module promises the error "at boot, not on
  // the first request", so the collapse has to fail here, before it happens.
  const collidingId = firstCollidingNodeId(input.nodes);
  if (collidingId !== undefined) {
    return orThrow(input.id, err({
      kind: "validation",
      nodeId: collidingId,
      message:
        `DAG '${input.id}' declares two different nodes under id '${collidingId}'; ` +
        "node ids must identify one definition",
    }));
  }

  const nodesRecord: NodesRecord = Object.fromEntries(
    input.nodes.map((n) => [n.id, n]),
  );
  const result = validateDagShape({
    id: input.id,
    nodes: nodesRecord,
    edges: input.edges,
    outputNodeId: input.outputNodeId,
    evalJudges: input.evalJudges,
    retryLimits: input.retryLimits,
    defaultRetryLimit: input.defaultRetryLimit,
  }, input.provenance);
  return orThrow(input.id, result);
};
