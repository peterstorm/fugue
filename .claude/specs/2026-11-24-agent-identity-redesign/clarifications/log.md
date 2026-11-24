# Clarifications Log: 2026-11-24-agent-identity-redesign

**Spec:** `../spec.md`
**Markers at start:** 17 `[NEEDS CLARIFICATION]`
**Markers at end:** 0

## How these were decided

No interview was held. The user was unreachable, and `AskUserQuestion` is not available to Loom subagents in this harness. Every decision below was **decided by the orchestrator under explicit user delegation**, quoting the user:

> "im gonna go to bed, you just run the whole loom workflow please, and during interview, just pick the most correct, best, most functional approach, for all questions ok"

Earlier context the user gave the orchestrator, which the decisions rely on:

- "no use case yet, but lets build it anyway" (build delegated mode now)
- "I want the most correct solution to the agent auth problem"
- "the keycloak users are all in entra, we mostly use keycloak to do advanced ABAC, but every identity is sourced through the entra idp"
- Users and M365 resources are in the same tenant.

**User: please review each decision below.** Any of them can be reversed before architecture or implementation by editing the spec line named under "Updated".

Repository facts checked by the clarify agent: the Teams bot adapter lives in `packages/host/src/hitl/adapters/bot/` (card, notifier, messages handler, the HITL approval channel), and the capabilities `msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read` are defined in host code (`packages/host/src/domain/`).

---

## 2026-11-24: Scenario priorities (Open Question 1)

**Question:** Confirm provisional priorities US1 to US4 P1, US5 to US7 P2, FR-033 P3.
**Answer:** Confirmed. All are in scope and built; priority only orders the work.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** Summary interview note, AS-019 and FR-033 tagged P3 (FR-033 changed from MAY to MUST offer, since it is in scope), Open Questions item 1.
**Rationale:** The user asked for the whole thing to be built; priorities follow the dependency order (agent path first, delegated mode on top, optional hardening last).

## 2026-11-24: Capability without an authority mode (AS-009, FR-005)

**Question:** Boot-time refusal for a missing authority mode, or migrate every capability to declare `app` with no fallback?
**Answer:** Both, made stronger: the authority mode is part of each capability's definition, so omitting it is a build-time (type) error for capabilities defined in code, and a boot-time refusal naming the capability for any capability set arriving as data. All existing capabilities (`msgraph:mail.send`, `msgraph:sites.read`, `dynamics:read`) are migrated to declare `app` explicitly. No default mode, no fallback.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** AS-009, FR-005, SC-013 (new).
**Rationale:** Illegal states are unrepresentable; a silent default is how authority widens.

## 2026-11-24: Agent client with no Entra identity mapped (AS-013)

**Question:** Fail at boot for every mapped agent, or lazily at first use?
**Answer:** Fail at boot for every agent client the deployment maps, once the Entra identity leg is configured. The existing config-presence gating is unchanged: each leg lights up only when its config is complete, and partial config stays fail-closed with an actionable warning.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** AS-013, AS-033 (new, see the identity-model decision below), FR-019 (new), SC-013 (new).
**Rationale:** A mis-provisioned deployment is found at deploy, not mid-run; consistent with existing fail-closed boot modes (NFR-020).

## 2026-11-24: Delegated continuation policy (AS-026, FR-017, Open Question 3)

**Question:** Option A (run-bound, encrypted, refreshable delegated credential) or Option B (approver re-presents a fresh Entra user token at approval)? For A, maximum custody?
**Answer:** Option A. Run-bound custody of the delegated refresh credential returned by on-behalf-of:
- encrypted at rest, only ciphertext in any store;
- bound to (run, agent identity, user Entra object id, tenant);
- never logged or placed on a handle;
- deleted when the run reaches a terminal state;
- custody capped at the run's maximum suspension window, default 7 days, configurable, never unbounded;
- revocation enforced by Entra at every refresh (user disabled, password reset, Conditional Access, risk).
When the refresh is refused or custody has expired, the delegated capability fails closed with a typed "delegated authority unavailable, re-authorization required" error surfaced to the initiator. It never falls back to `app` authority.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** AS-026, AS-034 (new), FR-017, FR-044 (new), SC-012 (new), Risks table, Open Questions item 3.
**Rationale:** The HITL approval channel (the Teams bot approval card) cannot carry a fresh Entra user token, so Option B would make delegated runs non-resumable in practice. The refresh credential is bound to the agent identity client, so it is useless without the agent's own credential. Entra-enforced revocation is stronger than anything the host could do itself.

