# Plan: Agent Identity Redesign (per-agent Entra identity, per-capability authority mode)

**Spec:** .claude/specs/2026-11-24-agent-identity-redesign/spec.md
**Created:** 2026-11-24
**Spec ids:** the architecture phase renumbered three non-canonical ids so the spec parses: AS-013a is AS-033, AS-026a is AS-034, FR-019a is FR-025.
**Companions** (in `.claude/specs/2026-11-24-agent-identity-redesign/`): `architecture-interview.md` (questionnaire answers), `plan-history.md` (loop-back history, self-audits, moved rationale) and `plan-reference.md` (data flow, security notes, seam and budget detail).

## Summary

Only an agent's own identity federates into Entra: every realm assertion is requested with `entra-exchange <capability>` and handed to a model-polymorphic `EntraAgentAuthority` port (Entra Agent ID, or per-agent app registrations). Each capability declares `app` or `delegated` in one typed catalog with no default. A pure run-start planner turns identity, DAG requirements and catalog into a `RunAuthority` before the HITL fork or a concurrency slot; a boot-scoped `CapabilityAuthority` derives each run's broker and origin from it by `forRun`, replacing the deleted subject-token registry and RFC 8693 user exchange. Delegated mode does one on-behalf-of exchange at admission and writes the run-bound refresh credential once, AES-256-GCM sealed in Redis under a three-state custody lifecycle (LC-1); execution only reads it, through a pure redeem decision function, and never rotates it. A refused or missing credential parks a HITL run `awaiting-reauthorization` at that node (a vendor-neutral framework park seam) until the recorded initiator re-authorizes, and fails a sync run with the typed re-authorization-required error; a resume slice whose admitted authority no longer matches the boot catalog fails before any node runs. One run-authority lifecycle owns establishment, re-establishment, the per-bracket handle (sole `forRun` caller) and release at every terminal state. A HITL decision is stored with its approver in one first-writer-wins write; every approval attempt is audited. Each acquisition path returns only its own faults. The Keycloak realm changes run outside the task graph.

Executable models: three lifecycles (LC-1 custody, LC-2 HITL run status, LC-3 framework DAG phase), eight invariants (INV-1 checkable; INV-2 and INV-4 to INV-8 owned; INV-3 advisory and unowned) and six contracts (CT-1 to CT-6). No Pipeline: this is not a fugue DAG feature.

> **Decision provenance.** Loop-backs 1 to 10 were decided under explicit user delegation; D1–D8 (loop-back 11), the custody window (11b) and S1/S2 (12) are the user's own; loop-back 12's gap fixes were made by the architecture agent at the user's go-ahead. Quotes and detail: `plan-history.md#loop-back-12-moved-verbatim`.

---

## Approach Gate

**Decided under explicit user delegation:** Approach A (recommended, and picked).

### Approach A: Run-bound authority (picked)

Shape, pros, cons and risk: `plan-history.md#loop-back-12-moved-verbatim`.

Rejected: Approach B (boot-scoped broker plus a process-global `RunAuthorityRegistry`) and Approach C (framework-native authority mode); text in `plan-history.md#approaches-b-and-c-full-text-at-loop-back-6`.

---

## Architectural Decisions

Each AD's rationale (Why): `plan-history.md#loop-back-12-moved-verbatim` (moved verbatim in loop-back 12); its rejected alternatives: `plan-history.md#rejected-alternatives-of-ad-1-to-ad-13-at-loop-back-11`.

### AD-1: Run-bound authority replaces the process-global subject-token side channel

**Choice:** A boot-scoped `CapabilityAuthority` whose `forRun(bound)` (Component Design › Capability Authority) returns a broker closed over the run's immutable `RunAuthority`, from admission (sync) or the persisted record (HITL). The run-authority lifecycle (AD-6) is its only caller, once per execution bracket (a sync run or one HITL slice). The authority persists no run id; it travels in the branded `BoundAuthority` (builders: Component Design › Run Authority Planner), and custody key and AAD come from `custodyBindingOf(bound)`. The broker routes by `routeRequirement` over `access` (AD-2), so the mint path never asks whether a run is delegated; the origin is `originOf(run)`, never stored; the broker never reads `inv.origin`, so `agentClientIdFromFrameworkOrigin` is removed. `SubjectTokenRegistry`, the subject-token side channel and the RFC 8693 exchange are deleted with no shims (CONTEXT.md Key Invariant 8; symbols: Phase 1 demolition Task).

### AD-2: Authority mode is part of the capability definition, in one catalog with no default

**Choice:** `domain/capability-catalog.ts` holds `CAPABILITY_CATALOG` (`as const satisfies Record<string, CapabilityDefinitionInput>`, where `authority: "app" | "delegated"` and `resource: "graph" | "dynamics"` are both required); interface in Component Design › Capability Catalog.
- `parseCapabilityCatalog` is the only constructor of the branded `CapabilityCatalog`; `authorityOf(scope)` is the only, total reader of a mode (INV-2), because only the catalog module mints a `CapabilityScope`.
- Pass 1 classifies requirement strings with `classifyCapabilities` into `brokered{scope}`, `not-brokered` (e.g. `http`, or an ADR-0051 custom `mycorp:widget` another provider serves) or `unknown` (a brokered namespace — `msgraph:`, `dynamics:` or one a data catalog introduces — whose key the catalog lacks). Any `unknown` is the `capability-unknown` refusal (503), first in the precedence, so an undeclared capability never defaults to `app` (FR-005; NFR-010). Pass 1 resolves each brokered mode into the run's name-keyed `access`; the mint path routes by it, reading no mode, and its one catalog fact is `brokeredNamespacesOf(catalog)`, so a brokered-namespace name `access` lacks fails closed.
- `capability-scope.ts` folds into the catalog and is deleted; `KNOWN_SCOPES` and the handle types are re-derived from catalog keys. All three existing capabilities declare `app`.
- Parsed once, at boot: `createHost` calls `loadCapabilityCatalog(HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG)` right after startup (`Err` → `capability-catalog-invalid{faults}`, before any capability connects); nothing parses at module load. The one value goes to the legacy gate until the Phase 4 cut-over, to `composeRunAuthorityWiring` and to the manifest handler, so a data-sourced catalog reaches every INV-2 sibling, and the delegated test capabilities (OOS-004) use the same parser.

### AD-3: One capability-facing contract, two Entra identity adapters, explicit model in configuration

**Choice** (FR-011, FR-019, SC-008: switching model is configuration only):
- The port `EntraAgentAuthority { acquireApp, establishDelegation, redeemDelegation }` (`domain/port/entra-agent-authority.ts`).
- `createAgentIdAuthority`: two client_credentials calls, step 1 to the blueprint (`client_id=blueprint`, `scope=api://AzureADTokenExchange/.default`, `fmi_path=<agent identity>`, `client_assertion=<realm assertion>`) yielding T1, step 2 as the agent identity (`client_assertion=T1`, `scope=<resource>/.default`); on-behalf-of and refresh as the agent identity with `client_assertion=T1`.
- `createAppRegistrationAuthority`: one client_credentials call as the agent's app; on-behalf-of and refresh with `client_assertion=<realm assertion>`.
- `ENTRA_IDENTITY_MODEL` (`agent-id` | `app-registration`, no default) parses into the `EntraDirectory` ADT, whose variant selects the adapter; capability and DAG definitions never see the model.
- `ENTRA_CLIENT_ID` and the single `fugue-agents` app (ADR-0055) are removed.

### AD-4: Every realm mint requests `entra-exchange <capability>`, and the assertion is inspected before Entra egress

**Choice:**
- `RealmAssertionMint.mintFederationAssertion(agent, capability)` always posts client_credentials with `scope="entra-exchange <capability>"` and no `audience` parameter.
- The pure `inspectFederatedAssertion` decodes the minted payload (from our own token endpoint over TLS: a sanity check, not trust) and requires `aud` ∋ `api://AzureADTokenExchange` and `scope` ∋ both grants.
- A Keycloak `invalid_scope`, or a token missing either grant, is `authority-unavailable{federation-grant-missing}` naming the grant(s), before any Entra egress (AS-003).

### AD-5: Two-pass run-start admission: a pure static pass, verification only on demand, a pure completion pass

**Choice:** Two pure functions in `domain/run-authority.ts` surround one I/O step (types and precedence: Component Design › Run Authority Planner). Pass 1 (`planRunAuthority` over `runtimeNodeInventory`, newly exported from the framework barrel) classifies first and decides every refusal needing no signature or claim check, through `delegated-token-invalid{malformed}`; only it builds the `DelegatedTokenExpectation`. Only for its `verify-delegated` step does the shell (`run-authority-admission.ts`) call `verifyEntraUserToken`, which returns claims only. Pass 2 (`admitDelegatedPresentation`) validates claims, binds the principal and builds the `VerifiedDelegationGrant` from `step.token` (one token source). `run-dag.ts` calls `admitRunAuthority` (the three composed into one branded `AdmittedRun`) after input parsing, before `hitl.startRun` and `acquire`; a refusal maps to `run-authority-refused` and its status.

### AD-6: Delegated authority is established eagerly at admission and continued through write-once, Redis-held custody

**Choice:** Admission yields `user-delegated-pending{grant}`. One operation owns the bracket from establishment to release: the run-authority lifecycle (`adapters/run-authority-lifecycle.ts`, owner of INV-4, INV-6 and INV-7), built once by `composeRunAuthorityWiring`; brackets, store, redeem table, release and key rotation: Component Design › Delegated Custody. The lifecycle alone holds `forRun` (the wiring does not expose the capability authority), re-establishment and the store's `delete`; each sibling holds a narrowed `Pick<RunAuthorityLifecycle, …>` (INV-4, INV-6, INV-7).
- **Establishment** (`establishDelegation`, CT-3): one on-behalf-of exchange with `offline_access`, sealed with AES-256-GCM; key (`fugue:<tenant>:authority:custody:<binding.runId>`), AAD and TTL derive from the `BoundAuthority` it returns, and the LC-1 `establish` guard runs before `put`. No compensation of its own: any `Err`, an ambiguous `put` included, returns to the lifecycle, which releases and refuses. The user token is a `RedactedSecret`, dropped when establishment returns.
- **Written once, never rotated (D1).** Entra does not revoke a refresh credential on redeem, and the confidential-client refresh lifetime (90 days) exceeds the custody cap, so every redeem uses the credential establishment wrote; `redeemDelegation` returns only the access credential, discarding any returned refresh credential. Execution's one custody write is `revoke` after Entra refuses a redeem; re-authorization (AD-13) re-establishes through the lifecycle.
- **Redis everywhere (D2).** `REDIS_URL` is required and the host degrades without Redis, so production custody is the Redis store for sync and HITL runs; the in-memory store is a test fake only.
- **Expiry** `custodyExpiryFor(now, max, runDeadline)`: `max` = the wired `DelegationLeg.maxSec` (`DELEGATED_CUSTODY_MAX_SEC`, unset → min(604800, `HITL_RUN_TTL_SEC`)); deadline = the sync route's timeout or establishment + `HITL_RUN_TTL_SEC`; 7 days with default keys. Fixed at establishment on the `RunAuthority` beside the run deadline (`delegation.runDeadlineMs`, never extended); a re-authorization is fresh consent and re-derives it as `custodyExpiryFor(now, max, runDeadlineMs)` (AD-13, the user's decision on the loop-back 11 report).
- **Redeem** runs the pure `decideRedeemStep` through the agent identity, with no `app` fallback.
- **Revocation is Entra's, per refresh (D3).** A disabled account, Conditional Access (sign-in frequency included) and an explicit session revocation refuse a refresh; a password change or reset does NOT revoke a confidential-client refresh credential. Operator cut-offs: disable the user, `revokeSignInSessions`, or end the run (a rejecting approver, or eviction at its TTL).

### AD-7: Inbound delegated-token contract and identity binding

**Choice:**
- The header is `X-Fugue-Delegated-Authorization: Bearer <compact JWT>` (the `X-Fugue-*` convention), beside the realm `Authorization`; refused (400) on runs needing no delegation; the manifest publishes per DAG whether it is required and its audience.
- `validateEntraUserTokenClaims` (pure, `domain/entra-user-token.ts`) checks:
  - `iss = issuerFor(tenant)` = `https://login.microsoftonline.com/{tenant}/v2.0` (the one derivation, shared with the verifier; the expectation carries only the tenant).
  - `tid` equals the deployment tenant (OOS-005)
  - `aud` equals the expected audience: the blueprint client id (agent-id model) or that agent's app id (app-registration model)
  - `azp` is in the deployment's allowlist `DelegatedTokenExpectation.clients` (`DELEGATED_CLIENT_APPS`, D4): the client application that obtained the token
  - `exp` and `nbf` within 60 s of skew
  - `oid` present
  - `scp` present (a delegated token, not app-only), and its space-separated scopes CONTAIN `DelegatedTokenExpectation.scope` (`DELEGATED_SCOPE`, for example `access_agent`, D4)
  - `ver = "2.0"`
  - Refusal order (first failure wins, unchanged precedence with the two new checks placed after `audience`): malformed, version, issuer, tenant, audience, client, expired, not-yet-valid, not-delegated, scope. The new `DelegatedTokenInvalidReason` values are `client` and `scope`; a refusal names the failed check only, never a claim value (AS-040).
- `verifyEntraUserToken` in `adapters/entra-user-token-verifier.ts`, a plain adapter function with no port, checks the signature: jose, RS256 only, through `lazyJwks` over `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, reached through the injected JWKS transport.
- `bindDelegatedPrincipal` requires that `oid` and `tid` equal the realm principal's.
- `AuthenticatedUser` gains a required `entra: EntraPrincipal`, parsed from the `entra_oid` and `entra_tid` claims by `validateRealmJwtClaims`. A realm user JWT without them is a 401 `unauthorized` that names the missing claims.
- **No default allowlist or scope (D4).** `DELEGATED_CLIENT_APPS` and `DELEGATED_SCOPE` join `DELEGATED_CUSTODY_KEYS` as required delegation-leg keys (formats: File Structure, `config.ts`): any unset leaves the leg dark (delegated runs refused `delegation-unconfigured` naming every missing key); a malformed value is the boot fault `identity-config-invalid`. Both live only on the wired `DelegationLeg`, built only by `planAuthorityLegs`.
- **Not an invariant** (reason: `plan-history.md#loop-back-12-moved-verbatim`, AD-7). CT-1's AS-040 acceptance covers them.
- **Runbook (D4).** On the exposed delegated scope, pre-authorize only the allowlisted clients and disable user consent, so no other client can obtain a token for it without an admin.

### AD-8: Extend the capability failure taxonomy with `authority-unavailable`

**Choice:**
- Add the framework kind `authority-unavailable{scope, agentClientId, cause}`. The cause (`AuthorityUnavailableCause`) is one of:
  - `{kind: "federation-grant-missing"; grants: readonly string[]}`
  - `{kind: "authority-unconfigured"; missing: readonly string[]}`
  - `{kind: "federation-rejected"; reason: "issuer" | "subject" | "audience" | "unknown"}`
  - `{kind: "reauthorization-required"; reason: "refused" | "custody-expired" | "custody-absent"}`
  - `{kind: "capability-not-admitted"}`: a requirement in a brokered namespace that the run's admitted `access` lacks
  - `{kind: "authority-changed"; changes: NonEmptyArray<{capability: string; change: "mode-changed" | "removed" | "newly-brokered"}>}`: the resume-slice drift check failed (AD-12); `scope` is the first change's capability name
