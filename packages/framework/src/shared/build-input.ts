// buildNodeInput — assemble a node's input value from its incoming sources.
//
// Shared by `dag-runtime/run-node.ts` (execution) and
// `dag-runtime/freshness-emission.ts` (witness extraction).

import type { IncomingSources } from "./incoming.js";
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";

/**
 * Build a node's input value from its incoming sources.
 *
 * - Exactly one incoming source, required or optional: input is the bare
 *   upstream value. A sole optional source is a selected router edge; the node
 *   is active only when that conditional/default edge fired. The selected
 *   optional source is asserted to have produced output — the same
 *   checkpoint-corruption/framework-ordering-bug class the required-source
 *   branch below catches, with the same non-retriable node-attributed error.
 * - No incoming sources: input is `undefined` — the node is a *source*
 *   (C0 / 0.2.0). No node implicitly receives the DAG input any more; the
 *   request reaches a node only through a `DAG_INPUT` edge, which makes
 *   `"$input"` one of its required sources (it is seeded into `outputs` at run
 *   start, so it resolves like any other upstream output here).
 * - Two or more incoming sources: input is an object keyed by
 *   `required ∪ optional`; absent optional sources surface as `undefined`. A
 *   `"$input"` key carries the request alongside the other fan-in sources.
 *
 * Why the 0/1/≥2 split rather than always passing a keyed object: with no or
 * exactly one source the keyed form is pure overhead — the node's `run(input)`
 * would always destructure a one-key envelope or ignore an empty one. Routed
 * handlers are not dispatched when their sole optional edge is absent, so
 * their selected classifier output has the same unambiguous one-source shape.
 * With ≥2 sources a bare value is ambiguous, so fan-in stays keyed.
 *
 * The `nodeId` parameter takes the branded `NodeId` so the validated-id
 * precondition is structural: an out-of-pattern identifier reaching this
 * function is unrepresentable, and the promised Err path has no hidden
 * exception channel from the brand's own validation.
 *
 * Returns `Err` with `retriability: "non-retriable"` when a required source —
 * or the selected sole optional source — is missing: this indicates checkpoint
 * corruption or a framework ordering bug, not a transient failure.
 */
export const buildNodeInput = (
  outputs: ReadonlyMap<string, unknown>,
  incoming: IncomingSources,
  nodeId: NodeId,
): Result<unknown, FrameworkError> => {
  const { required, optional } = incoming;

  // Assert all required sources produced output (wave ordering guarantees this;
  // assertion catches checkpoint corruption or framework ordering bugs)
  for (const dep of required) {
    if (!outputs.has(dep)) {
      return err({
        kind: "node-crash" as const,
        nodeId,
        retriability: "non-retriable" as const,
        message: `BUG: required source '${dep}' has no output in the outputs map. ` +
          `This indicates checkpoint corruption or a framework ordering bug.`,
      });
    }
  }

  const sources = [...required, ...optional];
  if (sources.length === 0) return ok(undefined);
  if (sources.length === 1) {
    const source = sources[0]!;
    // Same assertion, sole-optional-source form: a selected router edge whose
    // output is absent is the same corruption class the required-source check
    // attributes, so it gets the same non-retriable node-attributed error
    // instead of silently passing `undefined` as the node's input.
    if (!outputs.has(source)) {
      return err({
        kind: "node-crash" as const,
        nodeId,
        retriability: "non-retriable" as const,
        message: `BUG: sole optional source '${source}' has no output in the outputs map. ` +
          `This indicates checkpoint corruption or a framework ordering bug.`,
      });
    }
    return ok(outputs.get(source));
  }
  return ok(Object.fromEntries(sources.map((source) => [source, outputs.get(source)])));
};
