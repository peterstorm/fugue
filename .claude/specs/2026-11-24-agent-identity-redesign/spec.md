# Feature: Agent Identity Redesign (per-agent Entra identity, per-capability authority mode)

**Spec ID:** 2026-11-24-agent-identity-redesign
**Created:** 2026-11-24
**Status:** Clarified
**Owner:** Peter Storm (GitHub issue #42)

## Summary

Fugue's identity chain to Microsoft 365 does not work as designed today. Agent-origin runs cannot reach Entra because the agent's assertion lacks the audience Entra federation requires. User-origin runs present a token whose subject is the human, but the federated credentials are pinned to agent subjects, so the exchange cannot succeed. Long runs and runs resumed after human approval also lose the user token.

This feature redefines the model. Only an agent's own identity ever federates into Entra, and each agent gets its own Entra identity. Each capability declares its authority mode: `app` means the agent acts as itself and records the human initiator for attribution. `delegated` means the agent acts on behalf of a verified Entra user through on-behalf-of delegation. The Keycloak realm configuration and all identity documentation are brought into line with this model.

Scope covers two repositories: the Fugue host, and the `fugue-platform` realm package in Keycloak config-as-code (Keycloak 26.8.2). Both step 1 (agent path, `app` mode, per-agent identity, realm, docs) and step 2 (`delegated` mode) are in scope. The user chose to build delegated mode now even though no capability needs it yet. Live-tenant verification is done by the operator and is not part of this work.

> **Interview note:** The specify-phase and clarify-phase interviews were replaced by the user's explicit delegation ("just pick the most correct, best, most functional approach, for all questions"). Every open question was decided by the orchestrator under that delegation; each decision and its rationale is logged in `clarifications/log.md` for the user's review. Priorities: step 1 = P1, step 2 = P2, optional realm hardening (FR-033) = P3. All of them are in scope and built; priority only orders the work.

---

## User Scenarios

### US1: [P1] Agent-origin run reaches Microsoft 365 as its own agent identity

**As a** team running a scheduled or event-triggered DAG with no human initiator
**I want to** have each node's granted capability obtain a downstream Microsoft 365 credential under that agent's own Entra identity
**So that** autonomous workflows actually work, and each downstream action is authorized and logged against the specific agent that performed it

**Why this priority:** The agent path is the base of every other path, and today it is broken: the assertion lacks the Entra exchange audience. Nothing downstream works until it is fixed.

**Acceptance Scenarios:**
- AS-001: Given an agent client assigned the capability scope `mail.send`, When an agent-origin node requiring `mail.send` invokes the capability, Then the agent's realm credential is requested with both the Entra-exchange grant and the `mail.send` grant, the resulting assertion is audienced for Entra federation, and the node receives a narrowed handle backed by a credential issued to that agent's own Entra identity
- AS-002: Given an agent client NOT assigned the capability scope a node requires, When the node invokes the capability, Then the request is refused before any realm or Entra network egress, and a refusal audit record is emitted
- AS-003: Given an agent client whose realm configuration does not grant the Entra-exchange scope, When a credential is requested, Then the mint fails closed with a typed, actionable error naming the missing grant, and no Entra egress occurs
- AS-004: Given two different agent clients served by the same host deployment, When both acquire downstream credentials, Then each credential is issued to a distinct Entra identity, and neither agent's cached credential is ever returned to the other
- AS-005: Given Entra rejects the federated assertion (issuer, subject, or audience mismatch), When the exchange fails, Then the node receives a typed failure that distinguishes a federation-configuration error from a transient error, and no credential material appears in the error or audit
- AS-035: Given realm and Entra transports injected so that they answer without delay, When the automated suite measures downstream credential acquisition under both identity models and both authority modes, Then the host-added overhead of a cache miss is at most 10 ms p95, and a cache hit is at most 5 ms p95 and makes no transport call (the automated-suite clause of NFR-002 and NFR-001)

### US2: [P1] Capability declares its authority mode; user-origin `app` runs attribute without holding user tokens

**As a** capability author and as a human who starts a run
**I want to** each capability to declare whether it acts as the agent (`app`) or on behalf of the user (`delegated`); and for `app` capabilities on runs I start, my identity recorded as initiator while the agent acts as itself
**So that** downstream authorization is honest about which principal acts, and Fugue never holds, exchanges, or forwards my bearer token when it doesn't need to

**Why this priority:** This removes the unworkable user path (user-subject assertion against agent-pinned federated credentials, a 5-minute token lifetime cap, and an audience mismatch) and settles issue #42's "as the user" ambiguity. Every user-origin run depends on it.

**Acceptance Scenarios:**
- AS-006: Given a user-origin run whose nodes require only `app` capabilities, When the run executes, Then every downstream credential is the agent's own (same as US1), zero user-token exchanges occur, and each mint audit record carries the initiator's attribution (realm subject and Entra object id)
- AS-007: Given a user-origin run using only `app` capabilities is suspended for human approval, When it resumes after the user's original token has expired, Then downstream calls succeed under the agent identity and attribution is preserved from the durable run record, with no user token needed
- AS-008: Given a run that would run longer than the user's inbound token lifetime, When later nodes invoke `app` capabilities, Then they succeed and are not limited by the inbound token's expiry
- AS-009: Given a capability definition without an authority mode, When it is defined in code, Then it does not compile (the authority mode is a required part of each capability's definition); and When a capability set arrives as data (configuration or any non-code source), Then the host refuses to start with an actionable error naming the capability. No default mode and no fallback exist. Every existing capability (`msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`) is migrated to declare `app` explicitly
- AS-010: Given an agent-origin run whose DAG contains a node requiring a `delegated` capability, When the run is submitted, Then it is refused at run-start validation before any node executes, any concurrency slot is acquired, or any token egress occurs, with a typed error naming the node and capability
- AS-039: Given a user-origin run using only `app` capabilities whose inbound realm token, realm assertion and Entra access credential are distinctive sentinel values, When the run executes end to end, Then no sentinel, nor any encoding or signature segment of it, appears in the run's invocation origin or run authority, the serialised form of any capability handle, any audit record, any log line, or the run's HTTP response (FR-022 on the `app` execution path)

### US3: [P1] Operator provisions one Entra identity per agent, with a supported fallback

**As a** platform operator
**I want to** provision a separate Entra identity for each Keycloak agent client, grouped under one parent per host deployment, with a documented fallback when the preferred identity type cannot federate from Keycloak
**So that** downstream permissions, sign-in logs, and revocation are per agent, and a compromised host deployment's blast radius is bounded to that deployment's agents

**Why this priority:** This replaces ADR-0055's single shared `fugue-agents` app, which cannot give per-agent attribution or per-agent permissions in Entra. US1 depends on it.

**Acceptance Scenarios:**
- AS-011: Given a deployment configured for the Entra Agent ID model (one blueprint per host deployment, one agent identity per agent client), When an agent acquires a downstream credential, Then the credential is issued to that agent's agent identity, obtained through the blueprint without any static secret or certificate
- AS-012: Given a deployment configured for the fallback model (one ordinary Entra app registration per agent client, each with one federated credential), When an agent acquires a downstream credential, Then the credential is issued to that agent's app registration, and capability and DAG definitions are identical to those in the Agent ID model
- AS-013: Given a deployment whose Entra identity leg is configured, and an agent client the deployment maps that has no Entra identity mapped, When the host boots, Then the host refuses to start with an actionable error naming every such agent client (a mis-provisioned deployment is found at deploy, not mid-run). When the Entra identity leg is not configured, or is only partially configured, the existing config-presence gating applies unchanged: the leg stays dark and fail-closed with an actionable warning (NFR-020)
- AS-033: Given a deployment whose Entra identity leg is configured but that does not declare its identity model (Agent ID or per-agent app registration), When the host boots, Then the host refuses to start with an actionable error. There is no default identity model
- AS-014: Given the provisioning runbook, When an operator follows it end to end, Then every agent identity has zero client secrets and zero certificates, every agent's Exchange mailbox scoping uses RBAC for Applications (not the legacy Application Access Policy), and the runbook records which identity model the tenant spike selected

### US4: [P1] Realm configuration enforces the redesigned identity model

**As a** realm administrator
**I want to** the `fugue-platform` realm package to emit the Entra object id in user tokens and to reject configurations that would allow the old user-exchange path
**So that** the host can attribute and bind users to their Entra identity, and a misconfiguration is caught by config-as-code rather than in production

**Why this priority:** Attribution in US2 and identity binding in US5 both need the Entra object id claim. The no-user-exchange guarantee must hold in the realm itself as well as in the host.

**Acceptance Scenarios:**
- AS-015: Given a user who signed in through the realm's Entra identity provider, When the realm issues an access token to a frontend client, Then the token carries that user's Entra object id in a dedicated claim
- AS-016: Given any agent client with Keycloak standard token exchange enabled, When realm validation runs, Then validation fails and names the offending client
- AS-017: Given the Entra-exchange scope registered as a realm default or default-optional scope, or assigned to any frontend client, When realm validation runs, Then validation fails and reports the unexpected assignment
- AS-018: Given the realm package is re-applied to a realm that already matches it, When the run completes, Then zero changes are made (idempotent), and the golden export is byte-identical
- AS-019: (P3) Given the operator opts into the predictable service-account subject feature, When an agent client is created, Then its service-account subject is derivable from the client id before creation, so federated credentials can be provisioned ahead of time

### US5: [P2] Delegated capability acts on behalf of a verified Entra user

**As a** human starting a run (for example from LeadDesk, through HTTP run submission) that uses a `delegated` capability
**I want to** the agent to act on behalf of me, limited to my own Microsoft 365 permissions
**So that** operations that must respect my personal access (for example, reading only mail or files I can see) are authorized by Entra as me through the agent, and are logged as such

**Why this priority:** No current capability needs delegated mode, so it does not block the P1 paths. The user chose to build it now so the model is complete and proven before it is needed.

**Acceptance Scenarios:**
- AS-020: Given a user-origin run that requires a `delegated` capability, and a request carrying both a valid realm token and a valid Entra user token audienced to the deployment's blueprint, both from the same person (matching Entra object id and tenant), When the node invokes the capability, Then the agent identity obtains an on-behalf-of credential for that user, and the node receives a narrowed handle
- AS-021: Given a request where the realm token's Entra object id differs from the Entra user token's object id, When the run is submitted, Then the run is refused before any node executes, with a typed identity-binding error, and the audit record contains no token material
- AS-022: Given a user-origin run that requires a `delegated` capability but the request carries no Entra user token, When the run is submitted, Then the run is refused at run-start validation with an actionable error stating that a delegated-authority token is required
- AS-023: Given an Entra user token with the wrong audience, a wrong or foreign tenant, an expired lifetime, or an invalid signature, When the run is submitted, Then the run is refused at run-start validation and no on-behalf-of exchange is attempted
- AS-040: Given an Entra user token that is otherwise valid but was obtained by a client application not on the deployment's allowlist of delegated-token clients (its authorized party), or whose delegated scopes do not include the deployment's configured delegated scope, When the run is submitted, Then the run is refused at run-start validation with a typed error naming which check failed (client or scope, never the claim values), and no on-behalf-of exchange is attempted
- AS-024: Given a node that requires one `app` capability and one `delegated` capability, When both are invoked, Then the `app` handle is backed by the agent's own credential and the `delegated` handle by the on-behalf-of credential, and neither credential is reachable through the other's handle
- AS-025: Given the user's Entra account is disabled or the user's consent is revoked mid-run, When a later `delegated` invocation needs a credential, Then Entra's refusal surfaces as a typed authorization failure and the run does not fall back to `app` authority
- AS-036: Given signing-key and realm transports injected so that they answer without delay, and the signing-key set already fetched once, When the automated suite measures run submission, Then run-start validation of authority modes, delegated-token verification and identity binding together add at most 50 ms p95 (the automated-suite form of NFR-003)
- AS-037: Given a run submission carrying a sentinel realm user token and, where sent, a sentinel Entra user token (valid, or failing any verification or binding check), When the submission is admitted or refused, Then no sentinel, nor any encoding or signature segment of it, appears in the HTTP response, any log line (the worker's or the supervisor proxy's), any audit record, any error value, or the admitted run authority (FR-022 at run start)

### US6: [P2] Delegated authority survives long runs and human-approval suspension

**As a** human whose delegated run pauses for approval or runs longer than my token's lifetime
**I want to** the run to continue acting on behalf of me after resume, or be told clearly what I must do to continue
**So that** delegated workflows are not silently broken by token expiry, and my credentials are never kept longer than the run needs them

**Why this priority:** Needed for delegated mode to work in durable HITL workflows. Like US5, it has no current consumer.

**Acceptance Scenarios:**
- AS-026: Given a delegated run that suspends for approval (or outlives its delegated access credential), When it is resumed and a `delegated` capability needs a credential, Then the host redeems the run-bound delegated refresh credential obtained at the run's first on-behalf-of exchange, through the agent's own Entra identity, and the run continues acting on behalf of the original initiator. The refresh credential is held encrypted at rest (only ciphertext in any store), bound to (run, agent identity, user Entra object id, tenant), never logged or placed on a handle, and custody is capped at the run's maximum suspension window (default 7 days, configurable, never unbounded). The refresh credential is written once at establishment and never rotated: Entra does not revoke a refresh credential when it is redeemed, and its 90-day lifetime exceeds the custody cap. Entra evaluates every refresh: a disabled account, Conditional Access (including sign-in frequency) and an explicit revocation of the user's sessions refuse it. A password change or reset does NOT revoke it, so the operator's cut-offs are disabling the user, revoking the user's sessions, or cancelling the run
- AS-034: Given a delegated run whose refresh is refused by Entra, or whose custody is absent or expired while the run itself is still live, When a `delegated` capability needs a credential, Then the run never falls back to `app` authority; instead the run suspends in an awaiting-re-authorization state at that node, the initiator is notified with a typed "delegated authority unavailable, re-authorization required" reason, and no credential material is in the notification
- AS-041: Given a run suspended in the awaiting-re-authorization state, When its original initiator presents a fresh realm token and a fresh Entra user token for the run (the same binding rules as run start, and the Entra object id and tenant equal to the recorded initiator's), Then the host performs a fresh on-behalf-of exchange, replaces the run's custody with a fresh custody window (at most the configured maximum from the re-authorization, and never beyond the run's deadline), and the run resumes at the node that needed it from its checkpoint, including a run suspended because its custody expired; the run deadline is never extended; When anyone else presents tokens for the run, or the tokens fail any run-start check, Then the request is refused with a typed error, the run stays suspended, and the refusal is audited
- AS-042: Given a suspended run whose admitted authority no longer matches the host's capability catalog at resume (a capability's mode changed, a capability was removed, or a namespace the run passed through is now brokered), When any resume slice starts, Then the run fails before any node executes with a typed "authority changed" error naming the capabilities, and no credential is acquired under the stale authority
- AS-043: Given a HITL gate, When approvers act on it (including duplicate deliveries of the same click, a second approver after the gate resolved, and an approver without access to the DAG), Then exactly one decision is accepted, the accepted decision and its approver are stored in one atomic write, every attempt is audited with its outcome (accepted, duplicate, not-pending, unauthorized), and the accepted decision's audit record and the approval request shown to the approver state the principal the gated step will act as (the agent, or the initiator through delegation)
- AS-027: Given a delegated run that is torn down (completed, failed, cancelled, or evicted), When teardown finishes, Then no delegated credential for that run remains retrievable anywhere in the host
- AS-028: Given a delegated run approved by someone other than the original initiator (any approver authorized by the existing HITL approver authorization may approve), When delegated authority is needed after resume, Then the run continues acting on behalf of the original initiator (whose delegated authority was granted at run start), never on behalf of the approver; approval lends no authority, and the approver is recorded separately as the approver in the run and audit records
- AS-038: Given a delegated run whose realm assertion, on-behalf-of access credential and refresh credentials are distinctive sentinel values, When it is established, suspended, approved, resumed, refused or torn down, Then no sentinel, nor any encoding of it, appears in any run record or checkpoint, approval or audit record, log line, error value or HTTP response, and every custody record at rest holds only ciphertext (FR-022, and FR-017's encrypted-at-rest clause)

### US7: [P2] Identity documentation and decisions match the system

**As a** maintainer, operator, or security reviewer
**I want to** ADRs, the provisioning runbook, and the security docs to describe exactly which token carries which identity at each hop, and which principal each downstream resource authorizes
**So that** nobody claims a path is live, unwired, or "as the user" when it is not, and the operator can provision and verify the chain from the runbook alone

**Why this priority:** Issue #42's acceptance criteria require reconciled docs. Docs are the contract the operator verifies against.

**Acceptance Scenarios:**
- AS-029: Given the new ADRs, When a reader looks up per-agent identity, authority mode, or delegated continuation, Then each decision is in an accepted ADR that explicitly supersedes ADR-0055 and partially supersedes ADR-0056 and ADR-0058, and the superseded ADRs carry a pointer to their successor
- AS-030: Given the provisioning runbook, When an operator reads it, Then it covers per-agent identity under both identity models, RBAC for Applications for Exchange, the Agent ID tenant spike with explicit pass/fail criteria, the selection of the fallback model, rollback, and credential/client rotation
- AS-031: Given any identity doc listed in issue #42, When it describes the `app` path, Then it states that the downstream principal is the agent identity and that the human is recorded for attribution only. Where it describes the `delegated` path, it states that Entra authorizes the user through the agent identity
- AS-032: Given each hop of the agent, `app`, and `delegated` chains, When a reader consults the sequence diagram, Then every token is identified by issuer, subject, authorized party, audience, holder, and verifier

---

## Functional Requirements

### Core Requirements

- FR-001: System MUST request the agent's realm credential with both the Entra-exchange grant and the node's capability grant whenever a capability needs an Entra-federated downstream credential
- FR-002: System MUST present only an agent's own identity as the federated assertion to Entra. A token whose subject is a human MUST NOT be presented as a federated assertion
- FR-003: System MUST NOT perform any realm-side user token exchange for any run origin or authority mode
- FR-004: System MUST NOT retain, register, or bind the inbound user bearer token for any run whose capabilities are all `app` mode
- FR-005: Every capability MUST declare exactly one authority mode, either `app` or `delegated`, as part of its definition. A capability without one MUST be unrepresentable: a build-time (type) error where capabilities are defined in code, and a boot-time refusal naming the capability where a capability set arrives as data. There is no default mode. Every existing capability MUST be migrated to declare `app` explicitly
- FR-006: System MUST refuse, at run-start validation, any agent-origin run whose DAG requires a `delegated` capability, before node execution, concurrency acquisition, or token egress
- FR-007: System MUST refuse, at run-start validation, any user-origin run requiring a `delegated` capability unless the request carries a verified Entra user token bound to the same person as the verified realm token
- FR-008: System MUST verify the Entra user token for signature, issuer, tenant, audience (the deployment's blueprint or delegated audience), expiry, authorized party (the client application that obtained it MUST be on the deployment's configured allowlist of delegated-token clients, with no default) and delegated scope (it MUST include the deployment's configured delegated scope) against Entra's published signing keys
- FR-009: System MUST bind the realm token and the Entra user token as the same person only when the realm token's Entra object id claim and tenant equal the Entra token's object id and tenant. Any mismatch MUST fail closed
- FR-010: System MUST obtain `delegated` credentials only through on-behalf-of delegation performed by the agent's own Entra identity, and MUST NOT fall back to `app` authority when delegation fails
- FR-011: System MUST support two per-agent Entra identity models, Entra Agent ID (blueprint per host deployment, agent identity per agent client) and one app registration per agent client, behind one capability-facing contract, so that switching models requires no change to capability or DAG definitions
- FR-012: System MUST obtain every Entra credential without a static client secret or certificate
- FR-013: System MUST continue to refuse ungranted capability scopes before any realm or Entra egress, preserving AD-5 (the realm is the policy decision point, Entra is the enforcement point)
- FR-014: System MUST keep cached downstream credentials isolated per agent identity, per authority mode, and (for `delegated`) per user, so that no credential is ever served across those boundaries
- FR-015: System MUST surface identity failures as typed errors that distinguish policy refusal, missing configuration, federation mismatch, identity-binding mismatch, delegated-token-required, and transient upstream failure
- FR-016: System MUST let `app`-mode user-origin runs resume after HITL suspension, and complete beyond the inbound token's lifetime, without any user token
- FR-017: System MUST continue delegated authority across HITL suspension and token expiry by run-bound custody of the delegated refresh credential returned by on-behalf-of (AS-026). The credential MUST be encrypted at rest (only ciphertext in any store), bound to (run, agent identity, user Entra object id, tenant), written once and never rotated, never logged or placed on a handle, deleted when the run reaches a terminal state, and held no longer than the run's maximum suspension window (default 7 days, configurable, never unbounded). When Entra refuses the refresh or custody is absent or expired while the run is live, the run MUST NOT fall back to `app` authority; it MUST suspend awaiting re-authorization (FR-027)
- FR-026: System MUST check, at the start of every resume slice and before any node executes, that the run's admitted authority still matches the host's capability catalog (same mode for every admitted capability, no admitted capability removed, no passed-through requirement now in a brokered namespace). Any difference MUST fail the run with a typed "authority changed" error naming the capabilities (AS-042)
- FR-027: System MUST let a run suspended awaiting re-authorization resume only when its original initiator presents a fresh realm token and a fresh Entra user token that pass every run-start check (FR-007 to FR-009) and whose Entra object id and tenant equal the recorded initiator's; the host MUST then perform a fresh on-behalf-of exchange, replace the run's custody, and resume the run at the node that needed it. Any other presentation MUST be refused and audited, leaving the run suspended. Re-authorization MUST NOT extend the run's deadline; the re-established custody gets a fresh window capped at the configured maximum and never beyond the run's deadline (AS-041)
- FR-018: The existing admin-token and team-token inbound paths MUST behave exactly as before
- FR-019: A deployment MUST declare its per-agent identity model (Entra Agent ID or one app registration per agent client) explicitly in configuration. There is no default model; a configured Entra identity leg without a declared model, or with an agent client the deployment maps but has no Entra identity for, MUST refuse to boot with an actionable error (AS-013, AS-033)
- FR-025: A resumed delegated run MUST act on behalf of its original initiator only. Approval by a different authorized approver MUST NOT change the principal on whose behalf the run acts; the approver MUST be recorded separately (AS-028)
- FR-028: A HITL decision and the identity of its approver MUST be recorded in one atomic first-writer-wins write, so an accepted decision can never exist without its approver. Every approval attempt MUST be audited with its outcome (accepted, duplicate, not-pending, unauthorized), and both the approval request shown to the approver and the accepted decision's audit record MUST state the principal the gated step will act as (AS-043)

### Data Requirements

- FR-020: System MUST record initiator attribution (realm subject, Entra object id, tenant) on every user-origin run, durably enough to survive HITL suspension and resume
- FR-021: Every credential mint, reuse, and refusal audit record MUST carry run id, node id, agent client, Entra identity, capability scope, authority mode, and, for user-origin runs, the initiator's Entra object id
- FR-022: No bearer token, assertion, refresh token, or other credential material MAY appear in logs, audit records, error messages, capability handles, or the run's invocation origin
- FR-023: Every delegated credential held for a run MUST become unretrievable no later than run teardown
- FR-024: Initiator attribution and audit records MUST follow the existing run and audit retention policy unchanged. The Entra object id is a pseudonymous identifier of the same class as the realm subject already recorded, so no separate retention period applies. This MUST be stated in the data-handling notes (FR-044)

### Integration Requirements

- FR-030: Realm package MUST map the user's Entra object id from the Entra identity provider into access tokens issued to Fugue frontend clients
- FR-031: Realm validation MUST fail when any Fugue agent client has standard token exchange enabled
- FR-032: Realm validation MUST compare the expected and actual downstream scope assignments exactly (optional and default), reporting both missing and unexpected grants, and MUST fail when the Entra-exchange scope is a realm default/default-optional scope or is assignable to a frontend client
- FR-033: (P3, in scope) Realm package MUST offer an opt-in predictable service-account subject for agent clients, so federated credentials can be provisioned before the client exists
- FR-034: Re-applying the realm package MUST be idempotent and MUST either reconcile or explicitly reject pre-existing malformed clients, scopes, or mappers. Silent skipping is not allowed
- FR-035: No Fugue path MAY depend on Entra tokens stored by the realm's identity broker, and the `fugue-platform` realm's Entra identity provider MUST stop storing broker tokens (other realms are untouched). Nothing reads them, and their Graph audience makes them unusable for on-behalf-of, so they are unused credentials at rest
- FR-036: The host MUST define and enforce the contract by which any run-starting caller (HTTP run submission) presents an Entra user token audienced to the deployment's blueprint (or delegated audience) alongside the realm token. Only this host-side contract is in scope. The Fugue Teams bot is the HITL approval channel and does not start runs, so it has nothing to forward (OOS-009); LeadDesk frontend changes are out of scope (OOS-003)

### Documentation Requirements

- FR-040: New ADR(s) MUST record per-agent Entra identity (superseding ADR-0055), per-capability authority mode with no user exchange (partially superseding ADR-0056 and ADR-0058), and the delegated continuation policy
- FR-041: The provisioning runbook MUST be rewritten for per-agent identity under both models, RBAC for Applications, the Agent ID tenant spike with pass/fail criteria, fallback selection, rollback, and rotation, with an evidence template for the operator's live verification
- FR-042: The host auth doc, the consolidated team-security doc, spike #4, and the runbook MUST agree with the code. Each MUST separate implemented, configured, deployed, and live-verified status, and MUST NOT claim live status without evidence
- FR-043: A sequence diagram MUST identify every token and trust boundary for the agent, `app` user-origin, and `delegated` user-origin chains
- FR-044: The data-handling notes MUST record that initiator attribution and audit records now carry the Entra object id and tenant, that these follow the existing run and audit retention policy (FR-024), and how the delegated refresh credential is held, bound, capped, and deleted (FR-017)

---

## Non-Functional Requirements

### Performance

- NFR-001: A cached downstream credential handed to a node MUST add no realm or Entra network round trip
- NFR-002: Downstream credential acquisition MUST meet these p95 budgets. Host-added overhead (everything except network round trips to the realm and Entra) ≤ 10 ms p95, and a cache hit ≤ 5 ms p95, both verified in the automated suite with injected transports. Live cold-acquisition targets, verified by the operator during live verification (not a gate for this feature, OOS-001): ≤ 1500 ms p95 for the per-agent app registration model, ≤ 2000 ms p95 for the two-step Agent ID model (blueprint then agent identity), ≤ 2500 ms p95 for delegated on-behalf-of including the identity-binding check
- NFR-003: Run-start validation of authority modes and delegated-token verification and binding MUST add ≤ 50 ms p95 to run submission, excluding the first signing-key fetch (signing-key sets are cached)

### Security

- NFR-010: Every identity check fails closed. No mode, model, or configuration gap may degrade into broader authority
- NFR-011: The blast-radius unit is one host deployment: a compromise of one deployment exposes only the Entra identities under that deployment's parent identity (blueprint or its fallback set)
- NFR-012: Concurrent credential acquisition for the same identity, mode, and scope MUST be single-flight, and MUST NOT leak a credential across identities under concurrency

### Reliability

- NFR-020: No-config and partial-config boot modes MUST remain fail-closed with actionable warnings
- NFR-021: Transient upstream failures (realm or Entra unavailable, timeouts) MUST surface as the existing retryable typed failure kind, distinct from policy or configuration refusals. Credential acquisition MUST NOT retry internally (apart from the existing single-flight de-duplication, NFR-012); the node's existing retry policy is the single owner of retries, so an outage is not amplified by nested retries

---

## Success Criteria

- SC-001: 100% of agent-identity credential requests in the automated suite carry both the Entra-exchange grant and the capability grant, and 0 requests carry the capability grant alone
- SC-002: 0 realm-side user token exchanges occur across all user-origin test runs, and 0 user bearer tokens are retained for `app`-only runs, as shown by tests asserting call counts and registry absence
- SC-003: 100% of agent-origin runs requiring a `delegated` capability are refused at run start, with 0 node executions, 0 concurrency acquisitions, and 0 token egress
- SC-004: 100% of identity-binding negative controls (object id mismatch, tenant mismatch, wrong audience, expired, bad signature, missing Entra token) are refused with 0 on-behalf-of attempts
- SC-005: Realm validation detects 100% of seeded misconfigurations (agent client with standard token exchange, Entra-exchange as realm default or on a frontend client, missing object id mapper, unexpected or missing scope grant), and re-applying the package to a conforming realm makes 0 changes
- SC-006: An `app`-mode user-origin run suspended for HITL resumes and completes its downstream call after its inbound token has expired, in 100% of test runs
- SC-007: 0 occurrences of credential material in logs, audit, errors, handles, or invocation origin across the full suite, checked by a property or scan test
- SC-008: Switching an agent from the Agent ID model to the fallback model requires 0 changes to capability or DAG definitions
- SC-009: 0 identity docs listed in issue #42 claim an `app`-mode path acts "as the user", call a live-on-config path unwired, or carry a `PENDING-LIVE-VERIFICATION` status without an evidence template
- SC-010: Host typecheck, the full host test suite, and the realm config-as-code tests pass, with 0 regressions on admin and team token paths
- SC-011: In the latency benchmark with injected transports, host-added acquisition overhead is ≤ 10 ms p95, a cache hit is ≤ 5 ms p95, and run-start validation overhead is ≤ 50 ms p95 (NFR-002, NFR-003). The live cold-acquisition targets (1500 / 2000 / 2500 ms p95) are recorded in the runbook evidence template for the operator
- SC-012: 100% of delegated-continuation tests show: resume after suspension succeeds through the run-bound refresh credential; a refused refresh or expired custody suspends the run awaiting re-authorization with the typed re-authorization-required reason and 0 `app` fallbacks; re-authorization by the original initiator resumes the run at that node, and every other presentation is refused; 0 delegated credentials (access or refresh) remain retrievable after any terminal state; 0 plaintext refresh credentials in any store; and a run approved by a different approver acts on behalf of the original initiator in 100% of cases
- SC-013: 100% of capability definitions declare an authority mode (a definition without one fails typecheck), and 100% of seeded boot misconfigurations (data-sourced capability without a mode, configured Entra leg without a declared identity model, mapped agent client without an Entra identity) refuse to boot with an error naming the offender

**Measurement approach:** Automated tests with injected transports (call counts, captured request contents, egress counters, property tests over credential confinement), realm golden-export and validation tests, doc-lint checks for banned phrases and statuses, and a latency benchmark against the injected transports. Live-tenant evidence (federation matching, sign-in records, positive and negative resource controls) is gathered by the operator using the rewritten runbook and is not a gate for this feature.

---

## Out of Scope

- OOS-001: Live-tenant provisioning and verification, including the Agent ID spike execution, real Entra and Graph calls, and filling the runbook evidence. The operator owns these
- OOS-002: Migrating an existing live `fugue-agents` single-app deployment. Live provisioning was never completed, so no deployed state needs migration
- OOS-003: Changes to the LeadDesk frontend to acquire the Entra user token. Only the host-side contract it must meet is in scope
- OOS-004: Any concrete capability that uses `delegated` mode. Delegated mode is proven with test capabilities only
- OOS-005: Users outside the resource tenant (guest or cross-tenant users) for `delegated` mode
- OOS-006: Downstream identity providers or resource platforms other than Microsoft Entra and Microsoft 365, Dynamics, and Dataverse
- OOS-007: Changes to the admin-token and team-token inbound authentication paths
- OOS-008: ABAC policy authoring in the realm beyond the mappers and validations listed here
- OOS-009: Teams-originated run starts, including Teams SSO token acquisition and forwarding. The Fugue Teams bot is the HITL approval channel and does not start runs; any future Teams run-start path must meet the FR-036 host-side contract

---

## Open Questions

1. ~~Scenario priorities~~ Resolved: US1 to US4 P1, US5 to US7 P2, realm hardening (FR-033) P3. All are in scope and built; priority only orders the work.
2. Can an Entra Agent ID blueprint accept a federated credential from an external Keycloak issuer? Public docs only show managed identity. [DEFERRED: which identity model a given tenant uses until the operator's live Agent ID tenant spike (OOS-001) reports pass or fail against the runbook's criteria. This does not block the build: both models are built and tested, and each deployment declares its model explicitly in configuration with no default (FR-019)]
5. Delegated-mode facts the public docs leave open, added to the operator's tenant spike (OOS-001) with pass/fail criteria [DEFERRED to the spike; the build fails closed on each]: (a) the agent identity's on-behalf-of response returns a refresh credential when `offline_access` is requested; (b) admin consent of inheritable delegated permissions on the blueprint lets child agent identities perform on-behalf-of (they cannot take interactive consent, AADSTS82014); (c) the blueprint honours `requestedAccessTokenVersion: 2`, so user tokens audienced to it are v2; (d) whether Conditional Access sign-in frequency refuses refresh before the custody cap, which decides how often FR-027 re-authorization occurs in a given tenant
3. ~~Delegated continuation policy~~ Resolved: run-bound, encrypted, refresh-credential custody capped at the run's maximum suspension window (AS-026, FR-017).
4. ~~Teams bot scope~~ Resolved: out of scope; only the host-side run-submission contract is in scope (FR-036, OOS-009).

---

## Dependencies

- Keycloak `fugue-platform` realm (Keycloak 26.8.2) managed by the Keycloak config-as-code repository, with the Entra identity provider as the source of every user identity
- Microsoft Entra ID tenant that holds the Microsoft 365 resources, including Entra Agent ID (blueprints and agent identities), or plain app registrations as the fallback
- Microsoft Graph, Exchange Online (RBAC for Applications), SharePoint (`Sites.Selected`), and Dynamics/Dataverse as downstream resources
- LeadDesk frontend (and any other HTTP run-submission caller) as callers that start user-origin runs; the Fugue Teams bot as the HITL approval channel
- Existing Fugue HITL suspend/resume (ADR-0060, ADR-0071), the capability failure taxonomy (ADR-0059), and broker audit

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Entra Agent ID blueprint cannot federate from an external Keycloak issuer | High | Fallback model (one app registration per agent) is a first-class supported path behind the same contract, and a tenant spike gates the choice |
| Entra Agent ID is a preview or fast-moving product and its flows change | Med | Keep the identity model behind one contract, and pin the documented flow in an ADR with a re-verification step in the runbook |
| Delegated credential custody widens the host's credential blast radius | High | Refresh credential encrypted at rest, bound to run, agent identity, user and tenant, written once, deleted at terminal state, capped at the maximum suspension window; it is redeemable only with the agent identity's own credential. Entra evaluates every refresh (disabled account, Conditional Access, explicit session revocation) but a password reset does not revoke it, so the runbook documents the cut-offs: disable the user, revoke the user's sessions, or cancel the run. The decision is recorded in an ADR |
| Conditional Access sign-in frequency refuses delegated refresh well before the custody cap | Med | Runs suspend awaiting re-authorization instead of failing (FR-027); the spike measures the tenant's behaviour (Open Question 5d) |
| A client application other than LeadDesk obtains a token audienced to the blueprint | Med | Authorized-party allowlist in the host (FR-008), and the runbook pre-authorizes only the allowlisted clients on the blueprint's exposed scope with user consent disabled for it |
| Per-agent identities increase operator provisioning burden | Med | Runbook automation guidance, plus an optional predictable service-account subject for ahead-of-time federated credentials |
| Entra object id claim is absent for users who did not come through the Entra identity provider | Med | Binding fails closed. The realm guarantees every Fugue user is sourced through the Entra identity provider |
| Doc drift recurs after this change | Low | Doc-lint checks for banned phrases and statuses, and a status matrix separating implemented, configured, deployed, and live-verified |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Agent client | A Keycloak client that represents one Fugue agent (DAG). Its assigned optional scopes are the capability grants (AD-5) |
| Agent-origin run | A run with no human initiator, for example a scheduled or event-triggered run |
| User-origin run | A run started by a human authenticated with a realm token |
| Authority mode | Per-capability declaration of which principal the downstream resource authorizes: `app` or `delegated` |
| `app` mode | The agent acts as its own Entra identity. For user-origin runs the human is recorded for attribution only |
| `delegated` mode | The agent acts on behalf of a verified Entra user through on-behalf-of delegation, limited to that user's permissions |
| Entra-exchange grant | The realm scope that gives an agent's assertion the audience Entra requires for federated credential exchange |
| Federated assertion | A realm-issued agent token presented to Entra in place of a client secret |
| Entra Agent ID | Microsoft Entra's agent identity product: a blueprint (parent) and agent identities (children) |
| Blueprint | The Entra Agent ID parent identity. There is one per host deployment, and it is the blast-radius unit |
| Agent identity | The Entra Agent ID child identity. There is one per Keycloak agent client |
| Fallback model | One ordinary Entra app registration per agent client, each with one federated credential |
| Entra object id | The immutable Entra identifier of a user (`oid`), used for binding and for attribution joinable with Microsoft 365 audit |
| Identity binding | The check that the realm token and the Entra user token belong to the same person (same object id and tenant) |
| Initiator attribution | The recorded identity of the human who started a run, kept durably without any bearer token |
| Delegated continuation | How delegated authority persists across HITL suspension or token expiry |
| Policy decision point | The realm, which decides through scope assignment whether an agent may use a capability |
| Enforcement point | Entra and the resource, which enforce the identity's granted permissions on each call |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-11-24 | Initial draft from the settled design and issue #42 (specify interview not held because the tool was unavailable) | specify-agent |
| 2026-11-24 | Clarify: resolved all 17 markers under the user's explicit delegation (see `clarifications/log.md`); added AS-033, AS-034, FR-019, FR-025, FR-044, SC-012, SC-013, OOS-009; status Draft to Clarified | clarify-agent |
| 2026-11-24 | Architecture: renumbered non-canonical ids so the Loom spec parser (decompose input) accepts the spec: AS-013a to AS-033, AS-026a to AS-034, FR-019a to FR-025; moved the `(P3)` tags on AS-019 and FR-033 after the id colon. No requirement text changed | architecture-agent |
| 2026-11-24 | Architecture loop-back 1 (plan alignment): added AS-035 and AS-036, which restate as acceptance scenarios the automated-suite clauses NFR-002 and NFR-003 already contained ("verified in the automated suite with injected transports"), so the latency budgets can be acceptance-contract anchors (Loom accepts only FR and AS ids there). No NFR, SC or existing requirement text changed; the live targets stay operator evidence (OOS-001) | architecture-agent |
| 2026-11-25 | User design review of delegated mode (decided by the user, not under delegation): custody written once and never rotated; revocation wording corrected (a password reset does not revoke confidential-client refresh credentials); FR-008 adds the authorized-party allowlist and the exact delegated scope; added FR-026/AS-042 (fail closed on catalog drift at resume), FR-027/AS-041 (re-authorization path; AS-034 and FR-017 now suspend instead of failing), FR-028/AS-043 (atomic decision-with-approver, every click audited, acting principal shown), AS-040, Open Question 5 (spike items) and two risks | orchestrator, from the user's review |
| 2026-11-24 | Architecture loop-back 4 (plan alignment, JUDGE-1): added AS-037 (US5, run start), AS-038 (US6, continuation and custody at rest) and AS-039 (US2, `app` execution path), which restate FR-022 per surface so the no-credential-material prohibition can be decided by the acceptance of the contract whose phase builds each surface (Loom anchors each Requirement in one contract only; FR-022 itself is anchored on the mint path). No FR, NFR, SC or existing scenario text changed | architecture-agent |
| 2026-11-25 | User decision on the loop-back 11 report (decided by the user, not under delegation): a re-authorization is fresh consent, so the re-established custody gets a fresh window, min(re-authorization time + the configured maximum, the run's deadline), and a run suspended for expired custody can be re-authorized; the run deadline is still never extended. FR-027 and AS-041 reworded accordingly | orchestrator, from the user's review |
