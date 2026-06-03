// Run-start capability validation.
//
// Every NodeDef declares `requires: readonly Capability[]`. Before the kernel
// runner is invoked, the runtime walks the DAG and confirms every required
// capability is satisfied by the wired NodeContext. A missing capability fails
// the run with `Err({ kind: "missing-capability" })` before any `node.run` is
// called.
//
// ADR-0051: Now uses dynamic property access on the context object instead of
// a hardcoded switch. This supports extensible capabilities registered via
// module augmentation of `CapabilityRegistry`.

import type { DagDef } from "../types/dag.js";
import type {
  BaseNodeContext,
  Capability,
  ValidatedNodeContext,
} from "../types/node.js";
import { brandAsValidatedNodeContext } from "../types/node.js";
import type { FrameworkError } from "../types/errors.js";
import { type Result, ok, err } from "../types/result.js";

/**
 * Walk `dag.nodes`, collect `union(node.requires)`, and verify each capability
 * resolves to a non-null value on `ctx`. Returns all missing pairs as a
 * single Err — callers see the full set of gaps in one pass rather than
 * having to re-run after each fix. The first miss is also surfaced at the
 * top-level `nodeId`/`capability` fields so existing pattern-matchers stay
 * working unchanged.
 *
 * Returns a phantom-branded `ValidatedNodeContext` token when all
 * declarations are satisfied. Downstream code requires the token, so any
 * path that bypasses this check fails to typecheck.
 *
 * Uses dynamic property lookup (`ctx[cap]`) to support extensible capabilities
 * registered via `CapabilityRegistry` module augmentation (ADR-0051).
 */
export const validateCapabilities = (
  dag: DagDef,
  ctx: BaseNodeContext,
): Result<ValidatedNodeContext, FrameworkError> => {
  const missing: { readonly nodeId: typeof dag.nodes[number]["id"]; readonly capability: Capability }[] = [];
  // Single widening cast: custom capabilities live as dynamic properties on
  // the context (ADR-0051), so the lookup is keyed by `Capability` rather
  // than the statically-known `BaseNodeContext` fields. `== null` covers both
  // "field absent" (custom capability never wired) and "field explicitly
  // null" (built-in capability unwired) — both are missing for a node that
  // declared them.
  const dynamicCtx = ctx as Partial<Record<Capability, unknown>>;
  for (const node of dag.nodes) {
    for (const cap of node.requires) {
      if (dynamicCtx[cap] == null) {
        missing.push({ nodeId: node.id, capability: cap });
      }
    }
  }
  if (missing.length > 0) {
    const first = missing[0]!;
    return err({
      kind: "missing-capability" as const,
      nodeId: first.nodeId,
      capability: first.capability,
      missing,
    });
  }
  return ok(brandAsValidatedNodeContext(ctx));
};
