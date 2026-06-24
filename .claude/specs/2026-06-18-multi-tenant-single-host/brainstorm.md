# Brainstorm — True Single-Host Multi-Tenancy for the Fugue Host

## Building

A single fugue host process that safely serves **many tenants at once** with **hard
(adversary-grade) isolation** between them, and lets a new tenant come online **at
runtime** — mint token, register, push DAGs — with **no IaC PR and no host redeploy**,
whenever that tenant only reuses already-provisioned capabilities.

Today `host = team = trust boundary`: one tenant per process by design, and standing
up a per-team host takes days-to-weeks because it rides slow IaC-repo PRs. That ops
pain is the driver. We are converting the host from "one trust boundary per process"
into "one trust boundary per *tenant*, many tenants per box, isolated by the OS."

## Approach — Process-per-Tenant Supervisor

The host becomes a **supervisor process** and a fleet of **per-tenant worker
processes**. (Decided over the staged/soft single-process options — this is the
adversary-proof target.)

- **Supervisor** owns the single HTTP listener, inbound identity→tenant auth, the
  runtime tenant registry, per-tenant resource admission, and tenant→worker routing
  and lifecycle. It holds **no tenant secrets or data**.
- **Worker** runs exactly **one tenant's** DAGs. Each worker has its own process env,
  secrets, filesystem mount, JS heap, and (ideally) cgroup limits. A compromised npm
  dependency, hostile DAG code, or prompt-injection-driven RCE inside one tenant's
  worker **cannot** read another tenant's in-memory secrets or data — the OS process
  boundary enforces it.

The process boundary closes 5 of the 7 host-global singletons **for free** via the OS:
LLM client+key, `DOCUMENTS_FS_ROOT`, the Keycloak agent-client credentials map, shared
process env, and the single Bun heap all become per-worker by construction. What
remains as genuine design work is the supervisor, the registry, admission, IPC, and the
config-as-code seam for *new* downstream capabilities (gap 4).

`Tenant` becomes a **first-class branded security principal**, resolved at the
supervisor's request boundary and used to route to the owning worker.

### Reusable as-is (control plane is already tenant-aware)
- identity→team auth — `packages/host/src/domain/auth.ts`
- `canAccessDag` pure authz, run before concurrency acquire
- per-team token store (`fugue:tokens:*` / `fugue:teams:*`)
- per-invocation Keycloak capability broker keyed on `agentClientId`
- dagId-prefixed cache/checkpoint keys — `packages/host/src/domain/cache-keys.ts`
- multi-team HITL (`HITL_APPROVER_TEAMS` / `HITL_TEAM_CHANNELS`)

### The 7 host-global singletons (the gap being closed)
1. LLM client + key — `SharedInfra.llm` (`packages/host/src/ports.ts:146`;
   `packages/host/src/domain/config.ts:72-85`) — *solved by process boundary*
2. `DOCUMENTS_FS_ROOT` — `packages/host/src/domain/config.ts:417` — *solved by process boundary*
3. `KEYCLOAK_AGENT_CLIENT_CREDENTIALS` map — `packages/host/src/domain/config.ts:242` — *solved by process boundary*
4. One `fugue-agents` Entra app: permission union + 20-FIC/app cap — **config-as-code seam (stays PR-provisioned)**
5. `MAX_GLOBAL_CONCURRENCY` — `packages/host/src/domain/config.ts:63` (no per-tenant quota) — **becomes supervisor-level per-tenant admission**
6. shared process env vars — *solved by process boundary*
7. one Bun heap (execution/memory isolation) — *solved by process boundary*

## Key Constraints

- **Hard isolation is non-negotiable.** A worker only ever holds ONE tenant's
  config/secrets/data. No shared in-process tenant state.
- **Runtime onboarding for already-provisioned capabilities.** Token mint + tenant
  registration + DAG push must work with no IaC PR and no redeploy.
- **New downstream capability ⇒ additive config-as-code, never a redeploy.** A new
  Keycloak agent client or new Entra application permission / FIC may require a PR to
  the Keycloak/Entra repos, but provisioning must be **additive to the running host**.
- **Single host.** No cross-node clustering; one box, one supervisor.
- **No starvation.** One tenant must not be able to exhaust the box's concurrency or
  resources.
- Reuse the existing tenant-aware control plane rather than re-architecting it.

## In Scope

- **Supervisor process**: single HTTP listener, inbound auth, `Tenant` resolution at
  the request boundary, tenant→worker routing.
- **Worker lifecycle**: spawn, crash-restart, idle-eviction (policy is an open
  question), graceful drain/shutdown.
- **Runtime tenant registry**: per-tenant config (secrets source, fs root, Keycloak
  client mapping), updatable at runtime via an admin API (likely Redis-backed).
- **Per-tenant resource admission** at the supervisor (per-tenant concurrency/quota
  replacing the single global `MAX_GLOBAL_CONCURRENCY`).
- **Supervisor⇆worker IPC** (mechanism is an open question).
- **`Tenant`** as a branded security principal threaded through routing and authz.
- **Config-as-code seam for gap 4**: defined, additive, no-redeploy path for
  registering a *new* Keycloak agent client / Entra permission for a tenant that needs
  a genuinely new downstream capability.
- (Maybe) **per-tenant cost attribution / metering** — observability only.

## Out of Scope (YAGNI)

- Dynamic Keycloak/Entra **provisioning APIs** (runtime creation of new clients/apps).
  New capabilities stay PR-provisioned (additive).
- Cross-host / multi-node supervisor **clustering**.
- A full per-tenant **billing** system (attribution/metering may be in; billing is not).
- Re-architecting the already-tenant-aware control plane.

## Open Questions (for specify / architecture)

1. **Worker lifecycle policy** — lazy spawn-on-first-request + idle-evict, eager
   spawn-all-registered, or a hybrid with a warm pool? Affects cold-start latency vs
   idle resource cost.
2. **Per-tenant secrets source** — Vault path per tenant, Redis-encrypted blob, or
   per-tenant env file injected at worker spawn? Drives the worker bootstrap contract.
3. **Supervisor⇆worker IPC mechanism** — Unix domain socket, stdio/JSON-RPC, shared
   Redis queue, or a localhost HTTP hop? Drives latency, backpressure, and the routing
   contract.
4. **Tenant registry storage & invalidation** — Redis-backed config + how live
   registry mutations (register/deregister/reconfigure) reach the supervisor and
   running workers.
5. **Resource enforcement depth** — process-level concurrency admission only, or also
   cgroup CPU/memory limits per worker (and on what host platform)?
6. **Crash/restart semantics** — in-flight run handling on worker crash; checkpoint
   replay vs fail-fast for a tenant whose worker died mid-DAG.
