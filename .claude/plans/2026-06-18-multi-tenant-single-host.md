# Plan: True Single-Host Multi-Tenancy for the Fugue Host (Process-per-Tenant Supervisor)

**Spec:** `.claude/specs/2026-06-18-multi-tenant-single-host/spec.md`
**Created:** 2026-06-18

## Summary

Convert the fugue host from "one process = one tenant" into a **supervisor process** that owns the single `Bun.serve` listener, authenticates inbound identity to a first-class `Tenant` principal, resolves a runtime tenant registry, and routes each request over a per-tenant Unix domain socket to a **worker** — today's `createHost` bound to exactly one tenant. The OS process boundary is the isolation mechanism: the supervisor holds zero tenant secrets (each worker reads its own from a non-dereferenceable secrets reference at spawn), and per-tenant Redis ACL users make a compromised worker physically unable to read another tenant's keys. This is the **A3 hybrid** approach: the supervisor is an *additive* layer over an essentially-unchanged `createHost`, which remains a supported single-tenant entrypoint.

---

## Architectural Decisions

### AD-1: Overall approach — supervisor + process-per-tenant workers, HTTP-over-UDS (A3 hybrid)

**Choice:** A supervisor process owns the single inbound `Bun.serve` HTTP listener, inbound identity→`Tenant` auth, the tenant registry, per-tenant admission, and tenant→worker routing/lifecycle. Each worker is `createHost` bound to ONE tenant, running its own `Bun.serve` on a per-tenant Unix domain socket. Sync `POST /dags/:id/run` is reverse-proxied over the UDS to the owning worker, preserving the existing HTTP 200 contract with `run-dag.ts` unchanged. `createHost` stays a supported direct single-tenant entrypoint (FR-035 "extend not replace").
**Why:** Maximizes reuse of the already-tenant-aware control plane (auth→team, `canAccessDag`, token store, capability broker, cache keys, HITL) — the worker body is unchanged. HTTP-over-UDS preserves request/response semantics so no worker-side handler is rewritten. The supervisor is thin: routing + registry + admission, no execution, no secrets.
**Rejected:**
- *A1 — in-process tenant multiplexing (per-tenant client resolution inside one host)* — explicitly the anti-goal in `docs/team-security-and-capabilities.md §1`; shared heap means a compromised tenant reads every tenant's in-memory secrets (violates SC-001/FR-009).
- *A2 — full container-per-tenant / k8s-pod-per-tenant orchestration* — re-introduces the IaC-PR + redeploy latency the feature exists to remove (FR-036), and clustering is explicitly out of scope.

### AD-2: Process topology — thin init (PID 1), supervisor re-adopts live workers via Redis registry

**Choice:** A thin init process is PID 1; supervisor and all workers are its children. The supervisor can restart WITHOUT killing workers. On restart it re-adopts still-live workers from a Redis worker-registry (`fugue:supervisor:workers:<tenant>` → `{pid, udsPath, startedAt, health}`) plus a liveness re-probe over each UDS, then resumes routing (FR-019/020, SC-006). In-flight HITL runs survive regardless, being durable in Redis (FR-021).
**Why:** Decouples supervisor maintenance from tenant uptime; workers are not supervisor children in the kill-on-death sense. Redis registry + UDS probe is the source of truth for "who is alive", so re-adoption is a deterministic reconcile, not a guess.
**Rejected:**
- *Supervisor as PID 1 directly parenting workers* — supervisor death (or restart) would orphan/kill workers, breaking FR-019.
- *systemd/k8s as the re-adoption mechanism* — pushes lifecycle out of the process and couples to a specific platform; clustering/orchestration is out of scope.

### AD-3: IPC — Unix domain socket carrying HTTP

