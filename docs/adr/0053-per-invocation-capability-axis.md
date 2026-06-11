# ADR-0053: Per-Invocation Capability Axis (`mintFor`)

## Status

Accepted — **amends [ADR-0051](./0051-extensible-capability-registry.md)** (Extensible Capability Registry).

ADR-0051 opened the capability system along the *registry* axis (capability name → client type) and the *lifecycle* axis (`CapabilityHandle.connect`/`close`/`healthCheck`, boot-scoped connection pools). This ADR adds a third, orthogonal axis — *authority*, resolved per node invocation — without touching either of the first two. It also authorizes the change to the `extractClients` trust-boundary doc-comment that ADR-0051's design left forbidden "for today's design."

## Context

ADR-0051's capability system resolves a node's `requires` declaration into a static client record once, at boot: `extractClients` correlates each `CapabilityHandle<K>.name` to its `CapabilityRegistry[K]` client, and that record is shared verbatim across every run, every node, every caller. There is exactly one authority — a boot-time, full-privilege credential per capability — and every invocation gets the same one.

The identity-scoped capabilities effort needs authority to vary along axes the boot lifecycle cannot express:

- **Per node** — a node declaring `requires: ["msgraph:mail.send"]` should receive authority narrowed to that operation, not a god-credential.
- **Per run** — a user-initiated run must carry the initiating user's identity downstream; an autonomous/cron run must not.
- **Per identity** — agent-initiated hops mint as the agent's own client; user-initiated hops preserve the user `sub` while the agent becomes `azp`.

Two forces pull against each other. **Authority must change per invocation**, but **connection pools must not churn per invocation** — opening a pool per call is a network-cost regression and would violate the proven boot lifecycle ADR-0051 established (FR-W2-005). The boot lifecycle is correct as-is; the problem is that it is the *only* axis, so the only way to vary authority today is to vary the pool, which conflates two concerns that have different cadences.

A second, smaller force: ADR-0051's `extractClients` carries a load-bearing trust-boundary cast and a doc-comment that explicitly says "Keep every such cast here — do not introduce a second correlation point." The new authority seam consumes that correlated record at a *different* point than `extractClients` produces it. That doc-comment must change. The spec (FR-W2-008, SC-005, US3 acceptance) requires this change to be recorded in an ADR amending ADR-0051 — not slipped in as a silent comment patch.

## Options Considered

1. **Per-invocation pool creation — vary authority by reopening the connection.**
   - Pros: No new abstraction; authority and connection live together as they do today.
   - Cons: Opens a connection pool per node invocation — a direct network-cost regression and a violation of FR-W2-005 (pools MUST stay boot-scoped). Discards the proven ADR-0051 boot lifecycle to bolt authority onto the wrong cadence. Conflates two concerns (lifecycle vs. authority) that change at different rates.

2. **Add a separate per-invocation authority axis (`CapabilityBroker.mintFor`) — chosen.**
   - Pros: Preserves the boot lifecycle untouched (pools stay boot-scoped, FR-W2-005). Authority becomes a first-class, invocation-scoped concern resolved by a dedicated port. A pass-through default makes the migration byte-identical and zero-step (US3, SC-005). A token cache keyed on `(identity, audience, scope)` keeps minting cheap (FR-W2-007).
   - Cons: A new port and a new trust-boundary correlation point to reason about. The `extractClients` cast is no longer the sole consumption site — its doc-comment invariant must be amended (which is *this ADR*, not a patch).

3. **Silently edit the `extractClients` doc-comment instead of writing an ADR.**
   - Pros: Less ceremony.
   - Cons: Violates FR-W2-008 and SC-005, which require the trust-boundary change to be documented in an ADR amending ADR-0051. ADR-0051's own comment forbids a second correlation point "for today's design"; reversing that is an architectural decision that must be recorded, not buried in a diff. **Rejected on spec grounds.**

## Decision

**Add a per-invocation *authority* axis to the capability system via a new `CapabilityBroker.mintFor(invocation, requires)` port, leaving the ADR-0051 boot lifecycle entirely untouched; document the resulting `extractClients` trust-boundary shift in this ADR (which amends ADR-0051).**

### Three axes, cleanly separated

The capability system now has three orthogonal axes, and no axis touches another:

| Axis | Owner | Scope | Defined in |
|---|---|---|---|
| Registry (name → client type) | `CapabilityRegistry` | compile-time | ADR-0051 |
| Lifecycle (`connect`/`close`/`healthCheck`, pools) | `CapabilityHandle<K>` | **BOOT** | ADR-0051 |
| **Authority** (who may use what, narrowed) | **`CapabilityBroker`** | **per invocation** | **this ADR** |

`SharedInfra.capabilities`, `connectAll`/`closeAll`/`checkHealth`, and connection pools stay **boot-scoped and untouched** (FR-W2-005). A pool is opened once at boot and shared across every run; the broker never calls `connect`/`close`, and a `CapabilityHandle` never varies authority per call. The axis note is recorded directly in `capability-handle.ts` and `capability-broker.ts`.

### The port (`@fuguejs/framework`)

`packages/framework/src/types/capability-broker.ts` defines:

- **`Invocation`** — identity + correlation for one node invocation: `{ origin, runId, dagId, nodeId }`. `origin` is a discriminated union, not optional fields:
  - `{ kind: "agent"; agentClientId }` → `client_credentials`,
  - `{ kind: "user"; sub; agentClientId }` → Token Exchange V2 (preserving `sub`, `azp = agent`).