- It is non-retriable. These change with it, in the same Phase 1 Task (Phase boundary rule): `FRAMEWORK_ERROR_KINDS`, the persisted zod schema, `formatFrameworkError`, `retriabilityOf`, and the host's `classifyFrameworkError` HTTP mapping in `domain/framework-error-http.ts` (grant-missing 403, unconfigured 503, federation-rejected 502, reauthorization-required 401, capability-not-admitted 403, authority-changed 409).
- A `reauthorization-required` node failure in a HITL run does not fail the run: the HITL executor's park predicate parks it (AD-13). A sync run cannot wait, so it fails with 401 `reauthorization-required`.
- **One acquisition-fault vocabulary, typed per path.** Every acquisition-path adapter (realm mint, Entra authority, unwired adapters, custody cell, establishment) returns its subset of `AcquisitionFaultOf<H, R>` (Component Design › Entra Agent Authority), replacing `AssertionFault`, `EntraAcquisitionFault`, `DelegationEstablishmentFault` and `delegation-not-established`'s free-standing reason list, so an unreachable state is unrepresentable; the closed `UnreachableCause` keeps response text and credentials out of error values (INV-3 for faults holds in the type).
- **Two total projections** in `domain/acquisition-fault.ts`, each `.exhaustive()` and applied in exactly one module (so neither is an owned invariant): `frameworkErrorOf` over `MintPathFault` (in `capability-authority.ts`) and `runAuthorityRefusalOf` → `delegation-not-established{reason}` (in `run-authority-lifecycle.ts`).
- **One classifier.** `classifyTokenEndpointError` (`domain/token-endpoint-error.ts`) is the only reading of a realm or Entra token-endpoint error response: pure, one table, property-tested once, imported by both HTTP adapters, overloaded by grant (`client_credentials` → `AppAcquisitionFault`; `on-behalf-of`, `refresh` → `DelegatedGrantFault`), so the app path cannot receive a re-authorization fault.
  - Realm `invalid_scope` gives `grant-missing`.
  - Realm `invalid_client` and other client-authentication 4xx give `unconfigured{why: rejected}`, a configuration fault that retrying cannot fix.
  - AADSTS 70021, 700211, 700212 and 700213 give `federation-rejected`.
  - AADSTS 65001 and 82014 on the on-behalf-of grant give `unconfigured{why: rejected}` (D8 b: missing admin consent of the blueprint's inheritable delegated permissions, a configuration fault); the code rows are matched before the error-string rows.
  - `invalid_grant`, `interaction_required` and `consent_required` on on-behalf-of or refresh give `reauthorization-required{refused}` (Conditional Access, sign-in frequency included, D8 d).
  - The Entra adapter, not the classifier, reads a 2xx on-behalf-of response: no `refresh_token` in it gives `unconfigured{keys: ["offline_access"], why: rejected}` (D8 a), so establishment fails with zero custody writes. A `refresh_token` in a refresh response is dropped unread (AD-6).
  - 429, 5xx and timeouts give `unreachable`.
  - The classifier copies only error codes, never response text, into the fault.
- Unwired legs now map to `authority-unconfigured`, no longer to the retriable `infra-unreachable`. Transient failures stay `infra-unreachable` and are not retried internally (NFR-021).

### AD-9: Approval is recorded with its decision in one write and lends no authority

**Choice:**
- **One atomic decision value (D7).** `resolvePending` writes the whole `HitlDecision` (action, `ApproverRef`, channel, decision time, Teams activity id) in its existing single `SET NX`, so an accepted decision never exists without its approver (FR-028). The framework `HumanAction.actor` carries only a display rendering; identity is never read back from it.
- **Every attempt is audited** (accepted | duplicate | not-pending | unauthorized) by `recordApproval`, after the write, classified by the pure `classifyDecisionAttempt`; a Teams redelivery of one activity is `duplicate`, a `canAccessDag` refusal `unauthorized`.
- **The acting principal is shown, computed once.** `executesAsOf(authority)` (the agent, or the initiator through delegation, per capability) is called at one site, `hitl/service.ts`'s private `runViewOf(record)`; its value is passed on, never re-derived: to the review notification the card and webhook renderers print, to `getRun`'s `RunView` (the `GET /runs/:runId` review block and the approve response), and to the accepted decision's audit record (AS-043). One call site, so no owned invariant (the AD-8 projections' precedent).
- **Approvals on the run record** are appended when the executor consumes the decision, in the same lease-fenced checkpoint write that advances the run. The Redis decision record and `RunRecord.approvals` are authoritative; the audit log is a projection. Mechanics: Component Design › HITL Authority Continuity.
- `ApproverRef` is one of `realm-user{realmSub, entra}`, `team{team}`, `admin` or `teams-user{aadObjectId: EntraObjectId}`. It and the decision and approval types are declared in `hitl/types.ts` (Phase 5), not in a contract types file, because approvals lend no authority (CT-5).
- One persisted initiator: `PersistedIdentity.user` gains `entra` in Phase 2 (with the live identity), and in the Phase 4 cut-over `RunRecord.authority` replaces `RunRecord.identity`; `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are then deleted. The record, stored and read, holds the bare `RunAuthority` (`parseRunAuthority` at the store); `boundAuthorityOf(record)` derives the `BoundAuthority` from `record.runId` where it is used (IN-6), so no record can pair two run ids. The executor rebuilds the broker only from that derivation, through `withRecordedAuthority`.
- The Teams approver is not an `AuthIdentity`: `TeamsApprover` (`domain/auth.ts`) carries no realm principal, so a card click is never given a fabricated `entra` and cannot start a run or be persisted as an initiator; a missing or malformed `from.aadObjectId` fails closed.

### AD-10: Doc truth is checked, not promised

**Choice** (FR-042, SC-009):
- `scripts/check-identity-docs.ts` (pure `lintIdentityDoc(path, text): readonly Problem[]`, with tests), beside `check-doc-links.ts` in `scripts/verify.sh`.
- Every issue #42 doc must contain a status matrix (Implemented, Configured, Deployed, Live-verified); `PENDING-LIVE-VERIFICATION` only next to a link to the runbook evidence template.
- A declared table of banned phrases with reasons fails the script (e.g. "as the user" outside a delegated-path line, `exchangeV2`/`subject_token` claims, a claim that a password change or reset revokes the delegated credential (D3), refresh-credential "rotation" in custody).

### AD-11: New ports live in `domain/port/` (flagged convention conflict)

**Choice:** New ports go in `packages/host/src/domain/port/` (`realm-assertion-mint.ts`, `entra-agent-authority.ts`, `delegated-custody-store.ts`), adapters in `adapters/`. Each has at least two implementations: HTTP and unwired for the mint and the Entra authority (the unwired null object, selected by leg state, is what makes `RealmAssertionMint` pass the deletion test; without it both mint callers would branch on the leg); Redis and an in-memory test fake for the store (D2: the seam that keeps the redeem decision and the lifecycle matrix free of a Redis server). The user-token verifier has one implementation and pass 1 reaches it only on a wired leg, so it is a plain adapter function over the JWKS transport, not a port.

### AD-12: A resume slice fails closed when the admitted authority drifted from the boot catalog (D5)

**Choice:**
- Every `RunAuthority` variant carries its admitted `access`, so every HITL run is checkable. `RunAccess.passThrough`: the names pass 1 classified `not-brokered`, a fact about this run, not a copy of a catalog fact (`accessOf` builds it; `parseRunAccess` refuses a name also in a map). The `unbrokered` variant carries `UnbrokeredAccess{passThrough}`: every requirement name, since a host without a realm issuer (`REALM_JWT_ISSUER` unset, today's `selectCapabilityBroker` gate) brokers none.
- The pure `checkAdmittedAuthority(access, now: BrokeringNow, requirements)` (`domain/run-authority.ts`, INV-2 sibling through `authorityOf`) classifies each current raw requirement under the boot brokering state (`brokered{catalog}`: `classifyCapability`; `unbrokered`: nothing classifies brokered) and compares it with its admission classification:
  - a name in a map that no longer classifies `brokered` → `removed`;
  - a name in a map whose `authorityOf` mode differs → `mode-changed`;
  - a name in `passThrough` (either access kind) that now classifies `brokered` or `unknown` → `newly-brokered`: an unbrokered run resumed by a now-brokered host fails for every requirement in a brokered namespace (FR-026);
  - a name in neither (the DAG was redeployed with a new requirement) is left to `routeRequirement`'s `refused-not-admitted`, unchanged.
  Changes are sorted by capability name.
- `withRecordedAuthority` runs it at every HITL slice start, unbrokered runs included, before `forRun` and any node; an `Err` builds no handle, and the executor fails the run `authority-unavailable{authority-changed}` (AD-8), so it ends through `endRun` and custody is released. Sync runs have one slice, admitted against the same boot state, so need no check.

### AD-13: Re-authorization parks the run at the node through a vendor-neutral framework seam (D6)

**Choice:**
- **Mechanism: a framework park seam.** `DagRunOpts.parkOn?: (error: FrameworkError) => boolean`, consulted by the DAG executor on a non-retriable node failure (transitions stay pure): true → `node-parked` instead of `node-failed` and the halted phase `parked`, resumed like `retrying` so only the parked node and unfinished siblings re-run; sync `runDag` maps it to `err`; without `parkOn` nothing parks (semantics: File Structure › Framework; one Phase 1 Task with every exhaustive consumer). ADR 0096 records it.
- **Host state.** Only the HITL executor passes `parkOn: isReauthorizationRequired`. `RunStatus` gains `awaiting-reauthorization{nodeId, reason}` (lease-fenced settle) and `reauthorized{nodeId}` (the unleased `markReauthorized` compare-and-set on the meta key, writing the re-established authority with it); a parked run keeps custody (no `endRun`). Both states are LC-2's, the framework `parked` phase LC-3's. The host has no per-person channel, so the re-authorization-required notice goes once per park to the run's owner-team notification channel over the existing renderers, and `GET /runs/:runId` shows the awaiting state, what to present and until when, neither with credential material (S2, the user's decision at loop-back 12).
- **Endpoint.** `POST /runs/:runId/delegation` → `reauthorizeRun`: the same verification and binding as run start (pass 1's expectation builder through `planReauthorization`, then the verifier and pass 2 unchanged), the recorded initiator's `oid` and `tid` required, a fresh on-behalf-of exchange, custody re-established through the lifecycle under a fresh window `custodyExpiryFor(now, max, runDeadlineMs)`, then re-enqueue. Any other presentation is refused with a typed error, audited, and leaves the run parked. Mechanics: Component Design › HITL Authority Continuity and › Delegated Custody.
- **A fresh custody window, never a later deadline** (the user's decision on the loop-back 11 report). A re-authorization is fresh consent: the re-established expiry is ≤ now + max and ≤ the run deadline, which never changes. A run parked `custody-expired` is therefore re-authorizable; only a refused presentation, or under one second of the run deadline left (`reauthorization-window-closed`), keeps it parked. A record evicted while awaiting is released by the stale wake's `endRun(record-evicted)`.
- **Sync runs** cannot suspend: `reauthorization-required` fails them with 401 (the typed re-authorization-required error); neither kind ever falls back to `app`, and FR-027 and AS-041 apply to HITL runs only (S1, the user's decision at loop-back 12).

---

## File Structure

Each entry says what the file holds and, where it is not the file's group default, in which Phase. Behaviour is specified once, in Component Design; test-file entries are the canonical list of per-file test obligations.

### Framework: taxonomy and inventory export

```
packages/framework/src/types/errors.ts — authority-unavailable kind + AuthorityUnavailableCause union (AD-8, authority-changed included), FRAMEWORK_ERROR_KINDS, persisted zod schema, formatFrameworkError, retriabilityOf (non-retriable)
packages/framework/src/index.ts — export runtimeNodeInventory (barrel); export the parked outcome and the parkOn option type
packages/framework/src/__tests__/authority-unavailable-error.test.ts — kinds list; persisted round-trip through the zod schema; retriability; formatting; property test: every cause round-trips and formatted text never contains an injected sentinel or a credential field
packages/framework/src/dag-runtime/types.ts — park seam (AD-13): DagPhase parked{wave, nodeId, error}; DagEvent node-parked{nodeId, error, partialOutputs?, coFailedNodeIds?}; the persisted checkpoint schema gains both
packages/framework/src/dag-runtime/transition.ts — the LC-3 machine (the existing DAG phase reducer): node-parked: running | retrying → parked (partial outputs merged, retry count unchanged); resume from parked re-enters the wave as retrying does, with no delay; dag-transition-property.test.ts gains exactly the LC-3 parked rows
packages/framework/src/dag-runtime/machine.ts — isHalted covers parked with suspended
packages/framework/src/dag-runtime/run-dag-stateful.ts — DagRunOpts.parkOn?: (error: FrameworkError) => boolean, forwarded to the executor; StatefulOutcome gains parked{nodeId, error}
packages/framework/src/dag-runtime/executor.ts, dag-runtime/wave-execution.ts — on a non-retriable node failure, parkOn(error) true → node-parked instead of node-failed (the only consultation; transitions stay pure)
packages/framework/src/executor/run-dag.ts — WorkerJobOutcome gains parked; sync runDag maps parked to err(error)
packages/framework/src/__tests__/dag-park-seam.test.ts — no parkOn: a failure is terminal exactly as before (regression); parkOn true: node-parked recorded, phase parked, siblings' partial outputs kept, retry count unchanged, resume re-runs only the parked node and unfinished siblings; parkOn false: node-failed; persisted round-trip of parked; sync runDag returns err for a parked run; property: for any failing wave, parked then resumed with a now-succeeding node ends succeeded with every completed sibling run exactly once
```

### Host: contracts (declarations only, frozen)

```
packages/host/src/domain/run-authority-contract.ts — CT-1 types: EntraObjectId, EntraTenantId, EntraClientId brands, EpochMs and DurationMs brands (instants vs durations; every identity-subsystem clock is () => EpochMs), EntraPrincipal, Initiator, AuthorityMode, RawCapabilityRequirement, CapabilityRequirement (over the catalog-minted CapabilityScope), RequirementRef, DelegatedHeader, DelegatedTokenExpectation, AdmissionStep, VerifyDelegatedStep, DelegatedPresentation, VerifiedEntraClaims, VerifiedDelegationGrant, RedactedSecret, AdmittedCapability, AccessEntry, NonEmptyReadonlyMap, RunAccess, AppAccess, DelegatingAccess, UnbrokeredAccess, AdmittedAccess, BrokeringNow, RequirementRoute, RunAuthority, BrokeredRunAuthority, UserDelegatedAuthority, RunAuthorityPlan, PendingPlan, AdmittedRun, BoundAuthority, DelegatedTokenInvalidReason (client and scope included), RunAuthorityRefusal and its subsets (PlanRefusal, ClaimRefusal, BindingRefusal, PresentationRefusal, AdmissionRefusal, EstablishmentRefusal, ReauthorizationRefusal), AuthorityChange, AuthorityChanged, ReauthorizationPlan, ExecutesAs, PlanRunAuthorityFn (pass 1), AdmitDelegatedPresentationFn (pass 2), BindDelegatedPrincipalFn, ValidateEntraUserTokenClaimsFn, IssuerForFn, VerifyEntraUserTokenFn, OriginOfFn, RouteRequirementFn, CheckAdmittedAuthorityFn, PlanReauthorizationFn, ExecutesAsOfFn
packages/host/src/domain/capability-authority-contract.ts — CT-2 types: EntraIdentityRef, FederationGrant, FederatedAssertion, Hop, ReauthorizationReason, UnreachableCause, AcquisitionFaultOf<H, R> with AppAcquisitionFault, DelegatedGrantFault, EstablishmentFault and AcquisitionFault, MintPathFault, TokenEndpointErrorResponse (by grant), AcquiredCredential, RunMintingAuthority, CapabilityAuthority (forRun), CreateCapabilityAuthorityFn, InspectFederatedAssertionFn, ClassifyTokenEndpointErrorFn, FrameworkErrorOfFn, RunAuthorityRefusalOfFn
packages/host/src/domain/delegated-custody-contract.ts — CT-3 types: CustodySeconds brand, CustodyBinding, SealedRefreshCredential, CustodyState, CustodySuccessor, SuccessorOf, CustodyEvent, CustodyTransitionFault, HeldCustody, RedeemContext, RedeemProgress, RedeemOutcomeOf, RedeemAwaiting, RedeemStep, AuthorizedRun, SyncRunEnding, HitlRunEnding, RunBracketEnding, CustodyReleaseCause, CustodyReleaseOutcome, EstablishForRecordFailure, RunAuthorityLifecycle, EstablishDelegationFn, ReestablishDelegationFn, TransitionCustodyFn, EstablishFaultOfFn, BeginRedeemFn, DecideRedeemStepFn, CustodyBindingOfFn, CustodyTtlSecOfFn, ReleaseCauseOfFn, CreateRunAuthorityLifecycleFn
packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts — CT-1 acceptance (real verifier over an in-process JWKS)
packages/host/src/__tests__/acceptance/run-authority-admission-budget.acceptance.test.ts — CT-1 acceptance: run-start validation p95 budget (AS-036; NFR-003, SC-011), same path as the CT-1 file
packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts — CT-2 acceptance, for each identity model
packages/host/src/__tests__/acceptance/capability-authority-budget.acceptance.test.ts — CT-2 acceptance: host-added acquisition and cache-hit p95 budgets (AS-035; NFR-002, SC-011), same path as the CT-2 file
packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts — CT-3 acceptance
packages/host/src/__tests__/acceptance/run-reauthorization.acceptance.test.ts — CT-3 acceptance: park, notify (rendered by both production notifiers), re-authorize and resume at the node; a sync run fails 401; refused presentations; the window never extended (AS-034, AS-041, FR-027)
packages/host/src/__tests__/acceptance/authority-drift.acceptance.test.ts — CT-6 acceptance (Phase 4): a resume slice after a catalog or brokering change fails before any node runs, unbrokered runs included (AS-042, FR-026); a re-registered DAG cannot widen a resumed run (NFR-010)
packages/host/src/__tests__/acceptance/user-run-attribution.acceptance.test.ts — CT-4 acceptance (AS-006, FR-004, FR-020)
packages/host/src/__tests__/acceptance/hitl-decision-record.acceptance.test.ts — CT-5 acceptance (AS-043, FR-028)
packages/host/src/__tests__/acceptance/support/identity-fakes.ts — fakes at the network, storage and clock edges only: zero-latency realm-token, Entra-token, Entra-JWKS and Graph transports (an IdentityTransports value) with request capture, a JWKS signer for realm and Entra user tokens, a fake realm signature verifier (markSignatureVerified claims), setSystemTime clock control, an in-process UDS transport into the worker app, an in-memory RedisPort and HitlRedisPort with SharedInfra (custody runs through the production Redis store over it, D2), an in-process QueueBackend delivering to the started worker, a recording Bot Framework connector (BotConnectorPort) and webhook transport (WebhookHttp) under the production notifiers, capturing each rendered activity and card body, a fake VerifyBotToken, a capturing audit sink, logger and tracer. NO fake realm mint, Entra authority, verifier, cipher, custody store or capability authority: those come from composeRunAuthorityWiring
packages/host/src/__tests__/acceptance/support/latency-budget.ts — budget harness: warm-up, sample loop, nearest-rank p95 (test support)
packages/host/src/__tests__/acceptance/support/credential-sentinel.ts — FR-022 scan support for every contract's acceptance (Phase 3, with CT-2): CredentialSentinels, one distinctive value per credential kind (inbound realm and Entra user JWTs, realm assertion, T1, Entra app access token, on-behalf-of access token, refresh token, redeem-returned refresh token, re-authorization realm and Entra user tokens), wired into the fakes; CapturedSurfaces, a closed record of ten surfaces (logs, audit, spans, httpResponses, errors, handles, origins, runRecords, custodyAtRest, notifications: what the notifier transports received) filled only from the capturing sinks and transports, proxyToWorker's responses, the path's errors, handles and authority/origin values, the in-memory HitlRedisPort and the custody keyspace; assertNoCredentialMaterial renders each value with JSON.stringify, String() and Bun.inspect and fails on any sentinel, its base64, base64url or hex encoding, or any JWT segment of 16+ characters; assertCustodyCiphertextOnly also requires every custody record to be a SealedRefreshCredential opening only under the deployment keyring with its own binding as AAD
```

### Host: capability catalog (authority mode source)

```
packages/host/src/domain/capability-catalog.ts — Component Design › Capability Catalog; absorbs capability-scope.ts; no module-load parse; brokeredNamespacesOf (Phase 1, classifyCapability's own namespace rule); admittedCapabilityOf (Phase 2)
packages/host/src/domain/capability-scope.ts, domain/__tests__/capability-scope.test.ts — DELETED in the Phase 4 legacy deletion (Phase 1 re-derives its exports from the catalog)
packages/host/src/__tests__/boot-capability-catalog.test.ts — AS-009, FR-005 (boot face), SC-013: createHost with HostDeps.capabilityCatalog = a data catalog whose entry lacks `authority` (and one with an unknown mode) returns Err capability-catalog-invalid naming the capability, with no capability connected, no router built and no server bound; createHost with no override boots (the code catalog passes the same parser)
packages/host/src/domain/capability-gate.ts — decideGate(catalog, capability, assigned, dynamicsOrgHost) → pass-through | unknown{capability} | refused{scope, reason} | gated{scope, audience} via classifyCapability: the legacy gate, deleted with it (Phase 4); gateAdmitted(capability: AdmittedCapability, assigned, dynamicsOrgHost) → refused{capability, reason} | gated{audience} (Phase 3): the mint path's gate, classifying nothing
packages/host/src/domain/capability-registry.ts — registry augmentation derived from catalog keys
packages/host/src/domain/__tests__/capability-catalog.test.ts — parse faults name the capability; loadCapabilityCatalog maps faults to capability-catalog-invalid; FR-005 (compile face): @ts-expect-error type tests for a CAPABILITY_CATALOG entry missing authority, and one with a mode outside app | delegated
packages/host/src/domain/__tests__/capability-catalog.property.test.ts — parse(serialize(c)) = c; any entry lacking or with an unknown authority is refused; classifyCapability over generated catalogs and names: brokered iff a key, unknown iff in brokeredNamespacesOf(catalog) without the key, not-brokered otherwise; authorityOf(scope) equals the parsed entry's mode for every minted scope
packages/host/src/domain/__tests__/capability-gate.test.ts — rewritten for the catalog signature: pass-through, unknown, refused, gated; gateAdmitted refused and gated (Phase 3); the decideGate cases go with it in the legacy deletion
packages/host/src/__tests__/authority-mode.matrix.test.ts — INV-2 matrix (owner + every sibling)
```

### Host: identity topology configuration

```
packages/host/src/domain/config.ts — ENTRA_IDENTITY_MODEL, ENTRA_BLUEPRINT_CLIENT_ID, ENTRA_AGENT_IDENTITIES, DELEGATED_CUSTODY_KEYS (keyring shape validated), DELEGATED_CLIENT_APPS (comma-separated GUIDs, non-empty when set) and DELEGATED_SCOPE (one scope token), no defaults (D4); REDIS_URL stays required (L174; custody depends on it, D2); DELEGATED_CUSTODY_MAX_SEC (z.coerce.number().int().positive().optional(); any other value fails loadConfig naming the key); ENTRA_CLIENT_ID removed (refused by name) with the ENTRA_TENANT_ID/ENTRA_CLIENT_ID paired-field refusal
packages/host/src/domain/authority-legs.ts — Component Design › Identity Topology: planAuthorityLegs, EntraDirectory, EntraLeg with DelegationLeg nested in its wired variant ({keys, maxSec, clients, scope}; DEFAULT_DELEGATED_CUSTODY_MAX_SEC = 604800), DelegatingEntraLeg, delegationOf, delegatedAudienceFor (INV-5 owner), unwiredLegsWarning
packages/host/src/domain/__tests__/authority-legs.test.ts — rewritten: every seeded misconfiguration names its offender; custody max: unset with default HITL_RUN_TTL_SEC → 604800, unset with HITL_RUN_TTL_SEC=86400 → 86400, 3600 → 3600, equal to HITL_RUN_TTL_SEC accepted, HITL_RUN_TTL_SEC + 1 → custody-max-exceeds-run-ttl{maxSec, runTtlSec}
packages/host/src/domain/__tests__/authority-legs.property.test.ts — total over key-presence combinations, per Component Design › Identity Topology's gating: dark legs and their warnings and missing keys, wired iff complete and consistent, else faults naming every offender (not the first); ENTRA_CLIENT_ID always refused; delegationOf delegating iff both legs wired, else naming the missing keys; a wired leg's clients non-empty and scope the configured one, never a default; wired maxSec a positive integer ≤ HITL_RUN_TTL_SEC
packages/host/src/domain/__tests__/config-security.test.ts — loadConfig end to end with env fixtures; custody key shape (32 bytes, active ∈ keys); DELEGATED_CUSTODY_MAX_SEC "0", "-1", "1.5", "", "7d" each fail loadConfig naming the key; unset loads as undefined; DELEGATED_CLIENT_APPS "", "not-a-guid", "a,,b" and DELEGATED_SCOPE "" or "a b" each fail loadConfig naming the key
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
packages/host/src/domain/__tests__/token-endpoint-error.property.test.ts — total over (hop × grant × status × error × AADSTS codes); 429/5xx → unreachable{cause: status} for every hop and grant; the AD-8 classification table row by row (AADSTS 65001 and 82014 on on-behalf-of → unconfigured{rejected} whatever the error string, D8 b); a client_credentials response never classifies to reauthorization-required; no input text reaches the fault
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
packages/host/src/adapters/__tests__/entra-token-endpoint.test.ts — no client_secret/certificate ever (FR-012); every non-2xx handed to the classifier; a 2xx on-behalf-of response without refresh_token → unconfigured{keys: ["offline_access"], why: rejected} (D8 a); a refresh_token in a 2xx refresh response never reaches the result (D1)
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
packages/host/src/domain/run-authority.ts — planRunAuthority (pass 1), admitDelegatedPresentation (pass 2), bindDelegatedPrincipal, requirementsOf (raw inventory), originOf (the only RunAuthority → InvocationOrigin derivation); the run's access, built and read only here: accessOf (pass 1, passThrough included), parseRunAccess (the run-store boundary), routeRequirement (the mint path's routing), checkAdmittedAuthority (AD-12, Phase 2); bindAdmission (a decided plan's BoundAuthority); parseRunAuthority (the run store's parser of the bare authority) and boundAuthorityOf(record) (the record path's BoundAuthority, IN-6); planReauthorization (AD-13, Phase 2; the same expectation builder as pass 1); executesAsOf (AD-9, Phase 2)
packages/host/src/domain/jwt-validation.ts — entra_oid / entra_tid become required parsed claims; parseEntraObjectId(raw: unknown): Result<EntraObjectId, "entra-object-id-invalid">, the one EntraObjectId parser (a GUID; realm claims, bot handler, run store)
packages/host/src/domain/auth.ts — AuthenticatedUser.entra and AuthIdentity.user.entra required (Phase 2); TeamsApprover {kind: "teams-approver"; aadObjectId: EntraObjectId; canRunDag} and canAccessDag(AuthIdentity | TeamsApprover) (Phase 2); SubjectToken + markSubjectToken removed (Phase 1); agentClientIdFromFrameworkOrigin removed with its legacy callers (Phase 4 legacy deletion)
packages/host/src/domain/run-context.ts — subjectTokenForIdentity removed (Phase 1); origin no longer derived here once originOf exists (Phase 4 cut-over)
packages/host/src/http/middleware/auth.ts — user identity carries entra principal; no subject-token branding
packages/host/src/http/authenticate-identity.ts — same
packages/host/src/domain/__tests__/entra-user-token.test.ts — each refusal reason (client: azp outside the allowlist or absent; scope: scp lacking the configured scope, which is matched as a whole space-separated token, never a substring); issuerFor is the one issuer derivation; property: claims validation accepts iff all constraints hold, and the first failing check in the AD-7 order is the reason; no refusal value contains a claim value
packages/host/src/domain/__tests__/run-authority.property.test.ts — pass 1 totality over (identity × requirements × header × legs); the pure composition (pass 2 over every generated presentation; no fakes) preserves the full precedence, capability-unknown first; each refusal variant; verify-delegated only with a wired directory, a mapped agent, delegatedAudienceFor's audience and no unknown capability; accessOf keys every brokered requirement by name under authorityOf's mode, delegating exactly on a pending plan, passThrough exactly the not-brokered names, disjoint from both maps; an unbrokered plan's UnbrokeredAccess.passThrough is every requirement name; parseRunAccess(serialize(a)) = a, refusing a duplicate name (in or across maps) and an empty delegated map; parseRunAuthority(serialize(a)) = a, refusing agent or user-app over delegating access, user-delegated over app access, unbrokered over any RunAccess (and a brokered kind over UnbrokeredAccess), a custody expiry beyond runDeadlineMs and a duplicate name; boundAuthorityOf(record).runId = record.runId; routeRequirement: app or delegated exactly for a name in access (never delegated over app access), refused-not-admitted exactly for a brokered-namespace name outside it, pass-through otherwise; the grant's token is the step's; bindAdmission binds the admitted run id, pending exactly for a pending plan; binding iff oid ∧ tid equal; originOf agrees with agent and initiator; checkAdmittedAuthority over generated (brokering then, BrokeringNow, requirements; both unbrokered and every brokered kind): Ok iff every requirement classifies as at admission, each change kind exactly in its AD-12 case (an unbrokered run under brokered{catalog}: newly-brokered exactly for its brokered-namespace names; a brokered run under unbrokered: removed for every map name), a name in neither access nor passThrough never reported, changes sorted and non-empty; planReauthorization refuses each static case with zero verifier calls (non-user identity, oid or tid unequal to the recorded initiator's, dark leg, absent or malformed header, under one second of the run deadline left), else yields the verify step with pass 1's expectation for the recorded agent; executesAsOf names the agent for every app-mode capability and the initiator exactly for the delegated ones
packages/host/src/adapters/__tests__/entra-user-token-verifier.test.ts — signature, alg allowlist (RS256 only), key rotation via lazyJwks over an in-process JWKS transport; takes only a verify-delegated step; signature-verified carries claims only
packages/host/src/__tests__/middleware/auth.test.ts — realm JWT without entra claims → 401 naming the claims
```

**Export bindings:**
- `packages/host/src/domain/run-authority.ts` — CT-1: planRunAuthority: PlanRunAuthorityFn, admitDelegatedPresentation: AdmitDelegatedPresentationFn, bindDelegatedPrincipal: BindDelegatedPrincipalFn, originOf: OriginOfFn, routeRequirement: RouteRequirementFn, checkAdmittedAuthority: CheckAdmittedAuthorityFn, planReauthorization: PlanReauthorizationFn, executesAsOf: ExecutesAsOfFn
- `packages/host/src/domain/entra-user-token.ts` — CT-1: validateEntraUserTokenClaims: ValidateEntraUserTokenClaimsFn, issuerFor: IssuerForFn
- `packages/host/src/adapters/entra-user-token-verifier.ts` — CT-1: verifyEntraUserToken: VerifyEntraUserTokenFn

### Host: delegated custody

All behaviour: Component Design › Delegated Custody and LC-1.

```
packages/host/src/domain/delegated-custody.ts — LC-1 machine (transitionCustody), renewedAuthority (INV-8 owner), establishFaultOf, beginRedeem, decideRedeemStep, custodyBindingOf, parseCustodySeconds, custodySecondsToMs, custodyExpiryFor, custodyTtlSecOf, canonical AAD encoding, reauthorizationReasonOf
packages/host/src/domain/__tests__/delegated-custody.property.test.ts — exactly the LC-1 (state, event) pairs are accepted; every LC-1 guard (establish: expiry ≤ now, TTL < 1 s, beyond now + cap; reestablish: the same three over its fresh binding); refuse drops the sealed bytes; the successor type follows the event (@ts-expect-error: establish's successor is never revoked); establishFaultOf row by row (past-expiry → unreachable{entra, timeout}; cap-exceeded, undeclared → custody-defect); only reestablish leaves revoked, only establish and reestablish leave absent; no caller-chosen expiry in any state; custodyTtlSecOf = ⌊(expiry − now) / 1000⌋, never beyond the remaining window; reauthorizationReasonOf per LC-1; custodyExpiryFor ≤ both bounds; parseCustodySeconds bounds
packages/host/src/domain/__tests__/decide-redeem-step.property.test.ts — the outcome table row by row, with no fakes (@ts-expect-error: an outcome of another progress does not compile): every path finishes within four steps; expired at begin performs no effect; a store read fault only ever finishes unreachable{custody-store}; refused never grants and its only write is the revoke; held → open → redeem is the only granting path; no step ever writes a credential
packages/host/src/domain/port/delegated-custody-store.ts — the DelegatedCustodyStore port
packages/host/src/adapters/custody-cipher.ts — AES-256-GCM seal/open via WebCrypto; kid rotation; AAD mismatch → open fails
packages/host/src/adapters/delegated-custody-store-redis.ts — the production store for sync and HITL runs (D2): put = setNx, replace = set, revoke = get then setIfValue on the raw value read (no Lua: the tenant ACL denies eval, ADR-0067), delete = del; whole-second TTLs (RedisPort set/setNx take seconds); over the RedisPort requireHitlRedisPort narrows at boot
packages/host/src/__tests__/fixtures/delegated-custody-store-fake.ts — in-memory test fake with the same semantics, ciphertext only; MOVED from adapters/delegated-custody-store-memory.ts, never composed in production (D2)
packages/host/src/adapters/run-custody-cell.ts — createRunCustodyCell(deps, bound): the stateless sequencer; holds only get and revoke; created only inside forRun
packages/host/src/adapters/delegation-establishment.ts — establishDelegation (AD-6; holds only put) and reestablishDelegation (AD-13; holds only get and replace; INV-8 sibling: builds bound' only through renewedAuthority)
packages/host/src/adapters/run-authority-lifecycle.ts — INV-4, INV-6 and INV-7 owner (Component Design › Delegated Custody): AuthorizedRun's private constructor and mintingAuthorityOf; applies runAuthorityRefusalOf; logs a failed delete (runId, cause, error kind) and an establishment custody-defect at error; never throws on its own account
packages/host/src/domain/custody-release.ts — releaseCauseOf, pure
packages/host/src/domain/__tests__/custody-release.property.test.ts — total over RunBracketEnding; sync-rejected and sync-settled{failed} give the same cause; abandonment keeps its path and step; every CustodyReleaseCause is produced; @ts-expect-error: no sync persist abandonment
packages/host/src/adapters/__tests__/custody-cipher.test.ts — round-trip; tampered AAD (any field)/ciphertext/kid refused; plaintext never in stored bytes
packages/host/src/adapters/__tests__/delegated-custody-store-redis.test.ts — (test-redis) key under the tenant prefix from binding.runId; TTL = custodyTtlSecOf(binding expiry) ≤ HITL_RUN_TTL_SEC (idle-eviction cover); purgeTenantKeyspace reclaims it (tenant-purge cover); put never overwrites; replace sets the TTL of the new binding's expiry; revoke never creates nor overwrites a record replaced after its read; delete idempotent; one shared case table also runs against the test fake
packages/host/src/adapters/__tests__/run-custody-cell.test.ts — exactly decideRedeemStep's effects, in order, over the store fake and a fake Entra transport; concurrent redeems read the same write-once record and stored bytes never change; a refused redeem revokes once, and a later redeem fails refused with zero Entra calls
packages/host/src/adapters/__tests__/delegation-establishment.test.ts — failure → typed EstablishmentFault, zero app fallback; the authority carries no run id; the record carries no binding and opens only with custodyBindingOf(bound) as AAD; the LC-1 guard precedes every put; an on-behalf-of exchange completing at or after the run deadline (the fake transport advances the clock) → unreachable{entra, timeout}, zero put; cap-exceeded and undeclared are unreachable through it (one clock read after the exchange); reestablishDelegation: a fresh on-behalf-of, LC-1 reestablish before replace, the re-established expiry = custodyExpiryFor(t, max, runDeadlineMs) (fresh, runDeadlineMs unchanged), a failed exchange leaves the record untouched
packages/host/src/__tests__/custody-release.matrix.test.ts — INV-4 matrix (owner + every sibling; rows in the INV-4 Statement)
packages/host/src/__tests__/minting-handle.matrix.test.ts — INV-6 matrix
packages/host/src/__tests__/custody-reestablishment.matrix.test.ts — INV-7 matrix
packages/host/src/__tests__/run-deadline.matrix.test.ts — INV-8 matrix
```

**Export bindings:**
- `packages/host/src/domain/delegated-custody.ts` — CT-3: transitionCustody: TransitionCustodyFn, establishFaultOf: EstablishFaultOfFn, beginRedeem: BeginRedeemFn, decideRedeemStep: DecideRedeemStepFn, custodyBindingOf: CustodyBindingOfFn, custodyTtlSecOf: CustodyTtlSecOfFn
- `packages/host/src/domain/custody-release.ts` — CT-3: releaseCauseOf: ReleaseCauseOfFn
- `packages/host/src/adapters/delegation-establishment.ts` — CT-3: establishDelegation: EstablishDelegationFn, reestablishDelegation: ReestablishDelegationFn
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
packages/host/src/adapters/__tests__/capability-authority.property.test.ts — under fast-check scheduled interleavings: no credential served across (identity, mode, oid), single-flight per cell key (NFR-012); for N delegated capabilities in one run every redeem presents the same write-once credential, the custody record stays byte-identical, and no redeem-returned refresh credential reaches the store
packages/host/src/adapters/__tests__/keycloak-broker.test.ts — DELETED in the Phase 4 legacy deletion (superseded)
packages/host/src/adapters/__tests__/broker-audit.test.ts — new fields; no credential fields
```

**Export bindings:**
- `packages/host/src/adapters/capability-authority.ts` — CT-2: createCapabilityAuthority: CreateCapabilityAuthorityFn

### Host: run authority composition (one wiring for route, HITL engine and executor)

```
packages/host/src/adapters/run-authority-admission.ts — createRunAuthorityAdmission({ catalog, legs, jwks }) → admitRunAuthority: requirementsOf → planRunAuthority → only on verify-delegated: verifyEntraUserToken (statically imported) → admitDelegatedPresentation → the AdmittedRun; no establishment (that is the lifecycle's)
packages/host/src/adapters/run-authority-wiring.ts — composeRunAuthorityWiring, RunAuthorityWiring (with the composed re-authorization verifier, AD-13, the BrokeringNow it hands the lifecycle and admission, and delegatedAudience for the HITL service, INV-5 sibling), IdentityTransports (Component Design › Run Admission, "One wiring"); custody always over the Redis store (D2)
packages/host/src/adapters/run-composition.ts — createRunContextFactory, createDagExecutor, composeHitlRunService, HitlWiringArgs and their helpers (createHitlExecutor, syncRunOptions): moved unchanged from host.ts (Phase 3 extraction), signatures changed in the Phase 4 cut-over; imports no boot code; INV-6 sibling (createDagExecutor mints only through mintingAuthorityOf over the bracket's AuthorizedRun)
packages/host/src/adapters/__tests__/run-composition.test.ts — without createHost: createDagExecutor mints through the bracket's handle when brokered, with no broker when unbrokered; composeHitlRunService's executor makes one withRecordedAuthority per slice with boundAuthorityOf(record)
packages/host/src/adapters/__tests__/run-authority-admission.test.ts — precedence through the composition, capability-unknown first; zero JWKS requests for every statically refusable token-carrying submission (fast-check); non-delegated plans pass through unchanged
packages/host/src/adapters/__tests__/run-authority-lifecycle.test.ts — every behaviour in the RunAuthorityLifecycle interface comments; non-delegated plan → identity establishment, release still issued; failing delete → release-failed, one log, nothing thrown; one handle per brokered bracket (forRun counted, over its BoundAuthority), none unbrokered; mintingAuthorityOf undefined exactly for an unbrokered run; establishment custody-defect → 500 refusal and one error log; authority-changed before forRun on drift; reauthorize: Ok under a fresh expiry ≤ the run deadline, every Err leaves the record as it was
packages/host/src/adapters/__tests__/run-authority-wiring.test.ts — adapters selected per EntraDirectory variant (agent-id, app-registration, unwired); partial Entra config → unwired adapters; always the Redis custody store over the injected RedisPort (D2); a non-delegating leg → unwired establishment (unconfigured{absent}, zero egress and custody writes) and every delegated run refused naming each unset delegation key; a configured leg without ENTRA_IDENTITY_MODEL (AS-033) or with an unmapped agent client (AS-013) → Err naming the offenders; faults returned, never thrown
packages/host/src/__tests__/delegated-audience.matrix.test.ts — INV-5 matrix (owner + every sibling)
```

### Host: HITL persistence and approver

Behaviour: Component Design › HITL Authority Continuity and AD-9.

```
packages/host/src/hitl/types.ts — PersistedIdentity.user gains entra (Phase 2); RunRecord.authority: RunAuthority (bare, stored and read; IN-6) replaces identity, PersistedIdentity deleted (Phase 4 cut-over); the decision and approval types and RunRecord.approvals (Phase 5 approvals Task; RunMetadata omits approvals); RunStatus, RunStatusUpdate and transitionRunStatus move out to hitl/run-status.ts (LC-2 Task)
packages/host/src/hitl/run-status.ts — NEW (LC-2 Task): the LC-2 machine: RunStatus (the two new variants included), RunStatusUpdate, transitionRunStatus, moved from hitl/types.ts with every importer updated
packages/host/src/hitl/__tests__/run-status.property.test.ts — NEW (LC-2 Task): exactly the LC-2 (state, update) pairs are accepted, every other is Err; terminal writes idempotent only when equal; no entry into reauthorized but from awaiting-reauthorization
packages/host/src/hitl/decision.ts — NEW (Phase 5 approvals Task): classifyDecisionAttempt, authorizeApproval, approverDisplayOf, pure
packages/host/src/hitl/__tests__/decision.property.test.ts — classifyDecisionAttempt total: accepted iff the write won; duplicate iff the stored decision is the same click (equal teamsActivityId, or equal HTTP approver and action); not-pending otherwise; authorizeApproval agrees with canAccessDag; approverDisplayOf never renders an object id it was not given
packages/host/src/hitl/ports.ts — RunExecutionRequest.authority: BoundAuthority (boundAuthorityOf(record)) replaces identity (Phase 4 cut-over); resolvePending and getDecision over HitlDecision (Phase 5 approvals Task); RunExecOutcome awaiting-reauthorization, the notifier port over RunNotification, RunStorePort.markReauthorized (Phase 5 re-authorization Task)
packages/host/src/hitl/identity.ts — approverTeamIdentity returns TeamsApprover | undefined; toPersistedIdentity / toExecIdentity carry entra (Phase 2), then are deleted (Phase 4 cut-over); approver mapping to ApproverRef (Phase 5)
packages/host/src/hitl/service.ts — INV-4 sibling: startRun(admitted, input) with one establishForRecord, newRunId removed, processRun's fold and one endRun (Phase 4 cut-over); recordApproval replaces recordDecision, runViewOf (the only executesAsOf call) and getRun's RunView (Phase 5 approvals Task); INV-7 sibling: reauthorizeRun, runAuthority's "reauthorize"; INV-5 sibling: the awaiting view's audience from delegatedAudience; the parked-settle notification, processRun ignoring awaiting-reauthorization (Phase 5 re-authorization Task)
packages/host/src/hitl/human-review-hook.ts — consumes HitlDecision; actor = approverDisplayOf(approver) (Phase 5 approvals Task)
packages/host/src/hitl/run-store-job.ts — DagPhaseParserMap gains parked (Phase 1 park seam Task); the ApprovalRecord staged on human-responded and written in the checkpoint envelope (Phase 5 approvals Task)
packages/host/src/hitl/adapters/decision-store.ts — the whole HitlDecision in one SET NX; already-resolved returns the parsed stored decision (Phase 5 approvals Task)
packages/host/src/hitl/adapters/run-store.ts — user identity entra required (Phase 2); authority in place of identity, stored and read bare through parseRunAuthority (Phase 4 cut-over); approvals parsed from the checkpoint envelope, not cast, a teams-user id through parseEntraObjectId (Phase 5 approvals Task); the two new statuses (LC-2 Task); INV-8 sibling: markReauthorized = setIfValue on the meta key guarded on the record read, writing the re-established authority only when its runDeadlineMs equals the record read's (else Err, nothing written) (Phase 5 re-authorization Task); a record failing any of these is corrupt (pre-release, no shim)
packages/host/src/hitl/adapters/run-executor.ts — INV-6 sibling: broker → runAuthority, one withRecordedAuthority(boundAuthorityOf(record), …) per slice, minting through mintingAuthorityOf, authority-changed settles failed (Phase 4 cut-over); toSettledOutcome exhaustive, parked → failed (Phase 1 park seam Task), then parkOn and parked → awaiting-reauthorization (Phase 5 re-authorization Task); no subject-token bind
packages/host/src/hitl/adapters/bot/notifier.ts, hitl/adapters/webhook-notifier.ts — createBotFrameworkNotifier and createWebhookNotifier (runtime seams of CT-3 and CT-5) render RunNotification, printing the values handed to them and deriving none: executesAs on the review card (Phase 5 approvals Task); the reauthorization-required notice from its ReauthorizationView (Phase 5 re-authorization Task); no credential material
packages/host/src/http/handlers/runs.ts — createApproveRunHandler derives ApproverRef and calls recordApproval; GET /runs/:runId prints getRun's RunView: the review block with executesAs, and (INV-5 sibling) the awaiting block (reason, audience, header name, endpoint, reauthorizableUntilMs = the run deadline); INV-7 sibling: createReauthorizeRunHandler, the only route into reauthorizeRun (Phase 5 re-authorization Task); refusals via errorResponse
packages/host/src/http/router.ts — POST /runs/:runId/delegation (Phase 5 re-authorization Task)
packages/host/src/hitl/adapters/bot/messages-handler.ts — handleBotActivity parses from.aadObjectId (malformed: unknown approver) and authorizes the TeamsApprover (Phase 2); derives teams-user{aadObjectId} and passes the activity id (Phase 5)
packages/host/src/hitl/__tests__/identity.test.ts — approverTeamIdentity returns a teams-approver with no realm principal; user round-trip carries entra (Phase 2); round-trip cases removed with the functions (Phase 4 cut-over)
packages/host/src/hitl/__tests__/approver-authority.test.ts — unit: ApproverRef mapping per AuthIdentity variant and TeamsApprover; approval audit names both
packages/host/src/hitl/adapters/__tests__/redis-stores.test.ts — decision store: the stored value is the whole HitlDecision; a record without an approver is corrupt; already-resolved returns the first writer's decision
packages/host/src/hitl/adapters/__tests__/run-executor.test.ts — rewritten: run id and authority from the record only, one withRecordedAuthority call per slice; authority-changed fails the run with zero node executions; a reauthorization-required node parks, every other failure fails
packages/host/src/hitl/__tests__/run-store-job.test.ts — parked phase parses (Phase 1); approvals land in the same guarded checkpoint write as the human-responded advance, and a lost lease writes neither (Phase 5 approvals Task)
packages/host/src/hitl/__tests__/reauthorize-run.test.ts — NEW, service unit: each refusal leaves status and custody unchanged, audited once; accepted: reestablish, markReauthorized, enqueue, audit, in order; a run parked custody-expired is accepted with a fresh window; a lost markReauthorized race is 409 and the record keeps the winner's authority (custody sealed under the loser's binding is unopenable, so the next redeem parks the run again); one notification per park
```

### Host: admission, manifest and composition

```
packages/host/src/http/delegated-token-header.ts — parseDelegatedTokenHeader: parse X-Fugue-Delegated-Authorization → absent | present(RedactedSecret) | malformed
packages/host/src/http/handlers/run-dag.ts — INV-4 and INV-6 sibling: admission through the injected admitRunAuthority, then the sync path's one withEstablishedAuthority call (Component Design › Run Admission)
packages/host/src/supervisor/uds-proxy.ts — unchanged: proxyToWorker forwards X-Fugue-Delegated-Authorization and Authorization byte-identical and strips only X-Fugue-Tenant; a runtime seam of CT-1, CT-3 and CT-4
packages/host/src/http/handlers/manifest.ts — per-DAG authority block: requirements via classifyCapabilities, each brokered mode (authorityOf, INV-2 sibling), any capability-unknown requirements, the delegated header requirement, the audience (delegatedAudienceFor, INV-5 sibling), the required DELEGATED_SCOPE (the client allowlist is not published), tenant
packages/host/src/domain/host-error.ts — capability-catalog-invalid{faults} (Phase 1), identity-config-invalid{faults} (Phase 2), run-authority-refused{refusal} (Phase 4), run-not-awaiting-reauthorization{runId} 409 (Phase 5 re-authorization Task), each with its exhaustive tables; boot refusals name every offender, never a value
packages/host/src/http/middleware/error-handler.ts — rawDetailsFor, .exhaustive() over HostError: each new kind's case in the Task adding it; with __tests__/middleware/error-handler.test.ts and domain/__tests__/host-error.test.ts
packages/host/src/domain/framework-error-http.ts — authority-unavailable mapping (AD-8), in the Phase 1 union-widening Task (both matches .exhaustive())
packages/host/src/host.ts — subject-token wiring removed and boot catalog load with HostDeps.capabilityCatalog?: unknown (Phase 1); identity-config-invalid (Phase 2); factories imported from run-composition.ts (Phase 3 extraction); the Phase 4 cut-over's wiring changes (HostDeps.capabilityBroker REMOVED, HostDeps.identityTransports?: IdentityTransports added)
packages/host/src/adapters/node-context-factory.ts — createNodeContextForDag(shared, registered, runId, signal, authority: RunAuthority, options) returns NodeContextForDag{ctx, authority: RunAuthority, meterMintedLlm}; it stores no origin (CT-4 runtime seam); resolveOriginAndBindSubjectToken removed; unmapped-DAG throw replaced by planner refusal
packages/host/src/__tests__/broker-selection.test.ts — rewritten: createHost composes composeRunAuthorityWiring over HostDeps.identityTransports for each EntraDirectory variant
packages/host/src/__tests__/entrypoint-wiring.test.ts — capabilityBroker override removed; identityTransports injected instead
packages/host/src/__tests__/integration/full-lifecycle.test.ts — T8 rewritten: the capabilityBroker override test becomes an identityTransports injection test
packages/host/src/__tests__/node-context-factory.test.ts — rewritten
packages/host/src/__tests__/handlers/run-dag-authority.test.ts — refusal ordering: zero acquire, zero startRun, zero egress (JWKS included) on refusal
packages/host/src/__tests__/handlers/manifest-authority.test.ts — authority block shape per model
packages/host/src/__tests__/boot-identity-refusal.test.ts — AS-013, AS-033, SC-013, NFR-020 at createHost: a configured Entra leg without ENTRA_IDENTITY_MODEL, with an unknown model, or with a mapped agent client lacking an Entra identity → Err identity-config-invalid naming every offender, no router built, no server bound; ENTRA_CLIENT_ID → removed-key refusal with the migration hint; no ENTRA_* key, or one presence key, boots dark with one warning naming the missing key
packages/host/src/adapters/subject-token-registry.ts — DELETED (Phase 1)
packages/host/src/adapters/__tests__/subject-token-registry.test.ts — DELETED (Phase 1)
packages/host/src/__tests__/subject-token-teardown.test.ts — DELETED (Phase 1)
packages/host/src/adapters/__tests__/unwired-defaults.test.ts — rewritten for unwired mint/authority adapters (Phase 1 drops its exchangeV2 and subject-token cases; Phase 2 adds the new adapters' rows; the Phase 4 legacy deletion drops the legacy rows)
```

### Docs, ADRs and doc-lint

```
docs/adr/0093-per-agent-entra-identity.md — supersedes ADR-0055 (written by adr-writer in Phase 1)
docs/adr/0094-per-capability-authority-mode-no-user-exchange.md — partially supersedes ADR-0056 and ADR-0058
docs/adr/0095-delegated-continuation-run-bound-custody.md — delegated continuation policy and custody: write-once, Redis-held, never rotated; Entra's per-refresh evaluation and the operator cut-offs (D1 to D3); re-authorization (AD-13)
docs/adr/0096-durable-park-on-caller-classified-node-failure.md — the framework park seam (AD-13)
docs/adr/0055-*.md, docs/adr/0056-*.md, docs/adr/0058-*.md — status + successor pointers
docs/adr/README.md — index rows, supersession
packages/host/docs/auth.md — rewritten identity section, status matrix, token table
packages/host/docs/data-handling.md — NEW: initiator attribution (oid, tid), approver records (AD-9), retention unchanged (FR-024), custody hold/bind/cap/delete (FR-044), written once, revoked by Entra at refresh and not by a password reset (D3), the cap (DELEGATED_CUSTODY_MAX_SEC, default min(604800 s, HITL_RUN_TTL_SEC), never unbounded)
packages/host/docs/identity-chain-sequence.md — NEW: sequence diagrams for agent, app user-origin, delegated user-origin; per-hop token table (iss, sub, azp, aud, holder, verifier)
docs/team-security-and-capabilities.md — reconciled; status matrix
docs/runbooks/entra-fugue-agents-provisioning.md — rewritten: both models, RBAC for Applications, Agent ID spike pass/fail with the delegated items (D8 a to d), fallback selection, rollback, credential/client and custody-keyring rotation, realm-before-host deploy order, broker-token purge, delegated-scope hardening (pre-authorize only DELEGATED_CLIENT_APPS, user consent off, D4), delegated cut-offs (disable the user, revokeSignInSessions, end the run, D3), the re-authorization procedure, evidence template
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
type DelegationLeg = { kind: "wired"; keys: CustodyKeyring; maxSec: CustodySeconds;  // CT-3 brand; only parseCustodySeconds builds it, so 0 < maxSec ≤ HITL_RUN_TTL_SEC by construction
      clients: NonEmptyReadonlySet<EntraClientId>; scope: DelegatedScope }  // D4: DELEGATED_CLIENT_APPS, DELEGATED_SCOPE; no defaults
  | { kind: "dark"; missing: NonEmptyArray<"DELEGATED_CUSTODY_KEYS" | "DELEGATED_CLIENT_APPS" | "DELEGATED_SCOPE"> }  // every unset key
type DelegatedScope = Brand<string, "DelegatedScope">  // one scope token, no whitespace; parsed by loadConfig
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

Presence gating per leg (AS-013, NFR-020, clarify log): the Entra leg is configured iff `ENTRA_TENANT_ID` and `ENTRA_AGENT_IDENTITIES` are both set, else `dark`, warning with the missing presence key(s) and every other ignored `ENTRA_*` key (keys only, never values); only a configured leg produces model, blueprint and agent-identity faults. The delegation leg exists only inside a wired Entra leg; it is configured iff `DELEGATED_CUSTODY_KEYS`, `DELEGATED_CLIENT_APPS` and `DELEGATED_SCOPE` are all set, else `dark` naming every unset one (warned, not refused; delegated runs are refused `delegation-unconfigured`, AD-7). A dark Entra leg's `ignored` also names any set `DELEGATED_*` key. The custody max is resolved once, by `parseCustodySeconds(DELEGATED_CUSTODY_MAX_SEC, HITL_RUN_TTL_SEC): Result<CustodySeconds, IdentityConfigFault>`: the set value, else min(`DEFAULT_DELEGATED_CUSTODY_MAX_SEC`, `HITL_RUN_TTL_SEC`); above `HITL_RUN_TTL_SEC` → `custody-max-exceeds-run-ttl`; nothing downstream handles bare seconds. `ENTRA_CLIENT_ID` is refused in every leg state with a migration hint (a leftover shared-app key would otherwise go silently dark). `createHost` returns the faults as `identity-config-invalid` before building the router.

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
    => Promise<Result<AcquiredCredential, DelegatedGrantFault>>  // write-once custody (D1): a returned refresh_token is dropped unread
  // establishDelegation: a 2xx without refresh_token → unconfigured{keys: ["offline_access"], why: "rejected"} (D8 a)
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
type EstablishmentFault  = AcquisitionFaultOf<Hop, "refused">  // establishDelegation and reestablishDelegation (put/replace and the LC-1 guards included)
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

`authority-changed` is not an acquisition fault: the lifecycle's drift check produces `AuthorityChanged` (CT-1) and the HITL executor renders it as `authority-unavailable{authority-changed{changes}}` (AD-12).

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
  | { kind: "app"; app: ReadonlyMap<string, AccessEntry<"app">> }  // no delegated entry representable (closed `delegated?: never`)
  | { kind: "delegating"; delegated: NonEmptyReadonlyMap<string, AccessEntry<"delegated">>; app: ReadonlyMap<string, AccessEntry<"app">> },
  "RunAccess"> & { passThrough: ReadonlySet<string> }  // both variants: the names pass 1 classified not-brokered (AD-12)
  // built only by accessOf and parseRunAccess, which keep the key sets (both maps and passThrough) disjoint
type NonEmptyReadonlyMap<K, V> = Brand<ReadonlyMap<K, V>, "NonEmpty">  // size ≥ 1; branded only inside RunAccess's builders
type AppAccess = Extract<RunAccess, { kind: "app" }>; type DelegatingAccess = Extract<RunAccess, { kind: "delegating" }>
type UnbrokeredAccess = { kind: "unbrokered"; passThrough: ReadonlySet<string> }  // every requirement name: an unbrokered host brokers none (AD-12)
type AdmittedAccess = RunAccess | UnbrokeredAccess  // what every RunAuthority variant carries; parseRunAccess parses either
type BrokeringNow = { kind: "brokered"; catalog: CapabilityCatalog } | { kind: "unbrokered" }  // the boot brokering state (REALM_JWT_ISSUER set or not)
type RunAuthority =
  | { kind: "unbrokered"; principal: { kind: "agent" } | { kind: "user"; initiator: Initiator }; access: UnbrokeredAccess }
  | { kind: "agent"; agentClientId: AgentClientId; access: AppAccess }
  | { kind: "user-app"; agentClientId: AgentClientId; initiator: Initiator; access: AppAccess }
  | { kind: "user-delegated"; agentClientId: AgentClientId; initiator: Initiator; access: DelegatingAccess;
      delegation: { audience: EntraClientId; custodyExpiresAtMs: EpochMs; runDeadlineMs: EpochMs } }  // expiry ≤ runDeadlineMs; the deadline never changes
// No variant holds a run id: BoundAuthority pairs it with the authority, and custodyBindingOf(bound) (CT-3) derives
// {runId, agentClientId, entra: initiator.entra, expiresAtMs}; custody key, AAD and TTL all come from it.
type RawCapabilityRequirement = { nodeId: NodeId; capability: string }  // from runtimeNodeInventory, unparsed
type CapabilityRequirement = { nodeId: NodeId; scope: CapabilityScope }  // parsed by classifyCapabilities: brokered only
type RequirementRef = RawCapabilityRequirement  // one shape: a refusal names a requirement as the inventory gave it
type BrokeredRunAuthority = Exclude<RunAuthority, { kind: "unbrokered" }>
type UserDelegatedAuthority = Extract<RunAuthority, { kind: "user-delegated" }>
type RunAuthorityPlan = Exclude<RunAuthority, { kind: "user-delegated" }>
  | { kind: "user-delegated-pending"; agentClientId: AgentClientId; initiator: Initiator; access: DelegatingAccess; grant: VerifiedDelegationGrant }
type PendingPlan = Extract<RunAuthorityPlan, { kind: "user-delegated-pending" }>
type AdmittedRun<P extends RunAuthorityPlan = RunAuthorityPlan> = Brand<{ runId: RunId; dagId: DagId; ownerTeam: Team; plan: P }, "AdmittedRun">
  // built only by admitRunAuthority; taken whole, so no identity, plan or run id is paired wrongly
type BoundAuthority<A extends RunAuthority = RunAuthority> = Brand<{ runId: RunId; authority: A }, "BoundAuthority">
  // built only by bindAdmission, establishDelegation (from the AdmittedRun), boundAuthorityOf (the record's own runId) and renewedAuthority (from a bound): no loose pair anywhere
bindAdmission(admitted: AdmittedRun): { kind: "bound"; bound: BoundAuthority<Exclude<RunAuthority, {kind:"user-delegated"}>> }
  | { kind: "pending"; admitted: AdmittedRun<PendingPlan> }  // the lifecycle's one split: a decided plan is its own authority
type DelegatedHeader = { kind: "absent" } | { kind: "present"; token: RedactedSecret } | { kind: "malformed" }
type DelegatedTokenExpectation = Brand<{ tenant: EntraTenantId; audience: EntraClientId;
    clients: NonEmptyReadonlySet<EntraClientId>; scope: DelegatedScope }, "DelegatedTokenExpectation">  // clients, scope: the DelegationLeg's (D4)
  // built only by expectationFor, which pass 1 and planReauthorization share; audience from delegatedAudienceFor (INV-5);
  // no issuer: issuerFor(tenant) derives it where it is checked
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
      // DelegatedTokenInvalidReason = "malformed" | "signature" | "issuer" | "tenant" | "audience" | "client" | "expired"
      //   | "not-yet-valid" | "not-delegated" | "scope" | "version"   (client, scope: D4, AS-040; never a claim value)
  | { kind: "identity-binding-mismatch"; field: "oid" | "tid" }  // 403
  | { kind: "reauthorization-initiator-mismatch"; field: "identity" | "oid" | "tid" }  // 403; re-authorization only (AD-13)
  | { kind: "reauthorization-window-closed" }  // 410; under 1 s of the run deadline left, re-authorization only
  | { kind: "delegated-token-unexpected" }  // 400
  | { kind: "delegation-unconfigured"; missing: readonly string[] }  // 503
  | { kind: "agent-client-unmapped"; dagId: DagId }  // 503
  | { kind: "delegation-not-established"; reason: "refused" | "federation-rejected" | "grant-missing" | "unreachable" | "unconfigured" | "defect" }  // 403/502/403/503/503/500; built only by runAuthorityRefusalOf
// each producer is typed with only its subset, so the precedence split is a type fact: pass 2 holds nothing ranked above delegated-token-invalid
type PlanRefusal = Exclude<RunAuthorityRefusal, { kind: "delegated-token-invalid" | "identity-binding-mismatch" | "delegation-not-established"
    | "reauthorization-initiator-mismatch" | "reauthorization-window-closed" }>
  | { kind: "delegated-token-invalid"; reason: "malformed" }  // pass 1: a malformed header is its only token refusal
type ReauthorizationRefusal =  // planReauthorization's static subset; the endpoint then adds PresentationRefusal and EstablishmentRefusal
  | Extract<RunAuthorityRefusal, { kind: "reauthorization-initiator-mismatch" | "reauthorization-window-closed" | "delegation-unconfigured" | "delegated-token-required" }>
  | { kind: "delegated-token-invalid"; reason: "malformed" }
type ClaimRefusal = { kind: "delegated-token-invalid"; reason: Exclude<DelegatedTokenInvalidReason, "malformed" | "signature"> }
type BindingRefusal = Extract<RunAuthorityRefusal, { kind: "identity-binding-mismatch" }>
type PresentationRefusal = { kind: "delegated-token-invalid"; reason: "malformed" | "signature" } | ClaimRefusal | BindingRefusal  // pass 2
type AdmissionRefusal = PlanRefusal | PresentationRefusal  // admitRunAuthority
type EstablishmentRefusal = Extract<RunAuthorityRefusal, { kind: "delegation-not-established" }>  // the lifecycle brackets' only Err
planRunAuthority(input: RunAuthorityInput): Result<AdmissionStep, PlanRefusal>  // pass 1, pure, no token check; input: AuthIdentity,
  // agent mapping (AgentClientId | unmapped), raw requirements (classified first), catalog, brokering state (brokered{entra: EntraLeg} |
  // unbrokered; delegation-unconfigured names delegationOf's missing keys), DelegatedHeader
admitDelegatedPresentation(step: VerifyDelegatedStep, p: DelegatedPresentation, nowMs: EpochMs)
  : Result<PendingPlan, PresentationRefusal>  // pass 2, pure; grant = {step.token, validated claims}
issuerFor(tenant: EntraTenantId): string  // https://login.microsoftonline.com/{tenant}/v2.0; the one derivation
validateEntraUserTokenClaims(claims: unknown, expect: DelegatedTokenExpectation, nowMs: EpochMs): Result<VerifiedEntraClaims, ClaimRefusal>
bindDelegatedPrincipal(realm: EntraPrincipal, verified: VerifiedEntraClaims): Result<EntraPrincipal, BindingRefusal>
originOf(run: BrokeredRunAuthority): InvocationOrigin  // agent → {agent, agentClientId}; user-app | user-delegated → {user, sub: initiator.realmSub, agentClientId}
accessOf(reqs: readonly CapabilityRequirement[]): RunAccess  // pass 1: one entry per name, authorityOf's mode, admittedCapabilityOf; delegating iff any delegated
parseRunAccess(raw: unknown): Result<AdmittedAccess, "access-corrupt">  // a name twice, an empty delegated map, an unknown mode or resource → Err
parseRunAuthority(raw: unknown): Result<RunAuthority, "authority-corrupt">  // the run store's one parser; access via parseRunAccess; unbrokered needs
  // UnbrokeredAccess, agent and user-app app access, user-delegated delegating access and custodyExpiresAtMs ≤ runDeadlineMs
boundAuthorityOf(record: { runId: RunId; authority: RunAuthority }): BoundAuthority  // IN-6: the record holds the bare authority; bound where used
type RequirementRoute =
  | { kind: "pass-through" }  // outside every brokered namespace: another provider serves it
  | { kind: "app"; capability: AdmittedCapability } | { kind: "delegated"; capability: AdmittedCapability }
  | { kind: "refused-not-admitted"; capability: string }  // in a brokered namespace, absent from access: fail closed (NFR-010)
routeRequirement(access: AppAccess, brokered: BrokeredNamespaces, name: string): Exclude<RequirementRoute, { kind: "delegated" }>
routeRequirement(access: RunAccess, brokered: BrokeredNamespaces, name: string): RequirementRoute  // the mint path's one routing rule
type AuthorityChange = { capability: string; change: "mode-changed" | "removed" | "newly-brokered" }
type AuthorityChanged = { kind: "authority-changed"; changes: NonEmptyArray<AuthorityChange> }  // sorted by capability
checkAdmittedAuthority(access: AdmittedAccess, now: BrokeringNow, requirements: readonly RawCapabilityRequirement[])
  : Result<void, AuthorityChanged>  // AD-12; INV-2 sibling (reads modes only through authorityOf); unbrokered now: nothing classifies brokered
type ReauthorizationPlan = { kind: "verify"; step: VerifyDelegatedStep }  // the same step pass 2 consumes
planReauthorization(bound: BoundAuthority<UserDelegatedAuthority>, identity: AuthIdentity, header: DelegatedHeader,
  legs: AuthorityLegs, nowMs: EpochMs): Result<ReauthorizationPlan, ReauthorizationRefusal>
  // AD-13; pure; expectationFor(recorded agent) as pass 1 (INV-5); window-closed iff custodyTtlSecOf(delegation.runDeadlineMs, nowMs) < 1; refusal order: initiator-mismatch, window-closed,
  // delegation-unconfigured, delegated-token-required, malformed; every refusal before any JWKS egress
type ExecutesAs = { agent: AgentClientId; asAgent: readonly string[];
  onBehalfOf?: { initiator: Initiator; capabilities: NonEmptyArray<string> } }  // onBehalfOf iff delegating access
executesAsOf(authority: RunAuthority): ExecutesAs | { kind: "unbrokered" }  // AD-9; one caller, hitl/service.ts's runViewOf, whose value is passed on
// adapters/entra-user-token-verifier.ts: a plain adapter function, no port (one implementation; the JWKS transport is the seam)
verifyEntraUserToken(step: VerifyDelegatedStep, jwks: EntraJwks, signal: AbortSignal): Promise<DelegatedPresentation>
```

Refusal precedence, a property-tested total order over the composed admission: `capability-unknown` → `agent-client-unmapped` → `delegated-capability-requires-user` → `delegated-token-unexpected` → `delegation-unconfigured` → `delegated-token-required` → `delegated-token-invalid` → `identity-binding-mismatch`. `capability-unknown` is first because every later decision reads `authorityOf`. Pass 1 decides up to a malformed header; pass 2 the signature and claim reasons (an unparseable JWS is `malformed` there too) and the binding; every pass-1 refusal outranks every pass-2 one, as the types state, so the split preserves the order. The verifier takes the `verify-delegated` step, whose `expect` exists only when the Entra leg is wired, the agent mapped, no capability unknown and `delegatedAudienceFor` has answered. `accessOf` (every brokered requirement by name under `authorityOf`'s mode) is the only per-run mode resolution and `routeRequirement` its only mint-path reader, so a catalog change applies to runs admitted after it, the realm still authorizes each capability at every mint (AD-4), and a HITL run resuming after one fails at the slice start through `checkAdmittedAuthority` (AD-12, which also reads `access.passThrough`, an unbrokered run's included).
`planReauthorization` and pass 1 share one expectation builder (`expectationFor(directory, delegation, agent)`): a re-authorization token is checked against exactly a run-start token's audience, tenant, client allowlist and scope; pass 2 is reused unchanged.
**Depends on:** catalog, CT-1 types, framework `runtimeNodeInventory`, `lazyJwks` (inside the verifier only), `delegatedAudienceFor` (INV-5).

### Delegated Custody

**Responsibility:** Hold the run-bound refresh credential, written once, only as ciphertext in Redis, through a typed lifecycle with an expiry fixed per (re-)establishment, until the run's terminal state.
**Files:** File Structure › Host: delegated custody
**Interface:**

```
type CustodySeconds = Brand<number, "CustodySeconds">  // only parseCustodySeconds(raw, runTtlSec) builds it: 0 < s ≤ HITL_RUN_TTL_SEC
type CustodyBinding = { runId: RunId; agentClientId: AgentClientId; entra: EntraPrincipal; expiresAtMs: EpochMs }  // a DERIVED view, never stored
custodyBindingOf(bound: BoundAuthority<UserDelegatedAuthority>): CustodyBinding  // the AAD and the store key
type SealedRefreshCredential = { kid: string; iv: string; ciphertext: string }  // base64url
type CustodyState =  // LC-1 states = what get returns; no state carries a binding or an expiry
  | { kind: "absent" }
  | { kind: "held"; sealed: SealedRefreshCredential }
  | { kind: "revoked"; reason: "refused" }  // the sealed bytes are dropped
type CustodySuccessor = Exclude<CustodyState, {kind:"absent"}>  // what a transition yields and a write carries
type CustodyEvent =  // the binding comes from the run's authority on every event that needs a time guard
  | { kind: "establish"; binding: CustodyBinding; sealed: SealedRefreshCredential; nowMs: EpochMs; cap: CustodySeconds }
  | { kind: "refuse" }
  | { kind: "reestablish"; binding: CustodyBinding; sealed: SealedRefreshCredential; nowMs: EpochMs; cap: CustodySeconds }  // AD-13; the FRESH binding
type CustodyTransitionFault =
  | { kind: "undeclared"; from: CustodyState["kind"]; event: CustodyEvent["kind"] }
  | { kind: "past-expiry" }  // establish or reestablish with custodyTtlSecOf(binding.expiresAtMs, now) < 1
  | { kind: "cap-exceeded" }  // establish or reestablish with expiry beyond now + cap
type SuccessorOf<E extends CustodyEvent> = E extends {kind:"refuse"} ? Extract<CustodySuccessor, {kind:"revoked"}> : Extract<CustodySuccessor, {kind:"held"}>
transitionCustody<E extends CustodyEvent>(state: CustodyState, event: E): Result<SuccessorOf<E>, CustodyTransitionFault>
establishFaultOf(fault: CustodyTransitionFault): EstablishmentFault
  // past-expiry → unreachable{hop: entra, cause: timeout}: the run's window closed during the mint and on-behalf-of exchange (retriable 503);
  // cap-exceeded | undeclared → custody-defect{fault}: unreachable by construction, so a defect, failed closed
reauthorizationReasonOf(state: Exclude<CustodyState, {kind:"held"}>, binding: CustodyBinding, nowMs: EpochMs): ReauthorizationReason
custodyExpiryFor(now: EpochMs, max: CustodySeconds, runDeadline: EpochMs): EpochMs  // min(now + custodySecondsToMs(max), runDeadline)
renewedAuthority(bound: BoundAuthority<UserDelegatedAuthority>, nowMs: EpochMs, max: CustodySeconds): BoundAuthority<UserDelegatedAuthority>
  // INV-8 owner: the only builder of a re-established authority; every field kept but custodyExpiresAtMs = custodyExpiryFor(nowMs, max, runDeadlineMs)
custodyTtlSecOf(expiresAtMs: EpochMs, nowMs: EpochMs): number  // ⌊(expiresAtMs − nowMs) / 1000⌋: RedisPort set/setNx take whole seconds, so
  // the record never outlives the binding expiry; the guards refuse a TTL < 1 as past-expiry

// Written once (D1): only establishment and re-establishment write a credential, both through the lifecycle; a redeem's one write is revoke.
type HeldCustody = Extract<CustodyState, {kind:"held"}>
interface DelegatedCustodyStore {  // key fugue:<tenant>:authority:custody:<binding.runId>; ciphertext only
  put(binding: CustodyBinding, held: HeldCustody, nowMs: EpochMs): Promise<Result<void, HostError>>
      // SET NX, TTL custodyTtlSecOf(binding.expiresAtMs, nowMs); establishment only; an existing key is an Err
  replace(binding: CustodyBinding, held: HeldCustody, nowMs: EpochMs): Promise<Result<void, HostError>>  // SET, TTL custodyTtlSecOf(the NEW binding's expiry, nowMs); re-establishment only
  revoke(binding: CustodyBinding, read: HeldCustody, nowMs: EpochMs): Promise<Result<"revoked" | "not-current", HostError>>
      // setIfValue guarded on the stored bytes read, expiry = the binding's remaining ms; never creates; a record replaced since → not-current
  get(runId: RunId): Promise<Result<CustodyState, HostError>>  // missing or past TTL → absent
  delete(runId: RunId): Promise<Result<void, HostError>>  // idempotent; held ONLY by the lifecycle owner
}

// The redeem protocol, pure (domain/delegated-custody.ts); the cell (adapters/run-custody-cell.ts) performs each effect, decides nothing, holds no state.
type RedeemContext = { binding: CustodyBinding; nowMs: EpochMs }
type RedeemProgress =  // the ONE effect the cell performs next
  | { kind: "read" }
  | { kind: "open"; held: HeldCustody }
  | { kind: "redeem"; held: HeldCustody }  // mint, then redeemDelegation with the opened credential
  | { kind: "revoke"; read: HeldCustody }  // after Entra refused the redeem
type RedeemOutcomeOf = {  // each progress's own outcomes, and no others
  read: CustodyState | { kind: "store-failed" }
  open: { kind: "opened" } | { kind: "unopenable" }  // the plaintext stays in the cell
  redeem: { kind: "redeemed" } | { kind: "redeem-failed"; fault: DelegatedGrantFault }
  revoke: { kind: "revoked" } | { kind: "not-current" } | { kind: "store-failed" } | { kind: "skipped-aborted" }
}
type RedeemAwaiting = { [P in RedeemProgress["kind"]]:
  { context: RedeemContext; progress: Extract<RedeemProgress, {kind: P}>; outcome: RedeemOutcomeOf[P] } }[RedeemProgress["kind"]]
type RedeemStep =
  | { kind: "perform"; context: RedeemContext; progress: RedeemProgress }
  | { kind: "finish"; result: { kind: "grant" } | { kind: "fault"; fault: AcquisitionFault };
      log: readonly CustodyLogEvent[] }  // CustodyLogEvent: custody-unopenable | custody-revocation-write-failed
beginRedeem(context: RedeemContext): RedeemStep  // the two begin rows
decideRedeemStep(awaiting: RedeemAwaiting): RedeemStep  // .exhaustive() over progress.kind, then over that progress's outcomes: exactly the legal pairs

// The run-authority lifecycle (INV-4, INV-6 and INV-7 owner): one operation owns the bracket from establishment to release.
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
      // bindAdmission or establish → AuthorizedRun (forRun once iff brokered) → body → release(sync-settled{ending}) in finally;
      // body rejection → release(sync-rejected), rethrow; establish Err → release(abandoned{sync, establish}), Err(runAuthorityRefusalOf(fault))
  establishForRecord<T>(run: AdmittedRun, deadlineMs: EpochMs,
      persist: (bound: BoundAuthority) => Promise<Result<T, HostError>>): Promise<Result<T, EstablishForRecordFailure>>
      // establish → persist; either failing → release(abandoned{hitl, establish | persist}); no handle
  withRecordedAuthority<T>(bound: BoundAuthority, requirements: readonly RawCapabilityRequirement[],
      body: (run: AuthorizedRun) => Promise<T>): Promise<Result<T, AuthorityChanged>>
      // one HITL slice: checkAdmittedAuthority(bound.authority.access, the boot BrokeringNow) FIRST (Err → no handle, no body), then forRun once iff brokered → body;
      // neither establishes nor releases; the queue lease serializes slices
  reauthorize(bound: BoundAuthority<UserDelegatedAuthority>, grant: VerifiedDelegationGrant): Promise<Result<BoundAuthority<UserDelegatedAuthority>, EstablishmentRefusal>>
      // reestablishDelegation under a fresh window ≤ the run deadline; Ok: the re-established bound; any Err leaves custody as it was; never releases
  endRun(runId: RunId, ending: HitlRunEnding): Promise<CustodyReleaseOutcome>  // release(releaseCauseOf(hitl-ended{ending})); never rejects
}
createRunAuthorityLifecycle(deps: { establish: (admitted: AdmittedRun<PendingPlan>, deadlineMs: EpochMs)
      => Promise<Result<BoundAuthority<UserDelegatedAuthority>, EstablishmentFault>>;  // establishDelegation partially applied by the wiring; on a
      // non-delegating leg the unwired establishment (unconfigured{keys: delegationOf's missing, why: absent}, zero egress)
    reestablish: (bound: BoundAuthority<UserDelegatedAuthority>, grant: VerifiedDelegationGrant)
      => Promise<Result<BoundAuthority<UserDelegatedAuthority>, EstablishmentFault>>;  // reestablishDelegation, applied the same way
    brokering: BrokeringNow;  // the boot brokering state, for checkAdmittedAuthority only
    capabilityAuthority: CapabilityAuthority;  // the ONLY holder of forRun
    custody: Pick<DelegatedCustodyStore, "delete">; logger: LogPort }): RunAuthorityLifecycle  // INV-4, INV-6, INV-7 owner
establishDelegation(deps: { mint; entra; cipher; custody: Pick<DelegatedCustodyStore, "put">; leg: DelegatingEntraLeg; now: () => EpochMs },
    admitted: AdmittedRun<PendingPlan>, runDeadlineMs: EpochMs): Promise<Result<BoundAuthority<UserDelegatedAuthority>, EstablishmentFault>>
  // mint → on-behalf-of; ONE clock read t; delegation = {audience: delegatedAudienceFor(leg.directory, agent), custodyExpiresAtMs:
  // custodyExpiryFor(t, leg.delegation.maxSec, runDeadlineMs), runDeadlineMs}; binding = custodyBindingOf({admitted.runId, authority}); seal (AAD = binding);
  // transitionCustody(absent, establish{binding, sealed, t, cap}): Err → establishFaultOf, no put; Ok(held) → put(binding, held, t); no compensation
reestablishDelegation(deps: { mint; entra; cipher; custody: Pick<DelegatedCustodyStore, "get" | "replace">; leg: DelegatingEntraLeg; now: () => EpochMs },
    bound: BoundAuthority<UserDelegatedAuthority>, grant: VerifiedDelegationGrant): Promise<Result<BoundAuthority<UserDelegatedAuthority>, EstablishmentFault>>
  // mint → fresh on-behalf-of; t; bound' = renewedAuthority(bound, t, maxSec) (INV-8); binding' = custodyBindingOf(bound');
  // seal (AAD = binding'); get → transitionCustody(state, reestablish{binding', sealed, t, cap}): Err → establishFaultOf, no write; Ok(held) → replace(binding', held, t) → Ok(bound')
```

**The custody cell: a stateless sequencer.** `forRun(bound)` over a `user-delegated` authority creates the run's cell (`createRunCustodyCell(deps, bound)`) in its closure; per-capability access cells obtain credentials only through `cell.redeem(capability, signal)`. A redeem loops: `beginRedeem` gives the first step, the cell performs the one effect its progress names (store `get` or `revoke`, cipher `open`, realm mint plus `redeemDelegation`) and feeds the outcome to `decideRedeemStep`, until `finish`. Plaintext credentials stay in the cell (the decision sees only whether an open succeeded); `binding = custodyBindingOf(bound)` throughout. Custody is written once and a redeem never writes a credential (D1), so concurrent redeems need no serialization: each presents the same refresh credential, which Entra does not revoke on use. A run-level single-flight fails the deletion test, so there is none; the access cells keep NFR-012's single-flight.

The outcome table (`beginRedeem`'s begin rows, then `decideRedeemStep`, whose input admits only the progress's own outcomes, so the compiler checks totality). A store read failure (`HostError`) only ever becomes `unreachable{hop: custody-store, cause}`.

| State and outcome | Custody transition and next effect | Result of the invocation |
|---|---|---|
| begin, `nowMs ≥ binding.expiresAtMs` | none; no effect | `reauthorization-required{custody-expired}`, zero store reads, zero Entra calls |
| begin, otherwise | `read` | continues |
| `read` → store failed | none | `unreachable{custody-store}` (projects to retriable `infra-unreachable`) |
| `read` → `absent` | none | `reauthorization-required{custody-absent}`, or `{custody-expired}` if the expiry passed meanwhile (`reauthorizationReasonOf`) |
| `read` → `revoked` | none | `reauthorization-required{refused}`, zero Entra calls |
| `read` → `held` | `open` | continues |
| `open` → `unopenable` (AAD mismatch, kid not in the keyring) | none | `reauthorization-required{custody-absent}`, log `custody-unopenable` (runId and kid only) |
| `open` → `opened` | `redeem` | continues |
| `redeem` → `redeemed` | none; a refresh credential in the response was already dropped by the adapter | the access credential |
| `redeem` → `redeem-failed{reauthorization-required{refused}}` | `refuse` → `revoke(read)` (skipped if the signal aborted) | continues |
| `redeem` → `redeem-failed`, any other fault | none | that fault, no `app` fallback |
| `revoke` → any outcome | none further (`not-current`: a re-authorization replaced the record since the read, and it stays) | `reauthorization-required{refused}`; a store failure is logged `custody-revocation-write-failed` |

**Release** (INV-4 owner) is unconditional and idempotent: a run that never held custody costs one `DEL` on a missing key, so no caller decides whether a run "had" custody and a mutant owner cannot hide behind a skipped branch. Callers supply only a run ending, never a cause; the owner forms a `RunBracketEnding` and derives the cause with `releaseCauseOf`. The store is always Redis (D2); on a dark delegation leg it stays empty because the planner refuses every delegated run. A failed delete is logged at error with `runId`, `cause` and error kind only, and the ciphertext still expires at its TTL.

**The binding is never stored.** The record holds only `{kind, sealed}` (or `{kind, reason}` once revoked). `custodyBindingOf(bound)` derives the AAD at seal and open, and key and TTL at `put` and `replace`, from the bracket's `BoundAuthority` (the admitted run id or, on resume, the record's own id, beside the persisted `RunAuthority`), so a record replayed under another run or user fails to open and no second copy of run id, expiry or initiator can diverge.

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
  mint: RealmAssertionMint; entra: EntraAgentAuthority; custody: Pick<DelegatedCustodyStore, "get" | "revoke">; cipher: CustodyCipher;
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
RunAuthorityWiring = { legs; brokering: BrokeringNow; admitRunAuthority; lifecycle: RunAuthorityLifecycle;  // the capability authority is not exposed
  // brokering: unbrokered iff config.REALM_JWT_ISSUER is unset; admission then plans only unbrokered runs and the lifecycle builds no handle
  delegatedAudience: (agent: AgentClientId) => EntraClientId | undefined;  // AD-13 awaiting view (INV-5)
  verifyReauthorization: (bound, identity, header) => Promise<Result<VerifiedDelegationGrant, Exclude<RunAuthorityRefusal, EstablishmentRefusal>>> }
  // AD-13: planReauthorization → verifyEntraUserToken → admitDelegatedPresentation, composed over the same legs and JWKS resolver as admission
IdentityTransports = { realmToken; entraToken; entraJwks; graph }  // production: fetch-based, built in host.ts
```

Sync order: lookup, access, body, schema, then **admit** (two-pass). HITL: `startRun(admitted, input)` (bracketing establishment with record creation) and return. Otherwise acquire, circuit, then **one call** `withEstablishedAuthority(admitted, deadlineMs, body)`, where `body(run)` runs `createContext` over `run.authority`, then `executeDag` over `run`, returning `{ending, value}`; on `Err(refusal)` (establishment failed, custody already released) respond with it. The slot is released in the route's own `finally`, as today.

The delegated header's path through `proxyToWorker` and attribution's two injectable hops (`createContext`, `executeDag`), and why CT-1 and CT-4 declare them: `plan-reference.md#run-admission-seams`.

**One wiring, composed in one place.** Every identity dependency the route, HITL engine and executor take comes from one `RunAuthorityWiring`. `composeRunAuthorityWiring` is the ONLY production composition of `planAuthorityLegs`, the realm mint adapter (http or unwired), the Entra adapter for the declared model (agent-id, app-registration or unwired), the JWKS resolver over `transports.entraJwks`, the custody cipher, the Redis custody store (D2), `establishDelegation` and `reestablishDelegation` (the unwired establishments on a non-delegating leg, by `delegationOf`), `createCapabilityAuthority` (over `brokeredNamespacesOf(catalog)`), `createRunAuthorityLifecycle` (over it and the boot `BrokeringNow`: `brokered{catalog}` iff `REALM_JWT_ISSUER` is set, which admission also reads), `createRunAuthorityAdmission` and the re-authorization verifier, so acceptance taking its identity deps from it cannot pick a fake port, a no-op cipher or a hand-built plan. Faults are returned, never thrown; its only free inputs are its parameters; the catalog is branded (host.ts: the boot-loaded one; acceptance: a parsed test catalog, OOS-004). host.ts calls it once per host (over `sharedInfra.redis`, `routedTenant`, `HostDeps.identityTransports` or the fetch default; `Err` → `identity-config-invalid` before the router or server; a dark leg logs `unwiredLegsWarning` once) and hands the same instance, narrowed as INV-4, INV-6 and INV-7 list, to `buildRouterDeps` and `composeHitlRunService`, so a HITL run's start-time custody is visible to its resumed executor. `HostDeps.capabilityBroker` is removed: an embedder-injected broker bypassed exactly this composition.

**Runtime-seam rule used by every contract:** `plan-reference.md#runtime-seam-rule`.
**Depends on:** Planner, Custody, Capability Authority, HITL service.

### HITL Authority Continuity

**Responsibility:** Persist the run's authority and approvals, rebuild the broker from the record alone on resume, park a run whose delegated authority needs re-authorization, record every approval attempt, and delete custody at every terminal state.
**Files:** File Structure › Host: HITL persistence and approver
**Interface:**

```
RunRecord += { authority: RunAuthority; approvals: readonly ApprovalRecord[] }  // stored and read bare (IN-6); authority: Phase 4 cut-over; approvals: Phase 5
  // record.runId the only run id; boundAuthorityOf(record) binds at each use (executor slice, reauthorizeRun), so no record pairs two run ids
// hitl/types.ts (Phase 5 approvals Task, AD-9):
HitlDecision = { action: HumanAction; approver: ApproverRef; channel: "http" | "teams"; decidedAtMs: EpochMs; teamsActivityId?: string }
ApprovalAttempt = { kind: "decide"; decision: HitlDecision } | { kind: "unauthorized"; approver: ApproverRef | { kind: "unknown" }; channel; atMs: EpochMs; teamsActivityId?: string }
DecisionAttemptOutcome = "accepted" | "duplicate" | "not-pending" | "unauthorized"
ApprovalRecord = { nodeId: NodeId; action: HumanAction["kind"]; approver: ApproverRef; channel; decidedAtMs: EpochMs; teamsActivityId?: string }
DecisionStorePort.resolvePending(runId, nodeId, decision: HitlDecision)
  : Promise<Result<{ kind: "accepted" } | { kind: "already-resolved"; decision: HitlDecision } | { kind: "not-pending" }, HostError>>  // one SET NX of the whole value
classifyDecisionAttempt(attempt: Extract<ApprovalAttempt, {kind:"decide"}>, resolved): DecisionAttemptOutcome  // hitl/decision.ts, pure
authorizeApproval(identity: AuthIdentity | TeamsApprover, dag: RegisteredDag): Result<void, "unauthorized">  // canAccessDag, pure
recordApproval(runId, nodeId, attempt: ApprovalAttempt): Promise<Result<DecisionAttemptOutcome, HostError>>  // replaces recordDecision
type ActingPrincipal = ExecutesAs | { kind: "unbrokered" }  // executesAsOf's result, computed once by runViewOf
type RunView = { record: RunMetadata; executesAs: ActingPrincipal; reauthorization?: ReauthorizationView }  // getRun's result (was RunMetadata)
runViewOf(record): RunView  // hitl/service.ts, private: the ONLY executesAsOf call (AD-9) and, when awaiting, the only delegatedAudience read (INV-5)
// Phase 5 re-authorization Task (AD-13), over LC-2's two new RunStatus states (LC-2 Task):
type ReauthorizationView = { nodeId: NodeId; reason: ReauthorizationReason; audience: EntraClientId | { kind: "delegation-unconfigured" };
  header: "X-Fugue-Delegated-Authorization"; endpoint: string; until: EpochMs }  // until = the run deadline; no credential material
RunExecOutcome += { kind: "awaiting-reauthorization"; nodeId: NodeId; reason: ReauthorizationReason }
RunStorePort.markReauthorized(runId, expected: RunMetadata, authority: UserDelegatedAuthority): Promise<Result<"marked" | "not-current", HostError>>
  // setIfValue on the meta key, unleased; status and re-established authority in one write; runDeadlineMs ≠ expected's → Err, nothing written (INV-8)
RunNotification = { kind: "review"; ...; executesAs: ActingPrincipal }  // the RunView's value
  | { kind: "reauthorization-required"; runId; dagId; ownerTeam; view: ReauthorizationView }  // to the owner-team channel (S2)
reauthorizeRun(runId, presentation: { identity: AuthIdentity; header: DelegatedHeader })
  : Promise<Result<void, HostError>>  // run-not-awaiting-reauthorization | run-authority-refused{ReauthorizationRefusal | PresentationRefusal | EstablishmentRefusal}
HitlRunServiceDeps += { runAuthority: Pick<RunAuthorityLifecycle, "establishForRecord" | "endRun" | "reauthorize">;  // no custody store
  verifyReauthorization: RunAuthorityWiring["verifyReauthorization"]; delegatedAudience: RunAuthorityWiring["delegatedAudience"]; audit }
RunExecutorDeps: broker → runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority">  // RunAuthorityWiring.lifecycle; one handle per slice
RunRecord.identity → RunRecord.authority; RunExecutionRequest.identity → authority: BoundAuthority (boundAuthorityOf(record))  // Phase 4 cut-over
TeamsApprover = { kind: "teams-approver"; aadObjectId: EntraObjectId; canRunDag: (team: Team) => boolean }  // domain/auth.ts; not an AuthIdentity
ProcessRunOutcome = { kind: "continuing" } | { kind: "ended"; ending: HitlRunEnding }  // processRun's single fold; endRun is called once, after it
composeHitlRunService(args: HitlWiringArgs, queueBackend: QueueBackend, notifier): { service; runQueue }  // adapters/run-composition.ts; args.runAuthority: RunAuthorityWiring
```

`startRun(admitted, input)` makes one `establishForRecord(admitted, clock() + HITL_RUN_TTL_SEC, persist)` call; `persist(bound)` creates the record under `bound.runId` with the DAG and owner team, storing only the bare `bound.authority`. `processRun` folds the executor's completed, failed (rejected gate and `authority-changed` slice included) and suspended results, the corrupt-checkpoint settle and the evicted record into one `ProcessRunOutcome`, then calls `endRun` exactly once when it is `ended`. An already-terminal record is `continuing` (released when it became terminal), and so is `awaiting-reauthorization`, which keeps custody.

**Re-authorization (AD-13).** The executor passes the runtime-inventory `requirements` to `withRecordedAuthority` and `parkOn: isReauthorizationRequired` to the framework; a parked outcome settles `awaiting-reauthorization{nodeId, reason}` under the lease, and the service sends one `reauthorization-required` notification carrying `runViewOf(record).reauthorization` to the owner-team channel (best effort, a failure logged) when the settle changed the status; `GET /runs/:runId` prints the same view (S2). `reauthorizeRun`, in order: read the record (409 `run-not-awaiting-reauthorization` unless awaiting) and bind it with `boundAuthorityOf`; `verifyReauthorization` (`planReauthorization`'s static refusals before any JWKS egress, then the verifier and pass 2 unchanged, AS-040's checks included); `runAuthority.reauthorize` (Ok: the re-established bound); `markReauthorized` against the record read, writing its authority (custody is written first: a lost race or a failed record write leaves custody under a binding the record lacks, which the next redeem finds `unopenable` and parks, fail closed); enqueue a wakeup; one `delegation-reauthorization` audit record per call (accepted, or refused with the typed reason and no claim values; a refusal leaves custody and status unchanged). `processRun` moves a `reauthorized` record to `running` under the lease and resumes at the parked node; reconciliation wakes `reauthorized` runs and skips awaiting ones (a spurious wake on one does nothing). A record expiring while awaiting is found missing by the next wake, which calls `endRun(record-evicted)`; custody's TTL is never later than the record's.

**Approvals (AD-9).** Both handlers authorize through `authorizeApproval` (a refusal is an `unauthorized` attempt, audited, store untouched). For a `decide` attempt `recordApproval` makes the one `resolvePending` call and `classifyDecisionAttempt` decides (`accepted` when the write won; `duplicate` for the same click: equal `teamsActivityId` for Teams, equal approver and action for HTTP; else `not-pending`: a later approver, no pending gate, an unknown run); one `hitl-decision` audit record follows with outcome, initiator, approver, channel and, on `accepted`, `runViewOf(record).executesAs`. `getDecision` refuses a stored decision without an approver as corrupt. The executor consumes the decision through `human-review-hook.ts`; the run store's `appendEvent` stages `human-responded{nodeId}`, the following `updateData` writes the checkpoint envelope `{checkpoint, approvals}` to the `hitl:ckpt` key through the same guarded `setIfValues`, and `onCommitted` clears the decision.

`composeHitlRunService` builds `createRedisRunStore` and `createRedisDecisionStore` over the tenant's Redis, `createRunExecutor` over the lifecycle narrowed to `withRecordedAuthority`, `createRunQueue` over the injected backend, and `createHitlRunService` over them and the narrowed lifecycle. CT-3 drives it with an in-process `QueueBackend` and `runQueue.startWorker(service.processRun)`, so record schema, lease-fenced processing and the executor's broker are production code.

The approver is derived where production derives it: `createApproveRunHandler` maps the middleware-built `AuthIdentity` to `realm-user{realmSub, entra}`, `team{team}` or `admin` and serializes refusals through `errorResponse`; `handleBotActivity` parses `from.aadObjectId` (`parseEntraObjectId`), resolves a `TeamsApprover`, authorizes it through `canAccessDag` and maps it to `teams-user{aadObjectId}`. CT-3 and CT-5 declare these as runtime seams, so acceptance never calls `recordApproval` with a hand-built approver; CT-3 re-authorizes only through `createReauthorizeRunHandler`. Both also declare the production renderers `createBotFrameworkNotifier` and `createWebhookNotifier`, faked only at their transports (`BotConnectorPort`, `WebhookHttp`), so `executesAs` and the re-authorization notice are judged as approvers see them.

**Depends on:** CT-1 and CT-3 types, Capability Authority, the run-authority lifecycle (INV-4, INV-6, INV-7), the framework park seam (AD-13).

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

The composed view of Component Design (run start, slice start, per-node mint, park, re-authorization, approval, run ending) is in `plan-reference.md#data-flow` (moved verbatim in loop-back 12; each step is specified once in Component Design).

---

## Lifecycles

### LC-1: Delegated refresh-credential custody

**Machine file:** `packages/host/src/domain/delegated-custody.ts`
**Kind:** typed-reducer
**States:** absent, held, revoked (`revoked{reason: refused}`)

| Event | From | To |
|---|---|---|
| establish | absent | held |
| refuse | held | revoked |
| reestablish | absent | held |
| reestablish | held | held |
| reestablish | revoked | held |

LC-1 is exactly the persisted lifecycle: its states are the three values `DelegatedCustodyStore.get` returns, and each transition is one production performs and persists (`establish`: `establishDelegation` `put`s its successor; `refuse`: the cell's `revoke`, decided by `decideRedeemStep`; `reestablish`: `reestablishDelegation` `replace`s its successor, reached only through the lifecycle's `reauthorize`). No rotation (D1): a redeem never writes a credential. Expiry is not a state but a pure comparison against `custodyExpiresAtMs` (in `decideRedeemStep` and `reauthorizationReasonOf`); the record vanishes at its TTL. Release is the INV-4 owner's `DEL` of the whole record, not a transition: whatever the state, the key becomes `absent`.

Guards (times `EpochMs`, cap `CustodySeconds`; no state carries a binding or expiry; the binding is an event input from `custodyBindingOf(bound)`):
- `establish` requires `custodyTtlSecOf(binding.expiresAtMs, nowMs) ≥ 1` and `binding.expiresAtMs ≤ nowMs + custodySecondsToMs(cap)`, yielding `held{sealed}` for `put` (SET NX), so establishment cannot store expired or over-cap custody; `establishFaultOf` maps its faults.
- `refuse` yields `revoked{reason: refused}`, dropping the sealed bytes (`assertCustodyCiphertextOnly` relies on it).
- `reestablish` carries the re-established authority's FRESH binding (`custodyExpiryFor(now, cap, runDeadlineMs)`; the user's decision on the loop-back 11 report) and is guarded exactly as `establish` (TTL ≥ 1, expiry ≤ now + cap), yielding `held{sealed'}` for `replace` with the TTL of that new expiry. No state holds an expiry, and the run deadline bounding it lives only on the `RunAuthority` and never changes, so no re-authorization outlives the run (`planReauthorization` refuses `reauthorization-window-closed` with under one second of it left).
- Only `reestablish` leaves `revoked`; only `establish` and `reestablish` leave `absent`; so a redeem can neither revive revoked custody nor recreate released custody.
- Any other (state, event) pair is `Err(CustodyTransitionFault{undeclared})`.

