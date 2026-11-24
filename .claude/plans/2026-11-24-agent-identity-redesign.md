# Plan: Agent Identity Redesign (per-agent Entra identity, per-capability authority mode)

**Spec:** .claude/specs/2026-11-24-agent-identity-redesign/spec.md
**Created:** 2026-11-24
**Spec ids:** the architecture phase renumbered three non-canonical ids so the spec parses: AS-013a is AS-033, AS-026a is AS-034, FR-019a is FR-025.

## Summary

Only an agent's own identity federates into Entra. The host requests every realm assertion with `entra-exchange <capability>`. It hands that assertion to a model-polymorphic `EntraAgentAuthority` port, with one adapter for Entra Agent ID (blueprint plus agent identity) and one for per-agent app registrations. Each capability declares `app` or `delegated` in one typed catalog that has no default. A pure run-start planner turns the caller's identity, the DAG's requirements and the catalog into a `RunAuthority` before the HITL fork or a concurrency slot. A boot-scoped `CapabilityAuthority` hands each run a broker and its invocation origin, both derived from that one `RunAuthority` (`forRun`, called only by the run-authority lifecycle, once per execution bracket), which replaces the process-global subject-token registry and the RFC 8693 user exchange; both are deleted. Delegated mode does one on-behalf-of exchange at admission. It then keeps only the run-bound refresh credential, AES-256-GCM sealed under a three-state custody lifecycle (LC-1). The credential is read and written only by the run's single custody cell, a thin sequencer over one pure decision function. One run-authority lifecycle owns establishment, the per-bracket minting handle and release at every terminal state. Every acquisition path returns only the faults it can produce. The realm changes in the Keycloak config-as-code repository are specified in their own section and run outside the task graph.

> **Decided under explicit user delegation.** The user said: "im gonna go to bed, you just run the whole loom workflow please, and during interview, just pick the most correct, best, most functional approach, for all questions ok". Earlier the user also said "I want the most correct solution to the agent auth problem" and "we can change config code as well of course, to make it fit". No interview was held. The answers below are the architect's, and each is logged in `clarifications/log.md` under "Architecture phase decisions" for the user to review.

---

## Self-Interview (architecture questionnaire, answered under delegation)

| # | Topic | Answer |
|---|---|---|
| 1 | Scope and slicing | Everything in the spec is built: P1 (agent path, `app` mode, per-agent identity, docs) and P2 (`delegated` mode, continuation). The FR-033 realm hardening (P3) is specified for the realm repo. Phases follow dependency order, not priority, because delegated mode reuses every P1 seam. |
| 2 | Where the authority mode lives | In one code-defined `CAPABILITY_CATALOG`. The `satisfies` clause requires the `authority` field, so a capability without one does not compile. `parseCapabilityCatalog` is the only producer of the branded `CapabilityCatalog`. Boot has one catalog entry point: `createHost` calls `loadCapabilityCatalog(deps.capabilityCatalog ?? CAPABILITY_CATALOG)`, so the code catalog is only the default raw source and passes through the same parser at every boot, and `HostDeps.capabilityCatalog?: unknown` injects a data-sourced catalog. A data catalog with an entry lacking a mode makes `createHost` return the `capability-catalog-invalid` HostError naming the capability, before any capability connects or the server binds (AS-009, SC-013; `boot-capability-catalog.test.ts`). Nothing parses a catalog at module load. Since design-review loop-back 6, node requirement strings are parsed against the catalog in admission pass 1 by `classifyCapabilities`. A requirement in a brokered namespace that the catalog lacks is the `capability-unknown` refusal, first in the precedence order, so `authorityOf` takes a catalog-minted `CapabilityScope` and is total. |
| 3 | Identity model selection | `ENTRA_IDENTITY_MODEL` is `agent-id` or `app-registration` and has no default. It parses into the `EntraDirectory` ADT, and the variant decides which adapter is built. Capability and DAG definitions never see the model (SC-008). |
| 4 | Boot-time strictness | Each leg is gated on its own presence keys, as AS-013, NFR-020 and the clarify log require ("each leg lights up only when its config is complete, and partial config stays fail-closed with an actionable warning"). The Entra identity leg is **configured** iff both presence keys `ENTRA_TENANT_ID` and `ENTRA_AGENT_IDENTITIES` are set. With neither, or only one, it is dark and fail-closed, and the boot warning names each missing presence key and each `ENTRA_*` key it ignored. Once configured it must be complete and consistent, or boot is refused naming every offender: no `ENTRA_IDENTITY_MODEL` (AS-033), a mapped agent client with no Entra identity (AS-013), a blueprint missing or forbidden for the model, orphaned or shared identities. The delegation leg is configured iff `DELEGATED_CUSTODY_KEYS` is set; when configured over a dark Entra leg it is dark with a warning, not refused. Malformed values (a custody keyring that is not 32-byte keys with `active` among them, or a non-positive-integer `DELEGATED_CUSTODY_MAX_SEC`) are refused at `loadConfig` whatever the leg state, like every other malformed key. The removed `ENTRA_CLIENT_ID` is refused by name with a migration hint, because a leftover shared-app key would otherwise go silently dark. |
| 5 | Where run-start validation happens | In `run-dag.ts`, after input-schema parsing and before `hitl.startRun` and concurrency `acquire`. Admission is two pure passes around one optional I/O step (since design-review loop-back 5). The static pass decides every refusal that needs no token verification, in the frozen precedence order. Only when it returns `verify-delegated` does the shell verify the Entra token against the JWKS. That step is reachable only when delegation is required, the header is present and well-formed, the Entra leg is wired, the agent is mapped, and the expected audience is known. The second pass consumes the verified or rejected presentation. A statically refusable submission makes zero JWKS calls. |
| 6 | How the delegated user token arrives | In the `X-Fugue-Delegated-Authorization: Bearer <entra-jwt>` request header, next to the realm `Authorization` header. This follows the repository's `X-Fugue-*` naming. The supervisor UDS proxy already forwards headers it does not strip. The header is refused (400) on runs that need no delegation, so callers never send a bearer token that is not needed. The manifest publishes, per DAG, whether the header is required and which audience it must carry. |
| 7 | Binding the two tokens | The realm user JWT must carry `entra_oid` and `entra_tid`, which become required claims of `AuthenticatedUser`. The Entra token's `oid` and `tid` must equal them. The Entra token must also carry `scp`, which proves it is a delegated user token and not an app-only token. Its `tid` must equal the deployment tenant (OOS-005), and its `aud` must equal the expected delegated audience: the blueprint client id (agent-id model) or that agent's app id (app-registration model). The expected issuer is derived from the tenant by `issuerFor(tenant)`, never carried beside it (design-review loop-back 6). |
| 8 | Delegated continuation | One on-behalf-of exchange with `offline_access` at admission, then run-bound custody of the refresh credential. The credential is AES-256-GCM sealed, with AAD = (runId, agentClientId, oid, tid, expiresAtMs) and a `kid` for rotation. The AAD is the `CustodyBinding`, which `custodyBindingOf(authority)` derives from the run's `RunAuthority`, the one canonical value; since design-review loop-back 6 the `user-delegated` authority carries the `runId` too, so the store key, the AAD and the PX all come from it. The custody record stores no binding, so the sealed AAD and the record cannot diverge (since design-review loop-back 5). Custody expiry is fixed at establishment as min(now + custody max, run deadline), held only on the immutable `RunAuthority`, and never extended, including on rotation. Instants are branded `EpochMs` and durations `DurationMs`. The custody max is a branded `CustodySeconds`, whose only constructor parses it against `HITL_RUN_TTL_SEC`. The custody max is `DELEGATED_CUSTODY_MAX_SEC`: optional, a positive integer number of seconds, at most `HITL_RUN_TTL_SEC`. Unset, it is min(604800, `HITL_RUN_TTL_SEC`); `HITL_RUN_TTL_SEC` defaults to 604800, so the out-of-the-box cap is exactly 7 days and is never unbounded (FR-017, AS-026). A value that is not a positive integer is refused at `loadConfig`; a value above `HITL_RUN_TTL_SEC` is the boot refusal `custody-max-exceeds-run-ttl`. Custody is deleted at every terminal state. |
| 9 | Key management | `DELEGATED_CUSTODY_KEYS` (JSON: `active` kid plus kid to base64 32-byte key) arrives through the worker secrets source and is never handled by the supervisor (boundary A). Rotation adds a kid and switches `active`; old kids stay until the custody max has elapsed. |
| 10 | Error taxonomy | A new framework kind `authority-unavailable{scope, agentClientId, cause}`, which is non-retriable, with the causes `federation-grant-missing`, `authority-unconfigured`, `federation-rejected` and `reauthorization-required`. Transient failures stay `infra-unreachable` and are not retried internally (NFR-021). Run-start refusals are a host `run-authority-refused` error carrying the frozen `RunAuthorityRefusal` ADT. Since design-review loop-back 5, every acquisition failure (realm mint, Entra, custody, establishment) is one `AcquisitionFault` ADT, produced from token-endpoint responses by one pure classifier. Two total, exhaustive projections turn it into the framework error and into `RunAuthorityRefusal`. Since design-review loop-back 6, each path is typed with only the subset it can produce: `AppAcquisitionFault` for the realm mint and app acquisition, `EstablishmentFault` for establishment, and the full `AcquisitionFault` only for the custody cell's redeem. `unreachable` carries a closed cause (`status`, `timeout` or `network`), never free text. |
| 11 | Caching and concurrency | App tokens use boot-scoped single-flight cells keyed by (Entra identity, `app`, capability). Delegated tokens use run-scoped cells keyed by (Entra identity, `delegated`, user oid, capability), which live inside the `forRun` closure and die with the run. Since design-review loop-back 5, every delegated cell reads through one run-level single-flight custody cell, the only reader and writer of the run's custody. It serializes get, open, redeem and rotate, and a generation-fenced compare-and-swap covers any writer outside the process. Since design-review loop-back 6 the cell is its own module (`adapters/run-custody-cell.ts`), a thin sequencer over the pure `decideRedeemStep`. The store, not the caller, assigns each written generation. The per-run handle that holds the cell is built once per execution bracket by the run-authority lifecycle, the only caller of `forRun`. Capability stays in the key so the realm, as the policy decision point, is consulted per capability (AD-5). |
| 12 | HITL approver vs initiator | Approval lends no authority. `recordDecision` takes a typed `ApproverRef`; the run record appends an `ApprovalRecord`, and a `hitl-decision` audit record names approver and initiator separately. After resume, the run rebuilds its `RunAuthority` only from the persisted record. |
| 13 | Testing and verification | Fakes for every port; fast-check property tests for the planner, the binding, catalog parsing, custody transitions and cache isolation; sentinel-credential assertions (FR-022, SC-007) inside each contract's acceptance over the production composition, since loop-back 4 (FR-022 in CT-2, AS-037 in CT-1, AS-038 in CT-3, AS-039 in CT-4); and latency budget tests with injected transports (SC-011), which since alignment loop-back 1 are acceptance tests of CT-2 (acquisition, Phase 3) and CT-1 (admission, Phase 4 since design-review loop-back 5). Live-tenant evidence belongs to the operator (OOS-001). |
| 14 | Executable models | One lifecycle (custody, LC-1; since design-review loop-back 6 only the persisted states `absent`, `held` and `revoked`). Invariants: the RFC 8693 prohibition (checkable); single-source authority mode (owned); no credential material in observable surfaces (advisory); since alignment loop-back 1, custody release at every terminal state (owned, INV-4), which since design-review loop-back 5 is one run-authority lifecycle that owns both establishment and release, and since loop-back 6 also builds each execution bracket's minting handle; and, since loop-back 4, one source for the delegated audience (owned, INV-5). Four contracts (CT-4 since alignment loop-back 2). No Pipeline: this is not a fugue DAG feature. |

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

**Choice:** A boot-scoped `CapabilityAuthority` with `forRun(run: BrokeredRunAuthority): RunMintingAuthority`, where `RunMintingAuthority = Pick<MintingAuthority, "broker" | "origin">`. Each run's broker is a closure over an immutable `RunAuthority` value that admission produced (sync path) or that was rebuilt from the persisted run record (HITL path). The run-authority lifecycle (AD-6) is the only caller of `forRun` (design-review loop-back 6). It builds exactly one handle per execution bracket (a sync run, or one HITL slice) and hands it to the bracket's body, so one custody cell per run is structural, not caller discipline. A delegated run's `runId` is carried on its `user-delegated` authority, so the cell's custody key and AAD come from the one value `forRun` closes over. The origin beside it is `originOf(run)`, the one function that derives an `InvocationOrigin`. Nothing stores an origin next to an authority, so the two cannot disagree. The broker takes identity only from its closure and never reads `inv.origin`, so the per-invocation `agentClientIdFromFrameworkOrigin` re-check is removed (design-review loop-back 5). The following are deleted outright (CONTEXT.md Key Invariant 8, no shims): `SubjectTokenRegistry`, `SubjectToken`, `markSubjectToken`, `subjectTokenForIdentity`, `exchangeV2`, `buildExchangeV2Body`, `TOKEN_EXCHANGE_GRANT_TYPE`, `inertResolveSubjectToken`, `withSubjectTokenRelease` and the `bindSubjectToken` option.
**Why:**
- A run's authority is a fact, not a resource to bind and release. As a value it cannot leak across runs.
- It persists with the HITL record (FR-016, FR-020) and needs no teardown discipline.
- FR-003 and FR-004 hold by construction, because no code path can reach a user token on an `app` run.
**Rejected:**
- A process-global `RunAuthorityRegistry` (Approach B): mutable shared state and release discipline.
- Keeping `exchangeV2` "for later": FR-003 forbids user exchange for every origin and mode.

### AD-2: Authority mode is part of the capability definition, in one catalog with no default

**Choice:** `domain/capability-catalog.ts` holds `CAPABILITY_CATALOG` (`as const satisfies Record<string, CapabilityDefinitionInput>`, where `authority: "app" | "delegated"` and `resource: "graph" | "dynamics"` are both required). `parseCapabilityCatalog(raw: unknown): Result<CapabilityCatalog, readonly CatalogFault[]>` is the only constructor of the branded catalog. `authorityOf(scope: CapabilityScope): AuthorityMode` is the only reader of a mode (INV-2), and it is total (design-review loop-back 6). Only the catalog module mints a `CapabilityScope`, from a key of a parsed catalog, and the scope carries its definition under a module-private symbol, so no scope exists for which the mode is unknown. Node requirement strings are parsed at the boundary, in admission pass 1, by `classifyCapabilities(catalog, raw)`. Each requirement becomes one of three classes:
- `brokered{scope}`: a catalog key.
- `not-brokered`: a namespace no catalog key uses, such as `http` or an ADR-0051 custom `mycorp:widget`, which other capability providers serve.
- `unknown`: a brokered namespace (`msgraph:`, `dynamics:`, or any namespace a data catalog introduces) whose key the catalog lacks.

Any `unknown` is the `capability-unknown` refusal (503), which names every offending node and capability and comes first in the refusal precedence. So an undeclared capability never silently defaults to `app` and never reaches the mint gate (FR-005: a capability without a mode is unrepresentable; NFR-010: no gap degrades into broader authority). The mint-time gate takes the same classification, and its `unknown` arm is defense in depth, unreachable after admission. `capability-scope.ts` folds into the catalog and is deleted, and `KNOWN_SCOPES` and the derived handle types are re-derived from catalog keys. All three existing capabilities declare `app`. The catalog a host runs with is chosen and parsed once, at boot: `loadCapabilityCatalog(source: unknown): Result<CapabilityCatalog, HostError>` wraps `parseCapabilityCatalog` and maps its faults to the `capability-catalog-invalid{faults}` HostError, and `createHost` calls it with `HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG` right after startup. The one parsed value is then handed to the capability gate, `composeRunAuthorityWiring` (input `catalog`) and the manifest handler, so a data-sourced catalog reaches every INV-2 sibling, and the delegated test capabilities that prove delegated mode (OOS-004) enter through the same parser.
**Why:**
- FR-005 and SC-013: a mode can neither be omitted nor defaulted.
- A single reader makes the planner, the gate, the mint path and the manifest agree by construction, and the INV-2 matrix test proves it.
**Rejected:**
- A mode map beside `KNOWN_SCOPES`: two tables can drift.
- A mode on the DAG node's `requires`: it is a capability property, not a per-use choice, and it would leak into the framework.
- Defaulting to `app`: a silent default is how authority widens.
- `authorityOf(catalog, scope): AuthorityMode | undefined` over a raw scope string (the plan before loop-back 6): every caller had to decide what `undefined` means, which is how a mode gets invented. Rejecting unknown requirements only at DAG load was also considered; admission pass 1 gives the refusal a defined place in the precedence order, reads the same `runtimeNodeInventory` every other admission decision reads, and keeps every run-start refusal in one total function.

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

### AD-5: Two-pass run-start admission: a pure static pass, verification only on demand, a pure completion pass

**Choice:** In `domain/run-authority.ts`, two pure functions surround the one I/O step (design-review loop-back 5).
- **Pass 1, static.** `planRunAuthority(input: RunAuthorityInput): Result<AdmissionStep, RunAuthorityRefusal>`. Its input:
  - the `AuthIdentity`
  - the DAG's agent client mapping (`AgentClientId | unmapped`)
  - the raw `(nodeId, capability)` requirements (`RawCapabilityRequirement`) from the framework's `runtimeNodeInventory`, newly exported from the barrel
  - the catalog
  - the brokering state (`brokered{entra: wired{directory} | dark; delegation: wired | dark{missing}} | unbrokered`)
  - the parsed header (`DelegatedHeader`: `absent | present{token: RedactedSecret} | malformed`)
  
  It first parses the raw requirements with `classifyCapabilities` (AD-2). It then decides, in precedence order, every refusal that needs no signature or claim check:
  1. `capability-unknown` (since design-review loop-back 6)
  2. `agent-client-unmapped`
  3. `delegated-capability-requires-user`
  4. `delegated-token-unexpected`
  5. `delegation-unconfigured`
  6. `delegated-token-required`
  7. `delegated-token-invalid{malformed}` (a malformed header)

  Otherwise it returns one of two steps:
  - `AdmissionStep.decided{plan}`, for every run that needs no delegation.
  - `AdmissionStep.verify-delegated{token, expect, pending}`. `expect: DelegatedTokenExpectation = {tenant, audience}` is a brand that only pass 1 builds, from the wired directory and `delegatedAudienceFor` (INV-5). So the type admits verification only when the directory, the agent and the expected audience all exist. The expectation carries no issuer: the issuer is derived from the tenant by `issuerFor(tenant)` wherever it is checked, so the two cannot disagree (design-review loop-back 6).
- **I/O, only on demand.** For `verify-delegated` alone, the shell (`run-authority-admission.ts`) calls `verifyEntraUserToken(step, jwks, signal)`. This is a plain adapter function in `adapters/entra-user-token-verifier.ts`, with no domain port: it has exactly one implementation, and the seam a test fakes is the JWKS transport beneath it (design-review loop-back 6). Its first parameter is the `verify-delegated` step itself, so verification is reachable only from a step that pass 1 produced. It checks the signature against the tenant JWKS through `lazyJwks` and returns a `DelegatedPresentation`: `signature-verified{claims: unknown}` (the claims only, never the token) or `signature-rejected{reason: "malformed" | "signature"}`.
- **Pass 2, completion.** `admitDelegatedPresentation(step, presentation, nowMs: EpochMs): Result<Extract<RunAuthorityPlan, {kind: "user-delegated-pending"}>, RunAuthorityRefusal>`. It runs `validateEntraUserTokenClaims` and then `bindDelegatedPrincipal`, which yield `delegated-token-invalid{reason}` and then `identity-binding-mismatch`, the last two places in the order. It builds the `VerifiedDelegationGrant` from `step.token` and the validated claims, so the token has one source: the header that pass 1 parsed.
- `run-dag.ts` calls `admitRunAuthority`, which composes the three steps, after input-schema parsing and before `hitl.startRun` and concurrency `acquire`. A refusal maps to the `run-authority-refused` HostError and its HTTP status.
**Why:**
- AS-010, AS-021 to AS-023, FR-006 to FR-009 and SC-003/SC-004: every refusal happens before node execution, slot acquisition or token egress.
- A statically refusable submission makes no JWKS egress. A request whose higher-precedence refusal is static, such as a team token on a delegated DAG or a dark delegation leg, cannot be turned into a probe of Entra's key endpoint, and is never answered with a lower-precedence `delegated-token-invalid`.
- Both passes are total functions over closed unions. A property test over the pure composition (pass 1, then pass 2 over every generated presentation, no fakes) asserts that the full precedence order is preserved. `run-authority-admission.test.ts` and CT-1 count requests on the JWKS transport, the real seam, and the count is zero whenever pass 1 refuses or decides.
- It also replaces the `throw` for unmapped DAGs in `node-context-factory.ts` with a typed refusal.
**Rejected:**
- One planner over an already-verified presentation, which the plan used before loop-back 5. It verified against the JWKS before the static refusals that outrank it, so it made egress on refusable requests and needed a hedge (`present-unverified`) for an unwired leg.
- A `VerifyEntraUserToken` domain port, which the plan used before loop-back 6. It had one adapter and no second implementation, so it failed the deletion test: removing it loses nothing, and tests fake the JWKS transport instead.
- Returning the token inside `signature-verified` (before loop-back 6): it gave pass 2 two token sources, the step's and the presentation's.
- Validating inside `createNodeContextForDag`: that runs after concurrency acquisition.
- Validating in framework preflight: see Approach C.

### AD-6: Delegated authority is established eagerly at admission and continued through encrypted run-bound custody

**Choice:**
- Admission yields `user-delegated-pending{grant}`. One operation owns the bracket from establishment to release. It is the run-authority lifecycle (`createRunAuthorityLifecycle` in `adapters/run-authority-lifecycle.ts`, the INV-4 owner), which `composeRunAuthorityWiring` builds once (design-review loop-back 5):
  - **Sync runs.** After the concurrency slot is acquired, the route makes one call: `withEstablishedAuthority(plan, runId, deadlineMs, body)`. The lifecycle establishes, builds the bracket's one minting handle with `capabilityAuthority.forRun`, runs `body(run)` with that `AuthorizedRun{authority, minting}` (context creation and execution), and releases in its own `finally`. It derives the release cause from the body's `SyncRunEnding` (`completed | failed | aborted`), and from `failed` when the body rejects; the rejection is rethrown. An establishment failure is released by the lifecycle and returned as `Err(RunAuthorityRefusal)`, and the route then releases its slot.
  - **HITL runs.** Establishment and release are split across suspension, so the lifecycle exposes the two halves. `startRun` makes one call, `establishForRecord(plan, runId, deadlineMs, persist)`. It establishes, then runs `persist(authority)`, which creates the run record with the authority on it, and releases if either step fails. `processRun` folds every path (completed, failed including a rejected gate, corrupt checkpoint, evicted record) into one `HitlRunEnding` and makes one call, `endRun(runId, ending)`, after the fold.
  - **HITL slices.** Each slice the run executor processes runs inside one `withRecordedAuthority(record.authority, body)` call (design-review loop-back 6). It builds the slice's one minting handle from the persisted authority and hands `body` the `AuthorizedRun`; it neither establishes nor releases. Slices of one run are serialized by the queue lease, so at most one handle, and one custody cell, exists for a run in a process at a time.
  - **The only `forRun` caller.** The lifecycle receives `capabilityAuthority` from the wiring and is the only module that holds `forRun`. `RunAuthorityWiring` no longer exposes the capability authority, so no route, executor or test can build a second handle, and a second custody cell, for a run (design-review loop-back 6).
  - For a non-delegated plan, establishment is the identity. Release is still unconditional and idempotent, so no caller decides whether a run "had" custody.
- `establishDelegation` (CT-3) runs inside the lifecycle. It computes the expiry and builds `RunAuthority.user-delegated{delegation: {runId, audience, custodyExpiresAtMs}}`. It then derives `custodyBindingOf(authority)` (the AAD; every field, `runId` included, comes from the one authority since design-review loop-back 6), mints the realm assertion, performs on-behalf-of with `offline_access`, seals the refresh credential (`adapters/custody-cipher.ts`, AES-256-GCM), and stores it through `DelegatedCustodyStore.put(binding, held{sealed})`. The store keys the record `fugue:<tenant>:authority:custody:<binding.runId>`, writes generation 0 and sets PX at `binding.expiresAtMs`, so the key, the AAD and the expiry come from one value. It returns the authority. It has no compensation of its own. Any `Err`, an ambiguous `put` included, returns to the lifecycle, which releases.
- The verified user token is wrapped in a `RedactedSecret` and dropped as soon as establishment returns.
- The binding's expiry is `custodyExpiryFor(now: EpochMs, max: CustodySeconds, runDeadline: EpochMs): EpochMs = min(now + custodySecondsToMs(max), runDeadline)`. `max` is the wired `DelegationLeg.maxSec`: `DELEGATED_CUSTODY_MAX_SEC`, or min(604800, `HITL_RUN_TTL_SEC`) when unset, parsed once into `CustodySeconds`. The run deadline is the sync route's timeout deadline or, for a HITL run, establishment + `HITL_RUN_TTL_SEC`. With every key at its default the cap is 604800 s (7 days). The brands make an instant, a duration and a count of seconds impossible to mix.
- Redeeming refreshes through the agent identity, inside the run's single-writer custody cell. The cell is its own module, `adapters/run-custody-cell.ts`, a thin sequencer over the pure `decideRedeemStep` in `domain/delegated-custody.ts`, which holds the whole outcome table (Component Design, Delegated Custody; design-review loop-back 6). A rotated refresh token is re-sealed and written by `swap(runId, expected, next)`. The store writes `next` with generation `expected + 1` itself, and `next` is a `CustodySuccessor` with no generation field, so no caller can name a written generation and the compiler enforces the fence. The expiry cannot be extended, because no custody record carries one: the only expiry is the immutable `RunAuthority`'s.
- If Entra refuses, custody moves to `revoked`, and the capability fails `authority-unavailable{cause: reauthorization-required{refused}}` with no `app` fallback. Once the authority's expiry has passed, the capability fails `reauthorization-required{custody-expired}` with zero store reads and zero Entra calls. A custody record missing before that expiry (released, evicted or purged) is `custody-absent`. The store keeps PX at the binding expiry and returns `absent` for a missing key, and the expired-versus-absent distinction is made against the expiry the `RunAuthority` carries. So the initiator gets the accurate reason, and no ciphertext outlives the cap.
- Only the lifecycle owner is handed the store's `delete`. Each sibling receives a narrowed lifecycle: `run-dag.ts` gets `Pick<RunAuthorityLifecycle, "withEstablishedAuthority">`, `hitl/service.ts` gets `Pick<RunAuthorityLifecycle, "establishForRecord" | "endRun">`, and `hitl/adapters/run-executor.ts` gets `Pick<RunAuthorityLifecycle, "withRecordedAuthority">`. None holds a store or `forRun`, so no sibling can delete custody another way or build a second custody cell. The custody cell holds only `get` and `swap`, and `swap` never creates or deletes. Two removals need no code path and so are not siblings:
  - a run record evicted by Redis TTL while idle. Custody PX is the binding expiry, fixed at establishment and at most `HITL_RUN_TTL_SEC`, so custody expires no later than the record.
  - tenant purge. `purgeTenantKeyspace` reclaims `fugue:<tenant>:*`, custody keys included.
**Why:**
- The user token is touched once and never persisted. Only an agent-bound, encrypted, revocable refresh credential is held, which meets FR-017, FR-023 and AS-026 to AS-027.
- Entra enforces revocation at every refresh.
- The HITL approval channel cannot carry a fresh user token, so lazy delegation would break resume.
- One bracket owner means no caller pairs an establishment with a release by hand or chooses a release cause, and a new run-ending path is a new `SyncRunEnding` or `HitlRunEnding` variant, which the owner's exhaustive cause derivation must handle.
- The same owner builds the bracket's minting handle, so "one custody cell per run" holds by construction: only the lifecycle holds `forRun`, and it calls it once per bracket.
- The redeem outcome table is a pure function, so every row is property-tested with no fakes, and the I/O cell that runs it is a sequencer with no decisions of its own.
**Rejected:**
- A free-standing `releaseCustody(runId, cause)` called at eight sites, which the plan used before loop-back 5. It was a shallow module: every caller paired establishment with release and picked the cause itself.
- The custody cell inside `capability-authority.ts` with its outcome table in prose (before loop-back 6): the decisions lived in an I/O adapter, testable only through fakes, and the capability authority became a god-module.
- `forRun(run)` without a run id on the authority, called by each executor (before loop-back 6): the cell had no source for its key and AAD, and one cell per run depended on each caller calling `forRun` once.
- Routing release through the custody machine: release is a `DEL` of the whole record whatever its state, so a `teardown` event would be a transition no persisted state ever shows. LC-1 is the persisted lifecycle only (Lifecycles).
- Lazy on-behalf-of at first use: the raw user token would be held until then, and a HITL gate before first use would make the run unresumable.
- The approver re-presenting a token (Option B in the clarify log): rejected in clarify.
- Storing the access token only: it expires in about an hour, which is shorter than the 7-day suspension window.

