// Fan-in key comparison — the single source of truth for "a fan-in node's
// object-schema keys must equal the set of incoming source ids".
//
// The runtime builds a keyed object for any node fed by ≥2 distinct sources
// (`buildNodeInput`'s 0/1/≥2 rule), so a missing or typo'd key fails at runtime.
// This pure comparison is consumed in two places that must never disagree:
//   - `defineSources` (executor) — rejects the mismatch at definition time;
//   - `fugue lint` B1 (cli) — flags the same mismatch for *manual* `defineDag`.
// Living in the core (executor) lets the CLI import it downward, keeping the
// `core → cli` import count at zero.

import { objectSchemaKeys } from "../llm/zod-schema.js";

export type FanInKeyCheck =
  /** Keys match the incoming source ids exactly. */
  | { readonly kind: "ok" }
  /** Schema isn't an introspectable object schema — can't verify, skip. */
  | { readonly kind: "unverifiable" }
  /** Keys disagree with the incoming source ids. */
  | {
      readonly kind: "mismatch";
      /** Incoming source ids with no matching schema key. */
      readonly missing: readonly string[];
      /** Schema keys with no matching incoming source. */
      readonly extra: readonly string[];
      /** The schema's actual top-level keys (for diagnostics). */
      readonly schemaKeys: readonly string[];
    };

/**
 * Compare a fan-in node's object-schema keys against the set of incoming source
 * ids. Single introspection pass; `unverifiable` (non-object schema) is treated
 * as "skip" by both callers rather than a false positive.
 */
export const fanInKeyCheck = (
  schema: unknown,
  sourceIds: readonly string[],
): FanInKeyCheck => {
  const keys = objectSchemaKeys(schema);
  if (keys === null) return { kind: "unverifiable" };
  const keySet = new Set(keys);
  const sourceSet = new Set(sourceIds);
  const missing = sourceIds.filter((s) => !keySet.has(s));
  const extra = keys.filter((k) => !sourceSet.has(k));
  if (missing.length === 0 && extra.length === 0) return { kind: "ok" };
  return { kind: "mismatch", missing, extra, schemaKeys: keys };
};

/**
 * Human-readable description of a fan-in key mismatch — shared by the
 * definition-time error and the lint error so both read identically.
 */
export const describeFanInKeyMismatch = (
  nodeId: string,
  sourceIds: readonly string[],
  mismatch: Extract<FanInKeyCheck, { kind: "mismatch" }>,
): string => {
  const parts: string[] = [];
  if (mismatch.missing.length > 0) {
    parts.push(`missing key(s) for incoming source(s): ${mismatch.missing.join(", ")}`);
  }
  if (mismatch.extra.length > 0) {
    parts.push(`extra key(s) with no incoming source: ${mismatch.extra.join(", ")}`);
  }
  return (
    `Fan-in node '${nodeId}' receives an object keyed by its incoming ` +
    `node ids {${[...sourceIds].sort().join(", ")}}, but its inputSchema keys are ` +
    `{${[...mismatch.schemaKeys].sort().join(", ")}} — ${parts.join("; ")}.`
  );
};
