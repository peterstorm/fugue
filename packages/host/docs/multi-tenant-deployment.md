# Fugue Host — Multi-Tenant Single-Host Deployment (OpenShift)

Run **one pod that serves many teams**: a single shared `fugue-host` image whose
PID-1 (`thin-init`) supervises a supervisor process that spawns **one isolated
worker process per tenant**. This is the topology described in ADR-0064; it is a
distinct deployment choice from the **one-host-per-team** model in
[`deployment.md`](./deployment.md) (which is still fully supported — see
[Choosing a topology](#choosing-a-topology)).

> **Tenant = team.** Tenant↔team is enforced 1:1 (a team owns exactly one active
> tenant). A multi-tenant pod therefore serves N teams as N tenants.

---

## Table of Contents

1. [Topology](#topology)
2. [The three images](#the-three-images)
3. [How a worker discovers its DAGs (per-tenant isolation)](#how-a-worker-discovers-its-dags-per-tenant-isolation)
4. [Build the images](#build-the-images)
5. [Platform prerequisites](#platform-prerequisites)
6. [Per-tenant secrets (env-file convention)](#per-tenant-secrets-env-file-convention)
7. [Deploy the pod](#deploy-the-pod)
8. [Provision tenants](#provision-tenants)
9. [Add / remove a team](#add--remove-a-team)
10. [Per-tenant Redis ACL isolation (optional)](#per-tenant-redis-acl-isolation-optional)
11. [Environment reference](#environment-reference)
12. [Choosing a topology](#choosing-a-topology)
13. [Troubleshooting](#troubleshooting)

---

## Topology

```
                    ┌──────────────────────── Pod (single replica) ────────────────────────┐
   inbound HTTP ───▶│  fugue-host container — PID 1 = thin-init                              │
   (Service:3000)   │     └─ supervisor  (owns the ONE TCP listener :3000, /health, auth)   │
                    │          ├─ proxy ─▶ /run/fugue/cx.sock     ─▶ worker[cx]    (team cx) │
                    │          └─ proxy ─▶ /run/fugue/leads.sock  ─▶ worker[leads] (team leads)
                    │                                                                        │
                    │  /dags/cx     ◀── initContainer fugue-dags-cx     (baked, cx only)     │
                    │  /dags/leads  ◀── initContainer fugue-dags-leads  (baked, leads only)  │
                    └────────────────────────────────────────────────────────────────────────┘
```

- **thin-init (PID 1)** spawns + supervises the supervisor, restarting it across
  crashes WITHOUT killing the per-tenant workers (they re-parent to PID 1 and are
  re-adopted from the Redis registry — SC-006).
- **supervisor** owns the single inbound TCP listener, authenticates requests,
  resolves the target tenant, **lazy-spawns** that tenant's worker on first use,
  and reverse-proxies over the tenant's Unix-domain socket.
- **worker** is `createHost` bound to exactly one tenant, serving on
  `/run/fugue/<tenant>.sock` (0600). It resolves ITS tenant's secrets inside its
  own process and discovers ITS team's DAGs only.

---

## The three images

| Image | Built in | Contains | Cardinality |
|-------|----------|----------|-------------|
| `fugue-host` | this repo (`packages/host/Dockerfile`) | the ENGINE — bakes **no** DAGs | ONE, shared by all teams |
| `fugue-dags-<team>` | the `fugue-dags` repo (`Dockerfile`, `--build-arg TEAM=<team>`) | **one team's** baked DAGs + `node_modules` | ONE per team |
| (your apps) | — | call the host over HTTP with their team token | per app |

A multi-tenant deployment composes **one** `fugue-host` + **one
`fugue-dags-<team>` initContainer per tenant** + per-tenant env/secrets.

---

## How a worker discovers its DAGs (per-tenant isolation)

The host discovers DAGs by globbing `dags/**/dag.ts` under a root directory and
reading each DAG's sibling `fugue.yaml`. In the multi-tenant pod, **that root is
per-tenant**:

1. Each `fugue-dags-<team>` initContainer stages its baked bundle into a **distinct
   subdir** of the shared `/dags` volume — e.g. `/dags/cx`, `/dags/leads`.
2. Each tenant is registered with `dagsRoot` = its subdir (`/dags/cx`).
3. On spawn, the supervisor injects that `dagsRoot` into the worker's env as
   **`DAGS_LOCAL_PATH`**. The worker runs the local git adapter (clone/pull/install
   are no-ops) rooted there and globs **only its own team's DAGs**.

This is the **at-rest isolation boundary**. The host's `canAccessDag` is API-layer
only — it does **not** protect code/prompts/data on disk. Giving every worker the
whole multi-team tree would let a compromised worker read another team's DAG code
and prompts (team-security-and-capabilities.md §2). Per-tenant `dagsRoot` closes
that: a worker's filesystem view contains only its team's bundle.

> `dagsRoot` is validated as a **confined absolute path** (leading `/`, no `..`
> traversal, no NUL) at the `POST /admin/tenants` boundary — a registered tenant
> always carries a usable, confined root.

---

## Build the images

**Host (once, shared):**

```bash
# From this monorepo root
podman build -f packages/host/Dockerfile -t quay.example.com/fugue/host:0.2.0 .
podman push quay.example.com/fugue/host:0.2.0
```

**Per-team DAG bundle (one per team, from the `fugue-dags` repo root):**

```bash
podman build -f Dockerfile --build-arg TEAM=cx \
  -t quay.example.com/fugue/fugue-dags-cx:0.2.0 .
podman build -f Dockerfile --build-arg TEAM=leads \
  -t quay.example.com/fugue/fugue-dags-leads:0.2.0 .
podman push quay.example.com/fugue/fugue-dags-cx:0.2.0
podman push quay.example.com/fugue/fugue-dags-leads:0.2.0
```

---

## Platform prerequisites

- Redis reachable from the pod (shared is fine — keys are namespaced; for stronger
  isolation enable per-tenant ACLs, below).
- An admin token (`openssl rand -base64 32`) and a supervisor HMAC key
  (`openssl rand -hex 32`).

```bash
oc create secret generic fugue-mt-platform \
  --from-literal=ADMIN_TOKEN="$(openssl rand -base64 32)" \
  --from-literal=REDIS_URL="redis://:password@platform-redis-master:6379" \
  --from-literal=SUPERVISOR_HMAC_KEY="$(openssl rand -hex 32)"
```

---

## Per-tenant secrets (env-file convention)

A tenant's `secretsRef` is, for the default `SecretsSource` adapter, a **mounted
file path** whose contents are a `KEY=VALUE` env-file. The worker reads
`FUGUE_SECRETS_REF`, parses the file **inside its own process**, and merges the
result over its base env before `parseHostConfig`. The supervisor never reads it.

Create one Secret per tenant, keyed by `<tenant>.env`:

```bash
# cx runs on Anthropic
cat > /tmp/cx.env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-cx-team-key...
EOF
oc create secret generic fugue-tenant-cx --from-file=cx.env=/tmp/cx.env
shred -u /tmp/cx.env

# leads runs on Azure OpenAI
cat > /tmp/leads.env <<'EOF'
AZURE_OPENAI_API_KEY=leads-azure-key
AZURE_OPENAI_ENDPOINT=https://leads.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
EOF
oc create secret generic fugue-tenant-leads --from-file=leads.env=/tmp/leads.env
shred -u /tmp/leads.env
```

The manifest mounts each at `/run/secrets/fugue-tenants/<tenant>.env` (mode 0400).
That path is the tenant's `secretsRef`.

> **Fail-closed.** A missing file, unreadable file, malformed line, or duplicate
> key makes the worker refuse to boot (never a partial secret map). An empty file
> is a valid empty map (the tenant declared zero secrets).

---

## Deploy the pod

The reference manifest is
[`packages/host/deploy/multi-tenant-openshift.yaml`](../deploy/multi-tenant-openshift.yaml).
It wires the `/dags` and `/run/fugue` volumes, the per-team initContainers, the
per-tenant secret mounts, probes, the heap cap, and a drain-aligned
`terminationGracePeriodSeconds`. Adjust the image refs + tenant list, then:

```bash
oc apply -f packages/host/deploy/multi-tenant-openshift.yaml
oc expose service fugue-host-mt        # or `oc create route edge ...`
oc get pods -l app=fugue-host
curl https://$ROUTE/health             # → {"status":"ok",...}
```

At this point the pod is up but serves **no tenants yet** — register them next.

---

## Provision tenants

Tenants are runtime state, registered via the admin API (idempotent). The body
carries the per-tenant `dagsRoot` (its staged subdir), `secretsRef` (its mounted
env-file), `fsRoot` (its documents mount, if any), admission limits, the Keycloak
client mapping, and `eagerPin`.

```bash
ADMIN=$(oc get secret fugue-mt-platform -o jsonpath='{.data.ADMIN_TOKEN}' | base64 -d)

curl -X POST https://$ROUTE/admin/tenants/cx \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{
    "team": "cx",
    "dagsRoot": "/dags/cx",
    "secretsRef": "/run/secrets/fugue-tenants/cx.env",
    "fsRoot": "/srv/cx",
    "keycloakClientMapping": {
      "realm": "fugue-platform",
      "clientId": "fugue-host-cx",
      "agentClientIdsByDag": { "customer-summary": "fugue-agent-mail" }
    },
    "admission": { "maxConcurrentRuns": 10, "maxQueuedRuns": 20 },
    "eagerPin": false
  }'

curl -X POST https://$ROUTE/admin/tenants/leads \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{
    "team": "leads",
    "dagsRoot": "/dags/leads",
    "secretsRef": "/run/secrets/fugue-tenants/leads.env",
    "fsRoot": "/srv/leads",
    "keycloakClientMapping": { "realm": "fugue-platform", "clientId": "fugue-host-leads", "agentClientIdsByDag": {} },
    "admission": { "maxConcurrentRuns": 5, "maxQueuedRuns": 10 },
    "eagerPin": true
  }'
```

Field notes:

| Field | Meaning |
|-------|---------|
| `dagsRoot` | **Required.** Confined absolute path; the worker's `DAGS_LOCAL_PATH`. Must match the subdir the team's initContainer staged into. |
| `secretsRef` | **Required.** The mounted env-file path the worker resolves its secrets from. |
| `fsRoot` | Per-tenant documents mount (the `fs` documents adapter root); also the path the grace-window purge reclaims on deregister. Confined absolute path. |
| `admission.maxConcurrentRuns` / `maxQueuedRuns` | Per-tenant ceilings. `maxQueuedRuns` is also the worker's HITL queue-depth gate (forwarded as `FUGUE_MAX_QUEUED_RUNS`). |
| `keycloakClientMapping` | Per-tenant realm/clientId + `dagId → agent client id` for downstream capability minting. |
| `eagerPin` | `true` keeps the worker hot (never idle-evicted) — use for latency-sensitive teams. |

The worker is **lazy-spawned** on the tenant's first request (or eagerly if
`eagerPin`). Verify:

```bash
oc logs -l app=fugue-host | grep "Fugue worker is running"
# → {"msg":"Fugue worker is running","tenant":"cx","socketPath":"/run/fugue/cx.sock"}
```

---

## Add / remove a team

**Add:** build `fugue-dags-<team>`, create its env-file Secret, add an
initContainer + secret volume/mount to the manifest, `oc apply`, then
`POST /admin/tenants/<team>` with `dagsRoot: /dags/<team>`.

**Remove:** `DELETE /admin/tenants/<team>` (deregisters; in-flight runs drain, NEW
runs are refused fail-closed). The footprint (Redis keyspace + `fsRoot`) is
reclaimed by the grace-window purge after `SUPERVISOR_GRACE_WINDOW_MS` (default
7 days). Then drop the initContainer/secret on the next manifest apply.

---

## Per-tenant Redis ACL isolation (optional)

By default tenants share the `REDIS_URL` credential and are isolated by key-prefix
(`fugue:<tenant>:*`). For stronger isolation set `SUPERVISOR_REDIS_ACL_ENABLED=true`:
the supervisor mints a fresh scoped `~fugue:<tenant>:*` Redis user per worker spawn
and injects it into that worker's env. This requires the pod's `REDIS_URL`
credential to have **ACL-admin** rights. Fail-closed: a provisioning error refuses
the spawn (503), it does not fall back to the shared credential.

---

## Environment reference

Set on the `fugue-host` container (inherited by every worker unless a per-tenant
override applies). Defaults shown where the schema has one.

| Var | Default | Purpose |
|-----|---------|---------|
| `REDIS_URL` | — (required) | Redis connection (from `fugue-mt-platform`). |
| `ADMIN_TOKEN` | — (required, ≥16 chars) | Admin bearer token for `/admin/*`. |
| `DAGS_REPO_URL` | — (required field) | Unused in the multi-tenant pod (workers run local mode); set `"local"`. |
| `WORKER_UDS_DIR` | `/run/fugue` | Dir for per-tenant sockets; must match the volume mount. |
| `FUGUE_SUPERVISOR_HMAC_KEY` | (unset) | Signs the `X-Fugue-Tenant` header on the supervisor↔worker hop. Recommended. |
| `WORKER_HEAP_CAP_MB` | (unset) | Per-worker V8 heap cap (AD-9) — bounds one tenant's blast radius. |
| `SUPERVISOR_MAX_LIVE_WORKERS` | (unset) | Max simultaneously-live workers (FR-033). |
| `WORKER_IDLE_EVICT_MS` | `900000` | Idle TTL before a non-pinned worker is evicted. |
| `SUPERVISOR_REDIS_ACL_ENABLED` | `false` | Per-tenant Redis ACL minting (needs ACL-admin `REDIS_URL`). |
| `DRAIN_TIMEOUT_MS` | `30000` | In-flight drain budget on shutdown. |
| `THIN_INIT_SHUTDOWN_GRACE_MS` | `10000` | PID-1 grace after forwarding SIGTERM. Keep `< terminationGracePeriod − DRAIN_TIMEOUT_MS`. |
| `THIN_INIT_MAX_SUPERVISOR_RESTARTS` | `5` | Supervisor crash-loop budget. |
| `SUPERVISOR_GRACE_WINDOW_MS` | `604800000` (7d) | Deregistered-tenant footprint retention before purge. |
| `MAX_GLOBAL_CONCURRENCY` / `DEFAULT_DAG_CONCURRENCY` / `*_TIMEOUT_MS` | see config | Per-worker run limits (inherited; per-DAG `fugue.yaml` can override). |

Per-tenant values (NOT set pod-wide — injected by the supervisor from the
registry): `TENANT_ID`, `FUGUE_SECRETS_REF`, `DAGS_LOCAL_PATH`,
`FUGUE_MAX_QUEUED_RUNS`, and (when ACL is enabled) `FUGUE_REDIS_ACL_USERNAME` /
`FUGUE_REDIS_ACL_PASSWORD`.

---

## Choosing a topology

| | Multi-tenant single-host (this doc) | One-host-per-team ([`deployment.md`](./deployment.md)) |
|--|--|--|
| Pods | one pod, many teams | one pod per team |
| Entrypoint | default `main-thin-init.ts` | override CMD to `main.ts` |
| DAG source | per-tenant baked subdir (`DAGS_LOCAL_PATH` via registry) | git-sync (`DAGS_REPO_URL`) or one baked bundle |
| Isolation | process-per-tenant + per-tenant `dagsRoot`/secrets/ACL | hard pod boundary |
| Best for | many small teams, dense packing | a few teams wanting maximum blast-radius isolation |

Both are supported. Pick multi-tenant for density; pick one-host-per-team when a
team must not share a kernel/pod with any other.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Worker logs `dagsRoot must be a confined absolute path` at register | `dagsRoot` was relative or contained `..`. |
| Worker boots but `dagCount: 0` at `/readiness` | The team's initContainer staged into a different subdir than the registered `dagsRoot`. |
| Worker exits 1 with `FUGUE_SECRETS_REF is required` / `env-file secrets source '…': …` | The tenant's secret isn't mounted at its `secretsRef` path, or the env-file is malformed. |
| `503 worker-unavailable` on first request | Spawn failed (OOM / heap cap too low / ACL provisioning error). Check `oc logs` for the underlying cause. |
| Probe 401/404 | Probes must hit `/health` + `/readiness` on the supervisor's TCP port — not a worker socket. |
