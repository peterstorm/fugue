# Fugue Host — Deployment Guide (OpenShift)

Deploy a Fugue Host instance for a team on OpenShift with their own LLM credentials, Redis, and DAG repository.

> **This guide covers the one-host-per-team topology** (one pod per team, the
> single-tenant `main.ts` entrypoint). To run **one pod serving many teams** with
> process-per-tenant isolation, see the
> [Multi-Tenant Single-Host Deployment guide](./multi-tenant-deployment.md). Both
> topologies are supported — see its *Choosing a topology* table to decide.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Build the Container Image](#build-the-container-image)
3. [Create the OpenShift Project](#create-the-openshift-project)
4. [Deploy Redis](#deploy-redis)
5. [Create Secrets](#create-secrets)
6. [Deploy the Host](#deploy-the-host)
7. [Expose via Route](#expose-via-route)
8. [Verify the Deployment](#verify-the-deployment)
9. [Provision the Team Token](#provision-the-team-token)
10. [Add a DAG](#add-a-dag)
11. [Execute a DAG](#execute-a-dag)
12. [Multiple Teams](#multiple-teams)
13. [Monitoring & Troubleshooting](#monitoring--troubleshooting)
14. [Scaling](#scaling)
15. [Upgrading](#upgrading)

---

## Prerequisites

- OpenShift CLI (`oc`) with project-admin privileges
- Container registry access
- Team's DAGs git repository (HTTPS or SSH)
- Team's LLM API credentials (OpenAI, Anthropic, or Azure)
- `openssl` for generating secrets

---

## Build the Container Image

One image serves all team instances — only config differs.

```bash
# From the monorepo root
podman build -f packages/host/Dockerfile -t fugue-host:latest .

# Tag and push
podman tag fugue-host:latest your-registry.example.com/fugue/host:0.2.0
podman push your-registry.example.com/fugue/host:0.2.0
```

**What's in the image:**
- Bun 1.2 runtime (Alpine-based, ~50MB)
- `git` + `openssh-client` (for DAG repo sync over https/ssh)
- `packages/framework/`, `packages/host/`, `packages/adapter-fs/`, `packages/adapter-ms-graph/`, and
  `packages/document-source/` source (the adapter packages back
  `DOCUMENTS_ADAPTER=fs` / `ms-graph`, which the entries import dynamically)
- Dependencies via `bun install --frozen-lockfile --production`
- Non-root user `fugue`, port 3000, health check at `GET /health`

---

## Create the OpenShift Project

One project per team's host instance:

```bash
oc new-project fugue-cx --display-name="Fugue Host — CX Team"
```

---

## Deploy Redis

All Fugue host instances can share a single Redis instance. Keys are namespaced by prefix, so there are no collisions.

### Deploy shared Redis (recommended)

```bash
helm install platform-redis bitnami/redis \
  --set auth.password=<generated-password> \
  --set master.persistence.size=5Gi \
  --set replica.replicaCount=2  # HA setup
```

Note the connection URL: `redis://:password@platform-redis-master:6379`

Use this same URL for all host instances.

### Spend-ledger backend

Stock host wiring is Redis-first and unchanged. Redis spend records follow the
checkpoint TTL and survive process replacement. If the configured Redis adapter
cannot provide the increment/read/expiry primitives, the host logs an error and
falls back to the process-local ledger; budgets then survive parks in that
process but not restarts.

Embedders using the F6 file runtime may instead construct
`createFileSpendLedger(root)` and inject it as `SharedInfra.spendLedger`. Its
backend metadata marks it authoritative and restart-durable, so Redis capability
detection does not displace it and no in-process “NOT durable” warning is emitted.
The root must be a persistent, non-symlink directory owned by the runtime user. Keep
it for at least as long as resumable run state; deleting a run's durable state
must delete its spend record in the same lifecycle operation. The backend uses
per-run lock directories and atomic rename, and is intended for F6's local
single-writer filesystem contract—not network filesystems with incompatible
rename/lock semantics. No automatic TTL, GC, or backend selection from
`DAGS_LOCAL_PATH` is provided.

### Key namespacing

Multiple hosts use the same Redis with no conflicts:

```
Host instance "cx"        Host instance "leads"       Host instance "billing"
       │                          │                           │
       └─ fugue:tokens:<hash>     ├─ fugue:tokens:<hash>      ├─ fugue:tokens:<hash>
       ├─ fugue:teams:cx          ├─ fugue:teams:leads        ├─ fugue:teams:billing
       ├─ fugue:customer-summary: ├─ fugue:lead-scoring:      ├─ fugue:invoice-processor:
       │  cache:<key>             │  cache:<key>              │  cache:<key>
       └─ fugue:customer-summary: └─ fugue:lead-scoring:      └─ fugue:invoice-processor:
          <runId>:<nodeId>           <runId>:<nodeId>            <runId>:<nodeId>
                                                                    ↓
                                              [Single Shared Redis Instance]
```

All keys are prefixed with their scope:
- `fugue:tokens:*` — team tokens (all teams)
- `fugue:teams:*` — team metadata (all teams)
- `fugue:<dagId>:*` — per-DAG cache and checkpoints (team-scoped by DAG ownership)

### Sizing the shared Redis

| Metric | Estimate |
|--------|----------|
| Team tokens (per team) | ~1KB (hash + metadata) |
| Cache entries | Depends on DAG cache usage; TTL auto-cleanup |
| Checkpoints | Depends on DAG complexity; TTL auto-cleanup |
| **Total** (3 teams, light usage) | ~500MB—1GB |

Monitor Redis memory with `redis-cli INFO memory`. Set `maxmemory` and eviction policy:

```bash
helm install platform-redis bitnami/redis \
  --set master.persistence.size=5Gi \
  --set redis.masterConfiguration.maxmemory=4gb \
  --set redis.masterConfiguration.maxmemoryPolicy=allkeys-lru
```

> **Optional: Separate Redis per team** — If you need complete isolation (e.g., one team's high cache usage shouldn't evict another's), deploy independent Redis instances. But shared Redis is simpler and more resource-efficient.

---

## Create Secrets

### Generate the admin token

```bash
ADMIN_TOKEN=$(openssl rand -base64 32)
echo "Save this: $ADMIN_TOKEN"
```

### Create the secret (example: team on OpenAI)

```bash
oc create secret generic fugue-host-secrets \
  --from-literal=ADMIN_TOKEN="$ADMIN_TOKEN" \
  --from-literal=REDIS_URL="redis://:password@fugue-redis-master:6379" \
  --from-literal=OPENAI_API_KEY="sk-proj-team-cx-key..."
```

**For Anthropic:**
```bash
oc create secret generic fugue-host-secrets \
  --from-literal=ADMIN_TOKEN="$ADMIN_TOKEN" \
  --from-literal=REDIS_URL="redis://:password@fugue-redis-master:6379" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-team-key..."
```

**For Azure:**
```bash
oc create secret generic fugue-host-secrets \
  --from-literal=ADMIN_TOKEN="$ADMIN_TOKEN" \
  --from-literal=REDIS_URL="redis://:password@fugue-redis-master:6379" \
  --from-literal=AZURE_OPENAI_API_KEY="team-azure-key" \
  --from-literal=AZURE_OPENAI_ENDPOINT="https://team-resource.openai.azure.com" \
  --from-literal=AZURE_OPENAI_DEPLOYMENT="gpt-4o-mini"
```

### (Optional) Git credentials for private DAG repos

```bash
oc create secret generic fugue-git-credentials \
  --from-literal=GIT_ASKPASS_TOKEN="ghp_your-github-pat"
```

### (Optional) HITL, identity, and documents adapter

These are off by default. Add the relevant block to the host's env when a team's
DAGs need them.

**Human-in-the-loop (Teams approvals).** Required when any DAG declares a
`humanReview` gate — HITL runs on the durable BullMQ-over-Redis queue backend
(no extra service; it reuses `REDIS_URL`). Setting either the webhook URL or the
`BOT_APP_ID`/`BOT_APP_PASSWORD` pair enables HITL; a `humanReview` DAG is refused
with 501 when neither transport is configured. See [`hitl-teams.md`](./hitl-teams.md).

| Env var | Required | Purpose |
|---------|----------|---------|
| `TEAMS_WEBHOOK_URL` | webhook transport | Teams Incoming Webhook (Workflows) URL — must be `https://` |
| `HITL_APPROVAL_BASE_URL` | webhook transport | Public host URL for the card's approval deep-link (`<base>/runs/<id>`) |
| `BOT_APP_ID` | bot transport | Bot Framework / Entra app (client) id — takes precedence over the webhook |
| `BOT_APP_PASSWORD` | bot transport | Bot app client secret (required when `BOT_APP_ID` is set) |
| `BOT_TOKEN_URL` | optional | Override the BF token endpoint (single-tenant bots) — must be `https://` |
| `HITL_RUN_TTL_SEC` | optional | TTL for persisted runs/decisions (default 604800 = 7 days) |
| `HITL_LOCK_TTL_SEC` | optional | Single-flight lock TTL per run slice (default 300) |
| `HITL_WORKER_CONCURRENCY` | optional | Concurrent HITL run slices the worker processes (default 4) |

**Identity-scoped capabilities (Keycloak).** Wires the live capability broker and
the realm-JWT inbound mode. See [`auth.md`](./auth.md).

| Env var | Required | Purpose |
|---------|----------|---------|
| `REALM_JWT_ISSUER` | enables JWT mode | Issuer URL of the `fugue-platform` realm; also selects the live Keycloak broker |
| `REALM_JWT_AUDIENCE` | optional | Audience the host must appear in (default `fugue-host`) |
| `AGENT_CLIENT_SCOPES` | optional | Fail-closed scope policy: JSON `{ clientId: ["provider:operation", …] }` — absent client/scope mints nothing |

**Documents capability.** Required for DAGs declaring `requires: ["documents"]`
(the `fs` adapter is backed by `packages/adapter-fs` + `packages/document-source`,
both in the image; `ms-graph` by `packages/adapter-ms-graph`).

| Env var | Required | Purpose |
|---------|----------|---------|
| `DOCUMENTS_ADAPTER` | for `documents` DAGs | Adapter to wire (`fs` \| `ms-graph`) |
| `DOCUMENTS_FS_ROOT` | when `DOCUMENTS_ADAPTER=fs` | Root directory for the fs adapter (mounted volume / staged files) |
| `MSGRAPH_TENANT_ID` | when `DOCUMENTS_ADAPTER=ms-graph` | Azure app-registration tenant (directory) id |
| `MSGRAPH_CLIENT_ID` | when `DOCUMENTS_ADAPTER=ms-graph` | Azure app (client) id — app-only client credentials |
| `MSGRAPH_CLIENT_SECRET` | when `DOCUMENTS_ADAPTER=ms-graph` | Azure app client secret (never logged) |
| `MSGRAPH_BASE_URL` | optional | Graph base incl. `/v1.0` (sovereign clouds); the token scope derives from its origin unless `MSGRAPH_SCOPE` is set |
| `MSGRAPH_TOKEN_URL` | optional | OIDC v2.0 token-endpoint override (sovereign clouds) |
| `MSGRAPH_SCOPE` | optional | Graph resource scope override (default `<Graph origin>/.default`) |
| `MSGRAPH_REQUEST_TIMEOUT_MS` | optional | Per-request timeout for Graph + token calls (defaults 30 s / 15 s) |
| `MSGRAPH_RESOLVE_PATHS` | optional | `true` = resolve `sharePointPath` refs to driveItem ids by folder-walk (for tenants whose Graph backend rejects item-path URLs — peterstorm/fugue#36). Default `false` |

---

## Deploy the Host

```yaml
# fugue-host-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fugue-host
  labels:
    app: fugue-host
    team: cx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fugue-host
  template:
    metadata:
      labels:
        app: fugue-host
        team: cx
    spec:
      containers:
        - name: fugue-host
          image: your-registry.example.com/fugue/host:0.2.0
          ports:
            - containerPort: 3000
          env:
            - name: DAGS_REPO_URL
              value: "https://github.com/your-org/cx-dags.git"
            - name: DAGS_REPO_BRANCH
              value: "main"
            - name: DAGS_POLL_INTERVAL_MS
              value: "30000"
            - name: PORT
              value: "3000"
            - name: LLM_PROVIDER
              value: "openai"      # team's chosen provider
            - name: MAX_GLOBAL_CONCURRENCY
              value: "50"
            - name: DEFAULT_DAG_CONCURRENCY
              value: "10"
            - name: DEFAULT_DAG_TIMEOUT_MS
              value: "60000"
            - name: DRAIN_TIMEOUT_MS
              value: "30000"
          envFrom:
            - secretRef:
                name: fugue-host-secrets
          resources:
            requests:
              memory: "256Mi"
              cpu: "200m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readiness
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 5
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]
      terminationGracePeriodSeconds: 45
---
apiVersion: v1
kind: Service
metadata:
  name: fugue-host
spec:
  selector:
    app: fugue-host
  ports:
    - port: 3000
      targetPort: 3000
```

```bash
oc apply -f fugue-host-deployment.yaml
```

---

## Expose via Route

```bash
oc create route edge fugue-host \
  --service=fugue-host \
  --port=3000 \
  --insecure-policy=Redirect

FUGUE_URL=$(oc get route fugue-host -o jsonpath='{.spec.host}')
echo "Host available at: https://$FUGUE_URL"
```

---

## Verify the Deployment

```bash
# Pod running?
oc get pods -l app=fugue-host

# Logs
oc logs -l app=fugue-host --tail=20

# Health
curl https://$FUGUE_URL/health
# → {"status":"ok","timestamp":"..."}

# Readiness
curl https://$FUGUE_URL/readiness
# → {"ready":true,"dagCount":2,"phase":"ready"}
```

---

## Provision the Team Token

After the host is running, provision the team (one-time):

```bash
curl -X POST https://$FUGUE_URL/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "team": "cx",
    "label": "CX team production"
  }'
```

Response:
```json
{
  "ok": true,
  "token": "fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gEabc123xyzQ_dK-abcdef",
  "team": "cx",
  "label": "CX team production"
}
```

> ⚠️ **Save the token immediately.** Shown once. Store it as a secret for the team's applications.

```bash
# Store for the team's apps
oc create secret generic fugue-token \
  --namespace=cx-apps \
  --from-literal=FUGUE_TOKEN="fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gEabc123xyzQ_dK-abcdef"
```

---

## Add a DAG

### 1. Create the DAG in the team's repository

```bash
cd team-dags-repo
mkdir -p dags/cx/customer-summary/prompts
```

### 2. Write dag.ts

```typescript
// dags/cx/customer-summary/dag.ts
import { z } from "zod";
import type { DagRegistration } from "@fuguejs/host/contract";
import { defineDag, createFetchNode, createLlmNode, DAG_INPUT } from "@fuguejs/framework";

const InputSchema = z.object({ customerId: z.string().min(1) });

const fetch = createFetchNode({
  id: "fetch-crm",
  inputSchema: z.object({ customerId: z.string() }),
  outputSchema: z.object({ customer: z.any() }),
  fetch: async (input, ctx) => ({
    ok: true, value: { customer: { name: "Alice", id: input.customerId } },
  }),
});

const summarize = createLlmNode({
  id: "summarize",
  inputSchema: z.any(),
  outputSchema: z.object({ summary: z.string() }),
  promptName: "summary",
  model: "gpt-4o-mini",    // team chooses their model
  buildInput: (input) => ({ customerName: input.customer.name }),
});

const dag = defineDag({
  id: "customer-summary",
  nodes: { "fetch-crm": fetch, "summarize": summarize },
  edges: [
    { from: DAG_INPUT, to: "fetch-crm" },   // feed the request into the root (0.2.0)
    { from: "fetch-crm", to: "summarize" },
  ],
  outputNodeId: "summarize",
});

const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  config: { timeoutMs: 90_000, maxConcurrent: 5 },
  meta: { description: "Summarizes customer data", version: "1.0.0" },
};

export default registration;
```

### 3. Add prompt template

```text
# dags/cx/customer-summary/prompts/summary.txt
Customer: {{customerName}}

Summarize this customer's account status in 2-3 sentences.
```

### 4. Add fugue.yaml

```yaml
# dags/cx/customer-summary/fugue.yaml
team: cx
owner: platform-team
```

### 5. Push

```bash
git add dags/cx/customer-summary/
git commit -m "feat: add customer-summary DAG"
git push origin main
```

### 6. Wait for sync (default 30s)

```bash
oc logs -l app=fugue-host -f | grep "sync\|loaded\|customer-summary"
```

### 7. Verify

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://$FUGUE_URL/dags | jq '.dags[]'
```

---

## Execute a DAG

```bash
curl -X POST https://$FUGUE_URL/dags/customer-summary/run \
  -H "Authorization: Bearer fug_<team-token>" \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust-001"}'
```

**Success (200):**
```json
{
  "ok": true,
  "data": { "summary": "Alice has been a customer since..." },
  "runId": "f644de42-2085-44cf-880d-e9efd659c590",
  "durationMs": 3200
}
```

---

## Multiple Teams

Deploy one host instance per team. They share nothing except the container image.

```
┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌──────────────────────────────┐
│ fugue-cx (OpenShift project)│  │ fugue-leads (OS project)    │  │ fugue-billing (OS project)   │
│                             │  │                             │  │                              │
│ LLM_PROVIDER=openai        │  │ LLM_PROVIDER=anthropic      │  │ LLM_PROVIDER=azure           │
│ OPENAI_API_KEY=sk-cx-...   │  │ ANTHROPIC_API_KEY=sk-ant-.. │  │ AZURE_OPENAI_API_KEY=...     │
│ DAGS_REPO=org/cx-dags      │  │ DAGS_REPO=org/leads-dags    │  │ DAGS_REPO=org/billing-dags   │
│ Redis: fugue-redis-cx      │  │ Redis: fugue-redis-leads    │  │ Redis: fugue-redis-billing   │
│                             │  │                             │  │                              │
│ Team token: fug_cx-...     │  │ Team token: fug_leads-...   │  │ Team token: fug_billing-...  │
└─────────────────────────────┘  └─────────────────────────────┘  └──────────────────────────────┘
```

**What each team controls:**
- Their LLM provider and API key (and therefore billing)
- Their model choices (per-node in dag.ts)
- Their DAG repository
- Their concurrency/timeout tuning

**What the platform team controls:**
- The admin token (per instance or shared across instances)
- The container image version (rolling upgrades)
- Resource limits and scaling
- Network policy (which services can reach each host)

### Shared vs separate DAG repos

**Separate repos** (recommended): Each team owns their repo. Clear ownership.

**Shared repo**: All teams' DAGs in one repo (e.g., `dags/cx/...`, `dags/leads/...`). Each host instance syncs the full repo but only serves DAGs matching the provisioned team name. Works but team auth prevents accidental cross-team access.

---

## Monitoring & Troubleshooting

### Structured JSON logging

```json
{"level":"info","msg":"Sync complete: 3 DAGs loaded","sha":"abc123","loaded":3,"errors":0,"ts":"2026-06-09T..."}
{"level":"warn","msg":"DAG load failed (isolated)","error":{"kind":"dag-validation-failed"},"ts":"..."}
```

### Key log messages

| Level | Message | Meaning |
|-------|---------|---------|
| `info` | `Host fully booted and ready` | Startup complete |
| `info` | `Sync complete: N DAGs loaded` | Successful sync |
| `warn` | `DAG load failed (isolated)` | One DAG broken, others fine |
| `warn` | `Git pull failed` | Git unreachable; serves stale |
| `warn` | `Redis liveness probe failed` | Redis lost; host degrades |
| `info` | `Redis recovered` | Redis back; host auto-recovers |
| `error` | `Redis is unreachable — host cannot start` | Fatal at boot |

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Won't start | Missing `ADMIN_TOKEN` or `REDIS_URL` | Check secrets |
| Readiness 503 | DAG repo clone failed | Check `DAGS_REPO_URL`, git creds |
| DAG not appearing | Path doesn't match `dags/{team}/{name}/dag.ts` | Fix directory structure |
| 401 on DAG calls | Token invalid or revoked | Re-provision team |
| 429 | Concurrency limit hit | Increase `maxConcurrent` in fugue.yaml |
| 503 `dag-disabled` | Circuit breaker open | Wait 30s or push fix |

---

## Scaling

### Single instance (default)

The host is designed as a single-instance, in-memory state system:
- Circuit breakers, concurrency counters — all in-memory
- Simple, no distributed coordination needed

### Horizontal scaling (high traffic)

Deploy multiple replicas. Each independently:
- Syncs from git
- Tracks its own circuit breakers (per-instance)
- Enforces concurrency limits (per-instance, so effective limit = `MAX_GLOBAL_CONCURRENCY × replicas`)

### Resource sizing

| Load | Replicas | CPU | Memory |
|------|----------|-----|--------|
| Light (<10 RPS) | 1 | 200m-500m | 256Mi-512Mi |
| Medium (10-50 RPS) | 2 | 500m-1000m | 512Mi-1Gi |
| Heavy (>50 RPS) | 3+ | 1000m+ | 1Gi+ |

---

## Upgrading

### Host upgrades (rolling)

```bash
podman build -f packages/host/Dockerfile -t your-registry.example.com/fugue/host:0.2.0 .
podman push your-registry.example.com/fugue/host:0.2.0

oc set image deployment/fugue-host fugue-host=your-registry.example.com/fugue/host:0.2.0
oc rollout status deployment/fugue-host
```

Graceful shutdown: SIGTERM → stop accepting → drain in-flight → close Redis → exit.

### DAG upgrades (no restart)

Push to the DAG repo. Host auto-syncs within `DAGS_POLL_INTERVAL_MS`. No restart needed.

---

## Security Checklist

- [ ] `ADMIN_TOKEN` is 32+ chars of random data, stored in OpenShift secret
- [ ] Team token distributed via secure channel (Vault, 1Password, K8s secrets)
- [ ] Redis has a password and is not exposed outside the cluster
- [ ] Route uses TLS (edge termination)
- [ ] DAGs repo has branch protection (no force-push to main)
- [ ] Container runs as non-root (built into Dockerfile)
- [ ] Resource limits set
- [ ] Network policy restricts who can reach the host
