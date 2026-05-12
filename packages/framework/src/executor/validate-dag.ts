import type {
  DagDef,
  DagDefInput,
  DagDefShape,
  EdgeDef,
  EdgeDefRawInput,
} from "../types/dag.js";
import { brandAsDagDef, normalizeEdge } from "../types/dag.js";
import type { NodesRecord } from "../types/dag-internals.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";

const validationErr = (nodeId: string, message: string): FrameworkError => ({
  kind: "validation" as const,
  nodeId,
  message,
});

/**
 * Structural validation of a `DagDefInput`. On success, brands the input as
 * a runtime-shaped `DagDef` (nodes-as-array). The brand is the only path by
 * which `runDag` / `runDagStateful` accept a DAG, so calling this (or
 * `defineDag`) is the single, mandatory soundness gate.
 *
 * Topology rules (ADR 0015 + ADR 0017):
 *   - Edges are the single source of truth for wiring. `deps` /
 *     `optionalDeps` no longer exist on `NodeDef`; the runtime derives
 *     `{ required, optional }` per node at compile time.
 *   - Every node with at least one conditional out-edge MUST have exactly
 *     one `kind: "default"` out-edge (else-totality).
 *   - At most one edge per `(from, to)` pair.
 *   - Conditional `when` must be a non-empty plain object (structural
 *     predicate — see ADR 0016).
 *   - `outputNodeId` (when set) must be reachable along unconditional +
 *     default edges only — predicates may bypass nodes, never the output.
 *
 * Record/key invariant:
 *   - Every record key matches its node's `id`. This is the only discrepancy
 *     possible when authors construct nodes via factory helpers that take
 *     `id` explicitly.
 */
export const validateDagShape = (
  input: DagDefInput,
): Result<DagDef, FrameworkError> => {
  const entries = Object.entries(input.nodes) as [
    string,
    NodeDef<unknown, unknown, unknown>,
  ][];

  if (entries.length === 0) {
    return err(validationErr("__dag__", `DAG '${input.id}' has no nodes`));
  }

  // Record-key vs node.id consistency.
  for (const [key, node] of entries) {
    if (node.id !== key) {
      return err(
        validationErr(
          node.id,
          `nodes['${key}'] has id '${node.id}' — record key and node.id must match`,
        ),
      );
    }
  }

  const nodeIds = new Set(entries.map(([id]) => id));
  // Normalize edges into the tagged-discriminant runtime form. The input may
  // carry the implicit-unconditional or implicit-conditional (`when`-only)
  // shape per `EdgeDefRawInput`; downstream code reads exclusively from the
  // normalized array.
  const edges: readonly EdgeDef[] = (input.edges as readonly EdgeDefRawInput[])
    .map(normalizeEdge);

  // Edge endpoints reference known nodes (the literal-typed input guards
  // this at edit time, but defensive at runtime for `as DagDefInput` casts).
  for (const e of edges) {
    if (!nodeIds.has(e.from)) {
      return err(validationErr(e.from, `Edge references unknown source node '${e.from}'`));
    }
    if (!nodeIds.has(e.to)) {
      return err(validationErr(e.to, `Edge references unknown target node '${e.to}'`));
    }
  }

  // Edge uniqueness: at most one EdgeDef per (from, to) pair across all variants.
  const seenPairs = new Set<string>();
  for (const e of edges) {
    const key = `${e.from} ${e.to}`;
    if (seenPairs.has(key)) {
      return err({
        kind: "duplicate-edge",
        fromNodeId: e.from,
        toNodeId: e.to,
      });
    }
    seenPairs.add(key);
  }

  // Conditional edges must carry a non-empty, well-formed predicate. An empty
  // predicate `{}` matches every output and is almost always a bug — make it
  // an unconditional edge instead.
  for (const e of edges) {
    if (!isConditionalEdge(e)) continue;
    const pred = e.when;
    if (pred === null || typeof pred !== "object" || Array.isArray(pred)) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' has a malformed predicate — expected a plain object`,
        ),
      );
    }
    if (Object.keys(pred as Record<string, unknown>).length === 0) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' has an empty predicate '{}' — use an unconditional edge instead`,
        ),
      );
    }
  }

  // Else-totality: every node with any conditional out-edge must have exactly
  // one default out-edge.
  const outgoingByNode = new Map<string, EdgeDef[]>();
  for (const id of nodeIds) outgoingByNode.set(id, []);
  for (const e of edges) {
    const list = outgoingByNode.get(e.from);
    if (list) list.push(e);
  }
  for (const id of nodeIds) {
    const out = outgoingByNode.get(id) ?? [];
    const guarded = out.filter(isConditionalEdge);
    const defaults = out.filter(isDefaultEdge);
    if (guarded.length === 0) {
      if (defaults.length > 0) {
        return err(
          validationErr(
            id,
            `Node '${id}' has a default edge but no conditional out-edges — drop the default`,
          ),
        );
      }
      continue;
    }
    if (defaults.length !== 1) {
      return err({ kind: "missing-default-edge", nodeId: id });
    }
  }

  if (input.outputNodeId !== undefined && !nodeIds.has(input.outputNodeId)) {
    return err(
      validationErr(
        input.outputNodeId,
        `outputNodeId '${input.outputNodeId}' is not a node in DAG '${input.id}'`,
      ),
    );
  }

  if (input.outputNodeId !== undefined) {
    const incomingAny = new Map<string, EdgeDef[]>();
    for (const id of nodeIds) incomingAny.set(id, []);
    for (const e of edges) {
      const list = incomingAny.get(e.to);
      if (list) list.push(e);
    }
    const entryIds = [...nodeIds].filter(
      (id) => (incomingAny.get(id)?.length ?? 0) === 0,
    );

    const reachable = new Set<string>(entryIds);
    const stack = [...reachable];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const e of outgoingByNode.get(cur) ?? []) {
        if (isConditionalEdge(e)) continue;
        if (!reachable.has(e.to)) {
          reachable.add(e.to);
          stack.push(e.to);
        }
      }
    }

    if (!reachable.has(input.outputNodeId)) {
      return err({
        kind: "output-unreachable-under-routing",
        outputNodeId: input.outputNodeId,
        missedFromNode: input.outputNodeId,
      });
    }
  }

  // Construct the unbranded shape with full field-shape checking, then apply
  // the brand via the module-private `brandAsDagDef` helper. Typing the
  // intermediate as `DagDefShape` makes new required fields on DagDef a
  // compile error here, rather than a silent pass-through that would only
  // surface when something tried to read the missing field at runtime.
  const unbranded: DagDefShape = {
    id: input.id,
    nodes: entries.map(([, n]) => n),
    edges,
    ...(input.outputNodeId !== undefined ? { outputNodeId: input.outputNodeId } : {}),
    ...(input.evalJudges !== undefined ? { evalJudges: input.evalJudges } : {}),
    ...(input.retryLimits !== undefined
      ? { retryLimits: input.retryLimits as Readonly<Record<string, number>> }
      : {}),
    ...(input.defaultRetryLimit !== undefined
      ? { defaultRetryLimit: input.defaultRetryLimit }
      : {}),
  };
  return ok(brandAsDagDef(unbranded));
};

// Re-export so test helpers building array-shape inputs can convert.
export const recordFromNodeArray = (
  nodes: readonly NodeDef<unknown, unknown, unknown>[],
): NodesRecord => Object.fromEntries(nodes.map((n) => [n.id, n]));
