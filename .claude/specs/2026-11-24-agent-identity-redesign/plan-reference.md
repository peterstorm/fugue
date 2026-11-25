# Plan reference: Agent Identity Redesign

Companion of `.claude/plans/2026-11-24-agent-identity-redesign.md`, moved verbatim from it in loop-back 12 (plan alignment) to keep the plan within the engine's read budget. The plan's Component Design remains the single specification of each step; nothing here adds behaviour.

## Data Flow

Each step is specified once in Component Design; this is the composed view.

```
Run start:  proxyToWorker → createAuthMiddleware (AuthenticatedUser{entra}) → createRunDagHandler → parseDelegatedTokenHeader
  → admitRunAuthority: pass 1 planRunAuthority(requirementsOf(runtimeNodeInventory)) ─refusal→ run-authority-refused (0 JWKS, 0 slot, 0 egress)
      ─decided→ plan (agent | user-app{initiator{realmSub, oid, tid}} | unbrokered; no token retained)
      ─verify-delegated→ verifyEntraUserToken (JWKS transport) → pass 2 admitDelegatedPresentation → user-delegated-pending{access, grant}
  → AdmittedRun{runId, dagId, ownerTeam, plan}
  → HITL: startRun(admitted) → establishForRecord(admitted, runTtl, persist = create record{bound.runId, bound.authority})
    sync: acquire → withEstablishedAuthority(admitted, durationOfMs(timeout), body(run, deadlineMs): timer = remainingUntil(deadlineMs, epochMsOf(clock())))
    (deadline: the lifecycle's bracketDeadlineOf, runDeadlineMs = addDuration(t, window) at establishment's post-exchange read t, else addDuration(now after bind, window))
            body(run): createRunContextFactory → createNodeContextForDag(run.authority) → createDagExecutor → runDag(mintingAuthorityOf(run, meterLlm))
  → inside the lifecycle: bindAdmission ─bound→ (decided) │ ─pending→ establishDelegation → mint → OBO(offline_access) → seal(AAD = custodyBindingOf(bound))
      → transitionCustody(absent, establish) ─Err→ establishFaultOf │ ─held→ custody.put (NX, TTL to the binding expiry; written once)

HITL slice start: withRecordedAuthority(boundAuthorityOf(record), requirements) → checkAdmittedAuthority(access, BrokeringNow) ─Err→ failed{authority-changed} → endRun (0 nodes run)
Per node invocation (sync bracket | HITL slice; forRun(bound) once per bracket):
  invocationFor → broker.mintFor → routeRequirement(access, brokered, name) ─pass-through→ other providers
      │ ─refused-not-admitted→ authority-unavailable{capability-not-admitted} (0 egress) │ gateAdmitted ─refused→ policy-refusal (0 egress)
  → app: boot cell[(entraId, app, cap)] miss → RealmAssertionMint("entra-exchange cap") → inspectFederatedAssertion → acquireApp
  → delegated: run cell[(entraId, delegated, oid, cap)] miss → custody cell (beginRedeem, decideRedeemStep loop): read → open → redeemDelegation
      (no write; Entra refused → revoke → reauthorization-required{refused})
  → fault → frameworkErrorOf → authority-unavailable | infra-unreachable;  ok → buildGraphHandle → audit{run, node, agent, entraId, cap, mode, initiator?}
  → HITL: reauthorization-required → parkOn → node-parked → awaiting-reauthorization{nodeId, reason} → notify owner channel once; custody kept
    sync: reauthorization-required → 401, run failed

Re-authorization: POST /runs/:runId/delegation → createReauthorizeRunHandler → reauthorizeRun: status awaiting? ─no→ 409
  → verifyReauthorization: planReauthorization (initiator, window, leg, agent mapped, header; 0 JWKS on refusal) → verifyEntraUserToken → admitDelegatedPresentation
  → lifecycle.reauthorize → reestablishDelegation: mint → OBO → fresh expiry ≤ run deadline → seal(AAD = custodyBindingOf(bound')) → get → transitionCustody(reestablish) → stage(new TTL), nothing written
  → markReauthorized: ONE setAllIfValues guarded on the record bytes read writes record (bound'.authority) AND staged custody, or neither
      ─not-current (a concurrent presentation won; record ended or evicted)→ 409, nothing written → enqueue → processRun resumes the parked checkpoint at the node; audit accepted | refused

Approval: approve route | bot handler → authorizeApproval ─refused→ recordApproval(unauthorized) → audit
  → recordApproval(decide) → resolvePending (one SET NX of the whole decision) → classifyDecisionAttempt → audit
  → executor consumes it → ApprovalRecord in the lease-fenced checkpoint write → onCommitted clears the decision

Run ending: SyncRunEnding | HitlRunEnding (→ endRun) | establishment-abandoned → the lifecycle: releaseCauseOf → custody.delete (INV-4 owner)
Idle TTL eviction → custody TTL (≤ record TTL; an awaiting run's eviction too: no wake, TTL only) | tenant purge → purgeTenantKeyspace(fugue:<tenant>:*)
```