### AD-7: Inbound delegated-token contract and identity binding

**Choice:**
- The header is `X-Fugue-Delegated-Authorization: Bearer <compact JWT>`.
- `domain/entra-user-token.ts` is pure. `validateEntraUserTokenClaims` checks:
  - `iss = issuerFor(tenant)`, which is `https://login.microsoftonline.com/{tenant}/v2.0`. `issuerFor` in `domain/entra-user-token.ts` is the one derivation; the claim validator and the verifier both call it, and `DelegatedTokenExpectation` carries only the tenant (design-review loop-back 6).
  - `tid` equals the deployment tenant
  - `aud` equals the expected audience
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
- Add the framework kind `authority-unavailable{scope, agentClientId, cause}`. The cause is one of:
  - `{kind: "federation-grant-missing"; grants: readonly string[]}`
  - `{kind: "authority-unconfigured"; missing: readonly string[]}`
  - `{kind: "federation-rejected"; reason: "issuer" | "subject" | "audience" | "unknown"}`
  - `{kind: "reauthorization-required"; reason: "refused" | "custody-expired" | "custody-absent"}`
- It is non-retriable. These change with it, in the same Phase 1 Task (Phase boundary rule: a widened union and its exhaustive matchers change together): `FRAMEWORK_ERROR_KINDS`, the persisted zod schema, `formatFrameworkError`, `retriabilityOf`, and the host's `classifyFrameworkError` HTTP mapping in `domain/framework-error-http.ts` (grant-missing 403, unconfigured 503, federation-rejected 502, reauthorization-required 401).
- **One acquisition-fault vocabulary (design-review loop-back 5), typed per path (loop-back 6).** Every host adapter on the acquisition path returns one family of ADTs, declared once in the CT-2 types as `AcquisitionFaultOf<H, R>` over the hops `H` it can reach and the re-authorization reasons `R` it can produce. This covers the realm mint, the Entra authority, the unwired adapters, the custody cell and `establishDelegation`. It replaces the former `AssertionFault`, `EntraAcquisitionFault` and `DelegationEstablishmentFault`, and the free-standing reason list of `delegation-not-established`. Its variants:
  - `grant-missing{grants}`
  - `unconfigured{keys, why: absent | rejected}`
  - `federation-rejected{reason, aadsts?}`
  - `reauthorization-required{reason: R}`, present only when `R` is not `never`
  - `unreachable{hop: H, cause: UnreachableCause}`, where `UnreachableCause = {kind: "status"; status} | {kind: "timeout"} | {kind: "network"}`. The cause is closed: no free string can carry response text or a credential into an error value, so INV-3 for faults holds in the type. Text is rendered only at formatting, by `frameworkErrorOf`, from the status number and fixed words.

  Each path is typed with exactly the subset it can produce, so an unreachable state is unrepresentable:
  - `AppAcquisitionFault = AcquisitionFaultOf<"realm" | "entra", never>`: the realm mint and `acquireApp`. No `reauthorization-required`.
  - `DelegatedGrantFault = AcquisitionFaultOf<"realm" | "entra", "refused">`: on-behalf-of and refresh at the Entra token endpoint. Entra can refuse; it cannot report custody state.
  - `EstablishmentFault = AcquisitionFaultOf<"realm" | "entra" | "custody-store", "refused">`: `establishDelegation`. No `custody-expired` or `custody-absent`, because no custody exists before establishment.
  - `AcquisitionFault = AcquisitionFaultOf<"realm" | "entra" | "custody-store", ReauthorizationReason>`: the full set, produced only by the custody cell's redeem.

  Two total projections in `domain/acquisition-fault.ts` are the only translations, each matched with `.exhaustive()` over its own domain:
  - `frameworkErrorOf(fault: AcquisitionFault, scope, agent): FrameworkError` gives `authority-unavailable{cause}`, or `infra-unreachable` for `unreachable`. Every subset is assignable to its domain. It is applied only in `capability-authority.ts`.
  - `runAuthorityRefusalOf(fault: EstablishmentFault): RunAuthorityRefusal` gives `delegation-not-established{reason}`, whose reason union has no custody reason. It is applied only in `run-authority-lifecycle.ts`.

  Each projection is applied in exactly one module, so neither is an owned invariant. Their exhaustiveness and a property test ("every fault of each subset projects; `unreachable`, and only it, is retriable") hold them.
- **One classifier.** `classifyTokenEndpointError` in `domain/token-endpoint-error.ts` is the only reading of a realm or Entra token-endpoint error response. It is pure, has one decision table and is property-tested once. Both HTTP adapters import it. Its type is overloaded by grant: a `client_credentials` response classifies to `AppAcquisitionFault`, and an `on-behalf-of` or `refresh` response to `DelegatedGrantFault`, so the app path cannot receive a re-authorization fault.
  - Realm `invalid_scope` gives `grant-missing`.
  - Realm `invalid_client` and other client-authentication 4xx give `unconfigured{why: rejected}`, a configuration fault that retrying cannot fix.
  - AADSTS 70021, 700211, 700212 and 700213 give `federation-rejected`.
  - `invalid_grant`, `interaction_required` and `consent_required` on on-behalf-of or refresh give `reauthorization-required{refused}`.
  - 429, 5xx and timeouts give `unreachable`.
  - The classifier copies only error codes, never response text, into the fault.
- Unwired legs now map to `authority-unconfigured`, no longer to the retriable `infra-unreachable`.
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
- `PersistedIdentity`'s `user` gains `entra` in Phase 2, in the same Task that makes the live identity's `entra` required, so the persisted and the live user carry the same realm principal (design-review loop-back 6). In the Phase 4 cut-over `RunRecord.authority: RunAuthority` replaces `RunRecord.identity`, and `RunExecutionRequest.authority` replaces `RunExecutionRequest.identity`, so the initiator has one persisted source; `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are then deleted. Phase 5 adds `approvals: readonly ApprovalRecord[]`.
- The Teams approver is not an `AuthIdentity`. `approverTeamIdentity(map, aadObjectId)` returns a `TeamsApprover = {kind: "teams-approver"; aadObjectId; canRunDag}` (declared in `domain/auth.ts`), and `canAccessDag` takes `AuthIdentity | TeamsApprover`. A card click carries no realm principal, so it is never given a fabricated `entra`, it cannot start a run or be persisted as an initiator, and the `user` variant carries `entra` only where a realm user exists (design-review loop-back 6). Phase 5 maps it to `ApproverRef.teams-user{aadObjectId}`.
- Each decision emits a `hitl-decision` audit record with the initiator and the approver.
- `run-executor.ts` rebuilds the run's broker only from `record.authority`, through the lifecycle's `withRecordedAuthority`.
**Why:** FR-025 and AS-028. The type makes it impossible to derive authority from the approver.
**Rejected:**
- Overloading `HumanAction.actor` (a free-form string): it cannot carry the Entra principal and conflates display with identity.
- Keeping the Teams approver as a `user` `AuthIdentity` (before loop-back 6): once `entra` is required it would need a fabricated realm principal, and nothing would stop it from reaching run submission or the run record.
- Keeping both `RunRecord.identity` (with `user.entra`) and `RunRecord.authority` after the cut-over: two persisted copies of the initiator that could diverge.

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

Their adapters live in `adapters/`. Each port has at least two implementations (HTTP and unwired for the mint and the Entra authority, Redis and memory for the store). The Entra user-token verifier has one implementation, so it is not a port: `verifyEntraUserToken` is a plain adapter function and the JWKS transport is the seam (design-review loop-back 6).
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
packages/host/src/domain/run-authority-contract.ts              — CT-1 types: EntraObjectId, EntraTenantId, EntraClientId brands, EpochMs and DurationMs brands (instants vs durations; every identity-subsystem clock is () => EpochMs), EntraPrincipal, Initiator, AuthorityMode, RawCapabilityRequirement, CapabilityRequirement (over the catalog-minted CapabilityScope), RequirementRef, DelegatedHeader, DelegatedTokenExpectation (brand, {tenant, audience}, built only by pass 1), AdmissionStep (decided | verify-delegated), VerifyDelegatedStep, DelegatedPresentation (signature-verified{claims} | signature-rejected), VerifiedEntraClaims, VerifiedDelegationGrant, RedactedSecret, RunAuthority (user-delegated carries delegation.runId), BrokeredRunAuthority, UserDelegatedAuthority, RunAuthorityPlan, RunAuthorityRefusal (capability-unknown first), PlanRunAuthorityFn (pass 1), AdmitDelegatedPresentationFn (pass 2), BindDelegatedPrincipalFn, ValidateEntraUserTokenClaimsFn, IssuerForFn, VerifyEntraUserTokenFn, OriginOfFn
packages/host/src/domain/capability-authority-contract.ts       — CT-2 types: EntraIdentityRef, FederationGrant, FederatedAssertion, Hop, ReauthorizationReason, UnreachableCause (status | timeout | network), AcquisitionFaultOf<H, R> (the one acquisition-fault family) with its per-path subsets AppAcquisitionFault, DelegatedGrantFault, EstablishmentFault and the full AcquisitionFault, TokenEndpointErrorResponse (by grant), AcquiredCredential, RunMintingAuthority, CapabilityAuthority (forRun), CreateCapabilityAuthorityFn, InspectFederatedAssertionFn, ClassifyTokenEndpointErrorFn, FrameworkErrorOfFn, RunAuthorityRefusalOfFn
packages/host/src/domain/delegated-custody-contract.ts          — CT-3 types: CustodySeconds brand, CustodyBinding (a derived view, never stored), SealedRefreshCredential, CustodyGeneration brand (assigned only by the store), CustodyState (absent | held | revoked; also what get returns), CustodySuccessor (no generation field), CustodyEvent (establish | rotate | refuse), CustodyTransitionFault, HeldCustody, CustodySwapOutcome, PendingCustodyWrite, RedeemState, RedeemEffect, RedeemOutcome, RedeemStep, ApproverRef, ApprovalRecord, AuthorizedRun, SyncRunEnding, HitlRunEnding, CustodyReleaseCause, CustodyReleaseOutcome, EstablishForRecordFailure, RunAuthorityLifecycle, EstablishDelegationFn, TransitionCustodyFn, DecideRedeemStepFn, CustodyBindingOfFn, CreateRunAuthorityLifecycleFn
packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts — CT-1 acceptance: submissions through proxyToWorker → createAuthMiddleware → createRunDagHandler with admission from composeRunAuthorityWiring (real verifier over an in-process JWKS)
packages/host/src/__tests__/acceptance/run-authority-admission-budget.acceptance.test.ts — CT-1 acceptance: run-start validation p95 budget (AS-036; NFR-003, SC-011), same path as the CT-1 file
packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts     — CT-2 acceptance: invocationFor → broker.mintFor over the minting handle the lifecycle of composeRunAuthorityWiring hands a bracket body, for each identity model; delegated authorities admitted and established through the same wiring
packages/host/src/__tests__/acceptance/capability-authority-budget.acceptance.test.ts — CT-2 acceptance: host-added acquisition and cache-hit p95 budgets (AS-035; NFR-002, SC-011), same path as the CT-2 file
packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts   — CT-3 acceptance: HITL and sync runs started through proxyToWorker → createAuthMiddleware → createRunDagHandler; HITL engine from host.ts composeHitlRunService driven by its own run queue; sync execution through createRunContextFactory/createDagExecutor; approvals through createApproveRunHandler and handleBotActivity; one composeRunAuthorityWiring instance throughout
packages/host/src/__tests__/acceptance/user-run-attribution.acceptance.test.ts     — CT-4 acceptance: a user-origin sync run end to end through proxyToWorker → createAuthMiddleware → createRunDagHandler → host.ts createRunContextFactory/createDagExecutor → createNodeContextForDag → the capability authority from composeRunAuthorityWiring, fake transports only (AS-006, FR-004, FR-020)
packages/host/src/__tests__/acceptance/support/identity-fakes.ts — shared fakes at the network, storage and clock edges only: zero-latency realm-token, Entra-token, Entra-JWKS and Graph HTTP transports (an IdentityTransports value) with request capture, a JWKS signer for realm and Entra user tokens, a fake realm signature verifier returning markSignatureVerified claims, bun:test setSystemTime clock control, an in-process UDS transport into the worker app, an in-memory RedisPort and HitlRedisPort and the SharedInfra over them, an in-process QueueBackend that delivers each enqueued job to the started worker, a recording HITL notifier, a fake Bot Framework VerifyBotToken, a capturing audit sink, logger and tracer. It deliberately offers NO fake realm mint, Entra authority, user-token verifier, custody cipher, custody store or capability authority: acceptance takes all of those from composeRunAuthorityWiring
packages/host/src/__tests__/acceptance/support/latency-budget.ts — shared budget harness: warm-up, sample loop, nearest-rank p95 (test support, not production)
packages/host/src/__tests__/acceptance/support/credential-sentinel.ts — FR-022 scan support used by all four contracts' acceptance (Phase 3 creates it with CT-2): CredentialSentinels (one distinctive value per credential kind: inbound realm user JWT, inbound Entra user JWT, realm assertion, T1, Entra app access token, on-behalf-of access token, refresh token, rotated refresh token), wired into the identity-fakes transports and JWKS signer; CapturedSurfaces, a closed record of the nine surfaces (logs, audit, spans, httpResponses, errors, handles, origins, runRecords, custodyAtRest) filled only from the capturing logger, audit sink and tracer, the responses proxyToWorker returns, the error values the path produces, the handles and RunAuthority/RunMintingAuthority/InvocationOrigin values the path yields, the in-memory HitlRedisPort and the custody keyspace of the in-memory RedisPort or memory store; assertNoCredentialMaterial(surfaces, sentinels), which renders each captured value with JSON.stringify, String() and Bun.inspect and fails on any sentinel, its base64, base64url or hex encoding, or any JWT segment of 16 characters or more; assertCustodyCiphertextOnly(custodyAtRest, sentinels, keyring), which also requires every custody record to be a SealedRefreshCredential that opens only under the deployment keyring with its own binding as AAD
```

### Host: capability catalog (authority mode source)

```
packages/host/src/domain/capability-catalog.ts                  — CAPABILITY_CATALOG (the default raw source), CapabilityDefinitionInput, branded CapabilityCatalog, opaque CapabilityScope (minted only here, from a parsed catalog's key, carrying its definition under a module-private symbol), parseCapabilityCatalog, loadCapabilityCatalog (boot entry: parse → capability-catalog-invalid HostError), classifyCapability / classifyCapabilities (raw requirement → brokered{scope} | not-brokered | unknown, by the catalog's brokered namespaces), authorityOf(scope) (total), resourceOf(scope), requiresDelegation; absorbs capability-scope.ts; no module-load parse
packages/host/src/domain/capability-scope.ts                    — DELETED in the Phase 4 cut-over with the legacy broker path (Phase 1 re-derives its exports from the catalog)
packages/host/src/__tests__/boot-capability-catalog.test.ts     — AS-009, SC-013: createHost with HostDeps.capabilityCatalog = a data catalog whose entry lacks `authority` (and one with an unknown mode) returns Err capability-catalog-invalid naming the capability, with no capability connected, no router built and no server bound; createHost with no override boots (the code catalog passes the same parser)
packages/host/src/domain/capability-gate.ts                     — decideGate(catalog, capability, assigned, dynamicsOrgHost) classifies through classifyCapability: not-brokered → pass-through, unknown → unknown{capability} (zero egress; unreachable after admission), else refused{scope, reason} | gated{scope, audience}; the mode is read by authorityOf(scope), never stored on the decision
packages/host/src/domain/capability-registry.ts                 — registry augmentation derived from catalog keys
packages/host/src/domain/__tests__/capability-catalog.test.ts   — parse faults name the capability; @ts-expect-error type test for a missing authority
packages/host/src/domain/__tests__/capability-catalog.property.test.ts — parse(serialize(c)) = c; any entry lacking or with an unknown authority is refused; classifyCapability over generated catalogs and names: brokered iff a key, unknown iff a brokered namespace without the key, not-brokered otherwise; authorityOf(scope) equals the parsed entry's mode for every minted scope
packages/host/src/domain/__tests__/capability-gate.test.ts      — rewritten for the catalog signature: pass-through, unknown, refused, gated
packages/host/src/__tests__/authority-mode.matrix.test.ts       — INV-2 matrix (owner + every sibling)
```

### Host: identity topology configuration

```
packages/host/src/domain/config.ts                              — ENTRA_IDENTITY_MODEL, ENTRA_BLUEPRINT_CLIENT_ID, ENTRA_AGENT_IDENTITIES, DELEGATED_CUSTODY_KEYS (keyring shape validated at load), DELEGATED_CUSTODY_MAX_SEC (z.coerce.number().int().positive().optional(): a non-integer, zero, negative, empty or non-numeric value fails loadConfig naming the key; unset stays undefined); ENTRA_CLIENT_ID removed (refused by name) and the ENTRA_TENANT_ID/ENTRA_CLIENT_ID paired-field refusal removed with it
packages/host/src/domain/authority-legs.ts                      — planAuthorityLegs → Result<AuthorityLegs, readonly IdentityConfigFault[]> (every fault, not the first); presence gating per leg (Entra: ENTRA_TENANT_ID ∧ ENTRA_AGENT_IDENTITIES; delegation: DELEGATED_CUSTODY_KEYS); EntraDirectory ADT; DelegationLeg with maxSec: CustodySeconds = parseCustodySeconds(DELEGATED_CUSTODY_MAX_SEC, HITL_RUN_TTL_SEC) (unset → min(DEFAULT_DELEGATED_CUSTODY_MAX_SEC = 604800, HITL_RUN_TTL_SEC)); delegatedAudienceFor (INV-5 owner); unwiredLegsWarning text (authority-unconfigured, names missing presence keys and ignored keys, never a value)
packages/host/src/domain/__tests__/authority-legs.test.ts       — rewritten: every seeded misconfiguration names its offender; custody max: unset with default HITL_RUN_TTL_SEC → 604800, unset with HITL_RUN_TTL_SEC=86400 → 86400, 3600 → 3600, equal to HITL_RUN_TTL_SEC accepted, HITL_RUN_TTL_SEC + 1 → custody-max-exceeds-run-ttl{maxSec, runTtlSec}
packages/host/src/domain/__tests__/authority-legs.property.test.ts — total over key-presence combinations: Entra leg dark iff ENTRA_TENANT_ID or ENTRA_AGENT_IDENTITIES is unset, and then the warning names each missing presence key and each ignored ENTRA_* key; configured → wired iff complete and consistent, otherwise faults naming every offender; ENTRA_CLIENT_ID always refused; delegation leg dark iff DELEGATED_CUSTODY_KEYS unset or the Entra leg dark; wired maxSec is always a CustodySeconds whose value is a positive integer ≤ HITL_RUN_TTL_SEC
packages/host/src/domain/__tests__/config-security.test.ts      — custody key shape (32 bytes, active ∈ keys); DELEGATED_CUSTODY_MAX_SEC "0", "-1", "1.5", "", "7d" each fail loadConfig naming the key; unset loads as undefined
```

### Host: realm assertion mint

```
packages/host/src/domain/port/realm-assertion-mint.ts           — RealmAssertionMint port
packages/host/src/domain/federated-assertion.ts                 — pure payload decode + grant/audience inspection
packages/host/src/domain/__tests__/federated-assertion.test.ts  — missing aud/scope grants → federation-grant-missing naming grants
packages/host/src/adapters/realm-assertion-mint-http.ts         — client_credentials with scope "entra-exchange <capability>", no audience param; error responses through classifyTokenEndpointError (invalid_scope → grant-missing)
packages/host/src/adapters/unwired-realm-assertion-mint.ts      — unwired leg → AppAcquisitionFault unconfigured{why: absent}, zero egress
packages/host/src/adapters/__tests__/realm-assertion-mint-http.test.ts — request body capture (SC-001), adapter hands every non-2xx to the classifier
packages/host/src/domain/token-endpoint-error.ts                — classifyTokenEndpointError: the ONE pure reading of a realm or Entra token-endpoint error response, one decision table, overloaded by grant (client_credentials → AppAcquisitionFault; on-behalf-of | refresh → DelegatedGrantFault); codes and status only, never response text; unreachable carries a closed UnreachableCause
packages/host/src/domain/__tests__/token-endpoint-error.property.test.ts — total over (hop × grant × status × error × AADSTS codes); 429/5xx → unreachable{cause: status} for every hop and grant; the classification table; a client_credentials response never classifies to reauthorization-required; no input text reaches the fault
packages/host/src/domain/acquisition-fault.ts                   — frameworkErrorOf (total over AcquisitionFault, so over every subset; → authority-unavailable | infra-unreachable, rendering the closed UnreachableCause into fixed text) and runAuthorityRefusalOf (total over EstablishmentFault; → delegation-not-established), both .exhaustive()
packages/host/src/domain/__tests__/acquisition-fault.property.test.ts — every fault of each subset projects; unreachable is the only retriable projection; refusal HTTP statuses per reason; rendered infra-unreachable text is drawn only from the hop, the status digits and fixed words
packages/host/src/adapters/keycloak-token-endpoint.ts           — DELETED in the Phase 4 cut-over (legacy broker path)
packages/host/src/adapters/keycloak-token-endpoint-http.ts      — DELETED in the Phase 4 cut-over (legacy broker path; Phase 1 removes exchangeV2 from it)
packages/host/src/adapters/unwired-token-endpoint.ts            — DELETED in the Phase 4 cut-over (legacy broker path; Phase 1 removes its exchangeV2 stub with the port method)
packages/host/src/adapters/__tests__/keycloak-token-endpoint-http.test.ts — DELETED in the Phase 4 cut-over
```

**Export bindings:**
- `packages/host/src/domain/federated-assertion.ts` — CT-2: inspectFederatedAssertion: InspectFederatedAssertionFn
- `packages/host/src/domain/token-endpoint-error.ts` — CT-2: classifyTokenEndpointError: ClassifyTokenEndpointErrorFn
- `packages/host/src/domain/acquisition-fault.ts` — CT-2: frameworkErrorOf: FrameworkErrorOfFn, runAuthorityRefusalOf: RunAuthorityRefusalOfFn

### Host: Entra agent authority (two models)

```
packages/host/src/domain/port/entra-agent-authority.ts          — EntraAgentAuthority port (acquireApp, establishDelegation, redeemDelegation)
packages/host/src/adapters/entra-token-endpoint.ts              — shared form-body builders, tenant-validated endpoint URL, response → AcquiredCredential | AppAcquisitionFault (client_credentials) | DelegatedGrantFault (on-behalf-of, refresh); error responses through classifyTokenEndpointError, no classification of its own
packages/host/src/adapters/entra-agent-id-authority.ts          — two-step blueprint (fmi_path) → agent identity; OBO and refresh with T1
packages/host/src/adapters/entra-app-registration-authority.ts  — single-step per-agent app; OBO and refresh with the realm assertion
packages/host/src/adapters/unwired-entra-agent-authority.ts     — unwired leg → unconfigured{why: absent} (in each method's own subset), zero egress
packages/host/src/adapters/__tests__/entra-token-endpoint.test.ts — no client_secret/certificate ever (FR-012); every non-2xx handed to the classifier
packages/host/src/adapters/__tests__/entra-agent-id-authority.test.ts — step order, fmi_path, T1 as client_assertion, offline_access on OBO
packages/host/src/adapters/__tests__/entra-app-registration-authority.test.ts — single step, OBO assertion audience = agent app
packages/host/src/adapters/entra-wif.ts                         — DELETED in the Phase 4 cut-over (legacy broker path; from Phase 2 host.ts composes the legacy broker over unwired-entra-wif only)
packages/host/src/adapters/unwired-entra-wif.ts                 — DELETED in the Phase 4 cut-over (legacy broker path)
packages/host/src/adapters/__tests__/entra-wif.test.ts          — DELETED in the Phase 4 cut-over
```

### Host: Entra user token verification and run-start planning

```
packages/host/src/domain/entra-user-token.ts                    — pure claim validation for the delegated token; issuerFor(tenant) and jwksUriFor(tenant), the one derivation of the Entra v2.0 issuer and key URL, used by the claim validator and the verifier
packages/host/src/domain/redacted-secret.ts                     — runtime of the CT-1 RedactedSecret type (the types file only declares it): redactSecret(value) → a frozen object whose toJSON, toString and Bun.inspect custom hook all render "[redacted]" and that has no enumerable own property; revealSecret(secret) is the only reader, called only by the Entra form-body builders (entra-token-endpoint.ts), the custody cipher's seal and the user-token verifier
packages/host/src/domain/__tests__/redacted-secret.test.ts      — JSON.stringify, String(), template literal, Bun.inspect, Object.keys and structuredClone of a RedactedSecret never contain the value (property test over arbitrary strings)
packages/host/src/adapters/entra-user-token-verifier.ts         — verifyEntraUserToken(step: VerifyDelegatedStep, jwks: EntraJwks, signal) → DelegatedPresentation (signature-verified{claims} | signature-rejected{malformed | signature}); a plain adapter function, no port; jose + lazyJwks over jwksUriFor(step.expect.tenant) through the injected JWKS transport, RS256 only; reachable only with a step pass 1 built
packages/host/src/domain/run-authority.ts                       — planRunAuthority (pass 1, static: classifyCapabilities first, then the precedence order), admitDelegatedPresentation (pass 2: claims, binding, grant from step.token), bindDelegatedPrincipal, requirementsOf (raw inventory), originOf (the only RunAuthority → InvocationOrigin derivation)
packages/host/src/domain/jwt-validation.ts                      — entra_oid / entra_tid become required parsed claims
packages/host/src/domain/auth.ts                                — AuthenticatedUser.entra and AuthIdentity.user.entra required (Phase 2); TeamsApprover {kind: "teams-approver"; aadObjectId; canRunDag} and canAccessDag(AuthIdentity | TeamsApprover) (Phase 2); SubjectToken + markSubjectToken removed (Phase 1); agentClientIdFromFrameworkOrigin's broker use removed (Phase 4 cut-over)
packages/host/src/domain/run-context.ts                         — subjectTokenForIdentity removed (Phase 1); origin no longer derived here once originOf exists (Phase 4 cut-over)
packages/host/src/http/middleware/auth.ts                       — user identity carries entra principal; no subject-token branding
packages/host/src/http/authenticate-identity.ts                 — same
packages/host/src/domain/__tests__/entra-user-token.test.ts     — each refusal reason
packages/host/src/domain/__tests__/run-authority.property.test.ts — pass 1 totality; the pure composition (pass 1, then pass 2 over every generated presentation; no fakes) preserves the full precedence order, capability-unknown first; verify-delegated only with a wired directory, a mapped agent, delegatedAudienceFor's audience and no unknown capability; the admitted grant's token is the step's; binding iff oid ∧ tid equal; originOf agrees with the authority's agent and initiator for every brokered authority
packages/host/src/adapters/__tests__/entra-user-token-verifier.test.ts — signature, alg allowlist, key rotation via lazyJwks over an in-process JWKS transport; signature-verified carries claims only
packages/host/src/__tests__/middleware/auth.test.ts             — realm JWT without entra claims → 401 naming the claims
```

**Export bindings:**
- `packages/host/src/domain/run-authority.ts` — CT-1: planRunAuthority: PlanRunAuthorityFn, admitDelegatedPresentation: AdmitDelegatedPresentationFn, bindDelegatedPrincipal: BindDelegatedPrincipalFn, originOf: OriginOfFn
- `packages/host/src/domain/entra-user-token.ts` — CT-1: validateEntraUserTokenClaims: ValidateEntraUserTokenClaimsFn, issuerFor: IssuerForFn
- `packages/host/src/adapters/entra-user-token-verifier.ts` — CT-1: verifyEntraUserToken: VerifyEntraUserTokenFn

### Host: delegated custody

