# Plan: Agent Identity Redesign (per-agent Entra identity, per-capability authority mode)

**Spec:** .claude/specs/2026-11-24-agent-identity-redesign/spec.md
**Created:** 2026-11-24
**Spec ids:** the architecture phase renumbered three non-canonical ids so the spec parses: AS-013a is AS-033, AS-026a is AS-034, FR-019a is FR-025.
**Companions** (in `.claude/specs/2026-11-24-agent-identity-redesign/`): `architecture-interview.md` (questionnaire answers) and `plan-history.md` (loop-back history, self-audits).

## Summary

Only an agent's own identity federates into Entra. Every realm assertion is requested with `entra-exchange <capability>` and handed to a model-polymorphic `EntraAgentAuthority` port (adapters for Entra Agent ID, blueprint plus agent identity, and for per-agent app registrations). Each capability declares `app` or `delegated` in one typed catalog with no default. A pure run-start planner turns the caller's identity, the DAG's requirements and the catalog into a `RunAuthority` before the HITL fork or a concurrency slot. A boot-scoped `CapabilityAuthority` hands each run a broker and its invocation origin, both derived from that one `RunAuthority` by `forRun`, replacing the process-global subject-token registry and the RFC 8693 user exchange, which are deleted. Delegated mode does one on-behalf-of exchange at admission, then keeps only the run-bound refresh credential, AES-256-GCM sealed under a three-state custody lifecycle (LC-1) and touched only by the run's single custody cell, a thin sequencer over one pure decision function. One run-authority lifecycle owns establishment, the per-bracket minting handle (the only `forRun` caller) and release at every terminal state. Every acquisition path returns only the faults it can produce. The Keycloak config-as-code realm changes run outside the task graph.

Executable models: one lifecycle (LC-1), five invariants (INV-1 checkable; INV-2, INV-4 and INV-5 owned; INV-3 advisory and unowned) and four contracts (CT-1 to CT-4). No Pipeline: this is not a fugue DAG feature.

> **Decided under explicit user delegation.** The user said: "im gonna go to bed, you just run the whole loom workflow please, and during interview, just pick the most correct, best, most functional approach, for all questions ok". Earlier the user also said "I want the most correct solution to the agent auth problem" and "we can change config code as well of course, to make it fit". No interview was held. The answers are the architect's (`architecture-interview.md`), and each is logged in `clarifications/log.md` under "Architecture phase decisions" for the user to review.

---

## Approach Gate

**Decided under explicit user delegation:** Approach A (recommended, and picked).

### Approach A: Run-bound authority (picked)

- **Shape:** a boot-scoped `CapabilityAuthority` core (caches, ports, catalog) whose `forRun(runAuthority)` returns a framework `CapabilityBroker` closed over the run's authority; a pure run-start planner produces `RunAuthority`; `EntraAgentAuthority` has two adapters; delegation is established eagerly, then held in encrypted custody; the framework error taxonomy gains one kind.
- **Pros:** no process-global mutable registry; a run's authority is a value, persisted with the HITL record and rebuilt on resume; delegated caches die with the run; every refusal is a typed ADT decided before concurrency or the HITL fork; the framework stays vendor-neutral (ADR-0054).
- **Cons:** the run-start path (`run-dag.ts`, `host.ts`, `node-context-factory.ts`, `hitl/service.ts`, `run-executor.ts`) changes signature, a broad surface; the eager on-behalf-of exchange adds Entra latency to submitting delegated runs (budgeted in NFR-002: 2500 ms live).
- **Risk:** low. Every seam is injectable and testable with fakes.

### Approach B: Boot-scoped broker plus a process-global `RunAuthorityRegistry`

One broker per process; each run's authority (and, for delegated runs, the user token) in a runId-keyed map resolved at mint time, with lazy on-behalf-of. **Rejected:** shared mutable state with bind and release discipline, the raw user token outlives admission, and eager plus lazy delegation are two paths to prove.

### Approach C: Framework-native authority mode

`requires` entries and `InvocationOrigin` carry the mode and framework preflight validates delegation. **Rejected:** it puts Entra concepts into the framework (ADR-0054), its preflight runs after slot acquisition (AS-010 and SC-003 require refusal before), and it still needs host-only facts.

---

## Architectural Decisions

### AD-1: Run-bound authority replaces the process-global subject-token side channel

**Choice:** A boot-scoped `CapabilityAuthority` with `forRun(bound: BoundAuthority<BrokeredRunAuthority>): RunMintingAuthority`, where `RunMintingAuthority = Pick<MintingAuthority, "broker" | "origin">`. Each run's broker is a closure over an immutable `RunAuthority` value that admission produced (sync path) or that was rebuilt from the persisted run record (HITL path). The run-authority lifecycle (AD-6) is the only caller of `forRun`. It builds exactly one handle per execution bracket (a sync run, or one HITL slice) and hands it to the bracket's body, so one custody cell per run is structural, not caller discipline. The authority persists no run id. The bracket's run id travels beside it in the branded `BoundAuthority{runId, authority}` (its builders: Component Design › Run Authority Planner), so no seam takes a loose pair, and the cell's custody key and AAD come from `custodyBindingOf(bound)`. The broker routes each requirement with the pure `routeRequirement` over the run's `access`, which pass 1 resolved (AD-2), so the mint path never asks whether a run is delegated. The origin beside it is `originOf(run)`, the one function that derives an `InvocationOrigin`. Nothing stores an origin next to an authority, so the two cannot disagree. The broker takes identity only from its closure and never reads `inv.origin`, so the per-invocation `agentClientIdFromFrameworkOrigin` re-check is removed. `SubjectTokenRegistry`, the rest of the subject-token side channel and the RFC 8693 exchange are deleted outright, with no shims (CONTEXT.md Key Invariant 8; the symbol list is Phase 1's demolition Task).
**Why:**
- A run's authority is a fact, not a resource to bind and release. As a value it cannot leak across runs.
- It persists with the HITL record (FR-016, FR-020) and needs no teardown discipline.
- FR-003 and FR-004 hold by construction, because no code path can reach a user token on an `app` run.
**Rejected:**
- A process-global `RunAuthorityRegistry` (Approach B): mutable shared state and release discipline.
- Keeping `exchangeV2` "for later": FR-003 forbids user exchange for every origin and mode.

### AD-2: Authority mode is part of the capability definition, in one catalog with no default

