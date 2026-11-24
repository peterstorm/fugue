# Plan: Agent Identity Redesign (per-agent Entra identity, per-capability authority mode)

**Spec:** .claude/specs/2026-11-24-agent-identity-redesign/spec.md
**Created:** 2026-11-24
**Spec ids:** the architecture phase renumbered three non-canonical ids so the spec parses: AS-013a is AS-033, AS-026a is AS-034, FR-019a is FR-025.

## Summary

Only an agent's own identity federates into Entra. The host requests every realm assertion with `entra-exchange <capability>`. It hands that assertion to a model-polymorphic `EntraAgentAuthority` port, with one adapter for Entra Agent ID (blueprint plus agent identity) and one for per-agent app registrations. Each capability declares `app` or `delegated` in one typed catalog that has no default. A pure run-start planner turns the caller's identity, the DAG's requirements and the catalog into a `RunAuthority` before the HITL fork or a concurrency slot. A boot-scoped `CapabilityAuthority` hands each run a broker bound to that `RunAuthority` (`forRun`), which replaces the process-global subject-token registry and the RFC 8693 user exchange; both are deleted. Delegated mode does one on-behalf-of exchange at admission. It then keeps only the run-bound refresh credential, AES-256-GCM sealed under a typed custody lifecycle (LC-1), and deletes it at every terminal state. The realm changes in the Keycloak config-as-code repository are specified in their own section and run outside the task graph.

> **Decided under explicit user delegation.** The user said: "im gonna go to bed, you just run the whole loom workflow please, and during interview, just pick the most correct, best, most functional approach, for all questions ok". Earlier the user also said "I want the most correct solution to the agent auth problem" and "we can change config code as well of course, to make it fit". No interview was held. The answers below are the architect's, and each is logged in `clarifications/log.md` under "Architecture phase decisions" for the user to review.

---

## Self-Interview (architecture questionnaire, answered under delegation)

| # | Topic | Answer |
|---|---|---|
| 1 | Scope and slicing | Everything in the spec is built: P1 (agent path, `app` mode, per-agent identity, docs) and P2 (`delegated` mode, continuation). The FR-033 realm hardening (P3) is specified for the realm repo. Phases follow dependency order, not priority, because delegated mode reuses every P1 seam. |
| 2 | Where the authority mode lives | In one code-defined `CAPABILITY_CATALOG`. The `satisfies` clause requires the `authority` field, so a capability without one does not compile. `parseCapabilityCatalog` is the only producer of the branded `CapabilityCatalog`, and it refuses boot on data input with a fault that names the capability. No data-sourced catalog exists today; the boot composition still takes the catalog as an input, so SC-013 is testable with data. |
| 3 | Identity model selection | `ENTRA_IDENTITY_MODEL` is `agent-id` or `app-registration` and has no default. It parses into the `EntraDirectory` ADT, and the variant decides which adapter is built. Capability and DAG definitions never see the model (SC-008). |
| 4 | Boot-time strictness | No `ENTRA_*` keys means the leg is dark, with the existing warning (NFR-020). If any `ENTRA_*` key is set, the leg counts as configured and must be complete and consistent; otherwise boot is refused and every offender is named (AS-013, AS-033). This matches the existing paired-field refusals in `config.ts`. The removed `ENTRA_CLIENT_ID` is refused by name with a migration hint. |
| 5 | Where run-start validation happens | In `run-dag.ts`, after input-schema parsing and before `hitl.startRun` and concurrency `acquire`. The planner is pure; the only I/O before planning is verifying the Entra token against the JWKS, and only when the DAG needs delegation. |
| 6 | How the delegated user token arrives | In the `X-Fugue-Delegated-Authorization: Bearer <entra-jwt>` request header, next to the realm `Authorization` header. This follows the repository's `X-Fugue-*` naming. The supervisor UDS proxy already forwards headers it does not strip. The header is refused (400) on runs that need no delegation, so callers never send a bearer token that is not needed. The manifest publishes, per DAG, whether the header is required and which audience it must carry. |
| 7 | Binding the two tokens | The realm user JWT must carry `entra_oid` and `entra_tid`, which become required claims of `AuthenticatedUser`. The Entra token's `oid` and `tid` must equal them. The Entra token must also carry `scp`, which proves it is a delegated user token and not an app-only token. Its `tid` must equal the deployment tenant (OOS-005), and its `aud` must equal the expected delegated audience: the blueprint client id (agent-id model) or that agent's app id (app-registration model). |
| 8 | Delegated continuation | One on-behalf-of exchange with `offline_access` at admission, then run-bound custody of the refresh credential. The credential is AES-256-GCM sealed, with AAD = (runId, agentClientId, oid, tid, expiresAtMs) and a `kid` for rotation. Custody expiry is fixed at establishment as min(now + `DELEGATED_CUSTODY_MAX_SEC`, run deadline) and is never extended, including on rotation. Custody is deleted at every terminal state. |
| 9 | Key management | `DELEGATED_CUSTODY_KEYS` (JSON: `active` kid plus kid to base64 32-byte key) arrives through the worker secrets source and is never handled by the supervisor (boundary A). Rotation adds a kid and switches `active`; old kids stay until the custody max has elapsed. |
| 10 | Error taxonomy | A new framework kind `authority-unavailable{scope, agentClientId, cause}`, which is non-retriable, with the causes `federation-grant-missing`, `authority-unconfigured`, `federation-rejected` and `reauthorization-required`. Transient failures stay `infra-unreachable` and are not retried internally (NFR-021). Run-start refusals are a host `run-authority-refused` error carrying the frozen `RunAuthorityRefusal` ADT. |
| 11 | Caching and concurrency | App tokens use boot-scoped single-flight cells keyed by (Entra identity, `app`, capability). Delegated tokens use run-scoped cells keyed by (Entra identity, `delegated`, user oid, capability), which live inside the `forRun` closure and die with the run. Capability stays in the key so the realm, as the policy decision point, is consulted per capability (AD-5). |
| 12 | HITL approver vs initiator | Approval lends no authority. `recordDecision` takes a typed `ApproverRef`; the run record appends an `ApprovalRecord`, and a `hitl-decision` audit record names approver and initiator separately. After resume, the run rebuilds its `RunAuthority` only from the persisted record. |
| 13 | Testing and verification | Fakes for every port; fast-check property tests for the planner, the binding, catalog parsing, custody transitions and cache isolation; a sentinel-token scan (SC-007); and latency budget tests with injected transports (SC-011), which since alignment loop-back 1 are acceptance tests of CT-2 (acquisition, Phase 3) and CT-1 (admission, Phase 5). Live-tenant evidence belongs to the operator (OOS-001). |
| 14 | Executable models | One lifecycle (custody, LC-1). Invariants: the RFC 8693 prohibition (checkable), single-source authority mode (owned), no credential material in observable surfaces (advisory), and, since alignment loop-back 1, custody release at every terminal state (owned, INV-4). Three contracts. No Pipeline: this is not a fugue DAG feature. |

---

## Approach Gate

**Decided under explicit user delegation:** Approach A (recommended, and picked).

### Approach A: Run-bound authority (picked)

- **Shape:** a boot-scoped `CapabilityAuthority` core (caches, ports, catalog). `forRun(runAuthority)` returns a framework `CapabilityBroker` closed over the run's authority. A pure run-start planner produces `RunAuthority`. `EntraAgentAuthority` has two adapters. Delegation is established eagerly, then held in encrypted custody. The framework error taxonomy gains one kind.
- **Pros:**
  - No process-global mutable registry.
  - A run's authority is a value: persisted with the HITL record and rebuilt on resume.
  - Delegated caches die with the run.
  - Every refusal is a typed ADT decided before concurrency or the HITL fork.
  - The framework stays vendor-neutral (ADR-0054).
- **Cons:**
  - The run-start path (`run-dag.ts`, `host.ts`, `node-context-factory.ts`, `hitl/service.ts`, `run-executor.ts`) changes signature, so the change touches a broad surface.
  - The eager on-behalf-of exchange adds Entra latency to submitting delegated runs (budgeted in NFR-002: 2500 ms live).
- **Risk:** low. Every seam is injectable and testable with fakes.

### Approach B: Boot-scoped broker plus a process-global `RunAuthorityRegistry`

- **Shape:** keep one broker for the whole process. Store each run's authority, and for delegated runs the user token, in a map keyed by runId. Resolve it at mint time. Delegation is lazy (on-behalf-of at first use), forced eager only for HITL runs.
- **Pros:** fewer signature changes; it looks like today's subject-token registry.
- **Cons:**
  - Shared mutable state with bind and release discipline, which is exactly the class of bug the subject-token teardown tests exist for.
  - Lazy delegation holds the raw user token until first use, so the token outlives admission.
  - Two delegation timings, eager and lazy, mean two code paths to prove.
- **Rejected:** it violates immutability and lifetime-by-construction, and widens exposure of the user token.

### Approach C: Framework-native authority mode

- **Shape:** `requires` entries and `InvocationOrigin` carry the authority mode, and framework run-start preflight validates delegation.
- **Pros:** one place for the mode; reusable by other hosts.
- **Cons:**
  - It puts Entra and delegation concepts into the framework (ADR-0054 forbids vendor literals there).
  - The framework preflight runs after the host has acquired a concurrency slot, but AS-010 and SC-003 require refusal before acquisition.
  - The framework would still need host-only facts (the token binding, the custody store).
- **Rejected:** it breaks ADR-0054 and cannot meet the ordering that AS-010 requires.

---

## Architectural Decisions

### AD-1: Run-bound authority replaces the process-global subject-token side channel

**Choice:** A boot-scoped `CapabilityAuthority` with `forRun(run: RunAuthority): CapabilityBroker`. Each run's broker is a closure over an immutable `RunAuthority` value that admission produced (sync path) or that was rebuilt from the persisted run record (HITL path). The following are deleted outright (CONTEXT.md Key Invariant 8, no shims): `SubjectTokenRegistry`, `SubjectToken`, `markSubjectToken`, `subjectTokenForIdentity`, `exchangeV2`, `buildExchangeV2Body`, `TOKEN_EXCHANGE_GRANT_TYPE`, `inertResolveSubjectToken`, `withSubjectTokenRelease` and the `bindSubjectToken` option.
**Why:**
- A run's authority is a fact, not a resource to bind and release. As a value it cannot leak across runs.
- It persists with the HITL record (FR-016, FR-020) and needs no teardown discipline.
- FR-003 and FR-004 hold by construction, because no code path can reach a user token on an `app` run.
**Rejected:**
- A process-global `RunAuthorityRegistry` (Approach B): mutable shared state and release discipline.
- Keeping `exchangeV2` "for later": FR-003 forbids user exchange for every origin and mode.

### AD-2: Authority mode is part of the capability definition, in one catalog with no default

**Choice:** `domain/capability-catalog.ts` holds `CAPABILITY_CATALOG` (`as const satisfies Record<string, CapabilityDefinitionInput>`, where `authority: "app" | "delegated"` and `resource: "graph" | "dynamics"` are both required). `parseCapabilityCatalog(raw: unknown): Result<CapabilityCatalog, readonly CatalogFault[]>` is the only constructor of the branded catalog. `authorityOf(catalog, scope)` is the only reader of a mode (INV-2). `capability-scope.ts` folds into the catalog and is deleted, and `KNOWN_SCOPES` and the derived handle types are re-derived from catalog keys. All three existing capabilities declare `app`.
**Why:**
- FR-005 and SC-013: a mode can neither be omitted nor defaulted.
- A single reader makes the planner, the gate, the mint path and the manifest agree by construction, and the INV-2 matrix test proves it.
**Rejected:**
- A mode map beside `KNOWN_SCOPES`: two tables can drift.
- A mode on the DAG node's `requires`: it is a capability property, not a per-use choice, and it would leak into the framework.
- Defaulting to `app`: a silent default is how authority widens.