```
packages/host/src/domain/delegated-custody.ts                   — LC-1 machine: transitionCustody (absent | held | revoked; establish, rotate, refuse) → CustodySuccessor; decideRedeemStep, the pure decision function holding the custody cell's whole outcome table; custodyBindingOf(authority) (UserDelegatedAuthority → AAD view, runId included), parseCustodySeconds (the only CustodySeconds constructor, against HITL_RUN_TTL_SEC), custodySecondsToMs, custodyExpiryFor(EpochMs, CustodySeconds, EpochMs) → EpochMs, canonical AAD encoding, reauthorizationReasonOf (expiry as a pure comparison)
packages/host/src/domain/__tests__/delegated-custody.property.test.ts — exactly the three declared (state, event) pairs are accepted; rotate at or after the binding expiry is refused; establish is refused when the binding expiry is ≤ now or beyond now + cap; refuse yields revoked with no sealed bytes; no event leaves revoked and only establish leaves absent; no state or successor carries an expiry or a generation chosen by the caller; reauthorizationReasonOf: revoked → refused, absent → custody-expired iff now ≥ binding expiry, else custody-absent; custodyExpiryFor ≤ both bounds
packages/host/src/domain/__tests__/decide-redeem-step.property.test.ts — the custody cell's outcome table row by row, with no fakes: every path finishes within seven steps; expired at begin performs no effect; a store fault only ever finishes unreachable{custody-store}; refused never grants; missing never writes again; a rotated credential gets at least one write against the generation current at that time; a failed write finishes with the grant and a pending write that the next redeem flushes first
packages/host/src/domain/port/delegated-custody-store.ts        — DelegatedCustodyStore port: put(binding, held{sealed}) (NX, generation 0, key from binding.runId, PX at binding.expiresAtMs), get → CustodyState, swap(runId, expected, next: CustodySuccessor) (writes generation expected + 1 itself iff the stored generation is expected; KEEPTTL; never creates), delete
packages/host/src/adapters/custody-cipher.ts                    — AES-256-GCM seal/open via WebCrypto; kid rotation; AAD mismatch → open fails
packages/host/src/adapters/delegated-custody-store-redis.ts     — fugue:<tenant>:authority:custody:<binding.runId>, PX = binding expiry, ciphertext only; swap is one Lua script (missing → missing, generation mismatch → stale{current}, else SET {next, generation: expected + 1} KEEPTTL → swapped{written})
packages/host/src/adapters/delegated-custody-store-memory.ts    — process-local store for Redis-less sync deployments (ciphertext only; same put and swap semantics, generation assigned by the store)
packages/host/src/adapters/run-custody-cell.ts                  — createRunCustodyCell(deps, authority: UserDelegatedAuthority) → { redeem(capability, resource, signal) }: the run's single-flight custody cell, a thin sequencer that performs each RedeemEffect decideRedeemStep asks for (get, open, mint + redeemDelegation, seal, swap) and feeds the outcome back; no decision of its own; holds only Pick<DelegatedCustodyStore, "get" | "swap">; created only inside forRun
packages/host/src/adapters/delegation-establishment.ts          — establishDelegation: expiry → authority {delegation: {runId, audience, custodyExpiresAtMs}} → custodyBindingOf → mint → OBO → seal → put(binding, held{sealed}); Err(EstablishmentFault) on any failure, ambiguous put included, with no compensation of its own (the lifecycle owner releases); holds only Pick<DelegatedCustodyStore, "put">
packages/host/src/adapters/run-authority-lifecycle.ts           — INV-4 owner: createRunAuthorityLifecycle → { withEstablishedAuthority, establishForRecord, withRecordedAuthority, endRun }; owns establishment (via establishDelegation), the per-bracket minting handle (the only caller of capabilityAuthority.forRun) and release for every run; the only holder of DelegatedCustodyStore.delete; derives the CustodyReleaseCause from the SyncRunEnding, the HitlRunEnding or the failed establishment/persist step; applies runAuthorityRefusalOf; release idempotent and unconditional; logs a failed delete with runId, cause and error kind only; never throws on its own account
packages/host/src/adapters/__tests__/custody-cipher.test.ts     — round-trip; tampered AAD/ciphertext/kid refused; plaintext never in stored bytes
packages/host/src/adapters/__tests__/delegated-custody-store-redis.test.ts — key under tenant prefix from binding.runId; PX = binding expiry ≤ HITL_RUN_TTL_SEC (idle-eviction cover); purgeTenantKeyspace reclaims the custody key (tenant-purge cover); put writes generation 0; swap: missing never creates, stale returns the current record, swapped writes generation expected + 1 and keeps the TTL; delete idempotent
packages/host/src/adapters/__tests__/delegated-custody-store-memory.test.ts — expiry honoured on get (past PX → absent); same put and swap cases; delete idempotent
packages/host/src/adapters/__tests__/run-custody-cell.test.ts   — the sequencer performs exactly the effects decideRedeemStep returns, in order, over the memory store and a fake Entra transport; one redeem at a time under concurrent callers; a pending write is flushed before the next read
packages/host/src/adapters/__tests__/delegation-establishment.test.ts — failure → typed EstablishmentFault; zero app fallback; the authority carries the runId; stored record carries no binding and opens only with custodyBindingOf(authority) as AAD
packages/host/src/__tests__/run-authority-lifecycle.matrix.test.ts — INV-4 matrix: owner + every sibling; each run-ending path leaves custody absent with the path's own derived cause; each bracket builds exactly one minting handle
```

**Export bindings:**
- `packages/host/src/domain/delegated-custody.ts` — CT-3: transitionCustody: TransitionCustodyFn, decideRedeemStep: DecideRedeemStepFn, custodyBindingOf: CustodyBindingOfFn
- `packages/host/src/adapters/delegation-establishment.ts` — CT-3: establishDelegation: EstablishDelegationFn
- `packages/host/src/adapters/run-authority-lifecycle.ts` — CT-3: createRunAuthorityLifecycle: CreateRunAuthorityLifecycleFn

### Host: capability authority (mint path)

```
packages/host/src/adapters/capability-authority.ts              — boot-scoped core + forRun(run) → { broker, origin: originOf(run) }; forRun creates, for a user-delegated run, exactly one run custody cell (createRunCustodyCell over the authority, whose runId keys custody); broker identity from its closure only (inv.origin never read); classification through decideGate; app path; delegated path through the run's custody cell; per-capability access cells; frameworkErrorOf applied here only; audit, handle build. The custody outcome table lives in decideRedeemStep, not here
packages/host/src/adapters/keycloak-broker.ts                   — DELETED in the Phase 4 cut-over, when host.ts switches to composeRunAuthorityWiring (replaced by capability-authority.ts)
packages/host/src/adapters/broker-audit.ts                      — audit fields gain agentClientId, entraIdentity, authority, initiator {realmSub, oid, tid}; outcome gains federation path
packages/host/src/adapters/graph-capability.ts                  — handle builders keyed off catalog definitions
packages/host/src/domain/token-cache.ts                         — cache key ADT: app{identity, capability} | delegated{identity, oid, capability}, encoded by cacheKeyOf to the string key token-cell.ts already takes (token-cell.ts unchanged); the legacy cacheKey stays until the Phase 4 cut-over deletes its last importer
packages/host/src/domain/__tests__/token-cache.test.ts          — cacheKeyOf is injective across (identity, mode, oid, capability)
packages/host/src/adapters/agent-client-credentials.ts          — unchanged contract; consumed by realm-assertion-mint-http
packages/host/src/adapters/__tests__/capability-authority.test.ts — unit: gate refusals zero-egress (unknown included), cache isolation, single-flight, audit shape, one custody cell per forRun
packages/host/src/adapters/__tests__/capability-authority.property.test.ts — no credential served across (identity, mode, oid) under interleavings (NFR-012); under fast-check scheduled interleavings of N delegated capabilities in one run, custody redeems are serial, the stored generation ends at the number of rotations, the stored credential is the last rotated one, and an external writer's interleaved swap is absorbed by one re-read with no spurious error and no rotated credential lost
packages/host/src/adapters/__tests__/keycloak-broker.test.ts    — DELETED in the Phase 4 cut-over (superseded)
packages/host/src/adapters/__tests__/broker-audit.test.ts       — new fields; no credential fields
```

**Export bindings:**
- `packages/host/src/adapters/capability-authority.ts` — CT-2: createCapabilityAuthority: CreateCapabilityAuthorityFn

### Host: run authority composition (one wiring for route, HITL engine and executor)

```
packages/host/src/adapters/run-authority-admission.ts           — createRunAuthorityAdmission({ catalog, legs, jwks }) → admitRunAuthority: requirementsOf → planRunAuthority (pass 1) → only on verify-delegated: verifyEntraUserToken(step, jwks, signal), statically imported → admitDelegatedPresentation (pass 2); no establishment (that is the lifecycle's)
packages/host/src/adapters/run-authority-wiring.ts              — composeRunAuthorityWiring(input: { config, catalog: CapabilityCatalog, redis, routedTenant, transports: IdentityTransports, logger, tracer, audit, now: () => EpochMs }) → Result<RunAuthorityWiring, readonly IdentityConfigFault[]>, where catalog is the one loadCapabilityCatalog produced at boot; the ONLY production composition of planAuthorityLegs, the realm assertion mint adapter (http or unwired), the Entra agent authority adapter for the declared model (agent-id, app-registration or unwired), the JWKS resolver over transports.entraJwks, the custody cipher, the custody store (Redis when a Redis port is wired, memory otherwise), establishDelegation, createCapabilityAuthority, createRunAuthorityLifecycle (over that capability authority) and createRunAuthorityAdmission; RunAuthorityWiring = { legs, admitRunAuthority, lifecycle: RunAuthorityLifecycle } (the capability authority is not exposed: the lifecycle is the only holder of forRun); IdentityTransports = { realmToken, entraToken, entraJwks, graph } (production: fetch-based, built in host.ts)
packages/host/src/adapters/__tests__/run-authority-admission.test.ts — refusal precedence through the composition, capability-unknown first; zero requests on the JWKS transport for every statically refusable submission that carries a token (fast-check over submissions); non-delegated plans pass through unchanged
packages/host/src/adapters/__tests__/run-authority-lifecycle.test.ts — owner unit cases: establish Err → release with establishment-abandoned and runAuthorityRefusalOf's refusal; body rejection → release sync-ended{failed} and rethrow; persist failure → release and persist-failed; non-delegated plan → identity establishment, release still issued; failing delete → release-failed + one log, nothing thrown; withEstablishedAuthority and withRecordedAuthority each build exactly one handle (forRun counted) and hand it to the body; withRecordedAuthority neither establishes nor releases
packages/host/src/adapters/__tests__/run-authority-wiring.test.ts — per EntraDirectory variant the adapters selected (agent-id, app-registration, unwired); partial Entra config composes the unwired adapters; dark delegation leg composes the memory store and admission refuses every delegated run; a configured leg without ENTRA_IDENTITY_MODEL (AS-033) and with an unmapped agent client (AS-013) returns Err naming the offenders; config faults returned, never thrown
packages/host/src/__tests__/delegated-audience.matrix.test.ts   — INV-5 matrix (owner + every sibling)
```

### Host: HITL persistence and approver

```
packages/host/src/hitl/types.ts                                 — PersistedIdentity.user gains entra (Phase 2, with the live identity); RunRecord.authority: RunAuthority replaces RunRecord.identity and PersistedIdentity is deleted (Phase 4 cut-over); approvals: readonly ApprovalRecord[] (Phase 5)
packages/host/src/hitl/ports.ts                                 — RunExecutionRequest.authority: RunAuthority replaces identity (Phase 4 cut-over)
packages/host/src/hitl/identity.ts                              — approverTeamIdentity returns TeamsApprover | undefined, and toPersistedIdentity / toExecIdentity carry entra (Phase 2); toPersistedIdentity and toExecIdentity deleted (Phase 4 cut-over); approver mapping to ApproverRef (Phase 5)
packages/host/src/hitl/service.ts                               — startRun(dagId, team, input, identity, plan) makes one runAuthority.establishForRecord call whose persist step creates the record carrying the authority; processRun hands the executor record.authority, folds every path into ProcessRunOutcome = continuing | ended{HitlRunEnding} and makes one runAuthority.endRun call after the fold (INV-4 sibling; deps hold Pick<RunAuthorityLifecycle, "establishForRecord" | "endRun">, no store); recordDecision(..., approver) appends ApprovalRecord + hitl-decision audit (Phase 5)
packages/host/src/hitl/adapters/run-store.ts                    — record schema: user identity entra required (Phase 2); authority required in place of identity, and a user-delegated authority's delegation.runId must equal the record's runId (Phase 4 cut-over); approvals required (Phase 5); records failing any of these are rejected as corrupt (pre-release, no shim)
packages/host/src/hitl/adapters/run-executor.ts                 — RunExecutorDeps.broker → runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority"> (INV-4 sibling); each slice runs in one withRecordedAuthority(req.authority, body) call and mints through MintingAuthority = { ...run.minting, meterLlm }; no subject-token bind
packages/host/src/http/handlers/runs.ts                         — createApproveRunHandler derives ApproverRef (realm-user{realmSub, entra} | team | admin) from the AuthIdentity the auth middleware built; refusals via errorResponse (CT-3 runtime seam)
packages/host/src/hitl/adapters/bot/messages-handler.ts         — handleBotActivity authorizes the TeamsApprover through canAccessDag (Phase 2, no code change: the call accepts the new type) and derives teams-user{aadObjectId} from it (Phase 5; CT-3 runtime seam)
packages/host/src/hitl/__tests__/identity.test.ts               — approverTeamIdentity returns a teams-approver with no realm principal; user round-trip carries entra (Phase 2); round-trip cases removed with the functions (Phase 4 cut-over)
packages/host/src/hitl/__tests__/approver-authority.test.ts     — unit: ApproverRef mapping per AuthIdentity variant and TeamsApprover; approval audit names both
packages/host/src/hitl/adapters/__tests__/run-executor.test.ts  — rewritten: authority from record only, one withRecordedAuthority call per slice
```

### Host: admission, manifest and composition

```
packages/host/src/http/delegated-token-header.ts                — parseDelegatedTokenHeader: parse X-Fugue-Delegated-Authorization → absent | present(RedactedSecret) | malformed
packages/host/src/http/handlers/run-dag.ts                      — admission through the injected admitRunAuthority before hitl.startRun(…, plan) and acquire; after acquire the sync path makes one runAuthority.withEstablishedAuthority(plan, runId, deadlineMs, body) call whose body receives the bracket's AuthorizedRun, creates the context, executes through run.minting and returns its SyncRunEnding (INV-4 sibling; deps hold Pick<RunAuthorityLifecycle, "withEstablishedAuthority">, no store, no release function); both come from one RunAuthorityWiring
packages/host/src/supervisor/uds-proxy.ts                       — unchanged: proxyToWorker forwards X-Fugue-Delegated-Authorization and Authorization byte-identical and strips only X-Fugue-Tenant; a runtime seam of CT-1, CT-3 and CT-4, whose acceptance submits through it
packages/host/src/http/handlers/manifest.ts                     — per-DAG authority block: requirements classified by classifyCapabilities, modes per brokered capability (authorityOf on a scope from the boot-loaded catalog, INV-2 sibling), any capability-unknown requirements listed, delegated header requirement, expected audience (delegatedAudienceFor, INV-5 sibling), tenant
packages/host/src/domain/host-error.ts                          — run-authority-refused{refusal: RunAuthorityRefusal} (Phase 4, with its exhaustive status table and discloseHostError in the same Task); capability-catalog-invalid{faults: readonly CatalogFault[]} (Phase 1) and identity-config-invalid{faults: readonly IdentityConfigFault[]} (Phase 2), the two boot refusals createHost returns, whose messages name every offending capability, key or agent client and never a value; snapshot table entries
packages/host/src/http/middleware/error-handler.ts              — rawDetailsFor is .exhaustive() over HostError, so each new kind gets its case in the Task that adds the kind: capability-catalog-invalid (Phase 1), identity-config-invalid (Phase 2), run-authority-refused{refusal} (Phase 4); with __tests__/middleware/error-handler.test.ts and domain/__tests__/host-error.test.ts
packages/host/src/domain/framework-error-http.ts                — authority-unavailable mapping (grant-missing 403, unconfigured 503, federation-rejected 502, reauthorization-required 401); Phase 1, in the Task that widens the framework union, because both matches here are .exhaustive()
packages/host/src/host.ts                                       — createHost loads the catalog once with loadCapabilityCatalog(HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG) right after executeStartup (Err → return capability-catalog-invalid before capabilities connect); HostDeps.capabilityCatalog?: unknown added (Phase 1); calls composeRunAuthorityWiring ONCE per host (config, the loaded catalog, sharedInfra.redis, routedTenant, HostDeps.identityTransports or the fetch-based default; Err → return identity-config-invalid before the router is built or the server binds; a dark leg logs unwiredLegsWarning once) and feeds that one instance to buildRouterDeps (admitRunAuthority, the lifecycle narrowed to withEstablishedAuthority, createDagExecutor) and to the HITL composition (the lifecycle narrowed to establishForRecord and endRun for the service and to withRecordedAuthority for the executor); EXPORTS createRunContextFactory(config, sharedInfra, routedTenant) and createDagExecutor(config) (CT-3 and CT-4 runtime seams, consumed by buildRouterDeps) and composeHitlRunService(args: HitlWiringArgs, queueBackend, notifier) with HitlWiringArgs exported and args.runAuthority: RunAuthorityWiring replacing args.broker (CT-3 runtime seam, consumed by startDurableRunEngine); executeDag(dag, input, ctx, run: AuthorizedRun, meter) mints through MintingAuthority = { ...run.minting, meterLlm }, the one handle the bracket built (no minting for an unbrokered authority, whose minting is absent); HostDeps.capabilityBroker REMOVED (an injected broker would bypass the wiring) and HostDeps.identityTransports?: IdentityTransports added; subject-token wiring removed (Phase 1). All of this except the Phase 1 catalog and subject-token lines lands in the one Phase 4 cut-over Task
packages/host/src/adapters/node-context-factory.ts              — createNodeContextForDag(shared, registered, runId, signal, authority: RunAuthority, options) returns NodeContextForDag{ctx, authority: RunAuthority, meterMintedLlm}; it stores no origin (forRun derives it with originOf) (CT-4 runtime seam); resolveOriginAndBindSubjectToken removed; unmapped-DAG throw replaced by planner refusal
packages/host/src/__tests__/broker-selection.test.ts            — rewritten: createHost composes composeRunAuthorityWiring over HostDeps.identityTransports for each EntraDirectory variant
packages/host/src/__tests__/entrypoint-wiring.test.ts           — capabilityBroker override removed; identityTransports injected instead
packages/host/src/__tests__/integration/full-lifecycle.test.ts   — T8 rewritten: the capabilityBroker override test becomes an identityTransports injection test
packages/host/src/__tests__/node-context-factory.test.ts        — rewritten
packages/host/src/__tests__/handlers/run-dag-authority.test.ts  — refusal ordering: zero acquire, zero startRun, zero egress (JWKS included) on refusal
packages/host/src/__tests__/handlers/manifest-authority.test.ts — authority block shape per model
packages/host/src/__tests__/boot-identity-refusal.test.ts      — AS-013, AS-033, SC-013, NFR-020 at createHost: a configured Entra leg without ENTRA_IDENTITY_MODEL, with an unknown model, or with a mapped agent client that has no Entra identity returns Err identity-config-invalid naming every offender with no router built and no server bound; ENTRA_CLIENT_ID set → removed-key refusal with the migration hint; no ENTRA_* key, or only one presence key, boots with the leg dark and one warning naming the missing presence key
packages/host/src/adapters/subject-token-registry.ts            — DELETED (Phase 1)
packages/host/src/adapters/__tests__/subject-token-registry.test.ts — DELETED (Phase 1)
packages/host/src/__tests__/subject-token-teardown.test.ts      — DELETED (Phase 1)
packages/host/src/adapters/__tests__/unwired-defaults.test.ts   — rewritten for unwired mint/authority adapters (Phase 1 drops its exchangeV2 and subject-token cases; Phase 2 adds the new adapters' rows; the Phase 4 cut-over drops the legacy rows)
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
packages/host/docs/data-handling.md                             — NEW: initiator attribution (oid, tid), retention unchanged (FR-024), custody hold/bind/cap/delete (FR-044), stating the cap: DELEGATED_CUSTODY_MAX_SEC, default min(604800 s, HITL_RUN_TTL_SEC) = 7 days with default keys, at most HITL_RUN_TTL_SEC, never unbounded
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
type CatalogScope = keyof typeof CAPABILITY_CATALOG             // compile-time keys of the code catalog; types the handle registry augmentation only (replaces DownstreamScope)
type CapabilityCatalog = Brand<ReadonlyMap<string, CapabilityScope>, "CapabilityCatalog">
declare const scopeDefinition: unique symbol                    // module-private: not exported, so only this module reads a definition
type CapabilityScope = {                                        // minted only here, from a key of a parsed catalog; runtime paths (mint, gate, planner) take this,
  readonly name: string                                         // so data-sourced and test capabilities flow through them
  readonly [scopeDefinition]: CapabilityDefinition
}
type CatalogFault = { kind: "authority-missing" | "authority-unknown" | "resource-unknown" | "scope-malformed"; capability: string }
parseCapabilityCatalog(raw: unknown): Result<CapabilityCatalog, readonly CatalogFault[]>   // every fault, not the first
loadCapabilityCatalog(source: unknown): Result<CapabilityCatalog, HostError>   // boot entry; Err = capability-catalog-invalid{faults}; createHost passes HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG
type CapabilityClass =                                          // the boundary parse of one raw requirement string
  | { kind: "brokered"; scope: CapabilityScope }                // a catalog key
  | { kind: "not-brokered" }                                    // a namespace no catalog key uses (http, ADR-0051 custom): other providers serve it
  | { kind: "unknown"; capability: string }                     // a brokered namespace whose key the catalog lacks
classifyCapability(catalog, raw: string): CapabilityClass
classifyCapabilities(catalog, raw: readonly RawCapabilityRequirement[])
  : Result<readonly CapabilityRequirement[], readonly RequirementRef[]>   // the brokered requirements, or every unknown {nodeId, capability}
authorityOf(scope: CapabilityScope): AuthorityMode              // INV-2 owner; total: no scope exists without a definition
resourceOf(scope: CapabilityScope): "graph" | "dynamics"
requiresDelegation(reqs: readonly CapabilityRequirement[]): readonly CapabilityRequirement[]
```

A brokered namespace is the provider prefix of any catalog key (`msgraph`, `dynamics`, or a prefix a data catalog introduces). Admission pass 1 calls `classifyCapabilities` first, so an `unknown` requirement is the `capability-unknown` refusal before any other decision, and every later reader of a mode holds a catalog-minted scope (design-review loop-back 6).

**Depends on:** CT-1 types.

### Identity Topology (authority legs)

**Responsibility:** Parse the deployment's realm, Entra and delegation configuration into wired or dark legs, or into a list of named faults.
**Files:** `packages/host/src/domain/authority-legs.ts`, `packages/host/src/domain/config.ts`
**Interface:**

```
type EntraDirectory =
  | { model: "agent-id"; tenant: EntraTenantId; blueprint: EntraClientId; agents: ReadonlyMap<AgentClientId, EntraClientId> }
  | { model: "app-registration"; tenant: EntraTenantId; agents: ReadonlyMap<AgentClientId, EntraClientId> }
type EntraLeg = { kind: "wired"; directory: EntraDirectory }
  | { kind: "dark"; missing: readonly ("ENTRA_TENANT_ID" | "ENTRA_AGENT_IDENTITIES")[]; ignored: readonly string[] }
type DelegationLeg = { kind: "wired"; keys: CustodyKeyring; maxSec: CustodySeconds }   // CT-3 brand; only parseCustodySeconds builds it, so 0 < maxSec ≤ HITL_RUN_TTL_SEC by construction
  | { kind: "dark"; missing: readonly string[] }                                 // DELEGATED_CUSTODY_KEYS and/or the Entra identity leg
const DEFAULT_DELEGATED_CUSTODY_MAX_SEC = 604_800                                // 7 days
type IdentityConfigFault =                                                       // only for a CONFIGURED leg, or a removed key
  | { kind: "identity-model-missing" } | { kind: "identity-model-unknown"; value: string }
  | { kind: "blueprint-missing" } | { kind: "blueprint-forbidden"; model: "app-registration" }
  | { kind: "agent-identity-missing"; agentClientIds: readonly AgentClientId[] }
  | { kind: "agent-identity-orphan"; agentClientIds: readonly string[] }
  | { kind: "agent-identity-shared"; entraClientId: string; agentClientIds: readonly AgentClientId[] }
  | { kind: "removed-key"; key: "ENTRA_CLIENT_ID"; replacement: string }
  | { kind: "custody-max-exceeds-run-ttl"; maxSec: number; runTtlSec: number }
planAuthorityLegs(config, realmIssuer): Result<AuthorityLegs, readonly IdentityConfigFault[]>   // all faults, not first
delegatedAudienceFor(directory, agent): EntraClientId           // INV-5 owner: blueprint (agent-id) | agent app id (app-registration)
unwiredLegsWarning(legs): string | undefined
```

Presence gating per leg (AS-013, NFR-020, clarify log): the Entra identity leg is configured iff `ENTRA_TENANT_ID` and `ENTRA_AGENT_IDENTITIES` are both set; otherwise it is `dark` and the warning names the missing presence key(s) and every other `ENTRA_*` key it ignored. Only a configured leg can produce the model, blueprint and agent-identity faults. The delegation leg is configured iff `DELEGATED_CUSTODY_KEYS` is set, and is `dark` (warned, not refused) when that key is absent or the Entra leg is dark. The custody max is resolved here, once, by `parseCustodySeconds(DELEGATED_CUSTODY_MAX_SEC, HITL_RUN_TTL_SEC): Result<CustodySeconds, IdentityConfigFault>`: the set value (already a positive integer, or `loadConfig` refused it), else min(`DEFAULT_DELEGATED_CUSTODY_MAX_SEC`, `HITL_RUN_TTL_SEC`); a set value above `HITL_RUN_TTL_SEC` is `custody-max-exceeds-run-ttl`. Nothing downstream handles a bare number of custody seconds. `ENTRA_CLIENT_ID` is refused whatever the leg state. `createHost` turns a fault list into the `identity-config-invalid` HostError and returns it before the router is built.

**Depends on:** `config.ts` (raw keys), CT-1 brands.

### Realm Assertion Mint

**Responsibility:** Obtain an agent's federation assertion carrying both the Entra-exchange grant and the capability grant, or a typed fault, with no Entra egress on failure.
**Files:** `domain/port/realm-assertion-mint.ts`, `domain/federated-assertion.ts`, `adapters/realm-assertion-mint-http.ts`, `adapters/unwired-realm-assertion-mint.ts`
**Interface:**

```
interface RealmAssertionMint {
  readonly mintFederationAssertion: (agent: AgentClientId, capability: CapabilityScope, signal: AbortSignal)
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

**Depends on:** `agent-client-credentials.ts`, `domain/token-endpoint-error.ts`, the catalog and CT-2 types.

### Entra Agent Authority

**Responsibility:** Turn a federated assertion into a resource credential under the agent's own Entra identity, either app-only or on behalf of a user, for exactly one identity model.
**Files:** `domain/port/entra-agent-authority.ts`, `adapters/entra-token-endpoint.ts`, `adapters/entra-agent-id-authority.ts`, `adapters/entra-app-registration-authority.ts`, `adapters/unwired-entra-agent-authority.ts`
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
type UnreachableCause = { kind: "status"; status: number } | { kind: "timeout" } | { kind: "network" }   // closed: no free text
type AcquisitionFaultOf<H extends Hop, R extends ReauthorizationReason> =
  | { kind: "grant-missing"; grants: readonly FederationGrant[] }
  | { kind: "unconfigured"; keys: readonly string[]; why: "absent" | "rejected" }
  | { kind: "federation-rejected"; reason: "issuer" | "subject" | "audience" | "unknown"; aadsts?: AadstsCode }
  | ([R] extends [never] ? never : { kind: "reauthorization-required"; reason: R })
  | { kind: "unreachable"; hop: H; cause: UnreachableCause }
type AppAcquisitionFault = AcquisitionFaultOf<"realm" | "entra", never>                          // realm mint, acquireApp
type DelegatedGrantFault = AcquisitionFaultOf<"realm" | "entra", "refused">                      // on-behalf-of, refresh
type EstablishmentFault  = AcquisitionFaultOf<Hop, "refused">                                    // establishDelegation (put included)
type AcquisitionFault    = AcquisitionFaultOf<Hop, ReauthorizationReason>                        // the custody cell's redeem only
classifyTokenEndpointError: {                                     // domain/token-endpoint-error.ts; one table, the only reading of an error body
  (r: TokenEndpointErrorResponse<"client_credentials">): AppAcquisitionFault
  (r: TokenEndpointErrorResponse<"on-behalf-of" | "refresh">): DelegatedGrantFault
}
frameworkErrorOf(fault: AcquisitionFault, scope: CapabilityScope, agent: AgentClientId): FrameworkError   // domain/acquisition-fault.ts; total over every subset; renders UnreachableCause
runAuthorityRefusalOf(fault: EstablishmentFault): RunAuthorityRefusal                                     // domain/acquisition-fault.ts; delegation-not-established{reason}
createAgentIdAuthority(deps: { directory: Extract<EntraDirectory, {model:"agent-id"}>; http; now: () => EpochMs }): EntraAgentAuthority
createAppRegistrationAuthority(deps: { directory: Extract<EntraDirectory, {model:"app-registration"}>; http; now: () => EpochMs }): EntraAgentAuthority
```