`reauthorizationReasonOf`: `revoked` → `refused`; `absent` → `custody-expired` iff `nowMs ≥ binding.expiresAtMs`, else `custody-absent` (released, evicted or purged), covering expiry passing between the cell's pre-read expiry check and the read. `delegated-custody.property.test.ts` asserts every guard. The machine imports `CustodyState`, `CustodySuccessor` and `CustodyEvent` from the CT-3 types file (declared once).

### LC-2: HITL run status

**Machine file:** `packages/host/src/hitl/run-status.ts`
**Kind:** typed-reducer
**States:** queued, running, suspended, awaiting-reauthorization, reauthorized, completed, failed

| Event | From | To |
|---|---|---|
| running | queued, running, suspended, reauthorized | running |
| suspended | running | suspended |
| awaiting-reauthorization | running | awaiting-reauthorization |
| reauthorized | awaiting-reauthorization | reauthorized |
| completed | running, completed | completed |
| failed | running, failed | failed |

The machine is today's `transitionRunStatus(current, next: RunStatusUpdate): Result<RunStatusUpdate, string>`, moved from `hitl/types.ts` with `RunStatus` and `RunStatusUpdate` and given the two new states; the event is the requested update (`queued` is create-only). Every status write goes through it: the lease-fenced settles (`awaiting-reauthorization` from the executor's parked outcome, AD-13) and the unleased `markReauthorized` compare-and-set alike. Terminal rows accept only a byte-equal rewrite. A parked run leaves `awaiting-reauthorization` only by re-authorization or eviction (a missing record, not a transition). The LC-2 Task (Phase 1) creates the file, `run-status.property.test.ts` and every importer and `.exhaustive()` matcher of `RunStatus` with the run store's zod status parser (Phase boundary rule); the statuses have no producer until the re-authorization Task, which adds their behaviour (processRun, reconciliation, the awaiting view).