## 2026-11-24: Delegated run approved by a different person (AS-028)

**Question:** May a different approver resume a delegated run, and on whose behalf does it then act?
**Answer:** Any approver authorized by the existing HITL approver authorization may approve. Approval never lends authority: after resume the run continues acting on behalf of the original initiator (whose delegated authority was granted at run start). The approver is recorded separately as the approver. The run never acts on behalf of the approver.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** AS-028, FR-025 (new), SC-012 (new).
**Rationale:** Approval and authority are distinct facts; the initiator requested these actions conditional on approval.

## 2026-11-24: Retention of records carrying the Entra object id (FR-024)

**Question:** Is the existing retention policy acceptable, or does a separate period apply?
**Answer:** The existing run and audit retention policy applies unchanged. The Entra object id is a pseudonymous identifier of the same class as the realm subject already recorded. No separate retention period. Documented in the data-handling notes.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** FR-024, FR-044 (new).
**Rationale:** Same data class as what is already stored; a separate policy would add complexity without changing the privacy posture.

## 2026-11-24: Realm broker token storage (FR-035)

**Question:** Should the realm package stop storing broker tokens?
**Answer:** Yes, for the `fugue-platform` realm's Entra identity provider only. Other realms are untouched.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** FR-035.
**Rationale:** Unused credentials at rest are pure liability. Nothing reads them, and their Graph audience makes them unusable for on-behalf-of anyway.

## 2026-11-24: Teams bot SSO forwarding (FR-036, Open Question 4)

**Question:** Is changing the Teams bot to obtain and forward the Entra user token in scope?
**Answer:** Out of scope, and the requirement narrows. The Teams bot in this repo is the HITL approval channel (`packages/host/src/hitl/adapters/bot/`); it does not start runs, so it has nothing to forward. In scope is the host-side contract by which any run-starting caller (HTTP run submission) presents the Entra user token alongside the realm token. LeadDesk changes stay out (OOS-003). Teams-originated run starts are a new out-of-scope item.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** FR-036, OOS-009 (new), US5 role line, Dependencies, Open Questions item 4.
**Rationale:** The spec wrongly listed the Teams bot as a run starter; the narrowed contract covers every real caller.

## 2026-11-24: Credential acquisition latency (NFR-002, SC-011)

**Question:** Target p95 for cold acquisition.
**Answer:**
- Host-added overhead (everything except network round trips to the realm and Entra) ≤ 10 ms p95, verified in tests with injected transports.
- Cache hit ≤ 5 ms p95.
- Live cold-acquisition p95 targets for the operator's live verification: ≤ 1500 ms (per-agent app registration model), ≤ 2000 ms (two-step Agent ID model), ≤ 2500 ms (delegated on-behalf-of including the binding check).
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** NFR-002, SC-011.
**Rationale:** The automated suite can only measure what the host controls; network latency to Entra is verified live by the operator (OOS-001).

## 2026-11-24: Run-start validation overhead (NFR-003)

**Question:** Acceptable p95 overhead on run submission.
**Answer:** ≤ 50 ms p95 for authority-mode validation and delegated-token verification and binding, excluding the first signing-key fetch (key sets cached).
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** NFR-003, SC-011.
**Rationale:** Local signature and claim checks against cached keys are cheap; the first key fetch is a network cost outside the host's control.

## 2026-11-24: Retries on transient upstream failure (NFR-021)

**Question:** Retry internally, or leave retry to the node's failure taxonomy?
**Answer:** No internal retry (apart from the existing single-flight de-duplication). Transient failures surface as the existing retryable typed failure kind, and the node's existing retry policy owns retries.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** NFR-021.
**Rationale:** One owner of retry policy; nested retries multiply load during an outage.

