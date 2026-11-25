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

### 2026-11-24: Loop-back 1 (plan alignment)

The plan-alignment gap report raised four gaps. The approach (A) and the interview answers are unchanged. **User: please review.**

- **JUDGE-1, latency budgets gate the phases that build the code.** The NFR-002 budgets (host-added acquisition overhead of at most 10 ms p95, cache hit of at most 5 ms p95) are now a CT-2 acceptance file, gated at Phase 3, which builds the mint path. The NFR-003 budget (run-start validation of at most 50 ms p95) is now a CT-1 acceptance file, gated at Phase 5, which builds admission. Both use injected zero-latency transports, 50 warm-up and 500 timed samples, and a nearest-rank p95. The Phase 6 benchmark is removed. Loom accepts only FR and AS ids as acceptance anchors, so the spec gains **AS-035** and **AS-036**. They restate the "verified in the automated suite with injected transports" clauses that NFR-002 and NFR-003 already contained. No NFR or SC text changed.
- **OWN-1, custody deletion has one owner.** New owned invariant **INV-4**. The owner is `adapters/custody-release.ts` (`releaseCustody(runId, cause)`), the only holder of the custody store's `delete`. Its siblings are `hitl/service.ts` (terminal arms, corrupt-checkpoint settle, evicted record, start compensation), `http/handlers/run-dag.ts` (sync `finally`, establishment failure) and `adapters/delegation-establishment.ts` (put compensation). The matrix test drives every path, with mutation verification on, and replaces `custody-teardown.test.ts`. Idle Redis-TTL eviction and tenant purge have no code path, so they are not siblings. Custody PX (at most the record TTL) and `purgeTenantKeyspace` cover them, and the Redis store test asserts both.
- **SEAM-1, the supervisor proxy is a CT-1 seam.** `proxyToWorker` is declared as a runtime seam. CT-1 acceptance submits a delegated run through it into the worker's auth middleware and route. It asserts that the delegated header is forwarded byte-identical, that a client-forged tenant header is stripped, and that nothing is logged.
- **SEAM-2, approvals go through the production handlers.** CT-3's runtime seams add `createAuthMiddleware`, `createApproveRunHandler`, `handleBotActivity`, `errorResponse` and `createCustodyRelease`. CT-3 acceptance approves over HTTP and through the Teams bot handler, so the `ApproverRef` is derived as in production.

**Decided by:** the architecture agent, under the user's explicit delegation.

### 2026-11-24: Loop-back 2 (plan alignment)

The plan-alignment gap report raised one gap. The approach (A), the interview answers and the spec text are unchanged.

- **SEAM-1, attribution is decided through the production execution hop.** AS-006, FR-004 and FR-020 need every mint audit record of a user-origin run to carry the initiator's Entra `oid`. In production that attribution passes from admission through `executeDag` (host.ts) and `createNodeContextForDag` (`node-context-factory.ts`), and `RunDagDeps` makes both injectable, so a test could stub them; CT-2 drives `invocationFor` and `mintFor` directly and does not cover the hop either. The three requirements move from CT-1 to a new contract, **CT-4: User-origin run attribution through execution** (types file `none`, entry point `packages/host/src/host.ts`, acceptance `packages/host/src/__tests__/acceptance/user-run-attribution.acceptance.test.ts`). Its runtime seams are `createRunDagHandler`, host.ts `createRunContextFactory` and `createDagExecutor` (now exported and used by `buildRouterDeps`), `createNodeContextForDag` and `createCapabilityAuthority`. The acceptance runs a user-origin sync run end to end with fake transports only, for both identity models, and asserts the initiator's `oid` (with realm sub and tid) on every mint audit record, no retained user token, and a team-origin control with no initiator. `createNodeContextForDag` now returns a `RunMinting{authority, origin}` built from one `RunAuthority`, which `executeDag` takes, so origin and authority cannot disagree. A new contract was chosen over extra CT-1 seams because every acceptance file of a contract must reference every one of its seams, which would have folded DAG execution into CT-1's AS-036 run-start validation budget. Each requirement is still anchored in exactly one contract.

**Decided by:** the architecture agent, under the user's explicit delegation.

### 2026-11-24: Loop-back 3 (plan alignment)

The plan-alignment gap report raised one gap (SEAM-1: CT-3 runs could be started by calling `startRun` with a hand-built `RunAuthorityPlan`, bypassing the production admission). Three passes had each found one more contract whose acceptance bypassed a production seam, so this loop-back swept all four contracts instead of fixing only CT-3. The approach (A), the interview answers, the spec text and every Requirement anchor are unchanged. **User: please review.**

