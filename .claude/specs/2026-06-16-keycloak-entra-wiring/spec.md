# Feature: Keycloak/Entra Capability-Broker Wiring

**Spec ID:** 2026-06-16-keycloak-entra-wiring
**Created:** 2026-06-16
**Status:** Draft
**Owner:** Peter Hansen (hello@dotslash.dev)

## Summary

The fugue host already contains the complete *pure core* for identity-scoped
capabilities — the capability broker, JWT validation, token cache, audit, scope
narrowing, and ports — all merged (PRs #16/#17) and fail-closed. What it cannot
yet do is mint a single real downstream token: the live HTTP adapters, config,
and realm-side claim plumbing are absent, so every secured path 401s or refuses
by omission. This feature is the **additive wiring** that lights up the two run
origins end-to-end (agent-initiated → Keycloak `client_credentials` → Entra WIF;
user-initiated → realm JWT → RFC 8693 token exchange) plus the HITL go-live and
per-team approver authorization. It spans two repositories: `fugue` (the host,
TypeScript) and the `fugueplatform` realm config-as-code
(`~/dev/java/keycloakConfigAsCode`, Java).

The canonical design is `docs/team-security-and-capabilities.md` (§4 target, §5
gap, §7 phases); the ADRs (0051–0061) are the immutable "why". This spec captures
WHAT must be true when the wiring is done and WHY, not HOW.

---

## User Scenarios

### US1: [P1] Foundations available for every secured path (Phase 0)

**As an** operator deploying a team's host
**I want** the Entra/Keycloak configuration, transports, JWT verifier, and a
documented `.env.example` to exist and be safe-by-default
**So that** later paths can be switched on independently and a misconfigured host
fails closed rather than silently insecure.

**Why this priority:** Both the agent path and the user path depend on these
foundations; nothing else can land without them.

**Acceptance Scenarios:**
- Given a host booted with **no** Entra/Keycloak config, When it starts, Then it
  boots successfully on the existing static capability path with behaviour
  byte-identical to today (zero regression).
- Given a host booted with **partial** config (e.g. realm issuer but no agent
  credentials), When it starts, Then it boots, emits exactly one boot warning
  naming what is unwired, and the unwired path remains fail-closed.
- Given a fresh checkout, When a developer reads `.env.example`, Then every
  Entra, Keycloak, Bot, and HITL variable is present with an explanatory comment.

### US2: [P1] Agent-initiated run reaches a scoped downstream capability (Phase 1)

**As a** scheduled/autonomous DAG running with no human subject
**I want** to request a declared capability (e.g. send mail) and receive a
narrowly-scoped handle
**So that** the node can perform exactly the operation it declared, and nothing
more, without ever holding a credential.

**Why this priority:** This is the core capability-broker promise and the first
end-to-end mint.

**Acceptance Scenarios:**
- Given an agent run whose DAG declares `requires: ["msgraph:mail.send"]` and
  whose agent client is granted that scope, When the node executes, Then it
  receives a handle exposing only `sendMail` and the mail is sent.
- Given an agent run that declares a capability **not** granted to its client,
  When the broker attempts to mint, Then the request is refused at the Keycloak
  hop with **zero** egress to Entra, and the refusal is audited.
- Given the node holding a capability handle, When it inspects the handle, Then
  no raw token or broad client is reachable from it.

### US3: [P1] User-initiated run is authenticated and authorized per team (Phase 2)

**As a** human triggering a DAG via the BFF
**I want** my realm-issued token verified and my team membership checked against
the DAG I'm invoking
**So that** I can only run DAGs owned by a team I belong to.

**Why this priority:** Opens the user origin; required before any user-scoped
downstream exchange.

**Acceptance Scenarios:**
- Given a valid realm JWT carrying my team membership, When I invoke a DAG owned
  by one of my teams, Then the run is authorized.
- Given a valid realm JWT, When I invoke a DAG owned by a team I do **not** belong
  to, Then the run is denied **before** consuming any concurrency.
- Given a JWT-shaped token while the verifier is not yet wired, When I present it,
  Then it is rejected (fail-closed), never accepted unverified.
- Given an opaque `fug_` team token, When I present it, Then it resolves on the
  existing team path unchanged (no regression).

### US4: [P2] User-initiated run reaches downstream as the user (Phase 3)

**As a** human-triggered DAG node
**I want** my downstream access to be exchanged from my verified identity
**So that** downstream calls are attributable to me (`sub`) via the requesting
agent (`azp`) and scoped to what I'm entitled to.

**Why this priority:** Completes the user origin; depends on both US2 and US3.

**Acceptance Scenarios:**
- Given an authorized user run, When a node requests a capability, Then the
  downstream token preserves the user as `sub` and the agent as `azp`.
- Given the exchange path with no resolvable verified user token for the run,
  When the broker attempts to exchange, Then it fails closed (no proof-less
  impersonation is ever issued).
- Given an entitled `Sites.Selected` site, When the user run reads it, Then it
  succeeds; a non-entitled site returns a downstream-denied result.

### US5: [P2] HITL approvals are authorized per team (Phase 4)

**As a** team lead approving a suspended DAG in Teams
**I want** only members of the run's owning team to be able to approve it
**So that** one channel's members cannot approve another team's runs.

**Why this priority:** Closes a real cross-team authorization gap in the
already-shipped HITL button path; not blocking the capability story.

**Acceptance Scenarios:**
- Given a suspended run owned by team A, When a member of team A clicks
  approve/reject in Teams, Then the decision is recorded.
- Given the same run, When a non-member of team A clicks approve/reject, Then the
  decision is refused (parity with the HTTP approve path).

### US6: [P2] Live verification against a real tenant (Phase 5)

**As an** operator going to production
**I want** the Entra provisioning runbook executed with checkable acceptance and
the federation surface proven secretless
**So that** I can trust the live security posture.

**Acceptance Scenarios:**
- Given the provisioned `fugue-agents` app, When its credentials are inspected,
  Then there are zero client secrets and zero certificates (federation only).
- Given the four verification spikes, When each is run against the live tenant,
  Then each records a PASS (or PARTIAL with a documented fallback) before any
  gated step is trusted.

---

## Functional Requirements

### Foundations (Phase 0)

- FR-001: The host MUST accept Entra tenant/client identifiers, Keycloak agent
  client credentials, and a Dynamics organization host as configuration, and MUST
  reject internally-inconsistent combinations (e.g. tenant without client) at
  boot.
- FR-002: The host MUST provide a live transport for OAuth form-POST exchanges
  (Keycloak + Entra) and a live transport for downstream Graph calls.
- FR-003: The host MUST be able to verify a realm JWT's signature against the
  realm's published keys, leaving issuer/audience/expiry validation to the
  existing pure claim validator.
- FR-004: The host MUST resolve a per-agent-client credential by client identity,
  and a miss MUST be fail-closed (no egress).
- FR-005: `.env.example` MUST document every Entra, Keycloak, Bot, and HITL
  variable with comments.

### Agent path (Phase 1)

- FR-010: The host MUST mint a Keycloak service-account token for an agent client
  via client-credentials and exchange it for an app-only downstream token via
  workload identity federation.
- FR-011: The broker MUST select the live adapter for each leg **only when that
  leg's configuration is present**, and otherwise retain the fail-closed stub —
  no single global enable flag.
- FR-012: A capability the agent client is not granted MUST be refused at the
  Keycloak hop with zero downstream (Entra) egress.

### User inbound path (Phase 2)

- FR-020: The realm JWT MUST carry the user's team membership as a multi-valued
  claim, and the host MUST parse it defensively (fail-closed on malformed).
- FR-021: The host MUST authorize a user run by checking the run's DAG-owning
  team against the user's team membership, with the authorization decision a
  required (non-optional, non-defaultable) part of wiring the user path.
- FR-022: The user authorization decision MUST be stateless — derived from the
  verified token, with no per-request datastore lookup.
- FR-023: The existing admin and `fug_` team paths MUST continue to work
  unchanged.

### User downstream exchange (Phase 3)

- FR-030: For user-initiated runs, the host MUST present the user's actual
  verified token as proof when exchanging for a downstream token; it MUST NOT
  issue a proof-less token merely asserting a subject.
- FR-031: The exchanged downstream token MUST preserve the user as subject and
  the agent as authorized party.
- FR-032: The verified user token MUST be threaded host-side only (never across
  the framework port / never on the framework invocation origin).

### Hardening (Phase 4)

- FR-040: DAG identity MUST resolve to the real Keycloak agent client via
  configuration (replacing the current identity-function placeholder).
- FR-041: The HITL approval button path MUST authorize the approver against the
  run's owning team, at parity with the HTTP approve path.
- FR-042: The Dynamics/Dataverse capability MUST target the configured per-org
  host (replacing the hardcoded placeholder) and be scoped to read.

### Realm config-as-code (cross-repo, gates Phase 2 + Phase 5)

- FR-050: The `fugueplatform` realm MUST broker the mother-company Entra tenant
  and map the relevant Azure groups to realm roles representing teams.
- FR-051: The realm MUST emit the user's team membership as a multi-valued
  `teams` claim on the **access token only** (not the ID token).
- FR-052: Agent-type clients MUST be confidential service-account clients each
  carrying the optional scope that mirrors its downstream Entra permission, where
  assigning the scope **is** the policy grant.
- FR-053: The realm changes MUST be golden-export tested (the emitted claim/scope
  structure asserted).

---

## Non-Functional Requirements

### Security (the invariants that must stay green)

- NFR-010: A refused capability request MUST produce zero downstream egress
  (SC-006).
- NFR-011: No raw token or broad client MUST be reachable from a capability
  handle (SC-007).
- NFR-012: The `fugue-agents` Entra app MUST hold zero static secrets and zero
  certificates — federation is the only credential (SC-011).
- NFR-013: Identical capability requests within a token's lifetime MUST be
  de-duplicated by `(identity, audience, scope)` (SC-008) — per-invocation
  *authority* MUST NOT mean per-invocation *network calls*.
- NFR-014: Sensitive configuration (agent client secrets, tokens) MUST never be
  logged.

### Reliability

- NFR-020: Every adapter failure mode (transport unreachable, JWKS down, 4xx)
  MUST map to a typed result in the existing failure taxonomy — no bare throws,
  no swallowed errors.

---

## Success Criteria

- SC-001: A host with no security config boots and runs DAGs with behaviour
  byte-identical to the pre-wiring baseline (verified by existing host tests).
- SC-002: `bun run typecheck` and `bun test packages/host` pass, including the
  six SC-invariant tests (SC-006/007/008/010/011/012).
- SC-003: The project linter passes with zero violations (no bare throw, no
  catch-ignore, no `as any`, no raw-string ids).
- SC-004: An agent run with a granted scope sends mail end-to-end; an
  un-granted scope is refused with zero Entra egress (confirmed in the audit log).
- SC-005: A user not in a DAG's team is denied before concurrency acquisition
  (property-tested: any user ∉ team ⇒ access denied).
- SC-006: A non-member's HITL button click is refused (parity with HTTP path).
- SC-007: Post-provisioning, `fugue-agents` shows 0 secrets / 0 certs; all four
  spikes recorded PASS or PARTIAL-with-fallback.
- SC-008: The `fugueplatform` golden-export test asserts the `teams` claim is
  multi-valued, access-token-only, and the agent client scopes mirror permissions.

**Measurement approach:** unit/property/integration tests with recorded-call
fakes (no live network) for the host; golden-export test for the realm; manual
runbook acceptance + sign-in-log evidence for the live tenant phase.

---

## Out of Scope

- Per-team client resolution inside one host (deliberately rejected — host = team
  = trust boundary).
- A secret store (Vault / Azure Key Vault) adapter — the env-map behind the
  `AgentClientCredentials` port is acceptable for v1; the port keeps it swappable.
- git-sync subdir/sparse-checkout scoping (baked-image per-team path is the
  supported mechanism; git-sync scoping remains unbuilt).
- RFC 8693 `act`-claim delegation chains (Keycloak does not support it yet;
  identity is preserved via `sub`+`azp`+trace logging until it ships).
- Splitting `fugue-agents` into sensitivity-tier apps (`-read`/`-act`) — escalation
  path only, not this round.
- The non-security BFF/dashboard work (lives in its own plan).

---

## Open Questions

1. Should team roles in the realm be modeled as realm **roles** or realm
   **groups**? Both can feed the `teams` claim via a mapper; choose for whichever
   reads cleaner in config-as-code. [NEEDS CLARIFICATION: realm-role vs group for
   team modeling — arch-lead to decide during design]
2. Is there an authoritative list of Azure AD group → team mappings (team names +
   group GUIDs) for the first cohort, or only `business-sales` for now?
   [NEEDS CLARIFICATION: initial team→Azure-group roster]

---

## Dependencies

- The `fugueplatform` realm config-as-code package
  (`~/dev/java/keycloakConfigAsCode`) — currently has `RealmStep`,
  `ClientScopesStep`, `ClientStep`, `ConfigurationStep`, `ValidationStep`, plus
  the `entra-exchange` `AudienceMapper`; **lacks** `RolesStep`, `AzureIdpStep`,
  and the `teams` protocol mapper. Phase 2 and Phase 5 depend on these landing
  and being deployed.
- A reachable Entra tenant + provisioned `fugue-agents` app (Phase 5 only).
- The `jose` library (already used by the HITL Bot verifier) for JWKS handling.
- Existing pure core merged on `main` (broker, jwt-validation, token-cache,
  audit, capability-scope, framework `CapabilityBroker` port).

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|----------------------|
| Keycloak token-exchange V2 is downscoping-only (no `act`) | High | Already designed around: two origins, identity via `sub`+`azp`; re-confirm against 26.6.x before Phase 3 |
| FIC issuer/subject/audience must match byte-for-byte across two repos | High | Single source of truth for the constants (SSOT Appendix C); golden test the realm side; spike #2 negative control |
| Resource-scoping (`Sites.Selected`, Exchange policy) must *deny*, not just *allow* | High | Spike #3 proves both coverage and denial before trusting the app-only union |
| Cross-repo drift between host expectations and realm output | Medium | `teams` claim shape asserted by golden test; host parses defensively and fails closed |
| Live spikes are PENDING-LIVE-VERIFICATION (no tenant at authoring time) | Medium | Gate Phase 5 on spike PASS; everything else proven with recorded-call fakes |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Run origin | Whether a run is agent-initiated (no human) or user-initiated (human subject); they secure differently |
| Capability handle | A typed object exposing only the declared operation(s); never exposes a raw credential |
| `mintFor` | The broker entry point that turns a declared requirement into a scoped handle |
| WIF | Workload Identity Federation — Entra accepting the Keycloak SA token as a `client_assertion`, no static secret |
| FIC | Federated Identity Credential — the Entra-side match (issuer/subject/audience) enabling WIF; one per agent-type client |
| `teams` claim | Multi-valued access-token claim listing the user's team memberships, derived from Azure groups via realm mappers |
| Fail-closed | The default for every unwired/refused path: deny with no egress, never silently succeed |
| SC-00x | Security invariant tests already present in the host test suite |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-16 | Initial draft (decisions pre-resolved, `teams` claim feasibility verified) | Claude + Peter |
