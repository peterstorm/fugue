# ADR-0064: Overall approach — supervisor + process-per-tenant workers, HTTP-over-UDS (the A3 hybrid)

## Status

Accepted

## Date

2026-06-19

## Context

The fugue host historically equated `host = team = trust boundary`: one tenant per
process, stood up by a per-team deployment whose provisioning rode slow IaC-repo
PRs (days-to-weeks). That model has two structural costs the multi-tenant
single-host effort exists to remove. First, onboarding a tenant that only reuses
already-provisioned downstream capabilities still required an IaC PR and a host
redeploy (the FR-036 pain). Second, there was no way to serve many tenants on one
box at once, so capacity was a function of how many separate hosts ops could
afford to stand up and maintain.

The effort's premise is to make the runtime serve **many tenants on one box at
once**, with **adversary-grade isolation** between them, and let a tenant that
reuses existing capabilities come online **fully at runtime** — no IaC PR, no host
redeploy (US1, FR-036). FR-001 fixes the request-plane shape: there MUST be a
**single** HTTP listener owned by a supervisor process, and tenants MUST NOT each
own a separate inbound listener. US3 fixes the routing requirement: a caller
authenticates once at that single endpoint, and the boundary resolves the caller's
identity to its `Tenant` and routes the request to that tenant's own runtime and
authz. FR-035 is the load-bearing constraint on *how*: the system MUST **reuse**
the existing already-tenant-aware control plane — identity→team auth,
`canAccessDag`, the per-team token store, the per-invocation Keycloak capability
broker, the dagId-prefixed cache keys, multi-team HITL — and **extend** it, not
rebuild it. Re-architecting that control plane is explicitly out of scope.

The forces in tension are therefore: (1) **hard isolation** — a compromised or
RCE'd worker must read zero bytes of another tenant's secrets, files, or in-memory
state (US2/SC-001), which rules out a shared heap; (2) **runtime onboarding with
no redeploy** (FR-036), which rules out anything whose tenant-add path is a deploy
or an orchestration-PR; (3) **maximal reuse of the shipped control plane**
(FR-035), which strongly favours keeping the existing per-tenant request handlers
and the existing HTTP request/response contract intact rather than rewriting them
behind a new transport. The decision this ADR records is the **overall runtime
shape** that resolves those three forces simultaneously — the foundational choice
every sibling ADR (topology, IPC, isolation, registry, secrets, lifecycle)
elaborates.

## Options Considered

1. **A1 — In-process tenant multiplexing (resolve the tenant inside one host process and serve every tenant from one shared heap).**
   - Pros: Trivially satisfies the single-listener requirement (FR-001) — there is
     only one process. No IPC, no spawn, no socket; lowest possible cross-tenant
     latency. Onboarding is pure in-memory state, so FR-036 (no redeploy) falls out
     for free.
   - Cons: A **shared heap means no hard isolation**. A compromised tenant — a
     hostile DAG, a poisoned dependency, a prompt-injection RCE — can read every
     other tenant's secrets, decrypted material, and in-memory state directly out of
     the same address space. This is the explicit anti-goal in
     `docs/team-security-and-capabilities.md §1` and a direct violation of US2 / FR-009
     / SC-001 (zero cross-tenant reads under an adversarial worker). No amount of
     application-layer discipline closes a same-process read for code the attacker
     controls. **Disqualified by the central security premise of the feature.**

2. **A2 — Full container-per-tenant / one k8s pod per tenant (orchestration-level isolation).**
   - Pros: Strongest possible isolation (separate kernels-eye process trees,
     cgroups, network namespaces per tenant); conceptually the cleanest blast-radius
     story.
   - Cons: **Re-introduces exactly the latency the feature exists to remove** —
     adding a tenant becomes an orchestration change (pod spec / IaC PR / rollout),
     violating FR-036's "no IaC PR and no host redeploy". It also breaks the
     single-pod model (NFR-001 targets 10–20 tenants on **one** box) and drags in
     cross-host clustering, which is explicitly out of scope. Cost and ops blow up
     linearly in tenants. **Disqualified by the no-redeploy onboarding requirement
     and the single-box scope.**

