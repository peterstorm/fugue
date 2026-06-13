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
 * - `required.length === 0`: input is `undefined` — the node is a *source*
 *   (C0 / 0.2.0). No node implicitly receives the DAG input any more; the
 *   request reaches a node only through a `DAG_INPUT` edge, which makes
 *   `"$input"` one of its required sources (it is seeded into `outputs` at run
 *   start, so it resolves like any other upstream output here).
 * - `required.length === 1`: input is the bare upstream value (this is how a
 *   single `DAG_INPUT` edge delivers the request verbatim).
 * - `required.length >= 2`: input is an object keyed by `required` (a fan-in;
 *   a `"$input"` key carries the request alongside the other sources).
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
  if (required.length === 0) return ok(undefined);
  if (required.length === 1) return ok(outputs.get(required[0]!));
  return ok(Object.fromEntries(required.map((d) => [d, outputs.get(d)])));
};