### LC-3: Framework DAG run phase (park seam)

**Machine file:** `packages/framework/src/dag-runtime/transition.ts`
**Kind:** typed-reducer
**States:** pending, running, retrying, awaiting-human, suspended, retrying-hook, parked, succeeded, failed

| Event | From | To |
|---|---|---|
| start | pending | running |
| wave-done | running, retrying, parked | running, awaiting-human, succeeded, failed |
| node-failed | running, retrying, parked | retrying, failed |
| node-parked | running, retrying, parked | parked |
| executor-error | running, retrying, parked | failed |
| human-responded | awaiting-human, suspended, retrying-hook | running, awaiting-human, succeeded, failed |
| human-suspend | awaiting-human, suspended, retrying-hook | suspended |
| node-failed | awaiting-human, suspended, retrying-hook | retrying-hook, failed |
| executor-error | awaiting-human, suspended, retrying-hook | retrying-hook, failed |
| abort | pending, running, retrying, awaiting-human, suspended, retrying-hook, parked | failed |

The existing pure DAG phase reducer `transition(phase, event, ctx)` (`.exhaustive()` over `[DagPhase, DagEvent]`, ADR-0060) owns `parked`: the park seam adds the phase, the `node-parked` event and the `parked` rows, which accept exactly the `running`/`retrying` events, so a resumed parked wave re-runs as a retry does; every other row is unchanged. The executor only chooses `node-parked` over `node-failed` when `parkOn(error)` holds. `isHalted` covers `parked`. The LC-3 Task is the Phase 1 park seam Task; `dag-transition-property.test.ts` proves no undeclared (phase, event) pair changes the phase.

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
- `packages/host/src/domain/run-authority.ts` — run-start admission decides whether delegation is required and resolves each brokered requirement's mode into the run's `access`; `checkAdmittedAuthority` compares that `access` with the boot catalog's modes at every HITL slice start (AD-12)
- `packages/host/src/adapters/capability-authority.ts` — the mint path chooses the app or delegated acquisition from that `access` only, through `routeRequirement`
- `packages/host/src/http/handlers/manifest.ts` — publishes each DAG's capability modes and the delegated header requirement
**Matrix test:** `packages/host/src/__tests__/authority-mode.matrix.test.ts`
**Statement:** Every call site needing a capability's authority mode reads it through `authorityOf` on a `CapabilityScope`, which only the catalog module mints from a key of a parsed `CapabilityCatalog`, so `authorityOf` is total and no caller holds a capability without a mode (an unknown brokered-namespace requirement is refused `capability-unknown` at admission). No module hard-codes, defaults or keeps a second table of modes. The rule covers admission (pass 1's `access` is the only per-run mode resolution), the resume drift check (current modes only through `authorityOf`), mint-path dispatch (by `access` only) and the manifest. The matrix test generates catalogs (fast-check, delegated test entries included) and asserts all three siblings report the owner's mode for every scope, the mint path through a run the real admission admitted, so a mutant owner answering "app" fails; a drift row admits under one catalog, flips one mode in a second, and asserts `checkAdmittedAuthority` reports `mode-changed` for exactly the entries whose owner answer changed. Advisory: no lint rule can tell a mode read from a mode invented; the matrix and owner mutation verification enforce it. The matrix lands in Phase 1 with the owner rows; Phases 2, 3 and 5 extend it in the Wave adding each sibling.