**Choice:** Each worker's `createHost` `Bun.serve` binds a per-tenant UDS at `/run/fugue/<tenant>.sock` (perms 0600). The supervisor reverse-proxies inbound HTTP to the owning worker's socket, attaching the resolved `Tenant` principal as a signed header (HMAC over an internal supervisor key; never a tenant secret).
**Why:** Lowest-latency local transport; preserves HTTP semantics so worker handlers are unchanged; fs-permission-scoped (only the supervisor + that worker's uid can open the socket); carries no secret over the wire.
**Rejected:**
- *Localhost TCP* — port management + any local process can connect; weaker isolation than 0600 fs perms.
- *stdio JSON-RPC* — would require re-framing every handler away from HTTP; loses streaming/back-pressure semantics `Bun.serve` already gives.
- *Redis queue for sync runs* — adds a durable hop and latency to a path that must preserve the existing synchronous 200 contract.

### AD-4: Per-tenant Redis isolation — one ACL user per tenant, one Redis server, tenant-prefixed keys

**Choice:** ONE Redis server. Each worker receives a Redis ACL credential scoped to ONLY its tenant's key prefix (`~fugue:<tenant>:*`, `+@all` commands within that keyspace). All key schemes become tenant-prefixed: cache/checkpoint (`cache-keys.ts`), token store (`token-store.ts` `fugue:tokens:*`/`fugue:teams:*`), HITL stores, and the supervisor's own registry/worker keys. The Redis ACL credential is a SECRET and flows only into the owning worker via the secrets channel (AD-6), never the supervisor.
**Why:** Load-bearing for SC-001 — a compromised/RCE'd worker that runs `SCAN fugue:*` or `GET fugue:<other>:...` is *refused by Redis* with a NOPERM error. This closes the #1 adversarial-read gap: today `cache-keys.ts` keys on `fugue:<dagId>:...` and `token-store.ts` on global `fugue:tokens:*` — neither is tenant-scoped, so a shared Redis credential would let any worker read every tenant's keys.
**Rejected:**
- *Separate Redis server/db per tenant* — `SELECT n` (logical DBs) shares one auth and is not an isolation boundary; one server per tenant explodes ops for 10–20 tenants (NFR-001) and breaks the single-pod model.
- *Application-layer prefix enforcement only (no ACL)* — a compromised worker bypasses the application layer entirely; isolation must be enforced *by Redis*, not by the code the attacker controls.

### AD-5: Tenant registry — Redis-backed metadata + pub/sub propagation, fail-closed on outage

**Choice:** `fugue:tenants:<id>` → tenant config metadata (Keycloak client mapping, fs root, **secrets reference only — never the secret**, admission limits, eager-pin flag). Register/deregister/reconfigure publish on a Redis pub/sub channel so the supervisor (and, on next spawn, workers) observe changes. Reconfigure of a running worker takes effect on next spawn; immediate apply = drain + respawn (reuse lifecycle primitives, no live config hot-swap). When the registry/Redis is unavailable, the supervisor **fails closed by reusing the existing `degraded:redis-disconnected` state machine** (`host-state.ts` + `redis-probe.ts`): refuse new runs with 503, live workers keep serving (FR-022/023, SC-007).
**Why:** Redis is already the host's backing store and liveness substrate; reusing `redisDied`/`redisRecovered` + the probe gives fail-closed semantics for free, with no new durability engine. Pub/sub gives live mutation propagation (FR-024) without polling.
**Rejected:**
- *In-memory registry* — lost on supervisor restart, breaks re-adoption (SC-006) and live mutation across a restart.
- *Live config hot-swap into a running worker* — mutating a worker's secrets/config in place reopens the cross-tenant state surface; drain+respawn keeps "one worker = one immutable tenant config" true.

### AD-6: Per-tenant secrets — spawn-time env from a non-dereferenceable reference, behind a `SecretsSource` port

**Choice:** The registry stores only a secrets *reference* (default adapter: a mounted per-tenant env-file path; future: a Vault key) that the supervisor CANNOT dereference (no token, no read perm). At spawn, the WORKER reads the reference and `parseHostConfig`s the actual secrets itself. A `SecretsSource` port (`(SecretsRef) => Result<Record<string,string>, HostError>`) lets a Vault adapter drop in later, mirroring the `AgentClientCredentials` port rationale (AD-1 in the security doc).
**Why:** Realizes FR-005/006 and NFR-011/SC-002 structurally — the supervisor never holds a tenant secret, even transiently, because it only ever handles an opaque reference it lacks the authority to resolve. The worker is the only process with both the reference *and* the authority. This is what the process-inspection tests (SC-002/SC-003) assert against.
**Rejected:**
- *Supervisor reads secrets and injects them into worker env* — makes the supervisor a secrets choke point and high-value target (the exact risk the spec calls out); violates FR-005/SC-002.
- *Encrypted blob in the registry decryptable by the supervisor* — supervisor holds the decryption key = supervisor holds the secret.

### AD-7: Worker lifecycle — lazy spawn-on-first-request + idle-evict, eager-pin option; cold-start SLA bench-then-set

**Choice:** Workers spawn lazily on the tenant's first request and are idle-evicted after a configurable TTL (default ~15 min); a per-tenant eager-pin flag in the registry keeps hot tenants warm. Graceful drain lets in-flight runs complete/checkpoint before shutdown (FR-017), reusing the existing `beginDrain`/`drainComplete` transitions. **The cold-start latency NUMBER is set from a boot benchmark** (policy is locked now; SLA derived from a measured worker boot under the single-pod profile) (FR-018, NFR-003).
**Why:** Lazy+evict fits 10–20 tenants on one box (NFR-001) without standing-pool memory cost; eager-pin covers latency-sensitive tenants. A measured SLA beats a guessed one.
**Rejected:**
- *Always-eager warm pool for all tenants* — wastes memory against the per-worker ceiling (FR-034) at idle; doesn't scale to bursty tenant sets.
- *Always-lazy with no eviction* — leaks workers; eventually breaches the live-worker upper bound (FR-033).

### AD-8: Crash policy — sync runs fail-fast, HITL runs resume from durable checkpoint; crash contained to tenant

**Choice:** On worker crash, inline sync runs fail-fast (client retries) — the supervisor returns `worker-unavailable` (503) for that tenant only. HITL/`humanReview` runs resume from their durable Redis checkpoint on worker restart via the existing `processRun` idempotency + self-healing `SET NX EX` lock. A worker crash never affects another tenant's worker or runs (FR-012/015, SC-005); the supervisor restarts only the crashed tenant's worker (FR-015).
**Why:** Sync runs hold no durable state worth resuming and have a live client to retry; HITL runs are already durable, so reuse that machinery (FR-016) rather than build a new resume engine for sync.
**Rejected:**
- *Best-effort resume of sync runs from a new checkpoint engine* — builds durability the spec explicitly does not require for sync; the deferred item resolves to "fail-fast for sync, reuse durable HITL for the rest".

### AD-9: Resource enforcement — single pod + supervisor admission + per-worker heap cap (not cgroups)

**Choice:** Workers are child processes inside ONE k8s pod (matches `packages/host/Dockerfile`). Per-tenant concurrency admission and a live-worker upper bound are pure supervisor state, modeled by **extending the existing `domain/concurrency.ts` ADT** with a per-tenant axis. Per-tenant memory ceiling (FR-034, hundreds of MB) is enforced via a per-worker Bun/V8 heap flag at spawn; OOM → contained crash + restart (AD-8).
**Why:** Admission + heap cap satisfies anti-starvation (SC-011) and the memory ceiling (NFR-002) without containers-as-workers. cgroup-per-worker would require clustering / container-per-tenant — out of scope.
**Rejected:**
- *Per-worker cgroups* — needs a container/cgroup-delegation layer the single-pod model doesn't have; out of scope.
- *No admission, rely on OS scheduling* — one heavy tenant starves others (violates SC-011).

### AD-10: `Tenant` first-class branded principal + extended error taxonomy

**Choice:** `Tenant` is a hard-branded principal (a `unique symbol` brand like `RunId`/`SubjectToken`), resolved at the supervisor boundary and threaded through routing/authz; it **extends** `domain/auth.ts` (identity→team, `canAccessDag`) rather than replacing it. The supervisor extends `host-error.ts`/`framework-error-http.ts` with `tenant-unknown` (404/401), `tenant-over-quota` (429 + retry-after), and `worker-unavailable` (503). One tenant's failure never surfaces as another's (FR-041, SC-012).
**Why:** Branding makes "this string was resolved to a registered tenant at the boundary" unforgeable and greppable (the established pattern in `auth.ts`). Extending the existing error union keeps the single `httpStatusFor` mapping authoritative and exhaustive.
**Rejected:**
- *`Tenant` as a plain string* — loses the parse-don't-validate guarantee; any string could be passed as a routed principal.
- *Separate supervisor error type disjoint from `HostError`* — splits HTTP status mapping across two exhaustive matches that can drift.

---

## File Structure

All files under `packages/host/`. New supervisor code lives in a new `src/supervisor/` tree; the worker reuses existing `host.ts`/`createHost` with a thin bootstrap.

### Tenant principal + branded types (foundation)

```
src/domain/tenant.ts               — Tenant branded principal, TenantId, markTenant, resolveTenant (pure); secrets-reference type (opaque)
src/domain/tenant.test.ts          — brand forgery-resistance, resolution rules
src/domain/auth.ts                 — MODIFY: thread Tenant alongside AuthIdentity; tenant-aware canAccessDag extension (no replacement)
src/domain/host-error.ts           — MODIFY: add tenant-unknown | tenant-over-quota | worker-unavailable variants + httpStatusFor + formatHostError cases
src/domain/framework-error-http.ts — MODIFY: ensure new variants classify correctly (no breaker trip for over-quota/unknown)
```

### Key-namespacing migration (foundation, isolation-critical)

```
src/domain/cache-keys.ts           — MODIFY: prefix all keys with fugue:<tenant>: (cache + checkpoint); thread TenantId through builders
src/domain/cache-keys.test.ts      — MODIFY: assert tenant-prefixed keys; cross-tenant key strings never collide
src/adapters/token-store.ts        — MODIFY: tenant-prefix fugue:<tenant>:tokens:* / fugue:<tenant>:teams:*
src/adapters/token-store.test.ts   — MODIFY: per-tenant isolation of token/team keys
docs/migrations/tenant-key-namespacing.md — migration note: prefix scheme + one-time backfill/rekey for existing single-tenant deploys
```

### Tenant registry + secrets-source ports

```
src/supervisor/registry/tenant-registry.ts          — pure registry ADT: TenantConfig (secrets REFERENCE only), register/deregister/reconfigure transitions, idempotency
src/supervisor/registry/tenant-registry.test.ts      — idempotency, fail-closed lookups, deregister-then-purge state
src/supervisor/registry/redis-registry-adapter.ts    — Redis-backed read/write of fugue:tenants:<id> + pub/sub publish/subscribe
src/supervisor/registry/redis-registry-adapter.test.ts — over recorded-call Redis fake
src/supervisor/secrets/secrets-source.ts             — SecretsSource port: (SecretsRef) => Result<Record<string,string>, HostError>
src/supervisor/secrets/env-file-secrets-source.ts    — default adapter: read per-tenant env file at the referenced path
src/supervisor/secrets/env-file-secrets-source.test.ts
```

### Supervisor core (routing, admission, lifecycle)

```
src/supervisor/supervisor.ts                — createSupervisor: owns Bun.serve, identity→Tenant resolution, routing; reuses host-state.ts degraded machine
src/supervisor/supervisor.test.ts
src/supervisor/admission.ts                 — per-tenant admission + live-worker upper bound (EXTENDS domain/concurrency.ts ADT)
src/supervisor/admission.test.ts            — per-tenant ceilings, global worker bound, anti-starvation fairness (pure)
src/supervisor/routing.ts                   — pure: Tenant → worker route resolution; unknown → tenant-unknown
src/supervisor/routing.test.ts
src/supervisor/uds-proxy.ts                 — reverse-proxy adapter: forward HTTP over UDS, attach signed Tenant header (imperative shell, port-backed)
src/supervisor/uds-proxy.test.ts            — over recorded-call transport fake
src/main-supervisor.ts                      — binary entrypoint for the supervisor (parallel to existing main.ts worker entrypoint)
```

### Worker lifecycle + process management

```
src/supervisor/lifecycle/worker-lifecycle.ts        — pure lifecycle ADT: lazy-spawn / idle-evict / drain / crash-restart transitions
src/supervisor/lifecycle/worker-lifecycle.test.ts
src/supervisor/lifecycle/spawn-port.ts              — SpawnPort: spawn a worker process bound to a tenant UDS + heap cap; ProcManagePort: kill/health-probe
src/supervisor/lifecycle/bun-spawn-adapter.ts       — Bun.spawn adapter implementing SpawnPort/ProcManagePort + per-worker heap flag
src/supervisor/lifecycle/worker-registry-redis.ts   — fugue:supervisor:workers:<tenant> {pid,udsPath,startedAt,health}; re-adoption reconcile
src/supervisor/lifecycle/worker-registry-redis.test.ts
src/supervisor/lifecycle/thin-init.ts               — PID 1 thin init: parents supervisor + workers; does not kill workers on supervisor restart
```

### Worker bootstrap (binds createHost to one tenant over a UDS)

```
src/worker-main.ts                  — worker entrypoint: read SecretsSource ref from env, parseHostConfig, createHost bound to UDS for ONE tenant
src/host.ts                         — MODIFY: allow Bun.serve to bind a unix socket (unix path) instead of TCP port; thread TenantId into key builders + Redis ACL credential
src/domain/config.ts                — MODIFY: add WORKER_UDS_PATH, TENANT_ID, REDIS_ACL_* (worker side); supervisor config (SUPERVISOR_* , idle TTL, worker bound) via superRefine
src/domain/config.test.ts           — MODIFY
```

### Redis ACL provisioning

```
src/supervisor/secrets/redis-acl.ts             — pure: build ACL SETUSER spec for fugue:<tenant>:* scoped user; credential is a secret (flows only to worker)
src/supervisor/secrets/redis-acl.test.ts        — ACL spec scoping; cross-tenant pattern rejected
src/supervisor/secrets/redis-acl-provisioner.ts — adapter: apply/revoke ACL user against Redis (admin connection, supervisor-side provisioning only — credential handed off via SecretsSource, never held)
```

### Admin lifecycle API + audit port

```
src/http/handlers/admin/tenants.ts          — register/deregister/reconfigure handlers (admin-token only, idempotent); mounts on supervisor router
src/http/handlers/admin/tenants.test.ts      — admin-only authz, idempotency, audit emission, deregister revoke + grace-window retain
src/supervisor/audit/audit-port.ts           — AuditPort: record(actor,timestamp,tenant,action); pure record type
src/supervisor/audit/audit-sink-log-redis.ts — adapter: structured-log sink + Redis stream sink
src/supervisor/audit/audit-sink.test.ts
src/supervisor/lifecycle/grace-window-purge.ts — deregister grace-window retention + auto-purge (default 7d) of tenant footprint
src/supervisor/lifecycle/grace-window-purge.test.ts
```

### Adversarial / fault-injection integration tests

```
src/__tests__/integration/isolation-cross-tenant-read.test.ts   — SC-001: adversarial worker reads zero bytes of another tenant (Redis NOPERM, fs, mem)
src/__tests__/integration/isolation-supervisor-secrets.test.ts  — SC-002/SC-003: supervisor holds zero secrets; each worker holds exactly one tenant's
src/__tests__/integration/fault-worker-crash.test.ts            — SC-005: crash one worker under concurrent multi-tenant load, zero collateral
src/__tests__/integration/supervisor-restart-readopt.test.ts    — SC-006: restart supervisor with N live workers; 100% re-adopt + in-flight survive
src/__tests__/integration/fail-closed-registry-down.test.ts     — SC-007: registry/Redis down → 503 new runs, live workers keep serving
src/__tests__/integration/error-taxonomy-concurrent.test.ts     — SC-012: 429/503/404 per-tenant, no cross-tenant error bleed
```

---

## Component Design

### Tenant principal (`domain/tenant.ts`)

**Responsibility:** Define the branded `Tenant` security principal and the pure resolution from an `AuthIdentity` to a registered tenant.
**Files:** `src/domain/tenant.ts`, extends `src/domain/auth.ts`
**Interface:**
```
type TenantId = string & { readonly [__tenantIdBrand]: unique symbol }
type Tenant = { readonly id: TenantId; readonly team: string } & { readonly [__tenantBrand]: void }
type SecretsRef = string & { readonly [__secretsRefBrand]: void }   // opaque; supervisor cannot dereference
resolveTenant: (identity: AuthIdentity, registry: TenantRegistryView) => Result<Tenant, HostError /* tenant-unknown */>
```
**Depends on:** `auth.ts`, `host-error.ts`

### Key namespacing (`domain/cache-keys.ts`, `adapters/token-store.ts`)

**Responsibility:** Tenant-prefix every Redis key so a per-tenant ACL user can scope `~fugue:<tenant>:*`.
**Interface:**
```
cacheKeyPrefix:  (tenant: TenantId, dagId: DagId) => `fugue:${tenant}:${dagId}:cache:`
checkpointKeyPrefix: (tenant: TenantId, dagId, runId) => `fugue:${tenant}:${dagId}:${runId}:`
token-store: tokenKey/teamKey → `fugue:${tenant}:tokens:<hash>` / `fugue:${tenant}:teams:<team>`
```
**Depends on:** `tenant.ts`. **Note:** load-bearing for AD-4 — the ACL pattern is only sound if NO key escapes the tenant prefix.

### Tenant registry (`supervisor/registry/*`)

**Responsibility:** Hold per-tenant config (secrets REFERENCE only, never the secret) with idempotent register/deregister/reconfigure and live pub/sub propagation; fail-closed on Redis outage.
**Interface:**
```
type TenantConfig = { id, team, keycloakClientMapping, fsRoot, secretsRef: SecretsRef, admission: TenantLimits, eagerPin: boolean, deregisteredAt?: number }
register/deregister/reconfigure: (registry, TenantConfig|TenantId, now) => Result<TenantRegistry, HostError>   // pure, idempotent
RedisTenantRegistry: read/write fugue:tenants:<id>, publish/subscribe fugue:tenants:events
```
**Depends on:** `tenant.ts`, `host-state.ts` (reuses `redisDied`/`redisRecovered` for fail-closed). Reconfigure of a running worker = drain + respawn; no live hot-swap.

### Secrets source (`supervisor/secrets/secrets-source.ts` + env-file adapter)

**Responsibility:** Resolve a `SecretsRef` to actual secrets — invoked ONLY in the worker, never the supervisor.
**Interface:** `SecretsSource = (ref: SecretsRef) => Result<Record<string,string>, HostError>`. Default adapter reads a per-tenant env file.
**Depends on:** `tenant.ts`. **Security:** the supervisor lacks the authority (token/read perm) to call this against any tenant's ref — structural enforcement of FR-005/006, SC-002.

### Supervisor (`supervisor/supervisor.ts`)

**Responsibility:** Own the single inbound `Bun.serve`; authenticate identity→`Tenant`; admit; route to the owning worker over UDS; fail closed when the registry is unavailable.
**Interface:** `createSupervisor(deps) => Result<SupervisorInstance, HostError>` (mirrors `createHost`). Reuses `host-state.ts` for the `degraded:redis-disconnected` machine and `redis-probe.ts` for liveness.
**Depends on:** registry, admission, routing, uds-proxy, worker-lifecycle, audit, auth/tenant.

### Admission (`supervisor/admission.ts`)

**Responsibility:** Per-tenant concurrency admission + global live-worker upper bound, as a pure extension of `ConcurrencyState`.
**Interface:**
```
type TenantConcurrencyState = ConcurrencyState & { perTenant: ReadonlyMap<TenantId, {current,max}>; liveWorkers: {current,max} }
admitTenant: (state, TenantId, now) => Result<{state, token}, HostError /* tenant-over-quota | worker-unavailable */>
```
**Depends on:** `domain/concurrency.ts` (extend, don't fork).

### UDS proxy (`supervisor/uds-proxy.ts`)

**Responsibility:** Reverse-proxy an inbound HTTP request to the owning worker's `/run/fugue/<tenant>.sock`, attaching a signed `X-Fugue-Tenant` header (HMAC over a supervisor-internal key; carries no tenant secret). Preserves the synchronous 200 contract.
**Interface:** `proxyToWorker: (route: WorkerRoute, req: Request) => Promise<Response>` behind a `UdsTransportPort`.
**Depends on:** routing, worker-lifecycle.

### Worker lifecycle + spawn (`supervisor/lifecycle/*`)

**Responsibility:** Pure lifecycle ADT (lazy-spawn / idle-evict / drain / crash-restart) + spawn/proc-management ports + Redis worker-registry for re-adoption.
**Interface:**
```
WorkerState = spawning | live{pid,udsPath} | draining | crashed | evicted   (pure transitions)
SpawnPort.spawn: (TenantId, SecretsRef, udsPath, heapCapMb) => Result<{pid}, HostError>
ProcManagePort: kill(pid); probe(udsPath) => alive|dead
WorkerRegistry: persist/read fugue:supervisor:workers:<tenant>; reconcileReadopt(liveProbe) => routes   // SC-006
```
**Depends on:** registry, secrets-source (passes the REF, not secrets), tenant.

### Worker bootstrap (`worker-main.ts`)

**Responsibility:** A worker entrypoint that reads its tenant's `SecretsRef` from spawn env, resolves secrets via `SecretsSource`, `parseHostConfig`s them, and calls `createHost` bound to ONE tenant on its UDS.
**Interface:** reuses `createHost(HostDeps)`; `host.ts` modified so `Bun.serve` binds `{ unix: udsPath }` instead of `{ port }`, and the Redis ACL credential + `TenantId` thread into the key builders.
**Depends on:** `host.ts`, `config.ts`, `secrets-source.ts`.

### Audit (`supervisor/audit/*`)

**Responsibility:** Emit an audit record (actor, timestamp, tenant, action) for every tenant lifecycle op (FR-028, SC-008).
**Interface:** `AuditPort.record: (rec: AuditRecord) => Promise<void>`; sinks = structured log + Redis stream.
**Depends on:** none (pure record type + adapter).

### Redis ACL provisioning (`supervisor/secrets/redis-acl*.ts`)

**Responsibility:** Build + apply the per-tenant Redis ACL user scoped to `~fugue:<tenant>:*`; the generated credential is a secret handed to the worker via `SecretsSource`, never retained by the supervisor.
**Interface:** `buildAclSpec: (TenantId) => AclUserSpec` (pure); `RedisAclProvisioner.apply/revoke` (adapter, admin connection).
**Depends on:** `tenant.ts`. **Security:** load-bearing for SC-001.

### Admin tenant lifecycle API (`http/handlers/admin/tenants.ts`)

**Responsibility:** Register/deregister/reconfigure endpoints — admin-token only, idempotent, audited; deregister = immediate revoke (kill worker + invalidate token) + grace-window retain.
**Depends on:** registry, audit, worker-lifecycle, grace-window-purge, existing admin auth.

---

## Data Flow

```
inbound request → supervisor Bun.serve → auth (identity) → resolveTenant(identity, registry)
  → admitTenant(per-tenant + worker-bound) → worker-lifecycle (lazy spawn if absent)
  → uds-proxy (signed Tenant header) → worker createHost over UDS → run-dag.ts (unchanged)
  → worker reads/writes Redis under ~fugue:<tenant>:* via its scoped ACL user
```

```
admin register → admin/tenants handler → registry.register (idempotent) → Redis fugue:tenants:<id> + pub/sub
  → audit.record(actor,ts,tenant,register) → (lazy) worker spawned on first request with its SecretsRef
```

Key transformations: identity→`Tenant` is the parse-don't-validate boundary; the supervisor only ever forwards a *reference* + signed principal, never a secret. Worker resolves its own secrets at spawn.

---

## Implementation Phases

Dependency-ordered waves. Foundational seams (Tenant principal, key-namespacing, registry+secrets ports) precede supervisor/proxy/worker wiring, which precedes admission/audit/lifecycle, which precedes adversarial-isolation hardening.

### Phase 1: Foundations — principal, types, key namespacing (no dependencies)

- **T1 — Tenant principal + error taxonomy.** `domain/tenant.ts` (branded `Tenant`/`TenantId`/`SecretsRef`, `resolveTenant`); extend `host-error.ts` (`tenant-unknown`/`tenant-over-quota`/`worker-unavailable` + `httpStatusFor`/`formatHostError`) and `framework-error-http.ts`; extend `auth.ts` to thread `Tenant`. *(FR-002, FR-003, FR-040, FR-041, SC-012; US3)*
- **T2 — Key-namespacing migration.** Tenant-prefix `cache-keys.ts` and `token-store.ts`; thread `TenantId` through builders; migration note. *(FR-013, isolation prerequisite for AD-4; US2)*
- **Files:** `domain/tenant.ts`, `domain/host-error.ts`, `domain/framework-error-http.ts`, `domain/auth.ts`, `domain/cache-keys.ts`, `adapters/token-store.ts`, `docs/migrations/tenant-key-namespacing.md` (+ tests)

### Phase 2: Registry, secrets, Redis ACL (depends on Phase 1)

- **T3 — Tenant registry (pure + Redis adapter + pub/sub).** `supervisor/registry/*`; idempotent register/deregister/reconfigure; fail-closed via reused `redisDied`/`redisRecovered`. *(FR-024, FR-022, FR-023, FR-027; US5, US7)*
- **T4 — Secrets source port + env-file adapter.** `supervisor/secrets/secrets-source.ts` + `env-file-secrets-source.ts`. *(FR-005, FR-006, FR-031; US2)*
- **T5 — Redis ACL provisioning.** `supervisor/secrets/redis-acl.ts` + provisioner; per-tenant `~fugue:<tenant>:*` scoped user. *(FR-009, FR-010; SC-001; US2)*
- **Files:** `supervisor/registry/**`, `supervisor/secrets/**` (+ tests)

### Phase 3: Supervisor, worker bootstrap, UDS proxy, lifecycle (depends on Phase 2)

- **T6 — Worker bootstrap + host UDS bind.** `worker-main.ts`; modify `host.ts` to bind `Bun.serve` on a unix socket and thread `TenantId` + ACL credential into keys; `config.ts` worker/supervisor schema. *(FR-007, FR-001, FR-035; US3, US4)*
- **T7 — Supervisor core: routing + UDS proxy.** `supervisor/supervisor.ts`, `routing.ts`, `uds-proxy.ts`, `main-supervisor.ts`; single listener, identity→Tenant→worker, signed Tenant header. *(FR-001, FR-004, FR-008; US3)*
- **T8 — Worker lifecycle + thin-init re-adoption.** `supervisor/lifecycle/**` (lifecycle ADT, spawn/proc ports, Bun.spawn adapter w/ heap cap, worker-registry-redis re-adopt, thin-init). *(FR-014, FR-015, FR-016, FR-017, FR-019, FR-020, FR-021, NFR-003; US4, US7)*
- **Files:** `worker-main.ts`, `host.ts`, `config.ts`, `supervisor/supervisor.ts`, `supervisor/routing.ts`, `supervisor/uds-proxy.ts`, `main-supervisor.ts`, `supervisor/lifecycle/**` (+ tests)

### Phase 4: Admission, admin lifecycle API, audit, grace-window (depends on Phase 3)

- **T9 — Admission + worker-bound (extend concurrency ADT).** `supervisor/admission.ts`; per-tenant ceiling + live-worker upper bound + retry-after. *(FR-032, FR-033, FR-034, FR-038, FR-039; SC-011; US8)*
- **T10 — Admin tenant lifecycle API + audit + grace-window purge.** `http/handlers/admin/tenants.ts`, `supervisor/audit/**`, `supervisor/lifecycle/grace-window-purge.ts`; admin-only, idempotent, audited, deregister-revoke + 7d retain/purge. *(FR-025, FR-026, FR-028, FR-029, FR-030; SC-008, SC-009, SC-010; US5, US6)*
- **Files:** `supervisor/admission.ts`, `http/handlers/admin/tenants.ts`, `supervisor/audit/**`, `supervisor/lifecycle/grace-window-purge.ts` (+ tests)

### Phase 5: Adversarial isolation + fault-injection hardening (depends on Phase 1–4)

- **T11 — Isolation + secrets-absence integration tests.** Cross-tenant read (Redis NOPERM/fs/mem) zero-bytes; supervisor-secrets-absence; one-tenant-per-worker assertion. *(SC-001, SC-002, SC-003; NFR-010, NFR-011; US2)*
- **T12 — Fault-injection + fail-closed + error-taxonomy tests.** Worker-crash containment under concurrent load; supervisor-restart re-adoption + in-flight survival; registry-down fail-closed; per-tenant error taxonomy. *(SC-005, SC-006, SC-007, SC-012; NFR-020, NFR-021, NFR-022; US4, US7)*
- **Files:** `src/__tests__/integration/**`

---

## Testing Strategy

| Component | Unit Tests (pure) | Integration Tests (I/O) | Property Tests |
|-----------|-------------------|-------------------------|----------------|
| `tenant.ts` | brand resolution rules; unknown→`tenant-unknown`; forgery-resistance | — | resolved Tenant always maps to a registered id |
| key namespacing | every key carries `fugue:<tenant>:` prefix | — | no two distinct tenants produce a colliding key string |
| `tenant-registry` | idempotent register/deregister; reconfigure; deregister state | Redis adapter over recorded-call fake; pub/sub publish | repeating an op ⇒ identical end state (SC-009) |
| `secrets-source` | env-file parse → secrets map | adapter reads referenced file; supervisor cannot dereference | — |
| `redis-acl` | ACL spec scopes only `~fugue:<tenant>:*`; cross-tenant pattern rejected | provisioner apply/revoke over fake | — |
| `admission` | per-tenant ceiling → 429+retry-after; worker bound enforced | — | heavy tenant never reduces another's admission (SC-011) |
| `routing` | Tenant→worker route; unknown→`tenant-unknown` | — | — |
| `uds-proxy` | signed Tenant header built; no secret in header | proxy over recorded-call transport fake; 200 contract preserved | — |
| `worker-lifecycle` | lazy/evict/drain/crash transitions | spawn adapter spawns w/ heap cap; re-adopt reconcile (SC-006) | — |
| admin `tenants` handler | admin-only authz; non-admin refused; idempotent | register→route→run e2e; deregister revoke + retain | — |
| `audit` | record shape (actor/ts/tenant/action) | log + Redis-stream sinks | — |
| **isolation (adversarial)** | — | **SC-001** cross-tenant read = zero bytes (Redis NOPERM, fs, mem) | — |
| **secrets absence** | — | **SC-002/003** supervisor 0 secrets; each worker exactly 1 tenant's | — |
| **fault injection** | — | **SC-005** crash one worker under load, zero collateral | — |
| **supervisor restart** | — | **SC-006** N workers re-adopted, 100% in-flight survive | — |
| **fail-closed** | — | **SC-007** registry down → 503 new runs, live workers serve | — |
| **error taxonomy** | — | **SC-012** 429/503/404 per-tenant, no cross-tenant bleed | — |

---

## Security & NFR Notes

- **Security (trust boundaries):** Three layers of isolation — (1) OS process boundary per worker (in-memory state), (2) Redis ACL user per tenant (cache/checkpoint/token data), (3) non-dereferenceable secrets reference held by the supervisor (secrets at rest never transit the supervisor). The signed Tenant header on the UDS carries a principal, not a secret. Adversarial verification of all three is a first-class success criterion (SC-001/002/003/005) tested by real integration/fault-injection tests, not mocks.
- **Performance:** Lazy-spawn + idle-evict for 10–20 tenants on one box; eager-pin for hot tenants; cold-start SLA set from a boot benchmark. Per-worker heap cap bounds memory (NFR-002). Admission prevents one tenant starving the box (SC-011).
- **Primary optimization axis (locked):** isolation correctness > crash-containment > cold-start latency.
- **FP core / imperative shell:** supervisor routing, registry, admission, lifecycle transitions, and the Tenant/error ADTs are pure and unit-testable with recorded-call fakes (90%+ pure core); spawn, UDS transport, Redis I/O, and proc-management sit behind ports. `Result<T, HostError>` end-to-end, fail-closed.

---

## Verification

1. `bun run typecheck` green across `packages/host` (new supervisor tree + modified worker).
2. `bun test packages/host` — all suites incl. the six adversarial/fault-injection integration tests pass.
3. `.claude/linter` passes (purity boundaries, no bare throw, no `as any`, no raw-string ids — `Tenant`/`TenantId` branded).
4. Single-tenant mode unchanged: boot `createHost` directly (no supervisor) → behavior byte-identical to today (FR-035).
5. Manual: register a tenant via admin API (no redeploy/IaC PR), push DAGs, first invocation succeeds (SC-004); deregister → immediate revoke + footprint retained (SC-010).
6. Manual adversarial: an attacker-controlled DAG in tenant A's worker runs `SCAN fugue:*` / `GET fugue:<B>:...` → Redis NOPERM, zero bytes (SC-001).
