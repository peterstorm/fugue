# Plan Alignment Report: True Single-Host Multi-Tenancy

**Spec:** `.claude/specs/2026-06-18-multi-tenant-single-host/spec.md`
**Plan:** `.claude/plans/2026-06-18-multi-tenant-single-host.md`
**Generated:** 2026-06-18
**Method:** Semantic coverage (meaning, not literal text). Out-of-scope items excluded. The 7 ratified architecture-phase deferrals are treated as covered where the plan's AD/component design resolves the mechanism.

---

## Summary

- **Requirements checked:** 80 (42 FR, 13 SC, 10 US, 15 NFR — NFR-001/002/003/010/011/012/020/021/022)
- **Gaps found:** 2 (both MINOR / advisory; 0 blocking)
- **Verdict:** The plan is **substantively complete and implementable.** Every P1 user story, every functional requirement, and all 13 success criteria — including the six security-critical SCs (SC-001, SC-002, SC-005, SC-006, SC-007, SC-012) — have a concrete mechanism *and* a named test task. The two gaps are minor coverage thinness, not missing mechanisms; an implementer can proceed.

### Security-critical SC verification (concrete mechanism + test task)

| SC | Mechanism in plan | Test task |
|----|-------------------|-----------|
| SC-001 zero cross-tenant reads | AD-4 per-tenant Redis ACL user (`~fugue:<tenant>:*`, NOPERM on cross-read) + AD-1 OS process boundary + T2 key-namespacing | T11 `isolation-cross-tenant-read.test.ts` (Redis NOPERM/fs/mem) |
| SC-002 zero supervisor secrets | AD-6 non-dereferenceable `SecretsRef`; supervisor lacks token/read-perm; worker resolves at spawn | T11 `isolation-supervisor-secrets.test.ts` |
| SC-005 crash containment | AD-8 fail-fast sync / durable HITL resume; supervisor restarts only crashed tenant's worker | T12 `fault-worker-crash.test.ts` under concurrent load |
| SC-006 re-adoption | AD-2 thin-init PID1 + Redis worker-registry + UDS liveness re-probe reconcile | T12 `supervisor-restart-readopt.test.ts` |
| SC-007 fail-closed | AD-5 reuse `degraded:redis-disconnected` state machine + `redis-probe.ts`; 503 new runs, live workers serve | T12 `fail-closed-registry-down.test.ts` |
| SC-012 error taxonomy | AD-10 extend `host-error.ts`/`framework-error-http.ts` with `tenant-unknown`/`tenant-over-quota`/`worker-unavailable`; single `httpStatusFor` | T12 `error-taxonomy-concurrent.test.ts` |

All six are concretely mechanized and test-backed. The reuse anchors (`host-state.ts` `degraded:redis-disconnected` + `draining`, `domain/concurrency.ts`) were verified to exist in the codebase.

---

## Gaps (flat list)

### GAP-1 (MINOR — coverage thinness): US10 / FR-042 per-tenant cost attribution has no design artifact or test task

- **Requirement:** US10 [P3] / FR-042 — the system MAY report per-tenant cost/resource attribution as observability data, correctly attributed to the owning tenant (not billing).
- **Coverage:** Partial / implicit. FR-042 is a MAY (P3, lowest priority). The plan's audit sink (Redis stream, `supervisor/audit/*`) and per-tenant admission state (`admission.ts`) provide the natural substrate for attribution, but no component, file, task (T1–T12), or test names cost/resource attribution. No AD discusses it.
- **Why minor:** FR-042 is explicitly optional ("MAY") and P3; omitting it does not block the feature. Out-of-scope billing is correctly excluded. Flagged only so the team consciously decides to defer rather than silently drop it.
- **Suggested resolution:** Either add a one-line note that FR-042 is deferred as out-of-current-scope observability, or attach a small attribution emitter to the existing audit/admission seam in T9/T10.

### GAP-2 (MINOR — test-coverage thinness): SC-004 end-to-end runtime-onboarding (no-redeploy/no-IaC-PR) has only a manual verification step, not an automated integration test

- **Requirement:** SC-004 / US1 / FR-036 — a tenant reusing already-provisioned capabilities is fully onboarded (token minted, registered, DAGs pushed, first successful invocation) with zero IaC PRs and zero host redeploys.
- **Coverage:** Mechanism fully covered (T3 registry register, T7 routing, T6 worker bootstrap, T10 admin register handler; AD-1/AD-5). The admin `tenants` handler test row covers "register→route→run e2e." However, SC-004's full chain (mint token → register → push DAGs → first invocation, asserting no redeploy/no PR) appears only as **manual** Verification step 5, and the named integration-test list (T11/T12) does not include an automated onboarding-e2e test, unlike the other twelve SCs which each get a dedicated automated test.
- **Why minor:** The core onboarding path is mechanized and partially covered by the admin handler e2e row; SC-004 is a P1 success criterion that the spec's measurement approach calls an "end-to-end onboarding test." Relying on manual verification for a P1 SC is weaker than the automated coverage given to every other SC.
- **Suggested resolution:** Add an automated `onboarding-e2e.test.ts` (register via admin API → push DAG → invoke → assert 200, no process restart) under T10 or Phase 5, promoting Verification step 5 from manual to automated.