### INV-3: No credential material in any observable surface

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A prohibition. It spans every module that logs, audits, formats errors, builds handles or persists records, and no single module can own an absence (FR-022, SC-007).
**Statement:** No bearer token, assertion, refresh token, T1 token or custody plaintext appears in logs, audit records, trace spans, error values (`formatFrameworkError` and `discloseHostError` output included), HTTP responses, capability handles, `InvocationOrigin`, `RunAuthority` or `RunMintingAuthority` values, HITL run records and checkpoints, or custody records at rest (ciphertext only). Advisory, because a regex cannot recognise a token value. Decided by acceptance in the phase that builds each surface, over the production composition, with the shared `acceptance/support/credential-sentinel.ts` scan: FR-022 in CT-2 (mint path: logs, audit, spans, errors, handles, custody unchanged after a redeem that returned a refresh credential; Phase 3), AS-037 in CT-1 (run start: HTTP responses, worker and proxy logs, audit, errors, the admitted authority; Phase 4), AS-039 in CT-4 (`app` execution: origin, run authority, `RunMintingAuthority`, handles, audit, logs, the HTTP response; Phase 4) and AS-038 in CT-3 (continuation: run records, checkpoints, approvals, `hitl-decision` and `delegation-reauthorization` audit, the re-authorization notification, errors, the start, status, approve and re-authorization responses and the bot handler, custody ciphertext only; Phase 5). `AcquisitionFault` values are error values, and the type holds this part: `classifyTokenEndpointError` copies only error codes, and a fault has no free-string field (`unreachable` carries the closed `UnreachableCause`, rendered only by `frameworkErrorOf` from the hop, status digits and fixed words). `RedactedSecret` (`domain/redacted-secret.ts`) renders `[redacted]` under every serialisation; `revealSecret` is called only by the Entra form-body builders, the custody cipher and the user-token verifier. The framework's `authority-unavailable-error.test.ts` property-tests that formatted causes never contain an injected sentinel. No trailing scan: a leak is found in the Wave that builds the surface.

### INV-4: A run's custody is released at every ending by one lifecycle owner

**Tier:** advisory
**Owner module:** `packages/host/src/adapters/run-authority-lifecycle.ts`
**Sibling entry points:**
- `packages/host/src/http/handlers/run-dag.ts` — the sync path's one `withEstablishedAuthority` call, which brackets establishment, execution and release
- `packages/host/src/hitl/service.ts` — `startRun`'s one `establishForRecord` call and `processRun`'s one `endRun` call after its outcome fold
**Matrix test:** `packages/host/src/__tests__/custody-release.matrix.test.ts`
**Statement:** Custody is released at every run ending by the run-authority lifecycle alone (FR-023, AS-027, SC-012): it alone holds `DelegatedCustodyStore.delete` and `establishDelegation`, and derives the release cause from the bracket's own outcome (`SyncRunEnding`, a rejected body, `HitlRunEnding`, a failed establish or persist step) through the pure `releaseCauseOf`. So no module pairs establishment with release by hand, picks a cause, or deletes, expires or overwrites custody to end a run; siblings hold the lifecycle narrowed (route: `withEstablishedAuthority`; service: `establishForRecord | endRun`), with no store. Not siblings: `delegation-establishment.ts` (`put` only, reached through the owner's deps) and `run-custody-cell.ts` (`get` and `revoke`, never deleting). Two removals have no code path, by design, and `delegated-custody-store-redis.test.ts` asserts both: Redis TTL eviction of an idle record (custody TTL ≤ now + `HITL_RUN_TTL_SEC` at each (re-)establishment, whose record write follows and refreshes the record TTL) and tenant purge (`purgeTenantKeyspace`). The matrix runs the real owner over the custody store fake with a delegated plan established through it, and after each path asserts `get(runId)` is `absent` and the logged cause is `releaseCauseOf` of that ending. Sync paths through the real route: completed, failed, aborted by timeout, body rejected, establishment failed with a failed or an ambiguous `put`. HITL paths through the real service: completed, failed, rejected, authority changed at a slice start, corrupt checkpoint, evicted record (an awaiting-re-authorization run included), record creation failed after establishment; a parked run keeps custody (no `endRun`). A failing `delete` gives `release-failed`, one error log naming `runId` and `cause` with no credential bytes, and no sibling throws. Exactly one call per sibling half. A mutant owner that skips the delete, mis-derives the cause, swallows the outcome or drops the log fails, as does a sibling that bypasses or repeats the bracket. Advisory: a regex cannot tell a custody delete from any other `delete`. Owner rows land in Phase 3, sibling rows in the Phase 4 cut-over Task (Phase boundary rule).

### INV-5: The delegated audience has exactly one source

