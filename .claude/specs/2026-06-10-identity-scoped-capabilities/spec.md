# Specification — Identity-Scoped Capabilities

**Slug:** `identity-scoped-capabilities`
**Date:** 2026-06-10
**Status:** Specified (interview complete)

## Overview

Today every fugue node that declares `requires: [...]` receives a **boot-time
singleton capability** — the LLM client, an HTTP client, a Graph adapter — all
sharing the host's god-credentials with no per-node, per-run, or per-identity
authority. This effort transforms the capability a node receives into
**narrowly-scoped, per-invocation authority**: a typed handle exposing only the
operations the node declared, with all credential minting confined to the
imperative shell and never reachable from the functional core.

The work is delivered in **five waves** spanning **two repositories**:

- `fugue` (this repo) — the framework (`@fuguejs/framework`) and the host.
- `keycloakConfigAsCode` (`/Users/hansen142/dev/java/keycloakConfigAsCode`) —
  the `fugue-platform` realm, clients, and client scopes as config-as-code.

Waves 0–1 (LLM metering and budgets) are useful standalone hosting features and
require no identity infrastructure. Wave 2 makes the capability layer
per-invocation with a zero-regression pass-through default. Waves 3–4 add
Keycloak- and Entra-backed scoped capabilities for the agent-framework
milestone.

**Wave-to-priority mapping (authoritative):**

| Wave | Theme | Priority |
|---|---|---|
| 0 | LLM usage metering | **P1** |
| 1 | LLM budget enforcement | **P1** |
| 2 | `CapabilityBroker` port + pass-through default + ADR | **P1** |
| 3 | Keycloak-backed capabilities + user-initiated inbound JWT path | **P2** |
| 4 | Entra bridge (`fugue-agents` app, FICs, Graph/Dynamics capabilities) | **P2** |

---

## User Scenarios

### US1: [P1] Per-Agent LLM Usage Attribution (Wave 0)

**As an** operator running multiple DAGs in one team's host
**I want** every LLM call attributed to the exact node and run that made it
**So that** I can see per-agent / per-run token cost without ambiguity.

**Why P1:** Foundational observability; the cheapest proven instance of the
per-invocation axis and a dry run for the later scoped-capability waves.

**Acceptance Scenarios:**
- Given a DAG run that makes N LLM calls, When the run completes, Then 100% of
  those calls carry a `(dagId, runId, nodeId)` attribution triple and zero
  calls are unattributed.
- Given any single LLM call, When it is metered, Then the metering is a local
  operation only (structured log line and/or in-process or Redis counter) with
  no additional network round trip and negligible added latency.
- Given accumulated metering data for a run, When an operator queries it, Then
  per-`(dagId, runId, nodeId)` token totals (`tokensIn` / `tokensOut`) are
  available.

### US2: [P1] Per-Run LLM Budget Enforcement (Wave 1)

**As an** operator
**I want** to cap the total LLM token spend of a single run
**So that** a runaway or looping agent cannot incur unbounded cost.

**Why P1:** First real per-invocation capability decision (budget instead of a
token); standalone-useful; low-risk dry run for the OIDC-backed waves.

**Acceptance Scenarios:**
- Given `llmBudgetTokens` is set in `fugue.yaml`, When cumulative tokens for a
  run reach or exceed the budget, Then the next LLM call is refused before it is
  made and the refusal surfaces as a `llm-budget-exceeded` framework error
  through the existing `Result` channel.
- Given a budget of B and a run currently below B, When an in-flight call's
  return pushes cumulative tokens past B, Then that single overshoot is accepted
  (at most one call may exceed the budget) and the *next* call is refused.
- Given no `llmBudgetTokens` is configured, When a run executes, Then no budget
  enforcement occurs and behavior is identical to today.
- Given a budget check, When it runs, Then it consults an in-memory counter with
  no network call.

### US3: [P1] Zero-Regression Per-Invocation Capability Layer (Wave 2)