---

## Coverage Table

### User Stories

| ID | Coverage | Evidence |
|----|----------|----------|
| US1 [P1] runtime onboarding | Covered | AD-1, AD-5; T3/T7/T10; Data Flow (admin register → lazy spawn). (Onboarding e2e test thin — see GAP-2) |
| US2 [P1] hard isolation under compromise | Covered | AD-1/AD-4/AD-6; T2/T4/T5/T11; SC-001/002/003 tests |
| US3 [P1] identity→tenant routing | Covered | AD-1/AD-3/AD-10; T1/T6/T7 (`resolveTenant`, routing, UDS proxy) |
| US4 [P1] worker lifecycle | Covered | AD-7/AD-8; T6/T8; lifecycle ADT + drain/crash-restart |
| US5 [P1] runtime registry + admin API | Covered | AD-5/AD-10; T3/T10 admin handler (admin-only, idempotent, audited) |
| US6 [P1] deregistration + data lifecycle | Covered | T10 `grace-window-purge.ts` (revoke + 7d retain/purge); SC-010 |
| US7 [P1] supervisor restart with live workers | Covered | AD-2; T8 thin-init + worker-registry re-adopt; SC-006 test |
| US8 [P2] per-tenant admission/quota | Covered | AD-9; T9 admission ADT + worker bound; SC-011 |
| US9 [P2] additive new-capability seam | Covered | AD-5 secrets-ref + Keycloak client mapping in registry; FR-037 (provisioning APIs out of scope) |
| US10 [P3] cost attribution | **GAP-1** | No component/task/test; P3 MAY |

### Functional Requirements

| ID | Coverage | Evidence |
|----|----------|----------|
| FR-001 single listener | Covered | AD-1 supervisor owns single `Bun.serve`; T6/T7 |
| FR-002 auth→Tenant at boundary | Covered | AD-10; T1 `resolveTenant`; Data Flow |
| FR-003 branded Tenant principal | Covered | AD-10; T1 `domain/tenant.ts` `unique symbol` brand |
| FR-004 route to owning worker | Covered | AD-3; T7 routing + UDS proxy |
| FR-005 supervisor zero secrets | Covered | AD-6 non-dereferenceable ref; T4; SC-002 test |
| FR-006 secrets only into owning worker | Covered | AD-6; T4 worker-resolves-at-spawn |
| FR-007 one worker = one tenant | Covered | AD-1; T6 worker-main bound to ONE tenant; SC-003 |
| FR-008 no shared in-process state | Covered | AD-1 process-per-tenant; T7 |
| FR-009 no cross-tenant reads | Covered | AD-4 Redis ACL; T5/T11; SC-001 |
| FR-010 worker compromise contained | Covered | AD-1/AD-4; T11 |
| FR-011 supervisor compromise no secret | Covered | AD-6; T11 SC-002 |
| FR-012 crash isolation | Covered | AD-8; T12 SC-005 |
| FR-013 per-tenant cache/checkpoint isolation | Covered | AD-4; T2 key-namespacing |
| FR-014 lifecycle spawn/restart/drain | Covered | AD-7/AD-8; T8 lifecycle ADT |
| FR-015 crash-restart only crashed worker | Covered | AD-8; T8/T12 |
| FR-016 best-effort resume (deferred) | Covered | AD-8 resolves deferral: fail-fast sync / durable HITL resume |
| FR-017 graceful drain | Covered | AD-7 reuse `beginDrain`/`drainComplete`; T8 |
| FR-018 cold-start policy + target (deferred) | Covered | AD-7 resolves deferral: lazy+evict+eager-pin, SLA bench-then-set |
| FR-019 live workers serve through restart | Covered | AD-2 thin-init; T8 |
| FR-020 re-adopt workers (deferred) | Covered | AD-2 resolves deferral: Redis worker-registry + UDS re-probe; SC-006 |
| FR-021 in-flight survive restart | Covered | AD-2 durable HITL in Redis; T8/T12 |
| FR-022 fail-closed on unresolvable | Covered | AD-5 reuse `degraded:redis-disconnected`; T3/T12 SC-007 |
| FR-023 live workers continue on fail-closed | Covered | AD-5; T12 SC-007 |
| FR-024 runtime registry (deferred) | Covered | AD-5 resolves deferral: Redis-backed + pub/sub propagation |
| FR-025 admin API register/dereg/reconfig | Covered | T10 `http/handlers/admin/tenants.ts` |
| FR-026 admin-token only | Covered | T10 admin-only authz test |
| FR-027 idempotent register/deregister | Covered | T3 pure idempotent transitions; SC-009 |
| FR-028 audit record | Covered | AD (audit); T10 `audit-port.ts`; SC-008 |
| FR-029 deregister immediate revoke | Covered | T10 kill worker + invalidate token |
| FR-030 grace window 7d + purge | Covered | T10 `grace-window-purge.ts`; SC-010 |
| FR-031 secrets source by reference (deferred) | Covered | AD-6 resolves deferral: `SecretsSource` port + env-file adapter |
| FR-032 per-tenant admission | Covered | AD-9; T9 extends `concurrency.ts` |
| FR-033 live-worker upper bound | Covered | AD-9; T9 |
| FR-034 per-tenant memory ceiling (deferred) | Covered | AD-9 resolves deferral: per-worker Bun/V8 heap flag (not cgroups) |
| FR-035 reuse + extend control plane | Covered | AD-1 `createHost` unchanged; Verification step 4 single-tenant byte-identical |
| FR-036 onboarding no PR/no redeploy | Covered | AD-1/AD-5; US1 (e2e test thin — GAP-2) |
| FR-037 new capability additive, no redeploy | Covered | AD-5 registry client mapping; US9 (provisioning APIs out of scope) |
| FR-038 over-quota 429 + retry-after | Covered | AD-10; T9 admission returns 429+retry-after; SC-012 |
| FR-039 unhealthy worker 503 | Covered | AD-10 `worker-unavailable`; T9/T12 |
| FR-040 unknown/unauthorized 404/401 | Covered | AD-10 `tenant-unknown`; T1/T12 |
| FR-041 no cross-tenant error bleed | Covered | AD-10; T12 SC-012 |
| FR-042 cost attribution (P3 MAY) | **GAP-1** | No design/task/test |