The only places a bearer token exists are the inbound request (dropped after establishment), the per-call Entra form bodies, and the in-memory token cells. Custody holds only ciphertext bound by AAD.


## Security and NFR Notes

Each note points at its canonical home.
- **Trust boundaries:** realm JWT by the existing verifier; Entra user token against the configured tenant's JWKS with every AD-7 check pinned (no default allowlist or scope, D4); binding is `oid`/`tid` equality; the minted realm assertion is inspected before Entra egress (AD-4).
- **Fail closed (NFR-010):** every leg, mode and model gap is a boot refusal or `authority-unconfigured`; never `delegated` → `app`; an unmapped DAG is a typed refusal; `capability-unknown` at admission, `capability-not-admitted` at the mint path (a DAG changed during suspension cannot widen a run), `authority-changed` at a slice start (AD-12); a refused or missing delegated credential parks the run for re-authorization without extending the window (AD-13).
- **Revocation (D3):** AD-6; a refused refresh records `revoked` and drops the ciphertext at once.
- **Approval integrity (D7):** one first-writer-wins write of decision and approver; every attempt audited; approvers see the acting principal (AD-9).
- **Credential hygiene (FR-022, INV-3):** the user token is a `RedactedSecret` (`[redacted]` under every serialisation; three `revealSecret` callers); refresh credentials are plaintext only inside `custody-cipher.ts` calls, and custody (written once, Redis only) holds ciphertext whose AAD derives from the run authority, so a replayed record fails to open; a redeem-returned refresh credential is dropped unread; custody is capped (default min(604800 s, `HITL_RUN_TTL_SEC`), never above `HITL_RUN_TTL_SEC`); faults carry no free text; FR-022 is decided by the sentinel assertions in CT-2 (Phase 3), CT-1 and CT-4 (Phase 4) and CT-3 (Phase 5).
- **No probe surface before refusal:** JWKS egress only for a submission pass 1 cannot refuse statically (AD-5).
- **Blast radius (NFR-011):** one blueprint, or one fallback app set, per deployment; custody keys per deployment and tenant worker, held by the worker only (boundary A).
- **Supervisor UDS proxy:** forwards `X-Fugue-Delegated-Authorization` unchanged, strips only `X-Fugue-Tenant`; CT-1 asserts byte-identical arrival, no forged tenant header and no token in proxy logs.
- **Deploy order:** the realm (with `entra_oid`/`entra_tid`) deploys before the host, which 401s realm user JWTs without them; the runbook states it.
- **Performance:** app cache hits make no network call (NFR-001); delegated cells are run-scoped; `lazyJwks` caches JWKS (NFR-003); single-flight per cell key (NFR-012); no internal retries (NFR-021).
- **Retention (FR-024):** `oid` and `tid` follow the existing run and audit retention, documented in `data-handling.md`.


## Runtime-seam rule

