# Feature: True Single-Host Multi-Tenancy for the Fugue Host (Process-per-Tenant Supervisor)

**Spec ID:** 2026-06-18-multi-tenant-single-host
**Created:** 2026-06-18
**Status:** Draft
**Owner:** Peter Hansen

## Summary

Today the fugue host is `host = team = trust boundary`: one tenant per process, and standing up a per-team host rides slow IaC-repo PRs (days-to-weeks). This feature converts the host into a single **supervisor process** that safely serves **many tenants at once** on one box, with **adversary-grade isolation** between them, and lets a tenant that reuses already-provisioned capabilities come online **fully at runtime** (mint token, register, push DAGs) with **no IaC PR and no host redeploy**. Each tenant runs in a dedicated worker process; the OS process boundary is the isolation mechanism. The supervisor holds zero tenant secrets.

---

## User Scenarios

### US1: [P1] Runtime tenant onboarding (no redeploy)

**As a** platform operator onboarding a new tenant that only reuses already-provisioned downstream capabilities
**I want to** mint a tenant token, register the tenant, and push its DAGs against the running host
**So that** the tenant is live in minutes without an IaC PR or host redeploy

**Why this priority:** This is the core ops-pain driver. Without runtime onboarding the feature delivers no value over the status quo.

**Acceptance Scenarios:**
- Given a running supervisor and a tenant that reuses already-provisioned capabilities, When an admin registers the tenant and pushes its DAGs at runtime, Then the tenant can invoke its DAGs with no host redeploy and no IaC PR.
- Given a tenant registration referencing only capabilities already provisioned for the host, When the registration is submitted, Then it succeeds without requiring any config-as-code change.
- Given a tenant that requires a genuinely NEW downstream capability (new Keycloak agent client / new Entra permission or FIC), When onboarding is attempted, Then the system makes clear the new capability requires an additive config-as-code change, but the provisioning of that capability MUST be additive to the running host and MUST NOT require a host redeploy.

### US2: [P1] Hard cross-tenant isolation under compromise

**As a** security owner
**I want to** guarantee that a hostile, compromised, or RCE'd worker cannot read any other tenant's secrets, data, files, or in-memory state
**So that** one tenant's breach can never become another tenant's breach

**Why this priority:** Hard isolation is non-negotiable and is the central security premise of the whole approach.

**Acceptance Scenarios:**
- Given a worker executing arbitrary attacker-controlled code (hostile DAG, compromised dependency, prompt-injection RCE), When it attempts to read another tenant's secrets, filesystem, cache/checkpoint data, or in-memory state, Then it obtains zero bytes of another tenant's material.
- Given any worker process, When its loaded configuration and secrets are inspected, Then it holds exactly one tenant's config/secrets/data and no other tenant's.
- Given the supervisor process, When its memory and state are inspected at any point in its lifetime, Then it contains zero tenant secrets — only auth, routing, and registry metadata.

### US3: [P1] Identity-to-tenant routing at the boundary

**As a** caller invoking a DAG
**I want to** authenticate once at the single host endpoint and be routed to my own tenant's worker
**So that** my requests execute against my tenant's isolated runtime and authz

**Why this priority:** The supervisor's request boundary is what makes multi-tenancy on one listener possible; routing is foundational to every other scenario.

**Acceptance Scenarios:**
- Given an authenticated caller whose identity maps to a registered tenant, When a request arrives at the single HTTP listener, Then the supervisor resolves the `Tenant` principal at the boundary and routes to that tenant's owning worker.
- Given a caller whose identity does not map to any registered tenant, When a request arrives, Then it is rejected as unknown/unauthorized (404/401) with no cross-tenant information leakage.
- Given a resolved `Tenant` principal, When the worker evaluates `canAccessDag` and other authz, Then authz decisions are made against that tenant's principal and never against another tenant's data.

### US4: [P1] Worker lifecycle (spawn, crash-restart, graceful drain)

**As a** platform operator
**I want to** have workers spawned, restarted after crashes, and drained gracefully under supervisor control
**So that** tenant runtimes are reliable and a crash is contained to one tenant

**Why this priority:** Lifecycle is required for the supervisor to serve tenants safely and to satisfy crash-containment isolation.