**As a** framework maintainer / existing embedder
**I want** the capability system to gain a per-invocation authority axis without
breaking a single existing DAG or embedder
**So that** the migration to scoped capabilities is opt-in and risk-free.

**Why P1:** The `CapabilityBroker` port is the structural foundation every later
wave depends on; the pass-through default *is* the migration path.

**Acceptance Scenarios:**
- Given any DAG or embedder that compiles and runs today, When the
  `CapabilityBroker` port and pass-through default ship, Then it continues to
  compile and run with byte-identical capability behavior and zero migration
  steps.
- Given the framework package, When inspected, Then it defines the
  `CapabilityBroker` port and ships a pass-through broker that hands back
  statically-configured clients (today's behavior), with neither referencing
  Keycloak or Entra.
- Given a node executes through the broker, When it requests a capability, Then
  connection pools remain boot-scoped (`connect` / `close` / `healthCheck`
  untouched) while authority is resolved per invocation.
- Given the change to the `extractClients` trust-boundary, When the work lands,
  Then it is documented in an ADR amending ADR-0051 (not a silent patch).

### US4: [P2] Operation-Narrowed Keycloak-Backed Capability (Wave 3)

**As a** node author
**I want** a node that declares `requires: ["msgraph:mail.send"]` to receive a
handle exposing only `sendMail()`
**So that** the functional core can never reach a raw downstream client or token.

**Why P2:** Agent-framework milestone; gated on the verification spikes.

**Acceptance Scenarios:**
- Given a node declaring `requires: ["msgraph:mail.send"]`, When the broker
  resolves it, Then the node receives a handle exposing only `sendMail()` and
  the raw downstream client is unreachable from that handle, enforced by types
  with no escape hatch.
- Given an agent's Keycloak client that lacks an assigned scope, When the broker
  attempts to mint for that scope, Then the request fails closed at the Keycloak
  hop, no outbound Entra call is made, and the node receives a typed refusal.
- Given repeated invocations needing the same `(identity, audience, scope)`,
  When tokens are minted, Then at most one Keycloak token request occurs per
  `(identity, audience, scope)` per cache-TTL window (TTL safely under token
  lifetime).

### US5: [P2] User-Initiated Run With Preserved User Identity (Wave 3)

**As a** human triggering a DAG from a frontend (lead-desk)
**I want** my identity to survive into the run and downstream hops
**So that** downstream activity is attributable to me-via-the-agent, not an
anonymous god-credential.

**Why P2:** Requires the host-accepts-realm-JWTs inbound work; gated on the
identity-chaining spike (#4).

**Acceptance Scenarios:**
- Given the host receives a `fugue-platform`-issued OIDC JWT (`iss` = realm,
  `aud: fugue-host`), When it authenticates the request, Then it accepts and
  validates the JWT as a first-class inbound auth mode alongside opaque `fug_`
  bearer tokens.
- Given a validated user JWT, When a run starts, Then the user `sub` is
  extracted and threaded through the run and `NodeContext` so the broker can
  perform a per-hop token exchange.
- Given a user-initiated hop, When the broker mints downstream authority, Then
  it performs a Standard Token Exchange V2 of the user's token: `sub` stays the
  user and `azp` becomes the agent.
- Given an agent-initiated (cron / autonomous) run, When the broker mints
  authority, Then it uses direct `client_credentials` minting with no token
  exchange.

### US6: [P2] Operator Observability and Fail-Closed Auditability (Waves 3–4)

**As an** operator / auditor
**I want** every capability mint and every refusal recorded with correlating
identity and run context
**So that** I can answer "which user, via which agent, in which run, requested
what — and was it granted or refused?"

**Acceptance Scenarios:**
- Given any broker mint, When it occurs, Then it emits a correlated audit/trace
  record carrying `sub`, `azp`, `runId`, `nodeId`, and the requested scope.
- Given any broker refusal, When it occurs, Then it emits a correlated audit/
  trace record carrying the same fields.
- Given a set of capability requests in a run, When the run completes, Then
  100% of mints and 100% of refusals produced a correlated audit record.

### US7: [P2] Entra-Protected Downstream via Workload Identity Federation (Wave 4)

**As a** node author
**I want** a node to call Graph/Dynamics through a narrowly-scoped handle
**So that** no static Entra secret exists and Keycloak governs per-agent access.

**Acceptance Scenarios:**
- Given a Keycloak client with the required scope assigned, When the broker
  resolves an Entra-backed capability, Then it mints a Keycloak service-account
  token, presents it as `client_assertion` to Entra via workload identity
  federation, and receives an app-only downstream token — with no stored Entra
  secret or certificate.
- Given the `fugue-platform` realm config, When deployed, Then it mints the
  federation assertion with `aud: api://AzureADTokenExchange` via a dedicated
  client scope so the assertion cannot be replayed against internal services.
- Given resource-scoping policies (`Sites.Selected`, Exchange application access
  policies), When an Entra-backed capability acts, Then the union-permission
  token can act only on the explicitly granted SharePoint sites / mailboxes.

### US8: [P2] Shared `fugue-platform` Realm Serving Frontend SSO and Agents (Waves 3–4)

**As a** platform owner
**I want** one realm package that serves both frontend SSO and agent service
accounts
**So that** the fugue-host ecosystem has a single governed trust boundary.

**Acceptance Scenarios:**
- Given the `fugue-platform` realm package, When deployed, Then it exposes both
  a confidential auth-code client for frontend SSO and the agent service-account
  client(s).
- Given the config-as-code golden-export test, When run, Then it covers both
  client types.

---

## Functional Requirements

Each requirement is tagged with its wave. MUST / SHOULD / MAY per RFC 2119.

### Wave 0 — LLM Usage Metering (P1)

- **FR-W0-001 (MUST):** The system MUST attribute 100% of LLM calls to a
  `(dagId, runId, nodeId)` triple; zero LLM calls may be unattributed.
- **FR-W0-002 (MUST):** Metering MUST be a local operation only — a structured
  log line and/or an in-process or Redis counter — with no per-call network
  round trip.
- **FR-W0-003 (MUST):** Metering overhead MUST be negligible, targeting well
  under ~5 ms added at p99 per LLM call.
- **FR-W0-004 (MUST):** The system MUST aggregate `tokensIn` / `tokensOut` per
  `(dagId, runId, nodeId)` so per-agent / per-run cost is queryable.
- **FR-W0-005 (MUST):** Wave 0 MUST require no framework changes (host-only),
  using the existing `dag` / `runId` and `LlmResponse.tokensIn/tokensOut` seams.

### Wave 1 — LLM Budget Enforcement (P1)

- **FR-W1-001 (MUST):** The system MUST support a per-run token budget
  configured as `llmBudgetTokens` in `fugue.yaml`, enforced per `runId`.
- **FR-W1-002 (MUST):** Before each LLM call, the system MUST compare cumulative
  tokens-so-far for the run against the budget and, if cumulative ≥ budget,
  refuse the call.
- **FR-W1-003 (MUST):** A refusal MUST surface as a new `FrameworkError` variant
  `llm-budget-exceeded` flowing through the existing `Result` channel.
- **FR-W1-004 (MUST):** The system MUST accept that a single in-flight call may
  overshoot the budget by at most one call (exact token cost is unknown until
  the call returns); the *next* call after overshoot MUST be refused.
- **FR-W1-005 (MUST):** The budget check MUST consult an in-memory counter with
  no network call and complete in under 1 ms.
- **FR-W1-006 (MUST):** When `llmBudgetTokens` is absent, the system MUST NOT
  enforce any budget and MUST behave identically to pre-wave-1.

### Wave 2 — Per-Invocation Capability Axis (P1)

- **FR-W2-001 (MUST):** `@fuguejs/framework` MUST define a `CapabilityBroker`
  port: given an invocation and a `requires` declaration, produce a scoped
  capability handle. It occupies the same layer as `CapabilityHandle`.
- **FR-W2-002 (MUST):** The framework MUST ship a pass-through broker that hands
  back statically-configured clients, reproducing today's behavior exactly.
- **FR-W2-003 (MUST):** Every DAG / embedder that compiles and runs today MUST
  continue to compile and run with byte-identical capability behavior and zero
  migration steps (the pass-through default is the migration path).
- **FR-W2-004 (MUST):** Neither the `CapabilityBroker` port nor the pass-through
  default MAY reference Keycloak or Entra.
- **FR-W2-005 (MUST):** Connection pools MUST remain boot-scoped; `connect` /
  `close` / `healthCheck` MUST be untouched. Only authority becomes
  invocation-scoped.
- **FR-W2-006 (MUST):** The Keycloak/Entra broker *implementation* MUST live in
  the host, not the framework.
- **FR-W2-007 (MUST):** A token cache keyed on `(identity, audience, scope)`
  MUST live in the shell next to the minting, with TTL safely under token
  lifetime; at most one Keycloak token request per `(identity, audience, scope)`
  per TTL window.
- **FR-W2-008 (MUST):** The change to the `extractClients` trust-boundary
  correlation point MUST be documented in an ADR amending ADR-0051.
- **FR-W2-009 (MUST):** The LLM handle (budget / model allowlist) MUST be
  expressible as the first invocation-scoped capability over the same `mintFor`
  seam, without OIDC.

### Wave 3 — Keycloak-Backed Capabilities + Inbound JWT Path (P2)

- **FR-W3-001 (MUST):** The `keycloakConfigAsCode` `ClientStep` MUST mirror each
  downstream permission as a Keycloak optional client scope (e.g.
  `msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`); assigning a scope
  to an agent's client *is* the policy grant.
- **FR-W3-002 (MUST):** The broker MUST request exactly the scopes a node's
  `requires` names and mint via `client_credentials` as the agent's Keycloak
  client for agent-initiated runs.
- **FR-W3-003 (MUST — fail closed):** When an agent's Keycloak client lacks a
  required scope assignment, the broker MUST fail at the Keycloak hop, make zero
  outbound Entra calls, and deliver a typed refusal to the node. 100% of
  unauthorized requests MUST fail closed with zero Entra egress (verified by a
  network/no-egress assertion in test).
- **FR-W3-004 (MUST — operation narrowing):** A node declaring a capability MUST
  receive a handle exposing only the named operation(s); the raw downstream
  client MUST be unreachable from the handle, enforced by types with no escape
  hatch (testable as "no raw-client / no-token field reachable from the
  handle").
- **FR-W3-005 (MUST — secret exposure):** No raw token or vendor API key may
  ever be reachable from node-executed (functional-core) code; capability
  handles MUST expose no token/key field (verifiable by inspection/lint).
- **FR-W3-006 (MUST):** The host MUST accept and validate `fugue-platform` OIDC
  JWTs (`iss` = realm, `aud: fugue-host`) as a first-class inbound auth mode
  alongside the existing opaque `fug_` bearer tokens (two-path inbound auth).
- **FR-W3-007 (MUST):** For user-initiated runs, the host MUST extract the user
  `sub` from the JWT and thread it through the run and `NodeContext`.
- **FR-W3-008 (MUST):** For user-initiated hops, the broker MUST perform a
  Standard Token Exchange V2 of the user's token per hop — `sub` stays the user,
  `azp` becomes the agent — applying the same scope/audience narrowing.
- **FR-W3-009 (MUST):** Agent-initiated runs MUST NOT use token exchange; they
  use direct narrow `client_credentials` minting.
- **FR-W3-010 (MUST):** Both the agent-initiated and user-initiated paths MUST
  be delivered in wave 3. This effort owns the inbound-JWT work and MUST NOT
  depend on a separate frontend migration.
- **FR-W3-011 (MUST):** The `fugue-platform` realm package MUST expose both a
  confidential auth-code client for frontend SSO and the agent service-account
  client(s); the golden-export test MUST cover both client types.

### Wave 4 — Entra Bridge (P2)

- **FR-W4-001 (MUST):** A single Entra app registration `fugue-agents` MUST hold
  the union of application permissions any agent needs, admin-consented once.
- **FR-W4-002 (MUST):** The app MUST trust the `fugue-platform` realm as an
  external OIDC issuer via federated identity credentials, one FIC per agent-
  type Keycloak client (Variant A), matching `issuer`, `subject`
  (service-account `sub`), and `audience` (`api://AzureADTokenExchange`)
  case-sensitively.
- **FR-W4-003 (MUST):** The `fugue-platform` realm MUST mint the federation
  assertion with `aud: api://AzureADTokenExchange` via a dedicated client scope
  carrying a hardcoded-audience protocol mapper (`entra-exchange`), so the
  assertion is rejected by internal services and cannot be replayed in-platform.
- **FR-W4-004 (MUST):** For an authorized Entra-backed capability, the broker
  MUST present the Keycloak service-account token as `client_assertion` in a
  `client_credentials` request to Entra and receive an app-only Graph/Dynamics
  token, with no stored Entra secret or certificate.
- **FR-W4-005 (MUST):** Resource-scoping policies (`Sites.Selected` and Exchange
  application access policies) MUST bound where the union-permission token can
  act (specific SharePoint sites; specific mailboxes), covering the Graph
  surfaces the agents need.
- **FR-W4-006 (MUST):** The Entra-side operational steps (app registration,
  admin consent, FIC entries, resource-scoping policies) that are
  Azure-portal/manual MUST be captured as runbook/operational requirements with
  explicit acceptance, in addition to the config-as-code deliverables.

### Cross-Wave — Typed Failure Modes & Audit (Waves 3–4, P2)

- **FR-X-001 (MUST — distinct named errors):** The following failure modes MUST
  be distinct, named, discriminable typed errors:
  - `infra-unreachable` — Keycloak / token mint fails (transient).
  - `policy-refusal` — scope not assigned (authorization; fail-closed before
    Entra).
  - `llm-budget-exceeded` — per-run LLM budget reached.
- **FR-X-002 (MAY collapse):** For v1, Entra FIC mismatch / WIF rejection /
  resource-scoping denial MAY collapse into a single distinct
  `downstream-denied` (authorization) category, kept distinct from
  `infra-unreachable`.
- **FR-X-003 (MUST):** A token cache miss MUST NOT be treated as an error; it
  triggers a mint.
- **FR-X-004 (MUST):** Every broker mint AND every refusal MUST emit a
  correlated audit/trace record carrying `sub`, `azp`, `runId`, `nodeId`, and
  the requested scope; 100% of mints and refusals MUST produce a correlated
  record.

### Verification Spikes — Gating Preconditions (MUST-PASS)

All four spikes are MUST-PASS gating preconditions; each has an explicit
pass/fail outcome that gates its dependent wave, and documenting each outcome is
part of this effort's acceptance.

- **FR-SPK-001 (MUST, gates wave 4):** Spike — FIC sign-in attribution: confirm
  Entra sign-in logs surface *which* federated credential matched.
- **FR-SPK-002 (MUST, gates wave 4):** Spike — sub-claim mapper × FIC matching:
  Keycloak's sub mapper output survives Entra's case-sensitive
  issuer/subject/audience match.
- **FR-SPK-003 (MUST, gates wave 4):** Spike — resource-scoping coverage:
  `Sites.Selected` + Exchange application access policies actually cover the
  needed Graph surfaces.
- **FR-SPK-004 (MUST, HARD GATE for the wave-3 user-initiated path):** Spike —
  identity-chaining end-to-end on Keycloak 26.6: the composed user→agent→Entra
  flow works.

---

## Success Criteria

- **SC-001 (W0):** 100% of LLM calls in a run carry a `(dagId, runId, nodeId)`
  triple; 0 unattributed calls.
- **SC-002 (W0):** Added per-call metering latency is under ~5 ms at p99, with
  zero metering-induced network round trips per call.
- **SC-003 (W1):** With a budget B, the number of calls allowed past B is at
  most 1 (the accepted single overshoot); the next call is refused with
  `llm-budget-exceeded`.
- **SC-004 (W1):** Budget check latency is under 1 ms with zero network calls.
- **SC-005 (W2):** 100% of currently-compiling DAGs/embedders compile and run
  unchanged after the broker port + pass-through default ship; 0 migration steps
  required.
- **SC-006 (W3):** 100% of unauthorized capability requests fail closed with 0
  outbound Entra calls, verified by a network/no-egress assertion in test.
- **SC-007 (W3):** 0 raw-client and 0 token/key fields are reachable from a
  node's capability handle (verified by type-level test + lint).
- **SC-008 (W2/W3):** ≤ 1 Keycloak token request per `(identity, audience,
  scope)` per cache-TTL window.
- **SC-009 (W3–W4):** 100% of broker mints and 100% of refusals produce a
  correlated audit record containing `sub`, `azp`, `runId`, `nodeId`, and the
  requested scope.
- **SC-010 (W3):** For user-initiated hops, the downstream-presented token has
  `sub` = user and `azp` = agent in 100% of exchanged tokens; agent-initiated
  hops perform 0 token exchanges.
- **SC-011 (W4):** 0 static Entra secrets/certificates are stored anywhere in
  the Entra-backed capability path.
- **SC-012 (W3–W4):** The `fugue-platform` golden-export test covers both the
  confidential auth-code (frontend SSO) client and the agent service-account
  client(s) — both client types present in the asserted export.
- **SC-013 (Failure modes):** The 3 mandatory error variants
  (`infra-unreachable`, `policy-refusal`, `llm-budget-exceeded`) are
  individually discriminable in tests; `downstream-denied` (if used) is distinct
  from `infra-unreachable`.
- **SC-014 (Spikes):** All 4 verification spikes have a documented pass/fail
  outcome; waves 3–4 (and specifically the user-initiated path) do not proceed
  past their respective gates without a passing outcome.

---

## Out of Scope

Explicitly NOT part of this effort:

- **Per-team LLM client resolution** — solved by one-host-per-team (PR #13);
  rebuilding multi-tenant per-team client resolution into the host is an
  explicit anti-goal.
- **`act`-claim multi-hop in-token delegation** — on the Keycloak roadmap;
  `sub` + `azp` + traces is the v1 substitute. Not built here.
- **Dynamic client registration / dynamically-spawned agent identities** —
  identity is fixed per agent *type* / per DAG. DCR is a deliberate future
  escape hatch only.
- **The lead-desk application itself** — its claims, outcomes, entity model, and
  UI live in a separate repo/spec. This effort owns the `fugue-platform` realm
  *config* (including the frontend SSO client definition) but not the frontend
  app.
- **DPoP / mTLS sender-constraining of agent tokens** — OUT FOR NOW: does not
  compose with token exchange yet. Captured as a documented future
  consideration, not a requirement.
- **Per-agent Entra app registrations** — the unit is one Entra app per trust
  boundary (`fugue-agents` for this host); per-tier escalation (read/act) is the
  only sanctioned reason to add an app and is not part of this effort's build.
- **User-delegated (vs. app-only) Entra access behind the broker** — app-only
  permissions are the accepted residual limit for agent workloads.

---

## Traceability Notes

- The 5-wave structure is preserved in FR tags (`FR-W0-*` … `FR-W4-*`),
  cross-wave concerns (`FR-X-*`), and gating spikes (`FR-SPK-*`).
- Two-repo scope: `FR-W3-001`, `FR-W3-011`, `FR-W4-002/003` and the realm
  golden-export criteria land in `keycloakConfigAsCode`; all others land in
  `fugue`. `FR-W4-006` captures the manual Azure-portal operational surface.
- This spec describes WHAT and WHY only. Token-minting mechanics, broker class
  layout, cache implementation, and protocol-mapper wiring are HOW and belong to
  the architecture/plan phase.