## 2026-11-24: Agent ID spike outcome and default identity model (Open Question 2) - DEFERRED

**Question:** Can an Entra Agent ID blueprint accept a federated credential from an external Keycloak issuer, and which model is the default?
**Answer:** Deferred: which model a tenant uses is open until the operator's live Agent ID tenant spike (OOS-001) reports pass or fail against the runbook's criteria. It does not block the build. Added requirement: a deployment declares its identity model explicitly in configuration; there is no default model. Both models are built and tested.
**Decided by:** orchestrator under explicit user delegation (quote above).
**Updated:** Open Questions item 2 (`[DEFERRED: ... until ...]`), FR-019 (new), AS-033 (new), SC-013 (new).
**Unblocks when:** the operator runs the tenant spike from the rewritten runbook.
**Rationale:** The answer needs a live tenant, which is out of scope; an explicit model declaration removes any need for a default.

## 2026-11-24: Summary interview note

**Change:** Rewrote the Summary's interview note to say the interviews were replaced by the user's explicit delegation, with decisions logged here. Spec status Draft to Clarified.

---

## Implicit ambiguity scan (P1 scenarios)

- AS-013 previously said "When the host boots or the agent first needs a credential"; resolved to boot-time only.
- US3 did not say how a deployment chooses its model; resolved by FR-019 and AS-033 (explicit, no default).
- US5 and Dependencies named the Teams bot as a run starter; corrected to the HITL approval channel.
- No other P1 ambiguity found: AS-001 to AS-019 name concrete triggers, outcomes, and typed failures.

## Clarification Summary

| Category | Status |
|----------|--------|
| Functional scope | Resolved (priorities, Teams bot scope, FR-033 in scope) |
| Data model | Resolved (authority mode in the capability definition, refresh-credential binding, approver vs initiator) |
| UX flows | Resolved (re-authorization-required error to the initiator) |
| Performance | Resolved (NFR-002, NFR-003, SC-011) |
| Integration | Resolved; Agent ID federation deferred to the operator's live spike |
| Edge cases | Resolved (missing mode, missing mapping, missing model, refused refresh, expired custody, different approver) |
| Constraints | Resolved (retention, broker token storage, no internal retry) |

**Remaining `NEEDS CLARIFICATION` markers:** 0
**Deferred to architecture:** 0
**Deferred (external unblock):** 1 (Open Question 2, Agent ID spike)
**Ready for architecture:** Yes

---

## Architecture phase decisions

No interview was held. Every answer below was **decided by the architecture agent under explicit user delegation** (quote at the top of this log). The plan is `.claude/plans/2026-11-24-agent-identity-redesign.md`, and each answer maps to an AD block there. **User: please review.** Any decision can be reversed by editing the plan before decompose.

### 2026-11-24: Approach gate

**Options:**
- A: run-bound authority, where a boot-scoped `CapabilityAuthority` gives each run a broker through `forRun(RunAuthority)`, with a pure run-start planner and eager delegation plus encrypted custody.
- B: a boot-scoped broker plus a process-global run-authority registry keyed by run id, with lazy on-behalf-of.
- C: a framework-native authority mode validated by framework preflight.

**Picked:** A, which was also the recommendation.
**Rationale:**
- A run's authority becomes an immutable value. It is persisted with the HITL record and dies with the run.
- B keeps shared mutable state and holds the raw user token until first use.
- C breaks ADR-0054 (vendor neutrality) and cannot refuse before the host acquires a concurrency slot, which AS-010 requires.

### 2026-11-24: Self-interview answers

