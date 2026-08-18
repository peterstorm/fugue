// Structural lint checks that run *after* `defineDag` accepted a DAG — they
// catch authoring mistakes the topology validator deliberately doesn't (it
// can't see into Zod schemas, and advisories aren't its job). Pure functions
// over a branded `DagDef`; surfaced by `runLint` in its JSON output.
//
//   B1 (error)    fan-in-key-mismatch — a fan-in node's object-schema keys must
//                 equal the set of incoming node ids, or the runtime-built
//                 keyed input won't match the schema.
//   B2 (advisory) redundant-passthrough — a transform whose sole input is
//                 `DAG_INPUT` and whose input/output schemas are identical (the
//                 legacy request-carrier idiom); delete it and wire the consumer
//                 directly with a `DAG_INPUT` edge.
//   B3 (advisory) shape-helper-hint — a manual `defineDag` that is isomorphic
//                 to a shape helper. Advisory only; never fails the lint, and
//                 never fires on a DAG already built with a helper (provenance).

import type { DagDef } from "../types/dag.js";
import type { LintAdvisory, LintError } from "./types.js";
import { computeIncomingByNode } from "../dag-runtime/topology.js";
import { fanInKeyCheck, describeFanInKeyMismatch } from "../executor/fan-in-keys.js";
import { isDagInput } from "../types/ids.js";

interface DagAnalysis {
  readonly errors: readonly LintError[];
  readonly advisories: readonly LintAdvisory[];
}

// ---------------------------------------------------------------------------
// B1 — fan-in key check
// ---------------------------------------------------------------------------

const checkFanInKeys = (dag: DagDef): LintError[] => {
  const incomingByNode = computeIncomingByNode(dag);
  const errors: LintError[] = [];

  for (const node of dag.nodes) {
    const incoming = incomingByNode.get(node.id);
    if (incoming === undefined) continue;

    // The runtime builds a keyed object only when ≥2 distinct sources feed the
    // node (matching buildNodeInput's 0/1/≥2 rule). 0 or 1 source ⇒ bare value,
    // no keys to check.
    const sources = [...incoming.required, ...incoming.optional];
    if (sources.length < 2) continue;

    const check = fanInKeyCheck(node.inputSchema, sources);
    if (check.kind !== "mismatch") continue; // ok or unverifiable → skip

    errors.push({
      kind: "fan-in-key-mismatch",
      nodeId: node.id,
      message: describeFanInKeyMismatch(node.id, sources, check),
      missingKeys: check.missing,
      extraKeys: check.extra,
    });
  }
  return errors;
};

// ---------------------------------------------------------------------------
// B3 — shape-helper hint (advisory)
// ---------------------------------------------------------------------------

const edgeKey = (from: string, to: string): string => `${from}\0${to}`;

/**
 * Suggest a shape helper when a *manual* `defineDag` is edge-for-edge
 * isomorphic to one. Returns `null` for DAGs already built with a helper
 * (provenance set), DAGs with conditional/default edges (router territory —
 * not matched here), and anything that isn't an exact match.
 */
