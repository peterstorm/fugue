// Run-start capability validation.
//
// Wave 7 §7.5 — every NodeDef declares `requires: readonly Capability[]`.
// Before the kernel runner is invoked, the runtime walks the DAG and
// confirms every required capability is satisfied by the wired NodeContext.
// A missing capability fails the run with `Err({ kind: "missing-capability" })`
// before any `node.run` is called.

import type { DagDef } from "../types/dag.js";
import type {
  BaseNodeContext,
  Capability,
} from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";

const capabilityField = (
  ctx: BaseNodeContext,
  capability: Capability,
): unknown => {
  switch (capability) {
    case "llm":
      return ctx.llm;
    case "cache":
      return ctx.cache;
    case "prompts":
      return ctx.prompts;
    case "judgeLlm":
      return ctx.judgeLlm;
  }
};

/**
 * Walk `dag.nodes`, collect `union(node.requires)`, and verify each capability
 * resolves to a non-null value on `ctx`. Returns the *first* missing
 * capability (paired with the declaring node id) as an Err, or `ok` when all
 * declarations are satisfied.
 */
export const validateCapabilities = (
  dag: DagDef,
  ctx: BaseNodeContext,
): Result<void, FrameworkError> => {
  for (const node of dag.nodes) {
    for (const cap of node.requires) {
      if (capabilityField(ctx, cap) == null) {
        return err({
          kind: "missing-capability" as const,
          nodeId: node.id,
          capability: cap,
        });
      }
    }
  }
  return ok(undefined);
};