**Acceptance Scenarios:**
- Given a request for a registered tenant with no live worker, When the supervisor needs to serve it, Then it spawns a worker scoped to exactly that tenant.
- Given a tenant worker crashes mid-run, When the supervisor detects the crash, Then no other tenant's worker or runs are affected, and the supervisor restarts the crashed tenant's worker.
- Given a worker crashed mid-run, When the worker is restarted, Then the crashed tenant's in-flight run resumes from its last checkpoint on a best-effort basis (durable HITL runs survive). [DEFERRED TO ARCHITECTURE: run-resume vs fail-fast mechanism]
- Given an operator initiates a graceful drain of a worker, When drain is requested, Then in-flight runs are allowed to complete (or checkpoint) before the worker is shut down.

### US5: [P1] Runtime tenant registry and admin lifecycle API

**As a** platform admin
**I want to** register, deregister, and reconfigure tenants at runtime via an authenticated admin API
**So that** tenant lifecycle is managed live without redeploying the host

**Why this priority:** Runtime onboarding (US1) and routing (US3) depend on a live, mutable registry; lifecycle operations are P1.

**Acceptance Scenarios:**
- Given an admin-token-authenticated request, When it registers a new tenant with config (secrets source, fs root, Keycloak client mapping, etc.), Then the tenant becomes resolvable for routing and an audit record (actor, timestamp, tenant, action) is emitted.
- Given a register or deregister request that has already been applied, When it is submitted again with the same parameters, Then the operation is idempotent and produces the same end state.
- Given a non-admin token, When it attempts register/deregister/reconfigure, Then the request is rejected (unauthorized) and no lifecycle change occurs.
- Given a reconfigure request for an existing tenant, When applied, Then the tenant's effective config is updated for subsequent runs and an audit record is emitted.

### US6: [P1] Tenant deregistration and data lifecycle

**As a** platform admin offboarding a tenant
**I want to** revoke a tenant's access immediately while retaining its footprint for a grace window before purge
**So that** access stops at once but recoverable data is not destroyed prematurely

**Why this priority:** Deregistration is part of the P1 lifecycle and carries the strongest data-handling and access-revocation guarantees.

**Acceptance Scenarios:**
- Given a tenant is deregistered, When the operation completes, Then the tenant's worker is killed, its token is invalidated, and it can no longer be routed to or invoke DAGs.
- Given a tenant has been deregistered, When the grace window (default 7 days, configurable) has not elapsed, Then the tenant's footprint (fs mount, secrets, cache/checkpoint keys) is retained.
- Given a deregistered tenant whose grace window has elapsed, When the purge runs, Then the tenant's retained footprint is auto-purged.

### US7: [P1] Supervisor restart with live workers

**As a** platform operator
**I want to** restart the supervisor while tenant workers are live and keep in-flight runs surviving
**So that** supervisor maintenance does not cause tenant downtime or lost runs

**Why this priority:** Supervisor availability semantics are core to the single-host reliability story.

**Acceptance Scenarios:**
- Given live workers serving runs, When the supervisor is restarted, Then existing workers keep serving their in-flight work.
- Given the supervisor has restarted, When it comes back up, Then it re-adopts the still-live workers and resumes routing to them. [DEFERRED TO ARCHITECTURE: worker re-adoption mechanism]
- Given in-flight runs at the moment of supervisor restart, When the supervisor returns, Then those runs survive the restart.

### US8: [P2] Per-tenant resource admission / anti-starvation quota

**As a** platform operator on a shared box
**I want to** enforce per-tenant concurrency/resource admission and an upper bound on live workers
**So that** no single tenant can exhaust the box and starve others

**Why this priority:** Important for fairness and stability but the system can deliver isolated multi-tenancy before quotas are fully enforced; defers behind P1.

**Acceptance Scenarios:**
- Given a tenant at its admission/quota ceiling, When it submits additional work, Then the supervisor refuses the excess for that tenant only, returning over-quota (429) with a retry-after, and other tenants are unaffected.
- Given the box is at its configured upper bound on live workers, When a new tenant would require a worker beyond that bound, Then the supervisor enforces the bound rather than over-committing the box.
- Given one tenant generating heavy load, When other tenants submit work concurrently, Then other tenants' admission and latency are not degraded by the heavy tenant beyond their own fair share. [DEFERRED TO ARCHITECTURE: depth of resource enforcement (process-level admission only vs cgroup CPU/memory limits)]

