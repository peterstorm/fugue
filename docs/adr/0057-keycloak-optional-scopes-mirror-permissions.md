# ADR-0057: Keycloak Optional Client Scopes Mirror Downstream Permissions

> **Consolidated reference:** the live, end-to-end team-security picture this decision feeds into lives in [`docs/team-security-and-capabilities.md`](../team-security-and-capabilities.md). This ADR remains the immutable "why".

## Status

Accepted

## Context

Identity-scoped capabilities require a single, authoritative answer to one
question: *is this agent allowed to use this downstream permission?* A node
declares `requires: ["msgraph:mail.send"]`; the host's `CapabilityBroker` must
decide, per invocation, whether to mint authority for that operation against
Microsoft Graph (or Dynamics) — and must refuse **before** any Entra hop when the
agent is not entitled (SC-006: zero Entra egress on a refused scope).

The forces at play:

- **One policy surface.** The grant decision must live in exactly one place,
  not split across realm roles, application code, and Entra app-permission
  consent. A reviewer approving a new agent capability must see the grant in the
  same diff as the agent code (US4, FR-W3-001).
- **Fail-closed before egress.** The refusal point must be reachable and
  decidable *locally at the Keycloak hop*, so an unentitled scope never causes a
  network call to Entra (FR-W3-003, SC-006). A policy model that can only be
  evaluated after a token reaches the downstream resource is unacceptable.
- **Config-as-code governance.** The `fugue-platform` realm is already managed by
  the `keycloakConfigAsCode` repository: declarative steps, a golden-export test,
  and PR review. The capability grant should inherit that same governance gate
  rather than introducing a second, weaker control plane (manual admin console
  clicks, runtime role assignment, or an out-of-band ACL).
- **Granularity.** The unit of grant must match the unit a node declares: one
  downstream *operation* (`mail.send`, `sites.read`, `read`). Coarser units force
  over-granting and defeat per-agent least privilege.

The problem is choosing the Keycloak construct that *is* the policy grant —
the artifact a reviewer assigns, the gate the broker enforces — for the
downstream-permission vocabulary the broker speaks.

## Options Considered

1. **Optional client scopes mirroring each downstream permission** (chosen)
   - One Keycloak optional client scope per downstream operation
     (`msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`, …), created in
     the `fugue-platform` realm's `ClientScopesStep`. Assigning a scope to an
     agent-type client in `ClientStep` *is* the grant.
   - Pros: The grant is a declarative line in config-as-code — PR-reviewed,
     golden-export-tested, same governance gate as the agent code. The broker
     requests exactly the scopes `requires` names; an unassigned scope fails the
     token request **at the Keycloak hop**, so the refusal is local and precedes
     any Entra call. Scope granularity equals node-declaration granularity. The
     scope name round-trips the `requires` string (`<provider>:<operation>`), so
     the vocabulary is shared end-to-end with no translation table.
   - Cons: Optional client scopes are a per-client list; a sprawling permission
     set grows the assignment lists on each agent client. Keycloak does not
     type-check scope names, so a typo is caught by the golden test and the
     broker's `parseScope`/`assignedScopes` gate rather than at config-author
     time.

2. **Realm roles or UMA (User-Managed Access) as the primary mechanism**
   - Model each grant as a realm role assigned to the agent's service account, or
     as a UMA resource/permission policy.
   - Pros: Roles are a first-class RBAC primitive with established tooling; UMA
     supports rich attribute-based policies and per-resource permissions.
   - Cons: Roles are coarser than per-operation scopes and do not naturally map to
     the OAuth `scope` parameter the broker already sends on the token request, so
     enforcement would move *after* token issuance instead of gating it. UMA adds a
     second policy-evaluation runtime (permission tickets, RPT exchange) whose
     decision is not necessarily resolved before egress, weakening the
     fail-closed-before-Entra invariant. Neither expresses the grant in the same
     shape the node declares, requiring a translation layer.

## Decision

**Mirror each downstream permission as a Keycloak optional client scope in the
`fugue-platform` realm; assigning the scope to an agent client in `ClientStep` is
the policy grant, and the broker requests exactly those scopes — an unassigned
scope fails fail-closed at the Keycloak hop before any Entra call.**

Concretely:

- **Scope definitions.** The `fugue-platform` realm's `ClientScopesStep`
  (`keycloakConfigAsCode`, `.../fugueplatform/steps/ClientScopesStep.java`)
  declares one optional `ClientScopeRepresentation` per downstream operation,
  named `<provider>:<operation>` — `msgraph:mail.send`, `msgraph:sites.read`,
  `dynamics:read`. The companion `entra-exchange` scope (audience mapper for
  `api://AzureADTokenExchange`) lives in the same step but is the WIF bridge, not
  a grant.
