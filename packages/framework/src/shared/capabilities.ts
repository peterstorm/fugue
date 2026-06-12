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
import {
  brandAsValidatedNodeContext,
  BUILTIN_CAPABILITY_KEYS,
  RESERVED_NON_CAPABILITY_KEYS,
} from "../types/node.js";
import type { FrameworkError, MissingCapability } from "../types/errors.js";
import type { CapabilityBroker } from "../types/capability-broker.js";
import { type Result, ok, err } from "../types/result.js";

/**
 * Walk `dag.nodes`, collect `union(node.requires)`, and verify each capability
 * resolves to a non-null value on `ctx`. Returns all missing pairs as a
 * single Err — callers see the full set of gaps in one pass rather than
 * having to re-run after each fix. The first miss is `missing[0]`; the
 * non-empty tuple guarantees it always exists.
 *
 * Returns a phantom-branded `ValidatedNodeContext` token when all
 * declarations are satisfied. Downstream code requires the token, so any
 * path that bypasses this check fails to typecheck.
 *
 * Uses dynamic property lookup (`ctx[cap]`) to support extensible capabilities
 * registered via `CapabilityRegistry` module augmentation (ADR-0051).
 *
 * `broker` — when a minting broker is wired (the host's per-invocation Keycloak
 * broker), a capability the broker `provides()` is resolved at NODE DISPATCH,
 * not on the boot-scoped base context. Such a capability is therefore NOT
 * required to be present on `ctx` here: the run-start check skips it (it would
 * otherwise spuriously fail as `missing-capability`, since the static base
 * context legitimately lacks the minted scope handles). Capabilities the broker
 * does not provide — the static `http`/`db` clients, `llm`, etc. — are still
 * validated against `ctx` exactly as before. Omitted (pass-through / no broker)
 * ⇒ every required capability is validated against `ctx`, the unchanged path.
 */
export const validateCapabilities = (
  dag: DagDef,
  ctx: BaseNodeContext,
  broker?: CapabilityBroker,
): Result<ValidatedNodeContext, FrameworkError> => {
  const missing: MissingCapability[] = [];
  // Single widening cast: custom capabilities live as dynamic properties on
  // the context (ADR-0051), so the lookup is keyed by `Capability` rather
  // than the statically-known `BaseNodeContext` fields. `== null` covers both
  // "field absent" (custom capability never wired) and "field explicitly
  // null" (built-in capability unwired) — both are missing for a node that
  // declared them.
  const dynamicCtx = ctx as Partial<Record<Capability, unknown>>;
  // A capability whose name collides with a reserved infrastructure field
  // (e.g. a consumer augments `CapabilityRegistry` with `logger`) can never be
  // wired: `makeNodeContext` refuses to spread it (it would clobber the framework
  // field), so `dynamicCtx[cap]` would resolve to the always-present infra value
  // rather than the capability client. Treat such a requirement as missing —
  // fail closed rather than pass validation on a mistyped value.
  const reservedNonCapabilityKeys: ReadonlySet<string> = new Set(RESERVED_NON_CAPABILITY_KEYS);
  const builtinCapabilityKeys: ReadonlySet<string> = new Set(BUILTIN_CAPABILITY_KEYS);
  for (const node of dag.nodes) {
    for (const cap of node.requires) {
      // A capability the broker mints per-invocation is satisfied at dispatch,
      // not on the boot-scoped base context — skip it here (checking `ctx` would
      // fail it as missing). Reserved-key collisions are still rejected even if
      // a broker claims them: the runtime can never wire such a name as a field.
      if (reservedNonCapabilityKeys.has(cap)) {
        missing.push({ nodeId: node.id, capability: cap });
        continue;
      }
      if (broker?.provides?.(cap)) {
        // SEAM CONTRACT with `mergeScopedCapabilities`: every capability this
        // skip exempts MUST survive the dispatch-time merge, or validation
        // passes for a handle the node never receives. The merge refuses to
        // overlay BUILT-IN capability keys (`llm`/`http`/…, part of its
        // RESERVED_CONTEXT_KEYS clobber guard), so a broker claiming one is a
        // WIRING ERROR today — its minted handle would be silently dropped and
        // the node would run against the static client while the system
        // believes the broker governs it (a silent authority widening). Fail
        // the run loudly instead. When broker-minted built-ins land
        // (FR-W2-009), the merge's guard must change in the same commit as
        // this one.
        if (builtinCapabilityKeys.has(cap)) {
          return err({
            kind: "validation" as const,
            nodeId: node.id,
            message:
              `broker claims provides("${cap}") but "${cap}" is a built-in capability key the ` +
              `dispatch-time merge never overlays — wire it statically or extend the merge first`,
          });
        }
        continue;
      }
      if (dynamicCtx[cap] == null) {
        missing.push({ nodeId: node.id, capability: cap });
      }
    }
  }
  // Destructure to prove non-emptiness to the type system: when `first` is
  // present, `[first, ...rest]` is a `[MissingCapability, ...MissingCapability[]]`
  // tuple, satisfying the error's non-empty `missing` field without a cast.
  const [first, ...rest] = missing;
  if (first !== undefined) {
    return err({
      kind: "missing-capability" as const,
      missing: [first, ...rest],
    });
  }
  return ok(brandAsValidatedNodeContext(ctx));
};
