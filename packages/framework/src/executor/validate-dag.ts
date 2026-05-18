import type {
  DagDef,
  DagDefInput,
  DagDefShape,
  EdgeDef,
  EdgeDefRawInput,
} from "../types/dag.js";
import { brandAsDagDef } from "../types/dag.js";
import type { NodesRecord } from "../types/dag-internals.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";
import type { NodeDef } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId, DagId } from "../types/ids.js";
import { __brandNodeId, __brandDagId } from "../types/ids.js";
import { type Result, ok, err } from "../types/result.js";

/**
 * Normalize a raw input edge into the tagged-discriminant `EdgeDef`. Private
 * to this module — only called after `validateDagShape` has confirmed that
 * `from`/`to` reference known node IDs.
 */
const normalizeEdge = (e: EdgeDefRawInput): EdgeDef => {
  if ("kind" in e && e.kind === "default") {
    return { from: __brandNodeId(e.from), to: __brandNodeId(e.to), kind: "default" };
  }
  if ("when" in e) {
    return {
      from: __brandNodeId(e.from),
      to: __brandNodeId(e.to),
      kind: "conditional",
      when: e.when,
    };
  }
  return { from: __brandNodeId(e.from), to: __brandNodeId(e.to), kind: "unconditional" };
};

const validationErr = (nodeId: NodeId, message: string): FrameworkError => ({
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
 *   - Conditional `when` must be a well-formed function-based predicate
 *     with `{ label, version, check, minConfidence? }`.
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
    NodeDef<unknown, unknown>,
  ][];

  if (entries.length === 0) {
    return err(validationErr(__brandNodeId("__dag__"), `DAG '${input.id}' has no nodes`));
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

  const nodeIds = new Set(entries.map(([id]) => __brandNodeId(id)));
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

  // Conditional edges must carry a well-formed function-based predicate with
  // a non-empty `label` and a `check` function.
  for (const e of edges) {
    if (!isConditionalEdge(e)) continue;
    const pred = e.when;
    if (pred === null || typeof pred !== "object" || Array.isArray(pred)) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' has a malformed predicate — expected an object with { label, check }`,
        ),
      );
    }
    const p = pred as { label?: unknown; check?: unknown; version?: unknown; minConfidence?: unknown };
    if (typeof p.label !== "string" || p.label.length === 0) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' predicate is missing a non-empty 'label'`,
        ),
      );
    }
    if (typeof p.version !== "number" || !Number.isInteger(p.version) || p.version < 0) {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' predicate is missing a valid 'version' (non-negative integer)`,
        ),
      );
    }
    if (typeof p.check !== "function") {
      return err(
        validationErr(
          e.from,
          `Edge '${e.from}' -> '${e.to}' predicate is missing a 'check' function`,
        ),
      );
    }
    if (p.minConfidence !== undefined) {
      const validBuckets = ["high", "medium", "low", "unknown"];
      if (!validBuckets.includes(p.minConfidence as string)) {
        return err({
          kind: "predicate-malformed",
          nodeId: e.from,
          message: `Edge '${e.from}' -> '${e.to}' predicate has invalid minConfidence '${String(p.minConfidence)}' — must be one of: ${validBuckets.join(", ")}`,
        });
      }
    }
  }

  // Else-totality: every node with any conditional out-edge must have exactly
  // one default out-edge.
  const outgoingByNode = new Map<NodeId, EdgeDef[]>();
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

  if (input.outputNodeId !== undefined && !nodeIds.has(__brandNodeId(input.outputNodeId))) {
    return err(
      validationErr(
        __brandNodeId(input.outputNodeId),
        `outputNodeId '${input.outputNodeId}' is not a node in DAG '${input.id}'`,
      ),
    );
  }

  // Freshness extractor consistency: writes nodes that declare extractNewWitness
  // must also have extractConditionedOn (partial config is a bug). Reads nodes
  // without extractWitness simply opt out of freshness tracking (valid for
  // non-freshness-participating fetch nodes).
  for (const [, node] of entries) {
    if (
      node.sideEffects.kind === "writes" &&
      node.sideEffects.extractNewWitness &&
      !node.sideEffects.extractConditionedOn
    ) {
      return err(
        validationErr(
          node.id,
          `Node '${node.id}' declares extractNewWitness but is missing extractConditionedOn`,
        ),
      );
    }
    if (
      node.sideEffects.kind === "writes" &&
      node.sideEffects.extractConditionedOn &&
      !node.sideEffects.extractNewWitness
    ) {
      return err(
        validationErr(
          node.id,
          `Node '${node.id}' declares extractConditionedOn but is missing extractNewWitness`,
        ),
      );
    }
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

    const reachable = new Set<NodeId>(entryIds);
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

    if (!reachable.has(__brandNodeId(input.outputNodeId))) {
      // Walk backward from the output along unconditional + default edges to
      // find the first node that has no unconditional/default inbound. That
      // node is the actual frontier — the place where routing diverged from
      // the output. Reporting the output node itself (the prior behaviour)
      // sent every consumer chasing the symptom rather than the cause.
      const incomingNonConditional = new Map<string, EdgeDef[]>();
      for (const id of nodeIds) incomingNonConditional.set(id, []);
      for (const e of edges) {
        if (isConditionalEdge(e)) continue;
        const list = incomingNonConditional.get(e.to);
        if (list) list.push(e);
      }
      const visited = new Set<string>();
      const queue: string[] = [input.outputNodeId];
      let frontier: string = input.outputNodeId;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const ins = incomingNonConditional.get(cur) ?? [];
        if (ins.length === 0) {
          frontier = cur;
          break;
        }
        for (const e of ins) {
          if (!visited.has(e.from)) queue.push(e.from);
        }
      }
      return err({
        kind: "output-unreachable-under-routing",
        outputNodeId: __brandNodeId(input.outputNodeId),
        missedFromNode: __brandNodeId(frontier),
      });
    }
  }

  // Construct the unbranded shape with full field-shape checking, then apply
  // the brand via the module-private `brandAsDagDef` helper. Typing the
  // intermediate as `DagDefShape` makes new required fields on DagDef a
  // compile error here, rather than a silent pass-through that would only
  // surface when something tried to read the missing field at runtime.
  const unbranded: DagDefShape = {
    id: __brandDagId(input.id),
    nodes: entries.map(([, n]) => n),
    edges,
    ...(input.outputNodeId !== undefined ? { outputNodeId: __brandNodeId(input.outputNodeId) } : {}),
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
  nodes: readonly NodeDef<unknown, unknown>[],
): NodesRecord => Object.fromEntries(nodes.map((n) => [n.id, n]));