**Runtime-seam rule used by every contract.** A contract declares every production symbol on its decided path a test could otherwise substitute: an entry edge (`proxyToWorker`, `createAuthMiddleware`, a route handler, `handleBotActivity`, `invocationFor`) and the production factory of every injected dependency (`composeRunAuthorityWiring`, `composeHitlRunService`, `createRunContextFactory`, `createDagExecutor`). A symbol reached only through a static import or a construction inside a declared seam is traversed by construction and not re-declared (the engine requires each acceptance file to name every declared seam in code, and an artificial import proves nothing). The per-contract sweep of declared and excluded symbols is in `plan-history.md#acceptance-seam-sweep-loop-back-11`.

## Latency budget tests

**Latency budget tests (NFR-002, NFR-003, SC-011).** CT-2 (Phase 3) and CT-1 (Phase 4) acceptance files, gating the phases that build the code they constrain, over `acceptance/support/latency-budget.ts`: every transport an instantly-resolving fake (host-added time only); 50 discarded warm-up iterations (JIT, the first `lazyJwks` fetch NFR-003 excludes, WebCrypto key import); 500 timed `performance.now()` samples; nearest-rank p95 compared with the budget and printed for the evidence template. Cold samples each use a fresh wiring built outside the timed region; cache-hit samples reuse one warmed cell and assert zero transport calls (NFR-001). Host cost is well under 1 ms per acquisition and a few ms per admission, so the 10, 5 and 50 ms budgets leave an order of magnitude of CI headroom yet catch an accidental network call, per-call key derivation or uncached JWKS fetch. Anchors AS-035 (NFR-002) and AS-036 (NFR-003) restate the NFRs' automated clauses (Loom anchors only FR and AS ids); testcases are named (`AS-035: cold host-added acquisition ≤ 10 ms p95 (agent-id, app)`, `AS-035: cache hit ≤ 5 ms p95, zero transport calls`, `AS-036: run-start validation ≤ 50 ms p95 through proxyToWorker`).

## Run admission seams

Multi-tenant requests arrive through `proxyToWorker` (`supervisor/uds-proxy.ts`), which clones every header, deletes the client's `X-Fugue-Tenant`, stamps the signed one and forwards the rest, so `X-Fugue-Delegated-Authorization` arrives byte-identical and is never logged (the proxy logs only tenant and transport reason). CT-1 declares it a runtime seam, so a future header allowlist that drops the delegated header fails CT-1.

Attribution reaches the mint through two injectable hops exported from `adapters/run-composition.ts` (no boot code, so `buildRouterDeps` and CT-4 use them without `createHost`): `createContext` (`createRunContextFactory` → `createNodeContextForDag`, returning the `RunAuthority` beside the context) and `executeDag` (`createDagExecutor`, minting through `mintingAuthorityOf(run, meterLlm)` from the bracket's one `forRun`; an unbrokered run has no handle, by type). CT-4 declares both and `createNodeContextForDag`, so stubbing either cannot decide AS-006, FR-004 or FR-020.

## Moved in loop-back 13

Moved verbatim from the plan in loop-back 13 (plan design review fixes) to keep it within budget; the plan points at each.

### Delegated Custody: redeem sequencing

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

### Delegated Custody: binding and keys

**The binding is never stored.** The record holds only `{kind, sealed}` (or `{kind, reason}` once revoked). `custodyBindingOf(bound)` derives the AAD at seal and open, and key and TTL at `put` and `stage`, from the bracket's `BoundAuthority` (the admitted run id or, on resume, the record's own id, beside the persisted `RunAuthority`), so a record replayed under another run or user fails to open and no second copy of run id, expiry or initiator can diverge.

**Custody keys.** `DELEGATED_CUSTODY_KEYS` (JSON: the `active` kid plus kid → base64 32-byte key) arrives through the worker secrets source and is never handled by the supervisor (boundary A). Rotation adds a kid and switches `active`; old kids stay until the custody max has elapsed, so every live record still opens.

### Acceptance seam sweep

