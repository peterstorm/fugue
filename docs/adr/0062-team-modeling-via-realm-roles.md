# ADR-0062: Team modeling via realm roles (role name == team name)

> **Consolidated reference:** the live, end-to-end team-security picture this decision feeds into lives in [`docs/team-security-and-capabilities.md`](../team-security-and-capabilities.md). This ADR remains the immutable "why".

## Status

Accepted

## Date

2026-06-16

## Context

A user-initiated run is authorized by team membership: the host checks the run's
DAG-owning team against the user's teams (FR-021), and a user not in a DAG's team
is denied **before** any concurrency is acquired (SC-005). The host already models
this on the inbound side — `RealmJwtClaims.teams: readonly string[]`, the
stateless `canAccessDag` user branch (`packages/host/src/domain/auth.ts`). What
was missing was the realm-side plumbing that puts the user's team memberships on
the token in the first place: the `fugueplatform` realm brokers the mother-company
Entra tenant, and "which teams is this user in?" originates as Azure AD **group**
membership (a set of group GUIDs) in the federated identity, not as a `teams`
list the host can read.

The decision this ADR settles is the *realm construct* that represents a team —
the Keycloak primitive the IdP join writes into, and the source the `teams`
protocol mapper reads out of when emitting the multi-valued `teams` claim
(FR-020, FR-051). Keycloak offers two natural candidates, **realm roles** and
**realm groups**, and both can feed a `teams` claim through a protocol mapper;
the spec carried this as an explicit open question for design to resolve. The
forces at play:

- **Config-as-code weight.** The `fugueplatform` realm is governed declaratively
  in `keycloakConfigAsCode` — steps, a golden-export test, PR review. The team
  primitive should be the lightest construct that emits a clean, golden-testable
  claim, not the one that drags the most provisioning surface.
- **Reuse of shipped machinery.** The realm toolbox already provides
  `IdpPlanBuilder.claimToRoleMapper` (Azure group GUID → realm role) and the
  `oidc-usermodel-realm-role-mapper` protocol mapper. A team model that reuses
  these adds the least new code.
- **Greenfield namespace.** `fugueplatform` is a fresh realm with no pre-existing
  realm roles. The realm-role-mapper emits **all** realm roles into the claim, so
  whatever the realm-role namespace contains *is* the `teams` claim — undivided.
- **Claim shape invariants.** The `teams` claim must be multi-valued and
  **access-token-only** (out of the ID token, FR-051), so the host reads it from
  the access token and a relying frontend cannot mistake it for an authentication
  assertion.

## Options Considered

1. **Realm roles, role name == team name** (chosen)
   - One realm role per team (`business-sales`, …). The Azure IdP join maps each
     team's group GUID to its realm role via `claimToRoleMapper`; a single
     `oidc-usermodel-realm-role-mapper` emits all realm roles as the multi-valued
     `teams` claim.
   - Pros: reuses already-shipped toolbox machinery (`claimToRoleMapper` + the
     realm-role-mapper) — minimal new config. In a greenfield realm whose
     realm-role namespace is **reserved for teams**, "all realm roles" and "all
     teams" are the same set, so a single role-mapper emits exactly `teams` with
     no per-team mapper bookkeeping. The role name round-trips the team name, so
     the host's `dagTeam` string, the realm role, and the `teams` claim entry are
     one token end-to-end — no translation table.
   - Cons: the role-mapper emits *every* realm role, so the model's correctness
     rests on the convention that the realm-role namespace stays team-only — a
     future non-team realm role would leak into `teams`. Mitigated by reserving
     the namespace (asserted in `ValidationStep` / the golden test, flagged in the
     realm README) and by the group-membership escape hatch below.

2. **Realm groups as the primary model**
   - Model each team as a realm group; the Azure join maps group GUID →
     membership; a group-membership mapper emits `teams`.
   - Pros: groups model membership more precisely and carry their own attribute
     bag; a group-membership mapper is naturally scoped to group names, so an
     unrelated realm role can never leak into the claim.
   - Cons: heavier config-as-code (group hierarchy + a distinct membership mapper)
     for no behavioural benefit *while the realm-role namespace is reserved* — the
     host consumes a flat `teams: string[]` either way. Does not reuse the
     already-shipped `claimToRoleMapper` path, so it adds new realm machinery to
     buy precision the greenfield namespace already provides. Retained as the
     documented **escape hatch**, not the primary model.

## Decision

**Model teams as realm roles with role name == team name; map each team's Azure
group GUID to its realm role and emit all realm roles as the multi-valued,
access-token-only `teams` claim.** Keep realm **groups** as the documented escape
hatch should non-team realm roles ever need to coexist.

Concretely (cross-repo, `~/dev/java/keycloakConfigAsCode`, package
`dk.secondbrand.keycloak.configuration.fugueplatform`):

