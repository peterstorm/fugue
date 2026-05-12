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
import type { NodeDef } from "../types/node.js";
import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js";
import type { FrameworkError } from "../types/errors.js";
import { validateDagShape } from "./validate-dag.js";

export class DagDefinitionError extends Error {
  readonly dagId: string;
  readonly detail: FrameworkError;

  constructor(dagId: string, detail: FrameworkError) {
    super(`[defineDag] DAG '${dagId}' is unsound: ${formatDetail(detail)}`);
    this.name = "DagDefinitionError";
    this.dagId = dagId;
    this.detail = detail;
  }
}

const formatDetail = (e: FrameworkError): string => {
  switch (e.kind) {
    case "validation":
      return `${e.message} (node '${e.nodeId}')`;
    case "missing-default-edge":
      return `node '${e.nodeId}' has conditional out-edges but no default edge`;
    case "output-unreachable-under-routing":
      return `outputNodeId '${e.outputNodeId}' is not reachable along unconditional + default edges (frontier at '${e.missedFromNode}')`;
    case "duplicate-edge":
      return `duplicate edge '${e.fromNodeId}' -> '${e.toNodeId}'`;
    case "predicate-malformed":
      return `${e.message} (node '${e.nodeId}')`;
    case "cycle-detected":
      return `cycle detected: ${e.nodeIds.join(" -> ")}`;
    case "retry-exhausted":
    case "checkpoint-missing":
    case "checkpoint-expired":
    case "checkpoint-corrupt":
    case "checkpoint-version-mismatch":
    case "checkpoint-write-failed":
    case "prompt-not-found":
    case "cache-error":
    case "node-crash":
    case "aborted":
    case "rejected":
    case "invalid-reroute":
    case "transient":
    case "missing-capability":
      return JSON.stringify(e);
    default: {
      // Exhaustive guard — adding a new `FrameworkError.kind` without
      // handling it here (or routing it through the catch-all list above)
      // surfaces as a compile error at this assignment. Runtime fallback
      // keeps callers from crashing on a malformed message.
      const _exhaustive: never = e;
      return `unhandled error kind: ${JSON.stringify(_exhaustive)}`;
    }
  }
};

/**
 * Validate a DAG and return a branded `DagDef`. Throws `DagDefinitionError`
 * on invalid input.
 *
 * `<const Nodes>` infers the literal record so `edges[].from` / `edges[].to`
 * and `outputNodeId` are constrained to known node ids at edit time.
 */
export const defineDag = <const Nodes extends NodesRecord>(
  input: DagDefInput<Nodes>,
): DagDef => {
  // Drop the literal-typed `Nodes` constraint at this single seam so
  // `validateDagShape` operates on the base type. Edit-time constraints from
  // `DagDefInput<Nodes>` were already enforced at the call site.
  const result = validateDagShape(input as DagDefInput);
  if (!result.ok) {
    throw new DagDefinitionError(input.id, result.error);
  }
  return result.value;
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
  readonly nodes: readonly NodeDef<any, any, any>[];
  readonly edges: readonly EdgeDefRawInput[];
  readonly outputNodeId?: string;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
}): DagDef => {
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
  });
  if (!result.ok) {
    throw new DagDefinitionError(input.id, result.error);
  }
  return result.value;
};