### AD-3: One capability-facing contract, two Entra identity adapters, explicit model in configuration

**Choice:**
- The port is `EntraAgentAuthority { acquireApp, establishDelegation, redeemDelegation }`, in `domain/port/entra-agent-authority.ts`.
- `createAgentIdAuthority` makes two client_credentials calls:
  - Step 1 to the blueprint: `client_id=blueprint`, `scope=api://AzureADTokenExchange/.default`, `fmi_path=<agent identity>`, `client_assertion=<realm assertion>`. This yields T1.
  - Step 2 as the agent identity: `client_assertion=T1`, `scope=<resource>/.default`.
  - On-behalf-of and refresh run as the agent identity with `client_assertion=T1`.
- `createAppRegistrationAuthority` makes one client_credentials call as the agent's app. On-behalf-of and refresh run with `client_assertion=<realm assertion>`.
- The config produces the `EntraDirectory` ADT: `{model: "agent-id"; tenant; blueprint; agents} | {model: "app-registration"; tenant; agents}`.
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
- The capability grant stays in the assertion, so the realm remains the policy decision point (AD-5, FR-013).
- Both Keycloak behaviours are made deterministic: rejecting an unassigned optional scope, and silently dropping it.
**Rejected:**
- Requesting `entra-exchange` alone and checking the capability locally: that would bypass the realm as the policy decision point.
- Trusting the token blindly: a dropped scope would surface later as an opaque Entra AADSTS error.

### AD-5: Run-start planner as a pure function of identity, requirements, catalog and presentation

**Choice:** `planRunAuthority(input): Result<RunAuthorityPlan, RunAuthorityRefusal>` in `domain/run-authority.ts`.
- Its input:
  - the `AuthIdentity`
  - the DAG's agent client mapping (`AgentClientId | unmapped`)
  - the `(nodeId, capability)` requirements from the framework's `runtimeNodeInventory`, newly exported from the barrel
  - the catalog
  - the brokering state (`brokered{delegation: wired | unwired{missing}} | unbrokered`)
  - a `DelegatedPresentation` ADT: `absent | present-unverified | verified{grant} | invalid{reason}`
- The shell verifies the header against the JWKS only when `requiresDelegation(catalog, requirements)` holds, so a run with no delegated capability never parses the token.
- `run-dag.ts` calls it after input-schema parsing and before `hitl.startRun` and concurrency `acquire`. The refusal maps to the `run-authority-refused` HostError and its HTTP status.
**Why:**
- AS-010, AS-021 to AS-023, FR-006 to FR-009 and SC-003/SC-004: every refusal happens before node execution, slot acquisition or token egress.
- A total function over closed unions can be property-tested exhaustively.
- It also replaces the `throw` for unmapped DAGs in `node-context-factory.ts` with a typed refusal.
**Rejected:**
- Validating inside `createNodeContextForDag`: that runs after concurrency acquisition.
- Validating in framework preflight: see Approach C.

### AD-6: Delegated authority is established eagerly at admission and continued through encrypted run-bound custody

**Choice:**
- Admission yields `user-delegated-pending{grant}`. The shell then calls `establishDelegation` (CT-3) once:
  - Sync runs: after the concurrency slot is acquired, releasing the slot if establishment fails.
  - HITL runs: inside `startRun`, before the record is created, deleting the custody record if record creation fails.
- `establishDelegation` mints the realm assertion, performs on-behalf-of with `offline_access`, seals the refresh credential (`adapters/custody-cipher.ts`, AES-256-GCM, AAD = canonical binding), stores it through `DelegatedCustodyStore` under `fugue:<tenant>:authority:custody:<runId>`, and returns `RunAuthority.user-delegated{delegation: {audience, custodyExpiresAtMs}}`.
- The verified user token is wrapped in a `RedactedSecret` and dropped as soon as establishment returns.
- Redeeming refreshes through the agent identity. A rotated refresh token is re-sealed and the expiry is never extended.
- If Entra refuses, custody moves to `revoked`, and the capability fails `authority-unavailable{cause: reauthorization-required}` with no `app` fallback.
- Teardown goes through one owner, `releaseCustody` in `adapters/custody-release.ts` (INV-4). Every run-ending path calls it: `settleRunOutcome`'s terminal arms, the corrupt-checkpoint settle, `processRun` on an evicted record, the `startRun` compensation, the sync `finally` and establishment-failure path in `run-dag.ts`, and the `establishDelegation` compensation. Only the owner is handed the store's `delete`; every sibling receives `ReleaseCustody` and a narrowed store (`Pick<DelegatedCustodyStore, "put">` or `"get" | "replace"`), so no sibling can delete custody another way. Two removals need no code path and so are not siblings: a run record evicted by Redis TTL while idle (custody PX is the binding expiry, fixed at establishment and at most `HITL_RUN_TTL_SEC`, so custody expires no later than the record) and tenant purge (`purgeTenantKeyspace` reclaims `fugue:<tenant>:*`, custody keys included).
**Why:**
- The user token is touched once and never persisted. Only an agent-bound, encrypted, revocable refresh credential is held, which meets FR-017, FR-023 and AS-026 to AS-027.
- Entra enforces revocation at every refresh.
- The HITL approval channel cannot carry a fresh user token, so lazy delegation would break resume.
**Rejected:**
- Lazy on-behalf-of at first use: the raw user token would be held until then, and a HITL gate before first use would make the run unresumable.
- The approver re-presenting a token (Option B in the clarify log): rejected in clarify.
- Storing the access token only: it expires in about an hour, which is shorter than the 7-day suspension window.

### AD-7: Inbound delegated-token contract and identity binding

**Choice:**
- The header is `X-Fugue-Delegated-Authorization: Bearer <compact JWT>`.
- `domain/entra-user-token.ts` is pure. `validateEntraUserTokenClaims` checks:
  - `iss = https://login.microsoftonline.com/{tenant}/v2.0`
  - `tid` equals the deployment tenant
  - `aud` equals the expected audience
  - `exp` and `nbf` within 60 s of skew
  - `oid` present
  - `scp` present (a delegated token, not app-only)
  - `ver = "2.0"`
- `adapters/entra-user-token-verifier.ts` checks the signature: jose, RS256 only, through `lazyJwks` over `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`.
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
- Add the framework kind `authority-unavailable{scope, agentClientId, cause}`. The cause is one of:
  - `{kind: "federation-grant-missing"; grants: readonly string[]}`
  - `{kind: "authority-unconfigured"; missing: readonly string[]}`
  - `{kind: "federation-rejected"; reason: "issuer" | "subject" | "audience" | "unknown"}`
  - `{kind: "reauthorization-required"; reason: "refused" | "custody-expired" | "custody-absent"}`
- It is non-retriable, and these change with it: `FRAMEWORK_ERROR_KINDS`, the persisted zod schema, `formatFrameworkError`, `retriabilityOf` and the host's `classifyFrameworkError`.
- Unwired legs now map to `authority-unconfigured`, no longer to the retriable `infra-unreachable`.
- AADSTS 70021, 700211, 700212 and 700213 map to `federation-rejected`. `invalid_grant` and `interaction_required` on delegated refresh map to `reauthorization-required{refused}`. 429, 5xx and timeouts stay `infra-unreachable`.
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
- `ApproverRef` is one of `realm-user{realmSub, entra}`, `team{team}`, `admin` or `teams-user{aadObjectId}`.
- `RunRecord` gains `authority: RunAuthority` and `approvals: readonly ApprovalRecord[]`, and `PersistedIdentity`'s `user` gains `entra`.
- Each decision emits a `hitl-decision` audit record with the initiator and the approver.
- `run-executor.ts` rebuilds the run's broker only from `record.authority`.
**Why:** FR-025 and AS-028. The type makes it impossible to derive authority from the approver.
**Rejected:**
- Overloading `HumanAction.actor` (a free-form string): it cannot carry the Entra principal and conflates display with identity.

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

**Choice:** New port interfaces go in `packages/host/src/domain/port/`:
- `realm-assertion-mint.ts`
- `entra-agent-authority.ts`
- `delegated-custody-store.ts`
- `verify-entra-user-token.ts`

Their adapters live in `adapters/`.
**Why:** The binding `architecture.md` rule places ports in the domain, and the existing lint boundary already lets `domain/` import from inside `domain/`.
**Rejected:**
- Defining ports inside adapter files, the local convention (for example `keycloak-token-endpoint.ts`): rules outrank local convention.

This conflict is reported in the final summary. Existing ports are not moved, which is out of scope.

---

## File Structure

### Framework: taxonomy and inventory export

```
packages/framework/src/types/errors.ts                          — add authority-unavailable kind + AuthorityUnavailableCause union, FRAMEWORK_ERROR_KINDS, persisted zod schema, formatFrameworkError, retriabilityOf (non-retriable)
packages/framework/src/index.ts                                 — export runtimeNodeInventory (barrel)
packages/framework/src/__tests__/authority-unavailable-error.test.ts — persisted round-trip, retriability, formatting has no credential fields (property test over causes)
```

### Host: contracts (declarations only, frozen)

```
packages/host/src/domain/run-authority-contract.ts              — CT-1 types: EntraObjectId, EntraTenantId, EntraClientId brands, EntraPrincipal, Initiator, AuthorityMode, CapabilityRequirement, DelegatedPresentation, VerifiedDelegationGrant, RedactedSecret, RunAuthority, RunAuthorityPlan, RunAuthorityRefusal, PlanRunAuthorityFn, BindDelegatedPrincipalFn, ValidateEntraUserTokenClaimsFn
packages/host/src/domain/capability-authority-contract.ts       — CT-2 types: EntraIdentityRef, FederatedAssertion, AssertionFault, EntraAcquisitionFault, AcquiredCredential, CapabilityAuthority (forRun), CreateCapabilityAuthorityFn, InspectFederatedAssertionFn
packages/host/src/domain/delegated-custody-contract.ts          — CT-3 types: CustodyBinding, SealedRefreshCredential, CustodyState, CustodyEvent, CustodyTransitionFault, DelegationEstablishmentFault, ApproverRef, ApprovalRecord, CustodyReleaseCause, CustodyReleaseOutcome, ReleaseCustody, EstablishDelegationFn, TransitionCustodyFn, CreateCustodyReleaseFn
packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts — CT-1 acceptance (incl. delegated header through the supervisor UDS proxy)
packages/host/src/__tests__/acceptance/run-authority-admission-budget.acceptance.test.ts — CT-1 acceptance: run-start validation p95 budget (AS-036; NFR-003, SC-011)
packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts     — CT-2 acceptance
packages/host/src/__tests__/acceptance/capability-authority-budget.acceptance.test.ts — CT-2 acceptance: host-added acquisition and cache-hit p95 budgets (AS-035; NFR-002, SC-011)
packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts   — CT-3 acceptance (approvals driven through the approve route and the Teams bot handler)
packages/host/src/__tests__/acceptance/support/identity-fakes.ts — shared fakes: realm mint, Entra authority (both models), JWKS signer, custody store, clock, zero-latency HTTP transports, in-process UDS transport into the worker router
packages/host/src/__tests__/acceptance/support/latency-budget.ts — shared budget harness: warm-up, sample loop, nearest-rank p95 (test support, not production)
```

### Host: capability catalog (authority mode source)