- **`ScopedCapabilityHandle`** — `Partial<{ readonly [K in Capability]: CapabilityRegistry[K] }>`, deliberately mirroring `extractClients`'s output shape so a broker drops in wherever a static client record was consumed.
- **`CapabilityBroker.mintFor(inv, requires): Promise<Result<ScopedCapabilityHandle, FrameworkError>>`** — resolves the scoped client set an invocation is *authorized* to use. `async` because real brokers reach a token endpoint; errors flow on the `Result` channel, never thrown across the boundary.

The port lives in the framework (the same layer as `CapabilityHandle`); the Keycloak/Entra *implementation* lives only in the host (FR-W2-006). Neither the port nor the default references any identity provider (FR-W2-004). The framework ships a **pass-through broker** (`shared/passthrough-broker.ts`) that ignores `origin` and hands back the statically-configured clients byte-identically — that default **is** the migration path (US3, FR-W2-003, SC-005): every DAG/embedder that compiles and runs today does so unchanged, zero migration steps, no feature flag. (Broker layering and the pass-through default are detailed in ADR-0054; this ADR covers the *axis* and the trust-boundary shift.)

### The host shell — minting + token cache

`packages/host/src/adapters/keycloak-broker.ts` implements `CapabilityBroker` as the host Policy Enforcement Point. Per resolution it: parses each `requires` name to a `DownstreamScope` (parse-don't-validate), runs a local **fail-closed policy gate** (an unassigned scope is `policy-refusal` with **zero** Entra egress — the gate always precedes any cache read or endpoint call, SC-006/FR-W3-003), then mints via `client_credentials` (agent) or Token Exchange V2 (user), and wraps the result in an operation-narrowed handle exposing only the named operation — no raw client, no token field reachable (SC-007).

Per FR-W2-007, a **token cache keyed on `(identity, audience, scope)` with TTL safely under token lifetime lives in the shell next to the minting** — at most one token request per triple per TTL window (SC-008). As built, the shell holds **two** such cache cells reusing the same pure `token-cache` module: the Keycloak SA-token cache and the Entra app-only-token cache. The second cell exists because the WIF exchange is *itself* a token request — caching only the SA token would leak a fresh WIF egress on every resolution and violate SC-008's "at most one token request per triple per TTL window." An app-only cache hit short-circuits both egresses. The cache *values* and their freshness decisions stay pure; only the mutable cells and the injected clock (`now`) live in the shell. **A cache miss is not an error — it triggers a mint** (FR-X-003).

### The `extractClients` trust-boundary shift (the amendment to ADR-0051)

ADR-0051 designated `extractClients` (`packages/host/src/domain/capability-manager.ts`) as the *single* point restoring the per-handle `name ↔ client` correlation that is erased when `CapabilityHandle<K>` is widened to `readonly CapabilityHandle[]`, via the cast on its return. Its doc-comment said: *"Keep every such cast here — do not introduce a second correlation point."*

This ADR amends that. The authority seam now consumes the already-correlated record at a per-request point (the broker's `mintFor`). Concretely:

- `extractClients` **still** performs the cast **once**, at boot, producing the correlated record. Moving *consumption* to the broker seam did **not** add a second correlation point — the cast happens once and the broker receives the already-correlated record.
- The keycloak-broker assembles its `ScopedCapabilityHandle` with a structurally identical trust-boundary cast (`handleRecord as ScopedCapabilityHandle`) at a **per-request correlation point**, mirroring `extractClients`. This is the per-invocation analogue ADR-0051's comment forbade for the boot-only design.
- The `extractClients` doc-comment is updated to reflect this: the correlation cast remains the single *boot-time* point; the broker carries the *per-invocation* one. Adapter authors are still trusted to wire `CapabilityHandle<K>.name` to a `CapabilityRegistry[K]` client; nothing downstream re-verifies the client's structure (validation checks presence, not shape).

This change is recorded here, in an ADR amending ADR-0051, as FR-W2-008 and SC-005 require — not as a silent patch.

## Consequences

**Positive:**

- The proven ADR-0051 boot lifecycle is preserved exactly: pools open once at boot and are shared across every run; `connect`/`close`/`healthCheck` are untouched (FR-W2-005).
- Authority is now a first-class, per-invocation concern, varying per node / run / identity without churning connections.
- Zero-regression migration: the pass-through default makes existing DAGs/embedders run byte-identically with no migration steps and no flag (US3, SC-005).
- Minting is cheap and bounded: the `(identity, audience, scope)` token cache holds to ≤ 1 token request per triple per TTL window (FR-W2-007, SC-008); a miss is not an error (FR-X-003).
- The trust-boundary change is auditable: recorded in an ADR amending ADR-0051 rather than buried in a comment diff (FR-W2-008, SC-005).

**Negative:**

- There are now two structurally identical trust-boundary casts — the boot-time `extractClients` and the per-request broker assembly. ADR-0051's "single correlation point" invariant is relaxed to "one boot-time + one per-invocation point," which a future reader must hold in mind. Both are documented in-code and trusted equally (adapter authors wire `name ↔ client`; presence, not structure, is validated downstream).
- Capability resolution gains an `async`, fallible step (`mintFor` returns `Result`), where the static record was infallible. The pass-through default mints nothing and never errs, but real brokers introduce a token-endpoint dependency on the resolution path (mitigated by the cache and the fail-closed gate).
- Cache freshness correctness now depends on the configured TTL staying safely under the issued token lifetime — a deployment-time invariant the cache cannot self-enforce.
