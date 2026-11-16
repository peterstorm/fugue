/**
 * Capability Gate — the broker's fail-closed policy decision, pure.
 *
 * For one capability a node declares, decide whether the Keycloak broker
 * passes it through (not a scope it mints), refuses it locally, or lets it on
 * to minting with the downstream audience its token is narrowed to. The
 * decision reads only the capability name, the agent client's assigned scopes
 * and the configured Dynamics org host: no I/O, no audit. The broker
 * (`adapters/keycloak-broker.ts`) audits a refusal and does the egress for a
 * gated scope; this module only says which.
 *
 * Order, and why it is load-bearing:
 *   1. Pass-through EXACTLY when `parseScope` does not recognise the name (a
 *      static client such as `http`, or an ADR-0051 custom `mycorp:widget`), so
 *      the broker mints precisely what its `provides()` claims and everything
 *      else stays run-start-validated against the base context.
 *   2. `scope-not-assigned` — the agent client was never assigned the scope
 *      (SC-006 / FR-303). Checked before any cache read or egress.
 *   3. `dynamics-org-host-unset` — a `dynamics:read` scope with no configured
 *      `DYNAMICS_ORG_HOST` has no audience (FR-042). Checked AFTER the
 *      assignment check, so an unassigned scope is always reported as such.
 *
 * @satisfies SC-006 FR-303 FR-042
 */

import {
  audienceForScope,
  parseScope,
  scopeName,
  type DownstreamScope,
} from "./capability-scope.js";

/** Why the gate refused a recognised scope; each is one audit refusal reason. */
export type GateRefusalReason = "scope-not-assigned" | "dynamics-org-host-unset";

/**
 * A scope the gate let through: the parsed scope and the downstream audience
 * its token is narrowed to. The scope string is derived (`scopeName(scope)`),
 * never stored beside the scope, so the two cannot disagree.
 */
export type GatedScope = {
  readonly kind: "gated";
  readonly scope: DownstreamScope;
  readonly audience: string;
};

/** A recognised scope the gate refused locally, with zero egress. */
export type GateRefusal = {
  readonly kind: "refused";
  readonly scope: DownstreamScope;
  readonly reason: GateRefusalReason;
};

/** The gate's verdict for one declared capability. */
export type GateDecision = { readonly kind: "pass-through" } | GateRefusal | GatedScope;

/**
 * Decide one declared capability against the agent client's assigned scope
 * names (canonical `"<provider>:<operation>"`) and the configured Dynamics org
 * host. Pure and total.
 */
export const decideGate = (
  capability: string,
  assigned: ReadonlySet<string>,
  dynamicsOrgHost: string | undefined,
): GateDecision => {
  const scope = parseScope(capability);
  if (scope === undefined) return { kind: "pass-through" };
  if (!assigned.has(scopeName(scope))) return { kind: "refused", scope, reason: "scope-not-assigned" };
  const audience = audienceForScope(scope, dynamicsOrgHost);
  if (audience === undefined) return { kind: "refused", scope, reason: "dynamics-org-host-unset" };
  return { kind: "gated", scope, audience };
};