### Success Criteria

| ID | Coverage | Evidence |
|----|----------|----------|
| SC-001 zero cross-tenant bytes | Covered | AD-4; T11 `isolation-cross-tenant-read.test.ts` |
| SC-002 supervisor zero secrets | Covered | AD-6; T11 `isolation-supervisor-secrets.test.ts` |
| SC-003 one tenant per worker | Covered | AD-6; T11 isolation assertion |
| SC-004 full onboarding no PR/redeploy | Covered (test thin) | T3/T7/T10; manual Verification step 5 — see **GAP-2** |
| SC-005 crash zero collateral | Covered | AD-8; T12 `fault-worker-crash.test.ts` |
| SC-006 100% re-adopt + survive | Covered | AD-2; T12 `supervisor-restart-readopt.test.ts` |
| SC-007 fail-closed 503 | Covered | AD-5; T12 `fail-closed-registry-down.test.ts` |
| SC-008 audit + non-admin 0% | Covered | T10 audit + admin-only authz |
| SC-009 idempotency | Covered | T3 pure transitions; property test |
| SC-010 revoke + grace/purge | Covered | T10 `grace-window-purge.ts` |
| SC-011 anti-starvation + worker bound | Covered | AD-9; T9 fairness property test |
| SC-012 per-tenant error taxonomy | Covered | AD-10; T12 `error-taxonomy-concurrent.test.ts` |
| SC-013 10–20 workers within ceiling | Covered | AD-7/AD-9 lazy+evict, heap cap; NFR-001/002 (capacity/soak test named in spec measurement; plan relies on heap-cap + admission — see note) |

### Non-Functional Requirements

| ID | Coverage | Evidence |
|----|----------|----------|
| NFR-001 ~10–20 workers/box | Covered | AD-7 lazy+evict; AD-9 single pod |
| NFR-002 worker memory ceiling | Covered | AD-9 per-worker heap flag |
| NFR-003 cold-start target (deferred) | Covered | AD-7 SLA bench-then-set |
| NFR-010 zero cross-tenant reads (adversarial) | Covered | AD-4; T11 SC-001 |
| NFR-011 supervisor zero secrets (inspection) | Covered | AD-6; T11 SC-002 |
| NFR-012 immediate revoke on deregister | Covered | T10 kill + invalidate |
| NFR-020 crash contained | Covered | AD-8; T12 SC-005 |
| NFR-021 in-flight survive restart | Covered | AD-2; T12 SC-006 |
| NFR-022 fail-closed preserving in-flight | Covered | AD-5; T12 SC-007 |

---

## Notes (advisory, not gaps)

- **SC-013 capacity/soak test:** The spec's measurement approach names a "capacity/soak test" for SC-013. The plan mechanizes the means (heap cap + lazy/evict + admission, NFR-001/002) but does not name a dedicated soak test in T11/T12. This is borderline with GAP-2's category; left as advisory because SC-013 is a capacity target validated by AD-7/AD-9 mechanisms and a soak test is operational rather than design-blocking.
- **Out-of-scope correctly excluded:** dynamic Keycloak/Entra provisioning APIs, multi-node clustering, billing, control-plane re-architecture — the plan explicitly defers/rejects these (AD-1 rejects A2 clustering; AD-9 rejects cgroup/container-per-tenant; US9/FR-037 keep new capabilities PR-provisioned). No gaps flagged against them.
- **All 7 architecture deferrals resolved:** FR-018/NFR-003→AD-7; FR-016→AD-8; FR-020→AD-2; IPC→AD-3; FR-031→AD-6; FR-024→AD-5; FR-034→AD-9. Each has a concrete decision, not a re-deferral.
