import { createHash } from "node:crypto";
import type { DagDef } from "../types/dag.js";

/**
 * Framework version stamped onto every checkpoint meta. Resume rejects when
 * the stored value differs from this — semantics of validation, retry, or
 * output coercion can change across framework releases, so resuming with an
 * older meta would mix two contracts. Bump this on any change that alters
 * how cached node outputs are interpreted.
 */
export const FRAMEWORK_VERSION = "1";

/**
 * Stable structural hash of a DAG. Captures node IDs, node kinds, dep
 * topology (sorted), edges (sorted), and the explicit output node. Schema
 * versions are not included because zod schemas have no stable identity;
 * structural drift catches the realistic deploy-time risk (renamed/added/
 * removed nodes, rewired deps).
 *
 * Used to gate resume: if the persisted fingerprint differs from the current
 * DAG's, the cached node outputs cannot be safely replayed.
 */
export const dagFingerprint = (dag: DagDef): string => {
  const nodes = dag.nodes
    .map((n) => {
      const deps = [...n.deps].sort().join(",");
      return `${n.id}|${n.kind}|${deps}`;
    })
    .sort()
    .join("\n");
  const edges = dag.edges
    .map((e) => `${e.from}->${e.to}`)
    .sort()
    .join("\n");
  const output = dag.outputNodeId ?? "";
  const payload = `${dag.id}\n${nodes}\n${edges}\n${output}`;
  return createHash("sha256").update(payload).digest("hex");
};