Projection tables, each a `.exhaustive()` match:

| Fault variant | `frameworkErrorOf` (over `AcquisitionFault`) | `runAuthorityRefusalOf` (over `EstablishmentFault`; `delegation-not-established.reason`, HTTP) |
|---|---|---|
| `grant-missing` | `authority-unavailable{federation-grant-missing{grants}}` | `grant-missing`, 403 |
| `unconfigured` | `authority-unavailable{authority-unconfigured{missing: keys}}` | `unconfigured`, 503 |
| `federation-rejected` | `authority-unavailable{federation-rejected{reason}}` | `federation-rejected`, 502 |
| `reauthorization-required` | `authority-unavailable{reauthorization-required{reason}}` | `refused` only (the subset has no custody reason), 403 |
| `unreachable` | `infra-unreachable` (retriable), message rendered from `hop` and `cause` only | `unreachable`, 503 |

**Depends on:** CT-2 types, `domain/token-endpoint-error.ts` and the `fetch-http-post.ts` transport.

### Run Authority Planner

**Responsibility:** Decide, purely and before any slot or egress, the authority a run will act under, or refuse with a typed reason.
**Files:** `domain/run-authority.ts`, `domain/entra-user-token.ts`, `adapters/entra-user-token-verifier.ts`, `http/delegated-token-header.ts`
**Interface:**

```
type EpochMs = Brand<number, "EpochMs">; type DurationMs = Brand<number, "DurationMs">   // instants vs durations; no arithmetic mixes them
type RunAuthority =
  | { kind: "unbrokered"; principal: { kind: "agent" } | { kind: "user"; initiator: Initiator } }
  | { kind: "agent"; agentClientId: AgentClientId }
  | { kind: "user-app"; agentClientId: AgentClientId; initiator: Initiator }
  | { kind: "user-delegated"; agentClientId: AgentClientId; initiator: Initiator;
      delegation: { runId: RunId; audience: EntraClientId; custodyExpiresAtMs: EpochMs } }
// The user-delegated authority is the ONE canonical holder of the custody binding's facts: custodyBindingOf(authority)
// (CT-3) derives {runId, agentClientId, entra: initiator.entra, expiresAtMs} from it; no record stores a second copy,
// and the custody key, the AAD and the PX all come from this one value (design-review loop-back 6).
type RawCapabilityRequirement = { nodeId: NodeId; capability: string }        // from runtimeNodeInventory, unparsed
type CapabilityRequirement = { nodeId: NodeId; scope: CapabilityScope }       // parsed by classifyCapabilities: brokered only
type RequirementRef = { nodeId: NodeId; capability: string }                  // what a refusal names (scope.name)
type BrokeredRunAuthority = Exclude<RunAuthority, { kind: "unbrokered" }>
type UserDelegatedAuthority = Extract<RunAuthority, { kind: "user-delegated" }>
type RunAuthorityPlan = Exclude<RunAuthority, { kind: "user-delegated" }>
  | { kind: "user-delegated-pending"; agentClientId: AgentClientId; initiator: Initiator; grant: VerifiedDelegationGrant }
type DelegatedHeader = { kind: "absent" } | { kind: "present"; token: RedactedSecret } | { kind: "malformed" }
type DelegatedTokenExpectation = Brand<{ tenant: EntraTenantId; audience: EntraClientId }, "DelegatedTokenExpectation">
  // built only by pass 1; audience from delegatedAudienceFor (INV-5); no issuer: issuerFor(tenant) derives it where it is checked
type AdmissionStep =                                                                 // pass 1 result
  | { kind: "decided"; plan: Exclude<RunAuthorityPlan, { kind: "user-delegated-pending" }> }
  | { kind: "verify-delegated"; token: RedactedSecret; expect: DelegatedTokenExpectation;
      pending: { agentClientId: AgentClientId; initiator: Initiator } }
type VerifyDelegatedStep = Extract<AdmissionStep, { kind: "verify-delegated" }>
type DelegatedPresentation =                                                         // what the shell's signature check yields: claims only
  | { kind: "signature-verified"; claims: unknown }
  | { kind: "signature-rejected"; reason: "malformed" | "signature" }
type RunAuthorityRefusal =
  | { kind: "capability-unknown"; capabilities: readonly RequirementRef[] }                  // 503; every unknown node and capability
  | { kind: "delegated-capability-requires-user"; nodeId: NodeId; capability: string }       // 403
  | { kind: "delegated-token-required"; requirements: readonly RequirementRef[]; audience: EntraClientId }  // 401, names header + audience
  | { kind: "delegated-token-invalid"; reason: "malformed" | "signature" | "issuer" | "tenant" | "audience" | "expired" | "not-yet-valid" | "not-delegated" | "version" }  // 401
  | { kind: "identity-binding-mismatch"; field: "oid" | "tid" }                                // 403
  | { kind: "delegated-token-unexpected" }                                                     // 400
  | { kind: "delegation-unconfigured"; missing: readonly string[] }                            // 503
  | { kind: "agent-client-unmapped"; dagId: DagId }                                            // 503
  | { kind: "delegation-not-established"; reason: "refused" | "federation-rejected" | "grant-missing" | "unreachable" | "unconfigured" }  // 403/502/403/503/503; built only by runAuthorityRefusalOf
planRunAuthority(input: RunAuthorityInput): Result<AdmissionStep, RunAuthorityRefusal>                     // pass 1, pure, no token check
  // input.requirements: readonly RawCapabilityRequirement[]; classifyCapabilities runs first
admitDelegatedPresentation(step: VerifyDelegatedStep, p: DelegatedPresentation, nowMs: EpochMs)
  : Result<Extract<RunAuthorityPlan, {kind:"user-delegated-pending"}>, RunAuthorityRefusal>             // pass 2, pure; grant = {step.token, validated claims}
issuerFor(tenant: EntraTenantId): string                                    // https://login.microsoftonline.com/{tenant}/v2.0; the one derivation
validateEntraUserTokenClaims(claims: unknown, expect: DelegatedTokenExpectation, nowMs: EpochMs): Result<VerifiedEntraClaims, RunAuthorityRefusal>
bindDelegatedPrincipal(realm: EntraPrincipal, verified: VerifiedEntraClaims): Result<EntraPrincipal, RunAuthorityRefusal>
originOf(run: BrokeredRunAuthority): InvocationOrigin   // agent → {agent, agentClientId}; user-app | user-delegated → {user, sub: initiator.realmSub, agentClientId}
// adapters/entra-user-token-verifier.ts: a plain adapter function, no port (one implementation; the JWKS transport is the seam)
verifyEntraUserToken(step: VerifyDelegatedStep, jwks: EntraJwks, signal: AbortSignal): Promise<DelegatedPresentation>
```

Refusal precedence, a property-tested total order over the composed admission: `capability-unknown` → `agent-client-unmapped` → `delegated-capability-requires-user` → `delegated-token-unexpected` → `delegation-unconfigured` → `delegated-token-required` → `delegated-token-invalid` → `identity-binding-mismatch`. `capability-unknown` is first because no later decision is defined over a capability without a mode: whether delegation is required, which audience applies and whether a header is expected all read `authorityOf` (design-review loop-back 6). Pass 1 decides everything up to and including a malformed header (`delegated-token-invalid{malformed}`). Pass 2 decides the remaining `delegated-token-invalid` reasons and the binding. Every pass-1 refusal outranks every pass-2 refusal, so splitting at the verification step preserves the order. The verifier is reachable only with a `verify-delegated` step, which is its first parameter: the step's `expect` exists only when the Entra leg is wired, the agent is mapped, no capability is unknown and `delegatedAudienceFor` has answered. The pure property test composes pass 1 and pass 2 over generated presentations with no fakes; `run-authority-admission.test.ts` and CT-1 count requests on the JWKS transport, and the count is zero whenever pass 1 refuses or decides.
**Depends on:** catalog, CT-1 types, framework `runtimeNodeInventory`, `lazyJwks` (inside the verifier only), `delegatedAudienceFor` (INV-5).

### Delegated Custody

**Responsibility:** Hold the run-bound refresh credential only as ciphertext, through a typed lifecycle with a fixed expiry, until the run's terminal state.
**Files:** `domain/delegated-custody.ts` (LC-1 and `decideRedeemStep`), `domain/port/delegated-custody-store.ts`, `adapters/custody-cipher.ts`, `adapters/delegated-custody-store-redis.ts`, `adapters/delegated-custody-store-memory.ts`, `adapters/run-custody-cell.ts`, `adapters/delegation-establishment.ts`, `adapters/run-authority-lifecycle.ts` (INV-4 owner)
**Interface:**

```
type CustodySeconds = Brand<number, "CustodySeconds">           // only parseCustodySeconds(raw, runTtlSec) builds it: 0 < s ≤ HITL_RUN_TTL_SEC
type CustodyBinding = { runId: RunId; agentClientId: AgentClientId; entra: EntraPrincipal; expiresAtMs: EpochMs }   // a DERIVED view, never stored
custodyBindingOf(authority: UserDelegatedAuthority): CustodyBinding   // the AAD and the store key; every field, runId included, from the one authority
type SealedRefreshCredential = { kid: string; iv: string; ciphertext: string }          // base64url
type CustodyGeneration = Brand<number, "CustodyGeneration">     // assigned ONLY by the store: 0 on put, expected + 1 on swap
type CustodyState =                                             // LC-1 states = what get returns; no state carries a binding or an expiry
  | { kind: "absent" }
  | { kind: "held"; sealed: SealedRefreshCredential; generation: CustodyGeneration }
  | { kind: "revoked"; reason: "refused"; generation: CustodyGeneration }
type CustodySuccessor =                                         // what a transition yields and a write carries: no generation field
  | { kind: "held"; sealed: SealedRefreshCredential }
  | { kind: "revoked"; reason: "refused" }                      // the sealed bytes are dropped
type CustodyEvent =                                             // the binding comes from the run's authority on every event that needs a time guard
  | { kind: "establish"; binding: CustodyBinding; sealed: SealedRefreshCredential; nowMs: EpochMs; cap: CustodySeconds }
  | { kind: "rotate"; binding: CustodyBinding; sealed: SealedRefreshCredential; nowMs: EpochMs }
  | { kind: "refuse" }
type CustodyTransitionFault =
  | { kind: "undeclared"; from: CustodyState["kind"]; event: CustodyEvent["kind"] }
  | { kind: "past-expiry" }                                     // rotate at or after binding.expiresAtMs, or establish with expiry ≤ now
  | { kind: "cap-exceeded" }                                    // establish with expiry beyond now + cap
transitionCustody(state: CustodyState, event: CustodyEvent): Result<CustodySuccessor, CustodyTransitionFault>
reauthorizationReasonOf(state: Exclude<CustodyState, {kind:"held"}>, binding: CustodyBinding, nowMs: EpochMs): ReauthorizationReason
custodyExpiryFor(now: EpochMs, max: CustodySeconds, runDeadline: EpochMs): EpochMs   // min(now + custodySecondsToMs(max), runDeadline)

// Persistence. The fence is in the types: a write carries a CustodySuccessor, which has no generation, so only the store sets one.
type HeldCustody = Extract<CustodyState, {kind:"held"}>
type StoredCustody = Exclude<CustodyState, {kind:"absent"}>
type CustodySwapOutcome =
  | { kind: "swapped"; written: StoredCustody }                 // stored generation was expected; next written as expected + 1 with the remaining TTL
  | { kind: "stale"; current: StoredCustody }                   // another writer moved first; nothing written
  | { kind: "missing" }                                         // no record (released, expired at PX, purged); nothing written, never created
interface DelegatedCustodyStore {
  put(binding: CustodyBinding, initial: Extract<CustodySuccessor, {kind:"held"}>): Promise<Result<void, HostError>>
      // NX; key fugue:<tenant>:authority:custody:<binding.runId>; writes generation 0; PX at binding.expiresAtMs
  get(runId: RunId): Promise<Result<CustodyState, HostError>>                                   // missing or past PX → absent
  swap(runId: RunId, expected: CustodyGeneration, next: CustodySuccessor): Promise<Result<CustodySwapOutcome, HostError>>
      // atomic: writes next with generation expected + 1 iff the stored generation is expected; KEEPTTL; never creates
  delete(runId: RunId): Promise<Result<void, HostError>>                                        // idempotent; handed ONLY to the lifecycle owner
}

// The run custody cell's protocol, pure (domain/delegated-custody.ts, beside transitionCustody). The cell
// (adapters/run-custody-cell.ts) performs each effect and feeds the outcome back; it decides nothing itself.
type PendingCustodyWrite = { expected: CustodyGeneration; next: Extract<CustodySuccessor, {kind:"held"}> }
type RedeemState = { binding: CustodyBinding; nowMs: EpochMs; pending: PendingCustodyWrite | null;
                     progress: { kind: "begin" } | { kind: "flushing" } | { kind: "reading" } | { kind: "opening"; held: HeldCustody }
                             | { kind: "redeeming"; held: HeldCustody }
                             | { kind: "writing"; expected: CustodyGeneration; next: CustodySuccessor; attempt: "first" | "retry"; then: "grant" | "refused" } }
type RedeemEffect =
  | { kind: "flush"; expected: CustodyGeneration; next: CustodySuccessor }   // a write an earlier redeem could not complete
  | { kind: "read" }
  | { kind: "open"; held: HeldCustody }
  | { kind: "redeem"; held: HeldCustody }                       // mint, then redeemDelegation with the opened credential; the cell seals any rotated one
  | { kind: "write"; expected: CustodyGeneration; next: CustodySuccessor }
type RedeemOutcome =
  | { kind: "begun" }
  | { kind: "flushed" | "written"; outcome: CustodySwapOutcome | { kind: "store-failed" } }
  | { kind: "read"; outcome: CustodyState | { kind: "store-failed" } }
  | { kind: "opened"; ok: boolean }                             // the plaintext stays in the cell; the decision sees only ok
  | { kind: "redeemed"; rotated: SealedRefreshCredential | null }
  | { kind: "redeem-failed"; fault: DelegatedGrantFault }
type RedeemStep =
  | { kind: "perform"; effect: RedeemEffect; state: RedeemState }
  | { kind: "finish"; result: { kind: "grant" } | { kind: "fault"; fault: AcquisitionFault };
      pending: PendingCustodyWrite | null; log: readonly CustodyLogEvent[] }   // CustodyLogEvent: custody-unopenable | custody-defect | custody-rotation-contended | custody-revocation-write-failed
decideRedeemStep(state: RedeemState, outcome: RedeemOutcome): RedeemStep   // total; the whole outcome table

// The run-authority lifecycle (INV-4 owner): one operation owns the bracket from establishment to release.
type SyncRunEnding = { outcome: "completed" | "failed" | "aborted" }              // aborted covers the route's timeout and client cancel
type HitlRunEnding = { outcome: "completed" | "failed" | "corrupt-checkpoint" | "record-evicted" }   // a rejected gate settles failed
type CustodyReleaseCause =                                                         // derived by the owner, never chosen by a caller
  | { kind: "sync-ended"; outcome: SyncRunEnding["outcome"] }
  | { kind: "hitl-ended"; outcome: HitlRunEnding["outcome"] }
  | { kind: "establishment-abandoned"; path: "sync" | "hitl"; step: "establish" | "persist" }
type CustodyReleaseOutcome = { kind: "released" } | { kind: "release-failed"; error: HostError }
type EstablishForRecordFailure = { kind: "refused"; refusal: RunAuthorityRefusal } | { kind: "persist-failed"; error: HostError }
type AuthorizedRun = { authority: RunAuthority; minting: RunMintingAuthority | undefined }   // minting: the bracket's ONE forRun handle; absent only for unbrokered
interface RunAuthorityLifecycle {
  withEstablishedAuthority<T>(plan: RunAuthorityPlan, runId: RunId, deadlineMs: EpochMs,
      body: (run: AuthorizedRun) => Promise<{ ending: SyncRunEnding; value: T }>): Promise<Result<T, RunAuthorityRefusal>>
      // establish → forRun once → body → release(sync-ended{ending}) in finally; body rejection → release(sync-ended{failed}) and rethrow;
      // establish Err → release(establishment-abandoned{sync, establish}) and Err(runAuthorityRefusalOf(fault))
  establishForRecord<T>(plan: RunAuthorityPlan, runId: RunId, deadlineMs: EpochMs,
      persist: (authority: RunAuthority) => Promise<Result<T, HostError>>): Promise<Result<T, EstablishForRecordFailure>>
      // establish → persist; either failing → release(establishment-abandoned{hitl, establish | persist}); no handle (nothing executes)
  withRecordedAuthority<T>(authority: RunAuthority, body: (run: AuthorizedRun) => Promise<T>): Promise<T>
      // one HITL slice: forRun once over the persisted authority → body; neither establishes nor releases
  endRun(runId: RunId, ending: HitlRunEnding): Promise<CustodyReleaseOutcome>   // release(hitl-ended{ending}); never rejects
}
createRunAuthorityLifecycle(deps: { establish: (plan: Extract<RunAuthorityPlan,{kind:"user-delegated-pending"}>, runId: RunId, deadlineMs: EpochMs)
      => Promise<Result<UserDelegatedAuthority, EstablishmentFault>>;          // establishDelegation, partially applied by the wiring
    capabilityAuthority: CapabilityAuthority;                                    // the lifecycle is the ONLY holder of forRun
    custody: Pick<DelegatedCustodyStore, "delete">; logger: LogPort }): RunAuthorityLifecycle   // INV-4 owner
establishDelegation(deps: { mint; entra; cipher; custody: Pick<DelegatedCustodyStore, "put">;
                            directory: EntraDirectory; delegation: Extract<DelegationLeg, {kind:"wired"}>; now: () => EpochMs },
    plan: Extract<RunAuthorityPlan,{kind:"user-delegated-pending"}>, runId: RunId, runDeadlineMs: EpochMs)
  : Promise<Result<UserDelegatedAuthority, EstablishmentFault>>
  // delegation = {runId, audience: delegatedAudienceFor(directory, agent) (INV-5), custodyExpiresAtMs: custodyExpiryFor(now(), delegation.maxSec, runDeadlineMs)};
  // binding = custodyBindingOf(authority); seal with AAD = binding; put(binding, held{sealed}); no compensation of its own
```

**The run custody cell: one writer per run.** `forRun(user-delegated)` creates exactly one cell, `createRunCustodyCell(deps, authority)` from `adapters/run-custody-cell.ts`, inside its closure, and only the run-authority lifecycle calls `forRun`, once per bracket. The cell is a single-flight queue: its operations run one at a time, in arrival order. It is the only code in the process that reads or writes the run's custody, and every per-capability delegated access cell obtains credentials only through `cell.redeem(capability, resource, signal)`. A redeem is a loop: the cell asks `decideRedeemStep` what to do, performs that one effect (store `get` or `swap`, cipher `open` or `seal`, realm mint plus `redeemDelegation`), and feeds the outcome back, until the decision is `finish`. The plaintext refresh credential and the access credential stay in the cell; the decision sees only whether an open succeeded and the sealed rotated credential. Throughout, `binding = custodyBindingOf(authority)`.

The outcome table, every row decided by `decideRedeemStep` (design-review loop-back 6; before it, this table lived in prose inside `capability-authority.ts`). Every row is total. A store failure (`HostError`) never becomes an `AcquisitionFault` other than `unreachable{hop: custody-store, cause}`.

| State and outcome | Custody transition and next effect | Result of the invocation |
|---|---|---|
| begin, `nowMs ≥ binding.expiresAtMs` | none; no effect; any pending write dropped (the record vanishes at its PX) | `reauthorization-required{custody-expired}`, zero store reads, zero Entra calls |
| begin, pending write held | `flush` the pending `swap` first | continues |
| `flushed` → `swapped`, `stale` or `missing` | pending cleared; `read` | continues (a `missing` record reads `absent` next) |
| `flushed` → store failed | pending kept; no further effect | `unreachable{custody-store}` |
| `read` → store failed | none | `unreachable{custody-store}` (projects to retriable `infra-unreachable`) |
| `read` → `absent` | none | `reauthorization-required{custody-absent}`, or `{custody-expired}` if the expiry passed meanwhile (`reauthorizationReasonOf`) |
| `read` → `revoked` | none | `reauthorization-required{refused}` |
| `read` → `held` | `open` | continues |
| `opened` → not ok (AAD mismatch, kid no longer in the keyring) | none | `reauthorization-required{custody-absent}`, log `custody-unopenable` (runId and kid only) |
| `opened` → ok | `redeem` | continues |
| `redeem-failed` → `reauthorization-required{refused}` | `refuse` → `write(revoked)` against `held.generation` | `reauthorization-required{refused}` whatever the write outcome (a failed write is logged `custody-revocation-write-failed`), no `app` fallback |
| `redeem-failed` → any other fault | none | that fault |
| `redeemed`, no rotated credential | none | the access credential |
| `redeemed`, rotated, `rotate` → `Err(past-expiry)` | none; the rotated credential is discarded | `reauthorization-required{custody-expired}` |
| `redeemed`, rotated, `rotate` → any other `Err(CustodyTransitionFault)` | none | `reauthorization-required{custody-absent}`, log `custody-defect` at error (failed closed) |
| `redeemed`, rotated, `rotate` → ok | `write(held{sealed'})` against `held.generation` | continues |
| `written` → `swapped` | none further (the store wrote generation + 1) | the access credential |
| `written` (first attempt) → `stale{current: held}` | `rotate` from `current`; one more `write` against `current.generation` | continues |
| `written` (retry) → `stale` | none | the access credential, log `custody-rotation-contended`; the newer record the other writer stored stays, so a valid credential is persisted |
| `written` → `stale{current: revoked}` | none | `reauthorization-required{refused}` |
| `written` → `missing` | none; never recreated, because `swap` never creates | `reauthorization-required{custody-absent}`; the fresh access credential is discarded |
| `written` → store failed | the rotated write becomes the pending write, which the cell's next redeem flushes first | the access credential (the stored older generation remains the fallback) |

Within the process, the cell's serialization means two delegated capabilities never redeem the same refresh credential concurrently. Across processes, a stale lease holder, for example, is covered by the generation fence, which the compiler enforces: a write carries a `CustodySuccessor`, which has no generation, and the store writes `expected + 1` itself. The cell never discards its own rotated credential before at least one write attempt against the generation current at that time.

Release is unconditional and idempotent. A run that never held custody costs one `DEL` on a missing key, so no caller decides whether a run "had" custody, and a mutant owner cannot hide behind a skipped branch. The owner derives the cause from the bracket's own outcome, through one exhaustive match. A caller supplies only a run ending (`SyncRunEnding` from the sync body, `HitlRunEnding` from `processRun`'s fold), never a cause. On a dark delegation leg the owner is composed over the in-memory store, which stays empty because the planner refuses every delegated run there. A failed delete is logged at error as a structured record with `runId`, `cause` and the error kind only (never the sealed bytes), and the ciphertext still expires at its PX.

The binding is never stored. The custody record holds only `{kind, sealed, generation}` (or `{kind, reason, generation}` once revoked). `custodyBindingOf(authority)` derives the AAD at seal and at open, and the store key and PX at `put`, from the one `RunAuthority`, which the HITL record persists. So a record replayed under another run or user fails to open, and no second copy of the run id, the expiry or the initiator exists to diverge. The run store's schema refuses a record whose `user-delegated` authority names a different `runId` than the record, as corrupt.