**Tier:** advisory
**Owner module:** `packages/host/src/domain/authority-legs.ts`
**Sibling entry points:**
- `packages/host/src/domain/run-authority.ts` — pass 1 builds the `DelegatedTokenExpectation` (the expected `aud` that `validateEntraUserTokenClaims` checks) and the audience named in the `delegated-token-required` 401
- `packages/host/src/adapters/delegation-establishment.ts` — the `delegation.audience` recorded on the `user-delegated` run authority it returns
- `packages/host/src/http/handlers/manifest.ts` — the audience the manifest tells run-starting callers to request
- `packages/host/src/hitl/service.ts` — `runViewOf`'s awaiting view, the audience the re-authorization notice names, from the wiring's `delegatedAudience`, never the persisted `delegation.audience` copy
- `packages/host/src/http/handlers/runs.ts` — the `GET /runs/:runId` awaiting block, printing that view's audience
- `packages/host/src/adapters/run-authority-wiring.ts` — `RunAuthorityWiring.delegatedAudience`, the one `delegatedAudienceFor` call over the wired directory for the re-authorization notice and awaiting block (undefined when dark)
**Matrix test:** `packages/host/src/__tests__/delegated-audience.matrix.test.ts`
**Statement:** Every call site needing the audience a delegated Entra user token must carry obtains it from `delegatedAudienceFor(directory, agentClientId)`: the blueprint client id under the Agent ID model, the agent's own app id under the app-registration model (AD-7). No module derives it from the directory itself, defaults it, or keeps a second mapping. The rule covers admission's claim validation, establishment's recorded audience, the manifest's published audience, and the re-authorization notice and awaiting block (FR-008, FR-036, AS-034), so a caller told one audience is never verified against another; the persisted copy is a record of establishment, never read to tell a caller what to present. The matrix test generates directories for both models (fast-check: arbitrary agent maps and blueprints) and asserts for every mapped agent that admission accepts a token audienced to the owner's answer and refuses `delegated-token-invalid{audience}` for any other (`planReauthorization` uses the same `expectationFor`, so the Phase 5 re-authorization Task adds one row driving it), that establishment's authority carries the owner's answer, that the manifest publishes it, that `composeRunAuthorityWiring`'s `delegatedAudience` answers it for every mapped agent (undefined on a dark leg), and that a run parked through the real service and executor names it in the notification its production renderer sends and in the `GET` awaiting block (both after the directory changed since establishment); a mutant owner answering the blueprint under app-registration fails. Advisory: a regex cannot tell an audience read from one invented; the matrix and owner mutation verification enforce it. The owner, its rows and the `run-authority.ts` row (pass 1 builds the expectation; the row drives the composed admission) land in Phase 2, the establishment row in Phase 3, the manifest row in the Phase 5 manifest Task, the wiring, service and `runs.ts` rows in the Phase 5 re-authorization Task (which adds `delegatedAudience`; the wiring's Phase 3 Task follows the owner's Phase 2 Task).

### INV-6: Each execution bracket mints through exactly one handle, built by the lifecycle

**Tier:** advisory
**Owner module:** `packages/host/src/adapters/run-authority-lifecycle.ts`
**Sibling entry points:**
- `packages/host/src/http/handlers/run-dag.ts` — the sync body executes only over the bracket's `AuthorizedRun`
- `packages/host/src/hitl/adapters/run-executor.ts` — each slice's one `withRecordedAuthority(boundAuthorityOf(record), …)` call
- `packages/host/src/adapters/run-composition.ts` — `createDagExecutor` mints only through `mintingAuthorityOf` over the bracket's `AuthorizedRun`
**Matrix test:** `packages/host/src/__tests__/minting-handle.matrix.test.ts`
**Statement:** The lifecycle is the only caller of `capabilityAuthority.forRun` (the wiring does not expose the capability authority) and calls it exactly once per brokered bracket (a sync run, a HITL slice) over that bracket's `BoundAuthority`, never for an unbrokered run and never after a failed drift check; `AuthorizedRun`'s constructor is module-private, so no sibling can build a second handle or mint outside one. The matrix counts `forRun` through the real route, executor and `createDagExecutor` over a delegated, a user-app and an unbrokered run: one per sync bracket and per slice, zero unbrokered and on drift, and every mint goes through that handle. A mutant owner that builds a second handle, skips the drift check or builds one for an unbrokered run fails. Advisory: a regex cannot tell a handle reuse from a rebuild. Owner rows land in Phase 3, sibling rows in the Phase 4 cut-over Task.

### INV-7: Custody is re-established only through the lifecycle's `reauthorize`

**Tier:** advisory
**Owner module:** `packages/host/src/adapters/run-authority-lifecycle.ts`
**Sibling entry points:**
- `packages/host/src/hitl/service.ts` — `reauthorizeRun`'s one `reauthorize` call, after `verifyReauthorization` accepted the presentation
- `packages/host/src/http/handlers/runs.ts` — `createReauthorizeRunHandler`, the only route into `reauthorizeRun` (`POST /runs/:runId/delegation`)
**Matrix test:** `packages/host/src/__tests__/custody-reestablishment.matrix.test.ts`
**Statement:** Custody is replaced only by the lifecycle's `reauthorize`, the only holder of `reestablishDelegation` (which alone holds `replace`), reached only from `reauthorizeRun` behind `createReauthorizeRunHandler` (AS-041, FR-027). The service holds the lifecycle narrowed to `establishForRecord | endRun | reauthorize`, so no other replacement path type-checks. The matrix drives the real handler and service over the store fake: an accepted re-authorization makes exactly one `reauthorize` and one `replace` and leaves custody `held` under the re-established binding and the status `reauthorized` (a run parked `custody-expired` included); each refused presentation (another user, a closed window, a failed check, a run not awaiting) makes zero `replace` calls and leaves custody and status unchanged; an `Err` from `reestablishDelegation` leaves the record as it was. A mutant owner that replaces on a refused presentation, or writes before the guard, fails. Advisory: a regex cannot tell a re-establishing `replace` from a release. Owner rows land in Phase 3, sibling rows in the Phase 5 re-authorization Task.

### INV-8: The run deadline is fixed at establishment and never extended

**Tier:** advisory
**Owner module:** `packages/host/src/domain/delegated-custody.ts`
**Sibling entry points:**
- `packages/host/src/adapters/delegation-establishment.ts` — `establishDelegation` sets `runDeadlineMs` once, from the caller's deadline; `reestablishDelegation` builds the re-established authority only through `renewedAuthority`
- `packages/host/src/hitl/adapters/run-store.ts` — `markReauthorized` persists the re-established authority only when its `runDeadlineMs` equals the record read's
**Matrix test:** `packages/host/src/__tests__/run-deadline.matrix.test.ts`
**Statement:** A `user-delegated` run's `delegation.runDeadlineMs` is written once, at establishment, and every later authority keeps it: `renewedAuthority` is the only builder of a re-established authority and changes only `custodyExpiresAtMs` (= `custodyExpiryFor(now, max, runDeadlineMs)`, so ≤ the deadline), and the run store refuses to persist a re-established authority with another deadline (FR-027, AS-041). The matrix generates authorities, re-authorization times and custody maxima (fast-check) and asserts that the owner keeps the deadline and bounds the expiry by it and by now + max, that `reestablishDelegation` over fake transports returns the same deadline, and that `markReauthorized` over the in-memory `HitlRedisPort` persists it and refuses a changed one with nothing written; a mutant owner adding time to the deadline, or deriving the expiry from now + max alone, fails. Advisory: a regex cannot tell a copied deadline from a recomputed one. Owner rows land in Phase 2, the establishment row in Phase 3, the run-store row in the Phase 5 re-authorization Task.

---

## Contracts

### CT-1: Run-start authority admission