```
packages/host/src/domain/capability-catalog.ts                  — CAPABILITY_CATALOG, CapabilityDefinitionInput, branded CapabilityCatalog, parseCapabilityCatalog, authorityOf, resourceOf, requiresDelegation, scope parsing (absorbs capability-scope.ts)
packages/host/src/domain/capability-scope.ts                    — DELETED in Phase 3 (Phase 1 re-derives its exports from the catalog)
packages/host/src/domain/capability-gate.ts                     — decideGate reads the catalog; gated variant carries the CapabilityDefinition
packages/host/src/domain/capability-registry.ts                 — registry augmentation derived from catalog keys
packages/host/src/domain/__tests__/capability-catalog.test.ts   — parse faults name the capability; @ts-expect-error type test for a missing authority
packages/host/src/domain/__tests__/capability-catalog.property.test.ts — parse(serialize(c)) = c; any entry lacking or with an unknown authority is refused
packages/host/src/__tests__/authority-mode.matrix.test.ts       — INV-2 matrix (owner + every sibling)
```

### Host: identity topology configuration

```
packages/host/src/domain/config.ts                              — ENTRA_IDENTITY_MODEL, ENTRA_BLUEPRINT_CLIENT_ID, ENTRA_AGENT_IDENTITIES, DELEGATED_CUSTODY_KEYS, DELEGATED_CUSTODY_MAX_SEC; ENTRA_CLIENT_ID removed (refused by name)
packages/host/src/domain/authority-legs.ts                      — planAuthorityLegs → Result<AuthorityLegs, readonly IdentityConfigFault[]>; EntraDirectory ADT; DelegationLeg; delegatedAudienceFor; unwiredLegsWarning text (authority-unconfigured)
packages/host/src/domain/__tests__/authority-legs.test.ts       — rewritten: every seeded misconfiguration names its offender
packages/host/src/domain/__tests__/authority-legs.property.test.ts — total over key-presence combinations: dark iff no ENTRA_* key; complete iff valid; otherwise faults
packages/host/src/domain/__tests__/config-security.test.ts      — custody key shape (32 bytes, active ∈ keys), custody max ≤ HITL_RUN_TTL_SEC
```

### Host: realm assertion mint

```
packages/host/src/domain/port/realm-assertion-mint.ts           — RealmAssertionMint port
packages/host/src/domain/federated-assertion.ts                 — pure payload decode + grant/audience inspection
packages/host/src/domain/__tests__/federated-assertion.test.ts  — missing aud/scope grants → federation-grant-missing naming grants
packages/host/src/adapters/realm-assertion-mint-http.ts         — client_credentials with scope "entra-exchange <capability>", no audience param; invalid_scope → grant missing
packages/host/src/adapters/unwired-realm-assertion-mint.ts      — unwired leg → authority-unconfigured, zero egress
packages/host/src/adapters/__tests__/realm-assertion-mint-http.test.ts — request body capture (SC-001), status mapping
packages/host/src/adapters/keycloak-token-endpoint.ts           — DELETED
packages/host/src/adapters/keycloak-token-endpoint-http.ts      — DELETED
packages/host/src/adapters/unwired-token-endpoint.ts            — DELETED
packages/host/src/adapters/__tests__/keycloak-token-endpoint-http.test.ts — DELETED
```

**Export bindings:**
- `packages/host/src/domain/federated-assertion.ts` — CT-2: inspectFederatedAssertion: InspectFederatedAssertionFn

### Host: Entra agent authority (two models)

```
packages/host/src/domain/port/entra-agent-authority.ts          — EntraAgentAuthority port (acquireApp, establishDelegation, redeemDelegation)
packages/host/src/adapters/entra-token-endpoint.ts              — shared form-body builders, tenant-validated endpoint URL, response → AcquiredCredential | EntraAcquisitionFault (AADSTS mapping)
packages/host/src/adapters/entra-agent-id-authority.ts          — two-step blueprint (fmi_path) → agent identity; OBO and refresh with T1
packages/host/src/adapters/entra-app-registration-authority.ts  — single-step per-agent app; OBO and refresh with the realm assertion
packages/host/src/adapters/unwired-entra-agent-authority.ts     — unwired leg → authority-unconfigured, zero egress
packages/host/src/adapters/__tests__/entra-token-endpoint.test.ts — no client_secret/certificate ever (FR-012); AADSTS classification table
packages/host/src/adapters/__tests__/entra-agent-id-authority.test.ts — step order, fmi_path, T1 as client_assertion, offline_access on OBO
packages/host/src/adapters/__tests__/entra-app-registration-authority.test.ts — single step, OBO assertion audience = agent app
packages/host/src/adapters/entra-wif.ts                         — DELETED
packages/host/src/adapters/unwired-entra-wif.ts                 — DELETED
packages/host/src/adapters/__tests__/entra-wif.test.ts          — DELETED
```

### Host: Entra user token verification and run-start planning

```
packages/host/src/domain/entra-user-token.ts                    — pure claim validation for the delegated token
packages/host/src/domain/port/verify-entra-user-token.ts        — VerifyEntraUserToken port
packages/host/src/adapters/entra-user-token-verifier.ts         — jose + lazyJwks over the tenant v2.0 keys, RS256 only
packages/host/src/domain/run-authority.ts                       — planRunAuthority, bindDelegatedPrincipal, requirementsOf
packages/host/src/domain/jwt-validation.ts                      — entra_oid / entra_tid become required parsed claims
packages/host/src/domain/auth.ts                                — AuthenticatedUser.entra required; SubjectToken + markSubjectToken removed (Phase 1)
packages/host/src/domain/run-context.ts                         — subjectTokenForIdentity removed (Phase 1); origin derived from RunAuthority (Phase 5)
packages/host/src/http/middleware/auth.ts                       — user identity carries entra principal; no subject-token branding
packages/host/src/http/authenticate-identity.ts                 — same
packages/host/src/domain/__tests__/entra-user-token.test.ts     — each refusal reason
packages/host/src/domain/__tests__/run-authority.property.test.ts — planner totality and refusal ordering; binding iff oid ∧ tid equal
packages/host/src/adapters/__tests__/entra-user-token-verifier.test.ts — signature, alg allowlist, key rotation via lazyJwks
packages/host/src/__tests__/middleware/auth.test.ts             — realm JWT without entra claims → 401 naming the claims
```

**Export bindings:**
- `packages/host/src/domain/run-authority.ts` — CT-1: planRunAuthority: PlanRunAuthorityFn, bindDelegatedPrincipal: BindDelegatedPrincipalFn
- `packages/host/src/domain/entra-user-token.ts` — CT-1: validateEntraUserTokenClaims: ValidateEntraUserTokenClaimsFn

### Host: delegated custody

```
packages/host/src/domain/delegated-custody.ts                   — LC-1 machine: transitionCustody, custodyExpiryFor, canonical AAD encoding, reauthorizationReasonOf
packages/host/src/domain/__tests__/delegated-custody.property.test.ts — no undeclared transition accepted; rotation never extends expiry; deleted is absorbing
packages/host/src/domain/port/delegated-custody-store.ts        — DelegatedCustodyStore port (put, get, replace, delete) over CustodyState records
packages/host/src/adapters/custody-cipher.ts                    — AES-256-GCM seal/open via WebCrypto; kid rotation; AAD mismatch → open fails
packages/host/src/adapters/delegated-custody-store-redis.ts     — fugue:<tenant>:authority:custody:<runId>, PX = custody expiry, ciphertext only
packages/host/src/adapters/delegated-custody-store-memory.ts    — process-local store for Redis-less sync deployments (ciphertext only)
packages/host/src/adapters/delegation-establishment.ts          — establishDelegation: mint → OBO → seal → put; compensation through releaseCustody (INV-4 sibling); holds only Pick<DelegatedCustodyStore, "put">
packages/host/src/adapters/custody-release.ts                   — INV-4 owner: createCustodyRelease → releaseCustody(runId, cause); the only holder of DelegatedCustodyStore.delete; idempotent; logs a failed delete with runId, cause and error kind only; never throws
packages/host/src/adapters/__tests__/custody-cipher.test.ts     — round-trip; tampered AAD/ciphertext/kid refused; plaintext never in stored bytes
packages/host/src/adapters/__tests__/delegated-custody-store-redis.test.ts — key under tenant prefix; PX = binding expiry ≤ HITL_RUN_TTL_SEC (idle-eviction cover); purgeTenantKeyspace reclaims the custody key (tenant-purge cover); delete idempotent
packages/host/src/adapters/__tests__/delegated-custody-store-memory.test.ts — expiry honoured on get (expired → absent); delete idempotent
packages/host/src/adapters/__tests__/delegation-establishment.test.ts — failure → typed fault; zero app fallback
packages/host/src/__tests__/custody-release.matrix.test.ts      — INV-4 matrix: owner + every sibling; each terminal path leaves custody absent
```

**Export bindings:**
- `packages/host/src/domain/delegated-custody.ts` — CT-3: transitionCustody: TransitionCustodyFn
- `packages/host/src/adapters/delegation-establishment.ts` — CT-3: establishDelegation: EstablishDelegationFn
- `packages/host/src/adapters/custody-release.ts` — CT-3: createCustodyRelease: CreateCustodyReleaseFn

### Host: capability authority (mint path)

```
packages/host/src/adapters/capability-authority.ts              — boot-scoped core + forRun; app path, delegated path (redeem via custody), caches, audit, handle build
packages/host/src/adapters/keycloak-broker.ts                   — DELETED (replaced by capability-authority.ts)
packages/host/src/adapters/broker-audit.ts                      — audit fields gain agentClientId, entraIdentity, authority, initiator {realmSub, oid, tid}; outcome gains federation path
packages/host/src/adapters/graph-capability.ts                  — handle builders keyed off catalog definitions
packages/host/src/domain/token-cache.ts                         — cache key ADT: app{identity, capability} | delegated{identity, oid, capability}
packages/host/src/adapters/agent-client-credentials.ts          — unchanged contract; consumed by realm-assertion-mint-http
packages/host/src/adapters/__tests__/capability-authority.test.ts — unit: gate refusals zero-egress, cache isolation, single-flight, audit shape
packages/host/src/adapters/__tests__/capability-authority.property.test.ts — no credential served across (identity, mode, oid) under interleavings (NFR-012)
packages/host/src/adapters/__tests__/keycloak-broker.test.ts    — DELETED (superseded)
packages/host/src/adapters/__tests__/broker-audit.test.ts       — new fields; no credential fields
```

**Export bindings:**
- `packages/host/src/adapters/capability-authority.ts` — CT-2: createCapabilityAuthority: CreateCapabilityAuthorityFn

### Host: HITL persistence and approver

```
packages/host/src/hitl/types.ts                                 — PersistedIdentity.user gains entra; RunRecord gains authority: RunAuthority, approvals: readonly ApprovalRecord[]
packages/host/src/hitl/identity.ts                              — toPersistedIdentity / toExecIdentity carry entra; approver mapping to ApproverRef
packages/host/src/hitl/service.ts                               — startRun(dagId, team, input, identity, plan) establishes delegation before record creation (compensation via releaseCustody); settleRunOutcome terminal arms, the corrupt-checkpoint settle and processRun on an evicted record call releaseCustody (INV-4 sibling); recordDecision(..., approver) appends ApprovalRecord + hitl-decision audit
packages/host/src/hitl/adapters/run-store.ts                    — record schema: authority + approvals required (records without them are rejected as corrupt; pre-release, no shim)
packages/host/src/hitl/adapters/run-executor.ts                 — MintingAuthority from capabilityAuthority.forRun(record.authority); no subject-token bind
packages/host/src/http/handlers/runs.ts                         — createApproveRunHandler derives ApproverRef (realm-user{realmSub, entra} | team | admin) from the AuthIdentity the auth middleware built; refusals via errorResponse (CT-3 runtime seam)
packages/host/src/hitl/adapters/bot/messages-handler.ts         — handleBotActivity derives teams-user{aadObjectId} from the verified activity's from.aadObjectId (CT-3 runtime seam)
packages/host/src/hitl/__tests__/approver-authority.test.ts     — unit: ApproverRef mapping per AuthIdentity variant; approval audit names both
packages/host/src/hitl/adapters/__tests__/run-executor.test.ts  — rewritten: authority from record only
```

