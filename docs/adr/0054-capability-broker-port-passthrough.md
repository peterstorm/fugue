# ADR-0054: CapabilityBroker port + pass-through default in the framework; Keycloak/Entra impl in the host

## Status

Accepted

## Context

Identity-scoped capabilities introduce a new authority axis: given one node
invocation and the `requires` it declares, *something* must resolve the scoped
client set that invocation is allowed to use — minting narrowly-scoped,
operation-narrowed downstream tokens per hop. Today there is no such seam. The
host's `extractClients` builds a static client record once and that same record
is handed to every node of every run regardless of identity. Authority is global
and unscoped.

The question is **where the authority seam lives**. The obvious path is to grow
the minting machinery host-side only, beside the existing `extractClients`. But
`@fuguejs/framework` is consumed two ways: through the host (the deployed
process), and *directly* by framework-only embedders that bring their own
identity substrate and never run the host at all. The flagship security feature
of this effort — per-invocation, fail-closed, narrowed capabilities — is exactly
the kind of feature that must not be host-exclusive. A framework-only embedder
that declares `requires: ["msgraph:mail.send"]` must be able to plug in *its own*
broker and get the same authority discipline.

Two forces are in tension. (1) The seam (the port and its default) must live in
the framework, the same layer `CapabilityHandle` occupies, so any embedder can
target it — and it must reference no concrete identity provider (FR-W2-004). (2)
The concrete Keycloak/Entra implementation is large, provider-specific, and
operationally coupled to the deployed process; it belongs in the host
(FR-W2-006). And cutting across both: the migration to this new seam must be
**zero-regression** — every DAG and embedder that compiles and runs today must
keep byte-identical capability behavior with no migration step (FR-W2-003,
SC-005, US3).

## Options Considered

1. **Grow `mintFor` machinery host-side only (rejected seed).**
   - Pros: One place to write it; no new framework surface; the host already
     owns `extractClients` and all provider config.
   - Cons: Framework-only embedders get nothing — the flagship security feature
     becomes host-exclusive, contradicting the reason it exists (FR-W2-006, US3).
     The seam never gets defined in the layer that owns capabilities, so a later
     "lift it into the framework" extraction is forced — a painful refactor of a
     shipped, security-critical authority path with live token flows, done under
     worse conditions than now.

2. **Define the `CapabilityBroker` port + a pass-through default in the framework;
   put the Keycloak/Entra implementation only in the host (chosen).**
   - Pros: The authority seam lives where capabilities live, so any embedder can
     supply a broker. The pass-through default reproduces today's behavior exactly
     and *is itself the migration path* — zero-regression by construction. The
     provider-specific code stays out of the framework (no Keycloak/Entra import,
     type, or string literal crosses the boundary).
   - Cons: Two artifacts to maintain (port + default) instead of one inline change.
     A second, host-only concrete broker must be kept in lockstep with the port's
     contract.

3. **Ship the Keycloak broker in the framework directly (or in a mandatory adapter).**
   - Pros: Every embedder gets the live broker out of the box.
   - Cons: Forces a concrete identity provider on every framework consumer,
     violating FR-W2-004 and defeating the whole point of a substrate-agnostic
     seam. Couples the framework to Keycloak/Entra operational concerns. Rejected.

## Decision

**The `CapabilityBroker` port and a zero-regression pass-through default live in
`@fuguejs/framework`; the live Keycloak/Entra broker lives only in the host.**

### The port (framework)

`packages/framework/src/types/capability-broker.ts` defines the authority seam in
the same layer as `CapabilityHandle`. The two axes are deliberately orthogonal:

- `CapabilityHandle` owns **lifecycle** (`connect`/`close`/`healthCheck`,
  connection pools) — BOOT-scoped, opened once, shared across runs. The broker
  does not touch it (FR-W2-005).
- `CapabilityBroker` owns **authority** — per node / run / identity.

The port is a single method over named types:

```ts
interface CapabilityBroker {
  mintFor(
    inv: Invocation,
    requires: readonly Capability[],
  ): Promise<Result<ScopedCapabilityHandle, FrameworkError>>;
}
```