3. **A3 hybrid — supervisor + process-per-tenant workers, HTTP-over-UDS (chosen).**
   The supervisor process owns the single inbound listener, does identity→`Tenant`
   resolution, admission, registry, and routing/lifecycle, and holds zero tenant
   secrets. Each tenant runs in a dedicated **worker process** — `createHost` bound
   to exactly one tenant — serving on its own per-tenant Unix domain socket. The
   supervisor reverse-proxies each request over the owning worker's UDS, carrying
   the **existing HTTP contract** unchanged.
   - Pros: The **OS process boundary** is the isolation primitive — a worker has its
     own heap, env, and secrets, so a compromised worker cannot read another
     tenant's in-memory state (US2/SC-001). The single listener lives in the
     supervisor (FR-001). Onboarding is a registry write plus a lazy worker spawn —
     **no redeploy, no IaC PR** for reused capabilities (FR-036). Because the
     transport is **HTTP-over-UDS**, the worker body — every existing per-tenant
     handler, `run-dag.ts`, the auth middleware, the capability broker, the HITL
     machinery — is **reused unchanged** (FR-035): the request/response semantics
     the worker already speaks are preserved byte-for-byte. The supervisor stays
     thin (routing + registry + admission; no execution, no secrets), keeping it a
     small, auditable, low-value-to-compromise process.
   - Cons: Introduces an IPC hop (supervisor → worker) and a worker-lifecycle plane
     (spawn / crash-restart / drain / re-adopt) that did not exist before — genuinely
     more moving parts than A1. A per-request reverse-proxy adds latency over an
     in-process call and a cold-start cost on a tenant's first request. The supervisor
     becomes a routing chokepoint whose correctness (never route to a non-owning
     worker) is security-load-bearing.