### Host: admission, manifest and composition

```
packages/host/src/http/delegated-token-header.ts                — parse X-Fugue-Delegated-Authorization → absent | present(RedactedSecret) | malformed
packages/host/src/http/handlers/run-dag.ts                      — admission (plan → verify → bind) before hitl.startRun and acquire; establishment after acquire (sync); releaseCustody in finally and on establishment failure (INV-4 sibling)
packages/host/src/supervisor/uds-proxy.ts                       — unchanged: proxyToWorker forwards X-Fugue-Delegated-Authorization byte-identical and strips only X-Fugue-Tenant; a CT-1 runtime seam, driven by CT-1 acceptance
packages/host/src/http/handlers/manifest.ts                     — per-DAG authority block: modes per capability, delegated header requirement, expected audience, tenant
packages/host/src/domain/host-error.ts                          — run-authority-refused{refusal: RunAuthorityRefusal} + snapshot table entry
packages/host/src/domain/framework-error-http.ts                — authority-unavailable mapping (grant-missing 403, unconfigured 503, federation-rejected 502, reauthorization-required 401)
packages/host/src/host.ts                                       — selectCapabilityAuthority (legs → ports → authority), executeDag(dag, input, ctx, runAuthority, meter); subject-token wiring removed (Phase 1)
packages/host/src/adapters/node-context-factory.ts              — origin from RunAuthority; resolveOriginAndBindSubjectToken removed; unmapped-DAG throw replaced by planner refusal
packages/host/src/__tests__/broker-selection.test.ts            — rewritten for selectCapabilityAuthority over EntraDirectory variants
packages/host/src/__tests__/node-context-factory.test.ts        — rewritten
packages/host/src/__tests__/handlers/run-dag-authority.test.ts  — refusal ordering: zero acquire, zero startRun, zero egress on refusal
packages/host/src/__tests__/handlers/manifest-authority.test.ts — authority block shape per model
packages/host/src/__tests__/credential-sentinel-scan.test.ts    — SC-007: sentinel tokens through every path; scan logs, audit, errors, handles, origin, run records, custody bytes
packages/host/src/adapters/subject-token-registry.ts            — DELETED (Phase 1)
packages/host/src/adapters/__tests__/subject-token-registry.test.ts — DELETED (Phase 1)
packages/host/src/__tests__/subject-token-teardown.test.ts      — DELETED (Phase 1)
packages/host/src/adapters/__tests__/unwired-defaults.test.ts   — rewritten for unwired mint/authority adapters
packages/host/src/domain/__tests__/authority-legs.test.ts       — (see configuration group)
```

### Docs, ADRs and doc-lint

```
docs/adr/0093-per-agent-entra-identity.md                       — supersedes ADR-0055 (written by adr-writer in Phase 1)
docs/adr/0094-per-capability-authority-mode-no-user-exchange.md — partially supersedes ADR-0056 and ADR-0058
docs/adr/0095-delegated-continuation-run-bound-custody.md       — delegated continuation policy and custody
docs/adr/0055-*.md, docs/adr/0056-*.md, docs/adr/0058-*.md      — status + successor pointers
docs/adr/README.md                                              — index rows, supersession
packages/host/docs/auth.md                                      — rewritten identity section, status matrix, token table
packages/host/docs/data-handling.md                             — NEW: initiator attribution (oid, tid), retention unchanged (FR-024), custody hold/bind/cap/delete (FR-044)
packages/host/docs/identity-chain-sequence.md                   — NEW: sequence diagrams for agent, app user-origin, delegated user-origin; per-hop token table (iss, sub, azp, aud, holder, verifier)
docs/team-security-and-capabilities.md                          — reconciled; status matrix
docs/runbooks/entra-fugue-agents-provisioning.md                — rewritten: both models, RBAC for Applications, Agent ID spike pass/fail, fallback selection, rollback, rotation, realm-before-host deploy order, broker-token purge, evidence template
docs/runbooks/identity-live-verification-evidence.md            — NEW: evidence template incl. live latency targets (1500/2000/2500 ms p95)
docs/spikes/2026-06-10-spike-4-identity-chaining-e2e.md         — superseded banner + reconciled status
CONTEXT.md                                                      — Identity-scoped capabilities table; new terms (Run authority, Authority mode, Delegated custody, Entra directory)
scripts/check-identity-docs.ts                                  — doc-lint (status matrix, banned phrases, evidence-gated statuses)
scripts/__tests__/check-identity-docs.test.ts                   — pure lint rules
scripts/verify.sh                                               — run check-identity-docs.ts
```

---

## Component Design

### Capability Catalog

**Responsibility:** The single definition of every brokered capability, its authority mode and its downstream resource.
**Files:** `packages/host/src/domain/capability-catalog.ts`
**Interface:**

```
type AuthorityMode = "app" | "delegated"                       // from CT-1 types
type CapabilityDefinitionInput = { readonly authority: AuthorityMode; readonly resource: "graph" | "dynamics" }
const CAPABILITY_CATALOG = { "msgraph:mail.send": {authority:"app", resource:"graph"}, ... } as const satisfies Record<string, CapabilityDefinitionInput>
type CatalogScope = keyof typeof CAPABILITY_CATALOG             // replaces DownstreamScope's string set
type CapabilityCatalog = Brand<ReadonlyMap<string, CapabilityDefinition>, "CapabilityCatalog">
type CatalogFault = { kind: "authority-missing" | "authority-unknown" | "resource-unknown" | "scope-malformed"; capability: string }
parseCapabilityCatalog(raw: unknown): Result<CapabilityCatalog, readonly CatalogFault[]>
CODE_CATALOG: CapabilityCatalog                                 // parse of CAPABILITY_CATALOG, proven total at module load by a test
authorityOf(catalog, scope): AuthorityMode | undefined          // INV-2 owner
requiresDelegation(catalog, reqs: readonly CapabilityRequirement[]): readonly CapabilityRequirement[]
```

**Depends on:** CT-1 types.

### Identity Topology (authority legs)

**Responsibility:** Parse the deployment's realm, Entra and delegation configuration into wired or dark legs, or into a list of named faults.
**Files:** `packages/host/src/domain/authority-legs.ts`, `packages/host/src/domain/config.ts`
**Interface:**

```
type EntraDirectory =
  | { model: "agent-id"; tenant: EntraTenantId; blueprint: EntraClientId; agents: ReadonlyMap<AgentClientId, EntraClientId> }
  | { model: "app-registration"; tenant: EntraTenantId; agents: ReadonlyMap<AgentClientId, EntraClientId> }
type EntraLeg = { kind: "wired"; directory: EntraDirectory } | { kind: "dark" }
type DelegationLeg = { kind: "wired"; keys: CustodyKeyring; maxSec: number } | { kind: "dark" }
type IdentityConfigFault =
  | { kind: "identity-model-missing" } | { kind: "identity-model-unknown"; value: string }
  | { kind: "blueprint-missing" } | { kind: "blueprint-forbidden"; model: "app-registration" }
  | { kind: "agent-identity-missing"; agentClientIds: readonly AgentClientId[] }
  | { kind: "agent-identity-orphan"; agentClientIds: readonly string[] }
  | { kind: "agent-identity-shared"; entraClientId: string; agentClientIds: readonly AgentClientId[] }
  | { kind: "entra-key-without-tenant"; keys: readonly string[] }
  | { kind: "removed-key"; key: "ENTRA_CLIENT_ID"; replacement: string }
  | { kind: "delegation-without-entra" } | { kind: "custody-max-exceeds-run-ttl"; maxSec: number; runTtlSec: number }
planAuthorityLegs(config, realmIssuer): Result<AuthorityLegs, readonly IdentityConfigFault[]>   // all faults, not first
delegatedAudienceFor(directory, agent): EntraClientId           // blueprint | agent app id
unwiredLegsWarning(legs): string | undefined
```

**Depends on:** `config.ts` (raw keys), CT-1 brands.

### Realm Assertion Mint

**Responsibility:** Obtain an agent's federation assertion carrying both the Entra-exchange grant and the capability grant, or a typed fault, with no Entra egress on failure.
**Files:** `domain/port/realm-assertion-mint.ts`, `domain/federated-assertion.ts`, `adapters/realm-assertion-mint-http.ts`, `adapters/unwired-realm-assertion-mint.ts`
**Interface:**

```
interface RealmAssertionMint {
  readonly mintFederationAssertion: (agent: AgentClientId, capability: CatalogScope, signal: AbortSignal)
    => Promise<Result<FederatedAssertion, AssertionFault>>
}
type AssertionFault =
  | { kind: "grant-missing"; grants: readonly string[] }     // invalid_scope, or inspection failure
  | { kind: "credentials-missing"; agent: AgentClientId }    // no KEYCLOAK_AGENT_CLIENT_CREDENTIALS entry → zero egress
  | { kind: "unconfigured"; missing: readonly string[] }
  | { kind: "unreachable"; hop: "realm"; message: string }   // 429/5xx/timeout
  | { kind: "rejected"; status: number }                     // 401 bad client credentials
inspectFederatedAssertion(jwt: string, capability): Result<FederatedAssertion, AssertionFault>
```

**Depends on:** `agent-client-credentials.ts`, the catalog and CT-2 types.

### Entra Agent Authority

**Responsibility:** Turn a federated assertion into a resource credential under the agent's own Entra identity, either app-only or on behalf of a user, for exactly one identity model.
**Files:** `domain/port/entra-agent-authority.ts`, `adapters/entra-token-endpoint.ts`, `adapters/entra-agent-id-authority.ts`, `adapters/entra-app-registration-authority.ts`, `adapters/unwired-entra-agent-authority.ts`
**Interface:**

```
interface EntraAgentAuthority {
  readonly acquireApp: (id: EntraIdentityRef, assertion: FederatedAssertion, resource: ResourceAudience, signal)
    => Promise<Result<AcquiredCredential, EntraAcquisitionFault>>
  readonly establishDelegation: (id, assertion, user: VerifiedDelegationGrant, resource, signal)
    => Promise<Result<{ access: AcquiredCredential; refresh: RedactedSecret }, EntraAcquisitionFault>>
  readonly redeemDelegation: (id, assertion, refresh: RedactedSecret, resource, signal)
    => Promise<Result<{ access: AcquiredCredential; refresh: RedactedSecret | undefined }, EntraAcquisitionFault>>
}
type EntraAcquisitionFault =
  | { kind: "federation-rejected"; reason: "issuer" | "subject" | "audience" | "unknown"; aadsts?: string }
  | { kind: "delegation-refused"; reason: "invalid-grant" | "interaction-required" | "consent-required" }
  | { kind: "unreachable"; message: string }
createAgentIdAuthority(deps: { directory: Extract<EntraDirectory, {model:"agent-id"}>; http; now }): EntraAgentAuthority
createAppRegistrationAuthority(deps: { directory: Extract<EntraDirectory, {model:"app-registration"}>; http; now }): EntraAgentAuthority
```

**Depends on:** CT-2 types and the `fetch-http-post.ts` transport.

