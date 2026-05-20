import { createHash } from "node:crypto";
import type { DagDef, EdgeDef } from "../types/dag.js";
import { isConditionalEdge, isDefaultEdge } from "../types/dag.js";

/**
 * Framework version stamped onto every checkpoint meta. Resume rejects when
 * the stored value differs from this — semantics of validation, retry, or
 * output coercion can change across framework releases, so resuming with an
 * older meta would mix two contracts. Bump this on any change that alters
 * how cached node outputs are interpreted.
 *
 * - "1" — initial.
 * - "2" — ADR 0017: `deps`/`optionalDeps` removed from NodeDef; per-node
 *   input shape derived from edges. Fingerprint payload no longer includes
 *   deps. Old checkpoints reference fields that no longer exist on
 *   reconstructed NodeDefs and can't be safely resumed.
 */
export const FRAMEWORK_VERSION = "2";

const edgeKey = (e: EdgeDef): string => {
  if (isConditionalEdge(e)) return `${e.from}->${e.to}|when:${e.when.label}:${e.when.version}`;
  if (isDefaultEdge(e)) return `${e.from}->${e.to}|default`;
  return `${e.from}->${e.to}`;
};

/**
 * Stable structural hash of a DAG. Captures node IDs, node kinds, edges
 * (sorted, including predicate JSON for conditional edges and the
 * default-edge marker), and the explicit output node. Per-node deps are
 * NOT included — they were dropped from `NodeDef` (ADR 0017); the edges
 * payload now carries the same topological information.
 *
 * Schema versions are not included because zod schemas have no stable
 * identity; structural drift catches the realistic deploy-time risk
 * (renamed/added/removed nodes, rewired edges, edited predicates).
 *
 * Used to gate resume: if the persisted fingerprint differs from the current
 * DAG's, the cached node outputs cannot be safely replayed.
 */
export const dagFingerprint = (dag: DagDef): string => {
  const nodes = dag.nodes
    .map((n) => `${n.id}|${n.kind}`)
    .sort()
    .join("\n");
  const edges = dag.edges.map(edgeKey).sort().join("\n");
  const output = dag.outputNodeId ?? "";
  const payload = `${dag.id}\n${nodes}\n${edges}\n${output}`;
  return createHash("sha256").update(payload).digest("hex");
};
