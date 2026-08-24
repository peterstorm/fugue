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
9. [Declarative bootstrap (GitOps — no admin API, no `oc exec`)](#declarative-bootstrap-gitops--no-admin-api-no-oc-exec)
10. [Add / remove a team](#add--remove-a-team)
11. [Per-tenant Redis ACL isolation (optional)](#per-tenant-redis-acl-isolation-optional)
12. [Environment reference](#environment-reference)
13. [Choosing a topology](#choosing-a-topology)
14. [Troubleshooting](#troubleshooting)

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

> `dagsRoot` is parsed as a **tenant-owned root** at registration: tenant `cx`
> may use `/dags/cx` or a canonical descendant, never `/`, a host path, an alias,
> or another tenant's subtree. The same rule binds `fsRoot` under `/srv/<tenantId>`
> before that path can become a recursive purge target.

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
| `dagsRoot` | **Required.** Tenant-owned `/dags/<tenantId>` root or canonical descendant; the worker's `DAGS_LOCAL_PATH`. Must match the subdir the team's initContainer staged into. |
| `secretsRef` | **Required.** The mounted env-file path the worker resolves its secrets from. |
| `fsRoot` | Tenant-owned `/srv/<tenantId>` documents root or canonical descendant; also the recursive path the grace-window purge reclaims on deregister. |
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

## Declarative bootstrap (GitOps — no admin API, no `oc exec`)

The admin-API flow above needs in-cluster reach to a (deliberately Route-less)
host. On a locked-down namespace with **no `exec`/`port-forward` RBAC** there is
no way to drive those calls — and the multi-tenant supervisor exposes **no
team-minting endpoint at all** (team tokens are platform state, not a per-worker
route). For those environments the supervisor seeds tenants **and** team tokens
from **mounted files at startup**, so a `git push` + ArgoCD sync brings the host
up fully provisioned with zero imperative calls.

Both inputs are applied **idempotently on every boot** and **fail closed**: a
malformed file or an apply error exits the supervisor non-zero (the pod restarts)
rather than serving a half-seeded host. Re-applying an unchanged file is a no-op.

**1. Tenants — a non-secret ConfigMap.** A JSON **array** of the exact same
objects the admin API takes (each with a top-level `id`). Mount it and point
`TENANTS_BOOTSTRAP_PATH` at it.

```yaml
# ConfigMap fugue-tenants-bootstrap → key tenants.json
[
  { "id": "cx",    "team": "cx",    "dagsRoot": "/dags/cx",    "secretsRef": "/run/secrets/fugue-tenants/cx.env",
    "fsRoot": "/srv/cx",    "keycloakClientMapping": { "realm": "fugue-platform", "clientId": "fugue-host-cx",    "agentClientIdsByDag": {} },
    "admission": { "maxConcurrentRuns": 10, "maxQueuedRuns": 20 }, "eagerPin": false },
  { "id": "leads", "team": "leads", "dagsRoot": "/dags/leads", "secretsRef": "/run/secrets/fugue-tenants/leads.env",
    "fsRoot": "/srv/leads", "keycloakClientMapping": { "realm": "fugue-platform", "clientId": "fugue-host-leads", "agentClientIdsByDag": {} },
    "admission": { "maxConcurrentRuns": 5,  "maxQueuedRuns": 10 }, "eagerPin": true }
]
```

**2. Team tokens — a SealedSecret.** A JSON **object** mapping `team → token`,
where each token is a **pre-provided** `fug_` team token you generate once. This
replaces the one-time "minted token shown once" capture step: you seal the SAME
token into the host's bootstrap secret **and** into the consuming app's secret
(e.g. lead-desk's `FUGUE_TEAM_TOKEN`), so both sides agree with no copy-paste.

```bash
# Generate a token with the fug_ shape the auth path requires:
TOKEN="fug_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
# Seal { "leads": "<TOKEN>" } into the host bootstrap secret AND the app's secret.
```

```yaml
# Secret fugue-team-tokens-bootstrap → key team-tokens.json
{ "cx": "fug_…", "leads": "fug_…" }
```

Wire both onto the `fugue-host` container:

```yaml
env:
  - name: TENANTS_BOOTSTRAP_PATH
    value: /etc/fugue/bootstrap/tenants.json
  - name: TEAM_TOKENS_BOOTSTRAP_PATH
    value: /run/secrets/fugue-bootstrap/team-tokens.json
volumeMounts:
  - { name: tenants-bootstrap,    mountPath: /etc/fugue/bootstrap,        readOnly: true }
  - { name: team-tokens-bootstrap, mountPath: /run/secrets/fugue-bootstrap, readOnly: true }
volumes:
  - { name: tenants-bootstrap,    configMap: { name: fugue-tenants-bootstrap } }
  - { name: team-tokens-bootstrap, secret:   { secretName: fugue-team-tokens-bootstrap } }
```

Rules the parsers enforce at boot (parse-don't-validate):

- A tenant entry is validated through the **same** parser as `POST /admin/tenants`
  — a malformed config aborts boot exactly as it would 400 the API.
- A duplicate tenant `id`, or a duplicate `team` in the token file, is rejected
  (ambiguous — never last-writer-wins).
- A token **must** have the `fug_` shape (prefix + ≥43 chars) or it would never
  resolve via the team-token auth path — caught at boot, not as a silent 401.
- Every token's team **must** be owned by an active tenant from the tenants file —
  a token for an unknown team aborts boot rather than 403 the team at runtime.
- Re-seeding the **same** token for a team is a no-op; a **rotated** token (same
  team, new value) **upserts** (the stale token stops working).
- The token value is treated as a secret: it never appears in a log line or error.

> Tip for tests/dev: `TENANTS_BOOTSTRAP` / `TEAM_TOKENS_BOOTSTRAP` accept the same
> JSON **inline** as an env var (the `*_PATH` file wins when both are set).

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
| `TENANTS_BOOTSTRAP_PATH` | (unset) | Path to a mounted ConfigMap file: JSON array of tenant configs seeded idempotently at boot (GitOps, no admin API). |
| `TEAM_TOKENS_BOOTSTRAP_PATH` | (unset) | Path to a mounted SealedSecret file: JSON `team → fug_token` map seeded idempotently at boot. |
| `TENANTS_BOOTSTRAP` / `TEAM_TOKENS_BOOTSTRAP` | (unset) | Same JSON inline (dev/test); the `*_PATH` file wins when both set. |
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
| Registration reports `dagsRoot must be '/dags/<tenant>'…` or `fsRoot must be '/srv/<tenant>'…` | The path was non-canonical, outside the tenant-id subtree, or belonged to another tenant. |
| Worker boots but `dagCount: 0` at `/readiness` | The team's initContainer staged into a different subdir than the registered `dagsRoot`. |
| Worker exits 1 with `FUGUE_SECRETS_REF is required` / `env-file secrets source '…': …` | The tenant's secret isn't mounted at its `secretsRef` path, or the env-file is malformed. |
| `503 worker-unavailable` on first request | Spawn failed (OOM / heap cap too low / ACL provisioning error). Check `oc logs` for the underlying cause. |
| Probe 401/404 | Probes must hit `/health` + `/readiness` on the supervisor's TCP port — not a worker socket. |
| Supervisor exits 1 with `declarative bootstrap failed` | A bootstrap file is malformed or inconsistent — read the message: bad JSON, duplicate id/team, a non-`fug_` token, or a token whose team no tenant owns. Fail-closed by design (fix the ConfigMap/Secret and re-sync). |