### Run Authority Planner

**Responsibility:** Decide, purely and before any slot or egress, the authority a run will act under, or refuse with a typed reason.
**Files:** `domain/run-authority.ts`, `domain/entra-user-token.ts`, `adapters/entra-user-token-verifier.ts`, `http/delegated-token-header.ts`
**Interface:**

```
type RunAuthority =
  | { kind: "unbrokered"; principal: { kind: "agent" } | { kind: "user"; initiator: Initiator } }
  | { kind: "agent"; agentClientId: AgentClientId }
  | { kind: "user-app"; agentClientId: AgentClientId; initiator: Initiator }
  | { kind: "user-delegated"; agentClientId: AgentClientId; initiator: Initiator; delegation: { audience: EntraClientId; custodyExpiresAtMs: number } }
type RunAuthorityPlan = Exclude<RunAuthority, { kind: "user-delegated" }>
  | { kind: "user-delegated-pending"; agentClientId: AgentClientId; initiator: Initiator; grant: VerifiedDelegationGrant }
type RunAuthorityRefusal =
  | { kind: "delegated-capability-requires-user"; nodeId: NodeId; capability: string }       // 403
  | { kind: "delegated-token-required"; requirements: readonly CapabilityRequirement[] }      // 401
  | { kind: "delegated-token-invalid"; reason: "malformed" | "signature" | "issuer" | "tenant" | "audience" | "expired" | "not-yet-valid" | "not-delegated" | "version" }  // 401
  | { kind: "identity-binding-mismatch"; field: "oid" | "tid" }                                // 403
  | { kind: "delegated-token-unexpected" }                                                     // 400
  | { kind: "delegation-unconfigured"; missing: readonly string[] }                            // 503
  | { kind: "agent-client-unmapped"; dagId: DagId }                                            // 503
  | { kind: "delegation-not-established"; reason: "refused" | "federation-rejected" | "grant-missing" | "unreachable" | "unconfigured" }  // 403/502/403/503/503
planRunAuthority(input: RunAuthorityInput): Result<RunAuthorityPlan, RunAuthorityRefusal>
bindDelegatedPrincipal(realm: EntraPrincipal, verified: VerifiedEntraClaims): Result<EntraPrincipal, RunAuthorityRefusal>
validateEntraUserTokenClaims(claims: unknown, expect: { tenant; audience; nowMs }): Result<VerifiedEntraClaims, RunAuthorityRefusal>
```

Refusal precedence, a property-tested total order: `agent-client-unmapped` → `delegated-capability-requires-user` → `delegated-token-unexpected` → `delegation-unconfigured` → `delegated-token-required` → `delegated-token-invalid` → `identity-binding-mismatch`.
**Depends on:** catalog, CT-1 types, framework `runtimeNodeInventory`, `lazyJwks`.

### Delegated Custody

**Responsibility:** Hold the run-bound refresh credential only as ciphertext, through a typed lifecycle with a fixed expiry, until the run's terminal state.
**Files:** `domain/delegated-custody.ts` (LC-1), `domain/port/delegated-custody-store.ts`, `adapters/custody-cipher.ts`, `adapters/delegated-custody-store-redis.ts`, `adapters/delegated-custody-store-memory.ts`, `adapters/delegation-establishment.ts`, `adapters/custody-release.ts` (INV-4 owner)
**Interface:**

```
type CustodyBinding = { runId: RunId; agentClientId: AgentClientId; entra: EntraPrincipal; expiresAtMs: number }
type SealedRefreshCredential = { kid: string; iv: string; ciphertext: string }          // base64url
type CustodyState =
  | { kind: "absent" }
  | { kind: "held"; binding: CustodyBinding; sealed: SealedRefreshCredential; generation: number }
  | { kind: "expired"; binding: CustodyBinding }
  | { kind: "revoked"; binding: CustodyBinding; reason: "refused" }
  | { kind: "deleted" }
type CustodyEvent =
  | { kind: "establish"; binding: CustodyBinding; sealed: SealedRefreshCredential; nowMs: number; capMs: number }
  | { kind: "rotate"; sealed: SealedRefreshCredential; nowMs: number }
  | { kind: "refuse"; nowMs: number }
  | { kind: "expire"; nowMs: number }
  | { kind: "teardown" }
transitionCustody(state: CustodyState, event: CustodyEvent): Result<CustodyState, CustodyTransitionFault>
interface DelegatedCustodyStore {
  put(runId, state: Extract<CustodyState, {kind:"held"}>): Promise<Result<void, HostError>>   // NX
  get(runId): Promise<Result<CustodyState, HostError>>                                     // missing → absent
  replace(runId, next: CustodyState, expectedGeneration: number): Promise<Result<void, HostError>>  // CAS
  delete(runId): Promise<Result<void, HostError>>                                          // idempotent; handed ONLY to createCustodyRelease
}
type CustodyReleaseCause =
  | { kind: "hitl-completed" } | { kind: "hitl-failed" }                // settleRunOutcome terminal arms (a rejected gate settles failed)
  | { kind: "hitl-corrupt-checkpoint" }                                 // processRun settles failed
  | { kind: "hitl-record-evicted" }                                     // processRun finds no record
  | { kind: "hitl-start-compensation" }                                 // record creation failed after establishment
  | { kind: "sync-settled"; outcome: "completed" | "failed" | "aborted" } // run-dag finally (abort covers timeout and client cancel)
  | { kind: "sync-establishment-failed" }                               // run-dag, before the slot is released
  | { kind: "establishment-compensation" }                              // establishDelegation: put failed or was ambiguous
type CustodyReleaseOutcome = { kind: "released" } | { kind: "release-failed"; error: HostError }
type ReleaseCustody = (runId: RunId, cause: CustodyReleaseCause) => Promise<CustodyReleaseOutcome>   // never rejects
createCustodyRelease(deps: { custody: Pick<DelegatedCustodyStore, "delete">; logger: LogPort }): ReleaseCustody   // INV-4 owner
establishDelegation(deps: { mint; entra; cipher; custody: Pick<DelegatedCustodyStore, "put">; releaseCustody: ReleaseCustody; now },
    plan: Extract<RunAuthorityPlan,{kind:"user-delegated-pending"}>, runId, runDeadlineMs)
  : Promise<Result<Extract<RunAuthority,{kind:"user-delegated"}>, DelegationEstablishmentFault>>
```

`releaseCustody` is unconditional and idempotent: a run that never held custody costs one `DEL` on a missing key, so no caller decides whether a run "had" custody, and a mutant owner cannot hide behind a skipped branch. On a dark delegation leg the owner is composed over the in-memory store, which stays empty because the planner refuses every delegated run there. A failed delete is logged at error as a structured record with `runId`, `cause` and the error kind only (never the sealed bytes), and the ciphertext still expires at its PX.

**Depends on:** LC-1, CT-3 types, `RealmAssertionMint`, `EntraAgentAuthority`, Redis port.

### Capability Authority

**Responsibility:** For one run, turn a node's `requires` into narrowed handles under the run's authority, through the gate, the realm and Entra, with per-identity caching and audit.
**Files:** `adapters/capability-authority.ts`, `adapters/broker-audit.ts`, `adapters/graph-capability.ts`, `domain/token-cache.ts`
**Interface:**

```
interface CapabilityAuthority {
  readonly forRun: (run: RunAuthority) => CapabilityBroker      // framework port; mintFor + provides
}
createCapabilityAuthority(deps: {
  catalog: CapabilityCatalog; legs: AuthorityLegs; assignedScopes: (a: AgentClientId) => ReadonlySet<string>;
  mint: RealmAssertionMint; entra: EntraAgentAuthority; custody: Pick<DelegatedCustodyStore, "get" | "replace">; cipher: CustodyCipher;
  graphHttp: GraphHttp; dynamicsOrgHost?: string; tracer; logger; audit; now
}): CapabilityAuthority
```

Per invocation:
1. The run's `agentClientId` must equal `agentClientIdFromFrameworkOrigin(inv.origin)`; otherwise `policy-refusal`.
2. `decideGate` runs and refuses unassigned scopes with zero egress.
3. `authorityOf` picks the path:
   - `app`: the boot cell for (identity, app, capability) runs mint, then `acquireApp`.
   - `delegated` on a `user-delegated` run: the run cell for (identity, delegated, oid, capability) reads custody through `transitionCustody`, then mint, then `redeemDelegation`, then a rotation CAS.
   - `delegated` on any other run kind: `authority-unavailable{reauthorization-required: custody-absent}`. This is unreachable after admission and is kept as defense in depth.
4. Build the handle and write the audit record.

**Depends on:** every component above, plus the framework `CapabilityBroker`.

### Run Admission (HTTP shell)

**Responsibility:** Order the run-start steps so that every authority refusal happens before the HITL fork, concurrency, or egress, and so that custody is always torn down.
**Files:** `http/handlers/run-dag.ts`, `http/delegated-token-header.ts`, `domain/host-error.ts`, `host.ts`, `adapters/node-context-factory.ts`
**Interface:**

```
RunDagDeps += {
  admitRunAuthority: (identity, registered, header: DelegatedHeader) => Promise<Result<RunAuthorityPlan, RunAuthorityRefusal>>
  establishRunAuthority: (plan, runId, deadlineMs) => Promise<Result<RunAuthority, RunAuthorityRefusal>>
  releaseCustody: ReleaseCustody                                  // INV-4 owner, injected; run-dag never sees the custody store
  executeDag: (dag, input, ctx, authority: RunAuthority, meter) => ...
}
HitlRunService.startRun(dagId, team, input, identity, plan: RunAuthorityPlan)
```

Sync order: lookup, then access, then body, then schema, then **admit**. If HITL, `startRun` (which establishes) and return. Otherwise acquire, circuit, **establish** (on failure `releaseCustody(runId, sync-establishment-failed)`, then release the slot), execute, and in `finally` `releaseCustody(runId, sync-settled{outcome})`.

In a multi-tenant deployment the request reaches this handler through the supervisor: `proxyToWorker` (`supervisor/uds-proxy.ts`) clones every inbound header, deletes the client's `X-Fugue-Tenant`, stamps the signed one and forwards the rest, so `X-Fugue-Delegated-Authorization` arrives byte-identical and is never logged (the proxy logs only the tenant and the transport reason). CT-1 declares `proxyToWorker` as a runtime seam and its acceptance drives a submission through it, so a future header allowlist in the proxy that drops the delegated header fails CT-1.
**Depends on:** Planner, Custody, Capability Authority, HITL service.

### HITL Authority Continuity

**Responsibility:** Persist the run's authority and approvals, rebuild the broker from the record alone on resume, and delete custody at every terminal state.
**Files:** `hitl/types.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/run-executor.ts`, `http/handlers/runs.ts`, `hitl/adapters/bot/messages-handler.ts`
**Interface:**

```
RunRecord += { authority: RunAuthority; approvals: readonly ApprovalRecord[] }
ApprovalRecord = { nodeId: NodeId; decision: HumanAction["kind"]; approver: ApproverRef; atMs: number }
recordDecision(runId, nodeId, action, approver: ApproverRef): Promise<Result<void, HostError>>
HitlRunServiceDeps += { establishDelegation; releaseCustody: ReleaseCustody }   // no custody store
```

The approver is derived where production derives it, never handed in by a caller of the service: `createApproveRunHandler` maps the `AuthIdentity` that `createAuthMiddleware` built (a realm user carries its Entra principal) to `realm-user{realmSub, entra}`, `team{team}` or `admin`, and serializes refusals through `errorResponse`; `handleBotActivity` maps the verified activity's `from.aadObjectId` to `teams-user{aadObjectId}`. CT-3 declares all four symbols as runtime seams, so its acceptance approves through the route and the bot handler, not through `recordDecision` with a hand-built approver.