**Types file:** `packages/host/src/domain/run-authority-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts` — AS-010, AS-021, AS-022, AS-023, AS-037, AS-040, FR-006, FR-007, FR-008, FR-009, FR-018, FR-036
- `packages/host/src/__tests__/acceptance/run-authority-admission-budget.acceptance.test.ts` — AS-036
**Supported domain:** `packages/host/src/__tests__/acceptance/run-authority-admission.acceptance.test.ts`
**Entry point:** `packages/host/src/http/handlers/run-dag.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: tenant requests reach the worker, `X-Fugue-Tenant` stripped, the delegated header forwarded)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: identity, Entra principal included)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: admission before the HITL fork and acquire)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: two-pass admission with the real verifier, and the lifecycle)
- `errorResponse` (`packages/host/src/http/response.ts`: refusal serialization)
**Statement:** A run is admitted under exactly one `RunAuthority`, decided before any HITL fork, concurrency acquisition or token egress. A user run with only `app` capabilities is admitted as `user-app` carrying its initiator (realm sub, oid, tid); admin and team paths behave as before; CT-4 decides the attribution reaches every mint audit record and no user token is retained. Refused, each with its typed refusal and HTTP status: a DAG requiring a brokered-namespace capability the parsed catalog does not declare (`capability-unknown`, 503, naming every such node and capability, ahead of every other refusal, so it is never treated as `app`); an agent-origin (team or admin) run requiring a delegated capability (naming node and capability); a user run requiring delegation with no Entra token (the 401 names the `X-Fugue-Delegated-Authorization` header and the required audience); an invalid Entra token (bad signature, issuer, tenant, audience, expiry, non-delegated, wrong version); an otherwise valid token whose `azp` is not in `DELEGATED_CLIENT_APPS` (`delegated-token-invalid{client}`) or whose `scp` lacks `DELEGATED_SCOPE` (`delegated-token-invalid{scope}`), naming the failed check, never the `azp` or `scp` value, with zero on-behalf-of exchanges (AS-040, FR-008); a mismatched `oid` or `tid`; an Entra token sent to a run needing none; delegation on a dark delegation leg, including only `DELEGATED_CLIENT_APPS` or only `DELEGATED_SCOPE` unset (`delegation-unconfigured` naming that key). Refusals follow the Run Authority Planner's precedence. A token-carrying submission refused statically (agent-origin on a delegated DAG, unexpected token, dark leg, malformed header) makes zero JWKS requests, never answered with a lower-precedence `delegated-token-invalid`. Every submission enters at `proxyToWorker` into a worker app mounting `createAuthMiddleware` and `createRunDagHandler` in `createRouter`'s order, with `admitRunAuthority` and the lifecycle from `composeRunAuthorityWiring` over in-process transports: nothing in admission is stubbed, no `AuthIdentity` or plan hand-built. `createContext`, `executeDag` and `hitl` are recording observation points (admitted authority or plan; call counts, zero on every refusal); CT-3 and CT-4 decide what follows admission. Through the proxy a delegated submission arrives with `X-Fugue-Delegated-Authorization` byte-identical and is admitted, a forged `X-Fugue-Tenant` never reaches the worker (only the signed value), a refusal keeps the worker's status and body, and no proxy log line carries the delegated token. No credential material at run start (AS-037, FR-022): every submission (admitted, and each refusal variant, each failing verification check and a binding mismatch included) carries sentinel realm and Entra user tokens, and `assertNoCredentialMaterial` finds neither, nor any encoding or signature segment, in the responses through `proxyToWorker`, worker and proxy logs, audit records, error values, or the captured plans and authorities (a pending grant's token is a `RedactedSecret` rendering `[redacted]`). Run-start validation (realm JWT authentication, planning, delegated-token signature and claim verification through the real verifier over an in-process JWKS, binding) adds at most 50 ms p95, measured through proxy, middleware, route and admission after a warm-up absorbing the first signing-key fetch.

### CT-2: Capability authority mint path

**Types file:** `packages/host/src/domain/capability-authority-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts` — AS-001, AS-002, AS-003, AS-004, AS-005, AS-011, AS-012, AS-024, AS-025, FR-001, FR-002, FR-003, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-021, FR-022
- `packages/host/src/__tests__/acceptance/capability-authority-budget.acceptance.test.ts` — AS-035
**Supported domain:** `packages/host/src/__tests__/acceptance/capability-authority.acceptance.test.ts`
**Entry point:** `packages/host/src/adapters/capability-authority.ts`
**Runtime seams:**
- `invocationFor` (`@fuguejs/framework`: every Invocation derives from the run's MintingAuthority)
- `brokerAuditPayload` (`packages/host/src/adapters/broker-audit.ts`: every mint, reuse and refusal audit record)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the capability authority and model adapters; handles only from its lifecycle's brackets)
**Statement:** For a run's authority, each required capability yields a narrowed handle backed by a credential issued to that agent's own Entra identity; the realm assertion always carries both the Entra-exchange and the capability grant, and the two identity models are interchangeable with identical capability and DAG definitions. Caches never cross agent identity, authority mode or user; app and delegated handles in one node cannot reach each other; a delegated refusal never falls back to `app`; audit records carry run, node, agent client, Entra identity, scope, mode and initiator `oid`, no credential material. Refused: an unassigned scope (zero egress); a missing Entra-exchange or capability grant (zero Entra egress, naming it); a federation rejection (distinct from a transient failure). A delegated capability is acquired only through a `user-delegated` bracket: an app-access run has no delegated path, its handles come only from the app path. With the Entra leg dark (no presence keys, or one), every acquisition fails `authority-unavailable{authority-unconfigured}` naming the missing keys, with zero realm and Entra egress (FR-015, NFR-010). A transient realm or Entra failure (429, 5xx, timeout) surfaces as retriable `infra-unreachable` after exactly one transport call, with no internal retry (FR-015, NFR-021). Concurrent cold acquisitions for one (Entra identity, mode, capability) make exactly one realm and one Entra call, and concurrent acquisitions across agent identities, modes or users never receive each other's credential (FR-014, NFR-012). Custody is written once (D1): two `delegated` capabilities with different resources acquired concurrently in one `user-delegated` run both succeed, both refresh requests present the refresh credential establishment stored, and each redeem response's new refresh credential is discarded, so the custody record is byte-identical before and after. When Entra refuses a refresh (`invalid_grant`), the acquisition fails `reauthorization-required{refused}`, the record becomes `revoked` with no ciphertext, and every later delegated acquisition in the run fails the same with zero Entra calls and no `app` fallback. Captured request bodies prove the federation shape: every realm request is client_credentials (zero RFC 8693 bodies, FR-003), every Entra `client_assertion` is the agent's own realm assertion or its T1, never a human-subject token (FR-002), and none carries `client_secret` or a certificate assertion (FR-012). No credential material on the mint path (FR-022): with every realm assertion, T1, Entra access token, on-behalf-of access token and refresh token as sentinels, `assertNoCredentialMaterial` finds none, nor any encoding, in any log line, audit record, trace span, error value (every refusal's and failure's `formatFrameworkError` output included) or capability handle (JSON, `String()`, `Bun.inspect`); the redeem-returned refresh sentinel appears nowhere, custody included; `assertCustodyCiphertextOnly` holds after each redeem and after a refusal. With `DELEGATED_CUSTODY_MAX_SEC` unset and `HITL_RUN_TTL_SEC` at its default, the established `user-delegated` authority carries `custodyExpiresAtMs` = establishment + 604800 s (or the earlier run deadline passed in) and its custody TTL is `custodyTtlSecOf` of it (CT-3 decides FR-017 end to end). Every case takes its handle from a `withEstablishedAuthority` bracket of `composeRunAuthorityWiring`'s lifecycle, for each `ENTRA_IDENTITY_MODEL`, so adapters and request bodies are production's; delegated authorities come from the wiring's `admitRunAuthority` and that bracket, never a hand-sealed custody record. With zero-latency transports (every measured millisecond host-added), a cold acquisition through `invocationFor` and `broker.mintFor` (gate, mint, assertion inspection, Entra acquisition for both models, custody read and open when delegated, handle build, audit) takes at most 10 ms p95, each sample on a fresh wiring and handle built outside the timed region; a cache hit at most 5 ms p95 with zero transport calls.

### CT-3: Run authority continuity across suspension

**Types file:** `packages/host/src/domain/delegated-custody-contract.ts`
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts` — AS-007, AS-008, AS-020, AS-026, AS-027, AS-028, AS-038, FR-016, FR-017, FR-025, FR-023
- `packages/host/src/__tests__/acceptance/run-reauthorization.acceptance.test.ts` — AS-034, AS-041, FR-027
**Supported domain:** `packages/host/src/__tests__/acceptance/delegated-continuation.acceptance.test.ts`
**Entry point:** `packages/host/src/hitl/service.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: submissions, approvals and re-authorizations reach the worker, both auth headers forwarded)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: initiator and HTTP approver identity, Entra principal included)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: admission, then `startRun` or the sync bracket)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: admission, custody cipher and store, and the lifecycle: the only establishment, handle builder and release)
- `composeHitlRunService` (`packages/host/src/adapters/run-composition.ts`: run and decision stores, executor, queue and service over the wiring)
- `createRunContextFactory` (`packages/host/src/adapters/run-composition.ts`: the sync `createContext`)
- `createDagExecutor` (`packages/host/src/adapters/run-composition.ts`: the sync `executeDag`, minting through the bracket's handle)
- `createApproveRunHandler` (`packages/host/src/http/handlers/runs.ts`: derives the HTTP `ApproverRef`)
- `createGetRunHandler` (`packages/host/src/http/handlers/runs.ts`: the parked run's status read model)
- `createReauthorizeRunHandler` (`packages/host/src/http/handlers/runs.ts`: `POST /runs/:runId/delegation`, the only way into `reauthorizeRun`)
- `handleBotActivity` (`packages/host/src/hitl/adapters/bot/messages-handler.ts`: derives the `teams-user` `ApproverRef`)
- `createBotFrameworkNotifier` (`packages/host/src/hitl/adapters/bot/notifier.ts`: renders the review and re-authorization-required activities; faked only at `BotConnectorPort`)
- `createWebhookNotifier` (`packages/host/src/hitl/adapters/webhook-notifier.ts`: renders the same as webhook cards; faked only at `WebhookHttp`)
- `errorResponse` (`packages/host/src/http/response.ts`: approve and re-authorization refusal serialization)
**Statement:** A user run's authority survives HITL suspension and token expiry. An `app` run resumes and completes under the agent identity, with attribution taken from the record and no user token, and a sync `app` run whose later nodes execute after the inbound tokens' expiry still succeeds. A delegated run establishes its delegation once at start, holds only an AES-GCM-sealed refresh credential bound to (run, agent, oid, tid) with expiry capped at the suspension window, obtains its first on-behalf-of credential through the agent identity, redeems the sealed credential through the agent identity after resume, and acts for the original initiator whoever approves. Every run starts at `proxyToWorker` with a realm user JWT (and, when delegated, `X-Fugue-Delegated-Authorization`) through `createAuthMiddleware` into `createRunDagHandler`; HITL runs are processed by `composeHitlRunService`'s queue worker over the in-process backend, sync runs through `createRunContextFactory` and `createDagExecutor`, all fed by one `composeRunAuthorityWiring` as in host.ts. Only transports (the notifiers' `BotConnectorPort` and `WebhookHttp` beneath the production renderers included), Redis, the queue backend, the Bot Framework token verifier and the clock are fakes: no plan, authority, approver, run record or custody record is hand-built, and approvals enter only through `POST /runs/:runId/approve` and the Teams bot handler. A different realm user approving over HTTP, or a mapped Teams user from a card, is recorded as that approver (`realm-user{realmSub, entra}` or `teams-user{aadObjectId}`) in the persisted approvals and the `hitl-decision` audit record, while every delegated acquisition after resume carries the initiator's `oid`. Approving a run not suspended is refused 409 through `errorResponse`; an identity the approver authorization refuses records nothing. A sync run whose refresh is refused, or whose custody is expired or absent, never suspends: it fails HTTP 401 with the typed `authority-unavailable{reauthorization-required}` error, no `app` fallback and no credential material in the response (AS-034, S1). Through the production configuration, with `DELEGATED_CUSTODY_MAX_SEC` unset and `HITL_RUN_TTL_SEC` at its default, a delegated HITL run's custody binding expires exactly 604800 s after establishment, its TTL is `custodyTtlSecOf` of it (never beyond the binding expiry, so no ciphertext outlives the cap), and a resume one second before expiry redeems (FR-017, AS-026). Re-authorization (`run-reauthorization.acceptance.test.ts`; AS-034, AS-041, FR-027). A delegated HITL run whose refresh Entra refuses (`invalid_grant` after resume), whose custody key is deleted while suspended, or which resumes after custody expired (`DELEGATED_CUSTODY_MAX_SEC=3600`, resumed 3601 s after establishment by `setSystemTime`, zero custody reads and Entra calls) never falls back to `app`: it parks; `GET /runs/:runId` shows `awaiting-reauthorization` with the node, the accurate reason (`refused`, `custody-absent`, `custody-expired`), the delegated audience, header name, endpoint and run deadline; the owner team's channel receives exactly one re-authorization-required notice, captured at each transport as the production renderer built it (activity and card body) and naming the same fields, with no credential material (S2); completed siblings of the parked wave are not re-run. Then, through `proxyToWorker`, `createAuthMiddleware` and `createReauthorizeRunHandler`, the original initiator with a fresh realm JWT and Entra user token (sentinels) gets 202; Entra sees exactly one new on-behalf-of exchange; the replaced custody record opens to the new credential under the re-established binding, its expiry min(re-authorization time + the custody max, the run deadline); the run resumes at the parked node, every later delegated acquisition carrying the initiator's `oid`, and completes. Refused with a typed error, audited once, run left awaiting and custody unchanged: another realm user (`reauthorization-initiator-mismatch`, zero JWKS requests), an Entra token of another `oid` (`identity-binding-mismatch`), a token failing any run-start check (each `delegated-token-invalid` reason, AS-040's included), no header (`delegated-token-required`), with under one second of the run deadline left (`reauthorization-window-closed`), a run not awaiting (409). The run parked `custody-expired` (`DELEGATED_CUSTODY_MAX_SEC=3600`) is re-authorized with a fresh 3600 s window and completes; a record evicted while awaiting is released by the stale wake's `endRun(record-evicted)` and no credential is retrievable. The run deadline is never later after re-authorization. After every terminal state (HITL completed, failed including a rejected gate, record evicted; sync completed, failed, aborted by the route's timeout, the cancelled teardown) no delegated credential for the run is retrievable, through the capability authority or from the custody keyspace. No credential material across continuation (AS-038, FR-022): with inbound and re-authorization tokens, realm assertions, T1, on-behalf-of and redeemed access tokens and every refresh token (stored and redeem-returned) as sentinels, `assertNoCredentialMaterial` finds none, nor any encoding, in any HITL run record, checkpoint or approval, audit record (`hitl-decision`, `delegation-reauthorization` included), notification as rendered and captured at both transports, log line, trace span, error value, or response of the start, status, approve and re-authorization routes and the bot handler; `assertCustodyCiphertextOnly` holds at every step (after establishment, each redeem, a refusal, re-authorization), each record opening only under the deployment keyring with its own binding as AAD.

### CT-4: User-origin run attribution through execution

**Types file:** none
**No types reason:** The slice consumes CT-1's `RunAuthority` and `OriginOfFn` and CT-2's `CreateCapabilityAuthorityFn` and `RunMintingAuthority`; the host composition it pins (`NodeContextForDag`, the two `run-composition.ts` factories, `composeRunAuthorityWiring`) is host-internal wiring, not a consumer-facing surface.
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/user-run-attribution.acceptance.test.ts` — AS-006, AS-039, FR-004, FR-020
**Entry point:** `packages/host/src/adapters/run-composition.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: the submission reaches the worker; only tenant and transport reason logged)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: `sub`, `entra_oid`, `entra_tid` → `AuthenticatedUser`)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: the sync path, admission through execution)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: admission deriving the `user-app` initiator, and the capability authority)
- `createRunContextFactory` (`packages/host/src/adapters/run-composition.ts`: the `createContext` dep `buildRouterDeps` also uses)
- `createNodeContextForDag` (`packages/host/src/adapters/node-context-factory.ts`: passes the `RunAuthority` on unchanged, no origin of its own)
- `createDagExecutor` (`packages/host/src/adapters/run-composition.ts`: the `executeDag` dep, `mintingAuthorityOf` over the bracket's handle)
**Statement:** A user-origin sync run whose nodes require only `app` capabilities, submitted at `proxyToWorker` with a realm user JWT carrying `sub`, `entra_oid` and `entra_tid`, runs end to end through the declared seams over the bracket's minting handle, with in-process fake HTTP transports, for both identity models. No dep is stubbed and no `AuthIdentity`, plan or `RunAuthority` is hand-built; only transports, Redis and the clock are fakes. Every node's mint produces exactly one audit record, and each carries `authority: app`, the node's agent client and Entra identity, and `initiator{realmSub, oid, tid}` equal to the submitting user's (AS-006, FR-020); the Entra transport sees only the agent's own grants (zero on-behalf-of and zero RFC 8693 bodies). A team-origin run of the same DAG writes audit records with no initiator, the control that an attribution hard-coded in the executor fails. A sentinel inbound bearer token appears in none of the `RunAuthority` handed to `createContext`, the `NodeContextForDag` from `createNodeContextForDag` (also called directly on a `user-app` authority), `forRun`'s `RunMintingAuthority`, any realm or Entra request body, audit record or log line (the proxy's included); custody holds no record for the run (FR-004). Every node's `InvocationOrigin` equals `originOf` of the admitted authority (user origin, the initiator's realm `sub`, the DAG's agent client). No credential material on the `app` path (AS-039, FR-022): with the inbound realm JWT, realm assertion, T1 and Entra access token sentinels, `assertNoCredentialMaterial` finds none of them, nor any encoding or signature segment, in the `RunAuthority`, `RunMintingAuthority`, every `InvocationOrigin`, any capability handle's JSON, `String()` or `Bun.inspect` rendering, audit record, log line, trace span, or the run's HTTP response. A `createContext` that drops or swaps the initiator, or an `executeDag` minting through anything but the bracket's handle over that `RunAuthority`, fails the suite.

### CT-5: HITL decision record and approval audit

**Types file:** none
**No types reason:** Approvals lend no authority (AD-9), so `HitlDecision`, `ApproverRef`, `ApprovalAttempt` and `ApprovalRecord` are HITL-internal types in `hitl/types.ts`, not a consumer-facing contract surface; the acting principal shown to approvers is CT-1's `ExecutesAs`.
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/hitl-decision-record.acceptance.test.ts` — AS-043, FR-028
**Entry point:** `packages/host/src/hitl/service.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: submissions and approvals reach the worker)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: the HTTP approver's identity)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: starts the gated runs)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: the admitted authorities shown via `executesAsOf`)
- `composeHitlRunService` (`packages/host/src/adapters/run-composition.ts`: decision store, run store, executor and service)
- `createApproveRunHandler` (`packages/host/src/http/handlers/runs.ts`: the HTTP channel, authorization included)
- `createGetRunHandler` (`packages/host/src/http/handlers/runs.ts`: the approval payload with `executesAs`)
- `handleBotActivity` (`packages/host/src/hitl/adapters/bot/messages-handler.ts`: the Teams channel, activity id included)
- `createBotFrameworkNotifier` (`packages/host/src/hitl/adapters/bot/notifier.ts`: the review card as Teams shows it; faked only at `BotConnectorPort`)
- `createWebhookNotifier` (`packages/host/src/hitl/adapters/webhook-notifier.ts`: the webhook review card; faked only at `WebhookHttp`)
- `errorResponse` (`packages/host/src/http/response.ts`: approve refusal serialization)
**Statement:** At a HITL gate exactly one decision is accepted, and it is stored with its approver in one atomic first-writer-wins write: after any approval sequence, the decision key in the in-memory Redis holds one value carrying the action, the `ApproverRef`, the channel, the decision time and, for Teams, the activity id, and no state is reachable in which an accepted decision exists without its approver (FR-028). Driven only through the production channels over one `composeHitlRunService` and one `composeRunAuthorityWiring`, with a recording audit sink and both production notifiers over recording transports: a Teams click accepted, then the same activity redelivered (`duplicate`); an authorized realm user's HTTP approval, then the same user and action again (`duplicate`); a second authorized approver after the gate resolved, on either channel (`not-pending`, 409 over HTTP); a run with no pending gate or an unknown run id (`not-pending`); an identity `canAccessDag` refuses, over HTTP and from Teams (`unauthorized`, nothing written). Each attempt produces exactly one `hitl-decision` audit record with outcome and channel, after the write. The review card as each renderer delivered it to its transport (Bot Framework activity, webhook card body), the `GET /runs/:runId` review block and the approve response each state the admitted authority's acting principal (an `app` run: the agent client; a delegated run: the agent client on behalf of the initiator for exactly the delegated capabilities; never the approver), as does the accepted decision's audit record, all equal to the one `executesAsOf` value `runViewOf` computed. When the executor consumes the accepted decision, the persisted `approvals` gains exactly one `ApprovalRecord` equal to the stored decision in the checkpoint write that advances past the gate (a lost lease writes neither), then the decision key is cleared; the audit log agrees with both authoritative records (AS-043).

### CT-6: Resume-slice authority scoping

**Types file:** none
**No types reason:** The slice consumes CT-1's `AdmittedAccess`, `BrokeringNow`, `AuthorityChanged` and `CheckAdmittedAuthorityFn` and CT-3's `RunAuthorityLifecycle`; what it pins is the HITL executor's slice-start behaviour, host-internal, not a new consumer-facing surface.
**Acceptance tests:**
- `packages/host/src/__tests__/acceptance/authority-drift.acceptance.test.ts` — AS-042, FR-026
**Entry point:** `packages/host/src/hitl/adapters/run-executor.ts`
**Runtime seams:**
- `proxyToWorker` (`packages/host/src/supervisor/uds-proxy.ts`: submissions and approvals reach the worker)
- `createAuthMiddleware` (`packages/host/src/http/middleware/auth.ts`: initiator and approver identity)
- `createRunDagHandler` (`packages/host/src/http/handlers/run-dag.ts`: admission, then `startRun`)
- `composeRunAuthorityWiring` (`packages/host/src/adapters/run-authority-wiring.ts`: admission, the lifecycle and its boot `BrokeringNow`, one per simulated host)
- `composeHitlRunService` (`packages/host/src/adapters/run-composition.ts`: run store, executor, queue and service over each wiring)
- `createApproveRunHandler` (`packages/host/src/http/handlers/runs.ts`: resolves the gate, waking the resume slice)
- `createGetRunHandler` (`packages/host/src/http/handlers/runs.ts`: the failed run's status)
**Statement:** A resume slice runs only under the authority admitted at run start, checked against the host as it is now (AD-12): a HITL run suspended at a gate is approved and resumed by a second `composeRunAuthorityWiring` and `composeHitlRunService` over the same in-memory Redis (a redeployed host), and when the second host's boot catalog makes an `app`-admitted capability `delegated` (`mode-changed`), removes one (`removed`) or brokers a namespace the run passed through (`newly-brokered`), or when a run admitted `unbrokered` on a host without `REALM_JWT_ISSUER` resumes on a host with it and a requirement in a brokered namespace (`newly-brokered`), the slice fails `authority-unavailable{authority-changed}` naming exactly those capabilities before any node runs, with zero realm and Entra egress and no minting handle; `GET /runs/:runId` shows the failure and custody is released; an unchanged host resumes normally, an unbrokered run included. A resumed slice cannot widen the admitted authority (NFR-010): an `app` HITL run whose DAG is re-registered while suspended with the same nodes and edges (the resume fingerprint still matches) but a later node newly requiring a catalog capability the run was not admitted for fails that node `authority-unavailable{capability-not-admitted}` naming it, with zero egress for it and no pass-through; a node gaining a not-brokered `http` requirement still runs. Only transports, Redis, the queue backend and the clock are fakes; no plan, authority, record or catalog value is hand-built (each host parses its own test catalog).

---
## Implementation Phases

Ordered by dependency, not priority, because delegated mode (P2) reuses every P1 seam; the FR-033 realm hardening (P3) is specified in the Cross-Repo section. Decompose places the contract tasks (CT-1 to CT-6) and the LC-1 machine task in the earliest Waves their imports allow. The LC-1 machine imports CT-3 types, so it follows the CT-3 contract task. The earliest possible Task for LC-3 is the Phase 1 park seam Task, and for LC-2 the Phase 1 LC-2 Task (after the CT-2 contract Task); every Task touching a lifecycle depends on its LC Task. No judgement lands after its subject: each contract gates the Wave of the Task that builds its decided path (CT-2: Phase 3; CT-1, CT-4, CT-6: the Phase 4 cut-over; CT-5, CT-3: Phase 5).

**Phase boundary rule (every Wave leaves typecheck and the host suite green).** The rule covers signature changes as well as deletions.

*Signature changes.* A Task that changes an exported signature updates, in the same Task, every production caller and test fixture that constructs or matches it: function parameters or results, deps records (`RunDagDeps`, `HitlRunServiceDeps`, `RunExecutorDeps`, `HitlWiringArgs`, `HostDeps`, `NodeContextForDag`), ports, `.exhaustive()`-matched unions (`FrameworkError`, `HostError`, `DagPhase`, `StatefulOutcome`, `RunStatus`, `RunExecOutcome`), records gaining a required field or narrowed variant (`AuthIdentity`, `AuthenticatedUser`, `PersistedIdentity`, `RunExecutionRequest`, `HitlDecision`) and persisted schemas (`RunRecord`, the checkpoint envelope, the decision value). No Wave leaves a caller for a later one (callerless new exports exempt). Each Phase's **Files** list names what searching found (`kind: "user"` literals, `canRunDag:`, realm-claim, `identity: {` and `ownerTeam:` fixtures, `HostError` `.exhaustive()` matches, importers of changed modules); decompose re-runs those searches when cutting Tasks. Placements the rule decides:
- The framework union widening (`authority-changed` included) and the host's `framework-error-http.ts` mapping are one Phase 1 Task.
- The framework park seam (AD-13) is one Phase 1 Task with every exhaustive consumer of `DagPhase` and `StatefulOutcome` in both packages: the framework's own matches, the host's `hitl/run-store-job.ts` phase parser map and `hitl/adapters/run-executor.ts`'s `toSettledOutcome` (`parked` → `failed` until the Phase 5 re-authorization Task passes `parkOn`).
- Each HostError widening carries `domain/host-error.ts`'s exhaustive tables and `http/middleware/error-handler.ts`'s exhaustive `rawDetailsFor` in the same Task: `capability-catalog-invalid` (Phase 1), `identity-config-invalid` (Phase 2), `run-authority-refused` (Phase 4) and `run-not-awaiting-reauthorization` (Phase 5 re-authorization Task).
- `withRecordedAuthority`'s drift-checking signature exists from the owner's creation (Phase 3, no caller yet); its executor caller arrives in the Phase 4 cut-over.
- The decision value (`resolvePending`, `getDecision`, `HitlDecision`) changes in one Phase 5 approvals Task with every producer and consumer: the decision store, the service, both approval handlers, `human-review-hook.ts`, `run-store-job.ts` and their fixtures.
- `RunStatus`'s two new states change in the Phase 1 LC-2 Task with `transitionRunStatus`, the run store's status parser, every `.exhaustive()` matcher (the status view's arm prints the state, its node and reason) and their fixtures. `RunExecOutcome`, the notifier port, `RunView.reauthorization` and `HitlRunServiceDeps`' widened `Pick` and `delegatedAudience` change in one Phase 5 re-authorization Task with every matcher and constructor (`processRun`, reconciliation, the executor, both notifier adapters, the status view's awaiting block and their fixtures).
- `getRun`'s `RunView` (replacing `RunMetadata`) changes in the Phase 5 approvals Task with its callers `runs.ts` and `bot/messages-handler.ts` and their fixtures.
- The required realm Entra principal is one Phase 2 Task. It carries every constructor of a `user` `AuthIdentity` or `PersistedIdentity`, including `hitl/identity.ts` (`approverTeamIdentity`, now returning `TeamsApprover`, and `toPersistedIdentity` / `toExecIdentity`), `hitl/types.ts`, the run-store schema and the bot handler.
- The run-start cut-over is one Phase 4 Task. It is where several modules' signatures change together: `HitlRunService.startRun`, `HitlRunServiceDeps`, `RunExecutorDeps`, `RunExecutionRequest`, `RunDagDeps`, `NodeContextForDag` and `RunRecord.authority` (replacing `RunRecord.identity`), with their callers `run-dag.ts`, `hitl/service.ts`, `run-executor.ts` and the host.ts HITL and router composition; what can leave it does (Phase 4 intro).

*Deletions.* The legacy broker path (files marked DELETED in the Phase 4 legacy deletion) keeps compiling until the Phase 4 cut-over switches host.ts to `composeRunAuthorityWiring`; the legacy deletion Task then removes it. Phases 2 and 3 build replacements as new files and exports beside it, and a Task changing a module the legacy path imports (`config.ts`, `authority-legs.ts`, `token-cache.ts`, `broker-audit.ts`, `graph-capability.ts`, `capability-gate.ts`) updates the legacy importer in the same Task. From Phase 2 (`ENTRA_CLIENT_ID` removed) host.ts composes the legacy Entra hop as `unwired-entra-wif` only; that hop never reached Entra (spec Summary), so nothing working is lost before the cut-over.

### Phase 1: Foundations and demolition (no dependencies)

- Add `authority-unavailable` (its `authority-changed` cause included; AD-8, AD-12) to the framework union, `FRAMEWORK_ERROR_KINDS`, the persisted schema, `formatFrameworkError` and `retriabilityOf` (non-retriable), with tests, and in the same Task the host mapping in `domain/framework-error-http.ts` (two `.exhaustive()` matches). Export `runtimeNodeInventory` from the framework barrel.
- Create the catalog and parser (opaque `CapabilityScope`, total `authorityOf`, `brokeredNamespacesOf`, `classifyCapability`/`classifyCapabilities`); re-derive `capability-scope.ts`'s exports from it (file deleted in the Phase 4 legacy deletion); point `capability-gate.ts` (`decideGate(catalog, capability, …)` with its `unknown` arm) and `capability-registry.ts` at it, updating `decideGate`'s caller `keycloak-broker.ts` in the same Task. Write the property tests and the INV-2 matrix owner rows.
- Boot catalog entry point (AS-009, FR-005, SC-013; decompose assigns FR-005 and AS-009 to this Task, whose tests decide both faces of FR-005 and which no contract anchors): the FR-005 `@ts-expect-error` type tests in `capability-catalog.test.ts` (compile face), `loadCapabilityCatalog`, the `capability-catalog-invalid` HostError with its cases in `domain/host-error.ts`'s and `error-handler.ts`'s (`rawDetailsFor`) exhaustive tables, `HostDeps.capabilityCatalog?: unknown`, and the `createHost` call after `executeStartup` handing `deps.capabilityCatalog ?? CAPABILITY_CATALOG`, parsed, to the gate (from Phase 4 also the wiring, from Phase 5 the manifest). Write `__tests__/boot-capability-catalog.test.ts` (boot face).
- Remove the RFC 8693 user exchange end to end, preserving `app` behaviour: delete `subject-token-registry.ts` and its test, `subject-token-teardown.test.ts`, `SubjectToken`, `markSubjectToken`, `subjectTokenForIdentity`, `exchangeV2` (port in `keycloak-token-endpoint.ts`, HTTP adapter, `unwired-token-endpoint.ts` stub), `buildExchangeV2Body`, `TOKEN_EXCHANGE_GRANT_TYPE`, `inertResolveSubjectToken`, `withSubjectTokenRelease`, and `bindSubjectToken` with its resolution in `node-context-factory.ts` and `run-executor.ts`. The broker's user branch mints the agent's own client_credentials assertion, with the initiator `sub` as attribution only. Update the affected tests (`unwired-defaults.test.ts` included) and `domain/tenant.ts`'s comments citing the deleted brand. INV-1 goes green.
- **Framework park seam Task** (the LC-3 Task; AD-13; Phase boundary rule): `DagRunOpts.parkOn` and its one consultation in the DAG executor, `node-parked{nodeId, error, partialOutputs?, coFailedNodeIds?}`, the `parked{wave, nodeId, error}` phase and transition, `isHalted`, resume-as-retrying, the persisted schema, `parked` in `StatefulOutcome` and `WorkerJobOutcome`, sync `runDag`'s `err` mapping and `dag-park-seam.test.ts`; in the same Task the host's `run-store-job.ts` parser map and `run-executor.ts`'s exhaustive `toSettledOutcome` (`parked` → `failed` until the Phase 5 re-authorization Task), with tests. Without `parkOn`, behaviour is unchanged.
- **LC-2 Task** (after the CT-2 contract Task, whose `ReauthorizationReason` it imports; the re-authorization Task depends on it): `hitl/run-status.ts` (`RunStatus`, `RunStatusUpdate` and `transitionRunStatus` moved from `hitl/types.ts`, the two new states and rows), `run-status.property.test.ts`, every importer, the run store's status parser and every `.exhaustive()` `RunStatus` matcher with fixtures (Phase boundary rule); nothing produces the new states until the Phase 5 re-authorization Task.
- Write ADRs 0093, 0094, 0095 and 0096 (adr-writer agent; AS-029, FR-040). Add the successor pointers in ADRs 0055, 0056 and 0058, and the `docs/adr/README.md` rows.
- **Files:**
  - `packages/framework/src/types/errors.ts`, `packages/framework/src/index.ts`, `packages/framework/src/__tests__/authority-unavailable-error.test.ts`, `packages/host/src/domain/framework-error-http.ts` and its test (same Task as the union widening)
  - LC-2: `packages/host/src/hitl/run-status.ts`, `packages/host/src/hitl/__tests__/run-status.property.test.ts`, `hitl/types.ts`, every `RunStatus` importer and matcher (`hitl/ports.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `http/handlers/runs.ts`) and their fixtures
  - Park seam: `packages/framework/src/dag-runtime/types.ts`, `transition.ts`, `machine.ts`, `run-dag-stateful.ts`, `executor.ts`, `wave-execution.ts`, `packages/framework/src/executor/run-dag.ts`, `packages/framework/src/__tests__/dag-park-seam.test.ts`, `dag-transition.test.ts`, `dag-transition-property.test.ts`, `dag-runtime-stateful.test.ts`, every other framework `.exhaustive()` match of `DagPhase` or `StatefulOutcome` and its tests, `packages/host/src/hitl/run-store-job.ts`, `packages/host/src/hitl/__tests__/run-store-job.test.ts`, `packages/host/src/hitl/adapters/run-executor.ts`, `packages/host/src/hitl/adapters/__tests__/run-executor.test.ts`
  - `packages/host/src/domain/capability-catalog.ts`, `capability-scope.ts`, `capability-gate.ts`, `capability-registry.ts`, `adapters/keycloak-broker.ts` (the `decideGate` caller), `domain/host-error.ts`, `http/middleware/error-handler.ts`, `domain/__tests__/capability-catalog*.test.ts`, `domain/__tests__/capability-gate.test.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `packages/host/src/__tests__/authority-mode.matrix.test.ts`, `packages/host/src/__tests__/boot-capability-catalog.test.ts`
  - Demolition: `adapters/subject-token-registry.ts`, `adapters/__tests__/subject-token-registry.test.ts`, `__tests__/subject-token-teardown.test.ts`, `domain/auth.ts`, `domain/run-context.ts`, `domain/tenant.ts` (comments only), `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `adapters/keycloak-token-endpoint.ts`, `adapters/keycloak-token-endpoint-http.ts`, `adapters/unwired-token-endpoint.ts`, `adapters/keycloak-broker.ts`, `adapters/node-context-factory.ts`, `hitl/adapters/run-executor.ts`, `host.ts`, plus their tests (`__tests__/middleware/auth.test.ts`, `__tests__/node-context-factory.test.ts`, `__tests__/broker-selection.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `adapters/__tests__/keycloak-token-endpoint-http.test.ts`, `adapters/__tests__/unwired-defaults.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`)
  - `docs/adr/0093-*.md`, `0094-*.md`, `0095-*.md`, `0096-*.md`, `docs/adr/0055-*.md`, `0056-*.md`, `0058-*.md`, `docs/adr/README.md`

### Phase 2: Identity topology, ports and verification (depends on Phase 1)

- Rewrite the Entra keys in `config.ts` (`DELEGATED_CUSTODY_MAX_SEC` optional positive integer, malformed → `loadConfig` refusal naming it; `DELEGATED_CLIENT_APPS`, `DELEGATED_SCOPE`, no defaults, D4) and make `authority-legs.ts` return `Result` (Component Design › Identity Topology; `delegatedAudienceFor` is the INV-5 owner). Write the unit and property tests and the INV-5 matrix owner rows. In the same Task: host.ts maps a fault list to the `identity-config-invalid` HostError `createHost` returns before the router is built (cases in `host-error.ts`'s and `error-handler.ts`'s exhaustive tables), composes the legacy Entra hop as `unwired-entra-wif`, and the `ENTRA_CLIENT_ID` fixtures in `config-security.test.ts`, `authority-legs.test.ts` and `broker-selection.test.ts` change.
- First the acquisition-fault vocabulary both HTTP adapters return: `domain/token-endpoint-error.ts` (`classifyTokenEndpointError`) and `domain/acquisition-fault.ts` (`frameworkErrorOf`, `runAuthorityRefusalOf`), each with its property test (AD-8).
- The realm assertion mint port, HTTP and unwired adapters and `inspectFederatedAssertion` (AD-4); the Entra agent authority port, shared endpoint module and agent-id, app-registration and unwired adapters (AD-3). The legacy `keycloak-token-endpoint(-http).ts`, `unwired-token-endpoint.ts`, `entra-wif.ts` and `unwired-entra-wif.ts` stay until the Phase 4 legacy deletion.
- `domain/redacted-secret.ts` (runtime of CT-1's `RedactedSecret`) with its property test.
- **Required realm Entra principal: one Task** (Phase boundary rule): `entra_oid`/`entra_tid` required realm claims, and `entra` required on `AuthenticatedUser`, the `user` `AuthIdentity` and the `user` `PersistedIdentity`, with every constructor and matcher:
  - Production: `domain/jwt-validation.ts`, `domain/auth.ts` (adds `TeamsApprover`; `canAccessDag(AuthIdentity | TeamsApprover)`), `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `hitl/identity.ts` (`approverTeamIdentity(map, EntraObjectId)` returns `TeamsApprover | undefined`, never a fabricated realm principal; `toPersistedIdentity`/`toExecIdentity` carry `entra`), `hitl/types.ts`, `hitl/adapters/run-store.ts`, and `hitl/adapters/bot/messages-handler.ts` (parses `from.aadObjectId` with `parseEntraObjectId`).
  - Tests and fixtures: `domain/__tests__/jwt-validation.test.ts`, `adapters/__tests__/realm-jwt-verifier.test.ts`, `__tests__/middleware/auth.test.ts` (no claims → 401 naming them), `__tests__/supervisor/supervisor.test.ts`, `__tests__/domain/auth.test.ts`, `__tests__/domain/tenant.test.ts`, `__tests__/handlers/run-dag.test.ts`, `__tests__/node-context-factory.test.ts`, `__tests__/integration/mapped-host-composition.test.ts`, `adapters/__tests__/keycloak-broker.test.ts`, `hitl/__tests__/identity.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts`, `hitl/adapters/bot/__tests__/bot.test.ts` (GUID approver ids, plus a malformed-id case).
- Entra user token claim validation with `issuerFor`, `jwksUriFor`, the `azp` allowlist and `scp` containment (`client`, `scope` reasons; AD-7), and `verifyEntraUserToken(step, jwks, signal)` over the JWKS transport (no port).
- The two-pass planner (AD-5) with each pass's refusal subset, `accessOf`, `parseRunAccess` (`passThrough` included), `admittedCapabilityOf` (catalog module), `routeRequirement`, `checkAdmittedAuthority` (AD-12), `planReauthorization` over the shared `expectationFor` (AD-13), `executesAsOf` (AD-9), `bindAdmission`, `parseRunAccess` and `parseRunAuthority` (`UnbrokeredAccess` included; run-store caller in Phase 4), `boundAuthorityOf` (IN-6), the binding and `originOf`; all new exports with no caller yet. Extend the INV-2 matrix with `run-authority.ts` (drift row included) and add its INV-5 row (pass 1 builds the expectation).
- The custody cipher, store port, Redis store (`put` SET NX, `replace` SET, `revoke` over `setIfValue`, whole-second TTLs, no Lua), the test fake in `__tests__/fixtures/`, and the LC-1 machine with the rest of `domain/delegated-custody.ts` (File Structure › Host: delegated custody; `renewedAuthority` and the INV-8 matrix owner rows included) and both property tests.
- **Files:** `domain/config.ts`, `domain/authority-legs.ts`, `domain/host-error.ts`, `http/middleware/error-handler.ts`, `host.ts`, `domain/port/*.ts`, `domain/token-endpoint-error.ts`, `domain/acquisition-fault.ts`, `domain/federated-assertion.ts`, `domain/entra-user-token.ts`, `domain/redacted-secret.ts`, `domain/run-authority.ts`, `domain/capability-catalog.ts` (`admittedCapabilityOf`), `domain/jwt-validation.ts`, `domain/auth.ts`, `domain/delegated-custody.ts`, `adapters/realm-assertion-mint-http.ts`, `adapters/unwired-realm-assertion-mint.ts`, `adapters/entra-token-endpoint.ts`, `adapters/entra-agent-id-authority.ts`, `adapters/entra-app-registration-authority.ts`, `adapters/unwired-entra-agent-authority.ts`, `adapters/entra-user-token-verifier.ts`, `adapters/custody-cipher.ts`, `adapters/delegated-custody-store-redis.ts`, `__tests__/fixtures/delegated-custody-store-fake.ts`, `http/middleware/auth.ts`, `http/authenticate-identity.ts`, `hitl/identity.ts`, `hitl/types.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/bot/messages-handler.ts`, their tests, the fixtures named in the required-principal Task, `domain/__tests__/config-security.test.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `__tests__/authority-mode.matrix.test.ts`, `__tests__/delegated-audience.matrix.test.ts`, `__tests__/run-deadline.matrix.test.ts`, `__tests__/broker-selection.test.ts` and `adapters/__tests__/unwired-defaults.test.ts`. Nothing is deleted in this phase.

### Phase 3: Capability authority and delegation establishment (depends on Phase 2)

- `run-custody-cell.ts` (the stateless sequencer) with its test; `capability-authority.ts` (Component Design › Capability Authority), replacing `keycloak-broker.ts` at the Phase 4 cut-over, with its property test (concurrent-capabilities interleavings over write-once custody). The cache key ADT encodes to the string `token-cell.ts` already takes (`token-cell.ts` unchanged, `token-cache.test.ts` changes); the legacy `cacheKey` stays until the legacy deletion. Migrate the non-legacy `capability-scope.ts` importers (`graph-capability.ts`, `config.ts` scope validation) to the catalog. Extend `broker-audit.ts` with the legacy broker's call. Add `gateAdmitted` (new export; legacy `decideGate` untouched) with its `capability-gate.test.ts` cases. Extend the INV-2 matrix with `capability-authority.ts`.
- `delegation-establishment.ts` (`establishDelegation`, AD-6; `reestablishDelegation`, AD-13), `domain/custody-release.ts` with its property test, and the INV-4, INV-6 and INV-7 owner `run-authority-lifecycle.ts` (over the capability authority and the boot `BrokeringNow`; `AuthorizedRun`'s private constructor, `mintingAuthorityOf`, the drift check, `reauthorize`). Write `run-authority-lifecycle.test.ts` and the owner rows of INV-4 (establishment failed with a failed or ambiguous `put`, body rejection, persist failure, failing delete), INV-6 (one handle per brokered bracket, none unbrokered or on drift) and INV-7 (`reauthorize` under a fresh expiry, custody untouched on `Err`), and the INV-8 `reestablishDelegation` row. Sibling rows wait for the Phase 4 cut-over (INV-4, INV-6) and the Phase 5 re-authorization Task (INV-7).
- `run-authority-admission.ts` and `run-authority-wiring.ts` (Component Design › Run Admission), the only production composition of the identity subsystem, always over the Redis custody store (D2). Add the INV-5 establishment row. CT-2 acceptance takes its handles from the wiring's lifecycle bracket, so it lands here with the mint path.
- Create `acceptance/support/credential-sentinel.ts`. This phase answers for FR-022 on the mint path and the NFR-002 budgets: both CT-2 acceptance files run through `composeRunAuthorityWiring` and gate this phase's Wave.
- **Run-composition extraction Task** (signature-preserving, independent, may take the first Wave): move `createRunContextFactory`, `createDagExecutor`, `composeHitlRunService`, `createHitlExecutor`, `syncRunOptions`, `HitlWiringArgs` and the host-local `RunAuthority` record (renamed `LegacyRunBroker`, freeing the CT-1 name; the cut-over deletes it) from host.ts into `adapters/run-composition.ts`, which imports no boot code; host.ts imports them back, and `syncRunOptions`' two test importers (`fan-cap-wiring.test.ts`, `integration/mapped-host-composition.test.ts`) change in the same Task.
- **Files:** `host.ts`, `adapters/run-composition.ts`, `__tests__/fan-cap-wiring.test.ts`, `__tests__/integration/mapped-host-composition.test.ts` (extraction Task); `adapters/run-custody-cell.ts`, `adapters/capability-authority.ts`, `adapters/keycloak-broker.ts` (legacy importer updates only), `adapters/broker-audit.ts`, `adapters/graph-capability.ts`, `domain/capability-gate.ts`, `domain/__tests__/capability-gate.test.ts`, `domain/token-cache.ts`, `domain/__tests__/token-cache.test.ts`, `domain/config.ts`, `adapters/delegation-establishment.ts`, `domain/custody-release.ts`, `adapters/run-authority-lifecycle.ts`, `adapters/run-authority-admission.ts`, `adapters/run-authority-wiring.ts`, `__tests__/acceptance/support/credential-sentinel.ts`, their tests, `__tests__/authority-mode.matrix.test.ts`, `__tests__/custody-release.matrix.test.ts`, `__tests__/minting-handle.matrix.test.ts`, `__tests__/custody-reestablishment.matrix.test.ts`, `__tests__/run-deadline.matrix.test.ts` and `__tests__/delegated-audience.matrix.test.ts`

### Phase 4: Run-start cut-over: admission, HITL establishment and composition (depends on Phase 3)

The Phase boundary rule forbids splitting `HitlRunService.startRun`, `HitlRunServiceDeps` and `RunExecutorDeps` from their callers (`run-dag.ts`, the host.ts HITL composition), so the switch is one Task, kept small: the composition move is done (Phase 3), additive Tasks precede it, the legacy deletion follows it.

- **Additive Tasks** (no signature with an outside caller; may take an earlier Wave): `http/delegated-token-header.ts` (`parseDelegatedTokenHeader` → `DelegatedHeader`) with its test; the `run-authority-refused{refusal}` HostError with every exhaustive `HostError` matcher (status table, one status per `RunAuthorityRefusal` kind, `capability-unknown` 503 included; `discloseHostError`; snapshots; `rawDetailsFor`).
- **The cut-over Task: one Task, one Wave**, every coupled signature with every caller and fixture:
  - `http/handlers/run-dag.ts` (Component Design › Run Admission): `RunDagDeps` gains `admitRunAuthority` and `runAuthority`; `createContext` takes a `RunAuthority`, `executeDag` the bracket's `AuthorizedRun`.
  - `hitl/service.ts`: one `establishForRecord` in `startRun(admitted, input)`, the `ProcessRunOutcome` fold and one `endRun` in `processRun`; `HitlRunServiceDeps.runAuthority` narrowed, `newRunId` removed.
  - `hitl/types.ts`, `hitl/ports.ts`, `hitl/identity.ts`, `hitl/adapters/run-store.ts`: `RunRecord.authority` (the bare `RunAuthority`, IN-6) and `RunExecutionRequest.authority` (`boundAuthorityOf(record)`) replace `identity` (AD-9); `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` deleted; `approverTeamIdentity` stays.
  - `hitl/adapters/run-executor.ts`: `RunExecutorDeps.broker` → `runAuthority: Pick<RunAuthorityLifecycle, "withRecordedAuthority">`; one call per slice with the DAG's runtime-inventory requirements, minting through `mintingAuthorityOf`; `authority-changed` settles `failed` before any node runs (AD-12).
  - `adapters/node-context-factory.ts`: `NodeContextForDag{ctx, authority, meterMintedLlm}`, no origin, no unmapped-DAG throw.
  - `host.ts`: one `composeRunAuthorityWiring` per host over the boot catalog and `HostDeps.identityTransports` (fetch-based default), `identity-config-invalid` on faults, feeding `buildRouterDeps` and the HITL composition; `run-composition.ts`'s `createRunContextFactory(config, sharedInfra, routedTenant)`, `createDagExecutor(config)` and `HitlWiringArgs.runAuthority` (replacing `broker`) change with it and `LegacyRunBroker` goes; `selectCapabilityBroker`, `selectRunAuthority` and `HostDeps.capabilityBroker` removed. Afterwards no production module imports the legacy path.
  - Tests and fixtures (search `createRunDagHandler`, `createNodeContextForDag`, `createRunExecutor`, `startRun(`, `capabilityBroker`, `identity: {`, `ownerTeam:`): rewrites of `broker-selection.test.ts`, `entrypoint-wiring.test.ts`, `full-lifecycle.test.ts` T8, `node-context-factory.test.ts`, `run-executor.test.ts`; fixtures in `__tests__/handlers/run-dag.test.ts`, `__tests__/handlers/hitl-http.test.ts`, `__tests__/integration/mapped-host-composition.test.ts`, `__tests__/integration/dag-isolation.test.ts`, `__tests__/integration/mapped-process-resume.test.ts`, `__tests__/fixtures/mapped-resume-worker.ts`, `hitl/__tests__/service.test.ts`, `hitl/__tests__/service-admission.test.ts`, `hitl/__tests__/identity.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts`, `hitl/adapters/bot/__tests__/bot.test.ts`; new `handlers/run-dag-authority.test.ts`, `adapters/__tests__/run-composition.test.ts`, `boot-identity-refusal.test.ts` (AS-013, AS-033, NFR-020 at `createHost`); the INV-4 and INV-6 sibling rows.

  Any split leaves a Wave where `startRun`, the HITL or executor deps, the execution request or the record schema disagree with a caller; splitting the route's sync and HITL branches would need both brokers and a second `NodeContextForDag` shape (a shim).
- **Legacy deletion Task** (after the cut-over): `keycloak-broker.ts`, `domain/auth.ts`'s `agentClientIdFromFrameworkOrigin`, `keycloak-token-endpoint.ts`, `keycloak-token-endpoint-http.ts`, `unwired-token-endpoint.ts`, `entra-wif.ts`, `unwired-entra-wif.ts`, `capability-scope.ts` and their tests (`capability-scope.test.ts` included), the catalog `decideGate` with its `unknown` arm and test cases, the legacy `cacheKey` with its `token-cache.test.ts` cases (`compositeKey` stays if `cacheKeyOf` uses it), `unwired-defaults.test.ts`'s legacy rows, and comments citing them (`domain/config.ts`, `hitl-transport-selection.test.ts`, `full-lifecycle.test.ts`).
- Gating this phase's Wave (NFR-003; FR-022 at run start and on the `app` path; FR-026): CT-1 acceptance (AS-037 sentinels, proxy forwarding, zero-JWKS static refusals), the CT-1 budget file (AS-036), CT-4 acceptance (AS-039) and CT-6 acceptance (AS-042, FR-026: drift and widening at a resume slice, over the approve route, `GET /runs/:runId` and `composeHitlRunService` as they stand after the cut-over). Decompose assigns CT-1's, CT-4's and CT-6's Requirements to the cut-over Task, which builds the executor's drift call. CT-3 also needs the approval (AS-028) and re-authorization (AS-034, AS-041) paths, so its Requirements go to the Phase 5 re-authorization Task.
- **Files:** `http/delegated-token-header.ts`, `domain/host-error.ts`, `http/middleware/error-handler.ts`, `domain/__tests__/host-error.test.ts`, `__tests__/middleware/error-handler.test.ts`, `http/handlers/run-dag.ts`, `hitl/types.ts`, `hitl/ports.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/run-executor.ts`, `adapters/node-context-factory.ts`, `domain/run-context.ts`, `host.ts`, `adapters/run-composition.ts`, `adapters/__tests__/run-composition.test.ts`, `__tests__/broker-selection.test.ts`, `__tests__/entrypoint-wiring.test.ts`, `__tests__/integration/full-lifecycle.test.ts`, `__tests__/node-context-factory.test.ts`, `hitl/adapters/__tests__/run-executor.test.ts`, the fixtures listed in the cut-over Task, `__tests__/handlers/run-dag-authority.test.ts`, `__tests__/custody-release.matrix.test.ts`, `__tests__/minting-handle.matrix.test.ts`, `__tests__/boot-identity-refusal.test.ts`, the CT-1, CT-4 and CT-6 acceptance files; legacy deletion: the files its Task names

### Phase 5: Approvals, re-authorization and manifest (depends on Phase 4)

- **Approvals Task** (AD-9, D7; the decision value changes with every producer and consumer): the decision and approval types in `hitl/types.ts`; `RunRecord.approvals` in the checkpoint envelope, parsed (a `teams-user` id through `parseEntraObjectId`); `resolvePending` writing the whole value in its one `SET NX`, `already-resolved` returning the stored decision; `getDecision` parsing it; `human-review-hook.ts` passing `actor = approverDisplayOf(approver)`; `run-store-job.ts` appending the `ApprovalRecord` in the guarded checkpoint write past the gate; `hitl/decision.ts` with its property test; the approver mapping in `hitl/identity.ts`; `runViewOf` (the one `executesAsOf` call, AD-9) and `getRun`'s `RunView` with its callers; `executesAs` printed on both notifiers' review card; one `hitl-decision` audit per attempt; `approver-authority.test.ts`. `recordApproval` replaces `recordDecision` with its two callers: `createApproveRunHandler` (authorizes, derives the `ApproverRef` from the middleware's `AuthIdentity`, returns outcome and the `RunView`'s `executesAs`, also in the `GET /runs/:runId` review block) and `handleBotActivity` (`teams-user{aadObjectId}` from the `TeamsApprover`, the activity id, a `duplicate` answered idempotently). Every `RunRecord` fixture, decision-store fixture and `recordDecision` caller changes in the same Task: `hitl/__tests__/service.test.ts`, `human-review-hook.test.ts`, `run-store-job.test.ts`, `__tests__/handlers/hitl-http.test.ts`, `hitl/adapters/bot/__tests__/bot.test.ts`, `hitl/adapters/__tests__/redis-stores.test.ts`, `run-executor.test.ts`, `__tests__/fixtures/mapped-resume-worker.ts`. CT-5 acceptance gates this phase's Wave; decompose assigns CT-5's Requirements to this Task.
- **Re-authorization Task** (AD-13, D6; after the approvals Task, extending the service and notifiers), each with every matcher and fixture: `markReauthorized` (its INV-8 deadline guard included), `RunExecOutcome.awaiting-reauthorization`, the executor's `parkOn: isReauthorizationRequired` and `parked` → `awaiting-reauthorization` settle, `processRun` and reconciliation, `RunView.reauthorization` and the `RunNotification` union over both notifiers, `reauthorizeRun`, `HitlRunServiceDeps.runAuthority`'s `"reauthorize"`, `verifyReauthorization` and `delegatedAudience` (with `RunAuthorityWiring.delegatedAudience`), the `run-not-awaiting-reauthorization` HostError with its exhaustive tables, `createReauthorizeRunHandler` and its router line, and the status view's awaiting block. Tests: `hitl/__tests__/reauthorize-run.test.ts`, the INV-7 sibling rows, the INV-8 run-store row and the INV-5 `planReauthorization`, service and `runs.ts` rows. FR-022 across continuation: both CT-3 acceptance files (AS-038 sentinels over the rendered notifications, parked reasons, the sync 401) gate this phase's Wave; decompose assigns CT-3's Requirements to this Task.
- **Manifest Task.** The manifest authority block over the boot catalog and `delegatedAudienceFor`, publishing the required delegated scope; requirements go through `classifyCapabilities`, so a DAG with an unknown capability publishes the `capability-unknown` requirements it would be refused for, not a mode. Its handler deps change with their `buildRouterDeps` caller and `__tests__/handlers/manifest.test.ts`. Extend the INV-2 and INV-5 matrices with `manifest.ts`; write `manifest-authority.test.ts`.
- **Files:** `hitl/types.ts`, `hitl/ports.ts`, `hitl/decision.ts`, `hitl/identity.ts`, `hitl/service.ts`, `hitl/human-review-hook.ts`, `hitl/run-store-job.ts`, `hitl/adapters/decision-store.ts`, `hitl/adapters/run-store.ts`, `hitl/adapters/run-executor.ts`, `hitl/adapters/bot/notifier.ts`, `hitl/adapters/webhook-notifier.ts`, `hitl/adapters/bot/messages-handler.ts`, `http/handlers/runs.ts`, `http/router.ts`, `domain/host-error.ts`, `http/middleware/error-handler.ts`, `http/handlers/manifest.ts`, `adapters/run-composition.ts`, `adapters/run-authority-wiring.ts` (`delegatedAudience`), `host.ts`, `hitl/__tests__/decision.property.test.ts`, `hitl/__tests__/approver-authority.test.ts`, `hitl/run-status.ts`, `hitl/__tests__/run-status.property.test.ts`, `hitl/__tests__/reauthorize-run.test.ts`, `hitl/adapters/__tests__/webhook-notifier.test.ts`, the record, decision and `recordDecision` fixtures listed in the approvals Task, `__tests__/handlers/manifest.test.ts`, `__tests__/handlers/manifest-authority.test.ts`, `__tests__/authority-mode.matrix.test.ts`, `__tests__/custody-reestablishment.matrix.test.ts`, `__tests__/run-deadline.matrix.test.ts`, `__tests__/delegated-audience.matrix.test.ts`, the CT-3 and CT-5 acceptance files

### Phase 6: Documentation (depends on Phase 5)

- No trailing verification Task: the SC-011 budgets and the SC-007 / FR-022 sentinel assertions are contract acceptance gated in the phases that build their surfaces (INV-3).
- Write the docs, doc-lint and tests listed in File Structure › Docs, ADRs and doc-lint (contents there; ADRs are Phase 1's): AS-014, AS-030, AS-031, AS-032, FR-041, FR-043. The delegated-mode content follows the user's design review:
  - **Revocation (D3).** AD-6's semantics; the runbook lists the cut-offs: disable the user, `revokeSignInSessions` for the user, or end the run (reject it at its gate, or let it expire); a password change or reset does NOT revoke.
  - **Delegated-scope hardening (D4).** Pre-authorize only the `DELEGATED_CLIENT_APPS` clients on the blueprint's (or agent app's) exposed scope, set `DELEGATED_SCOPE` to that scope, and disable user consent for it.
  - **Spike items (D8), each with pass/fail criteria and the build's fail-closed behaviour:** (a) on-behalf-of with `offline_access` returns a `refresh_token` (pass: present; fail: establishment refuses `delegation-not-established{unconfigured}` naming `offline_access`, zero custody writes); (b) admin consent of inheritable delegated permissions on the blueprint lets child agent identities do on-behalf-of (pass: 2xx; fail: AADSTS82014 or 65001 → `unconfigured`, 503); (c) the blueprint honours `requestedAccessTokenVersion: 2` (pass: user tokens carry `ver` 2.0 and the v2 issuer; fail: `delegated-token-invalid{version}`); (d) whether Conditional Access sign-in frequency refuses refresh before the custody cap (record the observed interval; a refusal parks the run `awaiting-reauthorization{refused}`, which tells the operator how often FR-027 re-authorization occurs).
  - **Re-authorization procedure (D6).** The `reauthorization-required` notification, `GET /runs/:runId`'s awaiting block, and the initiator's `POST /runs/:runId/delegation` with fresh tokens.
- **Files:** `packages/host/docs/auth.md`, `packages/host/docs/data-handling.md`, `packages/host/docs/identity-chain-sequence.md`, `docs/team-security-and-capabilities.md`, `docs/runbooks/entra-fugue-agents-provisioning.md`, `docs/runbooks/identity-live-verification-evidence.md`, `docs/spikes/2026-06-10-spike-4-identity-chaining-e2e.md`, `CONTEXT.md`, `scripts/check-identity-docs.ts`, `scripts/__tests__/check-identity-docs.test.ts`, `scripts/verify.sh`

---

## Testing Strategy

Canonical homes: per-file unit, integration and property obligations are the test-file entries in File Structure; acceptance obligations are the CT statements; owned-invariant matrices are INV-2 and INV-4 to INV-8. Fakes exist for every port.

- **Property tests** use fast-check: the `*.property.test.ts` files (the LC-1 and LC-2 machines'; LC-3's is `dag-transition-property.test.ts`), `authority-unavailable-error.test.ts`, `federated-assertion.test.ts`, `entra-user-token.test.ts`, `redacted-secret.test.ts` and the matrix tests over generated catalogs, directories and authorities. The token-endpoint classifier and the fault projections are property-tested once, in `domain/__tests__`.
- **Integration over fakes:** the JWKS transport is the verifier's seam (no port). `hitl/adapters/__tests__/redis-stores.test.ts` also round-trips a persisted authority, its access included.
- **Acceptance:** CT-1 to CT-6 over the production composition, with CT-3 resuming after the inbound tokens expire (SC-006) by `setSystemTime`; the FR-022 sentinel assertions in CT-2 (Phase 3), CT-1 and CT-4 (Phase 4) and CT-3 (Phase 5) through `credential-sentinel.ts`; notifications judged as rendered, faked only at the notifier transports.
- **Boot refusals** (AS-009, AS-013, AS-033) have no run-time contract path and are decided by `boot-capability-catalog.test.ts` and `boot-identity-refusal.test.ts` in the phases that build them. FR-005 is a definition rule, not run-time behaviour, so no contract anchors it: the Phase 1 boot catalog Task's `@ts-expect-error` type tests (compile face) and `boot-capability-catalog.test.ts` (boot face) decide it. CT-6 decides the run-time scoping (`capability-not-admitted`, NFR-010).

**Latency budget tests (NFR-002, NFR-003, SC-011; AS-035, AS-036):** harness, sampling and testcase names in `plan-reference.md#latency-budget-tests`.

### Acceptance seam sweep and self-audit

Each acceptance-decided Requirement is traced along its production path under the runtime-seam rule; the declared seams are the CT lists. Fakes only at the network (`IdentityTransports`, the realm signature verifier, the Bot Framework token verifier), storage (`RedisPort`, `HitlRedisPort`, `QueueBackend`), notifier-transport (`BotConnectorPort`, `WebhookHttp`) and clock edges, plus recording observation points for deps another contract decides. Per-contract sweeps and every self-audit (all rows pass; loop-back 12's last): `plan-history.md`. The **Phase boundary rule** is binding on decompose and implementers; rules applied at several sites but deliberately not owned are in the OWN rows there.
---

## Security & NFR Notes

Trust boundaries, fail-closed rules, revocation, approval integrity, credential hygiene, probe surface, blast radius, the UDS proxy, deploy order, performance and retention: `plan-reference.md#security-and-nfr-notes` (moved verbatim in loop-back 12; each note points at its canonical home here).

---

## Verification

1. `bun run --cwd packages/framework typecheck && bun run --cwd packages/host typecheck`
2. `bun run --cwd packages/framework test` and `bun run --cwd packages/host test`: all green. The admin and team token tests are unchanged (SC-010).
3. `bun test packages/host/src/__tests__/acceptance/`: CT-1 to CT-6 green.
4. `bun scripts/check-doc-links.ts && bun scripts/check-identity-docs.ts`
5. `bun "/home/peterstorm/.dotfiles/.claude/local-marketplace/plugins/loom/engine/src/cli.ts" helper validate-lint-rules`, then the full-tier lint: INV-1 has zero hits.
6. The SC-011 budgets are part of step 3: `capability-authority-budget.acceptance.test.ts` and `run-authority-admission-budget.acceptance.test.ts` print their p95 values and fail above 10/5 ms and 50 ms.
7. Realm repo: the Maven tests in the Cross-Repo section pass. Live-tenant verification is the operator's job, using `docs/runbooks/identity-live-verification-evidence.md` (OOS-001).

**Operator prerequisites (installed; keep as is when Tasks are repopulated).** `.loom/verification-manifest.json` is schema 2, installed at the decompose approval (`clarifications/log.md`, "Decompose approval and verification manifest"), and already serves the owned invariants (INV-2, INV-4 to INV-8, mutation-verified) and the six contracts:

1. An `affectedRunner` and an `acceptanceRunner`: bun test with a JUnit reporter over `{files}`, 240000 ms, each with a `required-file` report.
2. JUnit wave checks: `project:framework-test`; `project:host-test` (all of `packages/host/src` except `signals.test.ts`, the acceptance directory included); `project:host-signals-test` (`signals.test.ts` isolated); `project:scripts-test`.
3. Report-less wave checks: `project:framework-typecheck`, `project:host-typecheck`, `project:doc-links`.
4. The six pre-existing operator checks, unchanged.

Deliberately absent: a `project:identity-acceptance` check and a `bun run --cwd packages/host test` check. The gate excuses a red acceptance testcase only from a JUnit report whose runner is the check's last step; that script chains two `bun test` calls and writes no report, so it would block every Wave between a contract's Wave and its claimant's. bun exits 1 on an empty path set, so a separate acceptance check would fail before the acceptance directory exists; `project:host-test` covers that directory. Verification steps 2 and 3 above are the operator's local run, not manifest checks.

---

## Cross-Repo Realm Work (executed outside the task graph)

This section is executed by the operator or a separate session in the worktree `/home/peterstorm/dev/java/keycloakConfigAsCode-agent-identity` (branch `feat/fugue-agent-identity`), never in `/home/peterstorm/dev/java/keycloakConfigAsCode`. No Fugue task depends on it. Fugue tasks code against the claim names and grant semantics below, and test them with fakes.

### Interface contract with the host (fixed by this plan)

| Item | Value |
|---|---|
| User access token claims (frontend clients) | `entra_oid` (string, Entra object id), `entra_tid` (string, Entra tenant id); always present for Entra-brokered users |
| Agent mint | client_credentials with `scope="entra-exchange <capability>"`; `entra-exchange` adds `aud=api://AzureADTokenExchange` (existing `ENTRA_EXCHANGE_AUDIENCE`); no other audience on agent assertions |
| Unassigned optional scope | `invalid_scope` (or omission), which the host treats as a missing grant |
| Agent clients | `standard.token.exchange.enabled=false`; client_credentials only |
| Broker tokens | `azuread` IdP `storeToken=false` |

### Realm work items (full text: `.claude/specs/2026-11-24-agent-identity-redesign/cross-repo-realm.md`)

- R1: Entra object id and tenant into user tokens (FR-030, AS-015)
- R2: No user exchange in the realm (FR-031, AS-016)
- R3: Exact scope assignment and Entra-exchange placement (FR-032, AS-017)
- R4: Stop storing broker tokens (FR-035)
- R5: Idempotent reconcile or explicit reject (FR-034, AS-018)
- R6 (P3): Opt-in predictable service-account subject (FR-033, AS-019)
- Types, tests (jqwik checks, golden export, external integration against Keycloak 26.8.2) and acceptance (`mvn -pl java-configuration test`; every SC-005 seeded misconfiguration detected; re-apply makes zero changes)

---

## Change Log

History, per-loop-back detail (initial plan and loop-backs 1 to 12) and the self-audits: `.claude/specs/2026-11-24-agent-identity-redesign/plan-history.md`. Loop-backs 7, 11 and 12 condensed this plan losslessly for the read budget (loop-back 12 also into `plan-reference.md`).

- 2026-11-25, loop-back 12 (plan alignment; S1, S2 decided by the user): HITL runs park, sync runs fail 401, owner-team notice and `GET` awaiting view (AS-034); unbrokered drift (`UnbrokeredAccess`, `BrokeringNow`); CT-6 gates drift in Phase 4; LC-2, LC-3; FR-005 on the boot catalog Task; production notifiers as seams; one `executesAsOf` site; INV-4 split into INV-4, INV-6 to INV-8; INV-5 siblings; IN-6 (`boundAuthorityOf`); installed manifest.