- **Root cause.** The bypasses had one shape: a dependency injected into the route, the HITL service or an executor (admission, establishment, custody release, the capability authority) had no declared production factory, so an acceptance test could supply its own. Declaring each internal factory one at a time cannot end that, because the engine requires every acceptance file to name every declared seam in code.
- **Fix: one composition, declared as a seam.** A new `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`, Phase 3) is the only production composition of the identity subsystem: authority legs, the realm and Entra adapters for the configured identity model, the Entra user token verifier, the custody cipher and store, `createCustodyRelease`, `createCapabilityAuthority` and the new `createRunAuthorityAdmission` (`adapters/run-authority-admission.ts`). host.ts calls it once and hands the same instance to the route and the HITL engine. host.ts also exports `composeHitlRunService`, the production HITL composition (run and decision stores, executor, run queue, service). `HostDeps.capabilityBroker` is removed, because an injected broker bypassed this composition; `HostDeps.identityTransports` replaces it. Acceptance may fake only transports, Redis, the queue backend, the notifier, the Bot Framework token verifier and the clock.
- **Per contract.** CT-1 adds `composeRunAuthorityWiring`. CT-2 adds `composeRunAuthorityWiring`, so both identity models run through the production adapter selection. CT-3 starts every run at `proxyToWorker` through `createAuthMiddleware` and `createRunDagHandler` (the requested fix), takes its HITL engine from `composeHitlRunService` and runs sync delegated runs through `createRunContextFactory` and `createDagExecutor`; its seams `createHitlRunService`, `createRunExecutor` and `createCustodyRelease` are replaced by the compositions that build them. CT-4 adds `proxyToWorker`, `createAuthMiddleware` and `composeRunAuthorityWiring`, which replaces `createCapabilityAuthority`.
- **AS-027 cancelled teardown.** The only cancelled run is a sync run aborted by the route's timeout, so CT-3 acceptance now also drives sync delegated runs (completed, failed, timeout abort) and checks that no credential survives.
- **Phasing.** CT-3 acceptance needs the Phase 5 route and host.ts composition, so decompose assigns CT-3's Requirements to the Phase 5 Task that wires them, and CT-3 is green at the Phase 5 Wave Gate.

The plan's Testing Strategy holds the full seam-sweep table (contract, Requirement, production path, seams declared, and why each undeclared symbol on the path cannot be bypassed).

**Decided by:** the architecture agent, under the user's explicit delegation.

### 2026-11-24: Loop-back 4 (plan alignment)