### US9: [P2] Additive config-as-code seam for a NEW downstream capability

**As a** platform engineer onboarding a tenant that needs a genuinely new downstream capability
**I want to** a defined, additive config-as-code path to provision a new Keycloak agent client / Entra permission / FIC
**So that** the new capability is added to the running host without a redeploy

**Why this priority:** Only a subset of onboardings need new capabilities; the common case (US1) needs no PR. Valuable but not blocking.

**Acceptance Scenarios:**
- Given a tenant needs a new downstream capability, When the additive config-as-code change is merged and applied, Then the running host can register/use that capability without a host redeploy.
- Given a new capability has not yet been provisioned, When a tenant attempts to use it, Then the system fails clearly indicating the capability is unprovisioned, without leaking other tenants' capability config.

### US10: [P3] Per-tenant cost attribution / metering

**As a** platform owner
**I want to** observe per-tenant resource/cost attribution
**So that** I can understand tenant cost without building billing

**Why this priority:** Observability-only nice-to-have; explicitly not billing. Lowest priority.

**Acceptance Scenarios:**
- Given tenants running workloads, When attribution is queried, Then per-tenant usage is reported as observability data, attributed correctly to the owning tenant.

---

## Functional Requirements

### Core Requirements — Supervisor, Routing, Principal

- FR-001: The system MUST expose a single HTTP listener owned by a supervisor process; tenants MUST NOT each own a separate inbound listener.
- FR-002: The supervisor MUST authenticate inbound identity and resolve it to a `Tenant` principal at the request boundary before any tenant work is dispatched.
- FR-003: `Tenant` MUST be a first-class, branded security principal threaded through routing and authorization (extending, not replacing, the existing identity→team auth and `canAccessDag` authz).
- FR-004: The supervisor MUST route each request to the worker that owns the resolved tenant, and MUST NOT route a request to any worker that does not own that tenant.
- FR-005: The supervisor MUST hold zero tenant secrets at any time; it MUST deal only in authentication, routing, and registry metadata.
- FR-006: Tenant secrets MUST flow only into the owning tenant's worker and MUST NOT transit the supervisor process, even transiently.
- FR-007: A worker MUST run exactly one tenant's DAGs and MUST hold exactly one tenant's config, secrets, filesystem mount, and in-memory state.
- FR-008: The system MUST NOT maintain any shared in-process tenant state across tenants.

### Core Requirements — Isolation

- FR-009: A worker executing arbitrary code MUST NOT be able to read another tenant's secrets, data, files, or in-memory state (cross-tenant reads MUST be zero).
- FR-010: A compromise of one worker MUST NOT yield access to any other tenant's material.
- FR-011: A compromise of the supervisor MUST NOT yield any tenant secret.
- FR-012: A worker crash MUST NOT affect any other tenant's worker or runs.
- FR-013: Per-tenant cache/checkpoint isolation MUST be preserved (the existing dagId-prefixed key scheme MUST continue to scope state per tenant).

### Core Requirements — Worker Lifecycle

- FR-014: The supervisor MUST manage worker lifecycle: spawn, crash-detection-and-restart, and graceful drain/shutdown.
- FR-015: On worker crash, the supervisor MUST restart the crashed tenant's worker without disturbing other tenants' workers.
- FR-016: On worker restart after a mid-run crash, the system MUST attempt best-effort resume of the crashed tenant's in-flight run from its last checkpoint, reusing existing checkpoint machinery; durable HITL runs MUST survive. [DEFERRED TO ARCHITECTURE: run-resume vs fail-fast mechanism]
- FR-017: On graceful drain, the system MUST allow in-flight runs to complete or checkpoint before the worker is shut down.
- FR-018: The cold-start latency target and the worker lifecycle policy (lazy / eager / warm-pool) MUST be defined. [DEFERRED TO ARCHITECTURE: cold-start policy and latency target]

### Core Requirements — Supervisor Availability

