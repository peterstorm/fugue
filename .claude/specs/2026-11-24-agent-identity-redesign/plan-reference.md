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
  → HITL: startRun(admitted) → establishForRecord(admitted, deadline, persist = create record{bound.runId, bound.authority})
    sync: acquire → withEstablishedAuthority(admitted, deadline, body)
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
  → verifyReauthorization: planReauthorization (initiator, window, leg, header; 0 JWKS on refusal) → verifyEntraUserToken → admitDelegatedPresentation
  → lifecycle.reauthorize → reestablishDelegation: mint → OBO → fresh expiry ≤ run deadline → seal(AAD = custodyBindingOf(bound')) → get → transitionCustody(reestablish) → replace(new TTL)
  → markReauthorized (CAS on the meta key, writing bound'.authority) → enqueue → processRun resumes the parked checkpoint at the node; audit accepted | refused

Approval: approve route | bot handler → authorizeApproval ─refused→ recordApproval(unauthorized) → audit
  → recordApproval(decide) → resolvePending (one SET NX of the whole decision) → classifyDecisionAttempt → audit
  → executor consumes it → ApprovalRecord in the lease-fenced checkpoint write → onCommitted clears the decision

Run ending: SyncRunEnding | HitlRunEnding (→ endRun) | establishment-abandoned → the lifecycle: releaseCauseOf → custody.delete (INV-4 owner)
Idle TTL eviction → custody TTL (≤ record TTL; an awaiting run's stale wake → endRun(record-evicted)) | tenant purge → purgeTenantKeyspace(fugue:<tenant>:*)
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
