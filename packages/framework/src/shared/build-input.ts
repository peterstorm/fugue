// buildNodeInput — assemble a node's input value from its incoming sources.
//
// Shared by `dag-runtime/run-node.ts` (execution) and
// `dag-runtime/freshness-emission.ts` (witness extraction).

import type { IncomingSources } from "./incoming.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { __brandNodeId } from "../types/ids.js";

/**
 * Build a node's input value from its incoming sources.
 *
 * - `optional.length > 0`: input is an object keyed by `required ∪ optional`;
 *   absent optional sources surface as `undefined`.
 * - `required.length === 0`: input is the DAG-level `dagInput`.
 * - `required.length === 1`: input is the bare upstream value.
 * - `required.length >= 2`: input is an object keyed by `required`.
 *
 * Why the 0/1/≥2 split rather than always passing a keyed object: with no or
 * exactly one required source the keyed form is pure overhead — the node's
 * `run(input)` would always destructure a one-key envelope or ignore an empty
 * one. The bare-value forms make trivial transforms readable. With ≥2 sources
 * a bare value is ambiguous, so we switch to the keyed object. Optional
 * sources always force the keyed shape because their presence isn't known
 * statically — a node can't branch on whether `input` is bare-or-keyed at
 * runtime.
 *
 * Returns `Err` with `retriability: "non-retriable"` when a required source
 * is missing — this indicates checkpoint corruption or a framework ordering
 * bug, not a transient failure.
 */
export const buildNodeInput = (
  dagInput: unknown,
  outputs: ReadonlyMap<string, unknown>,
  incoming: IncomingSources,
  nodeId: string,
): Result<unknown, FrameworkError> => {
  const { required, optional } = incoming;

  // Assert all required sources produced output (wave ordering guarantees this;
  // assertion catches checkpoint corruption or framework ordering bugs)
  for (const dep of required) {
    if (!outputs.has(dep)) {
      return err({
        kind: "node-crash" as const,
        nodeId: __brandNodeId(nodeId),
        retriability: "non-retriable" as const,
        message: `BUG: required source '${dep}' has no output in the outputs map. ` +
          `This indicates checkpoint corruption or a framework ordering bug.`,
      });
    }
  }

  if (optional.length > 0) {
    return ok(Object.fromEntries(
      [...required, ...optional].map((d) => [d, outputs.get(d)]),
    ));
  }
  if (required.length === 0) return ok(dagInput);
  if (required.length === 1) return ok(outputs.get(required[0]!));
  return ok(Object.fromEntries(required.map((d) => [d, outputs.get(d)])));
};