- FR-019: When the supervisor restarts, live workers MUST continue serving their in-flight work.
- FR-020: After a restart, the supervisor MUST re-adopt still-live workers and resume routing to them. [DEFERRED TO ARCHITECTURE: worker re-adoption mechanism]
- FR-021: In-flight runs MUST survive a supervisor restart.

### Core Requirements — Fail-Closed Resolution

- FR-022: If the supervisor cannot resolve or verify a tenant (registry or backing infra unavailable), it MUST fail closed and refuse to start new runs (503-style) rather than route on stale or guessed config.
- FR-023: When tenant resolution fails closed, already-running workers MUST continue serving their in-flight work.

### Data Requirements — Registry and Lifecycle

- FR-024: The system MUST maintain a runtime tenant registry holding per-tenant config (secrets source reference, filesystem root, Keycloak client mapping, etc.), mutable at runtime. [DEFERRED TO ARCHITECTURE: registry storage and mutation-propagation mechanism]
- FR-025: The system MUST expose an admin API to register, deregister, and reconfigure tenants at runtime.
- FR-026: Register, deregister, and reconfigure operations MUST be restricted to admin-token authentication only.
- FR-027: Register and deregister operations MUST be idempotent.
- FR-028: Every tenant lifecycle operation (register / deregister / reconfigure) MUST emit an audit record containing at least actor, timestamp, tenant, and action.
- FR-029: Deregistration MUST immediately revoke the tenant's access by killing its worker and invalidating its token.
- FR-030: Deregistration MUST retain the tenant's footprint (filesystem mount, secrets, cache/checkpoint keys) for a configurable grace window defaulting to 7 days, after which the footprint MUST be auto-purged.
- FR-031: The per-tenant secrets source MUST be referenced by registry metadata and resolved only within the owning worker. [DEFERRED TO ARCHITECTURE: per-tenant secrets source]

### Requirements — Resource Admission (P2)

- FR-032: The supervisor MUST enforce per-tenant resource admission/quota, replacing the single global concurrency limit, such that no single tenant can exhaust the box.
- FR-033: The supervisor MUST enforce a configurable upper bound on the number of live workers and MUST NOT exceed it.
- FR-034: Per-tenant memory MUST be bounded by a configurable per-tenant ceiling (order hundreds of MB). [DEFERRED TO ARCHITECTURE: depth of resource enforcement (admission-only vs cgroup CPU/memory limits) and host platform]

### Integration Requirements — Capabilities and Reuse

- FR-035: The system MUST reuse the existing tenant-aware control plane (identity→team auth, `canAccessDag`, per-team token store, per-invocation Keycloak capability broker, dagId-prefixed cache keys, multi-team HITL) and extend rather than replace it.
- FR-036: Onboarding a tenant that reuses already-provisioned capabilities MUST require no IaC PR and no host redeploy.
- FR-037: Provisioning a genuinely new downstream capability (new Keycloak agent client / new Entra permission or FIC) MAY require an additive config-as-code change, but MUST be additive to the running host and MUST NOT require a host redeploy.

### Error Taxonomy Requirements (caller/operator visible)

- FR-038: When a tenant is over its quota, the system MUST return an over-quota response (429) including a retry-after, scoped to that tenant only.
- FR-039: When a tenant's worker is unhealthy or unavailable, the system MUST return a service-unavailable response (503) scoped to that tenant only.
- FR-040: When a tenant is unknown or the caller is unauthorized, the system MUST return a not-found/unauthorized response (404/401) without leaking the existence or state of other tenants.
- FR-041: One tenant's saturation, failure, or error state MUST NEVER surface as another tenant's error.

### Observability Requirements (P3)

- FR-042: The system MAY report per-tenant cost/resource attribution as observability data, correctly attributed to the owning tenant; this MUST NOT constitute a billing system.

---

## Non-Functional Requirements

### Performance / Capacity

- NFR-001: A single box MUST support a target of approximately 10–20 active tenant workers.
- NFR-002: Per-tenant worker memory MUST stay within its configured ceiling (order hundreds of MB).
- NFR-003: Cold-start latency for serving a tenant's first request MUST meet a defined target. [DEFERRED TO ARCHITECTURE: cold-start latency target]

### Security

- NFR-010: Cross-tenant reads of secrets, data, files, or in-memory state MUST be zero, verifiable under an adversarial worker.
- NFR-011: The supervisor process MUST contain zero tenant secrets, verifiable by process inspection.
- NFR-012: Tenant access MUST be revocable immediately on deregistration (worker killed, token invalidated).