- **`RolesStep` (new).** Declares one realm role per team, role name == team name
  (e.g. `business-sales`). The realm-role namespace is **reserved for teams** —
  this is the load-bearing invariant the model rests on.
- **`AzureIdpStep` (new).** Brokers the `azuread` IdP and, per team, declares a
  `claimToRoleMapper("groups", <env group GUID>, "<team>")` with `forceSync`, so
  the user's Azure `groups` membership is projected onto the matching team realm
  role at each sign-in. The first cohort seeds exactly one team, `business-sales`;
  the builder and golden test are written for **N** teams.
- **`teams` protocol mapper** (`ClientScopesStep`, on the `fugue-frontend` client
  scope). A single `oidc-usermodel-realm-role-mapper` with `multivalued: true`,
  `access.token.claim: true`, `id.token.claim: false`, `claim.name: teams`,
  `jsonType.label: String`. Access-token-only keeps `teams` out of the ID token
  (FR-051); because the realm-role namespace is team-only, "all realm roles" *is*
  `teams`.
- **Wiring + tests.** Both new steps are wired into
  `FuguePlatformRealmConfiguration.STEPS`; `ValidationStep` asserts the team roles
  and the `teams` mapper config are present; `FuguePlatformRealmGoldenTest`
  asserts the emitted `teams` claim is multi-valued and access-token-only and that
  the agent client scopes mirror permissions (FR-053, SC-008).
- **Per-env, not hardcoded.** The team → Azure-group-GUID map is
  **per-environment configuration** (mirroring `azureConfig.adminGroupId()`), not
  baked into source — GUIDs stay out of the repo and additional teams are added by
  config, no code change.
- **Host side (unchanged by this ADR, the consumer).** The host reads the claim as
  `RealmJwtClaims.teams` and authorizes via `canAccessDag` /
  `authorizeUserRun = (u, dagTeam) => u.teams.includes(dagTeam)`
  (`packages/host/src/domain/auth.ts`). The host is agnostic to whether the realm
  sourced `teams` from roles or groups — which is exactly what makes the escape
  hatch a realm-only change.
- **Escape hatch.** If a non-team realm role ever needs to exist, switch the
  `teams` claim from the realm-role-mapper to a **group-membership mapper** and
  point the Azure join at group membership instead of `claimToRoleMapper`. This is
  a localized change to one protocol mapper plus the IdP join mapper — **no host
  change**, because the host already consumes a flat `teams: string[]`.

## Consequences

**Positive:**

- Reuses the already-shipped `claimToRoleMapper` + `oidc-usermodel-realm-role-mapper`
  toolbox — the least new realm config to put `teams` on the access token.
- The team name is one token end-to-end: the realm role, the `teams` claim entry,
  and the host's `dagTeam` membership check are the same string, with no mapping
  table to drift (mirrors the shared-vocabulary property ADR-0057 established for
  scope names).
- Access-token-only emission keeps `teams` out of the ID token (FR-051), so a
  relying frontend cannot mistake the membership list for an authentication claim;
  the golden test pins this shape (SC-008).
- The team → group-GUID roster is per-env config, so onboarding a new team
  (beyond the seeded `business-sales`) is a config change, not a source change,
  and no environment GUID is committed.
- The decision is realm-local: the host's inbound authz (ADR-0058) consumes a flat
  `teams: string[]` and is unaffected by the realm's choice of construct, which is
  what makes the group escape hatch a one-sided change.

**Negative:**

- The model's correctness depends on the realm-role namespace staying **team-only**
  — the role-mapper emits *every* realm role, so a future non-team realm role would
  silently leak into `teams`. Mitigated, not eliminated: `ValidationStep` / the
  golden test and the realm README guard the convention, and the group escape hatch
  is the documented exit if the convention can no longer hold.
- Realm groups remain available but are deliberately **not** the primary model;
  adopting them later is a deliberate migration of one mapper + the IdP join, not a
  free toggle (though it stays host-transparent).
- Each new team is two coordinated realm edits — the `RolesStep` role and the
  `AzureIdpStep` per-team `claimToRoleMapper` — plus its per-env group GUID; this is
  the accepted cost of keeping GUIDs out of source and the namespace explicit.

## Related

- ADR-0058 — two-path inbound host auth; the host side consumes the `teams` claim
  this decision emits (`canAccessDag` / `authorizeUserRun`).
- ADR-0057 — Keycloak optional client scopes mirror downstream permissions; the
  same `fugueplatform` config-as-code + golden-test governance gate, and the same
  shared-vocabulary (claim name == domain term) property.
- ADR-0061 — per-team DAG image scoping; the team identity this claim authorizes
  against is the same `fugue.yaml` `team` / top-level `dags/{team}/` unit.