**Choice:** `domain/capability-catalog.ts` holds `CAPABILITY_CATALOG` (`as const satisfies Record<string, CapabilityDefinitionInput>`, where `authority: "app" | "delegated"` and `resource: "graph" | "dynamics"` are both required); interface in Component Design › Capability Catalog.
- `parseCapabilityCatalog` is the only constructor of the branded `CapabilityCatalog`. `authorityOf(scope)` is the only reader of a mode (INV-2) and is total, because only the catalog module mints a `CapabilityScope`, from a key of a parsed catalog.
- Admission pass 1 parses node requirement strings with `classifyCapabilities` into `brokered{scope}`, `not-brokered` (e.g. `http`, or an ADR-0051 custom `mycorp:widget` served by another provider) or `unknown` (a brokered namespace — `msgraph:`, `dynamics:` or one a data catalog introduces — whose key the catalog lacks). Any `unknown` is the `capability-unknown` refusal (503), first in the precedence, so an undeclared capability never defaults to `app` or reaches the mint gate (FR-005: a capability without a mode is unrepresentable; NFR-010: no gap degrades into broader authority). Pass 1 also resolves each brokered requirement's mode into the run's name-keyed `access`, and the mint path routes by it through `routeRequirement`, reading no mode; its one catalog fact is `brokeredNamespacesOf(catalog)`, the classifier's own namespace rule, so a brokered-namespace name `access` lacks fails closed (Component Design › Capability Authority; NFR-010).
- `capability-scope.ts` folds into the catalog and is deleted; `KNOWN_SCOPES` and the derived handle types are re-derived from catalog keys. All three existing capabilities declare `app`.
- The catalog is parsed once, at boot: `createHost` calls `loadCapabilityCatalog(HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG)` right after startup (`Err` → the `capability-catalog-invalid{faults}` HostError, before any capability connects); nothing parses a catalog at module load. The one parsed value goes to the legacy gate until the Phase 4 cut-over, to `composeRunAuthorityWiring` (input `catalog`, for admission) and to the manifest handler, so a data-sourced catalog reaches every INV-2 sibling, and the delegated test capabilities (OOS-004) enter through the same parser.
**Why:**
- FR-005 and SC-013: a mode can neither be omitted nor defaulted.
- A single reader makes the planner, the mint path (through the planner's `access`) and the manifest agree by construction, and the INV-2 matrix test proves it.
**Rejected:**
- A mode map beside `KNOWN_SCOPES`: two tables can drift.
- A mode on the DAG node's `requires`: it is a capability property, not a per-use choice, and it would leak into the framework.
- Defaulting to `app`: a silent default is how authority widens.
- An earlier `authorityOf(catalog, scope): AuthorityMode | undefined` over raw strings: every caller decided what `undefined` meant. Refusing unknown requirements at DAG load instead of pass 1: no place in the precedence order, and run-start refusals would leave the one total function. Persisting admission's namespace set in `access`: a second copy of a catalog fact, and a namespace the catalog gains after admission would still pass through.

### AD-3: One capability-facing contract, two Entra identity adapters, explicit model in configuration

**Choice:**
- The port is `EntraAgentAuthority { acquireApp, establishDelegation, redeemDelegation }`, in `domain/port/entra-agent-authority.ts`.
- `createAgentIdAuthority` makes two client_credentials calls:
  - Step 1 to the blueprint: `client_id=blueprint`, `scope=api://AzureADTokenExchange/.default`, `fmi_path=<agent identity>`, `client_assertion=<realm assertion>`. This yields T1.
  - Step 2 as the agent identity: `client_assertion=T1`, `scope=<resource>/.default`.
  - On-behalf-of and refresh run as the agent identity with `client_assertion=T1`.
- `createAppRegistrationAuthority` makes one client_credentials call as the agent's app. On-behalf-of and refresh run with `client_assertion=<realm assertion>`.
- `ENTRA_IDENTITY_MODEL` (`agent-id` | `app-registration`, no default) parses into the `EntraDirectory` ADT, whose variant decides the adapter. Capability and DAG definitions never see the model.
- `ENTRA_CLIENT_ID` and the single `fugue-agents` app (ADR-0055) are removed.
**Why:**
- FR-011, FR-019 and SC-008: switching model is a configuration change only.
- Per-agent Entra identities give per-agent attribution and permissions (AS-004, NFR-011).
- No static secret or certificate exists on any Entra path (FR-012).
**Rejected:**
- Defaulting to the Agent ID model: the tenant spike is unresolved (Open Question 2).
- Keeping the shared app as a third model: it cannot meet AS-004 or per-agent revocation.

### AD-4: Every realm mint requests `entra-exchange <capability>`, and the assertion is inspected before Entra egress

**Choice:**
- `RealmAssertionMint.mintFederationAssertion(agent, capability)` always posts client_credentials with `scope="entra-exchange <capability>"` and no `audience` parameter.
- `inspectFederatedAssertion` is pure. It decodes the minted JWT payload (the token came from our own token endpoint over TLS; this is a sanity check, not trust) and requires that `aud` contains `api://AzureADTokenExchange` and that `scope` contains both grants.
- A Keycloak `invalid_scope`, or a token missing either grant, maps to `authority-unavailable{cause: federation-grant-missing}` naming the grant(s), before any Entra egress (AS-003).
**Why:**
- FR-001 and SC-001 fix the current bug, where the assertion lacks the Entra audience.
- The capability grant stays in the assertion, so the realm remains the policy decision point (FR-013); the token caches keep the capability in their key for the same reason.
- Both Keycloak behaviours are made deterministic: rejecting an unassigned optional scope, and silently dropping it.
**Rejected:**
- Requesting `entra-exchange` alone and checking the capability locally: that would bypass the realm as the policy decision point.
- Trusting the token blindly: a dropped scope would surface later as an opaque Entra AADSTS error.

### AD-5: Two-pass run-start admission: a pure static pass, verification only on demand, a pure completion pass

**Choice:** Two pure functions in `domain/run-authority.ts` surround one I/O step (inputs, types and precedence: Component Design › Run Authority Planner). Pass 1 (`planRunAuthority`, over `runtimeNodeInventory`, newly exported from the framework barrel) runs `classifyCapabilities` first and decides every refusal that needs no signature or claim check, through `delegated-token-invalid{malformed}`; only it builds the `DelegatedTokenExpectation` (audience from `delegatedAudienceFor`, INV-5; the issuer is derived by `issuerFor(tenant)`, never carried). Only for its `verify-delegated` step does the shell (`run-authority-admission.ts`) call `verifyEntraUserToken`, which takes that step and returns claims only. Pass 2 (`admitDelegatedPresentation`) runs `validateEntraUserTokenClaims`, then `bindDelegatedPrincipal` (the last two places in the order), and builds the `VerifiedDelegationGrant` from `step.token`, so the token has one source. `run-dag.ts` calls `admitRunAuthority`, which composes the three into one branded `AdmittedRun` (run id, DAG, owner team, plan), after input-schema parsing and before `hitl.startRun` and concurrency `acquire`; a refusal maps to the `run-authority-refused` HostError and its HTTP status.
**Why:**
- AS-010, AS-021 to AS-023, FR-006 to FR-009 and SC-003/SC-004: every **admission** refusal (`AdmissionRefusal`, the union of pass 1's `PlanRefusal` and pass 2's `PresentationRefusal`) happens before node execution, slot acquisition or token egress.
- Establishment is not admission; its one refusal, `delegation-not-established` (`EstablishmentRefusal`, the brackets' only `Err`), comes later. The sync `withEstablishedAuthority` runs after `acquire` and the circuit check, so the realm mint and on-behalf-of exchange hold a concurrency slot; the HITL one runs inside `startRun`, after the fork. This is deliberate: the slot bounds concurrent Entra establishment calls, and the establishment latency (within NFR-002's 2500 ms live budget) is spent holding it.
- A statically refusable submission makes no JWKS egress, so a higher-precedence static refusal (a team token on a delegated DAG, a dark delegation leg) can neither probe Entra's key endpoint nor be answered with a lower-precedence `delegated-token-invalid`.
- Both passes are total functions over closed unions, each typed with only the refusals it can produce, so pass 2 cannot return a refusal ranked above `delegated-token-invalid`; a property test over their pure composition preserves the full precedence order, and `run-authority-admission.test.ts` and CT-1 count zero JWKS-transport requests whenever pass 1 refuses or decides.
- It replaces the `throw` for unmapped DAGs in `node-context-factory.ts` with a typed refusal.
**Rejected:**
- Earlier designs: one planner over an already-verified presentation (egress before outranking static refusals, plus a `present-unverified` hedge); a `VerifyEntraUserToken` port with one adapter (fails the deletion test; tests fake the JWKS transport); the token inside `signature-verified` (two token sources).
- Validating inside `createNodeContextForDag` (after concurrency acquisition) or in framework preflight (Approach C).

### AD-6: Delegated authority is established eagerly at admission and continued through encrypted run-bound custody

**Choice:** Admission yields `user-delegated-pending{grant}`. One operation owns the bracket from establishment to release: the run-authority lifecycle (`createRunAuthorityLifecycle`, `adapters/run-authority-lifecycle.ts`, the INV-4 owner), built once by `composeRunAuthorityWiring`. Its brackets (sync `withEstablishedAuthority`; HITL `establishForRecord` and `endRun`; one `withRecordedAuthority` per HITL slice, serialized by the queue lease), the custody cell, the store, the redeem outcome table, release and key rotation: Component Design › Delegated Custody. The lifecycle alone holds `forRun` (`RunAuthorityWiring` does not expose the capability authority) and the store's `delete`; each sibling holds only its narrowed `Pick<RunAuthorityLifecycle, …>` (INV-4).
- **Establishment** (`establishDelegation`, CT-3; sequence in Component Design and Data Flow): one on-behalf-of exchange with `offline_access`, sealed with AES-256-GCM; custody key, AAD and expiry derive from the `BoundAuthority` it returns, the `AdmittedRun`'s run id beside the one `user-delegated` authority it builds (`fugue:<tenant>:authority:custody:<binding.runId>`, generation 0, PX at the expiry), and the LC-1 `establish` guard runs before `put` (fault mapping: Component Design › Delegated Custody). It has no compensation of its own: any `Err`, an ambiguous `put` included, returns to the lifecycle, which releases and returns `Err(RunAuthorityRefusal)`. The verified user token is a `RedactedSecret`, dropped as soon as establishment returns.
- **Expiry** is `custodyExpiryFor(now, max, runDeadline)`: `max` is the wired `DelegationLeg.maxSec` (`DELEGATED_CUSTODY_MAX_SEC`, or min(604800, `HITL_RUN_TTL_SEC`) when unset), and the run deadline is the sync route's timeout deadline or, for a HITL run, establishment + `HITL_RUN_TTL_SEC`; 604800 s (7 days) with default keys. Fixed at establishment, held only on the immutable `RunAuthority`, never extended, rotation included.
- **Redeem** runs in the run's single-writer custody cell over the pure `decideRedeemStep` (outcome table: Component Design), refreshing through the agent identity, with no `app` fallback.
**Why:**
- The user token is touched once and never persisted. Only an agent-bound, encrypted, revocable refresh credential is held (FR-017, FR-023, AS-026 to AS-027), and Entra enforces revocation at every refresh.
- The HITL approval channel cannot carry a fresh user token, so lazy delegation would break resume.
- One bracket owner means no caller pairs establishment with release or chooses a cause; a new run-ending path is a new `SyncRunEnding` or `HitlRunEnding` variant that the pure, exhaustive `releaseCauseOf` must handle. The same owner builds the bracket's handle, so one custody cell per run holds by construction.
- The redeem outcome table is a pure function, property-tested row by row with no fakes; the I/O cell decides nothing.
**Rejected:**
- Earlier designs: a free-standing `releaseCustody(runId, cause)` at eight sites (callers paired establishment with release and picked the cause); the custody cell and its outcome table inside `capability-authority.ts` (decisions in an I/O adapter, a god-module); `forRun(run)` without a run id, called by each executor (no key or AAD source; one cell per run as caller discipline).
- Routing release through the custody machine: release is a `DEL` of the whole record whatever its state, so a `teardown` event would be a transition no persisted state shows (LC-1 is the persisted lifecycle only).
- Lazy on-behalf-of at first use: the raw user token would be held until then, and a HITL gate before first use would make the run unresumable.
- The approver re-presenting a token (Option B in the clarify log): rejected in clarify.
- Storing the access token only: it expires in about an hour, shorter than the 7-day suspension window.

### AD-7: Inbound delegated-token contract and identity binding

**Choice:**
- The header is `X-Fugue-Delegated-Authorization: Bearer <compact JWT>` (the repository's `X-Fugue-*` convention), next to the realm `Authorization` header. It is refused (400) on runs that need no delegation, and the manifest publishes per DAG whether it is required and which audience it must carry.
- `domain/entra-user-token.ts` is pure. `validateEntraUserTokenClaims` checks:
  - `iss = issuerFor(tenant)`, which is `https://login.microsoftonline.com/{tenant}/v2.0`. `issuerFor` is the one derivation; the claim validator and the verifier both call it, and `DelegatedTokenExpectation` carries only the tenant.
  - `tid` equals the deployment tenant (OOS-005)
  - `aud` equals the expected audience: the blueprint client id (agent-id model) or that agent's app id (app-registration model)
  - `exp` and `nbf` within 60 s of skew
  - `oid` present
  - `scp` present (a delegated token, not app-only)
  - `ver = "2.0"`
- `verifyEntraUserToken` in `adapters/entra-user-token-verifier.ts`, a plain adapter function with no port, checks the signature: jose, RS256 only, through `lazyJwks` over `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, reached through the injected JWKS transport.
- `bindDelegatedPrincipal` requires that `oid` and `tid` equal the realm principal's.
- `AuthenticatedUser` gains a required `entra: EntraPrincipal`, parsed from the `entra_oid` and `entra_tid` claims by `validateRealmJwtClaims`. A realm user JWT without them is a 401 `unauthorized` that names the missing claims.
**Why:**
- FR-007 to FR-009 and FR-036. Parse, don't validate: an `AuthenticatedUser` without an Entra principal cannot exist.
- The realm guarantees every user comes through the Entra IdP (spec Risks), so requiring the claims fails closed instead of silently skipping attribution.
**Rejected:**
- An optional `entra` on `AuthenticatedUser`: an optional field gives unbound user runs a second state.
- Ignoring an unexpected header: that tolerates over-sending bearer tokens.
- Accepting v1 tokens: they carry a different issuer and claim shape, so v2 is pinned (the runbook sets `requestedAccessTokenVersion: 2`).

### AD-8: Extend the capability failure taxonomy with `authority-unavailable`

**Choice:**
- Add the framework kind `authority-unavailable{scope, agentClientId, cause}`. The cause (`AuthorityUnavailableCause`) is one of:
  - `{kind: "federation-grant-missing"; grants: readonly string[]}`
  - `{kind: "authority-unconfigured"; missing: readonly string[]}`
  - `{kind: "federation-rejected"; reason: "issuer" | "subject" | "audience" | "unknown"}`
  - `{kind: "reauthorization-required"; reason: "refused" | "custody-expired" | "custody-absent"}`
  - `{kind: "capability-not-admitted"}`: a requirement in a brokered namespace that the run's admitted `access` lacks
- It is non-retriable. These change with it, in the same Phase 1 Task (Phase boundary rule): `FRAMEWORK_ERROR_KINDS`, the persisted zod schema, `formatFrameworkError`, `retriabilityOf`, and the host's `classifyFrameworkError` HTTP mapping in `domain/framework-error-http.ts` (grant-missing 403, unconfigured 503, federation-rejected 502, reauthorization-required 401, capability-not-admitted 403).
- **One acquisition-fault vocabulary, typed per path.** Every acquisition-path adapter (realm mint, Entra authority, unwired adapters, custody cell, `establishDelegation`) returns `AcquisitionFaultOf<H, R>` (CT-2 types; definition and per-path subsets: Component Design › Entra Agent Authority), replacing `AssertionFault`, `EntraAcquisitionFault`, `DelegationEstablishmentFault` and the free-standing reason list of `delegation-not-established`. Each path has exactly its subset (establishment adds the closed `custody-defect`), so an unreachable state is unrepresentable. `unreachable` carries the closed `UnreachableCause`, so no free string can carry response text or a credential into an error value (INV-3 for faults holds in the type); text is rendered only by `frameworkErrorOf`, from the status number and fixed words.
- **Two total projections** in `domain/acquisition-fault.ts` are the only translations, each `.exhaustive()` over its own domain and applied in exactly one module, so neither is an owned invariant: `frameworkErrorOf` over `MintPathFault` (the acquisition faults plus the router's `not-admitted`; in `capability-authority.ts`) and `runAuthorityRefusalOf` → `delegation-not-established{reason}` (in `run-authority-lifecycle.ts`).
- **One classifier.** `classifyTokenEndpointError` in `domain/token-endpoint-error.ts` is the only reading of a realm or Entra token-endpoint error response: pure, one decision table, property-tested once, imported by both HTTP adapters. It is overloaded by grant: a `client_credentials` response classifies to `AppAcquisitionFault`, an `on-behalf-of` or `refresh` response to `DelegatedGrantFault`, so the app path cannot receive a re-authorization fault.
  - Realm `invalid_scope` gives `grant-missing`.
  - Realm `invalid_client` and other client-authentication 4xx give `unconfigured{why: rejected}`, a configuration fault that retrying cannot fix.
  - AADSTS 70021, 700211, 700212 and 700213 give `federation-rejected`.
  - `invalid_grant`, `interaction_required` and `consent_required` on on-behalf-of or refresh give `reauthorization-required{refused}`.
  - 429, 5xx and timeouts give `unreachable`.
  - The classifier copies only error codes, never response text, into the fault.
- Unwired legs now map to `authority-unconfigured`, no longer to the retriable `infra-unreachable`. Transient failures stay `infra-unreachable` and are not retried internally (NFR-021).
**Why:**
- FR-015 requires policy refusal, missing configuration, federation mismatch and transient failure to be distinct kinds.
- ADR-0059 already distinguishes retriability by kind, and none of these causes is fixed by retrying.
- The kind is vendor-neutral, which ADR-0054 requires.
**Rejected:**
- Reusing `downstream-denied`: it is the resource's own refusal, not a failure of authority acquisition.
- Leaving unwired legs as `infra-unreachable`: retrying amplifies a configuration error.

### AD-9: Approval is recorded separately and lends no authority

**Choice:**
- `HitlRunService.recordDecision(runId, nodeId, action, approver: ApproverRef)`.
- `ApproverRef` is one of `realm-user{realmSub, entra}`, `team{team}`, `admin` or `teams-user{aadObjectId}`. It and `ApprovalRecord` are declared in `hitl/types.ts` (Phase 5), not in a contract types file, because approvals lend no authority.
- `PersistedIdentity`'s `user` gains `entra` in Phase 2, in the same Task that makes the live identity's `entra` required. In the Phase 4 cut-over `RunRecord.authority: RunAuthority` replaces `RunRecord.identity`, and `RunExecutionRequest.authority` replaces `RunExecutionRequest.identity`, so the initiator has one persisted source; `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are then deleted. Phase 5 adds `approvals: readonly ApprovalRecord[]`.
- The Teams approver is not an `AuthIdentity`. `approverTeamIdentity(map, aadObjectId)` returns a `TeamsApprover = {kind: "teams-approver"; aadObjectId; canRunDag}` (declared in `domain/auth.ts`), and `canAccessDag` takes `AuthIdentity | TeamsApprover`. A card click carries no realm principal, so it is never given a fabricated `entra`, cannot start a run or be persisted as an initiator. Phase 5 maps it to `ApproverRef.teams-user{aadObjectId}`.
- Each decision emits a `hitl-decision` audit record with the initiator and the approver.
- `run-executor.ts` rebuilds the run's broker only from the record, through the lifecycle's `withRecordedAuthority(record.authority, …)`, a `BoundAuthority` that the run-record parse builds over the record's own id.
**Why:** FR-025 and AS-028. The type makes it impossible to derive authority from the approver.
**Rejected:**
- Overloading `HumanAction.actor` (a free-form string): it cannot carry the Entra principal and conflates display with identity.
- The Teams approver as a `user` `AuthIdentity` (needs a fabricated realm principal that could reach submission or the record), and keeping `RunRecord.identity` beside `RunRecord.authority` (two persisted initiators that could diverge).

### AD-10: Doc truth is checked, not promised

**Choice:**
- `scripts/check-identity-docs.ts`, with a pure `lintIdentityDoc(path, text): readonly Problem[]` and tests.
- Every doc listed in issue #42 must contain a status matrix with the columns Implemented, Configured, Deployed and Live-verified.
- `PENDING-LIVE-VERIFICATION` is allowed only next to a link to the runbook evidence template.
- A declared table of banned phrases, each with its reason (for example "as the user" outside a delegated-path line, and `exchangeV2`/`subject_token` claims), fails the script.
- The script is wired beside `check-doc-links.ts` in `scripts/verify.sh`.
**Why:** FR-042 and SC-009 come from a history of doc drift, and only an executable check keeps the docs honest.
**Rejected:** a review checklist, which drifts.

### AD-11: New ports live in `domain/port/` (flagged convention conflict)

**Choice:** New port interfaces go in `packages/host/src/domain/port/`: `realm-assertion-mint.ts`, `entra-agent-authority.ts`, `delegated-custody-store.ts`. Their adapters live in `adapters/`. Each port has at least two implementations (HTTP and unwired for the mint and the Entra authority, Redis and memory for the store). The Entra user-token verifier has one implementation, so it is not a port: `verifyEntraUserToken` is a plain adapter function and the JWKS transport is the seam. The `RealmAssertionMint` port exists for the unwired leg: its second production implementation is the unwired null object that `composeRunAuthorityWiring` selects by leg state, which is why it passes the deletion test; without it both mint callers (the app path, `establishDelegation`) would branch on the leg. The verifier needs no such variant: pass 1 reaches it only on a wired leg.
**Why:** The binding `architecture.md` rule places ports in the domain, and the existing lint boundary already lets `domain/` import from inside `domain/`.
**Rejected:** Defining ports inside adapter files, the local convention (for example `keycloak-token-endpoint.ts`): rules outrank local convention. This conflict is reported in the final summary. Existing ports are not moved, which is out of scope.

---

## File Structure

Each entry says what the file holds and, where it is not the file's group default, in which Phase. Behaviour is specified once, in Component Design; test-file entries are the canonical list of per-file test obligations.

### Framework: taxonomy and inventory export

```
packages/framework/src/types/errors.ts — authority-unavailable kind + AuthorityUnavailableCause union (AD-8), FRAMEWORK_ERROR_KINDS, persisted zod schema, formatFrameworkError, retriabilityOf (non-retriable)
packages/framework/src/index.ts — export runtimeNodeInventory (barrel)
packages/framework/src/__tests__/authority-unavailable-error.test.ts — kinds list; persisted round-trip through the zod schema; retriability; formatting; property test: every cause round-trips and formatted text never contains an injected sentinel or a credential field
```

### Host: contracts (declarations only, frozen)

```
packages/host/src/domain/run-authority-contract.ts — CT-1 types: EntraObjectId, EntraTenantId, EntraClientId brands, EpochMs and DurationMs brands (instants vs durations; every identity-subsystem clock is () => EpochMs), EntraPrincipal, Initiator, AuthorityMode, RawCapabilityRequirement, CapabilityRequirement (over the catalog-minted CapabilityScope), RequirementRef, DelegatedHeader, DelegatedTokenExpectation, AdmissionStep, VerifyDelegatedStep, DelegatedPresentation, VerifiedEntraClaims, VerifiedDelegationGrant, RedactedSecret, AdmittedCapability, AccessEntry, RunAccess, AppAccess, DelegatingAccess, RequirementRoute, RunAuthority, BrokeredRunAuthority, UserDelegatedAuthority, RunAuthorityPlan, PendingPlan, AdmittedRun, BoundAuthority, DelegatedTokenInvalidReason, RunAuthorityRefusal and its subsets (PlanRefusal, ClaimRefusal, BindingRefusal, PresentationRefusal, AdmissionRefusal, EstablishmentRefusal), PlanRunAuthorityFn (pass 1), AdmitDelegatedPresentationFn (pass 2), BindDelegatedPrincipalFn, ValidateEntraUserTokenClaimsFn, IssuerForFn, VerifyEntraUserTokenFn, OriginOfFn, RouteRequirementFn
packages/host/src/domain/capability-authority-contract.ts — CT-2 types: EntraIdentityRef, FederationGrant, FederatedAssertion, Hop, ReauthorizationReason, UnreachableCause, AcquisitionFaultOf<H, R> with AppAcquisitionFault, DelegatedGrantFault, EstablishmentFault and AcquisitionFault, MintPathFault, TokenEndpointErrorResponse (by grant), AcquiredCredential, RunMintingAuthority, CapabilityAuthority (forRun), CreateCapabilityAuthorityFn, InspectFederatedAssertionFn, ClassifyTokenEndpointErrorFn, FrameworkErrorOfFn, RunAuthorityRefusalOfFn
packages/host/src/domain/delegated-custody-contract.ts — CT-3 types: CustodySeconds brand, CustodyBinding, SealedRefreshCredential, CustodyGeneration brand, CustodyState, CustodySuccessor, SuccessorOf, CustodyEvent, CustodyTransitionFault, HeldCustody, CustodySwapOutcome, PendingCustodyWrite, RedeemContext, RedeemProgress, RedeemOutcomeOf, RedeemAwaiting, RedeemStep, AuthorizedRun, SyncRunEnding, HitlRunEnding, RunBracketEnding, CustodyReleaseCause, CustodyReleaseOutcome, EstablishForRecordFailure, RunAuthorityLifecycle, EstablishDelegationFn, TransitionCustodyFn, EstablishFaultOfFn, BeginRedeemFn, DecideRedeemStepFn, CustodyBindingOfFn, ReleaseCauseOfFn, CreateRunAuthorityLifecycleFn
packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts — CT-1 acceptance (real verifier over an in-process JWKS)
packages/host/src/__tests__/acceptance/run-authority-admission-budget.acceptance.test.ts — CT-1 acceptance: run-start validation p95 budget (AS-036; NFR-003, SC-011), same path as the CT-1 file
packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts — CT-2 acceptance, for each identity model
packages/host/src/__tests__/acceptance/capability-authority-budget.acceptance.test.ts — CT-2 acceptance: host-added acquisition and cache-hit p95 budgets (AS-035; NFR-002, SC-011), same path as the CT-2 file
packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts — CT-3 acceptance
packages/host/src/__tests__/acceptance/user-run-attribution.acceptance.test.ts — CT-4 acceptance (AS-006, FR-004, FR-020)
packages/host/src/__tests__/acceptance/support/identity-fakes.ts — shared fakes at the network, storage and clock edges only: zero-latency realm-token, Entra-token, Entra-JWKS and Graph HTTP transports (an IdentityTransports value) with request capture, a JWKS signer for realm and Entra user tokens, a fake realm signature verifier returning markSignatureVerified claims, bun:test setSystemTime clock control, an in-process UDS transport into the worker app, an in-memory RedisPort and HitlRedisPort and the SharedInfra over them, an in-process QueueBackend that delivers each enqueued job to the started worker, a recording HITL notifier, a fake Bot Framework VerifyBotToken, a capturing audit sink, logger and tracer. It deliberately offers NO fake realm mint, Entra authority, user-token verifier, custody cipher, custody store or capability authority: acceptance takes all of those from composeRunAuthorityWiring
packages/host/src/__tests__/acceptance/support/latency-budget.ts — shared budget harness: warm-up, sample loop, nearest-rank p95 (test support, not production)
packages/host/src/__tests__/acceptance/support/credential-sentinel.ts — FR-022 scan support for all four contracts' acceptance (Phase 3, with CT-2): CredentialSentinels (one distinctive value per credential kind: inbound realm user JWT, inbound Entra user JWT, realm assertion, T1, Entra app access token, on-behalf-of access token, refresh token, rotated refresh token), wired into the identity-fakes transports and JWKS signer; CapturedSurfaces, a closed record of nine surfaces (logs, audit, spans, httpResponses, errors, handles, origins, runRecords, custodyAtRest) filled only from the capturing logger, audit sink and tracer, the responses proxyToWorker returns, the error values the path produces, the handles and RunAuthority/RunMintingAuthority/InvocationOrigin values the path yields, the in-memory HitlRedisPort and the custody keyspace of the in-memory RedisPort or memory store; assertNoCredentialMaterial(surfaces, sentinels) renders each captured value with JSON.stringify, String() and Bun.inspect and fails on any sentinel, its base64, base64url or hex encoding, or any JWT segment of 16 characters or more; assertCustodyCiphertextOnly(custodyAtRest, sentinels, keyring) also requires every custody record to be a SealedRefreshCredential that opens only under the deployment keyring with its own binding as AAD
```

### Host: capability catalog (authority mode source)

```
packages/host/src/domain/capability-catalog.ts — Component Design › Capability Catalog; absorbs capability-scope.ts; no module-load parse; brokeredNamespacesOf (Phase 1, classifyCapability's own namespace rule); admittedCapabilityOf (Phase 2)
packages/host/src/domain/capability-scope.ts, domain/__tests__/capability-scope.test.ts — DELETED in the Phase 4 legacy deletion (Phase 1 re-derives its exports from the catalog)
packages/host/src/__tests__/boot-capability-catalog.test.ts — AS-009, SC-013: createHost with HostDeps.capabilityCatalog = a data catalog whose entry lacks `authority` (and one with an unknown mode) returns Err capability-catalog-invalid naming the capability, with no capability connected, no router built and no server bound; createHost with no override boots (the code catalog passes the same parser)
packages/host/src/domain/capability-gate.ts — decideGate(catalog, capability, assigned, dynamicsOrgHost) → pass-through | unknown{capability} | refused{scope, reason} | gated{scope, audience}, through classifyCapability: the legacy broker's gate, deleted with it in the Phase 4 legacy deletion; gateAdmitted(capability: AdmittedCapability, assigned, dynamicsOrgHost) → refused{capability, reason} | gated{audience} (Phase 3), the mint path's gate, which classifies nothing (Component Design › Capability Authority)
packages/host/src/domain/capability-registry.ts — registry augmentation derived from catalog keys
packages/host/src/domain/__tests__/capability-catalog.test.ts — parse faults name the capability; loadCapabilityCatalog maps faults to capability-catalog-invalid; @ts-expect-error type test for a missing authority
packages/host/src/domain/__tests__/capability-catalog.property.test.ts — parse(serialize(c)) = c; any entry lacking or with an unknown authority is refused; classifyCapability over generated catalogs and names: brokered iff a key, unknown iff in brokeredNamespacesOf(catalog) without the key, not-brokered otherwise; authorityOf(scope) equals the parsed entry's mode for every minted scope
packages/host/src/domain/__tests__/capability-gate.test.ts — rewritten for the catalog signature: pass-through, unknown, refused, gated; gateAdmitted refused and gated (Phase 3); the decideGate cases go with it in the legacy deletion
packages/host/src/__tests__/authority-mode.matrix.test.ts — INV-2 matrix (owner + every sibling)
```

### Host: identity topology configuration

```
packages/host/src/domain/config.ts — ENTRA_IDENTITY_MODEL, ENTRA_BLUEPRINT_CLIENT_ID, ENTRA_AGENT_IDENTITIES, DELEGATED_CUSTODY_KEYS (keyring shape validated at load), DELEGATED_CUSTODY_MAX_SEC (z.coerce.number().int().positive().optional(): a non-integer, zero, negative, empty or non-numeric value fails loadConfig naming the key; unset stays undefined); ENTRA_CLIENT_ID removed (refused by name) and the ENTRA_TENANT_ID/ENTRA_CLIENT_ID paired-field refusal removed with it
packages/host/src/domain/authority-legs.ts — Component Design › Identity Topology: planAuthorityLegs, EntraDirectory, EntraLeg with DelegationLeg nested in its wired variant (DEFAULT_DELEGATED_CUSTODY_MAX_SEC = 604800), DelegatingEntraLeg, delegationOf, delegatedAudienceFor (INV-5 owner), unwiredLegsWarning
packages/host/src/domain/__tests__/authority-legs.test.ts — rewritten: every seeded misconfiguration names its offender; custody max: unset with default HITL_RUN_TTL_SEC → 604800, unset with HITL_RUN_TTL_SEC=86400 → 86400, 3600 → 3600, equal to HITL_RUN_TTL_SEC accepted, HITL_RUN_TTL_SEC + 1 → custody-max-exceeds-run-ttl{maxSec, runTtlSec}
packages/host/src/domain/__tests__/authority-legs.property.test.ts — total over key-presence combinations: Entra leg dark iff ENTRA_TENANT_ID or ENTRA_AGENT_IDENTITIES is unset, and then the warning names each missing presence key and each ignored ENTRA_* key; configured → wired iff complete and consistent, otherwise faults naming every offender (not the first); ENTRA_CLIENT_ID always refused; a delegation leg exists only inside a wired Entra leg and is dark iff DELEGATED_CUSTODY_KEYS is unset; delegationOf is delegating iff both legs are wired, else names the dark Entra leg's missing presence keys or DELEGATED_CUSTODY_KEYS; wired maxSec is always a CustodySeconds whose value is a positive integer ≤ HITL_RUN_TTL_SEC
packages/host/src/domain/__tests__/config-security.test.ts — loadConfig end to end with env fixtures; custody key shape (32 bytes, active ∈ keys); DELEGATED_CUSTODY_MAX_SEC "0", "-1", "1.5", "", "7d" each fail loadConfig naming the key; unset loads as undefined
```

### Host: realm assertion mint

```
packages/host/src/domain/port/realm-assertion-mint.ts — RealmAssertionMint port
packages/host/src/domain/federated-assertion.ts — pure payload decode + grant/audience inspection (inspectFederatedAssertion)
packages/host/src/domain/__tests__/federated-assertion.test.ts — property: refused iff aud lacks the exchange audience or scope lacks either grant; missing grants → federation-grant-missing naming them
packages/host/src/adapters/realm-assertion-mint-http.ts — client_credentials with scope "entra-exchange <capability>", no audience param; error responses through classifyTokenEndpointError
packages/host/src/adapters/unwired-realm-assertion-mint.ts — unwired leg → AppAcquisitionFault unconfigured{why: absent}, zero egress
packages/host/src/adapters/__tests__/realm-assertion-mint-http.test.ts — request body capture (SC-001), adapter hands every non-2xx to the classifier over a fake HTTP
packages/host/src/domain/token-endpoint-error.ts — classifyTokenEndpointError (AD-8 table; overloaded by grant; codes and status only)
packages/host/src/domain/__tests__/token-endpoint-error.property.test.ts — total over (hop × grant × status × error × AADSTS codes); 429/5xx → unreachable{cause: status} for every hop and grant; the AD-8 classification table row by row; a client_credentials response never classifies to reauthorization-required; no input text reaches the fault
packages/host/src/domain/acquisition-fault.ts — frameworkErrorOf and runAuthorityRefusalOf (Component Design › Entra Agent Authority projection tables), both .exhaustive()
packages/host/src/domain/__tests__/acquisition-fault.property.test.ts — both projection tables row by row; every fault of each subset projects; unreachable is the only retriable projection; refusal HTTP statuses per reason; rendered infra-unreachable text is drawn only from the hop, the status digits and fixed words
packages/host/src/adapters/keycloak-token-endpoint.ts — DELETED in the Phase 4 legacy deletion (legacy path)
packages/host/src/adapters/keycloak-token-endpoint-http.ts — DELETED in the Phase 4 legacy deletion (legacy path; Phase 1 removes exchangeV2 from it)
packages/host/src/adapters/unwired-token-endpoint.ts — DELETED in the Phase 4 legacy deletion (legacy path; Phase 1 removes its exchangeV2 stub with the port method)
packages/host/src/adapters/__tests__/keycloak-token-endpoint-http.test.ts — DELETED in the Phase 4 legacy deletion
```

**Export bindings:**
- `packages/host/src/domain/federated-assertion.ts` — CT-2: inspectFederatedAssertion: InspectFederatedAssertionFn
- `packages/host/src/domain/token-endpoint-error.ts` — CT-2: classifyTokenEndpointError: ClassifyTokenEndpointErrorFn
- `packages/host/src/domain/acquisition-fault.ts` — CT-2: frameworkErrorOf: FrameworkErrorOfFn, runAuthorityRefusalOf: RunAuthorityRefusalOfFn

### Host: Entra agent authority (two models)

```
packages/host/src/domain/port/entra-agent-authority.ts — EntraAgentAuthority port (acquireApp, establishDelegation, redeemDelegation)
packages/host/src/adapters/entra-token-endpoint.ts — shared form-body builders, tenant-validated endpoint URL, response → AcquiredCredential | AppAcquisitionFault (client_credentials) | DelegatedGrantFault (on-behalf-of, refresh); error responses through classifyTokenEndpointError, no classification of its own
packages/host/src/adapters/entra-agent-id-authority.ts — two-step blueprint (fmi_path) → agent identity; OBO and refresh with T1
packages/host/src/adapters/entra-app-registration-authority.ts — single-step per-agent app; OBO and refresh with the realm assertion
packages/host/src/adapters/unwired-entra-agent-authority.ts — unwired leg → unconfigured{why: absent} (in each method's own subset), zero egress
packages/host/src/adapters/__tests__/entra-token-endpoint.test.ts — no client_secret/certificate ever (FR-012); every non-2xx handed to the classifier
packages/host/src/adapters/__tests__/entra-agent-id-authority.test.ts — step order, fmi_path, T1 as client_assertion, offline_access on OBO
packages/host/src/adapters/__tests__/entra-app-registration-authority.test.ts — single step, OBO assertion audience = agent app
packages/host/src/adapters/entra-wif.ts — DELETED in the Phase 4 legacy deletion (legacy path; from Phase 2 host.ts composes the legacy broker over unwired-entra-wif only)
packages/host/src/adapters/unwired-entra-wif.ts — DELETED in the Phase 4 legacy deletion (legacy path)
packages/host/src/adapters/__tests__/entra-wif.test.ts — DELETED in the Phase 4 legacy deletion
```

### Host: Entra user token verification and run-start planning

```
packages/host/src/domain/entra-user-token.ts — pure claim validation (AD-7); issuerFor(tenant) and jwksUriFor(tenant), the one derivation of the Entra v2.0 issuer and key URL, used by the claim validator and the verifier
packages/host/src/domain/redacted-secret.ts — runtime of the CT-1 RedactedSecret type (the types file only declares it): redactSecret(value) → a frozen object whose toJSON, toString and Bun.inspect custom hook all render "[redacted]" and that has no enumerable own property; revealSecret(secret) is the only reader, called only by the Entra form-body builders (entra-token-endpoint.ts), the custody cipher's seal and the user-token verifier
packages/host/src/domain/__tests__/redacted-secret.test.ts — JSON.stringify, String(), template literal, Bun.inspect, Object.keys and structuredClone of a RedactedSecret never contain the value (property test over arbitrary strings)
packages/host/src/adapters/entra-user-token-verifier.ts — verifyEntraUserToken (Component Design › Run Authority Planner; AD-7): jose + lazyJwks over jwksUriFor(step.expect.tenant) through the injected JWKS transport, RS256 only; a plain adapter function, no port
packages/host/src/domain/run-authority.ts — planRunAuthority (pass 1), admitDelegatedPresentation (pass 2), bindDelegatedPrincipal, requirementsOf (raw inventory), originOf (the only RunAuthority → InvocationOrigin derivation); the run's access, built and read only here: accessOf (pass 1), parseRunAccess (the run-store boundary), routeRequirement (the mint path's routing); bindAdmission (a decided plan's BoundAuthority)
packages/host/src/domain/jwt-validation.ts — entra_oid / entra_tid become required parsed claims
packages/host/src/domain/auth.ts — AuthenticatedUser.entra and AuthIdentity.user.entra required (Phase 2); TeamsApprover {kind: "teams-approver"; aadObjectId; canRunDag} and canAccessDag(AuthIdentity | TeamsApprover) (Phase 2); SubjectToken + markSubjectToken removed (Phase 1); agentClientIdFromFrameworkOrigin removed with its legacy callers (Phase 4 legacy deletion)
packages/host/src/domain/run-context.ts — subjectTokenForIdentity removed (Phase 1); origin no longer derived here once originOf exists (Phase 4 cut-over)
packages/host/src/http/middleware/auth.ts — user identity carries entra principal; no subject-token branding
packages/host/src/http/authenticate-identity.ts — same
packages/host/src/domain/__tests__/entra-user-token.test.ts — each refusal reason; issuerFor is the one issuer derivation; property: claims validation accepts iff all constraints hold
packages/host/src/domain/__tests__/run-authority.property.test.ts — pass 1 totality over (identity × requirements × header × legs); the pure composition (pass 1, then pass 2 over every generated presentation; no fakes) preserves the full precedence order, capability-unknown first; each refusal variant; verify-delegated only with a wired directory, a mapped agent, delegatedAudienceFor's audience and no unknown capability; accessOf keys every brokered requirement by name under authorityOf's mode and is delegating exactly on a user-delegated-pending plan; parseRunAccess(serialize(a)) = a, and it refuses a name listed twice; routeRequirement: app or delegated exactly for a name in access (never delegated over app access), refused-not-admitted exactly for a name outside access in a brokered namespace, pass-through otherwise; the admitted grant's token is the step's; bindAdmission binds the admitted run id and is pending exactly for a pending plan; binding iff oid ∧ tid equal; originOf agrees with the authority's agent and initiator for every brokered authority
packages/host/src/adapters/__tests__/entra-user-token-verifier.test.ts — signature, alg allowlist (RS256 only), key rotation via lazyJwks over an in-process JWKS transport; takes only a verify-delegated step; signature-verified carries claims only
packages/host/src/__tests__/middleware/auth.test.ts — realm JWT without entra claims → 401 naming the claims
```

**Export bindings:**
- `packages/host/src/domain/run-authority.ts` — CT-1: planRunAuthority: PlanRunAuthorityFn, admitDelegatedPresentation: AdmitDelegatedPresentationFn, bindDelegatedPrincipal: BindDelegatedPrincipalFn, originOf: OriginOfFn, routeRequirement: RouteRequirementFn
- `packages/host/src/domain/entra-user-token.ts` — CT-1: validateEntraUserTokenClaims: ValidateEntraUserTokenClaimsFn, issuerFor: IssuerForFn
- `packages/host/src/adapters/entra-user-token-verifier.ts` — CT-1: verifyEntraUserToken: VerifyEntraUserTokenFn

### Host: delegated custody

All behaviour: Component Design › Delegated Custody and LC-1.

```
packages/host/src/domain/delegated-custody.ts — LC-1 machine (transitionCustody), establishFaultOf, beginRedeem, decideRedeemStep, custodyBindingOf, parseCustodySeconds, custodySecondsToMs, custodyExpiryFor, canonical AAD encoding, reauthorizationReasonOf
packages/host/src/domain/__tests__/delegated-custody.property.test.ts — exactly the three declared (state, event) pairs are accepted; rotate at or after the binding expiry is refused; establish is refused when the binding expiry is ≤ now or beyond now + cap; refuse yields revoked with no sealed bytes; the successor type follows the event (@ts-expect-error: establish's successor is never revoked); establishFaultOf row by row (past-expiry → unreachable{entra, timeout}; cap-exceeded, undeclared → custody-defect); no event leaves revoked and only establish leaves absent; no state or successor carries an expiry or a generation chosen by the caller; reauthorizationReasonOf: revoked → refused, absent → custody-expired iff now ≥ binding expiry, else custody-absent; custodyExpiryFor ≤ both bounds; parseCustodySeconds bounds
packages/host/src/domain/__tests__/decide-redeem-step.property.test.ts — the outcome table row by row, with no fakes (@ts-expect-error: an outcome of another progress does not compile): every path finishes within seven steps; expired at begin performs no effect; a store fault only ever finishes unreachable{custody-store}; refused never grants; missing never writes again; a rotated credential gets at least one write against the generation current at that time; a failed write finishes with the grant and a pending write that the next redeem flushes first
packages/host/src/domain/port/delegated-custody-store.ts — DelegatedCustodyStore port (put, get, swap, delete)
packages/host/src/adapters/custody-cipher.ts — AES-256-GCM seal/open via WebCrypto; kid rotation; AAD mismatch → open fails
packages/host/src/adapters/delegated-custody-store-redis.ts — fugue:<tenant>:authority:custody:<binding.runId>, PX = binding expiry, ciphertext only; swap is one Lua script (missing → missing, generation mismatch → stale{current}, else SET {next, generation: expected + 1} KEEPTTL → swapped{written})
packages/host/src/adapters/delegated-custody-store-memory.ts — process-local store for Redis-less sync deployments (ciphertext only; same put and swap semantics, generation assigned by the store)
packages/host/src/adapters/run-custody-cell.ts — createRunCustodyCell(deps, bound: BoundAuthority<UserDelegatedAuthority>) → { redeem(capability: AdmittedCapability, signal) }; holds only Pick<DelegatedCustodyStore, "get" | "swap">; created only inside forRun
packages/host/src/adapters/delegation-establishment.ts — establishDelegation (AD-6); holds only Pick<DelegatedCustodyStore, "put">; runs the LC-1 establish guard before put
packages/host/src/adapters/run-authority-lifecycle.ts — INV-4 owner: createRunAuthorityLifecycle; AuthorizedRun's module-private constructor and its one fold mintingAuthorityOf; the only holder of DelegatedCustodyStore.delete and of capabilityAuthority.forRun; releases with the cause releaseCauseOf derives; applies runAuthorityRefusalOf; logs a failed delete with runId, cause and error kind only, and an establishment custody-defect at error; never throws on its own account
packages/host/src/domain/custody-release.ts — releaseCauseOf (Component Design › Delegated Custody), pure
packages/host/src/domain/__tests__/custody-release.property.test.ts — total over RunBracketEnding; sync-rejected and sync-settled{failed} give the same cause; abandonment keeps its path and step; every CustodyReleaseCause is produced; @ts-expect-error: no sync persist abandonment
packages/host/src/adapters/__tests__/custody-cipher.test.ts — round-trip; tampered AAD (any field)/ciphertext/kid refused; plaintext never in stored bytes
packages/host/src/adapters/__tests__/delegated-custody-store-redis.test.ts — (test-redis) key under tenant prefix from binding.runId; PX = binding expiry ≤ HITL_RUN_TTL_SEC (idle-eviction cover); purgeTenantKeyspace reclaims the custody key (tenant-purge cover); put writes generation 0; swap: missing never creates, stale returns the current record, swapped writes generation expected + 1 and keeps the TTL; delete idempotent
packages/host/src/adapters/__tests__/delegated-custody-store-memory.test.ts — expiry honoured on get (past PX → absent); same put and swap cases; delete idempotent
packages/host/src/adapters/__tests__/run-custody-cell.test.ts — the sequencer performs exactly the effects decideRedeemStep returns, in order, over the memory store and a fake Entra transport; one redeem at a time under concurrent callers; a pending write is flushed before the next read
packages/host/src/adapters/__tests__/delegation-establishment.test.ts — failure → typed EstablishmentFault; zero app fallback; the authority carries no run id; stored record carries no binding and opens only with custodyBindingOf(bound) as AAD; transitionCustody(absent, establish) precedes every put, so no put has an expiry ≤ now; an on-behalf-of exchange that completes at or after the run deadline (the fake Entra transport advances the clock) → unreachable{entra, timeout}, zero put, no Redis PX error; cap-exceeded and undeclared are unreachable through it (one clock read after the exchange) and their custody-defect mapping is the property test's
packages/host/src/__tests__/run-authority-lifecycle.matrix.test.ts — INV-4 matrix: owner + every sibling; each run-ending path leaves custody absent and logs releaseCauseOf of its ending; each bracket builds exactly one minting handle
```

**Export bindings:**
- `packages/host/src/domain/delegated-custody.ts` — CT-3: transitionCustody: TransitionCustodyFn, establishFaultOf: EstablishFaultOfFn, beginRedeem: BeginRedeemFn, decideRedeemStep: DecideRedeemStepFn, custodyBindingOf: CustodyBindingOfFn
- `packages/host/src/domain/custody-release.ts` — CT-3: releaseCauseOf: ReleaseCauseOfFn
- `packages/host/src/adapters/delegation-establishment.ts` — CT-3: establishDelegation: EstablishDelegationFn
- `packages/host/src/adapters/run-authority-lifecycle.ts` — CT-3: createRunAuthorityLifecycle: CreateRunAuthorityLifecycleFn

### Host: capability authority (mint path)

```
packages/host/src/adapters/capability-authority.ts — Component Design › Capability Authority: boot-scoped core + forRun, the one custody cell per user-delegated forRun, each requirement's path chosen only by routeRequirement over the run's access and the boot BrokeredNamespaces (no catalog, no mode read), per-capability access cells, frameworkErrorOf applied here only, audit, handle build; no custody decision
packages/host/src/adapters/keycloak-broker.ts — DELETED in the Phase 4 legacy deletion, after the cut-over switches host.ts to composeRunAuthorityWiring (replaced by capability-authority.ts)
packages/host/src/adapters/broker-audit.ts — audit fields gain agentClientId, entraIdentity, authority, initiator {realmSub, oid, tid}; outcome gains federation path
packages/host/src/adapters/graph-capability.ts — handle builders keyed off catalog definitions
packages/host/src/domain/token-cache.ts — cache key ADT: app{identity, capability} | delegated{identity, oid, capability}, encoded by cacheKeyOf to the string key token-cell.ts already takes (token-cell.ts unchanged); the legacy cacheKey stays until the Phase 4 legacy deletion removes its last importer
packages/host/src/domain/__tests__/token-cache.test.ts — cacheKeyOf is injective across (identity, mode, oid, capability)
packages/host/src/adapters/agent-client-credentials.ts — unchanged contract; consumed by realm-assertion-mint-http
packages/host/src/adapters/__tests__/capability-authority.test.ts — unit: unassigned refusals zero-egress, routing by the run's access (an app-access run has no delegated path; a brokered-namespace name outside the access → authority-unavailable{capability-not-admitted} with zero egress; a not-brokered name passes through), broker ignores inv.origin, cache isolation, single-flight, audit shape, one custody cell per forRun
packages/host/src/adapters/__tests__/capability-authority.property.test.ts — no credential served across (identity, mode, oid) under fast-check scheduled interleavings, single-flight per cell key (NFR-012); for N delegated capabilities in one run, custody redeems are serial, the stored generation ends at the number of rotations, the stored credential is the last rotated one, and an external writer's interleaved swap is absorbed by one re-read with no spurious error and no rotated credential lost
packages/host/src/adapters/__tests__/keycloak-broker.test.ts — DELETED in the Phase 4 legacy deletion (superseded)
packages/host/src/adapters/__tests__/broker-audit.test.ts — new fields; no credential fields
```

**Export bindings:**
- `packages/host/src/adapters/capability-authority.ts` — CT-2: createCapabilityAuthority: CreateCapabilityAuthorityFn

### Host: run authority composition (one wiring for route, HITL engine and executor)

```
packages/host/src/adapters/run-authority-admission.ts — createRunAuthorityAdmission({ catalog, legs, jwks }) → admitRunAuthority: requirementsOf → planRunAuthority → only on verify-delegated: verifyEntraUserToken (statically imported) → admitDelegatedPresentation → the AdmittedRun; no establishment (that is the lifecycle's)
packages/host/src/adapters/run-authority-wiring.ts — composeRunAuthorityWiring, RunAuthorityWiring, IdentityTransports (Component Design › Run Admission, "One wiring")
packages/host/src/adapters/run-composition.ts — createRunContextFactory(config, sharedInfra, routedTenant), createDagExecutor(config), composeHitlRunService(args: HitlWiringArgs, queueBackend, notifier), HitlWiringArgs and the helpers they call (createHitlExecutor, syncRunOptions); moved out of host.ts unchanged by the Phase 3 extraction Task, their signatures changed in the Phase 4 cut-over; imports no boot code
packages/host/src/adapters/__tests__/run-composition.test.ts — imported without createHost: createDagExecutor mints through the bracket's handle on a brokered AuthorizedRun and with no broker on an unbrokered one; composeHitlRunService's executor makes one withRecordedAuthority call per slice with the record's BoundAuthority
packages/host/src/adapters/__tests__/run-authority-admission.test.ts — refusal precedence through the composition, capability-unknown first; zero requests on the JWKS transport for every statically refusable submission that carries a token (fast-check over submissions); non-delegated plans pass through unchanged
packages/host/src/adapters/__tests__/run-authority-lifecycle.test.ts — owner unit cases: every behaviour in the RunAuthorityLifecycle interface comments (establish Err, body rejection, persist failure, withRecordedAuthority neither establishing nor releasing); non-delegated plan → identity establishment, release still issued; failing delete → release-failed + one log, nothing thrown; each brokered bracket builds exactly one handle (forRun counted, over the bracket's BoundAuthority) and hands it to the body, an unbrokered one none; mintingAuthorityOf is undefined exactly for an unbrokered run; an establishment custody-defect → 500 refusal and one error log
packages/host/src/adapters/__tests__/run-authority-wiring.test.ts — per EntraDirectory variant the adapters selected (agent-id, app-registration, unwired); partial Entra config composes the unwired adapters; a non-delegating leg composes the memory store and the unwired establishment (unconfigured{absent}, zero egress), and admission refuses every delegated run; a configured leg without ENTRA_IDENTITY_MODEL (AS-033) and with an unmapped agent client (AS-013) returns Err naming the offenders; config faults returned, never thrown
packages/host/src/__tests__/delegated-audience.matrix.test.ts — INV-5 matrix (owner + every sibling)
```

### Host: HITL persistence and approver

Behaviour: Component Design › HITL Authority Continuity and AD-9.

```
packages/host/src/hitl/types.ts — PersistedIdentity.user gains entra (Phase 2); RunRecord.authority: BoundAuthority replaces RunRecord.identity and PersistedIdentity is deleted (Phase 4 cut-over); ApproverRef, ApprovalRecord and approvals: readonly ApprovalRecord[] (Phase 5)
packages/host/src/hitl/ports.ts — RunExecutionRequest.authority: BoundAuthority replaces identity (Phase 4 cut-over)
packages/host/src/hitl/identity.ts — approverTeamIdentity returns TeamsApprover | undefined, and toPersistedIdentity / toExecIdentity carry entra (Phase 2); toPersistedIdentity and toExecIdentity deleted (Phase 4 cut-over); approver mapping to ApproverRef (Phase 5)
packages/host/src/hitl/service.ts — INV-4 sibling: startRun(admitted: AdmittedRun, input) with one establishForRecord call, and HitlRunServiceDeps.newRunId removed (the run id is admission's); processRun's ProcessRunOutcome fold and one endRun call (Phase 4 cut-over); recordDecision(..., approver) appends ApprovalRecord + hitl-decision audit (Phase 5)
packages/host/src/hitl/adapters/run-store.ts — record schema: user identity entra required (Phase 2); authority required in place of identity, parsed as a BoundAuthority over the record's own runId and its access through parseRunAccess, so a name listed twice, a delegated entry on an agent or user-app authority, or a user-delegated one without any is corrupt (Phase 4 cut-over); approvals required (Phase 5); records failing any of these are rejected as corrupt (pre-release, no shim)
packages/host/src/hitl/adapters/run-executor.ts — INV-4 sibling: RunExecutorDeps.broker → runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority">; each slice runs in one withRecordedAuthority(req.authority, body) call and mints through mintingAuthorityOf(run, meterLlm); no subject-token bind
packages/host/src/http/handlers/runs.ts — createApproveRunHandler derives ApproverRef (realm-user{realmSub, entra} | team | admin) from the middleware-built AuthIdentity; refusals via errorResponse (CT-3 runtime seam)
packages/host/src/hitl/adapters/bot/messages-handler.ts — handleBotActivity authorizes the TeamsApprover through canAccessDag (Phase 2, no code change: the call accepts the new type) and derives teams-user{aadObjectId} from it (Phase 5; CT-3 runtime seam)
packages/host/src/hitl/__tests__/identity.test.ts — approverTeamIdentity returns a teams-approver with no realm principal; user round-trip carries entra (Phase 2); round-trip cases removed with the functions (Phase 4 cut-over)
packages/host/src/hitl/__tests__/approver-authority.test.ts — unit: ApproverRef mapping per AuthIdentity variant and TeamsApprover; approval audit names both
packages/host/src/hitl/adapters/__tests__/run-executor.test.ts — rewritten: run id and authority from the record only, one withRecordedAuthority call per slice
```

### Host: admission, manifest and composition

```
packages/host/src/http/delegated-token-header.ts — parseDelegatedTokenHeader: parse X-Fugue-Delegated-Authorization → absent | present(RedactedSecret) | malformed
packages/host/src/http/handlers/run-dag.ts — INV-4 sibling: admission through the injected admitRunAuthority, then the sync path's one withEstablishedAuthority call (Component Design › Run Admission)
packages/host/src/supervisor/uds-proxy.ts — unchanged: proxyToWorker forwards X-Fugue-Delegated-Authorization and Authorization byte-identical and strips only X-Fugue-Tenant; a runtime seam of CT-1, CT-3 and CT-4
packages/host/src/http/handlers/manifest.ts — per-DAG authority block: requirements classified by classifyCapabilities, modes per brokered capability (authorityOf on a scope from the boot-loaded catalog, INV-2 sibling), any capability-unknown requirements listed, delegated header requirement, expected audience (delegatedAudienceFor, INV-5 sibling), tenant
packages/host/src/domain/host-error.ts — run-authority-refused{refusal: RunAuthorityRefusal} (Phase 4), capability-catalog-invalid{faults: readonly CatalogFault[]} (Phase 1) and identity-config-invalid{faults: readonly IdentityConfigFault[]} (Phase 2), each with its exhaustive tables (Phase boundary rule); the two boot refusals name every offending capability, key or agent client and never a value
packages/host/src/http/middleware/error-handler.ts — rawDetailsFor is .exhaustive() over HostError, so each new kind gets its case in the Task that adds the kind (Phases 1, 2, 4); with __tests__/middleware/error-handler.test.ts and domain/__tests__/host-error.test.ts
packages/host/src/domain/framework-error-http.ts — authority-unavailable mapping (AD-8); Phase 1, in the Task that widens the framework union, because both matches here are .exhaustive()
packages/host/src/host.ts — boot catalog load and HostDeps.capabilityCatalog?: unknown (Phase 1); identity-config-invalid on fault lists (Phase 2); the run-composition factories imported from adapters/run-composition.ts (Phase 3 extraction); in the Phase 4 cut-over: one composeRunAuthorityWiring per host feeding buildRouterDeps and the HITL composition, selectCapabilityBroker and selectRunAuthority removed, HostDeps.capabilityBroker REMOVED and HostDeps.identityTransports?: IdentityTransports added (Component Design › Run Admission); subject-token wiring removed (Phase 1)
packages/host/src/adapters/node-context-factory.ts — createNodeContextForDag(shared, registered, runId, signal, authority: RunAuthority, options) returns NodeContextForDag{ctx, authority: RunAuthority, meterMintedLlm}; it stores no origin (CT-4 runtime seam); resolveOriginAndBindSubjectToken removed; unmapped-DAG throw replaced by planner refusal
packages/host/src/__tests__/broker-selection.test.ts — rewritten: createHost composes composeRunAuthorityWiring over HostDeps.identityTransports for each EntraDirectory variant
packages/host/src/__tests__/entrypoint-wiring.test.ts — capabilityBroker override removed; identityTransports injected instead
packages/host/src/__tests__/integration/full-lifecycle.test.ts — T8 rewritten: the capabilityBroker override test becomes an identityTransports injection test
packages/host/src/__tests__/node-context-factory.test.ts — rewritten
packages/host/src/__tests__/handlers/run-dag-authority.test.ts — refusal ordering: zero acquire, zero startRun, zero egress (JWKS included) on refusal
packages/host/src/__tests__/handlers/manifest-authority.test.ts — authority block shape per model
packages/host/src/__tests__/boot-identity-refusal.test.ts — AS-013, AS-033, SC-013, NFR-020 at createHost: a configured Entra leg without ENTRA_IDENTITY_MODEL, with an unknown model, or with a mapped agent client that has no Entra identity returns Err identity-config-invalid naming every offender with no router built and no server bound; ENTRA_CLIENT_ID set → removed-key refusal with the migration hint; no ENTRA_* key, or only one presence key, boots with the leg dark and one warning naming the missing presence key
packages/host/src/adapters/subject-token-registry.ts — DELETED (Phase 1)
packages/host/src/adapters/__tests__/subject-token-registry.test.ts — DELETED (Phase 1)
packages/host/src/__tests__/subject-token-teardown.test.ts — DELETED (Phase 1)
packages/host/src/adapters/__tests__/unwired-defaults.test.ts — rewritten for unwired mint/authority adapters (Phase 1 drops its exchangeV2 and subject-token cases; Phase 2 adds the new adapters' rows; the Phase 4 legacy deletion drops the legacy rows)
```

### Docs, ADRs and doc-lint

```
docs/adr/0093-per-agent-entra-identity.md — supersedes ADR-0055 (written by adr-writer in Phase 1)
docs/adr/0094-per-capability-authority-mode-no-user-exchange.md — partially supersedes ADR-0056 and ADR-0058
docs/adr/0095-delegated-continuation-run-bound-custody.md — delegated continuation policy and custody
docs/adr/0055-*.md, docs/adr/0056-*.md, docs/adr/0058-*.md — status + successor pointers
docs/adr/README.md — index rows, supersession
packages/host/docs/auth.md — rewritten identity section, status matrix, token table
packages/host/docs/data-handling.md — NEW: initiator attribution (oid, tid), retention unchanged (FR-024), custody hold/bind/cap/delete (FR-044), stating the cap: DELEGATED_CUSTODY_MAX_SEC, default min(604800 s, HITL_RUN_TTL_SEC) = 7 days with default keys, at most HITL_RUN_TTL_SEC, never unbounded
packages/host/docs/identity-chain-sequence.md — NEW: sequence diagrams for agent, app user-origin, delegated user-origin; per-hop token table (iss, sub, azp, aud, holder, verifier)
docs/team-security-and-capabilities.md — reconciled; status matrix
docs/runbooks/entra-fugue-agents-provisioning.md — rewritten: both models, RBAC for Applications, Agent ID spike pass/fail, fallback selection, rollback, rotation, realm-before-host deploy order, broker-token purge, evidence template
docs/runbooks/identity-live-verification-evidence.md — NEW: evidence template incl. live latency targets (1500/2000/2500 ms p95)
docs/spikes/2026-06-10-spike-4-identity-chaining-e2e.md — superseded banner + reconciled status
CONTEXT.md — Identity-scoped capabilities table; new terms (Run authority, Authority mode, Delegated custody, Entra directory)
scripts/check-identity-docs.ts — doc-lint (AD-10: status matrix, banned phrases, evidence-gated statuses)
scripts/__tests__/check-identity-docs.test.ts — pure lint rules: each banned phrase, status matrix presence, evidence gating; verify.sh runs the script over the real doc set
scripts/verify.sh — run check-identity-docs.ts
```

---

## Component Design

### Capability Catalog

**Responsibility:** The single definition of every brokered capability, its authority mode and its downstream resource.
**Files:** File Structure › Host: capability catalog
**Interface:**

```
type AuthorityMode = "app" | "delegated"  // from CT-1 types
type CapabilityDefinitionInput = { readonly authority: AuthorityMode; readonly resource: "graph" | "dynamics" }
const CAPABILITY_CATALOG = { "msgraph:mail.send": {authority:"app", resource:"graph"}, ... } as const satisfies Record<string, CapabilityDefinitionInput>
type CatalogScope = keyof typeof CAPABILITY_CATALOG  // compile-time keys of the code catalog; types the handle registry augmentation only (replaces DownstreamScope)
type CapabilityCatalog = Brand<ReadonlyMap<string, CapabilityScope>, "CapabilityCatalog">
const scopeDefinition: unique symbol = Symbol("CapabilityScope.definition")  // a real runtime key, module-private (not exported),
  // so only this module reads a definition; declaration emit gives the codebase's `declare const … unique symbol` form (tenant-id.ts)
type CapabilityScope = {  // minted only by the module-private scopeOf (in no barrel), from a key of a parsed catalog; admission (and the legacy gate) take this,
  readonly name: string  // so data-sourced and test capabilities flow through it; the mint path takes its AdmittedCapability
  readonly [scopeDefinition]: CapabilityDefinition
}
type CatalogFault = { kind: "authority-missing" | "authority-unknown" | "resource-unknown" | "scope-malformed"; capability: string }
parseCapabilityCatalog(raw: unknown): Result<CapabilityCatalog, readonly CatalogFault[]>  // every fault, not the first
loadCapabilityCatalog(source: unknown): Result<CapabilityCatalog, HostError>  // boot entry; Err = capability-catalog-invalid{faults}; createHost passes HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG
type CapabilityClass =  // the boundary parse of one raw requirement string
  | { kind: "brokered"; scope: CapabilityScope }  // a catalog key
  | { kind: "not-brokered" }  // a namespace no catalog key uses (http, ADR-0051 custom): other providers serve it
  | { kind: "unknown"; capability: string }  // a brokered namespace whose key the catalog lacks
classifyCapability(catalog, raw: string): CapabilityClass
classifyCapabilities(catalog, raw: readonly RawCapabilityRequirement[])
  : Result<readonly CapabilityRequirement[], readonly RequirementRef[]>  // the brokered requirements, or every unknown {nodeId, capability}
authorityOf(scope: CapabilityScope): AuthorityMode  // INV-2 owner; total: no scope exists without a definition
resourceOf(scope: CapabilityScope): "graph" | "dynamics"
admittedCapabilityOf(scope: CapabilityScope): AdmittedCapability  // {name, resource}; with parseRunAccess, its only builder
requiresDelegation(reqs: readonly CapabilityRequirement[]): readonly CapabilityRequirement[]
type BrokeredNamespaces = Brand<ReadonlySet<string>, "BrokeredNamespaces">
brokeredNamespacesOf(catalog): BrokeredNamespaces  // the one namespace rule: classifyCapability and routeRequirement both read it
inBrokeredNamespace(ns: BrokeredNamespaces, name: string): boolean
```

A brokered namespace is the provider prefix of any catalog key (`msgraph`, `dynamics`, or a prefix a data catalog introduces). Admission pass 1 classifies first (AD-2), so every later reader of a mode holds a catalog-minted scope. `composeRunAuthorityWiring` hands the mint path `brokeredNamespacesOf` of the boot catalog, the same set a run admitted now is classified against.

**Depends on:** CT-1 types.

### Identity Topology (authority legs)

**Responsibility:** Parse the deployment's realm, Entra and delegation configuration into wired or dark legs, or into a list of named faults.
**Files:** File Structure › Host: identity topology configuration
**Interface:**

```
type EntraDirectory =
  | { model: "agent-id"; tenant: EntraTenantId; blueprint: EntraClientId; agents: ReadonlyMap<AgentClientId, EntraClientId> }
  | { model: "app-registration"; tenant: EntraTenantId; agents: ReadonlyMap<AgentClientId, EntraClientId> }
type EntraLeg = { kind: "wired"; directory: EntraDirectory; delegation: DelegationLeg }  // a delegation leg exists only here
  | { kind: "dark"; missing: readonly ("ENTRA_TENANT_ID" | "ENTRA_AGENT_IDENTITIES")[]; ignored: readonly string[] }
type DelegationLeg = { kind: "wired"; keys: CustodyKeyring; maxSec: CustodySeconds }  // CT-3 brand; only parseCustodySeconds builds it, so 0 < maxSec ≤ HITL_RUN_TTL_SEC by construction
  | { kind: "dark"; missing: readonly ["DELEGATED_CUSTODY_KEYS"] }
type DelegatingEntraLeg = Extract<EntraLeg, {kind:"wired"}> & { delegation: Extract<DelegationLeg, {kind:"wired"}> }
type AuthorityLegs = { keycloak: KeycloakLeg; entra: EntraLeg }  // no separate delegation field
delegationOf(entra: EntraLeg): { kind: "delegating"; leg: DelegatingEntraLeg } | { kind: "unavailable"; missing: readonly string[] }
  // the planner's delegation-unconfigured keys and the wiring's establishment choice both read this one parse
const DEFAULT_DELEGATED_CUSTODY_MAX_SEC = 604_800  // 7 days
type IdentityConfigFault =  // only for a CONFIGURED leg, or a removed key
  | { kind: "identity-model-missing" } | { kind: "identity-model-unknown"; value: string }
  | { kind: "blueprint-missing" } | { kind: "blueprint-forbidden"; model: "app-registration" }
  | { kind: "agent-identity-missing"; agentClientIds: readonly AgentClientId[] }
  | { kind: "agent-identity-orphan"; agentClientIds: readonly string[] }
  | { kind: "agent-identity-shared"; entraClientId: string; agentClientIds: readonly AgentClientId[] }
  | { kind: "removed-key"; key: "ENTRA_CLIENT_ID"; replacement: string }
  | { kind: "custody-max-exceeds-run-ttl"; maxSec: number; runTtlSec: number }
planAuthorityLegs(config, realmIssuer): Result<AuthorityLegs, readonly IdentityConfigFault[]>  // all faults, not first
delegatedAudienceFor(directory, agent): EntraClientId  // INV-5 owner: blueprint (agent-id) | agent app id (app-registration)
unwiredLegsWarning(legs): string | undefined
```

Presence gating per leg (AS-013, NFR-020, clarify log): the Entra identity leg is configured iff `ENTRA_TENANT_ID` and `ENTRA_AGENT_IDENTITIES` are both set; otherwise it is `dark` and the warning names the missing presence key(s) and every other `ENTRA_*` key it ignored (keys only, never a value). Only a configured leg can produce the model, blueprint and agent-identity faults. The delegation leg exists only inside a wired Entra leg, so a dark Entra leg cannot carry a wired one; it is configured iff `DELEGATED_CUSTODY_KEYS` is set, and otherwise `dark` (warned, not refused). A dark Entra leg's `ignored` also names any set `DELEGATED_CUSTODY_*` key. The custody max is resolved here, once, by `parseCustodySeconds(DELEGATED_CUSTODY_MAX_SEC, HITL_RUN_TTL_SEC): Result<CustodySeconds, IdentityConfigFault>`: the set value (a positive integer, or `loadConfig` refused it), else min(`DEFAULT_DELEGATED_CUSTODY_MAX_SEC`, `HITL_RUN_TTL_SEC`); above `HITL_RUN_TTL_SEC` it is `custody-max-exceeds-run-ttl`. Nothing downstream handles bare custody seconds. `ENTRA_CLIENT_ID` is refused whatever the leg state, with a migration hint, because a leftover shared-app key would otherwise go silently dark. `createHost` turns a fault list into the `identity-config-invalid` HostError and returns it before the router is built.

**Depends on:** `config.ts` (raw keys), CT-1 brands.

### Realm Assertion Mint

**Responsibility:** Obtain an agent's federation assertion carrying both the Entra-exchange grant and the capability grant, or a typed fault, with no Entra egress on failure.
**Files:** File Structure › Host: realm assertion mint
**Interface:**

```
interface RealmAssertionMint {
  readonly mintFederationAssertion: (agent: AgentClientId, capability: AdmittedCapability, signal: AbortSignal)
    => Promise<Result<FederatedAssertion, AppAcquisitionFault>>
}
inspectFederatedAssertion(jwt: string, capability): Result<FederatedAssertion, Extract<AppAcquisitionFault, {kind: "grant-missing"}>>
```

The mint's fault outcomes, all `AppAcquisitionFault` (CT-2; no `reauthorization-required` is representable):
- `grant-missing{grants}`: realm `invalid_scope`, or inspection finds either grant or the Entra-exchange audience missing.
- `unconfigured{keys, why: "absent"}`: no `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` entry for the agent, with zero egress; or the unwired adapter.
- `unconfigured{keys, why: "rejected"}`: the realm refused the agent's client authentication (`invalid_client`, 401).
- `unreachable{hop: "realm", cause}`: 429 or 5xx (`cause: {kind: "status"; status}`), a timeout or a network failure.

Every non-2xx goes through `classifyTokenEndpointError`. The adapter classifies nothing itself.

**Depends on:** `agent-client-credentials.ts`, `domain/token-endpoint-error.ts`, CT-1 and CT-2 types.

### Entra Agent Authority

**Responsibility:** Turn a federated assertion into a resource credential under the agent's own Entra identity, either app-only or on behalf of a user, for exactly one identity model.
**Files:** File Structure › Host: Entra agent authority
**Interface:**

```
interface EntraAgentAuthority {
  readonly acquireApp: (id: EntraIdentityRef, assertion: FederatedAssertion, resource: ResourceAudience, signal)
    => Promise<Result<AcquiredCredential, AppAcquisitionFault>>
  readonly establishDelegation: (id, assertion, user: VerifiedDelegationGrant, resource, signal)
    => Promise<Result<{ access: AcquiredCredential; refresh: RedactedSecret }, DelegatedGrantFault>>
  readonly redeemDelegation: (id, assertion, refresh: RedactedSecret, resource, signal)
    => Promise<Result<{ access: AcquiredCredential; refresh: RedactedSecret | undefined }, DelegatedGrantFault>>
}
// the one acquisition-fault family (CT-2 types); each path is typed with only the subset it can produce:
type Hop = "realm" | "entra" | "custody-store"
type ReauthorizationReason = "refused" | "custody-expired" | "custody-absent"
type UnreachableCause = { kind: "status"; status: number } | { kind: "timeout" } | { kind: "network" }  // closed: no free text
type AcquisitionFaultOf<H extends Hop, R extends ReauthorizationReason> =
  | { kind: "grant-missing"; grants: readonly FederationGrant[] }
  | { kind: "unconfigured"; keys: readonly string[]; why: "absent" | "rejected" }
  | { kind: "federation-rejected"; reason: "issuer" | "subject" | "audience" | "unknown"; aadsts?: AadstsCode }
  | ([R] extends [never] ? never : { kind: "reauthorization-required"; reason: R })
  | { kind: "unreachable"; hop: H; cause: UnreachableCause }
type AppAcquisitionFault = AcquisitionFaultOf<"realm" | "entra", never>  // realm mint, acquireApp
type DelegatedGrantFault = AcquisitionFaultOf<"realm" | "entra", "refused">  // on-behalf-of, refresh
type EstablishmentFault  = AcquisitionFaultOf<Hop, "refused">  // establishDelegation (put and the LC-1 establish guard included)
  | { kind: "custody-defect"; fault: "cap-exceeded" | "undeclared" }  // a guard fault that cannot occur unless the code is wrong
type AcquisitionFault    = AcquisitionFaultOf<Hop, ReauthorizationReason>  // the custody cell's redeem only
type MintPathFault = AcquisitionFault | { kind: "not-admitted" }  // + routeRequirement's refused-not-admitted; no path acquires
classifyTokenEndpointError: {  // domain/token-endpoint-error.ts; one table, the only reading of an error body
  (r: TokenEndpointErrorResponse<"client_credentials">): AppAcquisitionFault
  (r: TokenEndpointErrorResponse<"on-behalf-of" | "refresh">): DelegatedGrantFault
}
frameworkErrorOf(fault: MintPathFault, capability: string, agent: AgentClientId): FrameworkError  // domain/acquisition-fault.ts; total; renders UnreachableCause
runAuthorityRefusalOf(fault: EstablishmentFault): EstablishmentRefusal  // domain/acquisition-fault.ts; delegation-not-established{reason}
createAgentIdAuthority(deps: { directory: Extract<EntraDirectory, {model:"agent-id"}>; http; now: () => EpochMs }): EntraAgentAuthority
createAppRegistrationAuthority(deps: { directory: Extract<EntraDirectory, {model:"app-registration"}>; http; now: () => EpochMs }): EntraAgentAuthority
```

Projection tables, each a `.exhaustive()` match:

| Fault variant | `frameworkErrorOf` (over `MintPathFault`) | `runAuthorityRefusalOf` (over `EstablishmentFault`; `delegation-not-established.reason`, HTTP) |
|---|---|---|
| `grant-missing` | `authority-unavailable{federation-grant-missing{grants}}` | `grant-missing`, 403 |
| `unconfigured` | `authority-unavailable{authority-unconfigured{missing: keys}}` | `unconfigured`, 503 |
| `federation-rejected` | `authority-unavailable{federation-rejected{reason}}` | `federation-rejected`, 502 |
| `reauthorization-required` | `authority-unavailable{reauthorization-required{reason}}` | `refused` only (the subset has no custody reason), 403 |
| `unreachable` | `infra-unreachable` (retriable), message rendered from `hop` and `cause` only | `unreachable`, 503 |
| `custody-defect` | not in `MintPathFault` | `defect`, 500 (fails closed; the lifecycle logs it at error) |
| `not-admitted` | `authority-unavailable{capability-not-admitted}` | not in `EstablishmentFault` |

**Depends on:** CT-2 types, `domain/token-endpoint-error.ts` and the `fetch-http-post.ts` transport.

### Run Authority Planner

**Responsibility:** Decide, purely and before any slot or egress, the authority a run will act under, or refuse with a typed reason.
**Files:** File Structure › Host: Entra user token verification and run-start planning, plus `http/delegated-token-header.ts`
**Interface:**

```
type EpochMs = Brand<number, "EpochMs">; type DurationMs = Brand<number, "DurationMs">  // instants vs durations; no arithmetic mixes them
type AdmittedCapability = Brand<{ name: string; resource: "graph" | "dynamics" }, "AdmittedCapability">
type AccessEntry<M extends AuthorityMode> = { mode: M; capability: AdmittedCapability }
type RunAccess = Brand<  // pass 1's per-run mode resolution, persisted with the authority; name-keyed: no name under two modes, no last write wins
  | { kind: "app"; entries: ReadonlyMap<string, AccessEntry<"app">> }  // no delegated entry representable (closed `delegated?: never`)
  | { kind: "delegating"; entries: ReadonlyMap<string, AccessEntry<AuthorityMode>> },  // ≥ 1 delegated entry
  "RunAccess">  // built only by accessOf and parseRunAccess
type AppAccess = Extract<RunAccess, { kind: "app" }>; type DelegatingAccess = Extract<RunAccess, { kind: "delegating" }>
type RunAuthority =
  | { kind: "unbrokered"; principal: { kind: "agent" } | { kind: "user"; initiator: Initiator } }
  | { kind: "agent"; agentClientId: AgentClientId; access: AppAccess }
  | { kind: "user-app"; agentClientId: AgentClientId; initiator: Initiator; access: AppAccess }
  | { kind: "user-delegated"; agentClientId: AgentClientId; initiator: Initiator; access: DelegatingAccess;
      delegation: { audience: EntraClientId; custodyExpiresAtMs: EpochMs } }
// No variant holds a run id: BoundAuthority pairs it with the authority, and custodyBindingOf(bound) (CT-3) derives
// {runId, agentClientId, entra: initiator.entra, expiresAtMs}; custody key, AAD and PX all come from it.
type RawCapabilityRequirement = { nodeId: NodeId; capability: string }  // from runtimeNodeInventory, unparsed
type CapabilityRequirement = { nodeId: NodeId; scope: CapabilityScope }  // parsed by classifyCapabilities: brokered only
type RequirementRef = { nodeId: NodeId; capability: string }  // what a refusal names (scope.name)
type BrokeredRunAuthority = Exclude<RunAuthority, { kind: "unbrokered" }>
type UserDelegatedAuthority = Extract<RunAuthority, { kind: "user-delegated" }>
type RunAuthorityPlan = Exclude<RunAuthority, { kind: "user-delegated" }>
  | { kind: "user-delegated-pending"; agentClientId: AgentClientId; initiator: Initiator; access: DelegatingAccess; grant: VerifiedDelegationGrant }
type PendingPlan = Extract<RunAuthorityPlan, { kind: "user-delegated-pending" }>
type AdmittedRun<P extends RunAuthorityPlan = RunAuthorityPlan> = Brand<{ runId: RunId; dagId: DagId; ownerTeam: Team; plan: P }, "AdmittedRun">
  // only admitRunAuthority builds it; startRun and the lifecycle brackets take it whole, so no identity, plan or run id can be paired wrongly
type BoundAuthority<A extends RunAuthority = RunAuthority> = Brand<{ runId: RunId; authority: A }, "BoundAuthority">
  // the run id beside the authority established or recorded for it; built only by bindAdmission, establishDelegation (both from the
  // AdmittedRun) and the run-record parse (resume), so forRun, withRecordedAuthority, createRunCustodyCell and custodyBindingOf take no loose pair
bindAdmission(admitted: AdmittedRun): { kind: "bound"; bound: BoundAuthority<Exclude<RunAuthority, {kind:"user-delegated"}>> }
  | { kind: "pending"; admitted: AdmittedRun<PendingPlan> }  // the lifecycle's one split: a decided plan is its own authority
type DelegatedHeader = { kind: "absent" } | { kind: "present"; token: RedactedSecret } | { kind: "malformed" }
type DelegatedTokenExpectation = Brand<{ tenant: EntraTenantId; audience: EntraClientId }, "DelegatedTokenExpectation">
  // built only by pass 1; audience from delegatedAudienceFor (INV-5); no issuer: issuerFor(tenant) derives it where it is checked
type AdmissionStep =  // pass 1 result
  | { kind: "decided"; plan: Exclude<RunAuthorityPlan, { kind: "user-delegated-pending" }> }
  | { kind: "verify-delegated"; token: RedactedSecret; expect: DelegatedTokenExpectation;
      pending: { agentClientId: AgentClientId; initiator: Initiator; access: DelegatingAccess } }
type VerifyDelegatedStep = Extract<AdmissionStep, { kind: "verify-delegated" }>
type DelegatedPresentation =  // what the shell's signature check yields: claims only
  | { kind: "signature-verified"; claims: unknown }
  | { kind: "signature-rejected"; reason: "malformed" | "signature" }
type RunAuthorityRefusal =
  | { kind: "capability-unknown"; capabilities: readonly RequirementRef[] }  // 503; every unknown node and capability
  | { kind: "delegated-capability-requires-user"; nodeId: NodeId; capability: string }  // 403
  | { kind: "delegated-token-required"; requirements: readonly RequirementRef[]; audience: EntraClientId }  // 401, names header + audience
  | { kind: "delegated-token-invalid"; reason: DelegatedTokenInvalidReason }  // 401
      // DelegatedTokenInvalidReason = "malformed" | "signature" | "issuer" | "tenant" | "audience" | "expired" | "not-yet-valid" | "not-delegated" | "version"
  | { kind: "identity-binding-mismatch"; field: "oid" | "tid" }  // 403
  | { kind: "delegated-token-unexpected" }  // 400
  | { kind: "delegation-unconfigured"; missing: readonly string[] }  // 503
  | { kind: "agent-client-unmapped"; dagId: DagId }  // 503
  | { kind: "delegation-not-established"; reason: "refused" | "federation-rejected" | "grant-missing" | "unreachable" | "unconfigured" | "defect" }  // 403/502/403/503/503/500; built only by runAuthorityRefusalOf
// each producer is typed with only its subset, so the precedence split is a type fact: pass 2 holds nothing ranked above delegated-token-invalid
type PlanRefusal = Exclude<RunAuthorityRefusal, { kind: "delegated-token-invalid" | "identity-binding-mismatch" | "delegation-not-established" }>
  | { kind: "delegated-token-invalid"; reason: "malformed" }  // pass 1: a malformed header is its only token refusal
type ClaimRefusal = { kind: "delegated-token-invalid"; reason: Exclude<DelegatedTokenInvalidReason, "malformed" | "signature"> }
type BindingRefusal = Extract<RunAuthorityRefusal, { kind: "identity-binding-mismatch" }>
type PresentationRefusal = { kind: "delegated-token-invalid"; reason: "malformed" | "signature" } | ClaimRefusal | BindingRefusal  // pass 2
type AdmissionRefusal = PlanRefusal | PresentationRefusal  // admitRunAuthority
type EstablishmentRefusal = Extract<RunAuthorityRefusal, { kind: "delegation-not-established" }>  // the lifecycle brackets' only Err
planRunAuthority(input: RunAuthorityInput): Result<AdmissionStep, PlanRefusal>  // pass 1, pure, no token check
  // input: the AuthIdentity, the DAG's agent client mapping (AgentClientId | unmapped), requirements: readonly RawCapabilityRequirement[]
  // (classifyCapabilities runs first), the catalog, the brokering state (brokered{entra: EntraLeg} | unbrokered;
  // delegation-unconfigured names delegationOf(entra)'s missing keys) and the DelegatedHeader
admitDelegatedPresentation(step: VerifyDelegatedStep, p: DelegatedPresentation, nowMs: EpochMs)
  : Result<PendingPlan, PresentationRefusal>  // pass 2, pure; grant = {step.token, validated claims}
issuerFor(tenant: EntraTenantId): string  // https://login.microsoftonline.com/{tenant}/v2.0; the one derivation
validateEntraUserTokenClaims(claims: unknown, expect: DelegatedTokenExpectation, nowMs: EpochMs): Result<VerifiedEntraClaims, ClaimRefusal>
bindDelegatedPrincipal(realm: EntraPrincipal, verified: VerifiedEntraClaims): Result<EntraPrincipal, BindingRefusal>
originOf(run: BrokeredRunAuthority): InvocationOrigin  // agent → {agent, agentClientId}; user-app | user-delegated → {user, sub: initiator.realmSub, agentClientId}
accessOf(reqs: readonly CapabilityRequirement[]): RunAccess  // pass 1: one entry per name, authorityOf's mode, admittedCapabilityOf; delegating iff any delegated
parseRunAccess(raw: unknown): Result<RunAccess, "access-corrupt">  // the run-store boundary: a name twice, an unknown mode or resource → Err
type RequirementRoute =
  | { kind: "pass-through" }  // outside every brokered namespace: another provider serves it
  | { kind: "app"; capability: AdmittedCapability } | { kind: "delegated"; capability: AdmittedCapability }
  | { kind: "refused-not-admitted"; capability: string }  // in a brokered namespace, absent from access: fail closed (NFR-010)
routeRequirement(access: AppAccess, brokered: BrokeredNamespaces, name: string): Exclude<RequirementRoute, { kind: "delegated" }>
routeRequirement(access: RunAccess, brokered: BrokeredNamespaces, name: string): RequirementRoute  // the mint path's one routing rule
// adapters/entra-user-token-verifier.ts: a plain adapter function, no port (one implementation; the JWKS transport is the seam)
verifyEntraUserToken(step: VerifyDelegatedStep, jwks: EntraJwks, signal: AbortSignal): Promise<DelegatedPresentation>
```

Refusal precedence, a property-tested total order over the composed admission: `capability-unknown` → `agent-client-unmapped` → `delegated-capability-requires-user` → `delegated-token-unexpected` → `delegation-unconfigured` → `delegated-token-required` → `delegated-token-invalid` → `identity-binding-mismatch`. `capability-unknown` is first because no later decision is defined over a capability without a mode: whether delegation is required, which audience applies and whether a header is expected all read `authorityOf`. Pass 1 decides everything up to and including a malformed header (`delegated-token-invalid{malformed}`); pass 2 decides the signature and claim reasons (a JWS that does not parse is `malformed` there too) and the binding. Every pass-1 refusal outranks every pass-2 refusal, which the types state (`PresentationRefusal` holds nothing ranked above `delegated-token-invalid`), so splitting at the verification step preserves the order. The verifier's first parameter is the `verify-delegated` step, whose `expect` exists only when the Entra leg is wired, the agent is mapped, no capability is unknown and `delegatedAudienceFor` has answered (AD-5). Pass 1 also resolves the run's `access` with `accessOf`: every brokered requirement, keyed by name, under `authorityOf`'s mode. It is the only per-run mode resolution, and `routeRequirement`, in the same module, is its only reader on the mint path; every bracket mints under it, so a catalog change applies to runs admitted after it, and the realm still authorizes each capability at every mint (AD-4).
**Depends on:** catalog, CT-1 types, framework `runtimeNodeInventory`, `lazyJwks` (inside the verifier only), `delegatedAudienceFor` (INV-5).

### Delegated Custody

**Responsibility:** Hold the run-bound refresh credential only as ciphertext, through a typed lifecycle with a fixed expiry, until the run's terminal state.
**Files:** File Structure › Host: delegated custody
**Interface:**

```
type CustodySeconds = Brand<number, "CustodySeconds">  // only parseCustodySeconds(raw, runTtlSec) builds it: 0 < s ≤ HITL_RUN_TTL_SEC
type CustodyBinding = { runId: RunId; agentClientId: AgentClientId; entra: EntraPrincipal; expiresAtMs: EpochMs }  // a DERIVED view, never stored
custodyBindingOf(bound: BoundAuthority<UserDelegatedAuthority>): CustodyBinding  // the AAD and the store key
type SealedRefreshCredential = { kid: string; iv: string; ciphertext: string }  // base64url
type CustodyGeneration = Brand<number, "CustodyGeneration">  // assigned ONLY by the store: 0 on put, expected + 1 on swap
type CustodyState =  // LC-1 states = what get returns; no state carries a binding or an expiry
  | { kind: "absent" }
  | { kind: "held"; sealed: SealedRefreshCredential; generation: CustodyGeneration }
  | { kind: "revoked"; reason: "refused"; generation: CustodyGeneration }
type CustodySuccessor =  // what a transition yields and a write carries: no generation field
  | { kind: "held"; sealed: SealedRefreshCredential }
  | { kind: "revoked"; reason: "refused" }  // the sealed bytes are dropped
type CustodyEvent =  // the binding comes from the run's authority on every event that needs a time guard
  | { kind: "establish"; binding: CustodyBinding; sealed: SealedRefreshCredential; nowMs: EpochMs; cap: CustodySeconds }
  | { kind: "rotate"; binding: CustodyBinding; sealed: SealedRefreshCredential; nowMs: EpochMs }
  | { kind: "refuse" }
type CustodyTransitionFault =
  | { kind: "undeclared"; from: CustodyState["kind"]; event: CustodyEvent["kind"] }
  | { kind: "past-expiry" }  // rotate at or after binding.expiresAtMs, or establish with expiry ≤ now
  | { kind: "cap-exceeded" }  // establish with expiry beyond now + cap
type SuccessorOf<E extends CustodyEvent> = E extends {kind:"refuse"} ? Extract<CustodySuccessor, {kind:"revoked"}> : Extract<CustodySuccessor, {kind:"held"}>
transitionCustody<E extends CustodyEvent>(state: CustodyState, event: E): Result<SuccessorOf<E>, CustodyTransitionFault>
establishFaultOf(fault: CustodyTransitionFault): EstablishmentFault
  // past-expiry → unreachable{hop: entra, cause: timeout}: the run's window closed during the mint and on-behalf-of exchange (retriable 503);
  // cap-exceeded | undeclared → custody-defect{fault}: unreachable by construction, so a defect, failed closed
reauthorizationReasonOf(state: Exclude<CustodyState, {kind:"held"}>, binding: CustodyBinding, nowMs: EpochMs): ReauthorizationReason
custodyExpiryFor(now: EpochMs, max: CustodySeconds, runDeadline: EpochMs): EpochMs  // min(now + custodySecondsToMs(max), runDeadline)

// Persistence. The fence is in the types: a write carries a CustodySuccessor, which has no generation, so only the store sets one.
type HeldCustody = Extract<CustodyState, {kind:"held"}>
type StoredCustody = Exclude<CustodyState, {kind:"absent"}>
type CustodySwapOutcome =
  | { kind: "swapped"; written: StoredCustody }  // stored generation was expected; next written as expected + 1 with the remaining TTL
  | { kind: "stale"; current: StoredCustody }  // another writer moved first; nothing written
  | { kind: "missing" }  // no record (released, expired at PX, purged); nothing written, never created
interface DelegatedCustodyStore {
  put(binding: CustodyBinding, initial: Extract<CustodySuccessor, {kind:"held"}>): Promise<Result<void, HostError>>
      // NX; key fugue:<tenant>:authority:custody:<binding.runId>; writes generation 0; PX at binding.expiresAtMs
  get(runId: RunId): Promise<Result<CustodyState, HostError>>  // missing or past PX → absent
  swap(runId: RunId, expected: CustodyGeneration, next: CustodySuccessor): Promise<Result<CustodySwapOutcome, HostError>>
      // atomic: writes next with generation expected + 1 iff the stored generation is expected; KEEPTTL; never creates
  delete(runId: RunId): Promise<Result<void, HostError>>  // idempotent; handed ONLY to the lifecycle owner
}

// The run custody cell's protocol, pure (domain/delegated-custody.ts, beside transitionCustody). The cell
// (adapters/run-custody-cell.ts) performs each effect and feeds the outcome back; it decides nothing itself.
type PendingCustodyWrite = { expected: CustodyGeneration; next: Extract<CustodySuccessor, {kind:"held"}> }
type RedeemContext = { binding: CustodyBinding; nowMs: EpochMs; pending: PendingCustodyWrite | null }
type RedeemProgress =  // the ONE effect the cell performs next
  | { kind: "flush"; write: PendingCustodyWrite }  // a write an earlier redeem could not complete
  | { kind: "read" }
  | { kind: "open"; held: HeldCustody }
  | { kind: "redeem"; held: HeldCustody }  // mint, then redeemDelegation with the opened credential; the cell seals any rotated one
  | { kind: "write"; expected: CustodyGeneration; next: CustodySuccessor; attempt: "first" | "retry"; then: "grant" | "refused" }
type RedeemOutcomeOf = {  // each progress's own outcomes, and no others
  flush: CustodySwapOutcome | { kind: "store-failed" }
  read: CustodyState | { kind: "store-failed" }
  open: { kind: "opened" } | { kind: "unopenable" }  // the plaintext stays in the cell
  redeem: { kind: "redeemed"; rotated: SealedRefreshCredential | null } | { kind: "redeem-failed"; fault: DelegatedGrantFault }
  write: CustodySwapOutcome | { kind: "store-failed" }
}
type RedeemAwaiting = { [P in RedeemProgress["kind"]]:
  { context: RedeemContext; progress: Extract<RedeemProgress, {kind: P}>; outcome: RedeemOutcomeOf[P] } }[RedeemProgress["kind"]]
type RedeemStep =
  | { kind: "perform"; context: RedeemContext; progress: RedeemProgress }
  | { kind: "finish"; result: { kind: "grant" } | { kind: "fault"; fault: AcquisitionFault };
      pending: PendingCustodyWrite | null; log: readonly CustodyLogEvent[] }  // CustodyLogEvent: custody-unopenable | custody-defect | custody-rotation-contended | custody-revocation-write-failed
beginRedeem(context: RedeemContext): RedeemStep  // the two begin rows
decideRedeemStep(awaiting: RedeemAwaiting): RedeemStep  // .exhaustive() over progress.kind, then over that progress's outcomes: exactly the legal pairs

// The run-authority lifecycle (INV-4 owner): one operation owns the bracket from establishment to release.
type SyncRunEnding = { outcome: "completed" | "failed" | "aborted" }  // aborted covers the route's timeout and client cancel
type HitlRunEnding = { outcome: "completed" | "failed" | "corrupt-checkpoint" | "record-evicted" }  // a rejected gate settles failed
type RunBracketEnding =  // what the owner observed
  | { kind: "sync-settled"; ending: SyncRunEnding } | { kind: "sync-rejected" } | { kind: "hitl-ended"; ending: HitlRunEnding }
  | { kind: "abandoned"; path: "sync"; step: "establish" } | { kind: "abandoned"; path: "hitl"; step: "establish" | "persist" }
type CustodyReleaseCause =  // never chosen by a caller
  | { kind: "sync-ended"; outcome: SyncRunEnding["outcome"] }
  | { kind: "hitl-ended"; outcome: HitlRunEnding["outcome"] }
  | { kind: "establishment-abandoned"; path: "sync"; step: "establish" } | { kind: "establishment-abandoned"; path: "hitl"; step: "establish" | "persist" }
releaseCauseOf(ending: RunBracketEnding): CustodyReleaseCause  // domain/custody-release.ts; pure, .exhaustive(); sync-rejected → sync-ended{failed}
type CustodyReleaseOutcome = { kind: "released" } | { kind: "release-failed"; error: HostError }
type EstablishForRecordFailure = { kind: "refused"; refusal: EstablishmentRefusal } | { kind: "persist-failed"; error: HostError }
type AuthorizedRun = Brand<  // the bracket's ONE forRun handle exists exactly for a brokered authority
  | { kind: "unbrokered"; authority: Extract<RunAuthority, {kind:"unbrokered"}> }
  | { kind: "brokered"; authority: BrokeredRunAuthority; minting: RunMintingAuthority }, "AuthorizedRun">
  // built only by run-authority-lifecycle.ts's module-private authorizedRunOf(bound), whose minting is forRun(bound) over that same bound
mintingAuthorityOf(run: AuthorizedRun, meterLlm): MintingAuthority | undefined  // beside its constructor; .exhaustive(): brokered → {...run.minting, meterLlm}
interface RunAuthorityLifecycle {
  withEstablishedAuthority<T>(run: AdmittedRun, deadlineMs: EpochMs,
      body: (run: AuthorizedRun) => Promise<{ ending: SyncRunEnding; value: T }>): Promise<Result<T, EstablishmentRefusal>>
      // bindAdmission, or establish a pending plan → AuthorizedRun (forRun(bound) once iff brokered) → body → release(releaseCauseOf(sync-settled{ending}))
      // in finally; body rejection → release(releaseCauseOf(sync-rejected)) and rethrow;
      // establish Err → release(releaseCauseOf(abandoned{sync, establish})) and Err(runAuthorityRefusalOf(fault))
  establishForRecord<T>(run: AdmittedRun, deadlineMs: EpochMs,
      persist: (bound: BoundAuthority) => Promise<Result<T, HostError>>): Promise<Result<T, EstablishForRecordFailure>>
      // establish → persist; either failing → release(releaseCauseOf(abandoned{hitl, establish | persist})); no handle (nothing executes)
  withRecordedAuthority<T>(bound: BoundAuthority, body: (run: AuthorizedRun) => Promise<T>): Promise<T>
      // one HITL slice: forRun(bound) once over the record's parsed BoundAuthority → body; neither establishes nor releases;
      // the queue lease serializes slices, so at most one handle (one custody cell) per run per process at a time
  endRun(runId: RunId, ending: HitlRunEnding): Promise<CustodyReleaseOutcome>  // release(releaseCauseOf(hitl-ended{ending})); never rejects
}
createRunAuthorityLifecycle(deps: { establish: (admitted: AdmittedRun<PendingPlan>, deadlineMs: EpochMs)
      => Promise<Result<BoundAuthority<UserDelegatedAuthority>, EstablishmentFault>>;  // establishDelegation over a delegating leg, partially applied by the wiring;
      // on any other leg the wiring passes the unwired establishment (unconfigured{keys: delegationOf's missing, why: absent}, zero egress)
    capabilityAuthority: CapabilityAuthority;  // the lifecycle is the ONLY holder of forRun
    custody: Pick<DelegatedCustodyStore, "delete">; logger: LogPort }): RunAuthorityLifecycle  // INV-4 owner
establishDelegation(deps: { mint; entra; cipher; custody: Pick<DelegatedCustodyStore, "put">; leg: DelegatingEntraLeg; now: () => EpochMs },
    admitted: AdmittedRun<PendingPlan>, runDeadlineMs: EpochMs): Promise<Result<BoundAuthority<UserDelegatedAuthority>, EstablishmentFault>>
  // mint → on-behalf-of; then ONE clock read t = now(); delegation = {audience: delegatedAudienceFor(leg.directory, agent) (INV-5),
  // custodyExpiresAtMs: custodyExpiryFor(t, leg.delegation.maxSec, runDeadlineMs)}; bound = {admitted.runId, authority}; binding = custodyBindingOf(bound);
  // seal with AAD = binding; transitionCustody(absent, establish{binding, sealed, nowMs: t, cap: leg.delegation.maxSec}):
  // Err → Err(establishFaultOf(fault)) with no put; Ok(held) → put(binding, held); no compensation of its own
```

**The run custody cell: one writer per run.** `forRun(bound)` over a `user-delegated` authority creates exactly one cell, `createRunCustodyCell(deps, bound)` from `adapters/run-custody-cell.ts`, inside its closure, and only the run-authority lifecycle calls `forRun`, once per bracket. The cell is a single-flight queue: its operations run one at a time, in arrival order. It is the only code in the process that reads or writes the run's custody, and every per-capability delegated access cell obtains credentials only through `cell.redeem(capability, signal)`. A redeem is a loop: `beginRedeem` gives the first step, the cell performs the one effect its progress names (store `get` or `swap`, cipher `open` or `seal`, realm mint plus `redeemDelegation`), and hands that effect's own outcome to `decideRedeemStep`, until the decision is `finish`. The plaintext refresh credential and the access credential stay in the cell; the decision sees only whether an open succeeded and the sealed rotated credential. Throughout, `binding = custodyBindingOf(bound)`.

The outcome table, decided by `beginRedeem` (the begin rows) and `decideRedeemStep`, whose input admits only the progress's own outcomes, so the compiler checks that the rows are total. Rows name the progress, then its outcome. A store failure (`HostError`) never becomes an `AcquisitionFault` other than `unreachable{hop: custody-store, cause}`.

| State and outcome | Custody transition and next effect | Result of the invocation |
|---|---|---|
| begin, `nowMs ≥ binding.expiresAtMs` | none; no effect; any pending write dropped (the record vanishes at its PX) | `reauthorization-required{custody-expired}`, zero store reads, zero Entra calls |
| begin, pending write held | `flush` the pending `swap` first | continues |
| `flush` → `swapped`, `stale` or `missing` | pending cleared; `read` | continues (a `missing` record reads `absent` next) |
| `flush` → store failed | pending kept; no further effect | `unreachable{custody-store}` |
| `read` → store failed | none | `unreachable{custody-store}` (projects to retriable `infra-unreachable`) |
| `read` → `absent` | none | `reauthorization-required{custody-absent}`, or `{custody-expired}` if the expiry passed meanwhile (`reauthorizationReasonOf`) |
| `read` → `revoked` | none | `reauthorization-required{refused}` |
| `read` → `held` | `open` | continues |
| `open` → `unopenable` (AAD mismatch, kid not in the keyring) | none | `reauthorization-required{custody-absent}`, log `custody-unopenable` (runId and kid only) |
| `open` → `opened` | `redeem` | continues |
| `redeem` → `redeem-failed{reauthorization-required{refused}}` | `refuse` → `write(revoked)` against `held.generation` | `reauthorization-required{refused}` whatever the write outcome (a failed write is logged `custody-revocation-write-failed`), no `app` fallback |
| `redeem` → `redeem-failed`, any other fault | none | that fault |
| `redeem` → `redeemed`, no rotated credential | none | the access credential |
| `redeem` → `redeemed`, rotated, `rotate` → `Err(past-expiry)` | none; the rotated credential is discarded | `reauthorization-required{custody-expired}` |
| `redeem` → `redeemed`, rotated, `rotate` → any other `Err(CustodyTransitionFault)` | none | `reauthorization-required{custody-absent}`, log `custody-defect` at error (failed closed) |
| `redeem` → `redeemed`, rotated, `rotate` → ok | `write(held{sealed'})` against `held.generation` | continues |
| `write` → `swapped` | none further (the store wrote generation + 1) | the access credential |
| `write` (first attempt) → `stale{current: held}` | `rotate` from `current`; one more `write` against `current.generation` | continues |
| `write` (retry) → `stale` | none | the access credential, log `custody-rotation-contended`; the other writer's newer record stays valid |
| `write` → `stale{current: revoked}` | none | `reauthorization-required{refused}` |
| `write` → `missing` | none; never recreated, because `swap` never creates | `reauthorization-required{custody-absent}`; the fresh access credential is discarded |
| `write` → store failed | the rotated write becomes the pending write, which the cell's next redeem flushes first | the access credential (the stored older generation remains the fallback) |

Within the process, the cell's serialization means two delegated capabilities never redeem the same refresh credential concurrently. Across processes, a stale lease holder, for example, is covered by the generation fence, which the compiler enforces: a write carries a `CustodySuccessor`, which has no generation, and the store writes `expected + 1` itself. The cell never discards its own rotated credential before at least one write attempt against the generation current at that time.

**Release** (the lifecycle owner; AD-6, INV-4) is unconditional and idempotent: a run that never held custody costs one `DEL` on a missing key, so no caller decides whether a run "had" custody and a mutant owner cannot hide behind a skipped branch. A caller supplies only a run ending (`SyncRunEnding` from the sync body, `HitlRunEnding` from `processRun`'s fold), never a cause; the owner turns what it observed into a `RunBracketEnding` and derives the cause with the pure `releaseCauseOf`. On a dark delegation leg the owner is composed over the in-memory store, which stays empty because the planner refuses every delegated run there. A failed delete is logged at error as a structured record with `runId`, `cause` and the error kind only (never the sealed bytes), and the ciphertext still expires at its PX.

**The binding is never stored.** The custody record holds only `{kind, sealed, generation}` (or `{kind, reason, generation}` once revoked). `custodyBindingOf(bound)` derives the AAD at seal and at open, and the store key and PX at `put`, from the bracket's `BoundAuthority`: the admitted run id or, on resume, the HITL record's own id, beside the one `RunAuthority` the record persists, which holds no run id. So a record replayed under another run or user fails to open, and no second copy of the run id, the expiry or the initiator exists to diverge.

**Custody keys.** `DELEGATED_CUSTODY_KEYS` (JSON: the `active` kid plus kid → base64 32-byte key) arrives through the worker secrets source and is never handled by the supervisor (boundary A). Rotation adds a kid and switches `active`; old kids stay until the custody max has elapsed, so every live record still opens.

**Depends on:** LC-1, CT-3 types, `RealmAssertionMint`, `EntraAgentAuthority`, `domain/acquisition-fault.ts`, the capability authority (for the lifecycle's `forRun`), Redis port.

### Capability Authority

**Responsibility:** For one run, turn a node's `requires` into narrowed handles under the run's authority, through the gate, the realm and Entra, with per-identity caching and audit.
**Files:** File Structure › Host: capability authority
**Interface:**

```
type RunMintingAuthority = Pick<MintingAuthority, "broker" | "origin">  // framework MintingAuthority minus the host's LLM meter
interface CapabilityAuthority {
  readonly forRun: (bound: BoundAuthority<BrokeredRunAuthority>) => RunMintingAuthority  // { broker: closure over bound, origin: originOf(bound.authority) }; the only builder of the pair
}  // called ONLY by the run-authority lifecycle, once per bracket
createCapabilityAuthority(deps: {  // no catalog: the run's access and the boot namespace set carry every fact the mint path needs
  legs: AuthorityLegs; brokered: BrokeredNamespaces; assignedScopes: (a: AgentClientId) => ReadonlySet<string>;
  mint: RealmAssertionMint; entra: EntraAgentAuthority; custody: Pick<DelegatedCustodyStore, "get" | "swap">; cipher: CustodyCipher;
  graphHttp: GraphHttp; dynamicsOrgHost?: string; tracer; logger; audit; now: () => EpochMs
}): CapabilityAuthority
```

The run-authority lifecycle is the only caller of `forRun` (AD-6); its bracket bodies build the framework `MintingAuthority` with `mintingAuthorityOf(run, meterLlm)`. `createNodeContextForDag` hands the executor only the `RunAuthority`; `forRun` derives the origin with `originOf`. The broker reads identity (agent client, initiator, custody binding) only from its closure, never `inv.origin` (AD-1).

Per invocation the pure `routeRequirement(run.access, brokered, name)` (`domain/run-authority.ts`) chooses the path and the adapter only executes it, so the mint path reads no mode and no catalog and cannot ask whether a run is delegated (AD-2):
1. `pass-through`: the name is outside every brokered namespace, and another provider serves it. `refused-not-admitted`: a brokered-namespace name the admitted `access` lacks (a requirement admission never saw, or one a DAG re-registered during suspension added: the resume fingerprint excludes `requires`) fails `authority-unavailable{capability-not-admitted}` through `frameworkErrorOf`, with zero egress. Otherwise `gateAdmitted(capability, assigned, dynamicsOrgHost)` refuses an unassigned scope with zero egress, or gives the audience.
2. The route's path runs:
   - `app`: the boot-scoped single-flight cell for (identity, app, capability) runs mint, then `acquireApp`. Its faults are `AppAcquisitionFault`.
   - `delegated`: the run-scoped cell for (identity, delegated, oid, capability), which lives inside the `forRun` closure and dies with the run, asks the run's custody cell for an access credential for the capability's resource.
3. A failure is a fault of the path's subset, all assignable to `MintPathFault`. It becomes the node's framework error through `frameworkErrorOf`, the only place that projection is applied.
4. Build the handle and write the audit record.

The capability stays in both cache keys so the realm, as the policy decision point, is consulted per capability (AD-4). The module holds no custody decision: `forRun(bound)` over a `user-delegated` authority creates the run's one custody cell with `createRunCustodyCell(deps, bound)`, whose key and AAD come from `custodyBindingOf(bound)`, and the delegated access cells call its `redeem`; the outcome table is `decideRedeemStep`.

**Depends on:** every component above, plus the framework `CapabilityBroker` and `MintingAuthority`.

### Run Admission (HTTP shell)

**Responsibility:** Order the run-start steps so that every admission refusal happens before the HITL fork, concurrency, or egress, establishment runs after them (inside the sync path's held slot, or `startRun`), and custody is always torn down.
**Files:** File Structure › Host: admission, manifest and composition, and Host: run authority composition
**Interface:**

```
RunDagDeps += {
  admitRunAuthority: (identity, registered, header: DelegatedHeader, runId: RunId) => Promise<Result<AdmittedRun, AdmissionRefusal>>
      // RunAuthorityWiring.admitRunAuthority (two-pass); from here on the route reads the run id only from the AdmittedRun
  runAuthority: Pick<RunAuthorityLifecycle, "withEstablishedAuthority">  // RunAuthorityWiring.lifecycle; run-dag holds no store and no release function
  createContext: (registered, runId, signal, authority: RunAuthority) => Promise<NodeContextForDag>  // run-composition.ts createRunContextFactory → createNodeContextForDag
  executeDag: (dag, input, ctx, run: AuthorizedRun, meter) => ...  // run-composition.ts createDagExecutor → mintingAuthorityOf(run, meterLlm)
}
NodeContextForDag = { ctx; authority: RunAuthority; meterMintedLlm }  // no origin field: forRun derives it with originOf
HitlRunService.startRun(admitted: AdmittedRun, input)  // DAG, owner team, run id and plan from one admitted value
composeRunAuthorityWiring(input: { config; catalog: CapabilityCatalog; redis; routedTenant; transports: IdentityTransports;
    logger; tracer; audit; now: () => EpochMs }): Result<RunAuthorityWiring, readonly IdentityConfigFault[]>  // adapters/run-authority-wiring.ts
RunAuthorityWiring = { legs; admitRunAuthority; lifecycle: RunAuthorityLifecycle }  // the capability authority is not exposed
IdentityTransports = { realmToken; entraToken; entraJwks; graph }  // production: fetch-based, built in host.ts
```

Sync order: lookup, then access, then body, then schema, then **admit** (two-pass). If HITL, `startRun(admitted, input)` (which brackets establishment with record creation) and return. Otherwise acquire, circuit, then **one call**: `runAuthority.withEstablishedAuthority(admitted, deadlineMs, body)`, where `body(run)` runs `createContext` over `run.authority`, then `executeDag` over `run`, and returns `{ending, value}`. On `Err(refusal)` (establishment failed, custody already released by the owner) respond with the refusal. The slot is released in the route's own `finally`, as today.

In a multi-tenant deployment the request reaches this handler through the supervisor: `proxyToWorker` (`supervisor/uds-proxy.ts`) clones every inbound header, deletes the client's `X-Fugue-Tenant`, stamps the signed one and forwards the rest, so `X-Fugue-Delegated-Authorization` arrives byte-identical and is never logged (the proxy logs only the tenant and the transport reason). CT-1 declares `proxyToWorker` a runtime seam, so a future proxy header allowlist that drops the delegated header fails CT-1.

After admission the initiator's attribution reaches the mint through two injectable hops, both exported from `adapters/run-composition.ts`, which imports no boot code, so `buildRouterDeps` and CT-4 acceptance use the same functions without `createHost`: `createContext` (`createRunContextFactory` → `createNodeContextForDag`, returning the `RunAuthority` beside the context) and `executeDag` (`createDagExecutor`, minting through `mintingAuthorityOf(run, meterLlm)`, so broker and origin come from the bracket's one `forRun` call; an unbrokered run has no handle, by type). CT-4 declares both and `createNodeContextForDag` as runtime seams, so a test that stubs either dep cannot decide AS-006, FR-004 or FR-020.

**One wiring, composed in one place.** Every identity dependency the route, the HITL engine and the executor take by injection comes from one `RunAuthorityWiring`; `composeRunAuthorityWiring` is the ONLY production composition of `planAuthorityLegs`, the realm assertion mint adapter (http or unwired), the Entra agent authority adapter for the declared model (agent-id, app-registration or unwired), the JWKS resolver over `transports.entraJwks` that the user-token verifier reads, the custody cipher, the custody store (Redis when a Redis port is wired, memory otherwise), `establishDelegation` (on a non-delegating leg, by `delegationOf`, the unwired establishment instead), `createCapabilityAuthority` (over `brokeredNamespacesOf(catalog)`), `createRunAuthorityLifecycle` (over that capability authority) and `createRunAuthorityAdmission`, so acceptance that takes its identity dependencies from it cannot pick a fake port, a no-op cipher or a hand-built `RunAuthorityPlan`. Config faults are returned, never thrown. Its only free inputs are those in its signature; the catalog is branded, so only `parseCapabilityCatalog` can have produced it (host.ts passes the boot-loaded one, acceptance a parsed test catalog with delegated test capabilities, OOS-004). host.ts calls it once per host (over `sharedInfra.redis`, `routedTenant` and `HostDeps.identityTransports` or the fetch-based default; `Err` → return `identity-config-invalid` before the router is built or the server binds; a dark leg logs `unwiredLegsWarning` once) and hands the same instance to `buildRouterDeps` and `composeHitlRunService`, each taking the lifecycle narrowed as INV-4 lists, which is what keeps a HITL run's start-time custody visible to its resumed executor. `HostDeps.capabilityBroker` is removed, because an embedder-injected broker was a production bypass of exactly this composition.

**Runtime-seam rule used by every contract.** A contract declares as a runtime seam every production symbol on its decided path that a test could otherwise substitute: an edge it enters through (`proxyToWorker`, `createAuthMiddleware`, a route handler, `handleBotActivity`, `invocationFor`) and the production factory of every dependency the path receives by injection (`composeRunAuthorityWiring`, `composeHitlRunService`, `createRunContextFactory`, `createDagExecutor`). A symbol the path reaches only through a static import or a construction inside a declared seam (Testing Strategy › Acceptance seam sweep lists them) is traversed by construction and is not re-declared, because the engine requires each acceptance file to name every declared seam in code and an artificial import proves nothing. The acceptance seam sweep under Testing Strategy records, per contract and Requirement, which symbols are declared and why each excluded one cannot be bypassed.
**Depends on:** Planner, Custody, Capability Authority, HITL service.

### HITL Authority Continuity

**Responsibility:** Persist the run's authority and approvals, rebuild the broker from the record alone on resume, and delete custody at every terminal state.
**Files:** File Structure › Host: HITL persistence and approver
**Interface:**

```
RunRecord += { authority: BoundAuthority; approvals: readonly ApprovalRecord[] }  // authority: Phase 4 cut-over; approvals: Phase 5
ApprovalRecord = { nodeId: NodeId; decision: HumanAction["kind"]; approver: ApproverRef; atMs: EpochMs }  // hitl/types.ts, with ApproverRef
recordDecision(runId, nodeId, action, approver: ApproverRef): Promise<Result<void, HostError>>
HitlRunServiceDeps += { runAuthority: Pick<RunAuthorityLifecycle, "establishForRecord" | "endRun"> }  // RunAuthorityWiring.lifecycle; no custody store
RunExecutorDeps: broker → runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority">  // RunAuthorityWiring.lifecycle; one handle per slice
RunRecord.identity → RunRecord.authority; RunExecutionRequest.identity → authority  // Phase 4 cut-over: one persisted source of the initiator
TeamsApprover = { kind: "teams-approver"; aadObjectId: string; canRunDag: (team: Team) => boolean }  // domain/auth.ts; not an AuthIdentity
ProcessRunOutcome = { kind: "continuing" } | { kind: "ended"; ending: HitlRunEnding }  // processRun's single fold; endRun is called once, after it
composeHitlRunService(args: HitlWiringArgs, queueBackend: QueueBackend, notifier): { service; runQueue }  // adapters/run-composition.ts; args.runAuthority: RunAuthorityWiring
```

`startRun(admitted, input)` makes one `runAuthority.establishForRecord(admitted, clock() + HITL_RUN_TTL_SEC, persist)` call, whose `persist(bound)` creates the run record under `bound.runId` (the admitted run id), the DAG and owner team, carrying the bound authority. `processRun` folds each of its paths into one `ProcessRunOutcome`: the executor's completed, failed (a rejected gate included) and suspended results, the corrupt-checkpoint settle and the evicted record. It then calls `runAuthority.endRun(runId, ending)` exactly once when the outcome is `ended`. A record already terminal is `continuing`, because its release happened when it became terminal.

`composeHitlRunService` is the production HITL composition: it builds `createRedisRunStore` and `createRedisDecisionStore` over the tenant's Redis, `createRunExecutor` over `args.runAuthority.lifecycle` narrowed to `withRecordedAuthority`, `createRunQueue` over the injected backend and `createHitlRunService` over all of them plus the narrowed `args.runAuthority.lifecycle`. CT-3 acceptance drives it with an in-process `QueueBackend` and `runQueue.startWorker(service.processRun)`, so the record schema, the lease-fenced processing and the executor's broker are production code.

The approver is derived where production derives it, never handed in by a caller of the service: `createApproveRunHandler` maps the `AuthIdentity` that `createAuthMiddleware` built to `realm-user{realmSub, entra}`, `team{team}` or `admin`, and serializes refusals through `errorResponse`; `handleBotActivity` resolves the verified activity's `from.aadObjectId` to a `TeamsApprover` (`approverTeamIdentity`), authorizes it through `canAccessDag`, and maps it to `teams-user{aadObjectId}` (AD-9). CT-3 declares all four symbols as runtime seams, so its acceptance approves through the route and the bot handler, not through `recordDecision` with a hand-built approver.

**Depends on:** CT-1 and CT-3 types, Capability Authority, the run-authority lifecycle (INV-4).

### Doc Lint

**Responsibility:** Fail the build when an identity doc claims a status it has no evidence for, or describes the `app` path as acting as the user.
**Files:** File Structure › Docs, ADRs and doc-lint
**Interface:**

```
IDENTITY_DOCS: readonly string[]  // the issue #42 list
BANNED: readonly { pattern: RegExp; unlessLineMatches?: RegExp; reason: string }[]
lintIdentityDoc(path: string, text: string): readonly Problem[]
```

**Depends on:** none.

---

## Data Flow

Each step is specified once in Component Design; this is the composed view.

```
Run start:  proxyToWorker → createAuthMiddleware (AuthenticatedUser{entra}) → createRunDagHandler → parseDelegatedTokenHeader
  → admitRunAuthority: pass 1 planRunAuthority(requirementsOf(runtimeNodeInventory)) ─refusal→ run-authority-refused (0 JWKS, 0 slot, 0 egress)
      ─decided→ plan (agent | user-app{initiator{realmSub, oid, tid}} | unbrokered; no token retained)
      ─verify-delegated→ verifyEntraUserToken (JWKS transport) → pass 2 admitDelegatedPresentation → user-delegated-pending{access, grant}
  → AdmittedRun{runId, dagId, ownerTeam, plan}
  → HITL: startRun(admitted) → establishForRecord(admitted, deadline, persist = create record{bound.runId, bound.authority})
    sync: acquire → withEstablishedAuthority(admitted, deadline, body)
            body(run): createRunContextFactory → createNodeContextForDag(run.authority) → createDagExecutor → runDag(mintingAuthorityOf(run, meterLlm))
  → inside the lifecycle: bindAdmission ─bound→ (decided) │ ─pending→ establishDelegation → mint → OBO(offline_access) → seal(AAD = custodyBindingOf(bound))
      → transitionCustody(absent, establish) ─Err→ establishFaultOf │ ─held→ custody.put (gen 0, PX = expiry)

Per node invocation (sync bracket | HITL slice withRecordedAuthority(record.authority); forRun(bound) once per bracket):
  invocationFor → broker.mintFor → routeRequirement(access, brokered, name) ─pass-through→ other providers
      │ ─refused-not-admitted→ authority-unavailable{capability-not-admitted} (0 egress) │ gateAdmitted ─refused→ policy-refusal (0 egress)
  → app: boot cell[(entraId, app, cap)] miss → RealmAssertionMint("entra-exchange cap") → inspectFederatedAssertion → acquireApp
  → delegated: run cell[(entraId, delegated, oid, cap)] miss → run custody cell (beginRedeem, decideRedeemStep loop) → redeemDelegation → rotate → swap (gen + 1)
  → fault → frameworkErrorOf → authority-unavailable | infra-unreachable;  ok → buildGraphHandle → audit{run, node, agent, entraId, cap, mode, initiator?}

Run ending: SyncRunEnding | HitlRunEnding (→ endRun) | establishment-abandoned → the lifecycle: releaseCauseOf → custody.delete (INV-4 owner)
Idle TTL eviction → custody PX (≤ record TTL) | tenant purge → purgeTenantKeyspace(fugue:<tenant>:*)
```

The only places a bearer token exists are the inbound request (dropped after establishment), the per-call Entra form bodies, and the in-memory token cells. Custody holds only ciphertext bound by AAD.

---

## Lifecycles

### LC-1: Delegated refresh-credential custody

**Machine file:** `packages/host/src/domain/delegated-custody.ts`
**Kind:** typed-reducer
**States:** absent, held, revoked

| Event | From | To |
|---|---|---|
| establish | absent | held |
| rotate | held | held |
| refuse | held | revoked |

LC-1 is exactly the persisted lifecycle: its states are the three values `DelegatedCustodyStore.get` returns, and every transition is one that production performs and persists (`establish` is `establishDelegation`'s `transitionCustody(absent, establish)`, whose successor it `put`s; `rotate` and `refuse` are the custody cell's `swap`, decided by `decideRedeemStep`). Expiry is not a state but a pure comparison against the run authority's `custodyExpiresAtMs` (in `decideRedeemStep` and `reauthorizationReasonOf`), and the record vanishes at its PX. Release is the INV-4 owner's `DEL` of the whole record, not a transition between persisted states: whatever the state, the key becomes `absent`.

Guards (all times are `EpochMs`, the cap a `CustodySeconds`; no state carries a binding or an expiry, and the binding is an event input derived from the run's `BoundAuthority` by `custodyBindingOf`):
- `establish` requires `binding.expiresAtMs > nowMs` and `binding.expiresAtMs ≤ nowMs + custodySecondsToMs(cap)`, and yields the successor `held{sealed}`, which `put` writes at generation 0 (so establishment cannot store expired or over-cap custody); `establishFaultOf` maps its faults.
- `rotate` requires `nowMs < binding.expiresAtMs` and yields `held{sealed'}`, which `swap` writes at generation + 1. A guard failure is `past-expiry`, which `decideRedeemStep` turns into `custody-expired` with no write. Expiry cannot be extended because no state holds one.
- `refuse` yields `revoked{reason: refused}` and drops the sealed bytes, so a revoked record holds no ciphertext (`assertCustodyCiphertextOnly` relies on it).
- `revoked` has no outgoing event, and only `establish` leaves `absent`, so a rotation can neither revive a revoked custody nor recreate a released one.
- Any other (state, event) pair is `Err(CustodyTransitionFault{undeclared})`.

`reauthorizationReasonOf` maps `revoked` → `refused` and `absent` → `custody-expired` iff `nowMs ≥ binding.expiresAtMs`, else `custody-absent` (released, evicted or purged); the cell checks the authority's expiry before any read, and this mapping covers expiry passing between that check and the read. `delegated-custody.property.test.ts` asserts every guard. The machine imports `CustodyState`, `CustodySuccessor` and `CustodyEvent` from the CT-3 types file, so the frozen ADT is declared once.

---

## Invariants

### INV-1: No RFC 8693 token exchange anywhere in the system

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-no-rfc8693-token-exchange.json`
**Owner module:** none
**Unowned reason:** A prohibition. No module may implement this behaviour, so nothing can own it (FR-002, FR-003).
**Statement:** No production TypeScript source in any package names the RFC 8693 token-exchange grant URN or builds a `subject_token`/`subject_token_type` form parameter as a string literal. The rule covers every non-test file in the repository. Test files are excluded so that tests may assert the absence. The rule is live from the first edit of Wave 1, so the Phase 1 demolition task (which removes the only current production site, `keycloak-token-endpoint-http.ts`) sits in Phase 1, and the Wave 1 full-tier lint is green.

### INV-2: A capability's authority mode has exactly one source

**Tier:** advisory
**Owner module:** `packages/host/src/domain/capability-catalog.ts`
**Sibling entry points:**
- `packages/host/src/domain/run-authority.ts` — run-start admission decides whether delegation is required and resolves each brokered requirement's mode into the run's `access`
- `packages/host/src/adapters/capability-authority.ts` — the mint path chooses the app or delegated acquisition from that `access` only, through `routeRequirement`
- `packages/host/src/http/handlers/manifest.ts` — publishes each DAG's capability modes and the delegated header requirement
**Matrix test:** `packages/host/src/__tests__/authority-mode.matrix.test.ts`
**Statement:** Every call site that needs a capability's authority mode reads it through `authorityOf` on a `CapabilityScope`, which only the catalog module mints from a key of a parsed `CapabilityCatalog`, so `authorityOf` is total and no caller can be handed a capability without a mode (an unknown requirement in a brokered namespace is refused `capability-unknown` at admission instead). No module hard-codes a mode, defaults a missing mode, or keeps a second mode table. The rule covers admission (pass 1 is the only per-run mode resolution, the run's `access`), mint-path dispatch (by that `access`, never by a mode of its own) and the manifest. The matrix test generates catalogs (fast-check, including delegated test entries) and asserts that all three siblings report the owner's mode for every scope, the mint path through a run admitted by the real admission, so a mutant owner that answers "app" fails it. The tier is advisory because no lint rule can tell a mode read from a mode invented; the matrix test and owner mutation verification enforce it. The matrix test lands in Phase 1 with the owner rows, and Phases 2, 3 and 5 each extend it in the Wave that adds a sibling.

### INV-3: No credential material in any observable surface

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A prohibition. It spans every module that logs, audits, formats errors, builds handles or persists records, and no single module can own an absence (FR-022, SC-007).
**Statement:** No bearer token, assertion, refresh token, T1 token or custody plaintext appears in logs, audit records, trace spans, error values (`formatFrameworkError` and `discloseHostError` output included), HTTP responses, capability handles, `InvocationOrigin`, `RunAuthority` or `RunMintingAuthority` values, HITL run records and checkpoints, or custody records at rest, which hold only ciphertext. A regex cannot recognise a token value, so this stays advisory. It is decided by acceptance in the phase that builds each surface, over the production composition (`composeRunAuthorityWiring` and the declared seams), with the shared `acceptance/support/credential-sentinel.ts` scan: FR-022 in CT-2 (mint path: logs, audit, spans, errors, handles, custody re-sealed on rotation; Phase 3), AS-037 in CT-1 (run start: HTTP responses, worker and proxy logs, audit, errors, the admitted authority; Phase 4 cut-over), AS-039 in CT-4 (`app` execution: origin, run authority, `RunMintingAuthority`, handles, audit, logs, the run's HTTP response; Phase 4 cut-over) and AS-038 in CT-3 (continuation: run records and checkpoints, approvals, `hitl-decision` audit, error values, HTTP responses of the start, status and approve routes and the bot handler, custody at rest as ciphertext only; Phase 5). `AcquisitionFault` values count as error values; `classifyTokenEndpointError` copies only error codes into a fault, never response text, and a fault has no free-string field at all (`unreachable` carries the closed `UnreachableCause`, rendered to text only by `frameworkErrorOf` from the hop, the status digits and fixed words), so for faults this part of the rule is held by the type. The redaction primitive is `domain/redacted-secret.ts`: a `RedactedSecret` renders `[redacted]` under every serialisation, and `revealSecret` is called only by the Entra form-body builders, the custody cipher and the user-token verifier. The framework's `authority-unavailable-error.test.ts` adds a property test that formatted causes never contain an injected sentinel. There is no separate trailing scan: a leak is found in the Wave that builds the surface.

### INV-4: A run's delegated authority is established, handed to execution and released by one lifecycle owner

**Tier:** advisory
**Owner module:** `packages/host/src/adapters/run-authority-lifecycle.ts`
**Sibling entry points:**
- `packages/host/src/http/handlers/run-dag.ts` — the sync path's one `withEstablishedAuthority` call, which brackets establishment, the run's one minting handle, context creation, execution and release
- `packages/host/src/hitl/service.ts` — `startRun`'s one `establishForRecord` call and `processRun`'s one `endRun` call after its outcome fold
- `packages/host/src/hitl/adapters/run-executor.ts` — each slice's one `withRecordedAuthority` call, which builds the slice's one minting handle from the persisted authority
**Matrix test:** `packages/host/src/__tests__/run-authority-lifecycle.matrix.test.ts`
**Statement:** One operation owns the bracket from a run's authority establishment to its custody release, and the minting handle each execution bracket uses: the run-authority lifecycle that `createRunAuthorityLifecycle` builds (FR-023, AS-027, SC-012). It establishes through `establishDelegation`, builds each bracket's handle through `capabilityAuthority.forRun`, which it alone holds, so one custody cell per run is structural, and releases through `DelegatedCustodyStore.delete`, which it alone holds. It derives the release cause from the bracket's own outcome (the sync body's `SyncRunEnding`, a rejected body, the HITL `HitlRunEnding`, or a failed establish or persist step) through the pure `releaseCauseOf` in `domain/custody-release.ts`. So no module pairs an establishment with a release by hand, picks a cause, builds a second handle or custody cell for a run, or deletes, expires or overwrites custody to end a run. Siblings receive the lifecycle narrowed to the part they use (`withEstablishedAuthority` for the route, `establishForRecord | endRun` for the HITL service, `withRecordedAuthority` for the HITL executor) and hold no store and no `forRun`, so a second deletion path or a second handle does not type-check. `delegation-establishment.ts` is not a sibling: it holds only `put`, and every establishment `Err`, an ambiguous `put` included, returns to the owner, which releases. `run-custody-cell.ts` is not a sibling either: it holds only `get` and `swap`, `swap` never creates or deletes, and the cell is created only inside a `forRun` the owner calls. Two removals have no code path and are outside the sibling list by design, and `delegated-custody-store-redis.test.ts` asserts both: an idle run record evicted by Redis TTL (custody PX is the binding expiry, fixed at establishment and at most `HITL_RUN_TTL_SEC`, so custody expires no later than the record) and tenant purge (`purgeTenantKeyspace` deletes `fugue:<tenant>:*`, custody keys included). The matrix test uses the real owner over the in-memory store, with a delegated plan established through it. It drives each path and after each asserts what needs the store: that `get(runId)` is `absent` and that the logged cause is `releaseCauseOf` of that path's ending (the derivation itself is property-tested without a store in `custody-release.property.test.ts`). The sync paths go through the real route handler: completed, failed, aborted by timeout, body rejected, and establishment failed with a failed or an ambiguous `put`. The HITL paths go through the real service: completed, failed, rejected, corrupt checkpoint, evicted record, and record creation failed after establishment. A row with a store whose `delete` fails asserts `release-failed`, one error log naming `runId` and `cause` with no credential bytes, and that no sibling path throws. A row per sibling asserts that the sibling makes exactly its declared lifecycle calls (one for the route, one per half for the service, one per slice for the executor), and a row per bracket asserts that the owner calls `forRun` exactly once and the body mints through that handle. So a mutant owner that skips the delete, mis-derives the cause, swallows the outcome, drops the log or builds a second handle fails the matrix, and so does a sibling that bypasses the bracket or calls it twice. The tier is advisory because a regex cannot tell a custody delete from any other `delete` call; the narrowed sibling types, the matrix test and owner mutation verification enforce it. The owner and the matrix test's owner rows land in Phase 3. All three sibling rows land in the Phase 4 cut-over Task, which changes the three siblings' signatures together with their callers (Phase boundary rule).

### INV-5: The delegated audience has exactly one source

**Tier:** advisory
**Owner module:** `packages/host/src/domain/authority-legs.ts`
**Sibling entry points:**
- `packages/host/src/domain/run-authority.ts` — pass 1 builds the `DelegatedTokenExpectation` (the expected `aud` that `validateEntraUserTokenClaims` checks) and the audience named in the `delegated-token-required` 401
- `packages/host/src/adapters/delegation-establishment.ts` — the `delegation.audience` recorded on the `user-delegated` run authority it returns
- `packages/host/src/http/handlers/manifest.ts` — the audience the manifest tells run-starting callers to request
**Matrix test:** `packages/host/src/__tests__/delegated-audience.matrix.test.ts`
**Statement:** Every call site that needs the audience a delegated Entra user token must carry obtains it from `delegatedAudienceFor(directory, agentClientId)`: the blueprint client id under the Agent ID model and the agent's own app id under the app-registration model (AD-7). No module derives the audience from the directory itself, defaults it, or keeps a second mapping. The rule covers admission's claim validation, establishment's recorded audience and the manifest's published audience (FR-008, FR-036), so a caller told one audience is never verified against another. The matrix test generates directories for both models (fast-check: arbitrary agent maps and blueprints) and asserts, for every mapped agent, that admission accepts a token audienced to the owner's answer and refuses `delegated-token-invalid{audience}` for any other, that establishment's run authority carries the owner's answer, and that the manifest publishes it; a mutant owner that answers the blueprint under the app-registration model fails it. The tier is advisory because a regex cannot tell an audience read from an audience invented; the matrix test and owner mutation verification enforce it. The owner, the matrix test's owner rows and the `run-authority.ts` row (the planner is built in Phase 2) land in Phase 2. Pass 1 builds the expectation, so the admission sibling is `run-authority.ts`; its row drives the composed admission. Phase 3 adds the establishment row and Phase 5 the manifest row.

---

## Contracts

### CT-1: Run-start authority admission

**Types file:** `packages/host/src/domain/run-authority-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts` — AS-010, AS-021, AS-022, AS-023, AS-037, FR-006, FR-007, FR-008, FR-009, FR-018, FR-036
- `packages/host/src/__tests__/acceptance/run-authority-admission-budget.acceptance.test.ts` — AS-036
**Supported domain:** `packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts`
**Entry point:** `packages/host/src/http/handlers/run-dag.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: the supervisor forwards every tenant request to its worker here, stripping the client's `X-Fugue-Tenant` and forwarding `X-Fugue-Delegated-Authorization`)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: every request's identity, including the Entra principal parsed from the realm JWT's `entra_oid` and `entra_tid`, is built here)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: the production route handler, admission before the HITL fork and before acquire)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the production two-pass `admitRunAuthority`, with the real verifier over the injected JWKS transport, and the run-authority lifecycle whose `withEstablishedAuthority` an admitted sync submission runs in)
- `errorResponse` (`packages/host/src/http/response.ts`: refusal serialization)
**Statement:** A run is admitted under exactly one `RunAuthority`, decided before any HITL fork, concurrency acquisition or token egress. A user run with only `app` capabilities is admitted as `user-app` carrying its initiator (realm sub, oid, tid), and admin and team paths behave as before; CT-4 decides that this attribution reaches every mint audit record and that no user token is retained. Refused, each with its typed refusal and HTTP status: a run whose DAG requires a capability in a brokered namespace that the parsed catalog does not declare (`capability-unknown`, 503, naming every such node and capability, ahead of every other refusal, so an undeclared capability is never treated as `app`); an agent-origin (team or admin) run whose DAG requires a delegated capability (naming node and capability); a user run requiring delegation with no Entra token (the 401 body names the `X-Fugue-Delegated-Authorization` header and the audience it must carry); an invalid Entra token (bad signature, issuer, tenant, audience, expiry, a non-delegated token, or a wrong version); a mismatched `oid` or `tid`; an Entra token sent to a run that needs none; and delegation requested on a deployment whose delegation leg is dark. Refusals follow the precedence order of the Run Authority Planner. A submission carrying an Entra token whose refusal is static (an agent-origin run on a delegated DAG, a token sent to a run that needs none, a dark delegation leg, a malformed header) makes zero requests to the in-process JWKS transport and is never answered with a lower-precedence `delegated-token-invalid`. Every submission enters at `proxyToWorker` with an in-process transport into a worker app that mounts `createAuthMiddleware` and `createRunDagHandler` in `createRouter`'s order, and the handler's `admitRunAuthority` and run-authority lifecycle are the ones `composeRunAuthorityWiring` returns over in-process transports: no admission function, verifier, planner or binding is stubbed and no `AuthIdentity` or `RunAuthorityPlan` is hand-built. The handler's `createContext`, `executeDag` and `hitl` deps are recording observation points that capture the admitted authority or plan and count calls (zero on every refusal); what happens after admission is decided by CT-3 and CT-4. Through the proxy, a delegated submission arrives with `X-Fugue-Delegated-Authorization` byte-identical and is admitted, a client-forged `X-Fugue-Tenant` never reaches the worker (only the supervisor-signed value does), a refusal returns to the client with the worker's status and body unchanged, and no proxy log line carries the delegated token. No credential material at run start (AS-037, FR-022): every submission in the suite (admitted, and each refusal variant, including an Entra token failing each verification check and a binding mismatch) carries sentinel realm and Entra user tokens from `credential-sentinel.ts`, and `assertNoCredentialMaterial` finds neither, nor any encoding or signature segment of them, in the HTTP responses returned through `proxyToWorker`, the worker's and the proxy's log lines, the audit records, the error values, or the plans and authorities the observation points captured (a `user-delegated-pending` grant's token is a `RedactedSecret` and renders `[redacted]`). Run-start validation (realm JWT authentication, authority planning, delegated-token signature and claim verification through the real verifier over an in-process JWKS, and binding) adds at most 50 ms p95 to a submission, measured through the proxy, the middleware, the route and the wiring's admission after a warm-up that absorbs the first signing-key fetch.

### CT-2: Capability authority mint path

**Types file:** `packages/host/src/domain/capability-authority-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts` — AS-001, AS-002, AS-003, AS-004, AS-005, AS-011, AS-012, AS-024, AS-025, FR-001, FR-002, FR-003, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-021, FR-022
- `packages/host/src/__tests__/acceptance/capability-authority-budget.acceptance.test.ts` — AS-035
**Supported domain:** `packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts`
**Entry point:** `packages/host/src/adapters/capability-authority.ts`
**Runtime seams:**
- `invocationFor` (`@fuguejs/framework`: dispatch derives every Invocation from the run's MintingAuthority)
- `brokerAuditPayload` (`packages/host/src/adapters/broker-audit.ts`: every mint, reuse and refusal audit record)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the production capability authority and adapters for the configured identity model over the injected transports; every minting handle comes from its lifecycle's bracket, the only caller of `forRun`, and delegated run authorities from its `admitRunAuthority` and `withEstablishedAuthority`)
**Statement:** For a run's authority, each required capability yields a narrowed handle backed by a credential issued to that agent's own Entra identity; the realm assertion always carries both the Entra-exchange and the capability grant, and the two identity models are interchangeable with identical capability and DAG definitions. Caches never cross agent identity, authority mode or user, app and delegated handles in one node are unreachable from each other, a delegated refusal never falls back to `app`, and audit records carry the run, node, agent client, Entra identity, scope, mode and initiator `oid` with no credential material. Refused: an unassigned scope (zero egress); a missing Entra-exchange or capability grant (zero Entra egress, naming the grant); and a federation rejection (distinguished from a transient failure). A delegated capability is acquired only through a `user-delegated` bracket: a run admitted with app access has no delegated path, and its handles come only from the app path. On a deployment whose Entra identity leg is dark (no presence keys, or only one), every acquisition fails `authority-unavailable{authority-unconfigured}` naming the missing keys, with zero realm and Entra egress (FR-015, NFR-010). A transient realm or Entra failure (429, 5xx, timeout) surfaces as retriable `infra-unreachable` after exactly one transport call, with no internal retry (FR-015, NFR-021). Concurrent cold acquisitions for one (Entra identity, mode, capability) make exactly one realm and one Entra call, and concurrent acquisitions across agent identities, modes or users never receive each other's credential (FR-014, NFR-012). Custody has one writer per run. When two `delegated` capabilities with different resources are acquired concurrently in one `user-delegated` run, and each redeem returns a rotated refresh credential, both acquisitions succeed. The Entra transport sees the two refresh requests one after the other, the second presenting the refresh credential the first rotated in. The custody record afterwards is at generation 2 and opens to the second rotated credential. A rotation whose compare-and-swap finds the custody record released fails `reauthorization-required{custody-absent}` and leaves no record behind. A rotation whose compare-and-swap finds a newer generation, written by a second wiring over the same store standing in for another process, re-reads, swaps once more and succeeds, with no error and no rotated credential lost. The captured request bodies prove the federation shape: every realm request is client_credentials (zero RFC 8693 token-exchange bodies, FR-003), every Entra `client_assertion` is the agent's own realm assertion or the T1 derived from it and never a token whose subject is a human (FR-002), and no Entra request carries `client_secret` or a certificate assertion (FR-012). No credential material on the mint path (FR-022): with every realm assertion, T1, Entra access token, on-behalf-of access token and refresh token a sentinel from `credential-sentinel.ts`, `assertNoCredentialMaterial` finds none of them, nor any encoding of them, in any log line, audit record, trace span, error value (`formatFrameworkError` output of every refusal and failure above included) or capability handle (JSON, `String()` and `Bun.inspect` renderings), and `assertCustodyCiphertextOnly` holds for the custody record after a rotation re-seal. With `DELEGATED_CUSTODY_MAX_SEC` unset and `HITL_RUN_TTL_SEC` at its default, the `user-delegated` authority that the wiring's lifecycle establishes carries `custodyExpiresAtMs` = establishment + 604800 s, or the run deadline passed in when that is earlier, and its custody record's PX matches, so the default cap is checked in the phase that builds establishment (CT-3 decides FR-017 end to end). Every case takes its minting handle from a bracket of the lifecycle `composeRunAuthorityWiring` returns (`withEstablishedAuthority`, whose body receives the one handle the lifecycle built with `forRun`), for a deployment configured with `ENTRA_IDENTITY_MODEL` set to the Agent ID model and again to the app-registration model, so the adapter each model selects is the production one and the realm and Entra request bodies the tests capture are the bytes production sends; a `user-delegated` run authority is the one the wiring's `admitRunAuthority` and `withEstablishedAuthority` produce, and the delegated cases run inside that bracket, never over a hand-sealed custody record. With zero-latency injected realm and Entra transports, so that every measured millisecond is host-added, a cold acquisition through `invocationFor` and the bracket handle's `broker.mintFor` (gate, mint, assertion inspection, Entra acquisition for both identity models, custody open and rotation re-seal on the delegated path, handle build and audit) takes at most 10 ms p95, each cold sample on a fresh wiring and bracket handle built outside the timed region, and a cache hit at most 5 ms p95 with zero transport calls.

### CT-3: Run authority continuity across suspension

**Types file:** `packages/host/src/domain/delegated-custody-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts` — AS-007, AS-008, AS-020, AS-026, AS-034, AS-027, AS-028, AS-038, FR-005, FR-016, FR-017, FR-025, FR-023
**Supported domain:** `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts`
**Entry point:** `packages/host/src/hitl/service.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: run submissions and HTTP approvals reach the worker here, with `Authorization` and `X-Fugue-Delegated-Authorization` forwarded)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: the initiator's and the HTTP approver's identity, including the Entra principal, is built here)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: the production start route; admission, then the HITL branch to `startRun` with the admitted run, or the sync branch's one `withEstablishedAuthority` call bracketing establishment, execution and custody release)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: one instance supplies admission, the custody cipher and store, and the run-authority lifecycle, which is the only establishment, the only builder of the per-bracket minting handles and the only custody release)
- `composeHitlRunService` (`packages/host/src/adapters/run-composition.ts`: the production HITL composition of `createRedisRunStore`, `createRedisDecisionStore`, `createRunExecutor`, `createRunQueue` and `createHitlRunService` over the wiring; runs are processed by its own queue worker)
- `createRunContextFactory` (`packages/host/src/adapters/run-composition.ts`: the sync path's production `createContext`)
- `createDagExecutor` (`packages/host/src/adapters/run-composition.ts`: the sync path's production `executeDag`, minting through the one handle the lifecycle bracket built for the run)
- `createApproveRunHandler` (`packages/host/src/http/handlers/runs.ts`: the production approve route derives the `ApproverRef` from the middleware-built identity)
- `createGetRunHandler` (`packages/host/src/http/handlers/runs.ts`: the production run status route through which the initiator reads a HITL run's typed `reauthorization-required` failure)
- `handleBotActivity` (`packages/host/src/hitl/adapters/bot/messages-handler.ts`: the Teams approval path derives the `teams-user` `ApproverRef` from the verified activity)
- `errorResponse` (`packages/host/src/http/response.ts`: approve-route refusal serialization)
**Statement:** A user run's authority survives HITL suspension and token expiry. An `app` run resumes and completes under the agent identity, with attribution taken from the record and no user token, and a sync `app` run whose later nodes execute after the inbound tokens' expiry still succeeds. A delegated run establishes its delegation once at start, holds only an AES-GCM-sealed refresh credential bound to (run, agent, oid, tid) with expiry capped at the suspension window, obtains its first on-behalf-of credential through the agent identity, redeems the sealed credential through the agent identity after resume, and acts for the original initiator whoever approves. Every run starts at `proxyToWorker` with a realm user JWT and, when delegated, `X-Fugue-Delegated-Authorization`, through `createAuthMiddleware` into `createRunDagHandler`, so its `RunAuthorityPlan` and `RunAuthority` are the ones production admission and establishment derive; HITL runs then reach the `HitlRunService` that `composeHitlRunService` builds and are processed by its run queue worker over the in-process queue backend, and sync runs execute through `createRunContextFactory` and `createDagExecutor`. One `composeRunAuthorityWiring` instance feeds the route, the HITL composition and the sync executor, as host.ts does, and only transports, Redis, the queue backend, the notifier, the Bot Framework token verifier and the clock are fakes: no plan, run authority, approver, run record or custody record is hand-built. Approvals enter only through the production approval paths: `POST /runs/:runId/approve` (proxy, auth middleware, then the approve handler) and the Teams bot handler over the composed service. A different realm user approving over HTTP, or a mapped Teams user approving from a card, is recorded as that approver (`realm-user{realmSub, entra}` or `teams-user{aadObjectId}`) in the run's approvals as persisted by the production run store and in the `hitl-decision` audit record, while every delegated acquisition after resume still carries the initiator's `oid`. An approval of a run that is not suspended is refused 409 through `errorResponse`, and an approval by an identity the existing approver authorization refuses records nothing. A refused refresh, expired custody or absent custody is refused with `reauthorization-required` and no `app` fallback, and the refusal is surfaced to the initiator: a sync run's HTTP response is 401 `authority-unavailable` with cause `reauthorization-required`, and a HITL run settles failed with the same typed error, which the initiator reads through `GET /runs/:runId` (`createGetRunHandler`, via the proxy and the auth middleware). The custody cap is decided through the production configuration: with `DELEGATED_CUSTODY_MAX_SEC` unset and `HITL_RUN_TTL_SEC` at its default, the custody binding a delegated HITL run stores expires exactly 604800 s after establishment and its PX matches, and a resume at that expiry minus one second redeems successfully; with `DELEGATED_CUSTODY_MAX_SEC=3600`, a resume 3601 s after establishment (by `setSystemTime`) fails `reauthorization-required{custody-expired}` with zero custody-store reads, zero Entra calls and no `app` fallback (FR-017, AS-026, AS-034). The reason given to the initiator is the accurate one. A delegated HITL run whose custody record is removed before its binding expiry (the custody key deleted from the in-memory Redis while the run is suspended) fails `reauthorization-required{custody-absent}`, not `custody-expired`. The custody key's PX never exceeds the binding expiry, so no ciphertext outlives the cap to make that distinction. A resumed slice cannot widen the admitted authority (FR-005, NFR-010): an `app` HITL run whose DAG is re-registered while it is suspended, with the same nodes and edges (so the resume fingerprint still matches) but a later node that now also requires a catalog capability the run was not admitted for, fails that node `authority-unavailable{capability-not-admitted}` naming the capability, with zero realm and Entra egress for it and no pass-through to another provider; a node that gains a not-brokered `http` requirement still runs. After every terminal state (HITL completed, HITL failed including a rejected gate, HITL record evicted, sync completed, sync failed, and sync aborted by the route's timeout, which is the cancelled teardown) no delegated credential for the run can be retrieved, through the capability authority or from the custody keyspace. No credential material across continuation (AS-038, FR-022): with the inbound tokens, realm assertions, T1, on-behalf-of and redeemed access tokens and every refresh token (original and rotated) sentinels from `credential-sentinel.ts`, `assertNoCredentialMaterial` finds none of them, nor any encoding of them, in any HITL run record or checkpoint and approval in the in-memory `HitlRedisPort`, any audit record (`hitl-decision` included), log line, trace span or error value, or any HTTP response of the start, status and approve routes and the bot handler; and `assertCustodyCiphertextOnly` holds for every custody record at rest at every step (after establishment, after each rotation, after a refusal), each opening only under the deployment keyring with its own binding as AAD.

### CT-4: User-origin run attribution through execution

**Types file:** none
**No types reason:** The slice consumes CT-1's `RunAuthority` and `OriginOfFn` and CT-2's `CreateCapabilityAuthorityFn` and `RunMintingAuthority`; the host composition it pins (`NodeContextForDag`, the two `run-composition.ts` factories, `composeRunAuthorityWiring`) is host-internal wiring, not a consumer-facing surface.
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/user-run-attribution.acceptance.test.ts` — AS-006, AS-039, FR-004, FR-020
**Entry point:** `packages/host/src/adapters/run-composition.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: the submission reaches the worker here, with `Authorization` forwarded and nothing logged but the tenant and transport reason)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: the realm JWT's `sub`, `entra_oid` and `entra_tid` become the `AuthenticatedUser` here)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: the production route handler, sync path from admission through execution)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the production admission that derives the `user-app` initiator, and the capability authority with its realm and Entra adapters for the configured model)
- `createRunContextFactory` (`packages/host/src/adapters/run-composition.ts`: the production `createContext` dep; host.ts `buildRouterDeps` uses the same export)
- `createNodeContextForDag` (`packages/host/src/adapters/node-context-factory.ts`: builds the node context and hands the run's `RunAuthority` on unchanged, with no origin of its own)
- `createDagExecutor` (`packages/host/src/adapters/run-composition.ts`: the production `executeDag` dep; builds the framework `MintingAuthority` with `mintingAuthorityOf` over the handle the lifecycle bracket built, so broker and origin come from one `RunAuthority`)
**Statement:** A user-origin sync run whose nodes require only `app` capabilities, submitted at `proxyToWorker` with a realm user JWT carrying `sub`, `entra_oid` and `entra_tid`, runs end to end through the production composition: `createAuthMiddleware` and `createRunDagHandler` with `admitRunAuthority` and the run-authority lifecycle from `composeRunAuthorityWiring`, `createContext` from `createRunContextFactory` and `executeDag` from `createDagExecutor` (both in `run-composition.ts`) over the minting handle that wiring's lifecycle builds for the bracket, whose realm and Entra adapters talk to in-process fake HTTP transports, for both identity models. No dep is stubbed and no `AuthIdentity`, `RunAuthorityPlan` or `RunAuthority` is hand-built; only transports, Redis and the clock are fakes. Every node's mint produces exactly one audit record, and each carries `authority: app`, the node's agent client and Entra identity, and `initiator{realmSub, oid, tid}` equal to the submitting user's (AS-006, FR-020); the Entra transport sees only the agent's own grants (zero on-behalf-of and zero RFC 8693 bodies). A team-origin run of the same DAG writes audit records with no initiator, the control that an attribution hard-coded in the executor fails. A sentinel inbound bearer token appears in none of: the `RunAuthority` handed to `createContext`, the `NodeContextForDag` that `createNodeContextForDag` returns (also called directly on a `user-app` authority), the `RunMintingAuthority` that `forRun` returns for it, any realm or Entra request body, any audit record, any log line including the proxy's; and the custody store holds no record for the run (FR-004). Every `InvocationOrigin` a node receives equals `originOf` of the admitted authority (user origin, the initiator's realm `sub`, the DAG's agent client). No credential material on the `app` execution path (AS-039, FR-022): with the inbound realm JWT, the realm assertion, T1 and the Entra access token sentinels from `credential-sentinel.ts`, `assertNoCredentialMaterial` finds none of them, nor any encoding or signature segment of them, in the `RunAuthority`, `RunMintingAuthority` and every `InvocationOrigin` the nodes receive, any capability handle's JSON, `String()` or `Bun.inspect` rendering, any audit record, log line or trace span, or the run's HTTP response. A `createContext` that drops or swaps the initiator, or an `executeDag` that mints through anything but the handle the lifecycle bracket built over the `RunAuthority` `createContext` returned, fails the suite.

---
## Implementation Phases

Ordered by dependency, not priority, because delegated mode (P2) reuses every P1 seam; the FR-033 realm hardening (P3) is specified in the Cross-Repo section. Decompose places the contract tasks (CT-1, CT-2, CT-3, CT-4) and the LC-1 machine task in the earliest Waves their imports allow. The LC-1 machine imports CT-3 types, so it follows the CT-3 contract task.

**Phase boundary rule (every Wave leaves typecheck and the host suite green).** The rule covers signature changes as well as deletions.

*Signature changes.* A Task that changes an exported signature also updates, in the same Task, every production caller and every test fixture that constructs or matches it. This applies to a function's parameters or result, a deps record (`RunDagDeps`, `HitlRunServiceDeps`, `RunExecutorDeps`, `HitlWiringArgs`, `HostDeps`, `NodeContextForDag`), a port, a union that some caller matches with `.exhaustive()` (`FrameworkError`, `HostError`), a record type gaining a required field or a narrowed variant (`AuthIdentity`, `AuthenticatedUser`, `PersistedIdentity`, `RunExecutionRequest`), and a persisted record schema (`RunRecord`). Decompose never splits a signature change from its callers, and no Wave leaves a caller for a later one. New modules and new exports with no caller yet are exempt. Each Phase's **Files** list below names the constructors and matchers found by searching the code (`kind: "user"` literals, `canRunDag:` fixtures, realm-claim fixtures, `identity: {` and `ownerTeam:` record fixtures, `.exhaustive()` matches of `HostError`, every importer of a changed module); decompose re-runs those searches when it cuts Tasks. The rule decides these placements:
- The framework union widening and the host's `framework-error-http.ts` mapping are one Phase 1 Task.
- Each HostError widening carries `domain/host-error.ts`'s exhaustive tables and `http/middleware/error-handler.ts`'s exhaustive `rawDetailsFor` in the same Task: `capability-catalog-invalid` (Phase 1), `identity-config-invalid` (Phase 2) and `run-authority-refused` (Phase 4).
- The required realm Entra principal is one Phase 2 Task. It carries every constructor of a `user` `AuthIdentity` or `PersistedIdentity`, including `hitl/identity.ts` (`approverTeamIdentity`, now returning `TeamsApprover`, and `toPersistedIdentity` / `toExecIdentity`), `hitl/types.ts` and the run-store schema.
- The run-start cut-over is one Phase 4 Task. It is where several modules' signatures change together: `HitlRunService.startRun`, `HitlRunServiceDeps`, `RunExecutorDeps`, `RunExecutionRequest`, `RunDagDeps`, `NodeContextForDag` and `RunRecord.authority` (replacing `RunRecord.identity`), with their callers `run-dag.ts`, `hitl/service.ts`, `run-executor.ts` and the host.ts HITL and router composition; what can leave it does (Phase 4 intro).

*Deletions.* The legacy broker path (the files File Structure marks DELETED in the Phase 4 legacy deletion) stays compiling until the Phase 4 cut-over Task switches host.ts to `composeRunAuthorityWiring`; the legacy deletion Task after it deletes the path once nothing outside it imports it. Phases 2 and 3 build every replacement as new files and new exports beside it. A Phase 2 or 3 Task that changes a module the legacy path imports (`config.ts`, `authority-legs.ts`, `token-cache.ts`, `broker-audit.ts`, `graph-capability.ts`, `capability-gate.ts`) updates the legacy importer in the same Task, so no Wave is left broken for a later one. From Phase 2, when `ENTRA_CLIENT_ID` is removed, host.ts composes the legacy broker's Entra hop as `unwired-entra-wif` only: that hop never reached Entra (spec Summary), so no working behaviour is lost before the Phase 4 cut-over replaces it.

### Phase 1: Foundations and demolition (no dependencies)

- Add `authority-unavailable` to the framework error union. Update `FRAMEWORK_ERROR_KINDS`, the persisted schema, `formatFrameworkError` and `retriabilityOf` (non-retriable), with tests. In the same Task, add the host's `authority-unavailable` HTTP mapping in `domain/framework-error-http.ts`, whose two matches are `.exhaustive()` and would otherwise stop compiling (Phase boundary rule). Export `runtimeNodeInventory` from the framework barrel.
- Create the capability catalog and its parser, with the opaque catalog-minted `CapabilityScope`, the total `authorityOf(scope)`, `brokeredNamespacesOf` and `classifyCapability` / `classifyCapabilities`. Re-derive the exports of `capability-scope.ts` from the catalog (the file is deleted in the Phase 4 legacy deletion). Point `capability-gate.ts` (now `decideGate(catalog, capability, …)` with its `unknown` arm) and `capability-registry.ts` at the catalog, and update `decideGate`'s production caller, the legacy `keycloak-broker.ts`, in the same Task. Write the `@ts-expect-error` type test and the property tests. Write the INV-2 matrix test with the owner rows.
- Add the boot catalog entry point (AS-009, FR-005, SC-013): `loadCapabilityCatalog`, the `capability-catalog-invalid` HostError with its cases in `domain/host-error.ts`'s exhaustive tables and in `http/middleware/error-handler.ts`'s exhaustive `rawDetailsFor` (Phase boundary rule), `HostDeps.capabilityCatalog?: unknown`, and the `createHost` call right after `executeStartup` that loads `deps.capabilityCatalog ?? CAPABILITY_CATALOG` and hands the parsed catalog to the gate (and, from the Phase 4 cut-over, to the wiring and, from Phase 5, to the manifest). Write `__tests__/boot-capability-catalog.test.ts`.
- Remove the RFC 8693 user exchange end to end, behaviour-preserving for `app` semantics:
  - Delete `subject-token-registry.ts` and its test, `subject-token-teardown.test.ts`, `SubjectToken` and `markSubjectToken`, `subjectTokenForIdentity`, `exchangeV2` (from the port in `keycloak-token-endpoint.ts`, the HTTP adapter and the `unwired-token-endpoint.ts` stub), `buildExchangeV2Body` and `TOKEN_EXCHANGE_GRANT_TYPE`, `inertResolveSubjectToken`, `withSubjectTokenRelease`, and the `bindSubjectToken` option and its resolution in `node-context-factory.ts` and `run-executor.ts`.
  - The broker's user branch now mints the agent's own client_credentials assertion, with the initiator `sub` as attribution only.
  - Update the affected tests, `unwired-defaults.test.ts` included, and the comments in `domain/tenant.ts` that cite the deleted brand. This makes the INV-1 rule green.
- Write ADRs 0093, 0094 and 0095 (adr-writer agent). Add the successor pointers in ADRs 0055, 0056 and 0058, and the `docs/adr/README.md` rows.
- **Files:**
  - `packages/framework/src/types/errors.ts`, `packages/framework/src/index.ts`, `packages/framework/src/__tests__/authority-unavailable-error.test.ts`, `packages/host/src/domain/framework-error-http.ts` and its test (same Task as the union widening)
  - `packages/host/src/domain/capability-catalog.ts`, `capability-scope.ts`, `capability-gate.ts`, `capability-registry.ts`, `adapters/keycloak-broker.ts` (the `decideGate` caller), `domain/host-error.ts`, `http/middleware/error-handler.ts`, `domain/__tests__/capability-catalog*.test.ts`, `domain/__tests__/capability-gate.test.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `packages/host/src/__tests__/authority-mode.matrix.test.ts`, `packages/host/src/__tests__/boot-capability-catalog.test.ts`
  - Demolition: `adapters/subject-token-registry.ts`, `adapters/__tests__/subject-token-registry.test.ts`, `__tests__/subject-token-teardown.test.ts`, `domain/auth.ts`, `domain/run-context.ts`, `domain/tenant.ts` (comments only), `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `adapters/keycloak-token-endpoint.ts`, `adapters/keycloak-token-endpoint-http.ts`, `adapters/unwired-token-endpoint.ts`, `adapters/keycloak-broker.ts`, `adapters/node-context-factory.ts`, `hitl/adapters/run-executor.ts`, `host.ts`, plus their tests (`__tests__/middleware/auth.test.ts`, `__tests__/node-context-factory.test.ts`, `__tests__/broker-selection.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `adapters/__tests__/keycloak-token-endpoint-http.test.ts`, `adapters/__tests__/unwired-defaults.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`)
  - `docs/adr/0093-*.md`, `0094-*.md`, `0095-*.md`, `docs/adr/0055-*.md`, `0056-*.md`, `0058-*.md`, `docs/adr/README.md`

### Phase 2: Identity topology, ports and verification (depends on Phase 1)

- Rewrite the Entra keys in `config.ts` (`DELEGATED_CUSTODY_MAX_SEC` an optional positive integer, malformed → `loadConfig` refusal naming the key) and make `authority-legs.ts` return `Result` (Component Design › Identity Topology: per-leg presence gating, `EntraDirectory`, `EntraLeg` with its nested `DelegationLeg` and the resolved custody max, `delegationOf`, every fault, `delegatedAudienceFor` as INV-5 owner). Write the unit and property tests and `__tests__/delegated-audience.matrix.test.ts` with the owner rows. In host.ts, map a fault list to the `identity-config-invalid` HostError that `createHost` returns before the router is built, adding its cases to `domain/host-error.ts`'s exhaustive tables and to `http/middleware/error-handler.ts`'s exhaustive `rawDetailsFor` in the same Task, and compose the legacy broker's Entra hop as `unwired-entra-wif` (Phase boundary rule). The removed `ENTRA_CLIENT_ID` fixtures in `config-security.test.ts`, `authority-legs.test.ts` and `broker-selection.test.ts` change in the same Task.
- Add the acquisition-fault vocabulary first, because both HTTP adapters below return it: `domain/token-endpoint-error.ts` (`classifyTokenEndpointError`) and `domain/acquisition-fault.ts` (`frameworkErrorOf`, `runAuthorityRefusalOf`), each with its property test (AD-8).
- Add the realm assertion mint port, its HTTP and unwired adapters and `inspectFederatedAssertion` (AD-4). The legacy `keycloak-token-endpoint(-http).ts` and `unwired-token-endpoint.ts` stay until the Phase 4 legacy deletion.
- Add the Entra agent authority port, the shared endpoint module, and the agent-id, app-registration and unwired adapters (AD-3). The legacy `entra-wif.ts` and `unwired-entra-wif.ts` stay until the Phase 4 legacy deletion.
- Add `domain/redacted-secret.ts` (the runtime of the CT-1 `RedactedSecret` type) with its property test.
- **Required realm Entra principal: one Task** (Phase boundary rule). Make `entra_oid` and `entra_tid` required realm claims, and `entra` required on `AuthenticatedUser`, on the `user` `AuthIdentity` and on the `user` `PersistedIdentity`. The same Task changes every constructor and matcher of those types:
  - Production: `domain/jwt-validation.ts`, `domain/auth.ts` (adds `TeamsApprover` and widens `canAccessDag` to `AuthIdentity | TeamsApprover`), `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `hitl/identity.ts` (`approverTeamIdentity` returns `TeamsApprover | undefined`, so the Teams approver is never given a fabricated realm principal; `toPersistedIdentity` and `toExecIdentity` carry `entra`), `hitl/types.ts` (`PersistedIdentity.user.entra`) and `hitl/adapters/run-store.ts` (the persisted user identity requires `entra`). `hitl/adapters/bot/messages-handler.ts` compiles unchanged, because `canAccessDag` accepts the new type.
  - Tests and fixtures: `domain/__tests__/jwt-validation.test.ts`, `adapters/__tests__/realm-jwt-verifier.test.ts`, `__tests__/middleware/auth.test.ts` (a realm JWT without the claims → 401 naming them), `__tests__/supervisor/supervisor.test.ts`, `__tests__/domain/auth.test.ts`, `__tests__/domain/tenant.test.ts`, `__tests__/handlers/run-dag.test.ts`, `__tests__/node-context-factory.test.ts`, `__tests__/integration/mapped-host-composition.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `hitl/__tests__/identity.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts` and `hitl/adapters/bot/__tests__/bot.test.ts`.
- Add Entra user token claim validation with `issuerFor` and `jwksUriFor`, and the verifier as the plain adapter function `verifyEntraUserToken(step, jwks, signal)` over the JWKS transport (no port).
- Add the two-pass run authority planner (`planRunAuthority`, `admitDelegatedPresentation`; AD-5), each pass typed with its refusal subset, with the run's `access` (`accessOf`, `parseRunAccess`; `admittedCapabilityOf` in the catalog module), `routeRequirement`, `bindAdmission`, the binding and `originOf`. Extend the INV-2 matrix test with `run-authority.ts`, and add the `run-authority.ts` row to `__tests__/delegated-audience.matrix.test.ts` (INV-5: pass 1 builds the expectation from `delegatedAudienceFor`).
- Add the custody cipher, the store port, the Redis store (the `swap` Lua script) and the in-memory store, and the LC-1 machine with `transitionCustody`, `establishFaultOf`, `beginRedeem`, `decideRedeemStep`, `custodyBindingOf(bound)`, `parseCustodySeconds`, `custodyExpiryFor` and `reauthorizationReasonOf`, with `delegated-custody.property.test.ts` and `decide-redeem-step.property.test.ts`.
- **Files:** `domain/config.ts`, `domain/authority-legs.ts`, `domain/host-error.ts`, `http/middleware/error-handler.ts`, `host.ts`, `domain/port/*.ts`, `domain/token-endpoint-error.ts`, `domain/acquisition-fault.ts`, `domain/federated-assertion.ts`, `domain/entra-user-token.ts`, `domain/redacted-secret.ts`, `domain/run-authority.ts`, `domain/capability-catalog.ts` (`admittedCapabilityOf`), `domain/jwt-validation.ts`, `domain/auth.ts`, `domain/delegated-custody.ts`, `adapters/realm-assertion-mint-http.ts`, `adapters/unwired-realm-assertion-mint.ts`, `adapters/entra-token-endpoint.ts`, `adapters/entra-agent-id-authority.ts`, `adapters/entra-app-registration-authority.ts`, `adapters/unwired-entra-agent-authority.ts`, `adapters/entra-user-token-verifier.ts`, `adapters/custody-cipher.ts`, `adapters/delegated-custody-store-redis.ts`, `adapters/delegated-custody-store-memory.ts`, `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `hitl/identity.ts`, `hitl/types.ts`, `hitl/adapters/run-store.ts`, their tests, the fixtures named in the required-principal Task, `domain/__tests__/config-security.test.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `__tests__/authority-mode.matrix.test.ts`, `__tests__/delegated-audience.matrix.test.ts`, `__tests__/broker-selection.test.ts` and `adapters/__tests__/unwired-defaults.test.ts`. Nothing is deleted in this phase.

### Phase 3: Capability authority and delegation establishment (depends on Phase 2)

- Build `run-custody-cell.ts` (`createRunCustodyCell`) with `run-custody-cell.test.ts`. Build `capability-authority.ts` (Component Design › Capability Authority, with the cache key ADT), which replaces `keycloak-broker.ts` when the Phase 4 cut-over switches host.ts. Write its property test, including the concurrent-capabilities interleavings. The cache key ADT is encoded to the string `token-cell.ts` already takes, so `token-cell.ts` is unchanged, and `token-cache.test.ts` changes with it; the legacy `cacheKey` stays for `keycloak-broker.ts` until the legacy deletion. Migrate the non-legacy importers of `capability-scope.ts` (`graph-capability.ts`, `config.ts` scope validation) to the catalog; the file itself goes in the Phase 4 legacy deletion. Extend `broker-audit.ts`, updating the legacy broker's call in the same Task (Phase boundary rule). Add `gateAdmitted` to `capability-gate.ts` with its `capability-gate.test.ts` cases (a new export: the legacy `decideGate` is untouched). Extend the INV-2 matrix test with `capability-authority.ts`.
- Build `delegation-establishment.ts` (`establishDelegation`, AD-6), `domain/custody-release.ts` (`releaseCauseOf`) with its property test, and the INV-4 owner `run-authority-lifecycle.ts` (`createRunAuthorityLifecycle` over the capability authority, with `AuthorizedRun`'s module-private constructor and `mintingAuthorityOf`; Component Design › Delegated Custody). Write `run-authority-lifecycle.test.ts`, and `__tests__/run-authority-lifecycle.matrix.test.ts` with the owner rows: establishment failed with a failed or an ambiguous `put`, body rejection, persist failure, failing delete, one handle per bracket. The sibling rows wait for the Phase 4 cut-over, which builds the siblings' calls.
- Build `run-authority-admission.ts` (`createRunAuthorityAdmission`) and `run-authority-wiring.ts` (`composeRunAuthorityWiring`, `RunAuthorityWiring`, `IdentityTransports`; Component Design › Run Admission), the only production composition of the identity subsystem. Add the establishment row to `__tests__/delegated-audience.matrix.test.ts` (INV-5). CT-2 acceptance takes its minting handles from the wiring's lifecycle bracket, so it lands in this phase with the mint path.
- Create `acceptance/support/credential-sentinel.ts`. This phase answers for FR-022 on the mint path (CT-2's sentinel assertions: logs, audit, spans, errors, handles, custody re-sealed on rotation) and for the NFR-002 budgets (`capability-authority-budget.acceptance.test.ts`): both CT-2 acceptance files run through `composeRunAuthorityWiring` and must be green at this phase's Wave Gate, so a leak or a budget miss is found while the mint path is being built.
- **Run-composition extraction Task** (signature-preserving; independent of this phase's other Tasks, so it may take the first Wave). Move `createRunContextFactory`, `createDagExecutor`, `composeHitlRunService`, `createHitlExecutor`, `syncRunOptions`, `HitlWiringArgs` and the host-local `RunAuthority` record the first two take (renamed `LegacyRunBroker`, freeing the CT-1 name; the cut-over deletes it) from host.ts into `adapters/run-composition.ts`, which imports no boot code. host.ts imports them back, and the two test importers of `syncRunOptions` (`fan-cap-wiring.test.ts`, `integration/mapped-host-composition.test.ts`) change their import in the same Task; the existing suites pin the behaviour.
- **Files:** `host.ts`, `adapters/run-composition.ts`, `__tests__/fan-cap-wiring.test.ts`, `__tests__/integration/mapped-host-composition.test.ts` (extraction Task); `adapters/run-custody-cell.ts`, `adapters/capability-authority.ts`, `adapters/keycloak-broker.ts` (legacy importer updates only), `adapters/broker-audit.ts`, `adapters/graph-capability.ts`, `domain/capability-gate.ts`, `domain/__tests__/capability-gate.test.ts`, `domain/token-cache.ts`, `domain/__tests__/token-cache.test.ts`, `domain/config.ts`, `adapters/delegation-establishment.ts`, `domain/custody-release.ts`, `adapters/run-authority-lifecycle.ts`, `adapters/run-authority-admission.ts`, `adapters/run-authority-wiring.ts`, `__tests__/acceptance/support/credential-sentinel.ts`, their tests, `__tests__/authority-mode.matrix.test.ts`, `__tests__/run-authority-lifecycle.matrix.test.ts` and `__tests__/delegated-audience.matrix.test.ts`

### Phase 4: Run-start cut-over: admission, HITL establishment and composition (depends on Phase 3)

This phase switches the run-start path to the run authority. The Phase boundary rule forbids splitting `HitlRunService.startRun`, `HitlRunServiceDeps` and `RunExecutorDeps` from their production callers (`run-dag.ts` and the host.ts HITL composition), so the switch is one Task, kept as small as the rule allows: the composition move is already done (Phase 3), the additive Tasks precede it and the legacy deletion follows it.

- **Additive Tasks.** These change no signature that has a caller outside the Task, so decompose may place them in an earlier Wave of this phase than the cut-over:
  - `http/delegated-token-header.ts` (`parseDelegatedTokenHeader` → `DelegatedHeader`) with its test.
  - The `run-authority-refused{refusal}` HostError, together with every exhaustive matcher of `HostError` in the same Task: its status table (one status per `RunAuthorityRefusal` kind, `capability-unknown` 503 included), `discloseHostError`, snapshot entries, and `http/middleware/error-handler.ts`'s `rawDetailsFor`.
- **The cut-over Task: one Task, one Wave.** Every coupled signature changes together with every production caller and every fixture that constructs it:
  - `http/handlers/run-dag.ts` (Component Design › Run Admission): two-pass admission before the HITL fork and `acquire`; the HITL branch calls `startRun(admitted, input)`, the sync branch makes one `withEstablishedAuthority(admitted, …)` call. `RunDagDeps` gains `admitRunAuthority` (returning the `AdmittedRun` or an `AdmissionRefusal`) and `runAuthority`; `createContext` takes a `RunAuthority` and `executeDag` the bracket's `AuthorizedRun`.
  - `hitl/service.ts` (Component Design › HITL Authority Continuity): one `establishForRecord` call in `startRun(admitted, input)`, the `ProcessRunOutcome` fold and one `endRun` call in `processRun`; `HitlRunServiceDeps.runAuthority` is the narrowed lifecycle and `HitlRunServiceDeps.newRunId` is removed.
  - `hitl/types.ts`, `hitl/ports.ts`, `hitl/identity.ts`, `hitl/adapters/run-store.ts`: `RunRecord.authority` replaces `RunRecord.identity` and `RunExecutionRequest.authority` replaces its `identity`, both the `BoundAuthority` the record parse builds (File Structure › `run-store.ts`); `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are deleted, and `approverTeamIdentity` stays.
  - `hitl/adapters/run-executor.ts`: `RunExecutorDeps.broker` becomes `runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority">`, and each slice runs in one `withRecordedAuthority(req.authority, body)` call and mints through `mintingAuthorityOf(run, meterLlm)`.
  - `adapters/node-context-factory.ts`: `NodeContextForDag{ctx, authority, meterMintedLlm}`, with no origin. The unmapped-DAG throw is removed.
  - `host.ts`: one `composeRunAuthorityWiring` per host over the boot-loaded catalog and `HostDeps.identityTransports` (fetch-based by default), returning `identity-config-invalid` on its faults and feeding `buildRouterDeps` and the HITL composition. In `adapters/run-composition.ts`, `createRunContextFactory(config, sharedInfra, routedTenant)`, `createDagExecutor(config)` and `HitlWiringArgs.runAuthority` (replacing `broker`) change with this caller, and `LegacyRunBroker` goes. host.ts's `selectCapabilityBroker` and `selectRunAuthority` are removed; `HostDeps.capabilityBroker` removed, `HostDeps.identityTransports` added. After this Task no production module imports the legacy broker path.
  - Tests and fixtures (found by searching for `createRunDagHandler`, `createNodeContextForDag`, `createRunExecutor`, `startRun(`, `capabilityBroker`, `identity: {` and `ownerTeam:`):
    - rewrites of `broker-selection.test.ts`, `entrypoint-wiring.test.ts`, `full-lifecycle.test.ts` T8, `node-context-factory.test.ts` and `run-executor.test.ts`
    - `RunDagDeps`, `startRun`, executor and record fixtures: `__tests__/handlers/run-dag.test.ts`, `__tests__/handlers/hitl-http.test.ts`, `__tests__/integration/mapped-host-composition.test.ts`, `__tests__/integration/dag-isolation.test.ts`, `__tests__/integration/mapped-process-resume.test.ts`, `__tests__/fixtures/mapped-resume-worker.ts`, `hitl/__tests__/service.test.ts`, `hitl/__tests__/service-admission.test.ts`, `hitl/__tests__/identity.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts` and `hitl/adapters/bot/__tests__/bot.test.ts`
    - new `handlers/run-dag-authority.test.ts`, `adapters/__tests__/run-composition.test.ts` and `boot-identity-refusal.test.ts` (AS-013, AS-033, NFR-020 at `createHost`)
    - all three INV-4 sibling rows (route, HITL service, HITL executor) in `run-authority-lifecycle.matrix.test.ts`

  It stays one Task on purpose: any split leaves a Wave in which `startRun`, the HITL deps, the executor deps, the execution request or the record schema disagree with a caller. Splitting the route's sync and HITL branches was rejected: both share admission and `NodeContextForDag`, so a host composing both brokers and a second `NodeContextForDag` shape (a shim) would be needed.
- **Legacy deletion Task** (after the cut-over; deletes only modules nothing outside the legacy path imports): `keycloak-broker.ts` and `domain/auth.ts`'s `agentClientIdFromFrameworkOrigin`, `keycloak-token-endpoint.ts`, `keycloak-token-endpoint-http.ts`, `unwired-token-endpoint.ts`, `entra-wif.ts`, `unwired-entra-wif.ts`, `capability-scope.ts` and their tests (`domain/__tests__/capability-scope.test.ts` included), the catalog `decideGate` with its `unknown` arm and its `capability-gate.test.ts` cases, the legacy `cacheKey` in `token-cache.ts` with its `token-cache.test.ts` cases (`compositeKey` stays if `cacheKeyOf` uses it), `unwired-defaults.test.ts`'s legacy rows, and the comments citing them (`domain/config.ts`, `hitl-transport-selection.test.ts`, `full-lifecycle.test.ts`).
- This phase answers for the NFR-003 budget and for FR-022 at run start and on the `app` execution path. These must be green at this phase's Wave Gate:
  - CT-1 acceptance, including AS-037's sentinel assertions, the proxy forwarding cases and the zero-JWKS static refusals
  - the CT-1 budget file (`run-authority-admission-budget.acceptance.test.ts`, AS-036)
  - CT-4 acceptance (`user-run-attribution.acceptance.test.ts`), including AS-039

  Decompose assigns CT-1's and CT-4's Requirements to the cut-over Task.
- CT-3 acceptance also needs the approval path (AS-028), which Phase 5 builds, so decompose assigns CT-3's Requirements to the Phase 5 approvals Task.
- **Files:** `http/delegated-token-header.ts`, `domain/host-error.ts`, `http/middleware/error-handler.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `http/handlers/run-dag.ts`, `hitl/types.ts`, `hitl/ports.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/run-executor.ts`, `adapters/node-context-factory.ts`, `domain/run-context.ts`, `host.ts`, `adapters/run-composition.ts`, `adapters/__tests__/run-composition.test.ts`, `__tests__/broker-selection.test.ts`, `__tests__/entrypoint-wiring.test.ts`, `__tests__/integration/full-lifecycle.test.ts`, `__tests__/node-context-factory.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`, the fixtures listed in the cut-over Task, `__tests__/handlers/run-dag-authority.test.ts`, `__tests__/run-authority-lifecycle.matrix.test.ts`, `__tests__/boot-identity-refusal.test.ts`, the CT-1 and CT-4 acceptance files; legacy deletion: the files its Task names

### Phase 5: Approvals and manifest (depends on Phase 4)

- **Approvals Task.** `RunRecord.approvals` and its run-store schema, and `ApproverRef` and `ApprovalRecord` (with `atMs: EpochMs`), declared in `hitl/types.ts`. `recordDecision(…, approver: ApproverRef)` changes in the same Task as its two production callers (Phase boundary rule):
  - `createApproveRunHandler` (`http/handlers/runs.ts`) derives the `ApproverRef` from the middleware-built `AuthIdentity`.
  - `handleBotActivity` (`hitl/adapters/bot/messages-handler.ts`) derives `teams-user{aadObjectId}` from the `TeamsApprover`.

  It also adds the approver mapping in `hitl/identity.ts`, the `hitl-decision` audit record and `approver-authority.test.ts`. Every `RunRecord` fixture and every `recordDecision` caller in tests changes in the same Task: `hitl/__tests__/service.test.ts`, `__tests__/handlers/hitl-http.test.ts`, `hitl/adapters/bot/__tests__/bot.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts` and `__tests__/fixtures/mapped-resume-worker.ts`. This phase answers for FR-022 across continuation: CT-3 acceptance (`delegated-continuation.acceptance.test.ts`), including AS-038's sentinel assertions and the custody-expired versus custody-absent cases, must be green at this phase's Wave Gate. Decompose assigns CT-3's Requirements to this Task.
- **Manifest Task.** The manifest authority block over the boot-loaded catalog and `delegatedAudienceFor`; each DAG's requirements go through `classifyCapabilities`, so a DAG with an unknown capability publishes the `capability-unknown` requirements it would be refused for instead of a mode. Its handler deps change in the same Task as their host.ts `buildRouterDeps` caller and the existing `__tests__/handlers/manifest.test.ts`. Extend the INV-2 matrix test and the INV-5 matrix test (`delegated-audience.matrix.test.ts`) with `manifest.ts`, and write `manifest-authority.test.ts`.
- **Files:** `hitl/types.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `http/handlers/runs.ts`, `hitl/adapters/bot/messages-handler.ts`, `http/handlers/manifest.ts`, `host.ts`, `hitl/__tests__/approver-authority.test.ts`, the record and `recordDecision` fixtures listed in the approvals Task, `__tests__/handlers/manifest.test.ts`, `__tests__/handlers/manifest-authority.test.ts`, `__tests__/authority-mode.matrix.test.ts`, `__tests__/delegated-audience.matrix.test.ts`, and the CT-3 acceptance file

### Phase 6: Documentation (depends on Phase 5)

- No trailing verification Task. The SC-011 budgets are CT-2 and CT-1 acceptance files gated in Phases 3 and 4. The SC-007 / FR-022 sentinel assertions are part of the contracts' acceptance: CT-2 in Phase 3, CT-1 and CT-4 in Phase 4, and CT-3 in Phase 5. So a leak is found in the Wave that builds the surface.
- Rewrite `packages/host/docs/auth.md`, `docs/team-security-and-capabilities.md`, the provisioning runbook (both models, RBAC for Applications, Agent ID spike pass/fail, fallback selection, rollback, rotation, realm-before-host deploy order, broker-token purge) and spike #4. Add the new evidence template, `data-handling.md` and the sequence-diagram doc. Update the CONTEXT.md identity table and terms.
- Add `scripts/check-identity-docs.ts` with tests, wired into `scripts/verify.sh`.
- **Files:** `packages/host/docs/auth.md`, `packages/host/docs/data-handling.md`, `packages/host/docs/identity-chain-sequence.md`, `docs/team-security-and-capabilities.md`, `docs/runbooks/entra-fugue-agents-provisioning.md`, `docs/runbooks/identity-live-verification-evidence.md`, `docs/spikes/2026-06-10-spike-4-identity-chaining-e2e.md`, `CONTEXT.md`, `scripts/check-identity-docs.ts`, `scripts/__tests__/check-identity-docs.test.ts`, `scripts/verify.sh`

---

## Testing Strategy

Canonical homes: per-file unit, integration and property obligations are the test-file entries in File Structure; acceptance obligations are the CT statements; owned-invariant matrices are INV-2, INV-4 and INV-5. Fakes exist for every port.

- **Property tests** use fast-check: the `*.property.test.ts` files, `authority-unavailable-error.test.ts`, `federated-assertion.test.ts`, `entra-user-token.test.ts`, `redacted-secret.test.ts` and the three matrix tests over generated catalogs and directories. The token-endpoint classifier and the fault projections are property-tested once, in `domain/__tests__`.
- **Integration over fakes:** the JWKS transport is the verifier's seam (no port). `hitl/adapters/__tests__/redis-stores.test.ts` also round-trips a persisted authority, its access included.
- **Acceptance:** CT-1 to CT-4 over the production composition, with CT-3 resuming after the inbound tokens expire (SC-006) by `setSystemTime`; the FR-022 sentinel assertions in CT-2 (Phase 3), CT-1 and CT-4 (Phase 4) and CT-3 (Phase 5) through `credential-sentinel.ts`.
- **Boot refusals** (AS-009, AS-013, AS-033) have no run-time contract path and are decided by `boot-capability-catalog.test.ts` and `boot-identity-refusal.test.ts` in the phases that build them; FR-005's compile and boot faces by its `@ts-expect-error` and AS-009 tests, and its run-time face (no capability acts without an admitted mode after resume) by CT-3.

**Latency budget tests (NFR-002, NFR-003, SC-011).** The budgets are CT-2 (Phase 3) and CT-1 (Phase 4) acceptance files, gating the phases that build the code they constrain. Both use `acceptance/support/latency-budget.ts`: every realm, Entra and JWKS transport is an injected fake that resolves at once, so the measured time is host-added only; 50 discarded warm-up iterations (JIT, the first `lazyJwks` fetch that NFR-003 excludes, WebCrypto key import); then 500 timed samples with `performance.now()`; nearest-rank p95 compared with the budget and printed for the evidence template. Cold-acquisition samples each use a fresh `composeRunAuthorityWiring` built outside the timed region (so the custody key import is not timed and no cell is warm); cache-hit samples reuse one warmed cell and assert zero transport calls (NFR-001). The expected host cost is well under 1 ms per acquisition and a few ms per admission, so the 10, 5 and 50 ms budgets leave an order of magnitude of headroom for a loaded CI runner while still catching an accidental network call, a synchronous key derivation per call, or an uncached JWKS fetch. Loom accepts only FR and AS ids as acceptance anchors, so the budgets are anchored on AS-035 (NFR-002) and AS-036 (NFR-003), which restate the NFRs' automated-suite clauses. Testcases are named after the scenario they decide (`AS-035: cold host-added acquisition ≤ 10 ms p95 (agent-id, app)`, `AS-035: cache hit ≤ 5 ms p95, zero transport calls`, `AS-036: run-start validation ≤ 50 ms p95 through proxyToWorker`).

### Acceptance seam sweep

Every acceptance-decided Requirement was traced along its production path (CT statements, Data Flow) under the runtime-seam rule (Component Design › Run Admission); the declared seams are the CT lists. Fakes are allowed only at the network (`IdentityTransports`, the realm signature verifier, the Bot Framework token verifier), storage (`RedisPort`, `HitlRedisPort`, `QueueBackend`), notification and clock edges, plus recording observation points for deps whose behaviour another contract decides.

Symbols on every path that are not declared, and why they cannot be bypassed:
- Built only inside `composeRunAuthorityWiring`: `requirementsOf`, both admission passes and the binding, `planAuthorityLegs`, the mint and Entra adapters, the custody cipher and store, `establishDelegation`, `createCapabilityAuthority`, `createRunAuthorityLifecycle`. `forRun` is reachable only through the lifecycle it returns; `createRunCustodyCell` is called only inside `forRun`; `beginRedeem` and `decideRedeemStep` are static imports of the cell, `releaseCauseOf` of the lifecycle, `establishFaultOf` of `establishDelegation`.
- Built only inside `composeHitlRunService`: `createHitlRunService`, `createRunExecutor`, `createRedisRunStore`, `createRedisDecisionStore`, `createRunQueue`; `recordDecision`, `settleRunOutcome` (HITL completed, failed and rejected) and the `processRun` fold are inside the composed service.
- Static imports below a declared seam: `invocationFor` and `brokerAuditPayload` below the capability authority (CT-3, CT-4); `routeRequirement`, `gateAdmitted`, `inspectFederatedAssertion` and `token-cache.ts` inside the capability authority (CT-2, CT-3); `mintingAuthorityOf` inside `createDagExecutor` and `createRunExecutor`; `parseRunAccess` inside the run store (CT-3); `createNodeContextForDag` inside `createRunExecutor` and `createRunContextFactory` (CT-3).

| Contract | Requirements | Contract-specific notes |
|---|---|---|
| CT-1 | AS-010, AS-021, AS-022, AS-023, AS-037, FR-006 to FR-009, FR-036 | `parseDelegatedTokenHeader`, `hostErrorResponse`, `discloseHostError` and the refusal status table: static imports of the handler. `verifyEntraUserToken`: a static import of `createRunAuthorityAdmission`, which only the wiring builds; it has no port, and its JWKS transport is the faked network edge. `createRouter`: path-to-handler wiring with no identity logic; the in-process worker mounts the middleware and handler in its order |
| CT-1 | FR-018 (admin and team tokens → `agent` or `unbrokered` plan) | team-token store lookup: unchanged behaviour, already covered by the middleware suite; the acceptance asserts the admitted authority |
| CT-1 | AS-036 | none: the same five seams, so the budget measures the production admission |
| CT-2 | AS-001 to AS-005, AS-011, AS-012, FR-001 to FR-003, FR-011 to FR-015, FR-021, FR-022; delegated path AS-024, AS-025, FR-010; AS-035 (same three seams, fresh wiring per cold sample) | the RunAuthority to MintingAuthority hop is CT-4's |
| CT-3 | AS-007, AS-008, FR-016; AS-020, AS-026, FR-017; AS-028, FR-025; AS-034; AS-027, AS-038, FR-023; FR-005 (resume with a changed DAG) | Bot Framework token verification: a network trust edge, faked as a `VerifyBotToken` |
| CT-4 | AS-006, AS-039, FR-004, FR-020 | `createNodeContextForDag` is declared although `createRunContextFactory` imports it, because CT-4 also calls it directly on a `user-app` authority |

The FR-022 scans (CT-2 FR-022, CT-1 AS-037, CT-3 AS-038, CT-4 AS-039) read only the `credential-sentinel.ts` captures of the production path (File Structure), so a scan cannot pass by observing a path production does not take.

### Plan self-audit

Self-audit: see `plan-history.md#self-audit-design-review-loop-back-9` (the loop-back 4 to 8 audits precede it there); all rows pass. The **Phase boundary rule** it audited is binding on decompose and implementers and lives in Implementation Phases.

Rules applied at several sites but deliberately not owned, each with its reason, are in the OWN rows of the `plan-history.md` self-audits.

---

## Security & NFR Notes

- **Trust boundaries:** the realm JWT is verified by the existing verifier; the Entra user token against Entra's JWKS for the configured tenant only, with issuer, tenant, audience, `scp`, version, `exp`/`nbf` and RS256 pinned; binding is an equality check on `oid` and `tid`; the minted realm assertion is inspected, not trusted, before Entra egress.
- **Fail closed (NFR-010):** every leg, mode and model gap is a boot refusal or `authority-unconfigured`; no path falls back from `delegated` to `app`; an unmapped DAG on a brokered host is a typed refusal, no longer a throw; a capability the catalog does not declare is refused at admission (`capability-unknown`), so none reaches the mint path with an assumed mode; and a brokered-namespace requirement outside the run's admitted `access` is refused at the mint path (`capability-not-admitted`), so a DAG changed while a run is suspended cannot widen it.
- **Credential hygiene (FR-022, INV-3):**
  - The user token is a `RedactedSecret` (`domain/redacted-secret.ts`: renders `[redacted]` under every serialisation; three `revealSecret` callers).
  - Refresh credentials exist in plaintext only inside `custody-cipher.ts` calls; custody records hold only ciphertext whose AAD is derived from the `RunAuthority`, so a replayed record fails to open (Component Design › Delegated Custody).
  - Custody is capped at `DELEGATED_CUSTODY_MAX_SEC`, default min(604800 s, `HITL_RUN_TTL_SEC`) = 7 days with default keys, never above `HITL_RUN_TTL_SEC`, never unbounded.
  - Acquisition faults carry no free text (`unreachable` holds the closed `UnreachableCause`), so no response body or credential reaches an error value through a fault.
  - FR-022 is decided per building phase by the sentinel assertions in CT-2 (Phase 3), CT-1 and CT-4 (Phase 4) and CT-3 (Phase 5) acceptance.
- **No probe surface before refusal:** the Entra JWKS is fetched only for a submission that pass 1 cannot refuse statically, so a team token, an unexpected header or a dark leg never triggers egress to Entra's key endpoint.
- **Blast radius (NFR-011):** one blueprint, or one fallback app set, per deployment. Custody keys are per deployment and per tenant worker, held by the worker only (boundary A); rotation: Component Design › Delegated Custody.
- **Supervisor UDS proxy:** forwards `X-Fugue-Delegated-Authorization` unchanged and strips only `X-Fugue-Tenant` (Component Design › Run Admission); CT-1 asserts the header arrives byte-identical, a client-forged tenant header never reaches the worker, and no proxy log line carries the token.
- **Deploy order:** the realm (with `entra_oid` and `entra_tid` claims) must deploy before the host, because the host 401s realm user JWTs without them. The runbook states this.
- **Performance:** app cache hits make no network call (NFR-001); delegated cells are scoped to the run; JWKS sets are cached by `lazyJwks` (NFR-003); single-flight is per cell key (NFR-012); there are no internal retries (NFR-021).
- **Retention (FR-024):** `oid` and `tid` follow the existing run and audit retention. This is documented in `data-handling.md`.

---

## Verification

1. `bun run --cwd packages/framework typecheck && bun run --cwd packages/host typecheck`
2. `bun run --cwd packages/framework test` and `bun run --cwd packages/host test`: all green. The admin and team token tests are unchanged (SC-010).
3. `bun test packages/host/src/__tests__/acceptance/`: CT-1 to CT-4 green.
4. `bun scripts/check-doc-links.ts && bun scripts/check-identity-docs.ts`
5. `bun "/home/peterstorm/.dotfiles/.claude/local-marketplace/plugins/loom/engine/src/cli.ts" helper validate-lint-rules`, then the full-tier lint: INV-1 has zero hits.
6. The SC-011 budgets are part of step 3: `capability-authority-budget.acceptance.test.ts` and `run-authority-admission-budget.acceptance.test.ts` print their p95 values and fail above 10/5 ms and 50 ms.
7. Realm repo: the Maven tests in the Cross-Repo section pass. Live-tenant verification is the operator's job, using `docs/runbooks/identity-live-verification-evidence.md` (OOS-001).

**Operator prerequisites before Tasks are populated.** `.loom/verification-manifest.json` is schema 1 today. Two things need it upgraded:
- INV-2, INV-4 and INV-5 (owned, with mutation verification) need schema 2 with an `affectedRunner`.
- The four contracts need a JUnit-reporting test check.

Before Loom populates this plan, the operator must:

1. Set `"schemaVersion": 2`.
2. Add an `affectedRunner`: `{"executable": "bun", "args": ["test", "--reporter=junit", "--reporter-outfile=.loom/completion-reports/affected.junit.xml", "{files}"], "cwd": ".", "timeoutMs": 240000, "report": {"kind": "required-file", "path": ".loom/completion-reports/affected.junit.xml"}}`
3. Add an `acceptanceRunner` of the same form over `{files}`, reporting to `.loom/completion-reports/acceptance.junit.xml`.
4. Add a wave check `project:identity-acceptance`: `bun test packages/host/src/__tests__/acceptance --reporter=junit --reporter-outfile=.loom/completion-reports/identity-acceptance.junit.xml` with a `required-file` report.
5. Add wave checks for `bun run --cwd packages/host typecheck` and `bun run --cwd packages/framework typecheck`. The full host suite stays as `bun run --cwd packages/host test`, because `signals.test.ts` must run isolated.

---

## Cross-Repo Realm Work (executed outside the task graph)

This section is executed by the operator or a separate session in the worktree `/home/peterstorm/dev/java/keycloakConfigAsCode-agent-identity` (branch `feat/fugue-agent-identity`), never in `/home/peterstorm/dev/java/keycloakConfigAsCode`. No Fugue task depends on it. Fugue tasks code against the claim names and grant semantics below, and test them with fakes. Package root: `java-configuration/src/main/java/dk/secondbrand/keycloak/configuration/fugueplatform/`. Tests: `java-configuration/src/test/java/dk/secondbrand/keycloak/configuration/fugueplatform/`. The style is functional: pure `Optional<String>` violation functions in the `*Checks` classes, the `dk.oister` `Either` at the boundary, and jqwik property tests.

### Interface contract with the host (fixed by this plan)

| Item | Value |
|---|---|
| User access token claims (frontend clients) | `entra_oid` (string, Entra object id), `entra_tid` (string, Entra tenant id); always present for Entra-brokered users |
| Agent mint | client_credentials with `scope="entra-exchange <capability>"`; `entra-exchange` adds `aud=api://AzureADTokenExchange` (existing `ENTRA_EXCHANGE_AUDIENCE`); no other audience on agent assertions |
| Unassigned optional scope | `invalid_scope` (or omission), which the host treats as a missing grant |
| Agent clients | `standard.token.exchange.enabled=false`; client_credentials only |
| Broker tokens | `azuread` IdP `storeToken=false` |

### R1: Entra object id and tenant into user tokens (FR-030, AS-015)

- `steps/AzureIdpStep.java`: add two attribute-importer mappers through `IdpPlanBuilder.attributeImporterMapper`, with `forceSync()`: claim `oid` → user attribute `entra_oid`, and claim `tid` → user attribute `entra_tid`.
- New `steps/UserProfileStep.java`: declare `entra_oid` and `entra_tid` in the realm user profile (`PUT /admin/realms/{realm}/users/profile`), with `view: [admin, user]` and `edit: [admin]`. Users cannot forge binding attributes through the account console. Merge into the existing profile config by attribute name, which is idempotent.
- `FuguePlatformConstants.java`: add `ENTRA_OID_ATTRIBUTE`, `ENTRA_TID_ATTRIBUTE`, `ENTRA_IDENTITY_SCOPE = "fugue-entra-identity"` and the claim names.
- `steps/ClientScopesStep.java`: create the `fugue-entra-identity` client scope with two `oidc-usermodel-attribute-mapper` protocol mappers (attribute → claim, access token only, `String`). New model record `EntraIdentityClaimMapper.java` beside `AudienceMapper.java`.
- `steps/ClientStep.java`: assign `fugue-entra-identity` as a default client scope on every `FrontendSso` client, and never on an `AgentServiceAccount`.

### R2: No user exchange in the realm (FR-031, AS-016)

- `FuguePlatformClient.java`: both variants carry `standardTokenExchangeEnabled = false`. `ClientStep` pins the attribute `standard.token.exchange.enabled=false` on every Fugue client, as it already does for `pinFullScopeDisabled`.
- `steps/FuguePlatformClientChecks.java`: a pure `tokenExchangeEnabledViolation(ClientRepresentation) → Optional<String>` that names the client.
- `steps/ValidationStep.java`: run it for every Fugue client. Any violation fails with the client named.

### R3: Exact scope assignment and Entra-exchange placement (FR-032, AS-017)

- Keep `validateClientScopeAssignment` as an exact comparison. Report both missing and unexpected grants (default and optional), in two separate lists in the message.
- New pure checks in `FuguePlatformClientChecks.java`:
  - `entraExchangeOnFrontendViolation`: `entra-exchange` assigned, default or optional, to any `FrontendSso` client.
  - `agentAssertionAudienceViolation`: an agent client with any audience mapper other than through `entra-exchange`, or a capability scope that carries an audience mapper.
- `validateNoFugueScopesAreRealmDefault` also covers realm default-optional scopes for `entra-exchange` and `fugue-entra-identity` (the second must be a client default on frontends, never realm-wide).
- A missing `entra_oid`/`entra_tid` mapper on `fugue-entra-identity`, or a missing IdP importer mapper, is a validation failure (SC-005, "missing object id mapper").

### R4: Stop storing broker tokens (FR-035)

- `steps/AzureIdpStep.java`: replace `.storeTokens()` with `.dontStoreTokens()` and `.disableReadTokenRole()`.
- `steps/FuguePlatformAzureBrokerChecks.java`: `storeTokenViolation` fails when the `azuread` IdP has `storeToken=true`.
- Runbook note (Fugue side, Phase 6): purge previously stored broker tokens by deleting federated-identity token data, or force re-login.

### R5: Idempotent reconcile or explicit reject (FR-034, AS-018)

- Every step compares desired and actual state. A step updates in place when the object is reconcilable, and otherwise returns `Either.left(Violation)`, naming the object, for a pre-existing malformed client, scope or mapper. Examples of malformed: a mapper of the wrong type under an expected name, or a client with the wrong protocol. Nothing is silently skipped.
- Re-applying to a conforming realm makes zero admin writes. Assert this with the existing diff machinery (`diff/RealmDiffRunner`): the change set is empty.

### R6 (P3): Opt-in predictable service-account subject (FR-033, AS-019)

- `FuguePlatformRealmConfig.java`: add `predictableServiceAccountSubject: boolean`, default `false`.
- When it is on, `ClientStep` adds a hardcoded-claim protocol mapper on each `AgentServiceAccount` that emits `sub = "service-account-" + clientId` in access tokens. The `FuguePlatformClientChecks.predictableSubjectViolation` check verifies that the mapper exists with the derived value.
- The external integration test proves that Keycloak 26.8.2 emits the overridden `sub` on client_credentials. If it does not, the feature stays off, and the runbook records that FICs are created after the client exists.

### Types

- `EntraIdentityClaimMapper` (record: name, userAttribute, claimName)
- `UserProfileAttribute` (record: name, viewRoles, editRoles)
- `Violation` (record: subject, message), used by every new check
- `FuguePlatformClient` variants extended with token-exchange pinning
- `FuguePlatformRealmConfig` extended with `predictableServiceAccountSubject`

### Tests

- `steps/FuguePlatformClientChecksTest.java`: jqwik properties. Each new check returns a violation iff its seeded misconfiguration is present, and the violation names the offender.
- `steps/FuguePlatformAzureBrokerChecksTest.java`: `storeToken` and the importer-mapper checks.
- `FuguePlatformRealmGoldenTest.java`: update `golden-realm-export-fugue-platform.json`. The export must be byte-identical on re-apply.
- `FuguePlatformRealmExternalIntegrationTest.java` (`-DEXTERNAL_INTEGRATION_TESTS=true`):
  - A frontend user token carries `entra_oid` and `entra_tid`.
  - An agent mint with `scope="entra-exchange msgraph:mail.send"` yields `aud` = exactly `api://AzureADTokenExchange` with both scopes.
  - An unassigned scope yields `invalid_scope` or an omitted scope (the observed behaviour is recorded in the runbook).
  - Token exchange is refused for agent clients.
  - Re-apply makes zero changes.
  - With R6 on, `sub` is predictable.

### Acceptance

- `mvn -pl java-configuration test` passes, and the external integration test passes against a local Keycloak 26.8.2.
- Every SC-005 seeded misconfiguration is detected:
  - token exchange on an agent
  - `entra-exchange` as a realm default or on a frontend
  - a missing object id mapper
  - an unexpected or missing scope grant
- The golden export is updated, and re-apply makes zero changes.

---

## Change Log

History, per-loop-back detail and the self-audits: `.claude/specs/2026-11-24-agent-identity-redesign/plan-history.md` (loop-back 7 condensed this plan losslessly for the review read budget; no design change).

- 2026-11-24, initial plan and loop-back 1 (alignment): Approach A; budgets as CT-2/CT-1 acceptance (AS-035/AS-036); owned custody release (INV-4); proxy and approval seams.
- 2026-11-24, loop-back 2 (alignment): AS-006, FR-004, FR-020 move to the new CT-4 through the exported host.ts factories.
- 2026-11-24, loop-back 3 (alignment): seam sweep; `composeRunAuthorityWiring` and `composeHitlRunService` as the only compositions.
- 2026-11-24, loop-back 4 (alignment): FR-017 cap defaults, boot catalog (AS-009), per-contract FR-022 scans, per-leg gating, INV-5.
- 2026-11-24, loop-back 5 (design review 1): Phase 4 cut-over and Phase boundary rule; two-pass admission; run-authority lifecycle; one fault vocabulary.
- 2026-11-25, loop-back 6 (design review 2): `TeamsApprover`, `decideRedeemStep`, three-state LC-1, sole `forRun` caller, fault subsets, `capability-unknown`.
- 2026-11-25, loop-back 8 (design review 3): establish guard in production; `AuthorizedRun` and legs ADTs; progress-indexed redeem; `AdmittedRun`; no run id on the authority; planner-resolved `access`; `run-composition.ts`; `releaseCauseOf`.
- 2026-11-25, loop-back 9 (design review 4): fail-closed `routeRequirement` (`capability-not-admitted`); admission-scoped ordering; `BoundAuthority`; branded `AuthorizedRun`; name-keyed `RunAccess`; refusal subsets; extraction and legacy deletion split from the cut-over; approver types out of CT-3.