### Reliability

- NFR-020: A worker crash MUST be contained to its own tenant (zero impact on other tenants).
- NFR-021: In-flight runs MUST survive a supervisor restart.
- NFR-022: The system MUST fail closed (refuse new runs) when tenant resolution cannot be verified, while preserving in-flight work on live workers.

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: A worker executing arbitrary adversarial code reads **zero bytes** of any other tenant's secrets, files, cache/checkpoint data, or in-memory state — verified by an adversarial cross-tenant read test that MUST fail to obtain any other tenant's material.
- SC-002: Inspection of the supervisor process memory/state across its lifetime reveals **zero** tenant secrets — verified by a supervisor-secrets-absence test.
- SC-003: Every spawned worker holds exactly **one** tenant's config/secrets — verified by an isolation assertion test across all live workers.
- SC-004: A tenant reusing already-provisioned capabilities is fully onboarded (token minted, registered, DAGs pushed, first successful invocation) with **zero** IaC PRs and **zero** host redeploys.
- SC-005: A worker crash mid-run causes **zero** failed or disrupted runs in any other tenant — verified by a fault-injection test that crashes one tenant's worker under concurrent multi-tenant load.
- SC-006: After a supervisor restart while N workers are live, **100%** of in-flight runs survive and the supervisor re-adopts and resumes routing to **all N** previously-live workers.
- SC-007: When the registry/backing infra is unavailable, **100%** of new-run requests are refused with a 503-style response and **zero** requests are routed on stale/guessed config; in-flight runs on live workers continue at **100%**.
- SC-008: **100%** of register/deregister/reconfigure operations emit an audit record with actor, timestamp, tenant, and action; **0%** succeed under a non-admin token.
- SC-009: Repeating an identical register or deregister operation produces an identical end state in **100%** of cases (idempotency).
- SC-010: On deregistration, tenant access is revoked in such that subsequent invocation attempts are rejected at a **100%** rate; the tenant footprint is retained until the configurable grace window (default 7 days) elapses, then auto-purged.
- SC-011: Under a single tenant attempting to saturate the box, other tenants experience **zero** quota rejections attributable to the heavy tenant and the live-worker upper bound is **never** exceeded.
- SC-012: A tenant over quota receives **429 + retry-after**; an unhealthy-worker tenant receives **503**; an unknown/unauthorized tenant receives **404/401** — and in **zero** cases does one tenant's failure surface as another tenant's error (verified by a per-tenant error-taxonomy test under concurrent load).
- SC-013: The box sustains the target of **10–20** active tenant workers with each worker within its configured memory ceiling.

**Measurement approach:** Adversarial/fault-injection isolation tests (SC-001, SC-002, SC-003, SC-005), end-to-end onboarding test (SC-004), supervisor-restart re-adoption test (SC-006), fail-closed test (SC-007), admin-authz + audit + idempotency tests (SC-008, SC-009), deregistration lifecycle test with grace-window simulation (SC-010), anti-starvation load test (SC-011), error-taxonomy concurrency test (SC-012), and capacity/soak test (SC-013).

---

## Out of Scope

Explicitly NOT part of this feature (YAGNI):

- Dynamic Keycloak/Entra **provisioning APIs** (runtime creation of new clients/apps). New downstream capabilities stay PR-provisioned, additive to the running host.
- Cross-host / multi-node supervisor **clustering**. One box, one supervisor.
- A full per-tenant **billing** system. Per-tenant attribution/metering (observability only) MAY be included; billing is not.
- **Re-architecting** the already-tenant-aware control plane (auth→team, `canAccessDag`, token store, capability broker, cache keys, HITL). It is reused and extended, not rebuilt.

---

## Open Questions

These 7 items are **ratified, confirmed deferrals to the architecture phase** (decided 2026-06-18 with the user). The user-observable *requirements* and success criteria are fixed and unchanged; only the *technical mechanism* of each is deferred. They are NOT genuine requirement ambiguities and do NOT block the clarify gate. The architecture-tech-lead phase will decide each mechanism via its own interview + approach gate.