- `Invocation` carries the correlation triple (`runId`/`dagId`/`nodeId`) and an
  `InvocationOrigin` discriminated union — `{ kind: "agent" }` or
  `{ kind: "user" }`, never an ambiguous blend. The pass-through default ignores
  `origin` entirely; later brokers use it to select the authority strategy.
- `ScopedCapabilityHandle = Partial<{ readonly [K in Capability]: CapabilityRegistry[K] }>`
  mirrors `extractClients`' output shape, so a broker drops in wherever a static
  client record was consumed.
- Errors flow on the `Result` channel as `FrameworkError`, never thrown across
  the boundary.
- `mintFor` is `async` because real brokers reach a token endpoint; the default
  resolves synchronously-wrapped (no I/O).

**Invariant — provider-agnostic boundary (FR-W2-004):** neither the port nor the
pass-through default references Keycloak or Entra — no import, no type name, no
string literal. Verified: a grep for `keycloak`/`entra` across
`capability-broker.ts` and `passthrough-broker.ts` returns nothing.

### The pass-through default (framework)

`packages/framework/src/shared/passthrough-broker.ts` ships
`createPassthroughBroker(clients)`. Its `mintFor` resolves to `ok(clients)` for
every invocation — **the same object reference it was constructed with, never a
copy** — ignoring both `inv` and `requires`:

```ts
export const createPassthroughBroker = (
  clients: ScopedCapabilityHandle,
): CapabilityBroker => ({
  mintFor: (_inv, _requires) => Promise.resolve(ok(clients)),
});
```

This reproduces today's behavior exactly: the host's `extractClients` output was
previously passed straight to `makeNodeContext`; routing it through this broker
changes nothing observable (byte-identical client references — SC-005). It mints
nothing and makes zero token requests (SC-008 satisfied trivially). **The default
broker IS the migration path** — every DAG/embedder compiling today keeps working
with no migration step (FR-W2-002/003, US3).

### The live broker (host only — FR-W2-006)

`packages/host/src/adapters/keycloak-broker.ts` implements the same
`CapabilityBroker` port against Keycloak + Entra WIF. It dispatches on
`invocation.origin.kind` (agent → `client_credentials`; user → Token Exchange
V2), runs a local fail-closed policy gate that refuses unassigned scopes
**before any Entra call**, mints/exchanges tokens through injected endpoints with
a pure `(identity, audience, scope)`-keyed cache, and returns operation-narrowed
handles that expose only the named operation (no raw client/token reachable). All
of this — every Keycloak and Entra type — lives under `packages/host` and never
crosses into the framework.

### Rule of Three

The live broker stays in the host. An optional `@fuguejs/keycloak-broker` adapter
package is extracted **only if a second Keycloak-using embedder appears** — not
preemptively. One consumer is not a pattern; a shared package now would be
speculative generality maintained on faith.

## Consequences

**Positive:**

- The flagship security feature is available to every framework consumer, not
  just the host: any embedder supplies its own `CapabilityBroker` over the same
  port (US3, FR-W2-006).
- Zero-regression is guaranteed *by construction*, not by test diligence — the
  default broker hands back byte-identical references, so the unchanged path is
  literally unchanged (FR-W2-002/003, SC-005).
- The framework stays substrate-agnostic: no Keycloak/Entra coupling crosses the
  boundary (FR-W2-004), so non-Keycloak embedders are first-class.
- Lifecycle and authority are cleanly separated — pools stay boot-scoped and
  untouched while authority becomes per-invocation (FR-W2-005).
- The painful "lift host code into the framework later" extraction is avoided:
  the seam is defined correctly the first time.

**Negative:**

- Two framework artifacts (port + default) plus a host implementation must be
  kept in lockstep with the port's contract; a change to `mintFor`'s signature
  touches all three.
- The provider-agnostic boundary is enforced by convention and a grep, not by the
  type system — a future contributor could import a provider type into the
  framework broker files. Mitigated by the explicit FR-W2-004 markers in both
  files and this ADR's stated invariant.
- A framework-only embedder that wants live identity-scoped capabilities must
  supply its own broker; the framework ships only the pass-through default. This
  is the deliberate trade for substrate-agnosticism, and the Rule-of-Three note
  records when (and only when) a reusable adapter gets extracted.
