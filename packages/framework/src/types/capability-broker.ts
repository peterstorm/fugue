// CapabilityBroker — the per-invocation *authority* seam.
//
// This port sits in the same layer as `CapabilityHandle` (the BOOT-scoped
// lifecycle wrapper). The two axes are deliberately separate:
//
//   - `CapabilityHandle` owns LIFECYCLE: `connect`/`close`/`healthCheck`,
//     connection pools. These stay BOOT-scoped and are UNTOUCHED by the broker
//     (FR-W2-005). A pool is opened once at boot and shared across every run.
//
//   - `CapabilityBroker` owns AUTHORITY: given one node `Invocation` and the
//     `requires` declaration, it resolves the scoped client set that invocation
//     is allowed to use. Authority varies per node / run / identity; pools
//     must not.
//
// The framework ships a zero-regression PASS-THROUGH broker (see
// `../shared/passthrough-broker.ts`) that hands back the statically-configured
// clients byte-identically — today's behavior exactly. That default IS the
// migration path: every DAG/embedder that compiles and runs today continues to
// do so with no migration step (US3, FR-W2-002/003, SC-005).
//
// Later waves add a host-side broker that mints narrowly-scoped tokens per
// invocation. That implementation lives in the host, NOT here (FR-W2-006) — the
// port and the pass-through default never reference any concrete identity
// provider (FR-W2-004).
//
// @satisfies US3 — zero-regression per-invocation capability layer (the port +
//   pass-through default add the authority axis without breaking any DAG/embedder)
// @satisfies FR-W2-001 — framework defines the `CapabilityBroker` port (Invocation +
//   requires → scoped clients), occupying the same layer as `CapabilityHandle`
// @satisfies FR-W2-005 — only authority becomes invocation-scoped; connect/close/
//   healthCheck (CapabilityHandle) are untouched, pools stay boot-scoped

import type { Result } from "./result.js";
import type { FrameworkError } from "./errors.js";
import type { Capability, CapabilityRegistry } from "./node.js";
import type { RunId, DagId, NodeId } from "./ids.js";

/**
 * The resolved, scoped client set for a single invocation. Mirrors the output
 * shape of the host's `extractClients` (`Partial<{ [K in Capability]: ... }>`),
 * so the broker can be dropped in wherever a static client record is consumed.
 *
 * A capability key is present iff the broker resolved a client for it. The
 * pass-through broker returns exactly the configured set unchanged.
 */
export type ScopedCapabilityHandle = Partial<{ readonly [K in Capability]: CapabilityRegistry[K] }>;

/**
 * Who initiated an invocation — a discriminated union, not optional fields. An
 * invocation is EITHER agent-initiated (autonomous/cron) OR user-initiated,
 * never an ambiguous blend. In later waves `origin` selects the authority
 * strategy (agent → `client_credentials`; user → token exchange preserving
 * `sub`). The pass-through broker IGNORES `origin` entirely — authority is not
 * yet varied.
 *
 * Exported as a named type so consumers building it from an auth identity can
 * `match(origin).with(...).exhaustive()` by name and reuse the shape.
 */
export type InvocationOrigin =
  | { readonly kind: "agent"; readonly agentClientId: string }
  | { readonly kind: "user"; readonly sub: string; readonly agentClientId: string };

/**
 * Identity + correlation for one node invocation.
 *
 * `runId`/`dagId`/`nodeId` are the correlation triple every later mint/refusal
 * audit record is keyed on.
 */
export interface Invocation {
  readonly origin: InvocationOrigin;
  readonly runId: RunId;
  readonly dagId: DagId;
  readonly nodeId: NodeId;
}

/**
 * The per-invocation authority seam.
 *
 * `mintFor` resolves the scoped client set an invocation is authorized to use,
 * given its `requires` declaration. It is `async` because real brokers reach a
 * token endpoint; the pass-through default resolves synchronously-wrapped (no
 * I/O, no token request — SC-008 is trivially satisfied: it mints nothing).
 *
 * Errors flow on the `Result` channel (`FrameworkError`), never thrown across
 * the boundary. The pass-through broker never produces an `Err`.
 *
 * @satisfies FR-W2-009 — the LLM handle is expressible as the first
 *   invocation-scoped capability over this same `mintFor` seam (no OIDC
 *   required): `"llm"` is a `Capability`, so a future broker can resolve it here
 *   without any change to this port. (Not migrated in this wave — the
 *   metered-llm wiring stays.)
 */
export interface CapabilityBroker {
  mintFor(
    inv: Invocation,
    requires: readonly Capability[],
  ): Promise<Result<ScopedCapabilityHandle, FrameworkError>>;
}