1. Worker lifecycle policy + cold-start latency target — lazy / eager / warm-pool, and the latency number. [DEFERRED TO ARCHITECTURE] (FR-018, NFR-003)
2. Mid-run crash handling — run-resume from checkpoint vs fail-fast mechanism. [DEFERRED TO ARCHITECTURE] (FR-016)
3. Supervisor restart — worker re-adoption mechanism. [DEFERRED TO ARCHITECTURE] (FR-020)
4. Supervisor⇆worker IPC mechanism (UDS / stdio JSON-RPC / Redis queue / localhost HTTP). [DEFERRED TO ARCHITECTURE] (routing contract, underlies FR-004)
5. Per-tenant secrets source (Vault path / encrypted Redis blob / injected env file). [DEFERRED TO ARCHITECTURE] (FR-031)
6. Tenant registry storage and live-mutation propagation to supervisor and workers. [DEFERRED TO ARCHITECTURE] (FR-024)
7. Resource enforcement depth — process-level admission only vs cgroup CPU/memory limits, and host platform. [DEFERRED TO ARCHITECTURE] (FR-034)

---

## Dependencies

External factors and existing systems this feature depends on and extends:

- Existing identity→team authentication (`packages/host/src/domain/auth.ts`).
- Existing `canAccessDag` pure authorization.
- Existing per-team token store (`fugue:tokens:*` / `fugue:teams:*`).
- Existing per-invocation Keycloak capability broker keyed on `agentClientId`.
- Existing dagId-prefixed cache/checkpoint key scheme (`packages/host/src/domain/cache-keys.ts`).
- Existing multi-team HITL (`HITL_APPROVER_TEAMS` / `HITL_TEAM_CHANNELS`) and durable run/checkpoint machinery.
- Keycloak and Entra config-as-code repos (for additive new-capability provisioning only).
- A single host OS providing process-level isolation (and optionally cgroups) as the isolation primitive.

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Isolation gap leaks one tenant's data to another | High | Make isolation a first-class, adversarially-tested success criterion (SC-001..003, SC-005); OS process boundary as primary mechanism |
| Supervisor becomes a secrets choke point and a high-value target | High | Hard requirement that supervisor holds zero secrets (FR-005/006, SC-002); secrets flow only into owning worker |
| Cold-start latency degrades first-request UX | Med | Define lifecycle policy + latency target in architecture phase (deferral 1); consider warm pool |
| One tenant starves the box | Med | Per-tenant admission, live-worker upper bound, per-tenant memory ceiling (FR-032..034); anti-starvation test (SC-011) |
| Supervisor restart drops in-flight runs or orphans workers | Med | Workers keep serving; re-adoption + run survival required (FR-019..021); deferral 3 resolves mechanism |
| Registry/infra outage routes on stale config | High | Fail-closed requirement (FR-022/023, SC-007) |
| New-capability path tempts a redeploy | Low | Explicit requirement that new-capability provisioning is additive, never a redeploy (FR-037) |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Supervisor | The single host process owning the HTTP listener, inbound identity→tenant auth, tenant registry, per-tenant admission, and tenant→worker routing/lifecycle. Holds no tenant secrets. |
| Worker | A dedicated process running exactly one tenant's DAGs, with its own env, secrets, filesystem mount, and heap. The unit of isolation. |
| Tenant | A first-class branded security principal resolved at the supervisor boundary; the trust boundary the system now isolates (replacing host=team=trust boundary). |
| Already-provisioned capability | A downstream capability (Keycloak agent client / Entra permission / FIC) already available to the host; reusing it requires no PR and no redeploy. |
| New downstream capability | A capability not yet provisioned; requires an additive config-as-code change, never a host redeploy. |
| Runtime tenant registry | The live, mutable store of per-tenant config used by the supervisor to resolve and route tenants. |
| Grace window | The configurable retention period (default 7 days) after deregistration before a tenant's footprint is auto-purged. |
| Fail-closed | Refusing new runs when a tenant cannot be resolved/verified, rather than routing on stale or guessed config. |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-18 | Initial draft (post full interview) | Peter Hansen |
| 2026-06-18 | Clarify: 7 technical-mechanism markers ratified as confirmed architecture-phase deferrals (no requirement ambiguities) | Peter Hansen |
