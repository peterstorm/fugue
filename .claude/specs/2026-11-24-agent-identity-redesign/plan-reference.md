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
    (deadline: the lifecycle's bracketDeadlineOf: delegated, the DelegationWindow's runDeadlineMs from openDelegationWindow(t, window, max) at establishment's post-exchange read t; else addDuration(now after bind, window))
            body(run): createRunContextFactory → createNodeContextForDag(run.authority) → createDagExecutor → runDag(mintingAuthorityOf(run, meterLlm))
  → inside the lifecycle: bindAdmission ─bound→ (decided) │ ─pending→ establishDelegation → mint → OBO(offline_access) → cipher.seal(custodyBindingOf(bound)) → SealedFor
      → transitionCustody(absent, establish{sealed}) ─Err→ establishFaultOf │ ─HeldFor→ custody.put(held) (NX; key and TTL from held.sealed.binding; written once)

HITL slice start: withRecordedAuthority(boundAuthorityOf(record), requirements) → checkAdmittedAuthority(access, BrokeringNow) ─Err→ failed{authority-changed} → endRun (0 nodes run)
Per node invocation (sync bracket | HITL slice; forRun(bound) once per bracket):
  invocationFor → broker.mintFor → routeRequirement(access, brokered, name) ─pass-through→ other providers
      │ ─refused-not-admitted→ authority-unavailable{capability-not-admitted} (0 egress) │ gateAdmitted ─refused→ policy-refusal (0 egress)
  → app: boot cell[(entraId, app, cap)] miss → RealmAssertionMint("entra-exchange cap") → inspectFederatedAssertion → acquireApp
  → delegated: run cell[(entraId, delegated, oid, cap)] miss → custody cell (beginRedeem, decideRedeemStep loop): read (HeldRead: state + CustodyVersion) → open → redeemDelegation
      (no write; Entra refused → revoke guarded on the CustodyVersion bytes → reauthorization-required{refused})
  → fault → frameworkErrorOf → authority-unavailable | infra-unreachable;  ok → buildGraphHandle → audit{run, node, agent, entraId, cap, mode, initiator?}
  → HITL: reauthorization-required → parkOn, holding for EVERY failed node of the wave → node-parked → awaiting-reauthorization{nodeId, capability, reason} → notify owner channel once; custody kept while reauthorizationOpen
    (past the run deadline: reconcileActiveRuns wakes it → processRun settles failed{authority-unavailable{capability, agent, reauthorization-required{reason}}}
     under the lease → audit delegation-reauthorization{expired} → ended{failed} → endRun releases custody; GET shows the window closed meanwhile)
    (one non-parkable co-failure → node-failed with the first non-parkable error in wave order → the run fails → endRun)
    sync: reauthorization-required → 401, run failed

Re-authorization: POST /runs/:runId/delegation → createReauthorizeRunHandler → reauthorizeRun: getRunVersioned → {record, RecordVersion}; status awaiting? ─no→ 409; delegatedBoundOf ─Err→ internal-invariant-violated (corrupt record)
  → verifyReauthorization: planReauthorization (initiator, window via reauthorizationOpen, leg, agent mapped, header → reauthorization-token-required{audience}; 0 JWKS on refusal) → verifyEntraUserToken → admitDelegatedPresentation
  → lifecycle.reauthorize → reestablishDelegation: mint → OBO → renewedAuthority (renewDelegationWindow: fresh expiry, the same deadline) → cipher.seal(custodyBindingOf(bound')) → get
      → transitionCustody(reestablish{sealed}) → HeldFor, nothing written → the branded Reestablished{bound', held}
  → markReauthorized(version, reestablished): run ids or deadlines differ → Err, nothing written; reauthorizedRecordOf → ReauthorizedRecord
  → commitReauthorization (the custody store module): ONE setAllIfValues guarded on version.raw writes record (bound'.authority) AND custody from held, or neither
      ─not-current (a concurrent presentation won; record ended or evicted since the read)→ 409, nothing written → enqueue → processRun resumes the parked checkpoint at the node; audit accepted | refused

Approval: approve route (channel http, approver realm-user | team | admin) | bot handler (channel teams, teams-user, teamsActivityId) → authorizeApproval ─refused→ recordApproval(unauthorized) → audit
  → recordApproval(decide) → resolvePending (one SET NX of the whole channel-discriminated HitlDecision) → classifyDecisionAttempt → audit
  → executor consumes it → ApprovalRecord in the lease-fenced checkpoint write → onCommitted clears the decision

Run ending: SyncRunEnding | HitlRunEnding (→ endRun; record-evicted only for a record a real wake finds missing; failed for an awaiting run past its deadline) | establishment-abandoned → the lifecycle: releaseCauseOf → custody.delete (INV-4 owner)
Idle TTL eviction → custody TTL (≤ record TTL; a run evicted while awaiting re-authorization, before a sweep settles it, too: no wake reaches it, so its custody goes by its own TTL, never later than the record's) | tenant purge → purgeTenantKeyspace(fugue:<tenant>:*)
```

The only places a bearer token exists are the inbound request (dropped after establishment), the per-call Entra form bodies, and the in-memory token cells. Custody holds only ciphertext bound by AAD.


## Security and NFR Notes

Each note points at its canonical home.
- **Trust boundaries:** realm JWT by the existing verifier; Entra user token against the configured tenant's JWKS with every AD-7 check pinned (no default allowlist or scope, D4); binding is `oid`/`tid` equality; the minted realm assertion is inspected before Entra egress (AD-4).
- **Fail closed (NFR-010):** every leg, mode and model gap is a boot refusal or `authority-unconfigured`; never `delegated` → `app`; an unmapped DAG is a typed refusal; `capability-unknown` at admission, `capability-not-admitted` at the mint path (a DAG changed during suspension cannot widen a run), `authority-changed` at a slice start (AD-12); a refused or missing delegated credential parks the run for re-authorization without extending the window, and a parked run whose window closes is settled `failed` and released (AD-13).
- **Revocation (D3):** AD-6; a refused refresh records `revoked` and drops the ciphertext at once.
- **Approval integrity (D7):** one first-writer-wins write of the channel-discriminated decision (an http decision cannot carry a Teams approver, a Teams decision always carries its activity id); every attempt audited; approvers see the acting principal (AD-9).
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
| `read` → `held` (a `HeldRead`: the state and its `CustodyVersion`) | `open` | continues |
| `open` → `unopenable` (AAD mismatch, kid not in the keyring) | none | `reauthorization-required{custody-absent}`, log `custody-unopenable` (runId and kid only) |
| `open` → `opened` | `redeem` | continues |
| `redeem` → `redeemed` | none; a refresh credential in the response was already dropped by the adapter | the access credential |
| `redeem` → `redeem-failed{reauthorization-required{refused}}` | `refuse` → `revoke(read)`, guarded on `read.version.raw` (skipped if the signal aborted) | continues |
| `redeem` → `redeem-failed`, any other fault | none | that fault, no `app` fallback |
| `revoke` → any outcome | none further (`not-current`: a re-authorization replaced the record since the read, and it stays) | `reauthorization-required{refused}`; a store failure is logged `custody-revocation-write-failed` |

### Delegated Custody: binding and keys

**The binding is never stored.** The record holds only `{kind, sealed}` (the `SealedFor`'s credential; or `{kind, reason}` once revoked). `custodyBindingOf(bound)` derives the binding from the bracket's `BoundAuthority`; `CustodyCipher.seal` seals it in as the AAD and returns it inside the `SealedFor`, from which `put` and `commitReauthorization` take key and TTL (`HeldFor`), and `open` derives it again (the admitted run id or, on resume, the record's own id, beside the persisted `RunAuthority`), so a record replayed under another run or user fails to open and no second copy of run id, expiry or initiator can diverge.

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

`composeHitlRunService` builds `createRedisRunStore` (with `createReauthorizationCommit` over the same tenant Redis) and `createRedisDecisionStore` over the tenant's Redis, `createRunExecutor` over the lifecycle narrowed to `withRecordedAuthority`, `createRunQueue` over the injected backend, and `createHitlRunService` over them and the narrowed lifecycle. CT-3 drives it with an in-process `QueueBackend` and `runQueue.startWorker(service.processRun)`, so record schema, lease-fenced processing and the executor's broker are production code.

The approver is derived where production derives it: `createApproveRunHandler` maps the middleware-built `AuthIdentity` to `realm-user{realmSub, entra}`, `team{team}` or `admin` and serializes refusals through `errorResponse`; `handleBotActivity` parses `from.aadObjectId` (`parseEntraObjectId`), resolves a `TeamsApprover`, authorizes it through `canAccessDag` and maps it to `teams-user{aadObjectId}`. CT-3 and CT-5 declare these as runtime seams, so acceptance never calls `recordApproval` with a hand-built approver; CT-3 re-authorizes only through `createReauthorizeRunHandler`. Both also declare the production renderers `createBotFrameworkNotifier` and `createWebhookNotifier`, faked only at their transports (`BotConnectorPort`, `WebhookHttp`), so `executesAs` and the re-authorization notice are judged as approvers see them.

### Property test inventory

Testing Strategy bullet, verbatim:

- **Property tests** use fast-check: the `*.property.test.ts` files (the LC-1 and LC-2 machines'; LC-3's is `dag-transition-property.test.ts`), `authority-unavailable-error.test.ts`, `federated-assertion.test.ts`, `entra-user-token.test.ts`, `redacted-secret.test.ts` and the matrix tests over generated catalogs, directories and authorities. The token-endpoint classifier and the fault projections are property-tested once, in `domain/__tests__`.

## Moved in loop-back 14

Moved from the plan in loop-back 14 (plan design review 2 fixes) to keep it within the review budget, and reconciled to the current design in loop-back 14b (the pre-reconciliation text is in `plan-history.md`, "Loop-back 14b"); each AD keeps a summary and a pointer in the plan.

### AD-6 (full choice)

AD-6: Delegated authority is established eagerly at admission and continued through write-once, Redis-held custody

**Choice:** Admission yields `user-delegated-pending{grant}`. One operation owns the bracket from establishment to release: the run-authority lifecycle (`adapters/run-authority-lifecycle.ts`, owner of INV-4, INV-6 and INV-7), built once by `composeRunAuthorityWiring`; brackets, store, redeem table, release and key rotation: Component Design › Delegated Custody. The lifecycle alone holds `forRun` (the wiring does not expose the capability authority), re-establishment and the store's `delete`; each sibling holds a narrowed `Pick<RunAuthorityLifecycle, …>` (INV-4, INV-6, INV-7).
- **Establishment** (`establishDelegation`, CT-3): one on-behalf-of exchange with `offline_access`, sealed with AES-256-GCM by `CustodyCipher.seal(binding, …)`, which returns a `SealedFor` carrying its binding; key (`fugue:<tenant>:authority:custody:<binding.runId>`), AAD and TTL derive from that binding, `custodyBindingOf` of the `BoundAuthority` it returns, and the LC-1 `establish` guard runs on the `SealedFor` before `put(held)`. No compensation of its own: any `Err`, an ambiguous `put` included, returns to the lifecycle, which releases and refuses. The user token is a `RedactedSecret`, dropped when establishment returns.
- **Written once, never rotated (D1).** Entra does not revoke a refresh credential on redeem, and the confidential-client refresh lifetime (90 days) exceeds the custody cap, so every redeem uses the credential establishment wrote; `redeemDelegation` returns only the access credential, discarding any returned refresh credential. Execution's one custody write is `revoke` after Entra refuses a redeem, guarded on the `CustodyVersion` bytes its read returned; re-authorization (AD-13) re-establishes through the lifecycle.
- **Redis everywhere (D2).** `REDIS_URL` is required and the host degrades without Redis, so production custody is the Redis store for sync and HITL runs; the in-memory store is a test fake only.
- **Expiry** `custodyExpiryFor(now, max, runDeadline)`: `max` = the wired `DelegationLeg.maxSec` (`DELEGATED_CUSTODY_MAX_SEC`, unset → min(604800, `HITL_RUN_TTL_SEC`)); deadline = `addDuration(t, window)` at establishment's post-exchange read `t` (IN-3; window: the DAG timeout, or HITL's `runTtl`); the sync timer runs to that deadline; 7 days with default keys. Both live in the run's `delegation: DelegationWindow` (INV-8, structural): `openDelegationWindow(t, window, max)` at establishment is the only place the deadline is set; a re-authorization is fresh consent and `renewDelegationWindow(w, now, max)` re-derives the expiry as `custodyExpiryFor(now, max, w.runDeadlineMs)`, copying the deadline (AD-13, the user's decision on the loop-back 11 report); `parseDelegationWindow` refuses a stored expiry past the deadline.
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
  - Refusal order (first failure wins, unchanged precedence with the two new checks placed after `audience`): malformed (non-object claims, a missing or non-GUID `oid` or `tid`, a missing or non-numeric `exp`/`nbf`; the validator's `ClaimRefusal` admits it, IN-1), version, issuer, tenant, audience, client, expired, not-yet-valid, not-delegated, scope. The new `DelegatedTokenInvalidReason` values are `client` and `scope`; a refusal names the failed check only, never a claim value (AS-040).
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
- A `reauthorization-required` node failure in a HITL run does not fail the run while its window is open: the HITL executor's park predicate parks it (AD-13), provided every failed node of its wave is parkable, and past the run deadline reconciliation settles the parked run `failed` with that error; a co-failed non-parkable node fails the run with the first non-parkable error in wave order. A sync run cannot wait, so it fails with 401 `reauthorization-required`.
- **One acquisition-fault vocabulary, typed per path.** Every acquisition-path adapter (realm mint, Entra authority, unwired adapters, selected together by the wiring from one `mintLegsOf` decision, so a dark Entra leg also makes zero realm egress; custody cell, establishment) returns its subset of `AcquisitionFaultOf<H, R>` (Component Design › Entra Agent Authority), replacing `AssertionFault`, `EntraAcquisitionFault`, `DelegationEstablishmentFault` and `delegation-not-established`'s free-standing reason list, so an unreachable state is unrepresentable; the closed `UnreachableCause` keeps response text and credentials out of error values (INV-3 for faults holds in the type).
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
- **One atomic decision value (D7).** `resolvePending` writes the whole `HitlDecision` (`ApprovalChannel` & action and decision time: `{channel: http; approver: realm-user | team | admin}` or `{channel: teams; approver: teams-user; teamsActivityId}`) in its existing single `SET NX`; the persisted-decision parser refuses any other shape as corrupt, so an accepted decision never exists without its approver (FR-028). The framework `HumanAction.actor` carries only a display rendering; identity is never read back from it.
- **Every attempt is audited** (accepted | duplicate | not-pending | unauthorized) by `recordApproval`, after the write, classified by the pure `classifyDecisionAttempt` (`.exhaustive()` over channel); a Teams redelivery of one activity is `duplicate`, a `canAccessDag` refusal `unauthorized`.
- **The acting principal is shown, computed once.** `executesAsOf(authority)` (the agent, or the initiator through delegation, per capability) is called at one site, `hitl/service.ts`'s private `runViewOf(record)`; its value is passed on, never re-derived: to the review notification the card and webhook renderers print, to `getRun`'s `RunView` (the `GET /runs/:runId` review block and the approve response; a union over `record.status`, only its `awaiting-reauthorization` variant carrying `reauthorization` (open: what to present; closed past the run deadline: not recoverable), node and reason read from the status; `executesAs` an `ExecutesAs` of kind `app` or `delegating{onBehalfOf}`, or `unbrokered`), and to the accepted decision's audit record (AS-043). One call site, so no owned invariant (the AD-8 projections' precedent).
- **Approvals on the run record** are appended when the executor consumes the decision, in the same lease-fenced checkpoint write that advances the run. The Redis decision record and `RunRecord.approvals` are authoritative; the audit log is a projection. Mechanics: Component Design › HITL Authority Continuity.
- `ApproverRef` is one of `realm-user{realmSub, entra}`, `team{team}`, `admin` or `teams-user{aadObjectId: EntraObjectId}`; `ApprovalChannel` pairs the first three only with `http` and `teams-user` only with `teams` (with its `teamsActivityId`), and `HitlDecision`, `ApprovalRecord` and the `unauthorized` attempt are built over it. They are declared in `hitl/types.ts` (Phase 5), not in a contract types file, because approvals lend no authority (CT-5).
- One persisted initiator: `PersistedIdentity.user` gains `entra` in Phase 2 (with the live identity), and in the Phase 4 cut-over `RunRecord.authority` replaces `RunRecord.identity`; `PersistedIdentity`, `toPersistedIdentity` and `toExecIdentity` are then deleted. The record, stored and read, holds the bare `RunAuthority` (`parseRunAuthority` at the store); `boundAuthorityOf(record)` derives the `BoundAuthority` from `record.runId` where it is used (IN-6), so no record can pair two run ids. The executor rebuilds the broker only from that derivation, through `withRecordedAuthority`.
- The Teams approver is not an `AuthIdentity`: `TeamsApprover` (`domain/auth.ts`) carries no realm principal, so a card click is never given a fabricated `entra` and cannot start a run or be persisted as an initiator; a missing or malformed `from.aadObjectId` fails closed.

## Moved in loop-back 15

Moved from the plan in loop-back 15 (plan design review 3 fixes) to keep it within the review budget, as it stands after loop-back 15's edits; each AD keeps a summary and a pointer in the plan.

### AD-3 (full choice)

AD-3: One capability-facing contract, two Entra identity adapters, explicit model in configuration

**Choice** (FR-011, FR-019, SC-008: switching model is configuration only):
- The port `EntraAgentAuthority { acquireApp, establishDelegation, redeemDelegation }` (`domain/port/entra-agent-authority.ts`).
- `createAgentIdAuthority`: two client_credentials calls, step 1 to the blueprint (`client_id=blueprint`, `scope=api://AzureADTokenExchange/.default`, `fmi_path=<agent identity>`, `client_assertion=<realm assertion>`) yielding T1, step 2 as the agent identity (`client_assertion=T1`, `scope=<resource>/.default`); on-behalf-of and refresh as the agent identity with `client_assertion=T1`.
- `createAppRegistrationAuthority`: one client_credentials call as the agent's app; on-behalf-of and refresh with `client_assertion=<realm assertion>`.
- `ENTRA_IDENTITY_MODEL` (`agent-id` | `app-registration`, no default) parses into the `EntraDirectory` ADT, whose variant selects the adapter; capability and DAG definitions never see the model.
- `ENTRA_CLIENT_ID` and the single `fugue-agents` app (ADR-0055) are removed.

### AD-2 (full choice)

AD-2: Authority mode is part of the capability definition, in one catalog with no default

**Choice:** `domain/capability-catalog.ts` holds `CAPABILITY_CATALOG` (`as const satisfies Record<string, CapabilityDefinitionInput>`, where `authority: "app" | "delegated"` and `resource: "graph" | "dynamics"` are both required); interface in Component Design › Capability Catalog.
- `parseCapabilityCatalog` is the only constructor of the branded `CapabilityCatalog`; `authorityOf(scope)` is the only, total reader of a mode (INV-2), because only the catalog module mints a `CapabilityScope`.
- Pass 1 classifies requirement strings with `classifyCapabilities` into `brokered{scope}`, `not-brokered` (e.g. `http`, or an ADR-0051 custom `mycorp:widget` another provider serves) or `unknown` (a brokered namespace — the built-in `msgraph:` and `dynamics:`, even when a data catalog has no key there, or one a data catalog introduces — whose key the catalog lacks). Any `unknown` is the `capability-unknown` refusal (503), first in the precedence, so an undeclared capability never defaults to `app` (FR-005; NFR-010). Pass 1 resolves each brokered mode into the run's name-keyed `access`; the mint path routes by it, reading no mode, and its one catalog fact is `brokeredNamespacesOf(catalog)`, so a brokered-namespace name `access` lacks fails closed.
- `capability-scope.ts` folds into the catalog and is deleted; `KNOWN_SCOPES` and the handle types are re-derived from catalog keys. All three existing capabilities declare `app`.
- Parsed once, at boot: `createHost` calls `loadCapabilityCatalog(HostDeps.capabilityCatalog ?? CAPABILITY_CATALOG)` right after startup (`Err` → `capability-catalog-invalid{faults}`, before any capability connects); nothing parses at module load. The one value goes to the legacy gate until the Phase 4 cut-over, to `composeRunAuthorityWiring` and to the manifest handler, so a data-sourced catalog reaches every INV-2 sibling, and the delegated test capabilities (OOS-004) use the same parser.

### AD-12 (full choice)

AD-12: A resume slice fails closed when the admitted authority drifted from the boot catalog (D5)

**Choice:**
- Every `RunAuthority` variant carries its admitted `access`, so every HITL run is checkable. `RunAccess.passThrough`: the names pass 1 classified `not-brokered`, a fact about this run, not a copy of a catalog fact (`accessOf` builds it; `parseRunAccess` refuses a name also in a map). The `unbrokered` variant carries `UnbrokeredAccess{passThrough}`: every requirement name, since a host without a realm issuer (`REALM_JWT_ISSUER` unset, today's `selectCapabilityBroker` gate) brokers none.
- The pure `checkAdmittedAuthority(access, now: BrokeringNow, requirements)` (`domain/run-authority.ts`, INV-2 sibling through `authorityOf`) classifies each current raw requirement under the boot brokering state (`brokered{catalog}`: `classifyCapability`; `unbrokered`: nothing classifies brokered) and compares it with its admission classification:
  - a name in a map that no longer classifies `brokered` → `removed`;
  - a name in a map whose `authorityOf` mode differs → `mode-changed`;
  - a name in `passThrough` (either access kind) that now classifies `brokered` or `unknown` → `newly-brokered`: an unbrokered run resumed by a now-brokered host fails for every requirement in a brokered namespace (FR-026);
  - a name in neither (the DAG was redeployed with a new requirement) is left to `routeRequirement`'s `refused-not-admitted`, unchanged.
  Changes are sorted by capability name.
- `withRecordedAuthority` runs it at every HITL slice start, unbrokered runs included, before `forRun` and any node; an `Err` builds no handle, and the executor fails the run `authority-unavailable{authority-changed}` (AD-8), so it ends through `endRun` and custody is released. Sync runs have one slice, admitted against the same boot state, so need no check.

### AD-13 (full choice)

AD-13: Re-authorization parks the run at the node through a vendor-neutral framework seam (D6)

**Choice:**
- **Mechanism: a framework park seam.** `DagRunOpts.parkOn?: (error: FrameworkError) => boolean`, consulted by the DAG executor on a wave's non-retriable failures (transitions stay pure): `node-parked` instead of `node-failed` only when EVERY failed node in the wave satisfies it; otherwise `node-failed` with the first non-parkable error in wave order, so a resume never retries a hard-failed node; and the halted phase `parked`, resumed like `retrying` so only the parked node and unfinished siblings re-run; sync `runDag` maps it to `err`; without `parkOn` nothing parks (semantics: File Structure › Framework; one Phase 1 Task with every exhaustive consumer). ADR 0096 records it.
- **Host state.** Only the HITL executor passes `parkOn: isReauthorizationRequired`. `RunStatus` gains `awaiting-reauthorization{nodeId, capability, reason}` (lease-fenced settle) and `reauthorized{nodeId}` (the unleased fenced commit, below); a parked run keeps custody (no `endRun`) while `reauthorizationOpen`; past its run deadline the next reconciliation wakes it and `processRun` settles it `failed` (`authority-unavailable{capability, agent, reauthorization-required{reason}}`), audits `delegation-reauthorization{expired}` and ends it through `endRun`, which releases custody (INV-4; loop-back 15). Both states are LC-2's, the framework `parked` phase LC-3's. The host has no per-person channel, so the re-authorization-required notice goes once per park to the run's owner-team notification channel over the existing renderers, and `GET /runs/:runId` shows the awaiting state, what to present and until when, neither with credential material (S2, the user's decision at loop-back 12).
- **Endpoint.** `POST /runs/:runId/delegation` → `reauthorizeRun`: the same verification and binding as run start (pass 1's expectation builder through `planReauthorization`, then the verifier and pass 2 unchanged), the recorded initiator's `oid` and `tid` required, a fresh on-behalf-of exchange, custody re-established through the lifecycle under a fresh window `custodyExpiryFor(now, max, runDeadlineMs)`, then re-enqueue. Any other presentation is refused with a typed error, audited, and leaves the run parked. Mechanics: Component Design › HITL Authority Continuity and › Delegated Custody.
- **A fresh custody window, never a later deadline** (the user's decision on the loop-back 11 report). A re-authorization is fresh consent: the re-established expiry is ≤ now + max and ≤ the run deadline, which never changes. A run parked `custody-expired` is therefore re-authorizable; only a refused presentation, or under one second of the run deadline left (`reauthorization-window-closed`), keeps it parked. A record evicted while awaiting, before a sweep settles it, takes its custody with it by TTL (INV-4).
- **One fenced commit: record and custody together** (loop-back 13; mechanism: the architecture agent's). `reestablishDelegation` writes nothing; `markReauthorized` builds the re-established record and hands it, with the `Reestablished`, to the custody module's `commitReauthorization`, which owns both writes and both guards: one `setAllIfValues` transaction guarded on the record bytes read, or neither (loop-back 15). A losing concurrent presentation gets 409 `run-not-awaiting-reauthorization` with nothing written, and a record ended or evicted after the read fails the same guard, so no custody outlives its record (INV-4, INV-7, CT-3). Why: WATCH/MULTI is what `setIfValue`/`setIfValues` already run on the tenant ACL (no Lua, ADR-0067); CAS-then-guarded-write leaves a crash gap; dropping `expiresAtMs` from the AAD leaves the orphan (full: `plan-history.md#loop-back-13-plan-design-review-fixes`).
- **Sync runs** cannot suspend: `reauthorization-required` fails them with 401 (the typed re-authorization-required error); neither kind ever falls back to `app`, and FR-027 and AS-041 apply to HITL runs only (S1, the user's decision at loop-back 12).