- **Grant = assignment.** `ClientStep`
  (`.../fugueplatform/steps/ClientStep.java`) assigns the subset of optional
  scopes each agent-type service-account client is entitled to. This assignment
  is the entire policy: it is a declarative line in the realm config, covered by
  `FuguePlatformRealmGoldenTest` (SC-012), and merged only through PR review — the
  same gate the agent's own code passes through.
- **Broker enforcement (the gate).** The host broker
  (`packages/host/src/adapters/keycloak-broker.ts`) holds an injected
  `assignedScopes(agentClientId): ReadonlySet<string>` resolved from the realm
  policy. For each declared capability it (1) `parseScope`s the name into a typed
  `DownstreamScope` (`packages/host/src/domain/capability-scope.ts`) — a name
  `parseScope` rejects is **not** policy-refused: the broker skips it, treating
  it as a static (non-downstream) capability the boot-scoped base context
  supplies, and if no static capability of that name exists it surfaces at
  run-start validation as `missing-capability` (mapped to HTTP 500); a typo'd
  scope name in the *policy* itself is caught earlier still, by boot-time
  `AGENT_CLIENT_SCOPES` validation in `packages/host/src/domain/config.ts` —
  then (2) for a parseable downstream scope, checks `assigned.has(scopeStr)`
  **before any cache read or endpoint call**. Only a parseable scope that is not
  in the agent's `AGENT_CLIENT_SCOPES` assignment returns
  `{ kind: "policy-refusal", scope, agentClientId }` (403) with zero egress; the
  Keycloak mint, the WIF exchange, and therefore Entra are never reached
  (FR-W3-003, SC-006). The token request the broker does send names *exactly* the
  parsed scope, so Keycloak itself also refuses an unassigned scope at the
  `client_credentials` / token-exchange hop — defense in depth at both the local
  gate and the issuer.
- **Shared vocabulary.** `scopeName(scope)` in `keycloak-broker.ts` round-trips
  `parseScope`, so the node's `requires` string, the Keycloak scope name, the
  cache key, and the audit `scope` field are one and the same token — no mapping
  table to drift.

`parseScope`'s parse-don't-validate construction (the only constructor of a
`DownstreamScope`) plus the `assignedScopes` set are the two halves of the policy:
the first bounds the *vocabulary* to recognized operations (an out-of-vocabulary
name is deferred to run-start `missing-capability`, and rejected at boot when it
appears in `AGENT_CLIENT_SCOPES`), the second bounds the *grant* to assigned
ones — and only the grant half refuses with the non-retryable `policy-refusal`
category, distinct from `infra-unreachable` and `downstream-denied`.

## Consequences

**Positive:**

- The capability grant is config-as-code with the identical review and golden-test
  gate as the agent code — one policy surface, one diff, one approval (US4,
  FR-W3-001).
- Refusal is local and pre-egress: an unentitled scope is denied at the Keycloak
  hop with zero Entra calls, asserted by the broker's no-egress test (FR-W3-003,
  SC-006).
- Scope granularity equals node-declaration granularity, enabling true per-agent
  least privilege without over-granting.
- The `<provider>:<operation>` name is shared verbatim across `requires`, the
  Keycloak scope, the cache key, and the audit record — no translation layer to
  maintain or to drift out of sync.
- Defense in depth: both the broker's local `assignedScopes` gate and Keycloak's
  own scope validation on the token request refuse an unassigned scope.

**Negative:**

- Per-client optional-scope assignment lists grow with the permission catalog;
  a large fleet of downstream operations makes the agent-client config verbose.
- Keycloak does not type-check scope names; a typo in a scope definition or
  assignment is caught only by the golden-export test and the broker's
  parse/assignment gate, not at config-author time.
- Realm roles and UMA remain available but are deliberately *not* the primary
  grant mechanism; teams wanting attribute-based or coarser-grained controls must
  compose them *on top of* the scope mirror, accepting that the scope assignment is
  still the authoritative per-operation grant.
- A new downstream operation requires three coordinated edits — a scope
  definition, the per-client assignment, and `parseScope`'s recognized-operation
  union — before the broker will mint for it; this is the accepted cost of
  fail-closed, vocabulary-bounded authority.

## Rejected Alternatives

- **Realm roles / UMA as the primary grant mechanism.** Rejected as the *primary*
  control because both are coarser than per-operation scopes, do not map to the
  OAuth `scope` parameter the broker already sends (moving enforcement after token
  issuance rather than gating it), and — in UMA's case — introduce a second policy
  runtime whose decision is not guaranteed before egress, weakening the
  fail-closed-before-Entra invariant. They **compose with, not replace,** the scope
  mirror: a deployment may layer roles or UMA policies for additional, coarser
  controls, but the optional-client-scope assignment remains the authoritative
  per-operation grant the broker enforces.