**Depends on:** CT-1 and CT-3 types, Capability Authority, Custody release (INV-4).

### Doc Lint

**Responsibility:** Fail the build when an identity doc claims a status it has no evidence for, or describes the `app` path as acting as the user.
**Files:** `scripts/check-identity-docs.ts`, `scripts/__tests__/check-identity-docs.test.ts`
**Interface:**

```
IDENTITY_DOCS: readonly string[]                       // the issue #42 list
BANNED: readonly { pattern: RegExp; unlessLineMatches?: RegExp; reason: string }[]
lintIdentityDoc(path: string, text: string): readonly Problem[]
```

**Depends on:** none.

---

## Data Flow

```
Agent-origin / user-app (per node invocation):
framework dispatch → invocationFor(MintingAuthority) → forRun(runAuthority).mintFor(inv, requires)
  → decideGate(catalog, assigned) ─refused→ policy-refusal (0 egress)
  → authorityOf = app → boot cell[(entraId, app, cap)]
      miss → RealmAssertionMint(scope="entra-exchange cap") → inspectFederatedAssertion
           → EntraAgentAuthority.acquireApp (agent-id: blueprint fmi_path → T1 → agent identity; app-reg: one step)
  → buildGraphHandle → audit{run,node,agent,entraId,cap,mode=app,initiator?}

Delegated run start:
POST /dags/:id/run (Authorization: realm JWT[entra_oid,entra_tid]; X-Fugue-Delegated-Authorization: Entra JWT[aud=blueprint|agent app])
  → auth middleware → AuthenticatedUser{entra}
  → requirementsOf(runtimeNodeInventory) → requiresDelegation? → verify header (JWKS, RS256) → validate claims
  → planRunAuthority → bindDelegatedPrincipal → user-delegated-pending
  → [HITL: startRun | sync: acquire] → establishDelegation: mint → OBO(offline_access) → seal(AES-GCM, AAD=binding) → custody.put
  → RunAuthority.user-delegated (persisted on HITL record; user token dropped)

Delegated node invocation (incl. after resume, any approver):
forRun(record.authority) → run cell[(entraId, delegated, oid, cap)] miss → custody.get → transitionCustody
  → open → mint → redeemDelegation → rotate? seal + replace(CAS) → handle
  refused → transition(refuse) → authority-unavailable{reauthorization-required: refused} (no app fallback)

Terminal (hitl completed | hitl failed incl. rejected | corrupt checkpoint | record evicted | start compensation
          | sync finally: completed, failed, aborted | sync establishment failed | establishment compensation)
  → releaseCustody(runId, cause) → custody.delete (INV-4 owner, idempotent, never throws)
Idle TTL eviction → custody PX (≤ record TTL) | tenant purge → purgeTenantKeyspace(fugue:<tenant>:*)
```

The only places a bearer token exists are the inbound request (dropped after establishment), the per-call Entra form bodies, and the in-memory token cells. Custody holds only ciphertext bound by AAD.

---

## Lifecycles

### LC-1: Delegated refresh-credential custody

**Machine file:** `packages/host/src/domain/delegated-custody.ts`
**Kind:** typed-reducer
**States:** absent, held, expired, revoked, deleted

| Event | From | To |
|---|---|---|
| establish | absent | held |
| rotate | held | held |
| refuse | held | revoked |
| expire | held | expired |
| teardown | absent, held, expired, revoked | deleted |

The machine's guards:
- `establish` requires `binding.expiresAtMs ≤ nowMs + capMs` and `> nowMs`.
- `rotate` requires `nowMs < expiresAtMs`, keeps `binding` byte-identical (expiry is never extended) and increments `generation`.
- `refuse` and `expire` drop the sealed bytes; the state carries no credential.
- `deleted` is absorbing.
- Any other (state, event) pair is `Err(CustodyTransitionFault)`.

`reauthorizationReasonOf(state, nowMs)` maps the states as follows:
- `revoked` → `refused`
- `expired`, or `held` past expiry → `custody-expired`
- `absent` and `deleted` → `custody-absent`

The machine imports `CustodyState` and `CustodyEvent` from the CT-3 types file, so the frozen ADT is declared once.

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
- `packages/host/src/domain/capability-gate.ts` — the mint-time gate carries the catalog definition (mode included) in its `gated` decision
- `packages/host/src/domain/run-authority.ts` — run-start admission decides whether delegation is required
- `packages/host/src/adapters/capability-authority.ts` — the mint path chooses the app or delegated acquisition
- `packages/host/src/http/handlers/manifest.ts` — publishes each DAG's capability modes and the delegated header requirement
**Matrix test:** `packages/host/src/__tests__/authority-mode.matrix.test.ts`
**Statement:** Every call site that needs a capability's authority mode reads it through `authorityOf` on a parsed `CapabilityCatalog`. No module hard-codes a mode, defaults a missing mode, or keeps a second mode table. The rule covers admission, the mint-time gate, mint-path dispatch and the manifest. The matrix test generates catalogs (fast-check, including delegated test entries) and asserts that all four siblings report the owner's mode for every scope, so a mutant owner that answers "app" fails it. The tier is advisory because no lint rule can tell a mode read from a mode invented; the matrix test and owner mutation verification enforce it. The matrix test lands in Phase 1 with the owner and the gate, and Phases 2, 3 and 5 each extend it in the Wave that adds a sibling.

### INV-3: No credential material in any observable surface

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A prohibition. It spans every module that logs, audits, formats errors, builds handles or persists records, and no single module can own an absence (FR-022, SC-007).
**Statement:** No bearer token, assertion, refresh token, T1 token or custody plaintext appears in logs, audit records, error messages, `formatFrameworkError` output, capability handles, `InvocationOrigin`, HITL run records or custody bytes. A regex cannot recognise a token value, so this stays advisory. `credential-sentinel-scan.test.ts` drives sentinel tokens through every path and scans every captured surface.

### INV-4: Delegated custody is released through one owner at every run-ending path

**Tier:** advisory
**Owner module:** `packages/host/src/adapters/custody-release.ts`
**Sibling entry points:**
- `packages/host/src/hitl/service.ts` — `settleRunOutcome`'s completed and failed arms (a rejected gate settles failed), the corrupt-checkpoint settle and the evicted-record arm of `processRun`, and the `startRun` compensation when record creation fails after establishment
- `packages/host/src/http/handlers/run-dag.ts` — the sync `finally` (completed, failed, aborted by timeout or client cancel) and the establishment-failure path before the slot is released
- `packages/host/src/adapters/delegation-establishment.ts` — the compensation when the custody `put` fails or is ambiguous
**Matrix test:** `packages/host/src/__tests__/custody-release.matrix.test.ts`
**Statement:** Every code path that ends a run, or abandons a run's delegation establishment, makes that run's delegated custody unretrievable by calling `releaseCustody(runId, cause)` from the owner, which alone holds `DelegatedCustodyStore.delete` (FR-023, AS-027, SC-012). No other module deletes, expires or overwrites custody to end it; siblings receive `ReleaseCustody` and a store narrowed to `put` or `get | replace`, so a second deletion path does not type-check. The rule covers the HITL service's terminal arms, corrupt-checkpoint settle, evicted-record arm and start compensation, the sync handler's `finally` and establishment-failure path, and the establishment compensation. Two removals have no code path and are outside the sibling list by design: an idle run record evicted by Redis TTL (custody PX is the binding expiry, fixed at establishment and at most `HITL_RUN_TTL_SEC`, so custody expires no later than the record) and tenant purge (`purgeTenantKeyspace` deletes `fugue:<tenant>:*`, custody keys included); `delegated-custody-store-redis.test.ts` asserts both. The matrix test uses the real owner over the in-memory store with seeded `held` custody and drives each sibling path (HITL: completed, failed, rejected, corrupt checkpoint, evicted record, start compensation; sync: completed, failed, aborted, establishment failure; establishment: failed put, ambiguous put), asserting after each that `get(runId)` is `absent` and the logged cause is the path's own. A row with a store whose `delete` fails asserts `release-failed`, one error log naming `runId` and `cause` with no credential bytes, and that no sibling path throws. So a mutant owner that skips the delete, swallows the outcome or drops the log fails the matrix. The tier is advisory because a regex cannot tell a custody delete from any other `delete` call; the narrowed sibling types, the matrix test and owner mutation verification enforce it. The owner and the matrix test (owner and `delegation-establishment.ts` rows) land in Phase 3; Phase 4 adds the `hitl/service.ts` rows and Phase 5 the `run-dag.ts` rows. If decompose schedules an earlier Task that lists one of those siblings (for example to follow the `startRun` signature change into `run-dag.ts`), that Task's Wave adds the sibling's rows instead.

---

## Contracts

### CT-1: Run-start authority admission