The plan-alignment gap report raised three gaps. Because each pass had surfaced a few new gaps, the architecture agent then self-audited the whole plan against every alignment category and fixed what it found (the table is in the plan's Testing Strategy, "Plan self-audit (loop-back 4)"). The approach (A) is unchanged. **User: please review**, especially the two refinements of earlier answers marked below.

- **FR-017 / AS-026, custody default.** `DELEGATED_CUSTODY_MAX_SEC` is optional and must be a positive integer number of seconds, otherwise `loadConfig` refuses boot naming the key. When unset, custody is capped at min(604800, `HITL_RUN_TTL_SEC`). `HITL_RUN_TTL_SEC` defaults to 604800, so the out-of-the-box cap is exactly 7 days. A set value above `HITL_RUN_TTL_SEC` is the boot refusal `custody-max-exceeds-run-ttl`. **Refinement of answer 8 above** ("default 604800, at most `HITL_RUN_TTL_SEC`"): taken literally, a deployment that lowered `HITL_RUN_TTL_SEC` without touching custody would be refused boot by a default it never set. The min() keeps answer 8 unchanged under default keys.
- **AS-009 / FR-005 / SC-013, data-sourced catalog.** Boot has one catalog entry point. `createHost` calls `loadCapabilityCatalog(HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG)`, so the code catalog is only the default raw source and passes through the same branded parser at every boot. A data catalog entry without a mode makes `createHost` return the new `capability-catalog-invalid` HostError naming the capability, before anything connects or binds. The test is `boot-capability-catalog.test.ts`, in Phase 1. The one parsed catalog feeds the gate, `composeRunAuthorityWiring` and the manifest. Nothing parses a catalog at module load.
- **JUDGE-1, FR-022 / SC-007 decided where the surfaces are built.** Loom anchors each Requirement in one contract only, so FR-022 is anchored in CT-2 (mint path, Phase 3). The spec gains **AS-037** (run start, CT-1), **AS-038** (continuation and custody at rest, CT-3) and **AS-039** (`app` execution path, CT-4), which restate FR-022 per surface, as AS-035 and AS-036 did for the latency budgets. Each contract's acceptance scans nine enumerated surfaces of the production composition through a shared `credential-sentinel.ts`: logs, audit, spans, HTTP responses, error values, handles, origins and run authorities, run records and checkpoints, and custody at rest, which must be ciphertext only. The trailing Phase 6 scan is removed.
- **Self-audit fixes:**
  - **Refinement of answer 4 above.** The plan treated any `ENTRA_*` key as "configured" and refused partial config. That contradicted the clarify answer for AS-013 ("partial config stays fail-closed with an actionable warning"). Each leg is now gated on its presence keys:
    - The Entra leg is configured only when `ENTRA_TENANT_ID` and `ENTRA_AGENT_IDENTITIES` are both set; otherwise it is dark, with a warning naming the missing keys.
    - The delegation leg is configured when `DELEGATED_CUSTODY_KEYS` is set, and stays dark, with a warning, over a dark Entra leg.
    - Only a configured leg can be refused, for a missing model, an unmapped agent and similar faults.
    - The removed `ENTRA_CLIENT_ID` is still refused by name, so that a leftover shared-app key does not go silently dark.
  - Boot refusals have a named HostError, `identity-config-invalid`, and a host-level test, `boot-identity-refusal.test.ts`.
  - AS-034's "surfaced to the initiator" is now concrete: a sync 401 response, or the HITL run status through `GET /runs/:runId`, which adds `createGetRunHandler` as a CT-3 seam.
  - CT-2 now states single-flight, no internal retry, the request-body shape (FR-002, FR-003, FR-012) and the dark-leg refusal.
  - New owned invariant **INV-5**: the delegated audience has one source (`delegatedAudienceFor`), shared by admission, establishment and the manifest.
  - The `RedactedSecret` runtime moved out of the declarations-only contract types file, into `domain/redacted-secret.ts`.
  - The mint port takes a `CapabilityScope` from the parsed catalog, so that data and test capabilities reach it.
  - A Phase boundary rule moves every deletion of the legacy broker path into the Phase 5 host switch, so that every Wave type-checks.

**Decided by:** the architecture agent, under the user's explicit delegation.

### 2026-11-24: Loop-back 5 (plan design review)

The plan design review (code-reviewer, type-design-analyzer, architecture-tech-lead) returned 12 advisories. The orchestrator accepted all of them under the user's delegation ("most correct, best, most functional"), and the architecture agent resolved each in the plan as directed. The approach (A), the interview answers, the spec text, the contracts' Requirement anchors and runtime seams, LC-1's states and events, and the five invariants are unchanged. The design-review self-audit is in the plan's Testing Strategy, "Plan self-audit (design-review loop-back 5)". **User: please review.**

1. **Phase 4 broke typecheck.** Phase 4 changed `startRun`, `HitlRunServiceDeps` and `RunExecutorDeps`, but their production callers (`run-dag.ts`, host.ts) changed only in Phase 5. **Resolution:** the two phases are refolded. Phase 4 is now one run-start cut-over: a single Task changes every coupled signature (`startRun`, the HITL and executor deps, `RunDagDeps`, `NodeContextForDag`, `RunRecord.authority`) together with its callers, and deletes the legacy broker path. Phase 5 is approvals and the manifest, each one Task with its own callers. The Phase boundary rule now also covers signature changes: functions, deps records, ports, unions matched with `.exhaustive()`, and persisted schemas travel with every caller in one Task. Applying the rule also moved the host's `authority-unavailable` HTTP mapping into the Phase 1 Task that widens the framework error union. The INV-4 hedge ("if decompose schedules…") is removed: both sibling rows land in the cut-over Task.
2. **`custody-expired` was unreachable**, because stores return `absent` once PX has passed. **Resolution, chosen as the most accurate error that keeps the cap:** the store keeps PX at the binding expiry, so no ciphertext outlives the cap, and returns `absent` for a missing key. The custody cell checks the expiry that the run's `RunAuthority` carries before it reads the store. A resume past expiry is `custody-expired`, with zero store reads and zero Entra calls. A record that is gone before its expiry (released, evicted or purged) is `custody-absent`. Keeping ciphertext past the cap, so that the store could answer `expired` itself, was rejected because it would hold the credential longer than FR-017 allows. Collapsing the two reasons into one was rejected because it would give the initiator a less accurate error. AD-8, LC-1's `reauthorizationReasonOf`, CT-3 (both cases) and the AS-026 and AS-034 acceptance agree.
3. **Concurrent delegated redeem and the CAS loser.** **Resolution:** each run gets one single-flight custody cell inside the `forRun` closure. It is the only reader and writer of the run's custody, and it serializes get, open, redeem and rotate; the per-capability access cells read from it.
   - A compare-and-swap on a missing record fails and never creates one, so a late rotate after release yields `custody-absent`.
   - A generation mismatch re-reads and swaps once more against the current generation. It never errors spuriously and never discards a rotated credential before a write attempt.
   - The full host-error ↔ custody-transition table is in Component Design (Capability Authority).
   - CT-2 acceptance adds concurrent delegated capabilities in one run, CAS on a missing record, and a contending second writer.
4. **CAS fencing in types.** **Resolution:** the two persisted states, `held` and `revoked`, each carry a `CustodyGeneration`. `get` returns `CustodyRead` (`absent | held | revoked`), never `expired` or `deleted`. `swap` takes `CustodySwap{expected, next}` and returns `swapped | stale{current} | missing`. The rules "`next.generation = expected + 1`" and "never creates" are declared on these CT-3 types.
5. **Shallow run-authority bracket.** **Resolution:** a new INV-4 owner, `createRunAuthorityLifecycle` (`adapters/run-authority-lifecycle.ts`, replacing `custody-release.ts`), owns the bracket and derives the release cause from its outcome. It offers three operations:
   - `withEstablishedAuthority(plan, runId, deadline, body)` for sync runs
   - `establishForRecord(plan, runId, deadline, persist)` for the HITL start
   - `endRun(runId, ending)` for HITL endings, called once after `processRun`'s outcome fold

   The route makes one call and the HITL service makes two. `delegation-establishment.ts` is no longer a sibling. INV-4 and its matrix (renamed `run-authority-lifecycle.matrix.test.ts`) shrink accordingly, keeping the single release owner.
6. **Five parallel fault vocabularies.** **Resolution:** one `AcquisitionFault` ADT in the CT-2 types replaces `AssertionFault`, `EntraAcquisitionFault`, `DelegationEstablishmentFault` and the separate reason list of `delegation-not-established`. Two exhaustive projections translate it, `frameworkErrorOf` (to the framework error) and `runAuthorityRefusalOf` (to the refusal). Each is applied in exactly one module, so no new invariant is needed. Token-endpoint error classification is one pure function, `classifyTokenEndpointError`, property-tested once.
7. **Delegated token verified before higher-precedence refusals, and 8. JWKS egress.** **Resolution:** admission is two passes.
   - Pure pass 1 (`planRunAuthority`) decides every static refusal in precedence order.
   - The shell verifies the token against the JWKS only for a `verify-delegated` step. That step carries a `DelegatedTokenExpectation`, which can exist only when the directory, the mapped agent and the expected audience exist.
   - Pure pass 2 (`admitDelegatedPresentation`) validates the claims and binds the principal.

   A property test asserts that the precedence order is preserved and that the JWKS is called zero times on a statically refusable request. CT-1 asserts the same through the production path. Because pass 1 now builds the expected audience, INV-5's admission sibling becomes `domain/run-authority.ts`.
9. **`RunMinting` origin and authority could disagree.** **Resolution:** `RunMinting` is removed. `forRun(authority)` returns `{broker, origin}`, with the origin from one `originOf(authority)`. `createNodeContextForDag` hands on only the `RunAuthority`. The broker takes identity only from its closure, so the per-invocation `agentClientIdFromFrameworkOrigin` re-check, now redundant, is removed.
10. **Duplicated custody expiry and initiator.** **Resolution:** the `RunAuthority` is the one canonical value. Custody records store no binding, and `custodyBindingOf(runId, authority)` derives the AAD at seal and at open, so the sealed AAD and the record cannot diverge.
11. **Bare numbers for custody seconds and epoch milliseconds.** **Resolution:** `CustodySeconds` (only `parseCustodySeconds` builds it, checked against `HITL_RUN_TTL_SEC`), `EpochMs`, `DurationMs` and `CustodyGeneration` are brands, and `custodyExpiryFor(EpochMs, CustodySeconds, EpochMs): EpochMs`.

The self-audit also caught and fixed three things beyond the advisories:
- AS-022's 401 now carries its audience on the typed refusal.
- `recordDecision` and the manifest deps are each named as one Task with their callers.
- The INV-3 and INV-4 statements are kept to one paragraph, so the plan parser reads them whole.

**Decided by:** the architecture agent, under the user's explicit delegation (orchestrator acceptance of every advisory).

### 2026-11-25: Loop-back 6 (plan design review 2)

The second plan design review returned 12 advisories (11 numbered; the twelfth, an AD-5 versus Component Design disagreement, is closed by item 3). All were accepted, decided under user delegation ("most correct, best, most functional").

1. **Phase 2 typecheck break.** Making `entra` required broke `approverTeamIdentity` and `toExecIdentity`, built in later phases. **Resolution:** the Teams approver is its own `TeamsApprover` type and is never given a fabricated realm principal; `canAccessDag` accepts `AuthIdentity | TeamsApprover`. One Phase 2 Task makes the realm principal required everywhere, with `hitl/identity.ts`, `hitl/types.ts`, the run-store schema and every fixture. Every Phase was re-audited against the code; seven further breaks were fixed (the exhaustive `rawDetailsFor` in `error-handler.ts`, the `unwired-token-endpoint.ts` `exchangeV2` stub, the `decideGate` caller, realm-claim fixtures, `RunExecutionRequest` and ten cut-over fixtures, the Phase 5 record fixtures and `manifest.test.ts`, the token-cache key test).
2. **Custody outcome table buried in an I/O adapter.** **Resolution:** the pure `decideRedeemStep` sits beside `transitionCustody` in `domain/delegated-custody.ts`, property-tested row by row with no fakes; `adapters/run-custody-cell.ts` only performs the effects it returns.
3. **Two token sources in pass 2.** **Resolution:** `signature-verified` carries claims only; pass 2 builds the grant from `step.token`.
4. **A port with one adapter.** **Resolution:** the `VerifyEntraUserToken` port is removed; `verifyEntraUserToken(step, jwks, signal)` is a plain function whose seam is the JWKS transport, and it takes only a pass-1 `verify-delegated` step.
5. **LC-1 partly ceremonial.** **Resolution:** three states (`absent`, `held`, `revoked`) and three events (`establish`, `rotate`, `refuse`), each a persisted production transition. Expiry is a pure comparison against the binding; release is the lifecycle owner's DEL.
6. **`forRun` lacked a run id.** **Resolution:** `delegation.runId` lives on the `user-delegated` authority; `custodyBindingOf(authority)` derives the key and the AAD from it; the run store refuses a record whose authority names another run. The lifecycle is the only `forRun` caller, once per bracket (`withRecordedAuthority` for each HITL slice), so one custody cell per run is structural.
7. **Comment-only swap fence.** **Resolution:** `CustodySuccessor` carries no generation; the store assigns 0 on `put` and `expected + 1` on `swap`.
8. **One wide fault union.** **Resolution:** `AcquisitionFaultOf<H, R>` with per-path subsets: app/realm mint without `reauthorization-required`, establishment without `custody-expired`/`custody-absent`, redeem with the full set. Projections are total over their subsets.
9. **Free-text `unreachable.message`.** **Resolution:** the closed `UnreachableCause`, rendered at formatting time; INV-3's guarantee for faults is now in the type.
10. **`authorityOf` returned `undefined`.** **Resolution:** `classifyCapabilities` parses requirements into catalog-minted `CapabilityScope`s at the boundary; an undeclared capability in a brokered namespace is the typed `capability-unknown` refusal (503), first in precedence, never defaulted to `app` and never reaching the mint gate. `authorityOf(scope)` is total. Anchored to FR-005 and NFR-010.
11. **Expectation held both tenant and issuer.** **Resolution:** `DelegatedTokenExpectation` is `{tenant, audience}`; `issuerFor(tenant)` derives the issuer in the claim validator and the verifier.

Consequence recorded with item 1: in the Phase 4 cut-over `RunRecord.authority` replaces `RunRecord.identity` and `RunExecutionRequest.authority` replaces its identity; `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are deleted.

**Decided by:** the architecture agent, under user delegation (orchestrator acceptance of every advisory).

### 2026-11-25: Loop-back 7 (condensation)

Lossless restructure to fit the plan-design review read budget; no design change. The Self-Interview moved to `architecture-interview.md`; the Change Log, the three plan self-audits, the full Approaches B and C and the pre-condensation AD wording moved to `plan-history.md`.

**Decided by:** the architecture agent, under user delegation.

### 2026-11-25: Loop-back 8 (plan design review 3)

The third plan design review returned 10 advisories. All were accepted, decided under user delegation ("most correct, best, most functional").

1. **The establish guards had no production caller.** **Resolution:** `establishDelegation` reads the clock once after the on-behalf-of exchange, builds the authority and binding, seals, and runs `transitionCustody(absent, establish)` before `put`. `establishFaultOf` maps `past-expiry` (the run's deadline or custody window closed during the exchange) to the retriable `unreachable{hop: entra, cause: timeout}` (`delegation-not-established{unreachable}`, 503), never a Redis PX error. `cap-exceeded` and `undeclared`, unreachable by construction, become the new `custody-defect` establishment fault (`delegation-not-established{defect}`, 500, logged at error). `delegation-establishment.test.ts` and `delegated-custody.property.test.ts` carry the cases. LC-1's "every transition is one production performs" is true again. Decided under user delegation.
2. **`AuthorizedRun` admitted illegal states.** **Resolution:** a union of `unbrokered` (no handle) and `brokered` (with the bracket's `RunMintingAuthority`), built only by the lifecycle. `mintingAuthorityOf` is the one exhaustive fold to the framework option, so no consumer checks `minting === undefined`. Decided under user delegation.
3. **Independent Entra and delegation legs.** **Resolution:** `EntraLeg.wired` nests `delegation: DelegationLeg`, and the dark Entra variant has none. `establishDelegation` takes a `DelegatingEntraLeg`, the planner's brokering state is `brokered{entra: EntraLeg}`, and `delegationOf` is the one parse both read, so `delegation-unconfigured` follows from the type. INV-5 is unchanged. Decided under user delegation.
4. **`decideRedeemStep` admitted pairs outside the table.** **Resolution:** `RedeemOutcomeOf` is indexed by `RedeemProgress`. `beginRedeem` gives the first step, and `decideRedeemStep(awaiting: RedeemAwaiting)` accepts only each progress's own outcomes, so the compiler checks totality. Decided under user delegation.
5. **`startRun` took identity and plan separately.** **Resolution:** `admitRunAuthority` returns the branded `AdmittedRun{runId, dagId, ownerTeam, plan}`. `startRun(admitted, input)` and the lifecycle brackets take it whole, and `HitlRunServiceDeps.newRunId` is removed. Decided under user delegation.
6. **`delegation.runId` duplicated the record's id.** **Resolution:** the authority holds no run id. `custodyBindingOf(runId, authority)`, `forRun(runId, run)` and `withRecordedAuthority(runId, authority, body)` take it from the bracket (the admitted run, or the HITL record's own id). The run-store cross-check is removed, and the lifecycle is still the only `forRun` caller. Decided under user delegation.
7. **The planner's rule was repeated in the mint path.** **Resolution:** pass 1 resolves each run's `access` (`AppAccess` for `agent` and `user-app`, `DelegatingAccess` for `user-delegated`), persisted with the authority. `forRun` closes over it and the mint path dispatches by it alone: no catalog, no mode read, no "unreachable, defense in depth" branch. The mint path's `gateAdmitted` classifies nothing, and the catalog `decideGate` with its `unknown` arm goes with the legacy broker in the Phase 4 cut-over. INV-2's siblings are now admission, the mint path and the manifest. Decided with it: a suspended run keeps the access it was admitted under, so a catalog mode change applies to runs admitted after it; the realm still authorizes every capability at every mint. Decided under user delegation.
8. **host.ts stayed a god shell.** **Resolution:** `createRunContextFactory`, `createDagExecutor`, `composeHitlRunService`, `HitlWiringArgs` and their helpers (`createHitlExecutor`, `syncRunOptions`) move to `adapters/run-composition.ts`. The CT-3 and CT-4 seams and CT-4's entry point point there, and acceptance imports it without `createHost`. Decided under user delegation.
9. **Release-cause derivation was buried in the adapter.** **Resolution:** the pure `releaseCauseOf(RunBracketEnding)` in `domain/custody-release.ts`, property-tested. The lifecycle stays the INV-4 owner, and the matrix test keeps only what needs the store. Decided under user delegation.
10. **Every reviewer's point behind advisories 1 and 2.** **Resolution:** covered: the code reviewer's PX ≤ 0 case and test obligations (1); the type-design reviewer's lifecycle-built union and the architecture reviewer's consumer re-checks (2). Decided under user delegation.

The self-audit also fixed four phase-boundary breaks: `fan-cap-wiring.test.ts` imports the moved `syncRunOptions`; `createHitlExecutor` moves with `composeHitlRunService`; `gateAdmitted` is a new Phase 3 export, because the legacy broker calls `decideGate` until the cut-over; and `admittedCapabilityOf` puts the catalog module in the Phase 2 Files list.

**Decided by:** the architecture agent, under user delegation (orchestrator acceptance of every advisory).

### 2026-11-25: Loop-back 9 (plan design review 4)

The fourth plan design review returned 12 advisories. The orchestrator accepted 1 to 10 and asked for 11 and 12 to be decided on their merits. All were decided under user delegation ("most correct, best, most functional").

1. **The mint path passed an unadmitted brokered requirement through (a real fail-open gap).** On HITL resume the DAG and catalog are re-read but `access` is the value admitted at start, and the resume fingerprint excludes `requires`, so a node that gained an `msgraph:` or `dynamics:` requirement reached a provider unadmitted. **Resolution:** a name in a brokered namespace that the run's `access` lacks fails `authority-unavailable{capability-not-admitted}` (a new framework cause, 403, non-retriable) through `frameworkErrorOf`. Only names outside every brokered namespace pass through. The predicate is the catalog's `brokeredNamespacesOf` over the boot catalog, the classifier's own rule. A persisted copy of admission's namespace set was rejected, because it is a second source and a namespace gained after admission would still pass through. CT-3 asserts the resume-with-changed-DAG case, anchored FR-005, with NFR-010 cited. Decided under user delegation.
2. **AD-5 overstated the ordering.** **Resolution:** the guarantee is scoped to admission refusals (`AdmissionRefusal`). Establishment (`EstablishmentRefusal`, `delegation-not-established`) runs after `acquire` on the sync path and after the fork on the HITL path. It keeps the slot on purpose, to bound concurrent Entra calls, and its latency, inside NFR-002, is spent holding it. The Run Admission responsibility agrees. Decided under user delegation.
3. **The routing rule lived in an adapter.** **Resolution:** the pure `routeRequirement(access, brokered, name)` → `pass-through | app | delegated | refused-not-admitted` in `domain/run-authority.ts`, the module that builds `access`. It is overloaded so that app access never routes `delegated`, and it is property-tested without fakes. The capability authority only executes the route. Decided under user delegation.
4. **`mintingAuthorityOf` coupled CT-1 to CT-3.** **Resolution:** it moves beside `AuthorizedRun`'s constructor in `adapters/run-authority-lifecycle.ts`. `run-composition.ts` was rejected, because it would close an import cycle through `run-executor.ts`. Decided under user delegation.
5. **Loose (run id, authority) pairs.** **Resolution:** the branded `BoundAuthority{runId, authority}`, built only by `bindAdmission` and `establishDelegation` (both from the `AdmittedRun`) and the run-record parse. `forRun`, `withRecordedAuthority`, `createRunCustodyCell`, `custodyBindingOf` and `establishForRecord`'s `persist` take it, and `RunRecord.authority` is one. Decided under user delegation.
6. **`AuthorizedRun`'s pairing was conventional.** **Resolution:** `AuthorizedRun` is branded, built only by the lifecycle's module-private constructor, whose handle is `forRun(bound)` over that same bound authority. Decided under user delegation.
7. **`AppAccess` was open.** **Resolution:** `RunAccess` is a branded, name-keyed union of `app` (entries admit only the `app` mode, the closed form of `delegated?: never`) and `delegating` (at least one delegated entry). It is built only by `accessOf` (pass 1) and `parseRunAccess` (the run-store boundary, which refuses a name listed twice). A name therefore cannot sit under both modes, and no last write wins. Decided under user delegation.
8. **Admission functions returned the whole refusal union.** **Resolution:** each returns its subset: `PlanRefusal` (pass 1), `ClaimRefusal`, `BindingRefusal`, `PresentationRefusal` (pass 2), `AdmissionRefusal` (`admitRunAuthority`) and `EstablishmentRefusal` (`runAuthorityRefusalOf` and the lifecycle brackets). Pass 2 thus holds nothing ranked above `delegated-token-invalid`, as a type fact. Decided under user delegation.
9. **The `declare const` sketch emitted no runtime key.** **Resolution:** a real module-private `const scopeDefinition: unique symbol = Symbol(…)` (not a class), whose declaration emit is the codebase's existing brand form. The minting `scopeOf` is module-private and in no barrel. Decided under user delegation.
10. **The Phase 4 cut-over was one very large Wave.** **Resolution:** the move of `createRunContextFactory`, `createDagExecutor`, `composeHitlRunService`, `createHitlExecutor`, `syncRunOptions` and `HitlWiringArgs` into `run-composition.ts` is a signature-preserving Phase 3 Task. The legacy deletion is its own Task after the cut-over, once no production module imports the legacy path. A sync/HITL strangler split was rejected, because it needs two brokers composed at once and a second `NodeContextForDag` shape, a shim. Decided under user delegation.
11. **Split CT-3's types file (decide).** **Resolution:** accepted in part. `ApproverRef` and `ApprovalRecord` move to `hitl/types.ts`, since approvals lend no authority and no CT-3 binding or clause names them. The lifecycle and bracket types stay in CT-3, because its `createRunAuthorityLifecycle` and `releaseCauseOf` bindings and its FR-023 and AS-027 anchors decide them. Decided under user delegation.
12. **`RealmAssertionMint` port with one real adapter (decide).** **Resolution:** kept. The unwired null object is its second production implementation, selected by leg state in the dark-leg composition, and AD-11 records this. A leg-state branch would repeat in both mint callers. Decided under user delegation.

The self-audit also fixed five phase-boundary breaks: `mapped-host-composition.test.ts` also imports `syncRunOptions`, so it joins the extraction Task; `capability-scope.test.ts` was missing from the deletion list; host.ts's local `RunAuthority` record is renamed `LegacyRunBroker` so it does not collide with the CT-1 type; `mintingAuthorityOf`'s placement avoids an import cycle; and `agentClientIdFromFrameworkOrigin` goes with the legacy deletion. One new semantic is flagged for the user's review: a requirement that passed through at admission is refused on resume if the boot catalog has since begun brokering its namespace.

**Decided by:** the architecture agent, under user delegation (orchestrator decisions on all 12 advisories).

### 2026-11-25: Loop-back 10 (plan design review 5)

The fifth plan design review returned 7 advisories in 6 items; the code reviewer had none. The orchestrator accepted items 1 to 5 and declined item 6 in part. All were decided under user delegation.

1. **The persisted authority shape was inconsistent (AD-9 against File Structure and HITL Authority Continuity).** **Resolution:** the record stores the bare `RunAuthority`, which holds no run id, under its own `runId`, the only stored run id. Every read returns `RunRecord.authority` as the `BoundAuthority` that `parseBoundAuthority(raw.authority, raw.runId)` builds. `RunExecutionRequest.authority` carries that read's `BoundAuthority` and is never persisted, so there is no second stored copy of the run id. Decided under user delegation.
2. **The kind-to-access invariant lived in a storage adapter.** **Resolution:** a pure `parseBoundAuthority` in `domain/run-authority.ts`, beside `parseRunAccess`, owns the rules: `agent` and `user-app` need `app` access, `user-delegated` needs `delegating` access, and a duplicate name is corrupt. It is the record path's `BoundAuthority` builder. The run store only decodes JSON and calls it, and a property test covers the round trip and the corrupt pairs without a Redis fake. Decided under user delegation.
3. **Approver Entra object ids were raw strings.** **Resolution:** `TeamsApprover.aadObjectId` and `ApproverRef.teams-user{aadObjectId}` are `EntraObjectId`. The bot handler parses `from.aadObjectId` with `parseEntraObjectId` at the boundary (Phase 2), a malformed id fails closed as an unknown approver, and persisted approvals are parsed, not cast (Phase 5). Decided under user delegation.
4. **A delegating `RunAccess` could hold no delegated entry.** **Resolution:** the variant is `{delegated: NonEmptyReadonlyMap; app: ReadonlyMap}`, with disjoint keys kept by its two builders; `routeRequirement`'s overloads are unchanged. Decided under user delegation.
5. **`RequirementRef` duplicated `RawCapabilityRequirement`.** **Resolution:** `RequirementRef` is now an alias of it. Decided under user delegation.
6. **The `...Fn` alias surface was wide (decline in part).** **Resolution:** kept. All 21 aliases are named by an `**Export bindings:**` entry, which requires a named function type for skeleton generation, so none can be dropped. Decided under user delegation.

The self-audit fixed one phase-boundary break: `approverTeamIdentity` now takes an `EntraObjectId`, so `messages-handler.ts` changes in the Phase 2 required-principal Task, not "compiles unchanged".

**Decided by:** the architecture agent, under user delegation (orchestrator decisions on all 7 advisories).

### 2026-11-25: Decompose approval and verification manifest

1. **Task graph approval (Phase 4c).** **Resolution:** the decompose output was approved: 62 Tasks in 16 Waves; ADR Tasks T3–T5 and T52–T62 are in Wave 16. `validate-task-graph` passes: 1 lifecycle and 5 invariants bind. The orchestrator made two corrections before approval. First, the acceptance support files (`identity-fakes.ts`, `latency-budget.ts`, `credential-sentinel.ts`) move from T37 (Wave 11) to the first contract Task, T7 (Wave 2). The contract gate needs each acceptance file to be collected and to fail behaviourally, and a file whose import does not resolve is not a valid RED. Second, implementation notes IN-1 to IN-11 are folded into the `plan_context` of the Tasks that build the code they apply to: A notes are marked REQUIRED and D notes OPTIONAL. Decided under user delegation.
2. **Verification manifest (Phase 4d), a deviation from the plan's Verification step 5.** **Resolution:** schema 2 is installed with `--replace`. It keeps the six existing operator checks and adds an `affectedRunner` and an `acceptanceRunner` (bun JUnit, 240 s). It also adds these JUnit checks: `project:framework-test`, `project:host-test` (all of `packages/host/src` except `signals.test.ts`, the acceptance directory included), `project:host-signals-test` and `project:scripts-test`. Three more checks need no report: `project:framework-typecheck`, `project:host-typecheck` and `project:doc-links`. The plan asked for two checks that were changed:
   - The plan kept `bun run --cwd packages/host test` as a check. It is not used. The gate excuses a red acceptance testcase only from a JUnit report whose runner is the check's last step, and that script chains two `bun test` calls and writes no report. It would have blocked every Wave from the contract Wave until the claimant Wave.
   - The plan asked for a separate `project:identity-acceptance` check. It is folded into `project:host-test`, because bun exits 1 on an empty path set and the acceptance directory does not exist before Wave 2.
   Decided under user delegation.
3. **The GitHub issue body is a summary.** **Resolution:** the plan is about 225K characters, over GitHub's 65,536-character limit for an issue body. The issue therefore holds the AD list, the full Task table and the paths of the spec, plan and notes on `feat/agent-identity-redesign`. Decided under user delegation.

**Decided by:** the orchestrator, under user delegation.

### 2026-11-25: Loop-back 11 (user design review)

The user reviewed the design and decided D1 to D8. These are the user's own decisions, not delegated ones; the spec was amended first (FR-026 to FR-028, AS-040 to AS-043). The interview and the approach gate were not re-run: Approach A stands.

1. **D1, write-once custody.** **Resolution:** no rotation. LC-1 is absent / held / revoked{refused} with events establish, refuse and reestablish; reestablish keeps the binding expiry. The store offers `put` (SET NX), an expiry-keeping `replace`, `get`, a byte-guarded `revoke`, and a `delete` held only by the lifecycle owner. The redeem protocol is a pure outcome table (`decideRedeemStep`); the run-level single-flight failed the deletion test and is removed. Decided by the user.
2. **D2, Redis custody everywhere.** **Resolution:** `REDIS_URL` stays required; the in-memory custody store is a test fake only (`__tests__/fixtures/`). Decided by the user.
3. **D3, revocation semantics.** **Resolution:** a password change or reset does not revoke the delegated credential. The cut-offs are disabling the user, `revokeSignInSessions`, or ending the run. Docs and the doc-lint banned-phrase table carry it. Decided by the user.
4. **D4, admission hardening.** **Resolution:** `azp` must be in `DELEGATED_CLIENT_APPS` (no default) and `scp` must contain `DELEGATED_SCOPE`; new reasons `client` and `scope`, never carrying claim values; existing precedence kept. Runbook: pre-authorize only the allowlisted clients and turn off user consent for the scope. Decided by the user.
5. **D5, catalog drift.** **Resolution:** a drift check at the start of every resume slice fails the run `authority-unavailable{authority-changed}` before any node runs (AD-12, FR-026, AS-042). Decided by the user.
6. **D6, re-authorization.** **Resolution:** the run suspends `awaiting-reauthorization`, the initiator is notified, and `POST /runs/:runId/delegation` runs the run-start checks, requires the recorded initiator's oid and tid, does a fresh on-behalf-of exchange, re-establishes custody under the original expiry through the lifecycle owner and re-enqueues; refusals are audited; nothing is extended; a TTL eviction releases custody through `endRun` (AD-13, FR-027, AS-034, AS-041). Mechanism, chosen by the architect in AD-13: a vendor-neutral framework park seam (`DagRunOpts.parkOn`, phase `parked`), because only the run's checkpoint knows the wave, the completed siblings and the node to re-run, and a node failure is terminal in the framework today. Decided by the user (mechanism: the architect).
7. **D7, decision record.** **Resolution:** one `SET NX` writes `{action, approver, channel, decidedAtMs, teamsActivityId?}`; `actor` is display only; every attempt is audited (accepted, duplicate, not-pending, unauthorized); `executesAs` is shown on the card, the payload and the accepted audit record; `RunRecord.approvals` is appended in the lease-fenced write and the audit is a projection (AD-9, new CT-5, FR-028, AS-043). Decided by the user.
8. **D8, tenant spike.** **Resolution:** spike items (a) to (d), each with pass/fail criteria and fail-closed behaviour, are in the runbook and Phase 6; the classifier rows implement the fail-closed side. Decided by the user.

**Decisions the architect made within D1 to D8, flagged for the user's review:** `DELEGATED_SCOPE` has no default and is matched as one whole space-separated token; the D4 facts are not an invariant (parsed config, one reading site); refusal order puts `client` after `audience` and `scope` after `not-delegated`; a refused refresh moves custody to `revoked` rather than deleting it; whole-second TTLs, with a TTL under one second treated as past-expiry; `revoke` is a compare-and-set on the bytes read; `RunAccess.passThrough` records the run's not-brokered names; `authority-changed` is HTTP 409 with `scope` = the first change's capability; AADSTS 65001 and 82014 on on-behalf-of map to `unconfigured`; sync runs fail 401 instead of parking; `RunStatus` gains `reauthorized` with a `markReauthorized` compare-and-set; `reauthorization-window-closed` is 410 and a run not awaiting is 409; the notification goes to the owner team's channel (no per-initiator channel exists) with `GET /runs/:runId` as the authoritative read model; a run parked `custody-expired` with `DELEGATED_CUSTODY_MAX_SEC` < `HITL_RUN_TTL_SEC` waits for its record TTL (a spec amendment to fail it at once is recommended); CT-5 is a new contract and approvals live in the checkpoint envelope; ADR 0096 is written in Phase 1; the manifest publishes the scope but not the client allowlist; INV-5 gains a re-authorization row; HTTP `duplicate` means the same approver and action; the cross-repo realm work moved to `cross-repo-realm.md`; AD-11's convention conflict stands. The plan was condensed losslessly to 229,792 UTF-16 units (cap 230,000); the approved decompose predates these decisions and must be re-run.

**Decided by:** the user (D1 to D8, design review 2026-11-25); the flagged items by the architecture agent within those decisions.