A3 is the only option that satisfies all three primary forces at once: hard
isolation (process boundary, vs. A1's shared heap), runtime onboarding with no
redeploy (registry+spawn, vs. A2's orchestration PR), and maximal reuse of the
shipped control plane (HTTP-over-UDS keeps the worker body intact, FR-035). A1 and
A2 each sacrifice one non-negotiable. The decision is therefore effectively forced
by the requirement set, and the design work was in *how* to assemble the hybrid,
which the sibling ADRs cover.

## Decision

**The multi-tenant single-host runtime is a single pod running one SUPERVISOR
process that fronts a single HTTP listener, resolves caller identity → `Tenant` at
the boundary, and reverse-proxies each request to a per-tenant WORKER process over
that tenant's Unix-domain socket carrying HTTP — one worker per tenant, the
supervisor holding zero tenant secrets.** This is the "A3 hybrid":
process-per-tenant isolation + HTTP-over-UDS transport reusing the existing HTTP
contract.

Concretely, the shape as shipped (Waves 1–5):

- **Supervisor (`packages/host/src/supervisor/supervisor.ts`,
  `createSupervisor`).** A single `Bun.serve` (FR-001) whose `fetch` handler is a
  thin, fail-closed pipeline per request:
  1. dispatch `/admin/tenants(/:id)` to the admin lifecycle handler before any
     tenant logic, so an admin request is never resolved as a tenant or proxied;
  2. `authenticateIdentity` resolves the inbound bearer to an `AuthIdentity`
     (admin / realm-JWT user / `fug_` team), reusing the exact primitives the Hono
     `auth.ts` middleware uses, in the same fail-closed order;
  3. `resolveTenant(identity, registryView)` resolves the `Tenant` at the boundary
     (FR-002/US3); an identity that maps to no registered tenant fails closed and
     non-leaking as `tenant-unknown` (404);
  4. `admission.admit(tenant)` gates a NEW run via the registry's
     `resolveForNewRun` (fails closed while Redis is degraded — FR-022) plus the
     per-tenant concurrency ceiling, acquiring a slot released in a `finally`;
  5. `lifecycle.ensureWorker(tenant.id)` (the T8 `WorkerLifecyclePort` seam) yields
     the owning worker's UDS path or fails closed to `worker-unavailable` (503);
  6. `routeRequest` (pure) folds the admission decision + worker presence into a
     route or a refusal; and
  7. `proxyToWorker` reverse-proxies over the UDS.

  The supervisor does **no DAG execution** and holds **no tenant secret**:
  `SupervisorDeps` has no secret-bearing field, enforced at the single greppable
  seam `assertNoTenantSecrets` (FR-005).

- **Worker (`packages/host/src/worker-main.ts` + `packages/host/src/host.ts`).** A
  worker is `createHost` bound to **exactly one** tenant (FR-007), serving its own
  `Bun.serve` on a per-tenant UDS at `WORKER_UDS_DIR/<tenant>.sock` (0600). The
  pure `buildWorkerBootstrap` planner turns the worker's env (`TENANT_ID`,
  `FUGUE_SECRETS_REF`) into a validated `WorkerBootstrap`, resolving the tenant's
  secrets **inside the worker** via the env-file `SecretsSource` — the sole site
  carrying dereference authority (FR-006/FR-031). The worker is **not** a public
  listener; the single public listener is the supervisor's (FR-001).

- **Transport (`packages/host/src/supervisor/uds-proxy.ts`, `proxyToWorker`).** The
  supervisor forwards the inbound `Request` over the owning worker's UDS verbatim
  (status/headers/body preserved — the existing HTTP 200 contract), stripping any
  client-supplied `X-Fugue-Tenant` and stamping the supervisor's own signed value
  (`signTenantHeader`, the canonical contract in
  `packages/host/src/domain/tenant-header.ts` that the worker's `verifyTenantHeader`
  also imports). The `Authorization` header is forwarded unchanged so the worker
  re-runs its own auth.

- **Binary (`packages/host/src/main-supervisor.ts`).** Composes the real wiring:
  config, Redis, the Redis-backed tenant registry (config + secrets *references*
  only), the per-tenant admission gate, the worker-lifecycle manager, the admin
  lifecycle API, the audit sink, and the grace-window purge — then `createSupervisor`.

Key invariants:

- **Single inbound listener** lives in the supervisor; workers listen only on their
  own UDS (FR-001).
- **One worker = one tenant** — one config, one secrets set, one fs mount, one heap
  (FR-007); the OS process boundary is the isolation mechanism (US2).
- **Supervisor holds zero tenant secrets** — it deals only in auth, routing, and
  registry *metadata* (references), structurally (FR-005, via `assertNoTenantSecrets`).
- **Route only to the owning worker** — the routing core targets only the resolved
  tenant's own socket, defensively re-pinned against the tenant's expected socket
  before proxying (FR-004); a mismatch fails closed.
- **Reuse, don't replace** — the worker body is `createHost` unchanged; HTTP-over-UDS
  preserves the request/response contract so no worker-side handler is rewritten
  (FR-035). `createHost` remains a supported direct single-tenant entrypoint.

## Consequences

**Positive:**

- Hard cross-tenant isolation is structural, not disciplinary: a compromised worker
  shares no heap, no env, and no secrets with any other tenant, so an adversarial
  cross-tenant in-memory read returns zero bytes (US2/SC-001).
- A tenant reusing already-provisioned capabilities is onboarded fully at runtime —
  registry write + lazy spawn — with no IaC PR and no host redeploy (US1/FR-036).
- The shipped control plane is reused wholesale (FR-035): identity→team auth,
  `canAccessDag`, the token store, the capability broker, cache keys, and HITL all
  live inside the worker's `createHost` body unchanged, because HTTP-over-UDS keeps
  the worker speaking the same HTTP contract it always did.
- The supervisor is small and auditable — routing + registry + admission, no
  execution, no secrets — which both shrinks its attack surface and makes the
  "zero tenant secrets in the supervisor" guarantee (SC-002) inspectable.
- Fail-closed and non-leaking by construction at every boundary: unknown identity
  → 401, unresolved tenant → 404 (naming no tenant), degraded registry → refuse new
  runs while in-flight work continues, worker down → 503 for that tenant only — so
  one tenant's failure never surfaces as another's.

**Negative:**

- Real added complexity: an IPC hop and a worker-lifecycle plane (spawn /
  crash-restart / drain / re-adopt) that did not exist in the single-tenant host.
  The reliability of the system now depends on that plane (covered by ADR-0065,
  ADR-0067).
- Per-request reverse-proxy latency over the UDS, plus a cold-start cost on a
  tenant's first request (the lazy-spawn path) — acceptable for the workload but a
  measurable tax versus an in-process call.
- The supervisor is a routing chokepoint whose "never route to a non-owning worker"
  correctness is security-load-bearing; the defensive socket re-pin mitigates a
  lifecycle bug but the invariant must be preserved by every future edit to the
  request pipeline.
- The single-pod model caps blast radius at the pod, not the kernel: process
  isolation plus per-tenant Redis ACL (ADR-0067) is the isolation boundary, which is
  weaker than A2's per-pod kernel/cgroup isolation — a deliberate trade accepted to
  keep runtime onboarding (FR-036) and the 10–20-tenants-per-box target (NFR-001).

## Related

- ADR-0065 — process topology: thin-init (PID 1) parenting, supervisor restart, and
  Redis-backed re-adoption of still-live workers (elaborates the lifecycle/topology
  half of this decision).
- ADR-0066 — IPC: the Unix-domain-socket-carrying-HTTP transport and the signed
  `X-Fugue-Tenant` header contract (elaborates the transport half).
- ADR-0067 — isolation: per-tenant Redis ACL users, tenant-prefixed keyspaces, and
  the per-tenant secrets channel (elaborates the isolation mechanism this shape
  relies on).
- ADR-0058 — two-path inbound host auth: the identity resolution this supervisor
  reuses to turn a bearer into an `AuthIdentity` before tenant resolution.
- ADR-0035 — Hono/HTTP request contract: the existing HTTP 200 contract that
  HTTP-over-UDS preserves so the worker body is reused unchanged.
- ADR-0040 — single-instance state machine: the `host-state.ts` degraded machine +
  Redis probe the supervisor reuses for fail-closed behaviour rather than reinventing.
- `packages/host/src/supervisor/supervisor.ts` — `createSupervisor`: single
  `Bun.serve`, identity→`Tenant` resolve, admit, route (this decision in code).
- `packages/host/src/supervisor/uds-proxy.ts` — `proxyToWorker`: HTTP-over-UDS
  reverse proxy with the signed tenant header.
- `packages/host/src/worker-main.ts` + `packages/host/src/host.ts` — the worker:
  `createHost` bound to one tenant on its UDS.
- `packages/host/src/main-supervisor.ts` — the supervisor binary wiring.