**Depends on:** LC-1, CT-3 types, `RealmAssertionMint`, `EntraAgentAuthority`, `domain/acquisition-fault.ts`, the capability authority (for the lifecycle's `forRun`), Redis port.

### Capability Authority

**Responsibility:** For one run, turn a node's `requires` into narrowed handles under the run's authority, through the gate, the realm and Entra, with per-identity caching and audit.
**Files:** `adapters/capability-authority.ts`, `adapters/broker-audit.ts`, `adapters/graph-capability.ts`, `domain/token-cache.ts`
**Interface:**

```
type RunMintingAuthority = Pick<MintingAuthority, "broker" | "origin">   // framework MintingAuthority minus the host's LLM meter
interface CapabilityAuthority {
  readonly forRun: (run: BrokeredRunAuthority) => RunMintingAuthority   // { broker: closure over run, origin: originOf(run) }; the only builder of the pair
}                                                                        // called ONLY by the run-authority lifecycle, once per bracket
createCapabilityAuthority(deps: {
  catalog: CapabilityCatalog; legs: AuthorityLegs; assignedScopes: (a: AgentClientId) => ReadonlySet<string>;
  mint: RealmAssertionMint; entra: EntraAgentAuthority; custody: Pick<DelegatedCustodyStore, "get" | "swap">; cipher: CustodyCipher;
  graphHttp: GraphHttp; dynamicsOrgHost?: string; tracer; logger; audit; now: () => EpochMs
}): CapabilityAuthority
```

The run-authority lifecycle is the only caller of `forRun` (AD-6). Its bracket bodies build the framework `MintingAuthority` as `{ ...run.minting, meterLlm }` from the `AuthorizedRun` they receive. No host module stores an origin beside an authority: `createNodeContextForDag` hands the executor the `RunAuthority`, and `forRun` derives the origin with `originOf`. The broker reads identity (agent client, initiator, custody binding) only from its closure. It never reads `inv.origin`, which the framework's `invocationFor` takes from the same pair. So the former check, the run's `agentClientId` against `agentClientIdFromFrameworkOrigin(inv.origin)`, compared two values that now have one source, and it is removed.

Per invocation:
1. `decideGate(catalog, capability, assigned, dynamicsOrgHost)` classifies the requirement. `not-brokered` passes through; `unknown` is refused with zero egress (unreachable after admission, which refuses `capability-unknown`); an unassigned scope is refused with zero egress.
2. `authorityOf(scope)` picks the path:
   - `app`: the boot cell for (identity, app, capability) runs mint, then `acquireApp`. Its faults are `AppAcquisitionFault`.
   - `delegated` on a `user-delegated` run: the run cell for (identity, delegated, oid, capability) asks the run's custody cell (`adapters/run-custody-cell.ts`, Component Design, Delegated Custody) for an access credential for the capability's resource.
   - `delegated` on any other run kind: `reauthorization-required{custody-absent}`. This is unreachable after admission and is kept as defense in depth.
3. A failure is a fault of the path's subset, all assignable to `AcquisitionFault`. It becomes the node's framework error through `frameworkErrorOf`, the only place that projection is applied.
4. Build the handle and write the audit record.

The module holds no custody decision. `forRun(user-delegated)` creates the run's one custody cell with `createRunCustodyCell(deps, run)`, whose key and AAD come from `custodyBindingOf(run)`, and the delegated access cells call its `redeem`. The outcome table is `decideRedeemStep` in `domain/delegated-custody.ts` (design-review loop-back 6).

**Depends on:** every component above, plus the framework `CapabilityBroker` and `MintingAuthority`.

### Run Admission (HTTP shell)

**Responsibility:** Order the run-start steps so that every authority refusal happens before the HITL fork, concurrency, or egress, and so that custody is always torn down.
**Files:** `http/handlers/run-dag.ts`, `http/delegated-token-header.ts`, `domain/host-error.ts`, `host.ts`, `adapters/node-context-factory.ts`, `adapters/run-authority-admission.ts`, `adapters/run-authority-wiring.ts`
**Interface:**

```
RunDagDeps += {
  admitRunAuthority: (identity, registered, header: DelegatedHeader) => Promise<Result<RunAuthorityPlan, RunAuthorityRefusal>>   // RunAuthorityWiring.admitRunAuthority (two-pass)
  runAuthority: Pick<RunAuthorityLifecycle, "withEstablishedAuthority">   // RunAuthorityWiring.lifecycle; run-dag holds no store and no release function
  createContext: (registered, runId, signal, authority: RunAuthority) => Promise<NodeContextForDag>   // host.ts createRunContextFactory → createNodeContextForDag
  executeDag: (dag, input, ctx, run: AuthorizedRun, meter) => ...                                  // host.ts createDagExecutor → { ...run.minting, meterLlm }
}
NodeContextForDag = { ctx; authority: RunAuthority; meterMintedLlm }   // no origin field: forRun derives it with originOf
HitlRunService.startRun(dagId, team, input, identity, plan: RunAuthorityPlan)
```

Sync order: lookup, then access, then body, then schema, then **admit** (two-pass). If HITL, `startRun(…, plan)` (which brackets establishment with record creation) and return. Otherwise acquire, circuit, then **one call**: `runAuthority.withEstablishedAuthority(plan, runId, deadlineMs, body)`, where `body(run)` runs `createContext` over `run.authority`, then `executeDag` over `run`, and returns `{ending, value}`. On `Err(refusal)` (establishment failed, custody already released by the owner) respond with the refusal. The slot is released in the route's own `finally`, as today.

In a multi-tenant deployment the request reaches this handler through the supervisor: `proxyToWorker` (`supervisor/uds-proxy.ts`) clones every inbound header, deletes the client's `X-Fugue-Tenant`, stamps the signed one and forwards the rest, so `X-Fugue-Delegated-Authorization` arrives byte-identical and is never logged (the proxy logs only the tenant and the transport reason). CT-1 declares `proxyToWorker` as a runtime seam and its acceptance drives a submission through it, so a future header allowlist in the proxy that drops the delegated header fails CT-1.

After admission the initiator's attribution reaches the mint through two composition hops that `RunDagDeps` makes injectable: `createContext` (host.ts `createRunContextFactory`, which calls `createNodeContextForDag` and returns the `RunAuthority` beside the context) and `executeDag` (host.ts `createDagExecutor`, which builds the framework `MintingAuthority` as `{ ...run.minting, meterLlm }`, so broker and origin come from the one `forRun` call the lifecycle made for this bracket over one authority). Both host.ts factories are exported so `buildRouterDeps` and CT-4 acceptance use the same functions; CT-4 declares them and `createNodeContextForDag` as runtime seams, so an acceptance test that stubs either dep cannot decide AS-006, FR-004 or FR-020.

**One wiring, composed in one place.** Every identity dependency that the route, the HITL engine and the executor take by injection comes from one `RunAuthorityWiring`, built by `composeRunAuthorityWiring` (`adapters/run-authority-wiring.ts`): `admitRunAuthority` and the lifecycle narrowed to `withEstablishedAuthority` for `RunDagDeps`, the lifecycle narrowed to `establishForRecord` and `endRun` for `HitlRunServiceDeps`, and the lifecycle narrowed to `withRecordedAuthority` for the HITL executor. The capability authority is not exposed: the lifecycle holds it and is the only caller of `forRun`. The wiring is the only production caller of `createCapabilityAuthority`, `createRunAuthorityLifecycle`, `establishDelegation`, `createRunAuthorityAdmission`, the custody cipher and store, the JWKS resolver the user-token verifier reads and the identity-model adapter selection, so acceptance that takes its identity dependencies from it cannot pick a fake port, a no-op cipher or a hand-built `RunAuthorityPlan`. Its only free inputs are the configuration, the catalog (a branded `CapabilityCatalog`, so only `parseCapabilityCatalog` can have produced it; host.ts passes the one `loadCapabilityCatalog` returned at boot, and acceptance passes a parsed test catalog with delegated test capabilities, OOS-004), the network transports (`IdentityTransports`), the Redis port, the logger, tracer and audit sink, and the clock. host.ts calls it once and hands the same instance to `buildRouterDeps` and `composeHitlRunService`, which is what keeps a HITL run's start-time custody visible to its resumed executor. `HostDeps.capabilityBroker` is removed, because an embedder-injected broker was a production bypass of exactly this composition.

**Runtime-seam rule used by every contract.** A contract declares as a runtime seam every production symbol on its decided path that a test could otherwise substitute: an edge it enters through (`proxyToWorker`, `createAuthMiddleware`, a route handler, `handleBotActivity`, `invocationFor`) and the production factory of every dependency the path receives by injection (`composeRunAuthorityWiring`, `composeHitlRunService`, `createRunContextFactory`, `createDagExecutor`). A symbol the path reaches only through a static import inside a declared seam (for example `createNodeContextForDag` inside `createRunExecutor`, `brokerAuditPayload` inside `createCapabilityAuthority`, `createHitlRunService` and `createRunExecutor` inside `composeHitlRunService`) is traversed by construction and is not re-declared, because the engine requires each acceptance file to name every declared seam in code and an artificial import proves nothing. The acceptance seam sweep under Testing Strategy records, per contract and Requirement, which symbols are declared and why each excluded one cannot be bypassed.
**Depends on:** Planner, Custody, Capability Authority, HITL service.

### HITL Authority Continuity

**Responsibility:** Persist the run's authority and approvals, rebuild the broker from the record alone on resume, and delete custody at every terminal state.
**Files:** `hitl/types.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/run-executor.ts`, `http/handlers/runs.ts`, `hitl/adapters/bot/messages-handler.ts`
**Interface:**

```
RunRecord += { authority: RunAuthority; approvals: readonly ApprovalRecord[] }   // authority: Phase 4 cut-over; approvals: Phase 5
ApprovalRecord = { nodeId: NodeId; decision: HumanAction["kind"]; approver: ApproverRef; atMs: EpochMs }
recordDecision(runId, nodeId, action, approver: ApproverRef): Promise<Result<void, HostError>>
HitlRunServiceDeps += { runAuthority: Pick<RunAuthorityLifecycle, "establishForRecord" | "endRun"> }   // RunAuthorityWiring.lifecycle; no custody store
RunExecutorDeps: broker → runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority">   // RunAuthorityWiring.lifecycle; one handle per slice
RunRecord.identity → RunRecord.authority; RunExecutionRequest.identity → authority    // Phase 4 cut-over: one persisted source of the initiator
TeamsApprover = { kind: "teams-approver"; aadObjectId: string; canRunDag: (team: Team) => boolean }   // domain/auth.ts; not an AuthIdentity
ProcessRunOutcome = { kind: "continuing" } | { kind: "ended"; ending: HitlRunEnding }   // processRun's single fold; endRun is called once, after it
composeHitlRunService(args: HitlWiringArgs, queueBackend: QueueBackend, notifier): { service; runQueue }   // host.ts, exported; args.runAuthority: RunAuthorityWiring
```

`startRun` makes one `runAuthority.establishForRecord(plan, runId, clock() + HITL_RUN_TTL_SEC, persist)` call, whose `persist` creates the run record carrying the established authority. `processRun` folds each of its paths into one `ProcessRunOutcome`: the executor's completed, failed (a rejected gate included) and suspended results, the corrupt-checkpoint settle and the evicted record. It then calls `runAuthority.endRun(runId, ending)` exactly once when the outcome is `ended`. A record already terminal is `continuing`, because its release happened when it became terminal.

`composeHitlRunService` is the production HITL composition: it builds `createRedisRunStore` and `createRedisDecisionStore` over the tenant's Redis, `createRunExecutor` over `args.runAuthority.lifecycle` narrowed to `withRecordedAuthority`, `createRunQueue` over the injected backend and `createHitlRunService` over all of them plus the narrowed `args.runAuthority.lifecycle`. CT-3 acceptance uses it, with an in-process `QueueBackend` and `runQueue.startWorker(service.processRun)`, so the durable record schema (where `authority` and `approvals` persist), the lease-fenced processing and the executor's broker are production code, not a hand-assembled service.

The approver is derived where production derives it, never handed in by a caller of the service: `createApproveRunHandler` maps the `AuthIdentity` that `createAuthMiddleware` built (a realm user carries its Entra principal) to `realm-user{realmSub, entra}`, `team{team}` or `admin`, and serializes refusals through `errorResponse`; `handleBotActivity` resolves the verified activity's `from.aadObjectId` to a `TeamsApprover` (`approverTeamIdentity`), authorizes it through `canAccessDag`, and maps it to `teams-user{aadObjectId}`. A Teams approver is never an `AuthIdentity`, so it carries no fabricated realm principal and cannot initiate a run. CT-3 declares all four symbols as runtime seams, so its acceptance approves through the route and the bot handler, not through `recordDecision` with a hand-built approver.

**Depends on:** CT-1 and CT-3 types, Capability Authority, the run-authority lifecycle (INV-4).

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
framework dispatch → invocationFor(MintingAuthority{...run.minting, meterLlm}) → broker.mintFor(inv, requires)
  → decideGate(catalog, capability, assigned) ─not-brokered→ pass-through │ ─unknown | refused→ policy-refusal (0 egress)
  → authorityOf(scope) = app → boot cell[(entraId, app, cap)]
      miss → RealmAssertionMint(scope="entra-exchange cap") → inspectFederatedAssertion
           → EntraAgentAuthority.acquireApp (agent-id: blueprint fmi_path → T1 → agent identity; app-reg: one step)
      fault → AppAcquisitionFault → frameworkErrorOf → authority-unavailable | infra-unreachable
  → buildGraphHandle → audit{run,node,agent,entraId,cap,mode=app,initiator?}

User-app sync run start (CT-4):
POST /dags/:id/run (realm JWT[sub, entra_oid, entra_tid]) → admit: pass 1 → decided user-app{initiator{realmSub, oid, tid}} (no token retained, 0 JWKS calls)
  → acquire → withEstablishedAuthority(plan, runId, deadline, body)   [establish = identity; forRun once → AuthorizedRun]
      body(run): createRunContextFactory → createNodeContextForDag(run.authority) → {ctx, authority}
            → createDagExecutor → runDag(MintingAuthority{...run.minting, meterLlm}) → per node as above → audit{…, initiator{realmSub, oid, tid}}
  → release(sync-ended{ending}) (unconditional, idempotent)

Delegated run start:
POST /dags/:id/run (Authorization: realm JWT[entra_oid,entra_tid]; X-Fugue-Delegated-Authorization: Entra JWT[aud=blueprint|agent app])
  → auth middleware → AuthenticatedUser{entra} → parseDelegatedTokenHeader → absent | present | malformed
  → pass 1: planRunAuthority(identity, agent, requirementsOf(runtimeNodeInventory), catalog, legs, header)
      → classifyCapabilities ─unknown→ capability-unknown
      ─static refusal→ run-authority-refused (0 JWKS, 0 slot, 0 egress)
      → verify-delegated{token, expect{tenant, audience = delegatedAudienceFor}}
  → verifyEntraUserToken(step, jwks) (JWKS transport, RS256, issuerFor(tenant)) → signature-verified{claims} | signature-rejected
  → pass 2: admitDelegatedPresentation → validateEntraUserTokenClaims → bindDelegatedPrincipal → user-delegated-pending{grant: step.token + claims}
  → HITL: startRun → establishForRecord(plan, runId, deadline, persist = create record{authority})
    sync: acquire → withEstablishedAuthority(plan, runId, deadline, body)
  → establishDelegation: custodyExpiryFor → RunAuthority.user-delegated{delegation{runId, audience, expiry}} → custodyBindingOf(authority) → mint → OBO(offline_access)
      → seal(AES-GCM, AAD = binding) → custody.put(binding, held{sealed}) (store writes generation 0, PX = binding expiry)
  → RunAuthority.user-delegated (persisted on HITL record; user token dropped; no binding stored anywhere else)

Delegated node invocation (incl. after resume, any approver):
lifecycle bracket (sync) | withRecordedAuthority(record.authority) (HITL slice) → forRun once → access cell[(entraId, delegated, oid, cap)] miss
  → run custody cell (single-flight, one writer per run): loop decideRedeemStep(state, outcome) → perform effect
  → now ≥ authority expiry? → reauthorization-required{custody-expired} (0 store reads, 0 Entra calls)
  → [flush pending write] → custody.get → absent | revoked → reauthorizationReasonOf | held → open(AAD = custodyBindingOf)
  → mint → redeemDelegation → rotated? → transitionCustody(rotate) → seal → swap(runId, expected: gen, next) (store writes gen + 1)
      swapped → handle | stale → rotate from current, one retry → handle | missing → custody-absent (never recreated)
  refused → transitionCustody(refuse) → swap(revoked) → authority-unavailable{reauthorization-required: refused} (no app fallback)

Run ending (the lifecycle derives the cause; no caller picks one):
  sync: withEstablishedAuthority's finally → SyncRunEnding completed | failed | aborted (timeout, cancel) | body rejected → failed
  hitl: processRun fold → HitlRunEnding completed | failed (incl. rejected) | corrupt-checkpoint | record-evicted → endRun
  abandoned: establish Err (incl. ambiguous put) | HITL persist Err → establishment-abandoned
  → custody.delete (INV-4 owner, unconditional, idempotent, never throws)
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

Since design-review loop-back 6, LC-1 is exactly the persisted lifecycle. Its states are the three values `DelegatedCustodyStore.get` can return, and every transition is one that production performs and persists: `establish` is `establishDelegation`'s `put`, and `rotate` and `refuse` are the custody cell's `swap`, both decided by `decideRedeemStep`. The former `expired` and `deleted` states and the `expire` and `teardown` events are removed, because nothing ever persisted or observed them. Expiry is a pure comparison against the run authority's `custodyExpiresAtMs` (in `decideRedeemStep` and `reauthorizationReasonOf`), and the record vanishes at its PX. Release is the INV-4 owner's `DEL` of the whole record, which is not a transition between persisted states: whatever the state, the key becomes `absent`.

The machine's guards (all times are `EpochMs`, the cap a `CustodySeconds`; no state carries a binding or an expiry, and the binding is an event input derived from the run's `RunAuthority` by `custodyBindingOf`):
- `establish` requires `binding.expiresAtMs > nowMs` and `binding.expiresAtMs ≤ nowMs + custodySecondsToMs(cap)`, and yields the successor `held{sealed}`, which `put` writes at generation 0.
- `rotate` requires `nowMs < binding.expiresAtMs` and yields `held{sealed'}`, which `swap` writes at generation + 1. A guard failure is `past-expiry`, which `decideRedeemStep` turns into `custody-expired` with no write. Expiry cannot be extended because no state holds one: the only expiry is the immutable `RunAuthority`'s.
- `refuse` yields `revoked{reason: refused}` and drops the sealed bytes, so a revoked record holds no ciphertext.
- `revoked` has no outgoing event, and only `establish` leaves `absent`, so a rotation can neither revive a revoked custody nor recreate a released one.
- Any other (state, event) pair is `Err(CustodyTransitionFault{undeclared})`.

Persistence follows the CT-3 types. A transition yields a `CustodySuccessor`, which has no generation field; the store assigns generation 0 on `put` and `expected + 1` on `swap`, and `swap` writes only over the generation it was given. So the compiler, not a comment, enforces the fence.

`reauthorizationReasonOf(state, binding, nowMs)` maps the non-`held` states as follows:
- `revoked` → `refused`
- `absent` with `nowMs ≥ binding.expiresAtMs` → `custody-expired` (the record vanished at its PX)
- `absent` with `nowMs < binding.expiresAtMs` → `custody-absent` (released, evicted or purged before expiry)

The custody cell's first decision compares the authority's expiry before any read, so a resume past expiry is `custody-expired` with zero store reads and zero Entra calls. The `absent`-past-expiry row covers the race where expiry passes between that check and the read. The store never needs to keep a record past its cap to tell expired from absent.

The property tests assert what production depends on: exactly the three declared pairs are accepted; `rotate` at or after expiry is refused (the cell then writes nothing); `establish` beyond the cap is refused (establishment cannot store over-cap custody); `refuse` leaves no sealed bytes (`assertCustodyCiphertextOnly` relies on it); nothing leaves `revoked` and only `establish` leaves `absent` (the cell never writes over a revocation or recreates a released record). The store tests assert the generation the store assigns.

The machine imports `CustodyState`, `CustodySuccessor` and `CustodyEvent` from the CT-3 types file, so the frozen ADT is declared once.

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
- `packages/host/src/domain/capability-gate.ts` — the mint-time gate classifies each requirement and hands the mint path a catalog-minted scope in its `gated` decision
- `packages/host/src/domain/run-authority.ts` — run-start admission decides whether delegation is required
- `packages/host/src/adapters/capability-authority.ts` — the mint path chooses the app or delegated acquisition
- `packages/host/src/http/handlers/manifest.ts` — publishes each DAG's capability modes and the delegated header requirement
**Matrix test:** `packages/host/src/__tests__/authority-mode.matrix.test.ts`
**Statement:** Every call site that needs a capability's authority mode reads it through `authorityOf` on a `CapabilityScope`, which only the catalog module mints from a key of a parsed `CapabilityCatalog`, so `authorityOf` is total and no caller can be handed a capability without a mode (an unknown requirement in a brokered namespace is refused `capability-unknown` at admission instead). No module hard-codes a mode, defaults a missing mode, or keeps a second mode table. The rule covers admission, the mint-time gate, mint-path dispatch and the manifest. The matrix test generates catalogs (fast-check, including delegated test entries) and asserts that all four siblings report the owner's mode for every scope, so a mutant owner that answers "app" fails it. The tier is advisory because no lint rule can tell a mode read from a mode invented; the matrix test and owner mutation verification enforce it. The matrix test lands in Phase 1 with the owner and the gate, and Phases 2, 3 and 5 each extend it in the Wave that adds a sibling.

### INV-3: No credential material in any observable surface

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A prohibition. It spans every module that logs, audits, formats errors, builds handles or persists records, and no single module can own an absence (FR-022, SC-007).
**Statement:** No bearer token, assertion, refresh token, T1 token or custody plaintext appears in logs, audit records, trace spans, error values (`formatFrameworkError` and `discloseHostError` output included), HTTP responses, capability handles, `InvocationOrigin`, `RunAuthority` or `RunMintingAuthority` values, HITL run records and checkpoints, or custody records at rest, which hold only ciphertext. A regex cannot recognise a token value, so this stays advisory. It is decided by acceptance in the phase that builds each surface, over the production composition (`composeRunAuthorityWiring` and the declared seams), with the shared `acceptance/support/credential-sentinel.ts` scan: FR-022 in CT-2 (mint path: logs, audit, spans, errors, handles, custody re-sealed on rotation; Phase 3), AS-037 in CT-1 (run start: HTTP responses, worker and proxy logs, audit, errors, the admitted authority; Phase 4 cut-over), AS-039 in CT-4 (`app` execution: origin, run authority, `RunMintingAuthority`, handles, audit, logs, the run's HTTP response; Phase 4 cut-over) and AS-038 in CT-3 (continuation: run records and checkpoints, approvals, `hitl-decision` audit, error values, HTTP responses of the start, status and approve routes and the bot handler, custody at rest as ciphertext only; Phase 5). `AcquisitionFault` values count as error values; `classifyTokenEndpointError` copies only error codes into a fault, never response text, and since design-review loop-back 6 a fault has no free-string field at all (`unreachable` carries the closed `UnreachableCause`, rendered to text only by `frameworkErrorOf` from the hop, the status digits and fixed words), so for faults this part of the rule is held by the type. The redaction primitive is `domain/redacted-secret.ts`: a `RedactedSecret` renders `[redacted]` under every serialisation, and `revealSecret` is called only by the Entra form-body builders, the custody cipher and the user-token verifier. The framework's `authority-unavailable-error.test.ts` adds a property test that formatted causes never contain an injected sentinel. There is no separate trailing scan: a leak is found in the Wave that builds the surface.

### INV-4: A run's delegated authority is established, handed to execution and released by one lifecycle owner

**Tier:** advisory
**Owner module:** `packages/host/src/adapters/run-authority-lifecycle.ts`
**Sibling entry points:**
- `packages/host/src/http/handlers/run-dag.ts` — the sync path's one `withEstablishedAuthority` call, which brackets establishment, the run's one minting handle, context creation, execution and release
- `packages/host/src/hitl/service.ts` — `startRun`'s one `establishForRecord` call and `processRun`'s one `endRun` call after its outcome fold
- `packages/host/src/hitl/adapters/run-executor.ts` — each slice's one `withRecordedAuthority` call, which builds the slice's one minting handle from the persisted authority
**Matrix test:** `packages/host/src/__tests__/run-authority-lifecycle.matrix.test.ts`
**Statement:** One operation owns the bracket from a run's authority establishment to its custody release, and the minting handle each execution bracket uses: the run-authority lifecycle that `createRunAuthorityLifecycle` builds (FR-023, AS-027, SC-012). It establishes through `establishDelegation`, builds each bracket's handle through `capabilityAuthority.forRun`, which it alone holds, so one custody cell per run is structural (design-review loop-back 6), and releases through `DelegatedCustodyStore.delete`, which it alone holds. It derives the release cause from the bracket's own outcome: the sync body's `SyncRunEnding`, a rejected body, the HITL `HitlRunEnding`, or a failed establish or persist step. So no module pairs an establishment with a release by hand, picks a cause, builds a second handle or custody cell for a run, or deletes, expires or overwrites custody to end a run. Siblings receive the lifecycle narrowed to the part they use (`withEstablishedAuthority` for the route, `establishForRecord | endRun` for the HITL service, `withRecordedAuthority` for the HITL executor) and hold no store and no `forRun`, so a second deletion path or a second handle does not type-check. `delegation-establishment.ts` is not a sibling (it was one before design-review loop-back 5): it holds only `put`, and every establishment `Err`, an ambiguous `put` included, returns to the owner, which releases. `run-custody-cell.ts` is not a sibling either: it holds only `get` and `swap`, `swap` never creates or deletes, and the cell is created only inside a `forRun` the owner calls. Two removals have no code path and are outside the sibling list by design, and `delegated-custody-store-redis.test.ts` asserts both: an idle run record evicted by Redis TTL (custody PX is the binding expiry, fixed at establishment and at most `HITL_RUN_TTL_SEC`, so custody expires no later than the record) and tenant purge (`purgeTenantKeyspace` deletes `fugue:<tenant>:*`, custody keys included). The matrix test uses the real owner over the in-memory store, with a delegated plan established through it. It drives each path and after each asserts that `get(runId)` is `absent` and that the logged cause is the one the owner derives for that path. The sync paths go through the real route handler: completed, failed, aborted by timeout, body rejected, and establishment failed with a failed or an ambiguous `put`. The HITL paths go through the real service: completed, failed, rejected, corrupt checkpoint, evicted record, and record creation failed after establishment. A row with a store whose `delete` fails asserts `release-failed`, one error log naming `runId` and `cause` with no credential bytes, and that no sibling path throws. A row per sibling asserts that the sibling makes exactly its declared lifecycle calls (one for the route, one per half for the service, one per slice for the executor), and a row per bracket asserts that the owner calls `forRun` exactly once and the body mints through that handle. So a mutant owner that skips the delete, mis-derives the cause, swallows the outcome, drops the log or builds a second handle fails the matrix, and so does a sibling that bypasses the bracket or calls it twice. The tier is advisory because a regex cannot tell a custody delete from any other `delete` call; the narrowed sibling types, the matrix test and owner mutation verification enforce it. The owner and the matrix test's owner rows land in Phase 3. All three sibling rows land in the Phase 4 cut-over Task, which changes the three siblings' signatures together with their callers (Phase boundary rule).

### INV-5: The delegated audience has exactly one source

**Tier:** advisory
**Owner module:** `packages/host/src/domain/authority-legs.ts`
**Sibling entry points:**
- `packages/host/src/domain/run-authority.ts` — pass 1 builds the `DelegatedTokenExpectation` (the expected `aud` that `validateEntraUserTokenClaims` checks) and the audience named in the `delegated-token-required` 401
- `packages/host/src/adapters/delegation-establishment.ts` — the `delegation.audience` recorded on the `user-delegated` run authority it returns
- `packages/host/src/http/handlers/manifest.ts` — the audience the manifest tells run-starting callers to request
**Matrix test:** `packages/host/src/__tests__/delegated-audience.matrix.test.ts`
**Statement:** Every call site that needs the audience a delegated Entra user token must carry obtains it from `delegatedAudienceFor(directory, agentClientId)`: the blueprint client id under the Agent ID model and the agent's own app id under the app-registration model (AD-7). No module derives the audience from the directory itself, defaults it, or keeps a second mapping. The rule covers admission's claim validation, establishment's recorded audience and the manifest's published audience (FR-008, FR-036), so a caller told one audience is never verified against another. The matrix test generates directories for both models (fast-check: arbitrary agent maps and blueprints) and asserts, for every mapped agent, that admission accepts a token audienced to the owner's answer and refuses `delegated-token-invalid{audience}` for any other, that establishment's run authority carries the owner's answer, and that the manifest publishes it; a mutant owner that answers the blueprint under the app-registration model fails it. The tier is advisory because a regex cannot tell an audience read from an audience invented; the matrix test and owner mutation verification enforce it. The owner, the matrix test's owner rows and the `run-authority.ts` row (the planner is built in Phase 2) land in Phase 2. Since design-review loop-back 5, pass 1 builds the expectation, so the admission sibling is `run-authority.ts` and no longer `run-authority-admission.ts`; its row still drives the composed admission. Phase 3 adds the establishment row and Phase 5 the manifest row.

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
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the production two-pass `admitRunAuthority`, composing `requirementsOf`, pass 1 `planRunAuthority`, the Entra user token verifier over the injected JWKS transport, and pass 2 `admitDelegatedPresentation` over `validateEntraUserTokenClaims` and `bindDelegatedPrincipal`; and the run-authority lifecycle whose `withEstablishedAuthority` an admitted sync submission runs in)
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
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the production capability authority for the configured identity model, composing `planAuthorityLegs`, the realm assertion mint adapter, the Entra agent authority adapter for the declared model, the custody cipher and store and `createCapabilityAuthority` over the injected transports; every run's minting handle comes from its lifecycle's bracket, the only caller of `forRun`, and delegated run authorities come from its `admitRunAuthority` and its lifecycle's `withEstablishedAuthority`)
**Statement:** For a run's authority, each required capability yields a narrowed handle backed by a credential issued to that agent's own Entra identity; the realm assertion always carries both the Entra-exchange and the capability grant, and the two identity models are interchangeable with identical capability and DAG definitions. Caches never cross agent identity, authority mode or user, app and delegated handles in one node are unreachable from each other, a delegated refusal never falls back to `app`, and audit records carry the run, node, agent client, Entra identity, scope, mode and initiator `oid` with no credential material. Refused: an unassigned scope (zero egress); a missing Entra-exchange or capability grant (zero Entra egress, naming the grant); a federation rejection (distinguished from a transient failure); and a delegated capability on a non-delegated run. On a deployment whose Entra identity leg is dark (no presence keys, or only one), every acquisition fails `authority-unavailable{authority-unconfigured}` naming the missing keys, with zero realm and Entra egress (FR-015, NFR-010). A transient realm or Entra failure (429, 5xx, timeout) surfaces as retriable `infra-unreachable` after exactly one transport call, with no internal retry (FR-015, NFR-021). Concurrent cold acquisitions for one (Entra identity, mode, capability) make exactly one realm and one Entra call, and concurrent acquisitions across agent identities, modes or users never receive each other's credential (FR-014, NFR-012). Custody has one writer per run. When two `delegated` capabilities with different resources are acquired concurrently in one `user-delegated` run, and each redeem returns a rotated refresh credential, both acquisitions succeed. The Entra transport sees the two refresh requests one after the other, the second presenting the refresh credential the first rotated in. The custody record afterwards is at generation 2 and opens to the second rotated credential. A rotation whose compare-and-swap finds the custody record released fails `reauthorization-required{custody-absent}` and leaves no record behind. A rotation whose compare-and-swap finds a newer generation, written by a second wiring over the same store standing in for another process, re-reads, swaps once more and succeeds, with no error and no rotated credential lost. The captured request bodies prove the federation shape: every realm request is client_credentials (zero RFC 8693 token-exchange bodies, FR-003), every Entra `client_assertion` is the agent's own realm assertion or the T1 derived from it and never a token whose subject is a human (FR-002), and no Entra request carries `client_secret` or a certificate assertion (FR-012). No credential material on the mint path (FR-022): with every realm assertion, T1, Entra access token, on-behalf-of access token and refresh token a sentinel from `credential-sentinel.ts`, `assertNoCredentialMaterial` finds none of them, nor any encoding of them, in any log line, audit record, trace span, error value (`formatFrameworkError` output of every refusal and failure above included) or capability handle (JSON, `String()` and `Bun.inspect` renderings), and `assertCustodyCiphertextOnly` holds for the custody record after a rotation re-seal. With `DELEGATED_CUSTODY_MAX_SEC` unset and `HITL_RUN_TTL_SEC` at its default, the `user-delegated` authority that the wiring's lifecycle establishes carries `custodyExpiresAtMs` = establishment + 604800 s, or the run deadline passed in when that is earlier, and its custody record's PX matches, so the default cap is checked in the phase that builds establishment (CT-3 decides FR-017 end to end). Every case takes its minting handle from a bracket of the lifecycle `composeRunAuthorityWiring` returns (`withEstablishedAuthority`, whose body receives the one handle the lifecycle built with `forRun`), for a deployment configured with `ENTRA_IDENTITY_MODEL` set to the Agent ID model and again to the app-registration model, so the adapter each model selects is the production one and the realm and Entra request bodies the tests capture are the bytes production sends; a `user-delegated` run authority is the one the wiring's `admitRunAuthority` and `withEstablishedAuthority` produce, and the delegated cases run inside that bracket, never over a hand-sealed custody record. With zero-latency injected realm and Entra transports, so that every measured millisecond is host-added, a cold acquisition through `invocationFor` and the bracket handle's `broker.mintFor` (gate, mint, assertion inspection, Entra acquisition for both identity models, custody open and rotation re-seal on the delegated path, handle build and audit) takes at most 10 ms p95, each cold sample on a fresh wiring and bracket handle built outside the timed region, and a cache hit at most 5 ms p95 with zero transport calls.