**Types file:** `packages/host/src/domain/run-authority-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts` — AS-006, AS-010, AS-021, AS-022, AS-023, FR-004, FR-006, FR-007, FR-008, FR-009, FR-018, FR-020, FR-036
- `packages/host/src/__tests__/acceptance/run-authority-admission-budget.acceptance.test.ts` — AS-036
**Supported domain:** `packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts`
**Entry point:** `packages/host/src/http/handlers/run-dag.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: the supervisor forwards every tenant request to its worker here, stripping the client's `X-Fugue-Tenant` and forwarding `X-Fugue-Delegated-Authorization`)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: every request's identity, including the Entra principal, is built here)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: the production route handler)
- `errorResponse` (`packages/host/src/http/response.ts`: refusal serialization)
**Statement:** A run is admitted under exactly one `RunAuthority`, decided before any HITL fork, concurrency acquisition or token egress. A user run with only `app` capabilities is admitted as `user-app` with initiator attribution (realm sub, oid, tid) and retains no user token, and admin and team paths behave as before. Refused, each with its typed refusal and HTTP status: an agent-origin (team or admin) run whose DAG requires a delegated capability (naming node and capability); a user run requiring delegation with no Entra token; an invalid Entra token (bad signature, issuer, tenant, audience, expiry, a non-delegated token, or a wrong version); a mismatched `oid` or `tid`; an Entra token sent to a run that needs none; and delegation requested on a deployment whose delegation leg is dark. Submitted through the supervisor (`proxyToWorker` with an in-process transport into the worker's auth middleware and route), a delegated submission arrives with `X-Fugue-Delegated-Authorization` byte-identical and is admitted, a client-forged `X-Fugue-Tenant` never reaches the worker (only the supervisor-signed value does), a refusal returns to the client with the worker's status and body unchanged, and no proxy log line carries the delegated token. Run-start validation (realm JWT authentication, authority planning, delegated-token signature and claim verification through the real verifier over an in-process JWKS, and binding) adds at most 50 ms p95 to a submission, measured through the proxy and route after a warm-up that absorbs the first signing-key fetch.

### CT-2: Capability authority mint path

**Types file:** `packages/host/src/domain/capability-authority-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts` — AS-001, AS-002, AS-003, AS-004, AS-005, AS-011, AS-012, AS-024, AS-025, FR-001, FR-002, FR-003, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-021
- `packages/host/src/__tests__/acceptance/capability-authority-budget.acceptance.test.ts` — AS-035
**Supported domain:** `packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts`
**Entry point:** `packages/host/src/adapters/capability-authority.ts`
**Runtime seams:**
- `invocationFor` (`@fuguejs/framework`: dispatch derives every Invocation from the run's MintingAuthority)
- `brokerAuditPayload` (`packages/host/src/adapters/broker-audit.ts`: every mint, reuse and refusal audit record)
**Statement:** For a run's authority, each required capability yields a narrowed handle backed by a credential issued to that agent's own Entra identity; the realm assertion always carries both the Entra-exchange and the capability grant, and the two identity models are interchangeable with identical capability and DAG definitions. Caches never cross agent identity, authority mode or user, app and delegated handles in one node are unreachable from each other, a delegated refusal never falls back to `app`, and audit records carry the run, node, agent client, Entra identity, scope, mode and initiator `oid` with no credential material. Refused: an unassigned scope (zero egress); a missing Entra-exchange or capability grant (zero Entra egress, naming the grant); a federation rejection (distinguished from a transient failure); and a delegated capability on a non-delegated run. With zero-latency injected realm and Entra transports, so that every measured millisecond is host-added, a cold acquisition through `invocationFor` and `forRun(...).mintFor` (gate, mint, assertion inspection, Entra acquisition for both identity models, custody open and rotation re-seal on the delegated path, handle build and audit) takes at most 10 ms p95, and a cache hit at most 5 ms p95 with zero transport calls.

### CT-3: Run authority continuity across suspension

**Types file:** `packages/host/src/domain/delegated-custody-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts` — AS-007, AS-008, AS-020, AS-026, AS-034, AS-027, AS-028, FR-016, FR-017, FR-025, FR-023
**Supported domain:** `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts`
**Entry point:** `packages/host/src/hitl/service.ts`
**Runtime seams:**
- `createHitlRunService` (`packages/host/src/hitl/service.ts`: run start, processing, decisions, terminal settlement)
- `createRunExecutor` (`packages/host/src/hitl/adapters/run-executor.ts`: resumed slices build their minting authority here)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: the HTTP approver's identity, including its Entra principal, is built here)
- `createApproveRunHandler` (`packages/host/src/http/handlers/runs.ts`: the production approve route derives the `ApproverRef` from that identity)
- `handleBotActivity` (`packages/host/src/hitl/adapters/bot/messages-handler.ts`: the Teams approval path derives the `teams-user` `ApproverRef` from the verified activity)
- `errorResponse` (`packages/host/src/http/response.ts`: approve-route refusal serialization)
- `createCustodyRelease` (`packages/host/src/adapters/custody-release.ts`: every terminal settlement releases custody here, INV-4)
**Statement:** A user run's authority survives HITL suspension and token expiry. An `app` run resumes and completes under the agent identity, with attribution taken from the record and no user token. A delegated run establishes its delegation once at start, holds only an AES-GCM-sealed refresh credential bound to (run, agent, oid, tid) with expiry capped at the suspension window, redeems it through the agent identity after resume, and acts for the original initiator whoever approves. Approvals enter only through the production approval paths: `POST /runs/:runId/approve` (auth middleware, then the approve handler) and the Teams bot handler. A different realm user approving over HTTP, or a mapped Teams user approving from a card, is recorded as that approver (`realm-user{realmSub, entra}` or `teams-user{aadObjectId}`) in the run's approvals and the `hitl-decision` audit record, while every delegated acquisition after resume still carries the initiator's `oid`. An approval of a run that is not suspended is refused 409 through `errorResponse`, and an approval by an identity the existing approver authorization refuses records nothing. A refused refresh, expired custody or absent custody is refused with `reauthorization-required` and no `app` fallback, and after every terminal state (completed, failed including a rejected gate, evicted record) no delegated credential for the run can be retrieved.

---

## Implementation Phases

Ordered by dependency. Decompose places the contract tasks (CT-1, CT-2, CT-3) and the LC-1 machine task in the earliest Waves their imports allow. The LC-1 machine imports CT-3 types, so it follows the CT-3 contract task.

### Phase 1: Foundations and demolition (no dependencies)

- Add `authority-unavailable` to the framework error union. Update `FRAMEWORK_ERROR_KINDS`, the persisted schema, `formatFrameworkError` and `retriabilityOf` (non-retriable), with tests. Export `runtimeNodeInventory` from the framework barrel.
- Create the capability catalog and its parser. Re-derive the exports of `capability-scope.ts` from the catalog (the file is deleted in Phase 3). Point `capability-gate.ts` and `capability-registry.ts` at the catalog. Write the `@ts-expect-error` type test and the property tests. Write the INV-2 matrix test covering the owner and `capability-gate.ts`.
- Remove the RFC 8693 user exchange end to end, behaviour-preserving for `app` semantics:
  - Delete `subject-token-registry.ts` and its test, `subject-token-teardown.test.ts`, `SubjectToken` and `markSubjectToken`, `subjectTokenForIdentity`, `exchangeV2`, `buildExchangeV2Body` and `TOKEN_EXCHANGE_GRANT_TYPE`, `inertResolveSubjectToken`, `withSubjectTokenRelease`, and the `bindSubjectToken` option and its resolution in `node-context-factory.ts` and `run-executor.ts`.
  - The broker's user branch now mints the agent's own client_credentials assertion, with the initiator `sub` as attribution only.
  - Update the affected tests. This makes the INV-1 rule green.
- Write ADRs 0093, 0094 and 0095 (adr-writer agent). Add the successor pointers in ADRs 0055, 0056 and 0058, and the `docs/adr/README.md` rows.
- **Files:**
  - `packages/framework/src/types/errors.ts`, `packages/framework/src/index.ts`, `packages/framework/src/__tests__/authority-unavailable-error.test.ts`
  - `packages/host/src/domain/capability-catalog.ts`, `capability-scope.ts`, `capability-gate.ts`, `capability-registry.ts`, `domain/__tests__/capability-catalog*.test.ts`, `packages/host/src/__tests__/authority-mode.matrix.test.ts`
  - Demolition: `adapters/subject-token-registry.ts`, `adapters/__tests__/subject-token-registry.test.ts`, `__tests__/subject-token-teardown.test.ts`, `domain/auth.ts`, `domain/run-context.ts`, `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `adapters/keycloak-token-endpoint.ts`, `adapters/keycloak-token-endpoint-http.ts`, `adapters/keycloak-broker.ts`, `adapters/node-context-factory.ts`, `hitl/adapters/run-executor.ts`, `host.ts`, plus their tests (`__tests__/middleware/auth.test.ts`, `__tests__/node-context-factory.test.ts`, `__tests__/broker-selection.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `adapters/__tests__/keycloak-token-endpoint-http.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`)
  - `docs/adr/0093-*.md`, `0094-*.md`, `0095-*.md`, `docs/adr/0055-*.md`, `0056-*.md`, `0058-*.md`, `docs/adr/README.md`

### Phase 2: Identity topology, ports and verification (depends on Phase 1)

- Rewrite the Entra keys in `config.ts`. Make `authority-legs.ts` return `Result` with `EntraDirectory`, `DelegationLeg`, every fault, and `delegatedAudienceFor`. Write the property tests.
- Add the realm assertion mint port and HTTP adapter (`scope="entra-exchange <capability>"`, no `audience`), `inspectFederatedAssertion`, and the unwired adapter. Delete `keycloak-token-endpoint(-http).ts` and `unwired-token-endpoint.ts`.
- Add the Entra agent authority port, the shared endpoint module, and the agent-id, app-registration and unwired adapters. Delete `entra-wif.ts` and `unwired-entra-wif.ts`.
- Add Entra user token claim validation, the verifier port and the jose adapter. Make `entra_oid` and `entra_tid` required realm claims (`jwt-validation.ts`, `auth.ts`, `middleware/auth.ts`, `authenticate-identity.ts`).
- Add the run authority planner and the binding. Extend the INV-2 matrix test with `run-authority.ts`.
- Add the custody cipher, the store port, the Redis and in-memory stores, and the LC-1 machine.
- **Files:** `domain/config.ts`, `domain/authority-legs.ts`, `domain/port/*.ts`, `domain/federated-assertion.ts`, `domain/entra-user-token.ts`, `domain/run-authority.ts`, `domain/jwt-validation.ts`, `domain/auth.ts`, `domain/delegated-custody.ts`, `adapters/realm-assertion-mint-http.ts`, `adapters/unwired-realm-assertion-mint.ts`, `adapters/entra-token-endpoint.ts`, `adapters/entra-agent-id-authority.ts`, `adapters/entra-app-registration-authority.ts`, `adapters/unwired-entra-agent-authority.ts`, `adapters/entra-user-token-verifier.ts`, `adapters/custody-cipher.ts`, `adapters/delegated-custody-store-redis.ts`, `adapters/delegated-custody-store-memory.ts`, `http/middleware/auth.ts`, `http/authenticate-identity.ts`, their tests, and `__tests__/authority-mode.matrix.test.ts`. The deleted adapters and tests are listed in File Structure.

### Phase 3: Capability authority and delegation establishment (depends on Phase 2)

- Build `capability-authority.ts` (boot core plus `forRun`, app and delegated paths, cache key ADT, audit, handles) to replace `keycloak-broker.ts`. Delete `capability-scope.ts` and migrate its importers (`graph-capability.ts`, `config.ts` scope validation) to the catalog. Extend `broker-audit.ts`. Extend the INV-2 matrix test with `capability-authority.ts`.
- Build the INV-4 owner `custody-release.ts` (`createCustodyRelease`), and `delegation-establishment.ts` (mint, on-behalf-of, seal, put, compensation through `releaseCustody`). Write `__tests__/custody-release.matrix.test.ts` with the owner rows (failing-delete row included) and the `delegation-establishment.ts` rows.
- This phase answers for the NFR-002 budgets: the CT-2 budget acceptance file (`capability-authority-budget.acceptance.test.ts`) must be green at this phase's Wave Gate, so a budget miss is found while the mint path is being built.
- **Files:** `adapters/capability-authority.ts`, `adapters/keycloak-broker.ts` (deleted), `adapters/broker-audit.ts`, `adapters/graph-capability.ts`, `domain/token-cache.ts`, `domain/capability-scope.ts` (deleted), `adapters/delegation-establishment.ts`, `adapters/custody-release.ts`, their tests, `__tests__/authority-mode.matrix.test.ts` and `__tests__/custody-release.matrix.test.ts`

### Phase 4: HITL authority continuity and approver (depends on Phase 3)

- Persist `authority` and `approvals` on `RunRecord`, and `entra` on the persisted user identity.
- `startRun` takes a plan and establishes delegation before the record exists, compensating through `releaseCustody` if record creation fails.
- `HitlRunServiceDeps` gains `releaseCustody` (no custody store). Call it from `settleRunOutcome`'s completed and failed arms, the corrupt-checkpoint settle and the evicted-record arm of `processRun`. Add these rows to `__tests__/custody-release.matrix.test.ts` (INV-4).
- `recordDecision` takes an `ApproverRef`, appends an `ApprovalRecord` and emits the `hitl-decision` audit record. `createApproveRunHandler` derives the `ApproverRef` from the middleware-built `AuthIdentity`, and `handleBotActivity` derives `teams-user{aadObjectId}`; CT-3 acceptance approves through both.
- The run executor builds its broker from `record.authority` only.
- **Files:** `hitl/types.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/run-executor.ts`, `http/handlers/runs.ts`, `hitl/adapters/bot/messages-handler.ts`, and tests (`hitl/__tests__/approver-authority.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`, `__tests__/custody-release.matrix.test.ts`)

### Phase 5: Admission and composition (depends on Phase 4)

- Parse the delegated header. Add admission to `run-dag.ts` (before the HITL fork and acquire) and sync establishment, with `releaseCustody` in the `finally` and on establishment failure. Add the `run-dag.ts` rows to `__tests__/custody-release.matrix.test.ts` (INV-4).
- Wire `entra-user-token-verifier.ts` into admission. This phase answers for the NFR-003 budget: the CT-1 budget acceptance file (`run-authority-admission-budget.acceptance.test.ts`, through `proxyToWorker` and the route) must be green at this phase's Wave Gate, as must the CT-1 proxy forwarding cases.
- Add the `run-authority-refused` HostError and the `authority-unavailable` HTTP mapping.
- Add the manifest authority block and extend the INV-2 matrix test with `manifest.ts`.
- Compose `selectCapabilityAuthority` in `host.ts`. Change the `executeDag` signature. Derive the origin in `node-context-factory.ts` from `RunAuthority`. Rewrite the broker-selection and node-context tests.
- **Files:** `http/delegated-token-header.ts`, `http/handlers/run-dag.ts`, `http/handlers/manifest.ts`, `domain/host-error.ts`, `domain/framework-error-http.ts`, `host.ts`, `adapters/node-context-factory.ts`, `__tests__/broker-selection.test.ts`, `__tests__/node-context-factory.test.ts`, `__tests__/handlers/run-dag-authority.test.ts`, `__tests__/handlers/manifest-authority.test.ts`, `adapters/__tests__/unwired-defaults.test.ts`, `__tests__/authority-mode.matrix.test.ts`, `__tests__/custody-release.matrix.test.ts`

### Phase 6: Cross-cutting verification and documentation (depends on Phase 5)

- Add the SC-007 credential sentinel scan. (The SC-011 budgets are no longer a Phase 6 benchmark: they are CT-2 and CT-1 acceptance files gated in Phases 3 and 5.)
- Rewrite `packages/host/docs/auth.md`, `docs/team-security-and-capabilities.md`, the provisioning runbook (both models, RBAC for Applications, Agent ID spike pass/fail, fallback selection, rollback, rotation, realm-before-host deploy order, broker-token purge) and spike #4. Add the new evidence template, `data-handling.md` and the sequence-diagram doc. Update the CONTEXT.md identity table and terms.
- Add `scripts/check-identity-docs.ts` with tests, wired into `scripts/verify.sh`.
- **Files:** `packages/host/src/__tests__/credential-sentinel-scan.test.ts`, `packages/host/docs/auth.md`, `packages/host/docs/data-handling.md`, `packages/host/docs/identity-chain-sequence.md`, `docs/team-security-and-capabilities.md`, `docs/runbooks/entra-fugue-agents-provisioning.md`, `docs/runbooks/identity-live-verification-evidence.md`, `docs/spikes/2026-06-10-spike-4-identity-chaining-e2e.md`, `CONTEXT.md`, `scripts/check-identity-docs.ts`, `scripts/__tests__/check-identity-docs.test.ts`, `scripts/verify.sh`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Framework taxonomy | format, retriability, kinds list | persisted round-trip via zod schema | every cause round-trips; formatted text never contains injected sentinel |
| Capability Catalog | parse faults name capability; `@ts-expect-error` on missing authority | boot composition with a data catalog refuses (SC-013) | parse∘serialize = id; any entry with missing/unknown authority refused |
| Identity Topology | each `IdentityConfigFault` seeded | `loadConfig` end to end with env fixtures | dark iff no `ENTRA_*`; faults list all offenders (not first); custody max ≤ run TTL |
| Realm Assertion Mint | body capture: `scope="entra-exchange <cap>"`, no `audience` | status mapping over a fake HTTP | inspection: refused iff aud lacks exchange audience or scope lacks either grant |
| Entra Agent Authority | per model: step order, `fmi_path`, T1 as assertion, `offline_access`, no `client_secret` | AADSTS classification table | — |
| Entra token verification | each refusal reason; RS256 only | lazyJwks rotation with an in-process JWKS | claims validation accepts iff all constraints hold |
| Run Authority Planner | each refusal variant | — | totality over (identity × requirements × presentation × legs); precedence order; binding iff oid ∧ tid equal |
| Delegated Custody (LC-1) | guards | Redis store (test-redis), memory store | no undeclared transition accepted; rotation never extends expiry; deleted absorbing; cipher open fails on any AAD field change |
| Capability Authority | gate zero-egress, mode dispatch, audit shape | both models through fakes; CT-2 budget file: cold host-added ≤ 10 ms p95, cache hit ≤ 5 ms p95 (NFR-002) | cache isolation and single-flight under fast-check scheduled interleavings (NFR-012) |
| Custody release (INV-4) | owner: idempotent delete, failing delete → `release-failed` + one log, never throws | matrix test: every sibling's run-ending path leaves custody absent; Redis store PX and tenant purge cover the two code-less removals | — |
| HITL continuity | ApproverRef mapping per identity variant | CT-3: approvals through `createAuthMiddleware` + `createApproveRunHandler` and through `handleBotActivity`; resume with expired inbound token (SC-006) via in-memory run store | — |
| Run Admission | refusal ordering (0 acquire, 0 startRun, 0 egress) | CT-1: full route via `createRouter` with fakes, and through `proxyToWorker` with an in-process UDS transport (delegated header forwarded, tenant header stripped); CT-1 budget file: admission ≤ 50 ms p95 (NFR-003) | — |
| Doc Lint | each banned phrase, status matrix presence, evidence gating | runs over the real doc set in `verify.sh` | — |
| Cross-cutting | — | SC-007 sentinel scan | sentinel injection over generated run shapes |

**Latency budget tests (NFR-002, NFR-003, SC-011).** The budgets gate the phases that build the code they constrain, as CT-2 (Phase 3) and CT-1 (Phase 5) acceptance files, not a trailing benchmark. Both use `acceptance/support/latency-budget.ts`: every realm, Entra and JWKS transport is an injected fake that resolves at once, so the measured time is host-added only; 50 discarded warm-up iterations (JIT, the first `lazyJwks` fetch that NFR-003 excludes, WebCrypto key import); then 500 timed samples with `performance.now()`; nearest-rank p95 compared with the budget, and the p95 printed so the evidence template can quote it. The cold-acquisition samples each use a fresh `createCapabilityAuthority` (built outside the timed region) so no cell is warm; the cache-hit samples reuse one warmed cell and also assert zero transport calls (NFR-001). The expected host cost is well under 1 ms per acquisition and a few ms per admission, so the 10, 5 and 50 ms budgets leave an order of magnitude of headroom for a loaded CI runner while still catching an accidental network call, a synchronous key derivation per call, or an uncached JWKS fetch. Loom accepts only FR and AS ids as acceptance anchors, so the budgets are anchored on AS-035 (NFR-002) and AS-036 (NFR-003), which loop-back 1 added to the spec to restate NFR-002's and NFR-003's automated-suite clauses. Testcases are named after the scenario they decide (`AS-035: cold host-added acquisition ≤ 10 ms p95 (agent-id, app)`, `AS-035: cache hit ≤ 5 ms p95, zero transport calls`, `AS-036: run-start validation ≤ 50 ms p95 through proxyToWorker`).

---

## Security & NFR Notes

- **Trust boundaries:**
  - The realm JWT is verified by the existing verifier.
  - The Entra user token is verified against Entra's JWKS for the configured tenant only. Issuer, tenant, audience, `scp`, version, `exp`/`nbf` and RS256 are all pinned.
  - Binding is an equality check on `oid` and `tid`.
  - The minted realm assertion is inspected, not trusted, before Entra egress.
- **Fail closed (NFR-010):**
  - Every leg, mode and model gap is either a boot refusal or `authority-unconfigured`.
  - No path falls back from `delegated` to `app`.
  - An unmapped DAG on a brokered host is a typed refusal, no longer a throw.
- **Credential hygiene (FR-022):**
  - The user token is wrapped in a `RedactedSecret` whose `toJSON` and `toString` return `[redacted]`.
  - Refresh credentials exist in plaintext only inside `custody-cipher.ts` calls.
  - Custody records hold ciphertext with AAD. A record replayed under another run or user fails to open.
- **Blast radius (NFR-011):** one blueprint, or one fallback app set, per deployment. Custody keys are per deployment and per tenant worker, held by the worker only (boundary A).
- **Supervisor UDS proxy:** forwards `X-Fugue-Delegated-Authorization` unchanged (it strips only `X-Fugue-Tenant`). `proxyToWorker` is a CT-1 runtime seam, and CT-1 acceptance asserts that the header is forwarded byte-identical, that a client-forged tenant header never reaches the worker, and that no proxy log line carries the token.
- **Deploy order:** the realm (with `entra_oid` and `entra_tid` claims) must deploy before the host, because the host 401s realm user JWTs without them. The runbook states this.
- **Performance:**
  - App cache hits make no network call (NFR-001).
  - Delegated cells are scoped to the run.
  - JWKS sets are cached by `lazyJwks` (NFR-003).
  - Single-flight is per cell key (NFR-012).
  - There are no internal retries (NFR-021).
- **Retention (FR-024):** `oid` and `tid` follow the existing run and audit retention. This is documented in `data-handling.md`.

---

## Verification

1. `bun run --cwd packages/framework typecheck && bun run --cwd packages/host typecheck`
2. `bun run --cwd packages/framework test` and `bun run --cwd packages/host test`: all green. The admin and team token tests are unchanged (SC-010).
3. `bun test packages/host/src/__tests__/acceptance/`: CT-1 to CT-3 green.
4. `bun scripts/check-doc-links.ts && bun scripts/check-identity-docs.ts`
5. `bun "/home/peterstorm/.dotfiles/.claude/local-marketplace/plugins/loom/engine/src/cli.ts" helper validate-lint-rules`, then the full-tier lint: INV-1 has zero hits.
6. The SC-011 budgets are part of step 3: `capability-authority-budget.acceptance.test.ts` and `run-authority-admission-budget.acceptance.test.ts` print their p95 values and fail above 10/5 ms and 50 ms.
7. Realm repo: the Maven tests in the Cross-Repo section pass. Live-tenant verification is the operator's job, using `docs/runbooks/identity-live-verification-evidence.md` (OOS-001).

**Operator prerequisites before Tasks are populated.** `.loom/verification-manifest.json` is schema 1 today. Two things need it upgraded:
- INV-2 and INV-4 (owned, with mutation verification) need schema 2 with an `affectedRunner`.
- The three contracts need a JUnit-reporting test check.

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

| Date | Change | By |
|---|---|---|
| 2026-11-24 | Initial plan, Approach A, decided under explicit user delegation | architecture-agent |
| 2026-11-24 | Loop-back 1 (plan alignment). JUDGE-1: the NFR-002, NFR-003 and SC-011 budgets are now CT-2 and CT-1 acceptance files (`capability-authority-budget`, `run-authority-admission-budget`) gated in Phases 3 and 5, anchored on the new spec scenarios AS-035 and AS-036 (Loom accepts only FR and AS anchors); the Phase 6 `identity-latency.bench.test.ts` is removed. OWN-1: a new owned INV-4 (owner `adapters/custody-release.ts`; siblings `hitl/service.ts`, `http/handlers/run-dag.ts`, `adapters/delegation-establishment.ts`; matrix test `custody-release.matrix.test.ts`) replaces `hitl/__tests__/custody-teardown.test.ts`. Siblings get `ReleaseCustody` and a narrowed store, and the CT-3 types gain the release types and an export binding. SEAM-1: `proxyToWorker` is a CT-1 runtime seam, and CT-1 acceptance submits through it. SEAM-2: `createAuthMiddleware`, `createApproveRunHandler`, `handleBotActivity`, `errorResponse` and `createCustodyRelease` are CT-3 runtime seams, and CT-3 acceptance approves through the route and the bot handler | architecture-agent |