const detectShapeHelper = (dag: DagDef): LintAdvisory | null => {
  if (dag.provenance !== undefined) return null; // already used a helper
  if (dag.nodes.length < 2) return null;
  // `DAG_INPUT` edges are the request wiring, not part of the node topology —
  // ignore them so the underlying shape (and its entry node's in-degree of 0)
  // is detected as if the request flowed in implicitly.
  const edges = dag.edges.filter((e) => !isDagInput(e.from));
  if (!edges.every((e) => e.kind === "unconditional")) return null;

  const ids = dag.nodes.map((n) => n.id as string);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const outdeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const outTargets = new Map<string, string[]>(ids.map((id) => [id, []]));
  const actualEdges = new Set<string>();
  for (const e of edges) {
    const f = e.from as string;
    const t = e.to as string;
    outdeg.set(f, (outdeg.get(f) ?? 0) + 1);
    indeg.set(t, (indeg.get(t) ?? 0) + 1);
    outTargets.get(f)!.push(t);
    actualEdges.add(edgeKey(f, t));
  }
  const sources = ids.filter((id) => indeg.get(id) === 0);
  const sinks = ids.filter((id) => outdeg.get(id) === 0);

  // Linear: single chain — one source, one sink, every node in/out degree ≤ 1.
  if (
    edges.length === ids.length - 1 &&
    sources.length === 1 &&
    sinks.length === 1 &&
    ids.every((id) => (indeg.get(id) ?? 0) <= 1 && (outdeg.get(id) ?? 0) <= 1)
  ) {
    return {
      kind: "shape-helper-hint",
      helper: "defineLinearDag",
      message:
        `DAG '${dag.id as string}' is a linear chain — consider ` +
        `defineLinearDag([...]) so the edges are inferred from node order.`,
    };
  }

  if (sources.length !== 1) return null;
  const source = sources[0]!;
  const branches = outTargets.get(source)!;
  if (branches.length < 2) return null;

  // Fan-out with a single join (diamond): source→each branch, each branch→join,
  // and nothing else. Reconstruct the helper's edge set and compare exactly.
  const firstBranchTargets = outTargets.get(branches[0]!) ?? [];
  if (firstBranchTargets.length === 1) {
    const join = firstBranchTargets[0]!;
    if (join !== source && !branches.includes(join)) {
      const expected = new Set<string>();
      for (const b of branches) {
        expected.add(edgeKey(source, b));
        expected.add(edgeKey(b, join));
      }
      if (
        expected.size === actualEdges.size &&
        [...expected].every((k) => actualEdges.has(k))
      ) {
        return {
          kind: "shape-helper-hint",
          helper: "defineDiamond",
          message:
            `DAG '${dag.id as string}' is one source fanning out to ` +
            `${branches.length} branches that reconverge on '${join}' — ` +
            `consider defineDiamond({ source, branches, join }).`,
        };
      }
    }
  }

  // Fan-out with no join: every edge leaves the source; branches are all sinks.
  if (
    edges.length === branches.length &&
    branches.every((b) => outdeg.get(b) === 0)
  ) {
    return {
      kind: "shape-helper-hint",
      helper: "defineFanOut",
      message:
        `DAG '${dag.id as string}' is one source fanning out to ` +
        `${branches.length} parallel branches — consider ` +
        `defineFanOut({ source, branches }).`,
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// B2 — redundant-passthrough detector (advisory)
// ---------------------------------------------------------------------------

/**
 * Flag the legacy request-carrier idiom (the pre-0.2.0 `read-request` node): a
 * transform whose SOLE incoming source is `DAG_INPUT` and whose `inputSchema`
 * and `outputSchema` are the SAME reference. Such a node exists only to forward
 * the DAG request one hop downstream — exactly what a direct `DAG_INPUT` edge to
 * the consumer does, after which the node can be deleted.
 *
 * Two conjuncts keep this precise (advisory, but precise):
 *  - schema-reference identity is the "forwards its input unchanged" signal —
 *    we never execute the transform, so a reused schema is the static proxy;
 *  - sole-source-is-`$input` distinguishes the request carrier from an ordinary
 *    A→A transform that legitimately reuses a schema (which would otherwise
 *    false-positive). A genuine pass-through introduced just to route the
 *    request always sits directly behind `DAG_INPUT`.
 */
const detectRedundantPassthrough = (dag: DagDef): LintAdvisory[] => {
  const incomingByNode = computeIncomingByNode(dag);
  const advisories: LintAdvisory[] = [];
  for (const node of dag.nodes) {
    if (node.kind !== "transform") continue;
    if (node.inputSchema !== node.outputSchema) continue;
    const incoming = incomingByNode.get(node.id);
    if (incoming === undefined) continue;
    const sources = [...incoming.required, ...incoming.optional];
    if (sources.length !== 1 || !isDagInput(sources[0]!)) continue;
    advisories.push({
      kind: "redundant-passthrough",
      nodeId: node.id,
      message:
        `Transform '${node.id as string}' only forwards the DAG request one hop (its sole input is DAG_INPUT ` +
        `and its input/output schemas are identical). Delete it and wire its consumer directly with a ` +
        `{ from: DAG_INPUT, to: <consumer> } edge.`,
    });
  }
  return advisories;
};

/**
 * Run all structural lint checks against a validated `DagDef`. Errors set
 * `runLint`'s result to `ok: false`; advisories ride alongside without failing.
 */
export const analyzeDag = (dag: DagDef): DagAnalysis => {
  const shapeHint = detectShapeHelper(dag);
  return {
    errors: checkFanInKeys(dag),
    advisories: [
      ...(shapeHint === null ? [] : [shapeHint]),
      ...detectRedundantPassthrough(dag),
    ],
  };
};