1. **Scope and slicing:** everything in the spec is built. Phases follow dependency order (foundations and demolition, then topology and ports, then the capability authority, then HITL, then admission and composition, then verification and docs).
2. **Authority mode source:** one code catalog with a required `authority` field (a type error if it is missing) and a branded `CapabilityCatalog` parser for data. There is no default, and all three existing capabilities declare `app` (AD-2).
3. **Identity model:** `ENTRA_IDENTITY_MODEL` is `agent-id` or `app-registration` with no default. It parses into the `EntraDirectory` ADT, and `ENTRA_CLIENT_ID` is removed and refused by name (AD-3).
4. **Boot strictness:** with no `ENTRA_*` keys the leg is dark, with a warning. If any `ENTRA_*` key is set, the configuration must be complete and consistent, or boot is refused naming every offender, which matches the existing paired-field refusals.
5. **Run-start validation:** a pure planner in `run-dag.ts`, called after input-schema parsing and before the HITL fork and concurrency acquisition (AD-5).
6. **Delegated token transport:** the `X-Fugue-Delegated-Authorization: Bearer <entra-jwt>` header. It is refused on runs that need no delegation, and the manifest publishes the requirement and the expected audience (AD-7).
7. **Binding:** realm user JWTs must carry `entra_oid` and `entra_tid` (required claims). The Entra token must be a v2.0 delegated token (`scp`) for the deployment tenant, audienced to the blueprint (agent-id model) or the agent's app (app-registration model), and its `oid` and `tid` must equal the realm token's (AD-7).
8. **Delegated continuation:** one on-behalf-of exchange with `offline_access` at admission, then AES-256-GCM custody of the refresh credential. The AAD is (run, agent, oid, tid, expiry). The expiry is fixed at establishment and capped at `DELEGATED_CUSTODY_MAX_SEC` (default 604800, at most `HITL_RUN_TTL_SEC`), and custody is deleted at every terminal state (AD-6, LC-1).
9. **Key management:** `DELEGATED_CUSTODY_KEYS` holds an active kid plus a keyring, is held by the worker only, and is rotated by adding a kid.
10. **Error taxonomy:** a new non-retriable framework kind, `authority-unavailable`, with the causes grant-missing, unconfigured, federation-rejected and reauthorization-required. Transient failures stay `infra-unreachable`, and run-start refusals are the host `run-authority-refused` error (AD-8).
11. **Caching:** a boot-scoped app cache keyed by (Entra identity, app, capability) and a run-scoped delegated cache keyed by (Entra identity, delegated, user oid, capability). Capability stays in the key so the realm keeps deciding policy per capability.
12. **Approver vs initiator:** a typed `ApproverRef` is passed to `recordDecision`. Approvals are kept on the run record and in a `hitl-decision` audit record, and authority is rebuilt only from the run's own record (AD-9).
13. **Testing:** fakes for every port, fast-check property tests, the SC-007 sentinel scan and the SC-011 benchmark with injected transports. Live evidence is gathered by the operator.
14. **Executable models:**
    - LC-1: custody lifecycle.
    - INV-1: no RFC 8693 token exchange (checkable lint rule).
    - INV-2: one source for the authority mode (owned by the catalog, with a matrix test).
    - INV-3: no credential material in observable surfaces (advisory).
    - CT-1 to CT-3: admission, the mint path, and continuity.
    - No pipeline.
15. **Port placement:** new ports go in `packages/host/src/domain/port/` as `architecture.md` requires. The local convention defines ports inside adapter files; this conflict is flagged and existing ports are not moved (AD-11).
16. **Doc truth:** a `scripts/check-identity-docs.ts` doc-lint (status matrix, banned phrases, evidence-gated statuses) wired into `scripts/verify.sh` (AD-10).
17. **Realm work:** this is specified in the plan's "Cross-Repo Realm Work" section and executed outside the task graph in the keycloakConfigAsCode worktree. It covers:
    - the `entra_oid` and `entra_tid` claims, with an admin-only user-profile edit
    - token exchange pinned off
    - an exact scope comparison
    - no broker token storage
    - idempotent reconcile or explicit reject
    - an opt-in predictable service-account subject

    Deploy order: the realm before the host.

### 2026-11-24: Spec id renumbering

**Change:** The Loom spec parser accepts only canonical ids, so decompose could not read the spec. AS-013a was renumbered to AS-033, AS-026a to AS-034 and FR-019a to FR-025. The `(P3)` tags on AS-019 and FR-033 moved after the id colon. References in this log and in the spec were updated in place. No requirement text changed.
**Decided by:** the architecture agent, as a mechanical fix.