Each acceptance-decided Requirement is traced along its production path under the runtime-seam rule; the declared seams are the CT lists. Fakes only at the network (`IdentityTransports`, the realm signature verifier, the Bot Framework token verifier), storage (`RedisPort`, `HitlRedisPort`, `QueueBackend`), notifier-transport (`BotConnectorPort`, `WebhookHttp`) and clock edges, plus recording observation points for deps another contract decides. Per-contract sweeps and every self-audit (all rows pass; loop-back 12's last): `plan-history.md`. The **Phase boundary rule** is binding on decompose and implementers; rules applied at several sites but deliberately not owned are in the OWN rows there.

### Operator prerequisites

**Operator prerequisites (installed; keep as is when Tasks are repopulated).** `.loom/verification-manifest.json` is schema 2, installed at the decompose approval (`clarifications/log.md`, "Decompose approval and verification manifest"), and already serves the owned invariants (INV-2, INV-4 to INV-8, mutation-verified) and the six contracts:

1. An `affectedRunner` and an `acceptanceRunner`: bun test with a JUnit reporter over `{files}`, 240000 ms, each with a `required-file` report.
2. JUnit wave checks: `project:framework-test`; `project:host-test` (all of `packages/host/src` except `signals.test.ts`, the acceptance directory included); `project:host-signals-test` (`signals.test.ts` isolated); `project:scripts-test`.
3. Report-less wave checks: `project:framework-typecheck`, `project:host-typecheck`, `project:doc-links`.
4. The six pre-existing operator checks, unchanged.

Deliberately absent: a `project:identity-acceptance` check and a `bun run --cwd packages/host test` check. The gate excuses a red acceptance testcase only from a JUnit report whose runner is the check's last step; that script chains two `bun test` calls and writes no report, so it would block every Wave between a contract's Wave and its claimant's. bun exits 1 on an empty path set, so a separate acceptance check would fail before the acceptance directory exists; `project:host-test` covers that directory. Verification steps 2 and 3 above are the operator's local run, not manifest checks.

### Realm interface contract

### Interface contract with the host (fixed by this plan)

| Item | Value |
|---|---|
| User access token claims (frontend clients) | `entra_oid` (string, Entra object id), `entra_tid` (string, Entra tenant id); always present for Entra-brokered users |
| Agent mint | client_credentials with `scope="entra-exchange <capability>"`; `entra-exchange` adds `aud=api://AzureADTokenExchange` (existing `ENTRA_EXCHANGE_AUDIENCE`); no other audience on agent assertions |
| Unassigned optional scope | `invalid_scope` (or omission), which the host treats as a missing grant |
| Agent clients | `standard.token.exchange.enabled=false`; client_credentials only |
| Broker tokens | `azuread` IdP `storeToken=false` |

### Acceptance support files

File Structure › Host: contracts entries, verbatim:

```
packages/host/src/__tests__/acceptance/support/identity-fakes.ts — fakes at the network, storage and clock edges only: zero-latency realm-token, Entra-token, Entra-JWKS and Graph transports (an IdentityTransports value) with request capture, a JWKS signer for realm and Entra user tokens, a fake realm signature verifier (markSignatureVerified claims), setSystemTime clock control, an in-process UDS transport into the worker app, an in-memory RedisPort and HitlRedisPort with SharedInfra (custody runs through the production Redis store over it, D2), an in-process QueueBackend delivering to the started worker, a recording Bot Framework connector (BotConnectorPort) and webhook transport (WebhookHttp) under the production notifiers, capturing each rendered activity and card body, a fake VerifyBotToken, a capturing audit sink, logger and tracer. NO fake realm mint, Entra authority, verifier, cipher, custody store or capability authority: those come from composeRunAuthorityWiring
packages/host/src/__tests__/acceptance/support/credential-sentinel.ts — FR-022 scan support for every contract's acceptance (Phase 3, with CT-2): CredentialSentinels, one distinctive value per credential kind (inbound realm and Entra user JWTs, realm assertion, T1, Entra app access token, on-behalf-of access token, refresh token, redeem-returned refresh token, re-authorization realm and Entra user tokens), wired into the fakes; CapturedSurfaces, a closed record of ten surfaces (logs, audit, spans, httpResponses, errors, handles, origins, runRecords, custodyAtRest, notifications: what the notifier transports received) filled only from the capturing sinks and transports, proxyToWorker's responses, the path's errors, handles and authority/origin values, the in-memory HitlRedisPort and the custody keyspace; assertNoCredentialMaterial renders each value with JSON.stringify, String() and Bun.inspect and fails on any sentinel, its base64, base64url or hex encoding, or any JWT segment of 16+ characters; assertCustodyCiphertextOnly also requires every custody record to be a SealedRefreshCredential opening only under the deployment keyring with its own binding as AAD
```

## Moved in loop-back 13b

Moved verbatim from the plan in loop-back 13b (alignment fixes) to keep it within budget; the plan points at each.

### HITL composition and approver seams

`composeHitlRunService` builds `createRedisRunStore` and `createRedisDecisionStore` over the tenant's Redis, `createRunExecutor` over the lifecycle narrowed to `withRecordedAuthority`, `createRunQueue` over the injected backend, and `createHitlRunService` over them and the narrowed lifecycle. CT-3 drives it with an in-process `QueueBackend` and `runQueue.startWorker(service.processRun)`, so record schema, lease-fenced processing and the executor's broker are production code.

The approver is derived where production derives it: `createApproveRunHandler` maps the middleware-built `AuthIdentity` to `realm-user{realmSub, entra}`, `team{team}` or `admin` and serializes refusals through `errorResponse`; `handleBotActivity` parses `from.aadObjectId` (`parseEntraObjectId`), resolves a `TeamsApprover`, authorizes it through `canAccessDag` and maps it to `teams-user{aadObjectId}`. CT-3 and CT-5 declare these as runtime seams, so acceptance never calls `recordApproval` with a hand-built approver; CT-3 re-authorizes only through `createReauthorizeRunHandler`. Both also declare the production renderers `createBotFrameworkNotifier` and `createWebhookNotifier`, faked only at their transports (`BotConnectorPort`, `WebhookHttp`), so `executesAs` and the re-authorization notice are judged as approvers see them.

### Property test inventory

Testing Strategy bullet, verbatim:

- **Property tests** use fast-check: the `*.property.test.ts` files (the LC-1 and LC-2 machines'; LC-3's is `dag-transition-property.test.ts`), `authority-unavailable-error.test.ts`, `federated-assertion.test.ts`, `entra-user-token.test.ts`, `redacted-secret.test.ts` and the matrix tests over generated catalogs, directories and authorities. The token-endpoint classifier and the fault projections are property-tested once, in `domain/__tests__`.

## Moved in loop-back 14

Moved verbatim from the plan in loop-back 14 (plan design review 2 fixes) to keep it within the review budget; each AD keeps a summary and a pointer in the plan.

### AD-6 (full choice)

AD-6: Delegated authority is established eagerly at admission and continued through write-once, Redis-held custody

**Choice:** Admission yields `user-delegated-pending{grant}`. One operation owns the bracket from establishment to release: the run-authority lifecycle (`adapters/run-authority-lifecycle.ts`, owner of INV-4, INV-6 and INV-7), built once by `composeRunAuthorityWiring`; brackets, store, redeem table, release and key rotation: Component Design › Delegated Custody. The lifecycle alone holds `forRun` (the wiring does not expose the capability authority), re-establishment and the store's `delete`; each sibling holds a narrowed `Pick<RunAuthorityLifecycle, …>` (INV-4, INV-6, INV-7).
- **Establishment** (`establishDelegation`, CT-3): one on-behalf-of exchange with `offline_access`, sealed with AES-256-GCM; key (`fugue:<tenant>:authority:custody:<binding.runId>`), AAD and TTL derive from the `BoundAuthority` it returns, and the LC-1 `establish` guard runs before `put`. No compensation of its own: any `Err`, an ambiguous `put` included, returns to the lifecycle, which releases and refuses. The user token is a `RedactedSecret`, dropped when establishment returns.
- **Written once, never rotated (D1).** Entra does not revoke a refresh credential on redeem, and the confidential-client refresh lifetime (90 days) exceeds the custody cap, so every redeem uses the credential establishment wrote; `redeemDelegation` returns only the access credential, discarding any returned refresh credential. Execution's one custody write is `revoke` after Entra refuses a redeem; re-authorization (AD-13) re-establishes through the lifecycle.
- **Redis everywhere (D2).** `REDIS_URL` is required and the host degrades without Redis, so production custody is the Redis store for sync and HITL runs; the in-memory store is a test fake only.
- **Expiry** `custodyExpiryFor(now, max, runDeadline)`: `max` = the wired `DelegationLeg.maxSec` (`DELEGATED_CUSTODY_MAX_SEC`, unset → min(604800, `HITL_RUN_TTL_SEC`)); deadline = `addDuration(t, window)` at establishment's post-exchange read `t` (IN-3; window: the DAG timeout, or HITL's `runTtl`); the sync timer runs to that deadline; 7 days with default keys. Fixed at establishment on the `RunAuthority` beside the run deadline (`delegation.runDeadlineMs`, never extended); a re-authorization is fresh consent and re-derives it as `custodyExpiryFor(now, max, runDeadlineMs)` (AD-13, the user's decision on the loop-back 11 report).
- **Redeem** runs the pure `decideRedeemStep` through the agent identity, with no `app` fallback.
- **Revocation is Entra's, per refresh (D3).** A disabled account, Conditional Access (sign-in frequency included) and an explicit session revocation refuse a refresh; a password change or reset does NOT revoke a confidential-client refresh credential. Operator cut-offs: disable the user, `revokeSignInSessions`, or end the run (a rejecting approver, or eviction at its TTL).

### AD-7 (full choice)

AD-7: Inbound delegated-token contract and identity binding

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

### AD-8 (full choice)

AD-8: Extend the capability failure taxonomy with `authority-unavailable`

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

### AD-9 (full choice)

AD-9: Approval is recorded with its decision in one write and lends no authority

**Choice:**
- **One atomic decision value (D7).** `resolvePending` writes the whole `HitlDecision` (action, `ApproverRef`, channel, decision time, Teams activity id) in its existing single `SET NX`, so an accepted decision never exists without its approver (FR-028). The framework `HumanAction.actor` carries only a display rendering; identity is never read back from it.
- **Every attempt is audited** (accepted | duplicate | not-pending | unauthorized) by `recordApproval`, after the write, classified by the pure `classifyDecisionAttempt`; a Teams redelivery of one activity is `duplicate`, a `canAccessDag` refusal `unauthorized`.
- **The acting principal is shown, computed once.** `executesAsOf(authority)` (the agent, or the initiator through delegation, per capability) is called at one site, `hitl/service.ts`'s private `runViewOf(record)`; its value is passed on, never re-derived: to the review notification the card and webhook renderers print, to `getRun`'s `RunView` (the `GET /runs/:runId` review block and the approve response), and to the accepted decision's audit record (AS-043). One call site, so no owned invariant (the AD-8 projections' precedent).
- **Approvals on the run record** are appended when the executor consumes the decision, in the same lease-fenced checkpoint write that advances the run. The Redis decision record and `RunRecord.approvals` are authoritative; the audit log is a projection. Mechanics: Component Design › HITL Authority Continuity.
- `ApproverRef` is one of `realm-user{realmSub, entra}`, `team{team}`, `admin` or `teams-user{aadObjectId: EntraObjectId}`. It and the decision and approval types are declared in `hitl/types.ts` (Phase 5), not in a contract types file, because approvals lend no authority (CT-5).
- One persisted initiator: `PersistedIdentity.user` gains `entra` in Phase 2 (with the live identity), and in the Phase 4 cut-over `RunRecord.authority` replaces `RunRecord.identity`; `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are then deleted. The record, stored and read, holds the bare `RunAuthority` (`parseRunAuthority` at the store); `boundAuthorityOf(record)` derives the `BoundAuthority` from `record.runId` where it is used (IN-6), so no record can pair two run ids. The executor rebuilds the broker only from that derivation, through `withRecordedAuthority`.
- The Teams approver is not an `AuthIdentity`: `TeamsApprover` (`domain/auth.ts`) carries no realm principal, so a card click is never given a fabricated `entra` and cannot start a run or be persisted as an initiator; a missing or malformed `from.aadObjectId` fails closed.