### CT-3: Run authority continuity across suspension

**Types file:** `packages/host/src/domain/delegated-custody-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts` — AS-007, AS-008, AS-020, AS-026, AS-034, AS-027, AS-028, AS-038, FR-016, FR-017, FR-025, FR-023
**Supported domain:** `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts`
**Entry point:** `packages/host/src/hitl/service.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: run submissions and HTTP approvals reach the worker here, with `Authorization` and `X-Fugue-Delegated-Authorization` forwarded)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: the initiator's and the HTTP approver's identity, including the Entra principal, is built here)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: the production start route; admission, then the HITL branch to `startRun` with the admitted plan, or the sync branch's one `withEstablishedAuthority` call bracketing establishment, execution and custody release)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: one instance supplies admission, the run-authority lifecycle from `createRunAuthorityLifecycle` over `establishDelegation` and the capability authority, which is the only establishment, the only builder of the per-bracket minting handles the executors mint through and the only custody release, and the custody cipher and store)
- `composeHitlRunService` (`packages/host/src/host.ts`: the production HITL composition of `createRedisRunStore`, `createRedisDecisionStore`, `createRunExecutor`, `createRunQueue` and `createHitlRunService` over the wiring; runs are processed by its own queue worker)
- `createRunContextFactory` (`packages/host/src/host.ts`: the sync path's production `createContext`)
- `createDagExecutor` (`packages/host/src/host.ts`: the sync path's production `executeDag`, minting through the one handle the lifecycle bracket built for the run)
- `createApproveRunHandler` (`packages/host/src/http/handlers/runs.ts`: the production approve route derives the `ApproverRef` from the middleware-built identity)
- `createGetRunHandler` (`packages/host/src/http/handlers/runs.ts`: the production run status route through which the initiator reads a HITL run's typed `reauthorization-required` failure)
- `handleBotActivity` (`packages/host/src/hitl/adapters/bot/messages-handler.ts`: the Teams approval path derives the `teams-user` `ApproverRef` from the verified activity)
- `errorResponse` (`packages/host/src/http/response.ts`: approve-route refusal serialization)
**Statement:** A user run's authority survives HITL suspension and token expiry. An `app` run resumes and completes under the agent identity, with attribution taken from the record and no user token, and a sync `app` run whose later nodes execute after the inbound tokens' expiry still succeeds. A delegated run establishes its delegation once at start, holds only an AES-GCM-sealed refresh credential bound to (run, agent, oid, tid) with expiry capped at the suspension window, obtains its first on-behalf-of credential through the agent identity, redeems the sealed credential through the agent identity after resume, and acts for the original initiator whoever approves. Every run starts at `proxyToWorker` with a realm user JWT and, when delegated, `X-Fugue-Delegated-Authorization`, through `createAuthMiddleware` into `createRunDagHandler`, so its `RunAuthorityPlan` and `RunAuthority` are the ones production admission and establishment derive; HITL runs then reach the `HitlRunService` that `composeHitlRunService` builds and are processed by its run queue worker over the in-process queue backend, and sync runs execute through `createRunContextFactory` and `createDagExecutor`. One `composeRunAuthorityWiring` instance feeds the route, the HITL composition and the sync executor, as host.ts does, and only transports, Redis, the queue backend, the notifier, the Bot Framework token verifier and the clock are fakes: no plan, run authority, approver, run record or custody record is hand-built. Approvals enter only through the production approval paths: `POST /runs/:runId/approve` (proxy, auth middleware, then the approve handler) and the Teams bot handler over the composed service. A different realm user approving over HTTP, or a mapped Teams user approving from a card, is recorded as that approver (`realm-user{realmSub, entra}` or `teams-user{aadObjectId}`) in the run's approvals as persisted by the production run store and in the `hitl-decision` audit record, while every delegated acquisition after resume still carries the initiator's `oid`. An approval of a run that is not suspended is refused 409 through `errorResponse`, and an approval by an identity the existing approver authorization refuses records nothing. A refused refresh, expired custody or absent custody is refused with `reauthorization-required` and no `app` fallback, and the refusal is surfaced to the initiator: a sync run's HTTP response is 401 `authority-unavailable` with cause `reauthorization-required`, and a HITL run settles failed with the same typed error, which the initiator reads through `GET /runs/:runId` (`createGetRunHandler`, via the proxy and the auth middleware). The custody cap is decided through the production configuration: with `DELEGATED_CUSTODY_MAX_SEC` unset and `HITL_RUN_TTL_SEC` at its default, the custody binding a delegated HITL run stores expires exactly 604800 s after establishment and its PX matches, and a resume at that expiry minus one second redeems successfully; with `DELEGATED_CUSTODY_MAX_SEC=3600`, a resume 3601 s after establishment (by `setSystemTime`) fails `reauthorization-required{custody-expired}` with zero custody-store reads, zero Entra calls and no `app` fallback (FR-017, AS-026, AS-034). The reason given to the initiator is the accurate one. A delegated HITL run whose custody record is removed before its binding expiry (the custody key deleted from the in-memory Redis while the run is suspended) fails `reauthorization-required{custody-absent}`, not `custody-expired`. The custody key's PX never exceeds the binding expiry, so no ciphertext outlives the cap to make that distinction. After every terminal state (HITL completed, HITL failed including a rejected gate, HITL record evicted, sync completed, sync failed, and sync aborted by the route's timeout, which is the cancelled teardown) no delegated credential for the run can be retrieved, through the capability authority or from the custody keyspace. No credential material across continuation (AS-038, FR-022): with the inbound tokens, realm assertions, T1, on-behalf-of and redeemed access tokens and every refresh token (original and rotated) sentinels from `credential-sentinel.ts`, `assertNoCredentialMaterial` finds none of them, nor any encoding of them, in any HITL run record or checkpoint and approval in the in-memory `HitlRedisPort`, any audit record (`hitl-decision` included), log line, trace span or error value, or any HTTP response of the start, status and approve routes and the bot handler; and `assertCustodyCiphertextOnly` holds for every custody record at rest at every step (after establishment, after each rotation, after a refusal), each opening only under the deployment keyring with its own binding as AAD.

### CT-4: User-origin run attribution through execution

**Types file:** none
**No types reason:** The slice consumes CT-1's `RunAuthority` and `OriginOfFn` and CT-2's `CreateCapabilityAuthorityFn` and `RunMintingAuthority`; the host composition it pins (`NodeContextForDag`, the two host.ts factories, `composeRunAuthorityWiring`) is host-internal wiring, not a consumer-facing surface.
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/user-run-attribution.acceptance.test.ts` — AS-006, AS-039, FR-004, FR-020
**Entry point:** `packages/host/src/host.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: the submission reaches the worker here, with `Authorization` forwarded and nothing logged but the tenant and transport reason)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: the realm JWT's `sub`, `entra_oid` and `entra_tid` become the `AuthenticatedUser` here)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: the production route handler, sync path from admission through execution)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the production admission that derives the `user-app` initiator, and the capability authority with its realm and Entra adapters for the configured model)
- `createRunContextFactory` (`packages/host/src/host.ts`: the production `createContext` dep; `buildRouterDeps` uses the same export)
- `createNodeContextForDag` (`packages/host/src/adapters/node-context-factory.ts`: builds the node context and hands the run's `RunAuthority` on unchanged, with no origin of its own)
- `createDagExecutor` (`packages/host/src/host.ts`: the production `executeDag` dep; builds the framework `MintingAuthority` by spreading the minting handle the lifecycle bracket built and adding `meterLlm`, so broker and origin come from one `RunAuthority`)
**Statement:** A user-origin sync run whose nodes require only `app` capabilities, submitted at `proxyToWorker` with a realm user JWT carrying `sub`, `entra_oid` and `entra_tid`, runs end to end through the production composition: `createAuthMiddleware` and `createRunDagHandler` with `admitRunAuthority` and the run-authority lifecycle from `composeRunAuthorityWiring`, `createContext` from host.ts `createRunContextFactory` and `executeDag` from host.ts `createDagExecutor` over the minting handle that wiring's lifecycle builds for the bracket, whose realm and Entra adapters talk to in-process fake HTTP transports, for both identity models. No dep is stubbed and no `AuthIdentity`, `RunAuthorityPlan` or `RunAuthority` is hand-built; only transports, Redis and the clock are fakes. Every node's mint produces exactly one audit record, and each carries `authority: app`, the node's agent client and Entra identity, and `initiator{realmSub, oid, tid}` equal to the submitting user's (AS-006, FR-020); the Entra transport sees only the agent's own grants (zero on-behalf-of and zero RFC 8693 bodies). A team-origin run of the same DAG writes audit records with no initiator, the control that an attribution hard-coded in the executor fails. A sentinel inbound bearer token appears in none of: the `RunAuthority` handed to `createContext`, the `NodeContextForDag` that `createNodeContextForDag` returns (also called directly on a `user-app` authority), the `RunMintingAuthority` that `forRun` returns for it, any realm or Entra request body, any audit record, any log line including the proxy's; and the custody store holds no record for the run (FR-004). Every `InvocationOrigin` a node receives equals `originOf` of the admitted authority (user origin, the initiator's realm `sub`, the DAG's agent client). No credential material on the `app` execution path (AS-039, FR-022): with the inbound realm JWT, the realm assertion, T1 and the Entra access token sentinels from `credential-sentinel.ts`, `assertNoCredentialMaterial` finds none of them, nor any encoding or signature segment of them, in the `RunAuthority`, `RunMintingAuthority` and every `InvocationOrigin` the nodes receive, any capability handle's JSON, `String()` or `Bun.inspect` rendering, any audit record, log line or trace span, or the run's HTTP response. A `createContext` that drops or swaps the initiator, or an `executeDag` that mints through anything but the handle the lifecycle bracket built over the `RunAuthority` `createContext` returned, fails the suite.

---
## Implementation Phases

Ordered by dependency. Decompose places the contract tasks (CT-1, CT-2, CT-3, CT-4) and the LC-1 machine task in the earliest Waves their imports allow. The LC-1 machine imports CT-3 types, so it follows the CT-3 contract task.

**Phase boundary rule (every Wave leaves typecheck and the host suite green).** The rule covers signature changes as well as deletions (extended in design-review loop-back 5).

*Signature changes.* A Task that changes an exported signature also updates, in the same Task, every production caller and every test fixture that constructs or matches it. This applies to a function's parameters or result, a deps record (`RunDagDeps`, `HitlRunServiceDeps`, `RunExecutorDeps`, `HitlWiringArgs`, `HostDeps`, `NodeContextForDag`), a port, a union that some caller matches with `.exhaustive()` (`FrameworkError`, `HostError`), a record type gaining a required field or a narrowed variant (`AuthIdentity`, `AuthenticatedUser`, `PersistedIdentity`, `RunExecutionRequest`), and a persisted record schema (`RunRecord`). Decompose never splits a signature change from its callers, and no Wave leaves a caller for a later one. New modules and new exports with no caller yet are exempt. Each Phase's **Files** list below names the constructors and matchers the design-review loop-back 6 audit found by searching the code (`kind: "user"` literals, `canRunDag:` fixtures, realm-claim fixtures, `identity: {` and `ownerTeam:` record fixtures, `.exhaustive()` matches of `HostError`, every importer of a changed module); decompose re-runs those searches when it cuts Tasks. The rule decides these placements:
- The framework union widening and the host's `framework-error-http.ts` mapping are one Phase 1 Task.
- Each HostError widening carries `domain/host-error.ts`'s exhaustive tables and `http/middleware/error-handler.ts`'s exhaustive `rawDetailsFor` in the same Task: `capability-catalog-invalid` (Phase 1), `identity-config-invalid` (Phase 2) and `run-authority-refused` (Phase 4).
- The required realm Entra principal is one Phase 2 Task. It carries every constructor of a `user` `AuthIdentity` or `PersistedIdentity`, including `hitl/identity.ts` (`approverTeamIdentity`, now returning `TeamsApprover`, and `toPersistedIdentity` / `toExecIdentity`), `hitl/types.ts` and the run-store schema.
- The run-start cut-over is one Phase 4 Task. It is where several modules' signatures change together: `HitlRunService.startRun`, `HitlRunServiceDeps`, `RunExecutorDeps`, `RunExecutionRequest`, `RunDagDeps`, `NodeContextForDag` and `RunRecord.authority` (replacing `RunRecord.identity`), with their callers `run-dag.ts`, `hitl/service.ts`, `run-executor.ts` and the host.ts HITL and router composition.

*Deletions.* The legacy broker path stays compiling until the Phase 4 cut-over Task switches host.ts to `composeRunAuthorityWiring` and deletes it in the same change: `keycloak-broker.ts`, `keycloak-token-endpoint.ts`, `keycloak-token-endpoint-http.ts`, `unwired-token-endpoint.ts`, `entra-wif.ts`, `unwired-entra-wif.ts`, `capability-scope.ts` and their tests. Phases 2 and 3 build every replacement as new files and new exports beside it. A Phase 2 or 3 Task that changes a module the legacy path imports (`config.ts`, `authority-legs.ts`, `token-cache.ts`, `broker-audit.ts`, `graph-capability.ts`, `capability-gate.ts`) updates the legacy importer in the same Task, so no Wave is left broken for a later one. From Phase 2, when `ENTRA_CLIENT_ID` is removed, host.ts composes the legacy broker's Entra hop as `unwired-entra-wif` only: that hop never reached Entra (spec Summary), so no working behaviour is lost before the Phase 4 cut-over replaces it.

### Phase 1: Foundations and demolition (no dependencies)

- Add `authority-unavailable` to the framework error union. Update `FRAMEWORK_ERROR_KINDS`, the persisted schema, `formatFrameworkError` and `retriabilityOf` (non-retriable), with tests. In the same Task, add the host's `authority-unavailable` HTTP mapping in `domain/framework-error-http.ts`, whose two matches are `.exhaustive()` and would otherwise stop compiling (Phase boundary rule). Export `runtimeNodeInventory` from the framework barrel.
- Create the capability catalog and its parser, with the opaque catalog-minted `CapabilityScope`, the total `authorityOf(scope)` and `classifyCapability` / `classifyCapabilities` (design-review loop-back 6). Re-derive the exports of `capability-scope.ts` from the catalog (the file is deleted in the Phase 4 cut-over). Point `capability-gate.ts` (now `decideGate(catalog, capability, …)` with its `unknown` arm) and `capability-registry.ts` at the catalog, and update `decideGate`'s production caller, the legacy `keycloak-broker.ts`, in the same Task. Write the `@ts-expect-error` type test and the property tests. Write the INV-2 matrix test covering the owner and `capability-gate.ts`.
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

- Rewrite the Entra keys in `config.ts`, with `DELEGATED_CUSTODY_MAX_SEC` parsed as an optional positive integer (malformed → `loadConfig` refusal naming the key). Make `authority-legs.ts` return `Result` with per-leg presence gating, `EntraDirectory`, `DelegationLeg` (custody max resolved to `DELEGATED_CUSTODY_MAX_SEC` or min(604800, `HITL_RUN_TTL_SEC`), refused above `HITL_RUN_TTL_SEC`), every fault, and `delegatedAudienceFor` (INV-5 owner). Write the unit and property tests and `__tests__/delegated-audience.matrix.test.ts` with the owner rows. In host.ts, map a fault list to the `identity-config-invalid` HostError that `createHost` returns before the router is built, adding its cases to `domain/host-error.ts`'s exhaustive tables and to `http/middleware/error-handler.ts`'s exhaustive `rawDetailsFor` in the same Task, and compose the legacy broker's Entra hop as `unwired-entra-wif` (Phase boundary rule). The removed `ENTRA_CLIENT_ID` fixtures in `config-security.test.ts`, `authority-legs.test.ts` and `broker-selection.test.ts` change in the same Task.
- Add the acquisition-fault vocabulary first, because both HTTP adapters below return it: `domain/token-endpoint-error.ts` (`classifyTokenEndpointError`, the one pure classifier, overloaded by grant) and `domain/acquisition-fault.ts` (`frameworkErrorOf` over `AcquisitionFault`, `runAuthorityRefusalOf` over `EstablishmentFault`, both `.exhaustive()`), each with its property test. The CT-2 types declare the per-path subsets and the closed `UnreachableCause`.
- Add the realm assertion mint port and HTTP adapter (`scope="entra-exchange <capability>"`, no `audience`, errors through the classifier, `AppAcquisitionFault`), `inspectFederatedAssertion`, and the unwired adapter. The legacy `keycloak-token-endpoint(-http).ts` and `unwired-token-endpoint.ts` stay until the Phase 4 cut-over.
- Add the Entra agent authority port, the shared endpoint module, and the agent-id, app-registration and unwired adapters (`acquireApp` → `AppAcquisitionFault`, `establishDelegation` and `redeemDelegation` → `DelegatedGrantFault`). The legacy `entra-wif.ts` and `unwired-entra-wif.ts` stay until the Phase 4 cut-over.
- Add `domain/redacted-secret.ts` (the runtime of the CT-1 `RedactedSecret` type) with its property test.
- **Required realm Entra principal: one Task** (Phase boundary rule; design-review loop-back 6). Make `entra_oid` and `entra_tid` required realm claims, and `entra` required on `AuthenticatedUser`, on the `user` `AuthIdentity` and on the `user` `PersistedIdentity`. The same Task changes every constructor and matcher of those types:
  - Production: `domain/jwt-validation.ts`, `domain/auth.ts` (adds `TeamsApprover` and widens `canAccessDag` to `AuthIdentity | TeamsApprover`), `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `hitl/identity.ts` (`approverTeamIdentity` returns `TeamsApprover | undefined`, so the Teams approver is never given a fabricated realm principal; `toPersistedIdentity` and `toExecIdentity` carry `entra`), `hitl/types.ts` (`PersistedIdentity.user.entra`) and `hitl/adapters/run-store.ts` (the persisted user identity requires `entra`). `hitl/adapters/bot/messages-handler.ts` compiles unchanged, because `canAccessDag` accepts the new type.
  - Tests and fixtures: `domain/__tests__/jwt-validation.test.ts`, `adapters/__tests__/realm-jwt-verifier.test.ts`, `__tests__/middleware/auth.test.ts` (a realm JWT without the claims → 401 naming them), `__tests__/supervisor/supervisor.test.ts`, `__tests__/domain/auth.test.ts`, `__tests__/domain/tenant.test.ts`, `__tests__/handlers/run-dag.test.ts`, `__tests__/node-context-factory.test.ts`, `__tests__/integration/mapped-host-composition.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `hitl/__tests__/identity.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts` and `hitl/adapters/bot/__tests__/bot.test.ts`.
- Add Entra user token claim validation with `issuerFor` and `jwksUriFor`, and the verifier as the plain adapter function `verifyEntraUserToken(step, jwks, signal)` over the JWKS transport (no port).
- Add the two-pass run authority planner (`planRunAuthority` pass 1, with `classifyCapabilities` and the `capability-unknown` refusal first; `admitDelegatedPresentation` pass 2, building the grant from `step.token`), the binding and `originOf`. The verifier takes the `verify-delegated` step pass 1 builds. Extend the INV-2 matrix test with `run-authority.ts`, and add the `run-authority.ts` row to `__tests__/delegated-audience.matrix.test.ts` (INV-5: pass 1 builds the expectation from `delegatedAudienceFor`).
- Add the custody cipher, the store port (`put(binding, held)`, `get` → `CustodyState`, `swap(runId, expected, next)` with the store assigning the generation, `delete`), the Redis store (the `swap` Lua script) and the in-memory store, and the LC-1 machine with `transitionCustody`, `decideRedeemStep`, `custodyBindingOf(authority)`, `parseCustodySeconds`, `custodyExpiryFor` and `reauthorizationReasonOf`, with `delegated-custody.property.test.ts` and `decide-redeem-step.property.test.ts`.
- **Files:** `domain/config.ts`, `domain/authority-legs.ts`, `domain/host-error.ts`, `http/middleware/error-handler.ts`, `host.ts`, `domain/port/*.ts`, `domain/token-endpoint-error.ts`, `domain/acquisition-fault.ts`, `domain/federated-assertion.ts`, `domain/entra-user-token.ts`, `domain/redacted-secret.ts`, `domain/run-authority.ts`, `domain/jwt-validation.ts`, `domain/auth.ts`, `domain/delegated-custody.ts`, `adapters/realm-assertion-mint-http.ts`, `adapters/unwired-realm-assertion-mint.ts`, `adapters/entra-token-endpoint.ts`, `adapters/entra-agent-id-authority.ts`, `adapters/entra-app-registration-authority.ts`, `adapters/unwired-entra-agent-authority.ts`, `adapters/entra-user-token-verifier.ts`, `adapters/custody-cipher.ts`, `adapters/delegated-custody-store-redis.ts`, `adapters/delegated-custody-store-memory.ts`, `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `hitl/identity.ts`, `hitl/types.ts`, `hitl/adapters/run-store.ts`, their tests, the fixtures named in the required-principal Task, `domain/__tests__/config-security.test.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `__tests__/authority-mode.matrix.test.ts`, `__tests__/delegated-audience.matrix.test.ts`, `__tests__/broker-selection.test.ts` and `adapters/__tests__/unwired-defaults.test.ts`. Nothing is deleted in this phase.

### Phase 3: Capability authority and delegation establishment (depends on Phase 2)

- Build `run-custody-cell.ts` (`createRunCustodyCell`: the single-flight sequencer that performs the effects `decideRedeemStep` returns; holds only `get` and `swap`) with `run-custody-cell.test.ts`. Build `capability-authority.ts` (boot core plus `forRun` returning `{broker, origin: originOf(run)}` and creating one custody cell per user-delegated `forRun`, classification through `decideGate`, app path, delegated path through the cell, cache key ADT, `frameworkErrorOf`, audit, handles), which replaces `keycloak-broker.ts` when the Phase 4 cut-over switches host.ts. Write its property test, including the concurrent-capabilities interleavings. The cache key ADT is encoded to the string `token-cell.ts` already takes, so `token-cell.ts` is unchanged, and `token-cache.test.ts` changes with it; the legacy `cacheKey` stays for `keycloak-broker.ts` until the cut-over. Migrate the non-legacy importers of `capability-scope.ts` (`graph-capability.ts`, `config.ts` scope validation) to the catalog; the file itself goes in the Phase 4 cut-over. Extend `broker-audit.ts`, updating the legacy broker's call in the same Task (Phase boundary rule). Extend the INV-2 matrix test with `capability-authority.ts`.
- Build `delegation-establishment.ts` (expiry `custodyExpiryFor(now(), maxSec, runDeadlineMs)`, authority carrying the `runId`, `custodyBindingOf(authority)`, mint, on-behalf-of, seal, `put(binding, held)`; `EstablishmentFault`; no compensation of its own) and the INV-4 owner `run-authority-lifecycle.ts` (`createRunAuthorityLifecycle` over the capability authority: `withEstablishedAuthority`, `establishForRecord`, `withRecordedAuthority`, `endRun`, one `forRun` per bracket, cause derivation, `runAuthorityRefusalOf`). Write `run-authority-lifecycle.test.ts`, and `__tests__/run-authority-lifecycle.matrix.test.ts` with the owner rows: establishment failed with a failed or an ambiguous `put`, body rejection, persist failure, failing delete, one handle per bracket. The sibling rows wait for the Phase 4 cut-over, which builds the siblings' calls.
- Build `run-authority-admission.ts` (`createRunAuthorityAdmission`: the two-pass admit over the planner, the statically imported `verifyEntraUserToken` over the JWKS transport, and pass 2) and `run-authority-wiring.ts` (`composeRunAuthorityWiring` with its `catalog` input, `RunAuthorityWiring = {legs, admitRunAuthority, lifecycle}` with the capability authority held only by the lifecycle, `IdentityTransports`), the only production composition of the identity subsystem. Add the establishment row to `__tests__/delegated-audience.matrix.test.ts` (INV-5). CT-2 acceptance takes its minting handles from the wiring's lifecycle bracket, so it lands in this phase with the mint path.
- Create `acceptance/support/credential-sentinel.ts`. This phase answers for FR-022 on the mint path: CT-2's sentinel assertions (logs, audit, spans, errors, handles, custody re-sealed on rotation) are part of CT-2 acceptance and must be green at this phase's Wave Gate.
- This phase answers for the NFR-002 budgets: the CT-2 budget acceptance file (`capability-authority-budget.acceptance.test.ts`) must be green at this phase's Wave Gate, so a budget miss is found while the mint path is being built. Both CT-2 acceptance files run through `composeRunAuthorityWiring`.
- **Files:** `adapters/run-custody-cell.ts`, `adapters/capability-authority.ts`, `adapters/keycloak-broker.ts` (legacy importer updates only), `adapters/broker-audit.ts`, `adapters/graph-capability.ts`, `domain/token-cache.ts`, `domain/__tests__/token-cache.test.ts`, `domain/config.ts`, `adapters/delegation-establishment.ts`, `adapters/run-authority-lifecycle.ts`, `adapters/run-authority-admission.ts`, `adapters/run-authority-wiring.ts`, `__tests__/acceptance/support/credential-sentinel.ts`, their tests, `__tests__/authority-mode.matrix.test.ts`, `__tests__/run-authority-lifecycle.matrix.test.ts` and `__tests__/delegated-audience.matrix.test.ts`

### Phase 4: Run-start cut-over: admission, HITL establishment and composition (depends on Phase 3)

This phase switches the whole run-start path to the run authority in one atomic change. Before design-review loop-back 5 it was split across two phases, and the earlier one changed `HitlRunService.startRun`, `HitlRunServiceDeps` and `RunExecutorDeps` while their production callers (`run-dag.ts` and the host.ts HITL composition) changed only in the later one, which left a Wave that did not typecheck. The Phase boundary rule now forbids that split.

- **Additive Tasks.** These change no signature that has a caller outside the Task, so decompose may place them in an earlier Wave of this phase than the cut-over:
  - `http/delegated-token-header.ts` (`parseDelegatedTokenHeader` → `DelegatedHeader`) with its test.
  - The `run-authority-refused{refusal}` HostError, together with every exhaustive matcher of `HostError` in the same Task: its status table (one status per `RunAuthorityRefusal` kind, `capability-unknown` 503 included), `discloseHostError`, snapshot entries, and `http/middleware/error-handler.ts`'s `rawDetailsFor`.
- **The cut-over Task: one Task, one Wave.** Every coupled signature changes together with every production caller and every fixture that constructs it:
  - `http/handlers/run-dag.ts`: two-pass admission before the HITL fork and `acquire`. The HITL branch calls `startRun(…, plan)`. The sync branch makes one `runAuthority.withEstablishedAuthority(plan, runId, deadlineMs, body)` call. `RunDagDeps` gains `admitRunAuthority` and `runAuthority`; `createContext` takes a `RunAuthority` and `executeDag` the bracket's `AuthorizedRun`.
  - `hitl/service.ts`: `startRun(…, plan)` makes one `establishForRecord` call. `processRun` hands the executor `record.authority`, folds into `ProcessRunOutcome` and makes one `endRun` call. `HitlRunServiceDeps.runAuthority` is the narrowed lifecycle.
  - `hitl/types.ts`, `hitl/ports.ts`, `hitl/identity.ts`, `hitl/adapters/run-store.ts`: `RunRecord.authority` replaces `RunRecord.identity` and `RunExecutionRequest.authority` replaces its `identity`, required by the record schema (with the `delegation.runId` = record `runId` check); `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are deleted, and `approverTeamIdentity` stays.
  - `hitl/adapters/run-executor.ts`: `RunExecutorDeps.broker` becomes `runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority">`, and each slice runs in one `withRecordedAuthority(req.authority, body)` call and mints through `{ ...run.minting, meterLlm }`.
  - `adapters/node-context-factory.ts`: `NodeContextForDag{ctx, authority, meterMintedLlm}`, with no origin. The unmapped-DAG throw is removed.
  - `host.ts`:
    - It calls `composeRunAuthorityWiring` once per host over the boot-loaded catalog and `HostDeps.identityTransports` (fetch-based by default), and returns `identity-config-invalid` on its faults.
    - It feeds `buildRouterDeps` and the HITL composition from that one instance; `HitlWiringArgs.runAuthority` replaces `broker`.
    - It exports `createRunContextFactory`, `createDagExecutor`, `composeHitlRunService` and `HitlWiringArgs`, and `buildRouterDeps` and `startDurableRunEngine` use them.
    - `HostDeps.capabilityBroker` is removed and `HostDeps.identityTransports` added.
  - The legacy broker path is deleted in the same Task: `keycloak-broker.ts` (with its `agentClientIdFromFrameworkOrigin` re-check), `keycloak-token-endpoint.ts`, `keycloak-token-endpoint-http.ts`, `unwired-token-endpoint.ts`, `entra-wif.ts`, `unwired-entra-wif.ts`, `capability-scope.ts` and their tests, and the legacy `cacheKey` in `token-cache.ts` with its cases in `domain/__tests__/token-cache.test.ts` (`compositeKey` stays if `cacheKeyOf` uses it).
  - Tests and fixtures (found by searching for `createRunDagHandler`, `createNodeContextForDag`, `createRunExecutor`, `startRun(`, `capabilityBroker`, `identity: {` and `ownerTeam:`):
    - rewrites of `broker-selection.test.ts`, `entrypoint-wiring.test.ts`, `full-lifecycle.test.ts` T8, `node-context-factory.test.ts`, `run-executor.test.ts` and `unwired-defaults.test.ts` (legacy rows dropped)
    - `RunDagDeps`, `startRun`, executor and record fixtures: `__tests__/handlers/run-dag.test.ts`, `__tests__/handlers/hitl-http.test.ts`, `__tests__/integration/mapped-host-composition.test.ts`, `__tests__/integration/dag-isolation.test.ts`, `__tests__/integration/mapped-process-resume.test.ts`, `__tests__/fixtures/mapped-resume-worker.ts`, `hitl/__tests__/service.test.ts`, `hitl/__tests__/service-admission.test.ts`, `hitl/__tests__/identity.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts` and `hitl/adapters/bot/__tests__/bot.test.ts`
    - new `handlers/run-dag-authority.test.ts` and `boot-identity-refusal.test.ts` (AS-013, AS-033, NFR-020 at `createHost`)
    - all three INV-4 sibling rows (route, HITL service, HITL executor) in `run-authority-lifecycle.matrix.test.ts`

  The cut-over is a large Task, and it stays one Task on purpose: any split leaves a Wave in which `startRun`, the HITL deps, the executor deps, the execution request or the record schema disagree with a caller.
- This phase answers for the NFR-003 budget and for FR-022 at run start and on the `app` execution path. These must be green at this phase's Wave Gate:
  - CT-1 acceptance, including AS-037's sentinel assertions, the proxy forwarding cases and the zero-JWKS static refusals
  - the CT-1 budget file (`run-authority-admission-budget.acceptance.test.ts`, AS-036)
  - CT-4 acceptance (`user-run-attribution.acceptance.test.ts`), including AS-039

  Decompose assigns CT-1's and CT-4's Requirements to the cut-over Task.
- CT-3 acceptance also needs the approval path (AS-028), which Phase 5 builds, so decompose assigns CT-3's Requirements to the Phase 5 approvals Task.
- **Files:** `http/delegated-token-header.ts`, `domain/host-error.ts`, `http/middleware/error-handler.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `http/handlers/run-dag.ts`, `hitl/types.ts`, `hitl/ports.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/run-executor.ts`, `adapters/node-context-factory.ts`, `domain/auth.ts`, `domain/run-context.ts`, `domain/token-cache.ts`, `host.ts`, `__tests__/broker-selection.test.ts`, `__tests__/entrypoint-wiring.test.ts`, `__tests__/integration/full-lifecycle.test.ts`, `__tests__/node-context-factory.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`, the fixtures listed in the cut-over Task, `domain/__tests__/token-cache.test.ts`, `__tests__/handlers/run-dag-authority.test.ts`, `adapters/__tests__/unwired-defaults.test.ts`, `__tests__/run-authority-lifecycle.matrix.test.ts`, `__tests__/boot-identity-refusal.test.ts`, the CT-1 and CT-4 acceptance files, and the deleted legacy files listed in File Structure

### Phase 5: Approvals and manifest (depends on Phase 4)

- **Approvals Task.** `RunRecord.approvals` and its run-store schema, and `ApprovalRecord` with `atMs: EpochMs`. `recordDecision(…, approver: ApproverRef)` changes in the same Task as its two production callers (Phase boundary rule):
  - `createApproveRunHandler` (`http/handlers/runs.ts`) derives the `ApproverRef` from the middleware-built `AuthIdentity`.
  - `handleBotActivity` (`hitl/adapters/bot/messages-handler.ts`) derives `teams-user{aadObjectId}` from the `TeamsApprover`.

  It also adds the approver mapping in `hitl/identity.ts`, the `hitl-decision` audit record and `approver-authority.test.ts`. Every `RunRecord` fixture and every `recordDecision` caller in tests changes in the same Task: `hitl/__tests__/service.test.ts`, `__tests__/handlers/hitl-http.test.ts`, `hitl/adapters/bot/__tests__/bot.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts` and `__tests__/fixtures/mapped-resume-worker.ts`. This phase answers for FR-022 across continuation: CT-3 acceptance (`delegated-continuation.acceptance.test.ts`), including AS-038's sentinel assertions and the custody-expired versus custody-absent cases, must be green at this phase's Wave Gate. Decompose assigns CT-3's Requirements to this Task.
- **Manifest Task.** The manifest authority block over the boot-loaded catalog and `delegatedAudienceFor`; each DAG's requirements go through `classifyCapabilities`, so a DAG with an unknown capability publishes the `capability-unknown` requirements it would be refused for instead of a mode. Its handler deps change in the same Task as their host.ts `buildRouterDeps` caller and the existing `__tests__/handlers/manifest.test.ts`. Extend the INV-2 matrix test and the INV-5 matrix test (`delegated-audience.matrix.test.ts`) with `manifest.ts`, and write `manifest-authority.test.ts`.
- **Files:** `hitl/types.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `http/handlers/runs.ts`, `hitl/adapters/bot/messages-handler.ts`, `http/handlers/manifest.ts`, `host.ts`, `hitl/__tests__/approver-authority.test.ts`, the record and `recordDecision` fixtures listed in the approvals Task, `__tests__/handlers/manifest.test.ts`, `__tests__/handlers/manifest-authority.test.ts`, `__tests__/authority-mode.matrix.test.ts`, `__tests__/delegated-audience.matrix.test.ts`, and the CT-3 acceptance file

### Phase 6: Documentation (depends on Phase 5)

- No trailing verification Task. The SC-011 budgets are CT-2 and CT-1 acceptance files gated in Phases 3 and 4. Since loop-back 4 the SC-007 / FR-022 sentinel assertions are part of the contracts' acceptance: CT-2 in Phase 3, CT-1 and CT-4 in Phase 4, and CT-3 in Phase 5 (phase numbers since design-review loop-back 5). So a leak is found in the Wave that builds the surface.
- Rewrite `packages/host/docs/auth.md`, `docs/team-security-and-capabilities.md`, the provisioning runbook (both models, RBAC for Applications, Agent ID spike pass/fail, fallback selection, rollback, rotation, realm-before-host deploy order, broker-token purge) and spike #4. Add the new evidence template, `data-handling.md` and the sequence-diagram doc. Update the CONTEXT.md identity table and terms.
- Add `scripts/check-identity-docs.ts` with tests, wired into `scripts/verify.sh`.
- **Files:** `packages/host/docs/auth.md`, `packages/host/docs/data-handling.md`, `packages/host/docs/identity-chain-sequence.md`, `docs/team-security-and-capabilities.md`, `docs/runbooks/entra-fugue-agents-provisioning.md`, `docs/runbooks/identity-live-verification-evidence.md`, `docs/spikes/2026-06-10-spike-4-identity-chaining-e2e.md`, `CONTEXT.md`, `scripts/check-identity-docs.ts`, `scripts/__tests__/check-identity-docs.test.ts`, `scripts/verify.sh`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Framework taxonomy | format, retriability, kinds list | persisted round-trip via zod schema | every cause round-trips; formatted text never contains injected sentinel |
| Capability Catalog | parse faults name capability; `@ts-expect-error` on missing authority; `loadCapabilityCatalog` maps faults to `capability-catalog-invalid` | `boot-capability-catalog.test.ts`: `createHost` with `HostDeps.capabilityCatalog` = a data catalog missing a mode returns `capability-catalog-invalid` naming the capability, nothing connected or bound; the default code catalog boots through the same parser (AS-009, SC-013) | parse∘serialize = id; any entry with missing/unknown authority refused; `classifyCapability` brokered iff a key, unknown iff a brokered namespace without the key; `authorityOf(scope)` total and equal to the parsed mode |
| Identity Topology | each `IdentityConfigFault` seeded; custody max unset → min(604800, `HITL_RUN_TTL_SEC`), explicit value kept, above run TTL refused; malformed `DELEGATED_CUSTODY_MAX_SEC` refused at `loadConfig` | `loadConfig` end to end with env fixtures; `boot-identity-refusal.test.ts` at `createHost` (AS-013, AS-033, NFR-020) | Entra leg dark iff a presence key is missing, with a warning naming it; configured → faults list all offenders (not first); wired custody max always in (0, run TTL] |
| Acquisition faults | projection tables row by row; classifier table (realm `invalid_scope`, `invalid_client`, AADSTS codes, `invalid_grant`/`interaction_required`/`consent_required`, 429/5xx) | — | `classifyTokenEndpointError` total over (hop × grant × status × error × codes), transient statuses always `unreachable{cause}`, a `client_credentials` response never `reauthorization-required`, no input text in the fault; both projections total over their subsets, `unreachable` the only retriable projection, rendered `infra-unreachable` text drawn only from hop, status digits and fixed words (property-tested once, in `domain/__tests__`) |
| Realm Assertion Mint | body capture: `scope="entra-exchange <cap>"`, no `audience` | every non-2xx handed to the classifier over a fake HTTP | inspection: refused iff aud lacks exchange audience or scope lacks either grant |
| Entra Agent Authority | per model: step order, `fmi_path`, T1 as assertion, `offline_access`, no `client_secret` | every non-2xx handed to the classifier | — |
| Entra token verification | each refusal reason; `issuerFor` the one issuer derivation; RS256 only; `verifyEntraUserToken` takes only a `verify-delegated` step and returns claims only | lazyJwks rotation over an in-process JWKS transport (the seam; no port) | claims validation accepts iff all constraints hold |
| Run Authority Planner | each refusal variant, `capability-unknown` included; `originOf` per brokered authority | JWKS-transport request count zero on every static refusal (`run-authority-admission.test.ts`, CT-1) | pass 1 totality over (identity × requirements × header × legs); the pure composition of both passes over generated presentations preserves the full precedence order, `capability-unknown` first; the admitted grant's token is the step's; binding iff oid ∧ tid equal |
| Delegated Custody (LC-1) | guards; `parseCustodySeconds` bounds; brand arithmetic (`custodyExpiryFor` ≤ both bounds) | Redis store (test-redis) and memory store: `put` writes generation 0 under `binding.runId` with PX at the binding expiry, `swap` writes `expected + 1`, missing never creates, stale returns current, swapped keeps TTL; `run-custody-cell.test.ts`: the sequencer performs exactly the decided effects | LC-1: exactly three declared pairs; rotate refused at or after expiry; establish refused beyond the cap; refuse leaves no sealed bytes; nothing leaves `revoked`, only `establish` leaves `absent`; `reauthorizationReasonOf` expired iff now ≥ binding expiry. `decideRedeemStep`: the outcome table row by row with no fakes (termination, store fault → `unreachable{custody-store}` only, refused never grants, missing never rewrites, rotated credential written at least once, pending write flushed first); cipher open fails on any AAD field change |
| Capability Authority | gate zero-egress (`unknown` included), mode dispatch, audit shape, broker ignores `inv.origin`, one custody cell per `forRun` | CT-2: both models through `composeRunAuthorityWiring` over fake transports, including concurrent delegated capabilities and a second-wiring CAS contender; CT-2 budget file: cold host-added ≤ 10 ms p95, cache hit ≤ 5 ms p95 (NFR-002) | cache isolation and single-flight under fast-check scheduled interleavings (NFR-012); custody-cell serialization, final generation and last-rotated credential under interleavings |
| Run-authority lifecycle (INV-4) | owner: cause derivation per outcome, idempotent unconditional delete, failing delete → `release-failed` + one log, body rejection rethrown after release, one `forRun` per bracket, `withRecordedAuthority` neither establishes nor releases | matrix test: every sibling path through the real route, service and executor leaves custody absent with its derived cause, each sibling makes exactly its declared lifecycle calls, and each bracket mints through its one handle; Redis store PX and tenant purge cover the two code-less removals | — |
| HITL continuity | ApproverRef mapping per identity variant and `TeamsApprover`; `approverTeamIdentity` yields a `teams-approver` with no realm principal; run-store schema refuses a record whose authority names another run | CT-3: runs started through `proxyToWorker` + `createAuthMiddleware` + `createRunDagHandler`; HITL engine from host.ts `composeHitlRunService` (production Redis run and decision stores over the in-memory Redis, processed by its own queue worker over an in-process `QueueBackend`); sync delegated runs through `createRunContextFactory` + `createDagExecutor`, including a timeout abort; approvals through `createApproveRunHandler` and `handleBotActivity`; resume after the inbound tokens expire (SC-006) by `setSystemTime`; custody-expired (zero store reads, zero Entra calls) versus custody-absent (record removed before expiry); one `composeRunAuthorityWiring` throughout | — |
| Run Admission | refusal ordering (0 acquire, 0 startRun, 0 egress, 0 JWKS) | CT-1: through `proxyToWorker` with an in-process UDS transport into `createAuthMiddleware` + `createRunDagHandler`, admission from `composeRunAuthorityWiring` (delegated header forwarded, tenant header stripped, statically refusable submissions make zero JWKS requests); CT-1 budget file: admission ≤ 50 ms p95 (NFR-003); CT-4: a user-origin sync run through `proxyToWorker`, `createAuthMiddleware`, `createRunDagHandler`, host.ts `createRunContextFactory` and `createDagExecutor` over the capability authority from `composeRunAuthorityWiring` (fake transports, both models), asserting the initiator `oid` on every mint audit record and no retained user token | — |
| Run authority composition | two-pass admission precedence through the composition, zero JWKS on static refusals; lifecycle unit cases (`run-authority-lifecycle.test.ts`) | `run-authority-wiring.test.ts`: adapter selection per `EntraDirectory` variant, dark delegation leg, faults returned not thrown | — |
| Doc Lint | each banned phrase, status matrix presence, evidence gating | runs over the real doc set in `verify.sh` | — |
| Credential hygiene (FR-022, SC-007) | `redacted-secret.test.ts`; framework cause formatting never contains a sentinel | sentinel assertions inside CT-2 (Phase 3), CT-1 and CT-4 (Phase 4) and CT-3 (Phase 5) acceptance over the production composition, through `credential-sentinel.ts` (nine enumerated surfaces, custody at rest ciphertext only) | `RedactedSecret` renders `[redacted]` for arbitrary values under every serialisation |
| Delegated audience (INV-5) | owner per model | matrix test: pass 1's expectation (and so the composed admission) accepts only the owner's audience, establishment records it, the manifest publishes it | generated directories for both models |

**Latency budget tests (NFR-002, NFR-003, SC-011).** The budgets gate the phases that build the code they constrain, as CT-2 (Phase 3) and CT-1 (Phase 4) acceptance files, not a trailing benchmark. Both use `acceptance/support/latency-budget.ts`: every realm, Entra and JWKS transport is an injected fake that resolves at once, so the measured time is host-added only; 50 discarded warm-up iterations (JIT, the first `lazyJwks` fetch that NFR-003 excludes, WebCrypto key import); then 500 timed samples with `performance.now()`; nearest-rank p95 compared with the budget, and the p95 printed so the evidence template can quote it. The cold-acquisition samples each use a fresh `composeRunAuthorityWiring` (built outside the timed region, so the custody key import is not timed) so no cell is warm; the cache-hit samples reuse one warmed cell and also assert zero transport calls (NFR-001). The expected host cost is well under 1 ms per acquisition and a few ms per admission, so the 10, 5 and 50 ms budgets leave an order of magnitude of headroom for a loaded CI runner while still catching an accidental network call, a synchronous key derivation per call, or an uncached JWKS fetch. Loom accepts only FR and AS ids as acceptance anchors, so the budgets are anchored on AS-035 (NFR-002) and AS-036 (NFR-003), which loop-back 1 added to the spec to restate NFR-002's and NFR-003's automated-suite clauses. Testcases are named after the scenario they decide (`AS-035: cold host-added acquisition ≤ 10 ms p95 (agent-id, app)`, `AS-035: cache hit ≤ 5 ms p95, zero transport calls`, `AS-036: run-start validation ≤ 50 ms p95 through proxyToWorker`).

### Acceptance seam sweep

Loop-back 3 traced every acceptance-decided Requirement along its full production path. The rule (Component Design, Run Admission): declare every edge the path enters through and the production factory of every dependency the path receives by injection; do not re-declare a symbol reached only by a static import inside a declared seam, because the engine requires each acceptance file to name every declared seam in code. Fakes are allowed only at the network (`IdentityTransports`, the realm signature verifier, the Bot Framework token verifier), storage (`RedisPort`, `HitlRedisPort`, `QueueBackend`), notification and clock edges, plus recording observation points for deps whose behaviour another contract decides.

| Contract | Requirements | Production path | Seams declared | On the path but not declared, and why it cannot be bypassed |
|---|---|---|---|---|
| CT-1 | AS-010, AS-021, AS-022, AS-023, AS-037, FR-006 to FR-009, FR-036 | client → `proxyToWorker` → `createAuthMiddleware` → `createRunDagHandler` → `parseDelegatedTokenHeader` → `admitRunAuthority`: `requirementsOf`, `planRunAuthority` (pass 1, `classifyCapabilities` first), only on `verify-delegated` `verifyEntraUserToken` over the JWKS transport, `admitDelegatedPresentation` (pass 2: `validateEntraUserTokenClaims`, `bindDelegatedPrincipal`) → refusal via `hostErrorResponse` → `errorResponse` | `proxyToWorker`, `createAuthMiddleware`, `createRunDagHandler`, `composeRunAuthorityWiring`, `errorResponse` | `parseDelegatedTokenHeader`, `discloseHostError` and the refusal status table: static imports of the handler. Both passes and the binding: built only inside `composeRunAuthorityWiring`. `verifyEntraUserToken`: a static import of `createRunAuthorityAdmission`, which only the wiring builds; it has no port, and its JWKS transport is the faked network edge. `createRouter`: path-to-handler wiring with no identity logic; the in-process worker mounts the middleware and handler in its order |
| CT-1 | FR-018 | as above with admin and team tokens → `agent` or `unbrokered` plan | same | team-token store lookup: unchanged behaviour, already covered by the middleware suite; the acceptance asserts the admitted authority |
| CT-1 | AS-036 | same path as AS-010 to AS-023, admitted and refused submissions | same five, so the budget measures the production admission | none |
| CT-2 | AS-001 to AS-005, AS-011, AS-012, FR-001 to FR-003, FR-011 to FR-015, FR-021, FR-022 | lifecycle bracket → `forRun` once → framework dispatch → `invocationFor` → `broker.mintFor` → `decideGate` → realm mint adapter → `inspectFederatedAssertion` → Entra adapter for the configured model → handle → `brokerAuditPayload` → audit sink | `invocationFor`, `brokerAuditPayload`, `composeRunAuthorityWiring` | `createCapabilityAuthority`, `createRunAuthorityLifecycle`, `planAuthorityLegs`, the mint and Entra adapters: built only inside `composeRunAuthorityWiring`; `forRun` is reachable only through the lifecycle it returns. `decideGate`, `inspectFederatedAssertion`, `token-cache.ts`: static imports of the capability authority. The RunAuthority to MintingAuthority hop is CT-4's |
| CT-2 | AS-024, AS-025, FR-010 | as above, delegated path: run custody cell, sequencing `decideRedeemStep` → custody get → cipher open → `redeemDelegation` → rotation `swap`; the run authority comes from `admitRunAuthority` and the lifecycle's `withEstablishedAuthority` | same | custody cipher and store, `establishDelegation`, `createRunAuthorityLifecycle`: inside `composeRunAuthorityWiring`. `createRunCustodyCell`: called only inside `forRun`. `decideRedeemStep`: a static import of the cell |
| CT-2 | AS-035 | same path as the CT-2 file; fresh wiring per cold sample | same three | none |
| CT-3 | AS-007, AS-008, FR-016 | HITL: `proxyToWorker` → `createAuthMiddleware` → `createRunDagHandler` → `admitRunAuthority` → `startRun` → run store create → queue worker → `processRun` → `createRunExecutor` → `withRecordedAuthority(record.authority)` → `forRun` once → `createNodeContextForDag` → mint; suspend; approve; resume after token expiry. Sync: handler → `createRunContextFactory` → `createDagExecutor` with later nodes after token expiry | `proxyToWorker`, `createAuthMiddleware`, `createRunDagHandler`, `composeRunAuthorityWiring`, `composeHitlRunService`, `createRunContextFactory`, `createDagExecutor`, `createApproveRunHandler`, `createGetRunHandler`, `handleBotActivity`, `errorResponse` | `createHitlRunService`, `createRunExecutor`, `createRedisRunStore`, `createRedisDecisionStore`, `createRunQueue`: built only inside `composeHitlRunService`. `createNodeContextForDag`: static import of `createRunExecutor` and `createRunContextFactory`. `invocationFor`, `brokerAuditPayload`: static imports below the capability authority |
| CT-3 | AS-020, AS-026, FR-017 | delegated HITL start as above, with `X-Fugue-Delegated-Authorization` → `startRun` → `establishForRecord` → `establishDelegation`: mint → on-behalf-of → seal → custody put → persist (record create); after resume, in the slice's `withRecordedAuthority` bracket, the custody cell: expiry check → custody get → open → `redeemDelegation` → rotate. Sync: handler → `withEstablishedAuthority` → body executes | same eleven | `establishDelegation`, `createRunAuthorityLifecycle`, custody cipher and store: inside `composeRunAuthorityWiring` |
| CT-3 | AS-028, FR-025 | `proxyToWorker` → `createAuthMiddleware` → `createApproveRunHandler` → `recordDecision` with the derived `ApproverRef` → approvals in the run record and `hitl-decision` audit; Teams: `handleBotActivity` → `recordDecision`; resume → delegated mint carries the initiator `oid` | same eleven | `recordDecision`: method of the composed service. Bot Framework token verification: a network trust edge, faked as a `VerifyBotToken` |
| CT-3 | AS-034 | resume → custody refused, expired (authority expiry passed) or absent (record gone before expiry) → `authority-unavailable{reauthorization-required}` with the matching reason settles the run failed → the initiator reads it through `proxyToWorker` → `createAuthMiddleware` → `createGetRunHandler`; sync: the route's 401 through `errorResponse` | same eleven | none |
| CT-3 | AS-027, AS-038, FR-023 | HITL completed, failed and rejected through `settleRunOutcome`, record evicted through `processRun`, each folded into a `HitlRunEnding` → `endRun`; sync completed, failed and timeout abort through `withEstablishedAuthority`'s `finally` → the lifecycle owner → custody delete | same eleven | `createRunAuthorityLifecycle`: inside `composeRunAuthorityWiring`. `settleRunOutcome` and the `processRun` fold: inside the composed service |
| CT-4 | AS-006, AS-039, FR-004, FR-020 | `proxyToWorker` → `createAuthMiddleware` parsing `sub`, `entra_oid`, `entra_tid` → `createRunDagHandler` → `admitRunAuthority` → `user-app` → `withEstablishedAuthority` body → `createRunContextFactory` → `createNodeContextForDag` → `RunAuthority` → `createDagExecutor` → the bracket's one handle, built by the lifecycle's `forRun` (origin by `originOf`) → mint → audit | `proxyToWorker`, `createAuthMiddleware`, `createRunDagHandler`, `composeRunAuthorityWiring`, `createRunContextFactory`, `createNodeContextForDag`, `createDagExecutor` | `createCapabilityAuthority`: inside `composeRunAuthorityWiring`. `createNodeContextForDag` is declared although `createRunContextFactory` imports it, because CT-4 also calls it directly on a `user-app` authority. `invocationFor`, `brokerAuditPayload`: static imports below the capability authority |

The FR-022 rows (CT-2 FR-022, CT-1 AS-037, CT-3 AS-038, CT-4 AS-039) scan surfaces that exist only on the production path above: the logger, audit sink and tracer are the ones `composeRunAuthorityWiring` (and the route, proxy and HITL composition) write to, the HTTP responses are the ones `proxyToWorker` returns, the run records and custody records are the bytes the production run store and custody store wrote into the in-memory Redis ports, and the handles, origins and authorities are the values the production path yields. `credential-sentinel.ts` reads only those captures, so a scan cannot pass by observing a path production does not take.

### Plan self-audit (loop-back 4)

After closing the three alignment-4 gaps, the whole plan was re-checked against every alignment category. "Caught" lists what this pass found beyond the reported gaps; each is fixed in the plan. This table is a historical record. Its phase numbers and names (`releaseCustody`, the Phase 5 host switch) predate design-review loop-back 5, whose audit follows.

| Category | What was checked | Caught and fixed |
|---|---|---|
| Coverage specificity (every FR, AS, NFR, SC: function, file, test, defaults, unset behaviour, error kind, boot vs run time) | All 39 AS, 37 FR, 8 NFR and 13 SC ids walked against File Structure, Component Design, contracts and phases | (1) FR-017 default: `DELEGATED_CUSTODY_MAX_SEC` unset → min(604800, `HITL_RUN_TTL_SEC`), positive-integer parse at `loadConfig`, `custody-max-exceeds-run-ttl` at boot, tests named (reported gap). (2) AS-009: `loadCapabilityCatalog`, `HostDeps.capabilityCatalog`, `capability-catalog-invalid`, `boot-capability-catalog.test.ts` (reported gap). (3) AS-013 / AS-033 named no HostError or host-level test: `identity-config-invalid` and `boot-identity-refusal.test.ts` added. (4) AS-034 "surfaced to the initiator" named no surface: sync 401 and HITL `GET /runs/:runId` (`createGetRunHandler`) now in CT-3. (5) AS-022 "actionable error": the 401 body names the header and audience. (6) `RealmAssertionMint` took the code-only `CatalogScope`, so data-sourced and delegated test capabilities could not reach it: `CapabilityScope` brand from the parsed catalog |
| JUDGE (constraining Requirements decided by acceptance in the building phase) | Budgets, security prohibitions, fail-closed, idempotency, retries, concurrency | (1) FR-022 / SC-007 only had a Phase 6 scan: now FR-022 in CT-2 (Phase 3), AS-037 in CT-1, AS-038 in CT-3, AS-039 in CT-4 (Phase 5); Phase 6 scan removed (reported gap). (2) NFR-021 (no internal retry), NFR-012 (single-flight under concurrency), FR-002, FR-003 and FR-012 (request-body shape) and the dark-leg `authority-unconfigured` case were unit-test-only although CT-2 anchors their FRs: now in CT-2's statement. (3) The custody default cap is also asserted in CT-2 (Phase 3) because CT-3, which anchors FR-017, can only go green in Phase 5. Accepted and explained: AS-009, AS-013 and AS-033 boot refusals are decided by boot tests in the phase that builds them (Phases 1, 2 and 5), since a boot refusal has no run-time contract path |
| OWN (a rule applied at 2+ sites is owned, or unowned with a reason) | Every rule the plan applies in more than one module | The delegated audience was derived for admission's claim check, establishment's recorded audience and the manifest, with no owner: new INV-5 (owner `authority-legs.ts`, three siblings, `delegated-audience.matrix.test.ts`). Explained, not owned: AADSTS classification (one function in `entra-token-endpoint.ts`, imported by both adapters); unwired → `authority-unconfigured` (each unwired adapter is the sole dark-leg implementation of its port, selected only by the wiring, covered by `unwired-defaults.test.ts` and CT-2's dark-leg case); secret reveal (one `revealSecret`, three callers, leakage is INV-3); custody expiry (one `custodyExpiryFor`, one caller); approver derivation (two sites with disjoint inputs producing different `ApproverRef` variants); catalog parse (one boot site, the brand forbids a second producer) |
| SEAM (runtime seams and acceptance start at production edges) | Re-swept after the edits above | CT-3 adds `createGetRunHandler`, the edge through which the initiator reads the AS-034 failure. The FR-022 scans read only captures of the production path (paragraph above). No other new path |
| MODEL (lifecycles bound, checkable invariants regex-checkable, types files declarations only) | LC-1, INV-1 to INV-5, the three types files | `RedactedSecret` (CT-1 types) needs runtime serialisation behaviour, which a declarations-only types file cannot hold: the runtime moved to `domain/redacted-secret.ts` (Phase 2) with a property test. LC-1 still bound to `delegated-custody.ts`; INV-1 still the only checkable invariant |
| FEAS (nothing contradicts `clarifications/log.md`) | Every clarify answer and architecture decision | (1) Self-Interview 4 said any `ENTRA_*` key makes the leg configured and partial config is refused, which contradicts the clarify answer for AS-013 ("partial config stays fail-closed with an actionable warning") and AS-013's text: legs are now gated on their presence keys, partial config is dark with a warning, and only a configured leg is refused. (2) The logged custody default (604800, at most `HITL_RUN_TTL_SEC`) would refuse boot for a deployment that lowered `HITL_RUN_TTL_SEC` without touching custody: the unset default is min(604800, `HITL_RUN_TTL_SEC`), identical under default keys. (3) Not a log contradiction but a feasibility one: Phase 2 deleted adapters the legacy broker (deleted in Phase 3) and host.ts (switched in Phase 5) still imported, so Waves 2 to 4 could not type-check: the Phase boundary rule moves every legacy deletion into the Phase 5 host switch |

### Plan self-audit (design-review loop-back 5)

This table is a historical record. Where design-review loop-back 6 changed a fact it states (LC-1's five states, `CustodySwap`, `CustodyRead`, the single `AcquisitionFault`), the loop-back 6 audit that follows supersedes it. The plan design review (code-reviewer, type-design-analyzer, architecture-tech-lead) returned 12 advisories, all accepted under the user's delegation and resolved in this loop-back. Every area they touched was then re-checked against each alignment category and against the extended phase-boundary typecheck rule. "Caught" lists what this pass found beyond the 12 advisories; each is fixed in the plan.

| Category | What was checked | Result and caught |
|---|---|---|
| Phase boundary (every Wave typechecks; signature changes travel with their callers) | Every exported signature, deps record, port, exhaustively matched union and persisted schema the plan changes, against the Task and Wave that changes each caller | Advisory 1 is resolved by one Phase 4 cut-over Task: `startRun`, `HitlRunServiceDeps`, `RunExecutorDeps`, `RunDagDeps`, `NodeContextForDag` and `RunRecord.authority` change with their callers `run-dag.ts` and host.ts. The INV-4 hedge is gone, and both sibling rows land in that Task. **Caught (1):** the Phase 1 framework union widening broke the host's `.exhaustive()` matches in `framework-error-http.ts`, which the plan had placed in Phase 5. The mapping moves into the Phase 1 widening Task. **Caught (2):** `recordDecision(…, approver)` and its two callers (`runs.ts`, `messages-handler.ts`), and the manifest handler deps and their `buildRouterDeps` caller, are each named as one Task in Phase 5. **Caught (3):** the `run-authority-refused` HostError and its exhaustive status table and `discloseHostError` are one Task. New modules with no caller yet (Phases 2 and 3) are exempt by the rule's own text |
| Coverage specificity | AS-026, AS-034, FR-017, FR-022, FR-023, AS-027, AS-022, NFR-012, NFR-003, plus every Requirement whose path the 12 resolutions moved | AS-034 now distinguishes `custody-expired` (the authority's expiry has passed: zero store reads, zero Entra calls) from `custody-absent` (record gone before expiry), with the store keeping PX at the binding expiry. So the FR-017 cap holds for ciphertext, and CT-3 decides both cases (advisory 2). NFR-012 gains the one-writer-per-run custody case in CT-2 (advisory 3). **Caught:** AS-022's 401 must name the audience, but admission had no typed source for it. `delegated-token-required` now carries `audience` from pass 1 |
| JUDGE (constraining Requirements decided by acceptance in the building phase) | The new behaviour each resolution adds | Zero JWKS calls on static refusals: CT-1 acceptance (Phase 4) and the run-authority property test (Phase 2). Concurrent delegated redeem, CAS-on-missing and CAS contention: CT-2 acceptance (Phase 3, the phase that builds the custody cell). Expired versus absent: CT-3 acceptance (Phase 5). The `origin` derivation: CT-4 (Phase 4). The budgets and sentinel gates moved with their contracts: CT-1 and CT-4 to Phase 4, CT-3 at Phase 5 |
| OWN (a rule applied at 2+ sites is owned, or unowned with a reason) | Fault classification and projections, bracket, origin, custody binding, expected audience | INV-4 is deepened: the owner holds the whole bracket, and its siblings fall from three modules (eight call sites) to two modules (three calls); `delegation-establishment.ts` leaves the sibling list (advisory 5). **Caught:** pass 1 now builds the expected audience, so the INV-5 admission sibling moves from `run-authority-admission.ts` to `domain/run-authority.ts`, and its row moves to Phase 2. Explained, not owned: `frameworkErrorOf` is applied only in `capability-authority.ts` and `runAuthorityRefusalOf` only in `run-authority-lifecycle.ts`, one module each (advisory 6); `classifyTokenEndpointError` is one function with two importers and is property-tested once; `originOf` is applied only in `forRun`; `custodyBindingOf` is one function whose three callers (seal, open, reason) derive from the one `RunAuthority`, so there is no second rule to drift |
| SEAM (runtime seams and acceptance start at production edges) | All four contracts' seam lists against the changed paths | No seam added or removed. `createRunAuthorityLifecycle` and `establishDelegation` are built only inside `composeRunAuthorityWiring`, which is already a seam of every contract. The custody cell is private to `forRun`. The seam-sweep rows are rewritten for the new paths, and every declared symbol still exists |
| MODEL (lifecycles bound, invariants well-formed, types files declarations only) | LC-1, INV-1 to INV-5, the three types files, the export bindings | LC-1 is still bound to `delegated-custody.ts`, with the same five states and event table. The guards take the binding as an event input, and no state carries an expiry (advisories 4 and 10). The fencing rule is declared on `CustodySwap`, `PersistedCustody` and `CustodyRead` in the CT-3 types (advisory 4). `CustodySeconds`, `EpochMs`, `DurationMs` and `CustodyGeneration` are brands (advisory 11). Every new export binding names a type declared in its contract's types file: `ClassifyTokenEndpointErrorFn`, `FrameworkErrorOfFn`, `RunAuthorityRefusalOfFn`, `AdmitDelegatedPresentationFn`, `OriginOfFn`, `CustodyBindingOfFn`, `CreateRunAuthorityLifecycleFn`. **Caught:** the parser takes only an invariant statement's first paragraph, so the INV-3 and INV-4 statements are kept to one paragraph each |
| FEAS (nothing contradicts `clarifications/log.md`) | Every clarify answer, against the 12 resolutions | No contradiction. The custody cell's CAS re-read and single re-swap make no Entra or realm call. The clarify answer "no internal retry (apart from the existing single-flight de-duplication)" concerns transport retries, and CT-2 still asserts exactly one transport call per transient failure. The custody cap, the AAD fields (now derived, not stored), the `authority-unavailable` causes and the no-`app`-fallback rule are unchanged |

### Plan self-audit (design-review loop-back 6)

The second plan design review returned 12 advisories (11 numbered items; item 3 also closes the alignment note that AD-5 and Component Design disagreed on `signature-verified`). All were accepted under the user's delegation and resolved in this loop-back. The phase-boundary walk below was done against the code, not the plan: for every type the plan changes, the constructors and matchers were found by searching the worktree (`kind: "user"` literals, `canRunDag:` fixtures, realm-claim fixtures, `identity: {` and `ownerTeam:` record fixtures, `.exhaustive()` matches of `HostError`, every importer of `token-cache.ts`, `capability-gate.ts` and the subject-token symbols, every caller of `createRunDagHandler`, `createNodeContextForDag`, `createRunExecutor`, `startRun(` and `recordDecision(`), and each hit was checked against the Phase whose Task changes the type. "Caught" lists what this pass found beyond the 12 advisories; each is fixed in the plan.

| Category | What was checked | Result and caught |
|---|---|---|
| Phase boundary (every Wave typechecks; a required field, a narrowed type, a widened union or a changed signature travels with every constructor and matcher) | Phase 1: framework union, `decideGate`, `capability-catalog-invalid`, subject-token removal. Phase 2: `AuthenticatedUser.entra`, `AuthIdentity.user.entra`, `PersistedIdentity.user.entra`, `identity-config-invalid`, `ENTRA_CLIENT_ID` removal, `planAuthorityLegs`. Phase 3: token-cache key, `broker-audit`, `graph-capability`. Phase 4: `RunDagDeps`, `startRun`, `HitlRunServiceDeps`, `RunExecutorDeps`, `RunExecutionRequest`, `NodeContextForDag`, `RunRecord.authority`, `run-authority-refused`. Phase 5: `recordDecision`, `RunRecord.approvals`, manifest deps | Advisory 1 is resolved by one Phase 2 Task for the required realm principal, which carries `hitl/identity.ts`, `hitl/types.ts`, the run-store schema and 14 test files, with the Teams approver given its own `TeamsApprover` type. **Caught (1):** `http/middleware/error-handler.ts`'s `rawDetailsFor` is `.exhaustive()` over `HostError` and was in no Task; it now joins all three HostError widenings (Phases 1, 2, 4). **Caught (2):** Phase 1 demolition missed `adapters/unwired-token-endpoint.ts` (its `exchangeV2` stub implements the port method being removed) and `unwired-defaults.test.ts`. **Caught (3):** Phase 1 changes `decideGate`'s signature, and its caller `keycloak-broker.ts`, its test and `capability-gate.test.ts` are now named in that Task. **Caught (4):** Phase 2's required realm claims break `jwt-validation.test.ts`, `realm-jwt-verifier.test.ts` and `supervisor.test.ts`, now named. **Caught (5):** the Phase 4 cut-over missed `RunExecutionRequest` (`hitl/ports.ts`) and ten fixture files that construct `RunDagDeps`, call `startRun` or build executor requests and records (`run-dag.test.ts`, `hitl-http.test.ts`, `mapped-host-composition.test.ts`, `dag-isolation.test.ts`, `mapped-process-resume.test.ts`, `fixtures/mapped-resume-worker.ts`, `service.test.ts`, `service-admission.test.ts`, `redis-stores.test.ts`, `bot.test.ts`). **Caught (6):** Phase 5's `recordDecision` and `approvals` change the same fixtures and `manifest.test.ts`, now named. **Caught (7):** Phase 3's cache key ADT: `token-cell.ts` keys by string, so the ADT is encoded by `cacheKeyOf` and `token-cell.ts` stays unchanged; `token-cache.test.ts` moves with it, and the legacy `cacheKey` goes with its last importer in the cut-over |
| Coverage specificity | Every Requirement whose path the 12 resolutions touched: FR-005, NFR-010, FR-007 to FR-009, AS-023, FR-017, AS-026, AS-034, FR-022, NFR-012, FR-023, AS-027, AS-028 | Advisory 10: the closed-world catalog requirement is FR-005 ("a capability without [a mode] MUST be unrepresentable") with NFR-010 ("no gap may degrade into broader authority"); the spec needs no new scenario, because an undeclared capability in a brokered namespace is exactly a capability without a mode. `capability-unknown` is decided in pass 1, property-tested in Phase 2, and asserted in CT-1 acceptance (Phase 4) as part of CT-1's refusal set. FR-005 stays decided by its build-time and boot-time tests (AS-009), so it is not added as a CT-1 anchor, which would ask CT-1 acceptance to decide a compile error. Every other Requirement keeps its anchor and its building phase |
| JUDGE (constraining Requirements decided by acceptance in the building phase) | The behaviour each resolution adds | `capability-unknown`: CT-1 (Phase 4) and `run-authority.property.test.ts` (Phase 2). The custody outcome table: `decide-redeem-step.property.test.ts` (Phase 2) and CT-2's concurrency, CAS-on-missing and contender cases (Phase 3). One cell per run: the INV-4 matrix (owner rows Phase 3, sibling rows Phase 4) and CT-2, whose handles now come only from a lifecycle bracket. Closed fault causes: CT-2's FR-022 sentinel scan (Phase 3) plus the type |
| OWN (a rule applied at 2+ sites is owned, or unowned with a reason) | Mode reading, issuer derivation, handle building, generation assignment, fault projection | INV-2: `authorityOf` is total over a catalog-minted scope; the four siblings are unchanged and the gate's note now says it hands a scope, not a definition. INV-4: the owner also builds every bracket's handle, so `hitl/adapters/run-executor.ts` becomes the third sibling (`withRecordedAuthority`); `run-custody-cell.ts` holds only `get` and `swap` and is not a sibling. Explained, not owned: `issuerFor` is one function with two callers (claim validator, verifier); generation assignment lives only in the two store adapters, which share the port's contract and the same store tests; `decideRedeemStep` has one caller, the cell |
| SEAM (runtime seams and acceptance start at production edges) | All four contracts' seam lists against the changed paths | No seam added or removed. `verifyEntraUserToken` is now a static import of `createRunAuthorityAdmission`, which only `composeRunAuthorityWiring` builds, and its JWKS transport is already a faked network edge in `IdentityTransports`. `createRunCustodyCell` is called only inside `forRun`, and `forRun` is reachable only through the lifecycle the wiring returns. The CT-1, CT-2, CT-3 and CT-4 seam descriptions and the seam-sweep rows are rewritten for the bracket-owned handle; every declared symbol still exists, and no runtime-seam line has nested parentheses |
| MODEL (lifecycles bound, invariants well-formed, types files declarations only) | LC-1, INV-1 to INV-5, the three types files, the export bindings | LC-1 is bound to `domain/delegated-custody.ts` with a parseable table of three states (`absent`, `held`, `revoked`) and three events (`establish`, `rotate`, `refuse`), each a persisted production transition (advisory 5). The fence is a type: `CustodySuccessor` has no generation (advisory 7). New export bindings name types declared in their contract's types file: `DecideRedeemStepFn` (CT-3), `IssuerForFn` and `VerifyEntraUserTokenFn` (CT-1). The per-path fault subsets and `UnreachableCause` are declarations in the CT-2 types. `CapabilityScope` carries a module-private symbol, so its declaration stays in `capability-catalog.ts` and the CT-1 types file imports it as a type. INV-4's statement is still one paragraph |
| FEAS (nothing contradicts `clarifications/log.md`) | Every clarify answer and architecture decision, against the 12 resolutions | No contradiction. Removing `RunRecord.identity` in the cut-over keeps every persisted fact the clarify answers rely on (the initiator's realm sub and Entra principal live on `record.authority`). Dropping the custody `expired` state keeps the AS-034 distinction, which never depended on a persisted `expired`. The Teams approver keeps FR-041's fail-closed `canAccessDag` check unchanged |

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
  - The user token is wrapped in a `RedactedSecret` (`domain/redacted-secret.ts`) whose `toJSON`, `toString` and inspect hook return `[redacted]`; `revealSecret` is called only by the Entra form-body builders, the custody cipher and the user-token verifier.
  - Refresh credentials exist in plaintext only inside `custody-cipher.ts` calls.
  - Custody records hold ciphertext with AAD. A record replayed under another run or user fails to open.
  - Custody is capped at `DELEGATED_CUSTODY_MAX_SEC`, default min(604800 s, `HITL_RUN_TTL_SEC`) = 7 days with default keys, never above `HITL_RUN_TTL_SEC`, never unbounded.
  - FR-022 is decided per building phase by the sentinel assertions in CT-2 (Phase 3), CT-1 and CT-4 (Phase 4) and CT-3 (Phase 5) acceptance (INV-3).
  - Custody records carry no binding. The AAD is derived from the run's `RunAuthority` at seal and at open, so the stored record and the authority cannot disagree about the run, the user or the expiry.
  - Acquisition faults carry no free text: `unreachable` holds the closed `UnreachableCause`, so no response body or credential can reach an error value through a fault (design-review loop-back 6).
  - A capability the catalog does not declare is refused at admission (`capability-unknown`), so no undeclared capability reaches the mint path with an assumed mode.
- **No probe surface before refusal:** the Entra JWKS is fetched only for a submission that pass 1 cannot refuse statically, so a team token, an unexpected header or a dark leg never triggers egress to Entra's key endpoint.
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

| Date | Change | By |
|---|---|---|
| 2026-11-24 | Initial plan, Approach A, decided under explicit user delegation | architecture-agent |
| 2026-11-24 | Loop-back 1 (plan alignment). JUDGE-1: the NFR-002, NFR-003 and SC-011 budgets are now CT-2 and CT-1 acceptance files (`capability-authority-budget`, `run-authority-admission-budget`) gated in Phases 3 and 5, anchored on the new spec scenarios AS-035 and AS-036 (Loom accepts only FR and AS anchors); the Phase 6 `identity-latency.bench.test.ts` is removed. OWN-1: a new owned INV-4 (owner `adapters/custody-release.ts`; siblings `hitl/service.ts`, `http/handlers/run-dag.ts`, `adapters/delegation-establishment.ts`; matrix test `custody-release.matrix.test.ts`) replaces `hitl/__tests__/custody-teardown.test.ts`. Siblings get `ReleaseCustody` and a narrowed store, and the CT-3 types gain the release types and an export binding. SEAM-1: `proxyToWorker` is a CT-1 runtime seam, and CT-1 acceptance submits through it. SEAM-2: `createAuthMiddleware`, `createApproveRunHandler`, `handleBotActivity`, `errorResponse` and `createCustodyRelease` are CT-3 runtime seams, and CT-3 acceptance approves through the route and the bot handler | architecture-agent |
| 2026-11-24 | Loop-back 2 (plan alignment). SEAM-1: AS-006, FR-004 and FR-020 move from CT-1 to a new contract CT-4 (`user-run-attribution.acceptance.test.ts`, entry point `host.ts`), whose runtime seams are `createRunDagHandler`, host.ts `createRunContextFactory` and `createDagExecutor` (now exported and used by `buildRouterDeps`), `createNodeContextForDag` and `createCapabilityAuthority`. CT-4 acceptance runs a user-origin sync run end to end through the real executor and context factory with fake transports only and asserts the initiator `oid` on every mint audit record. `createNodeContextForDag` returns a `RunMinting{authority, origin}` built from one `RunAuthority`, and `executeDag` takes it, so origin and authority cannot disagree. A new contract rather than extra CT-1 seams, because every CT-1 acceptance file must reference every CT-1 seam, which would fold DAG execution into the AS-036 run-start validation budget | architecture-agent |
| 2026-11-24 | Loop-back 3 (plan alignment). SEAM-1: CT-3 runs now start through the production route (`proxyToWorker`, `createAuthMiddleware`, `createRunDagHandler` with its HITL branch), so the `RunAuthorityPlan` handed to `startRun` is the one admission derives. Complete seam sweep (Testing Strategy, Acceptance seam sweep) found the same class of bypass in every contract: the route's `admitRunAuthority`, `establishRunAuthority` and `releaseCustody`, the HITL service's establishment, and the executors' capability authority were injected deps with no declared production factory, so any acceptance could hand-build a plan or pick a fake port. Fix: new `adapters/run-authority-admission.ts` (`createRunAuthorityAdmission`) and `adapters/run-authority-wiring.ts` (`composeRunAuthorityWiring`, the only production composition of legs, adapters by model, verifier, custody cipher and store, `createCustodyRelease`, `createCapabilityAuthority` and admission), built in Phase 3, called once by host.ts; host.ts also exports `composeHitlRunService`; `HostDeps.capabilityBroker` removed and `HostDeps.identityTransports` added. Seams: CT-1 adds `composeRunAuthorityWiring`; CT-2 adds `composeRunAuthorityWiring`; CT-3 adds `proxyToWorker`, `createRunDagHandler`, `composeRunAuthorityWiring`, `composeHitlRunService`, `createRunContextFactory`, `createDagExecutor` and replaces `createHitlRunService`, `createRunExecutor` and `createCustodyRelease`, which those compositions build; CT-4 adds `proxyToWorker`, `createAuthMiddleware`, `composeRunAuthorityWiring` and replaces `createCapabilityAuthority`, which the wiring builds. CT-3 acceptance also runs sync delegated runs (completed, failed, timeout abort), because AS-027's cancelled teardown exists only on the sync path. Requirement anchors unchanged; CT-3 goes green at the Phase 5 Wave Gate | architecture-agent |
| 2026-11-24 | Loop-back 4 (plan alignment). FR-017 / AS-026: `DELEGATED_CUSTODY_MAX_SEC` is an optional positive integer (malformed → `loadConfig` refusal), unset → min(604800, `HITL_RUN_TTL_SEC`) (7 days with default keys), above `HITL_RUN_TTL_SEC` → boot refusal `custody-max-exceeds-run-ttl`; `custodyExpiryFor` and the run deadline are stated; CT-3 asserts the default and an explicit cap, CT-2 asserts the default in Phase 3. AS-009 / FR-005 / SC-013: one boot catalog entry point, `loadCapabilityCatalog(HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG)` in `createHost`, returning the new `capability-catalog-invalid` HostError (`boot-capability-catalog.test.ts`, Phase 1); no module-load parse; the parsed catalog feeds the gate, `composeRunAuthorityWiring` (new `catalog` input) and the manifest. JUDGE-1 (FR-022 / SC-007): FR-022 is anchored in CT-2, and the new spec scenarios AS-037, AS-038 and AS-039 restate it per surface in CT-1, CT-3 and CT-4, each scanned by the shared `credential-sentinel.ts` over nine enumerated surfaces of the production composition and gated at Phases 3 and 5; the Phase 6 `credential-sentinel-scan.test.ts` is removed. The self-audit (Testing Strategy, "Plan self-audit (loop-back 4)") also fixed: per-leg presence gating to match the clarify answer for AS-013 (partial config is dark with a warning); the `identity-config-invalid` HostError and `boot-identity-refusal.test.ts`; AS-034 surfaced through `createGetRunHandler` (new CT-3 seam); CT-2 now states NFR-012, NFR-021, FR-002, FR-003, FR-012 and the dark-leg case; new owned INV-5 (one source for the delegated audience); the `RedactedSecret` runtime moved to `domain/redacted-secret.ts`; `CapabilityScope` replaces `CatalogScope` on the mint port; the Phase boundary rule moves every legacy-path deletion into the Phase 5 host switch so every Wave type-checks | architecture-agent |
| 2026-11-24 | Loop-back 5 (plan design review; 12 advisories, all accepted under user delegation). (1) Phase 4 broke typecheck: the old Phases 4 and 5 become a Phase 4 run-start cut-over (one Task carries `startRun`, the HITL and executor deps, `RunDagDeps`, `NodeContextForDag` and `RunRecord.authority` with their callers `run-dag.ts` and host.ts, plus the legacy deletion) and a Phase 5 of approvals and manifest; the Phase boundary rule now covers signature changes and exhaustively matched unions, which also moves the `framework-error-http.ts` mapping into the Phase 1 union-widening Task; the INV-4 hedge is removed. (2) `custody-expired` is reachable: the store keeps PX at the binding expiry and returns `absent`, and the custody cell decides expired versus absent against the expiry the `RunAuthority` carries (expired: zero store reads, zero Entra calls); CT-3 decides both. (3) One single-flight custody cell per run is the only reader and writer of custody; `swap` is a generation-fenced CAS that never creates (a late rotate after release fails `custody-absent`); a stale CAS re-reads and swaps once more; the host-error ↔ transition table is in Component Design; CT-2 adds the concurrent-capabilities, CAS-on-missing and contender cases. (4) Fencing in types: every persisted state (`held`, `revoked`) carries a `CustodyGeneration`; `get` returns `CustodyRead` (never expired or deleted); `CustodySwap`/`CustodySwapOutcome` in the CT-3 types. (5) INV-4 deepened: `createRunAuthorityLifecycle` (`adapters/run-authority-lifecycle.ts`, replacing `custody-release.ts`) owns the bracket with `withEstablishedAuthority`, `establishForRecord` and `endRun`, deriving the release cause; siblings fall to `run-dag.ts` (one call) and `hitl/service.ts` (two calls); matrix test renamed `run-authority-lifecycle.matrix.test.ts`. (6) One `AcquisitionFault` ADT replaces `AssertionFault`, `EntraAcquisitionFault` and `DelegationEstablishmentFault`; `classifyTokenEndpointError` is the one classifier; `frameworkErrorOf` and `runAuthorityRefusalOf` are the two exhaustive projections, one module each. (7, 8) Two-pass admission: pure pass 1 (`planRunAuthority`) decides every static refusal, the verifier runs only on `verify-delegated` with a `DelegatedTokenExpectation`, pure pass 2 (`admitDelegatedPresentation`) validates claims and binds; zero JWKS calls on static refusals, property-tested and in CT-1; INV-5's admission sibling moves to `run-authority.ts`. (9) `RunMinting` removed: `forRun` returns `{broker, origin: originOf(run)}`, `createNodeContextForDag` hands on only the `RunAuthority`, and the broker's `agentClientIdFromFrameworkOrigin` re-check is removed. (10) Custody records store no binding; `custodyBindingOf(runId, authority)` derives the AAD from the one `RunAuthority`. (11) `CustodySeconds`, `EpochMs`, `DurationMs`, `CustodyGeneration` brands. Self-audit: "Plan self-audit (design-review loop-back 5)" | architecture-agent |
| 2026-11-25 | Loop-back 6 (plan design review 2; 12 advisories, all accepted, decided under user delegation). (1) Phase 2 broke typecheck by making `entra` required while `approverTeamIdentity` and `toExecIdentity` built `user` values in later phases: the Teams approver gets its own `TeamsApprover` type (no fabricated realm principal, `canAccessDag(AuthIdentity \| TeamsApprover)`), and one Phase 2 Task makes the realm principal required on `AuthenticatedUser`, `AuthIdentity` and `PersistedIdentity` together with `hitl/identity.ts`, `hitl/types.ts`, the run-store schema and every fixture; every Phase was re-walked against the code and seven further boundary breaks were fixed (see the loop-back 6 self-audit). (2) The custody outcome table moves out of the I/O adapter into the pure `decideRedeemStep` beside `transitionCustody`, property-tested row by row with no fakes; `adapters/run-custody-cell.ts` is a thin sequencer. (3) `signature-verified` carries claims only; pass 2 builds the grant from `step.token`. (4) The `VerifyEntraUserToken` port is removed; `verifyEntraUserToken(step, jwks, signal)` is a plain adapter function over the JWKS transport, reachable only with a pass-1 step. (5) LC-1 shrinks to `absent`/`held`/`revoked` with `establish`/`rotate`/`refuse`; expiry is a pure comparison and release is the owner's DEL. (6) `delegation.runId` lives on the `user-delegated` authority; `custodyBindingOf(authority)` derives key and AAD from one value; the lifecycle is the only `forRun` caller, once per bracket (`withRecordedAuthority` added for HITL slices), so one cell per run is structural. (7) `CustodySuccessor` has no generation; the store assigns 0 on `put` and `expected + 1` on `swap`. (8) `AcquisitionFaultOf<H, R>` with `AppAcquisitionFault`, `EstablishmentFault`, `DelegatedGrantFault` and the full `AcquisitionFault`; projections total over each subset. (9) `unreachable{cause: UnreachableCause}` with the closed `status`/`timeout`/`network` (plus `custody-store`) cause, rendered at formatting time. (10) Requirements are parsed by `classifyCapabilities` into catalog-minted `CapabilityScope`s; an unknown capability in a brokered namespace is the typed `capability-unknown` refusal (503, first in precedence; FR-005, NFR-010); `authorityOf(scope)` is total. (11) `DelegatedTokenExpectation` is `{tenant, audience}`; `issuerFor(tenant)` derives the issuer in the validator and the verifier. `RunRecord.authority` replaces `RunRecord.identity` in the Phase 4 cut-over, and `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are deleted there. |
