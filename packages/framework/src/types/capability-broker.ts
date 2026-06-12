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
// The zero-regression path is to wire NO broker at all: `runDag` without a
// `minting` option skips per-node minting entirely, so every DAG/embedder that
// compiles and runs today continues to do so with no migration step (US3,
// FR-W2-002/003, SC-005). The framework also ships a PASS-THROUGH broker (see
// `../shared/passthrough-broker.ts`) — an optional embedder convenience that
// hands back the statically-configured clients byte-identically, equivalent to
// omitting the broker.
//
// The host-side broker that mints narrowly-scoped tokens per invocation lives
// in the host, NOT here (FR-W2-006) — the port and the pass-through convenience
// never reference any concrete identity provider (FR-W2-004).
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
 * The per-node minting authority — a broker AND the origin it authorizes
 * against, as ONE value.
 *
 * The two are useless apart: run-start validation exempts `broker.provides()`
 * scopes from the base-context check *because* they will be minted at dispatch,
 * and dispatch minting needs `origin` to build each node's `Invocation`. When
 * they were two independent optionals, `broker`-without-`origin` was
 * representable — validation waved scope capabilities through, minting silently
 * never ran, and the node crashed on an `undefined` handle. Pairing them in one
 * type makes that half-wired state unrepresentable.
 */
export interface MintingAuthority {
  readonly broker: CapabilityBroker;
  readonly origin: InvocationOrigin;
}

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
 *   without any change to THIS PORT. (Not migrated in this wave — the
 *   metered-llm wiring stays.) NOTE the RUNTIME is not yet ready for that
 *   future: `mergeScopedCapabilities` deliberately refuses to overlay built-in
 *   capability keys (`llm`/`http`/…), and `validateCapabilities` therefore
 *   REJECTS a broker claiming `provides()` for one as a wiring error. Migrating
 *   a built-in onto this seam means lifting both guards in the same commit —
 *   the port itself needs no change.
 */
export interface CapabilityBroker {
  mintFor(
    inv: Invocation,
    requires: readonly Capability[],
  ): Promise<Result<ScopedCapabilityHandle, FrameworkError>>;

  /**
   * Does this broker resolve `cap` per-invocation (minting it at node dispatch)
   * rather than expecting it on the boot-scoped base context?
   *
   * Consulted by run-start capability validation (`validateCapabilities`): a
   * capability the broker provides is NOT required to be present on the wired
   * NodeContext — it is minted per node when the node actually runs, so the
   * run-start check must not fail it as `missing-capability`. A capability the
   * broker does NOT provide (e.g. the static `http`/`db` clients, or `llm`) is
   * still validated against the base context as before.
   *
   * Optional and defaulting to "provides nothing": the pass-through broker (and
   * any broker that only hands back the static set) omits it, so every required
   * capability is validated against the base context exactly as today — the
   * zero-regression path is unchanged. A minting broker (the host's realm-backed
   * broker) implements it to claim the `"<provider>:<operation>"` scope names it
   * resolves at dispatch.
   */
  provides?(cap: Capability): boolean;
}
