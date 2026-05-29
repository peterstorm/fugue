# Fugue Host — OpenShift Deployment Guide

Step-by-step guide to deploying the Fugue Host on OpenShift with Redis, team provisioning, and DAG authoring.

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
9. [Provision Teams](#provision-teams)
10. [Add a DAG](#add-a-dag)
11. [Execute a DAG](#execute-a-dag)
12. [Monitoring & Troubleshooting](#monitoring--troubleshooting)
13. [Scaling Considerations](#scaling-considerations)
14. [Upgrading](#upgrading)

---

## Prerequisites

- OpenShift CLI (`oc`) logged in with project-admin privileges
- Access to a container registry (e.g., `image-registry.openshift-image-registry.svc:5000`)
- A git repository for your DAG definitions (can be private — host clones via HTTPS or SSH)
- Azure OpenAI (or Anthropic/OpenAI) API credentials
- `openssl` or similar for generating secrets

---

## Build the Container Image

The Dockerfile is at `packages/host/Dockerfile`:

```bash
# From the monorepo root
cd /path/to/fugue

# Build the image
podman build -f packages/host/Dockerfile -t fugue-host:latest .

# Tag for your registry
podman tag fugue-host:latest your-registry.example.com/fugue/host:1.0.0

# Push
podman push your-registry.example.com/fugue/host:1.0.0
```

**What's in the image:**
- Bun 1.2 runtime (Alpine-based, ~50MB)
- `git` (for DAG repo sync)
- `packages/framework/` + `packages/host/` source code
- Dependencies installed via `bun install --frozen-lockfile --production`
- Runs as non-root user `fugue`
- Exposes port 3000 (configurable via `PORT`)
- Health check built-in: `GET /health`

---

## Create the OpenShift Project

```bash
oc new-project fugue --display-name="Fugue DAG Runtime"
```

---

## Deploy Redis

The host requires Redis for token storage, cache, and checkpoints.

### Option A: OpenShift Redis Template

```bash
oc new-app redis-persistent \
  --name=fugue-redis \
  -p REDIS_PASSWORD=your-redis-password \
  -p VOLUME_CAPACITY=1Gi \
  -p MEMORY_LIMIT=256Mi
```

### Option B: Redis via Helm (recommended for production)

```bash
helm install fugue-redis bitnami/redis \
  --set auth.password=your-redis-password \
  --set master.persistence.size=2Gi \
  --set replica.replicaCount=1
```

Either way, note the connection URL:
```
redis://:your-redis-password@fugue-redis-master:6379
```

---

## Create Secrets

### Generate the admin token

```bash
ADMIN_TOKEN=$(openssl rand -base64 32)
echo "Save this admin token securely: $ADMIN_TOKEN"
```

### Create the OpenShift secret

```bash
oc create secret generic fugue-host-secrets \
  --from-literal=ADMIN_TOKEN="$ADMIN_TOKEN" \
  --from-literal=REDIS_URL="redis://:your-redis-password@fugue-redis-master:6379" \
  --from-literal=AZURE_OPENAI_API_KEY="your-azure-key" \
  --from-literal=AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com" \
  --from-literal=AZURE_OPENAI_DEPLOYMENT="gpt-4o-mini" \
  --from-literal=AZURE_OPENAI_API_VERSION="2025-04-01-preview"
```

### (Optional) Git credentials for private DAG repos

```bash
oc create secret generic fugue-git-credentials \
  --from-literal=GIT_ASKPASS_TOKEN="ghp_your-github-pat"
```

---

## Deploy the Host

Create the deployment manifest:

```yaml
# fugue-host-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fugue-host
  labels:
    app: fugue-host
spec:
  replicas: 1   # Single instance (see Scaling section)
  selector:
    matchLabels:
      app: fugue-host
  template:
    metadata:
      labels:
        app: fugue-host
    spec:
      containers:
        - name: fugue-host
          image: your-registry.example.com/fugue/host:1.0.0
          ports:
            - containerPort: 3000
              protocol: TCP
          env:
            # Required config
            - name: DAGS_REPO_URL
              value: "https://github.com/your-org/fugue-dags.git"
            - name: DAGS_REPO_BRANCH
              value: "main"
            - name: DAGS_POLL_INTERVAL_MS
              value: "30000"
            - name: PORT
              value: "3000"
            - name: LLM_PROVIDER
              value: "azure"
            # Concurrency tuning
            - name: MAX_GLOBAL_CONCURRENCY
              value: "50"
            - name: DEFAULT_DAG_CONCURRENCY
              value: "10"
            - name: DEFAULT_DAG_TIMEOUT_MS
              value: "60000"
            - name: DRAIN_TIMEOUT_MS
              value: "30000"
            # Resilience tuning
            - name: REDIS_PROBE_INTERVAL_MS
              value: "10000"   # liveness probe interval; drives degraded/recovered transitions
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
            timeoutSeconds: 3
          readinessProbe:
            httpGet:
              path: /readiness
              port: 3000
            initialDelaySeconds: 15
            periodSeconds: 5
            timeoutSeconds: 3
          # Graceful shutdown
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]  # Allow LB to drain connections
      terminationGracePeriodSeconds: 45  # DRAIN_TIMEOUT_MS + buffer
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
      protocol: TCP
```

Apply:
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

# Get the route URL
FUGUE_URL=$(oc get route fugue-host -o jsonpath='{.spec.host}')
echo "Fugue host available at: https://$FUGUE_URL"
```

---

## Verify the Deployment

```bash
# Check pod is running
oc get pods -l app=fugue-host

# Check logs
oc logs -l app=fugue-host --tail=20

# Health check
curl https://$FUGUE_URL/health
# → {"status":"ok","timestamp":"2026-05-26T..."}

# Readiness check
curl https://$FUGUE_URL/readiness
# → {"ready":true,"dagCount":3,"phase":"ready"}

# List DAGs (with admin token)
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://$FUGUE_URL/dags
```

---

## Provision Teams

Teams are how you scope access. Each team gets a unique token that can only access DAGs owned by that team.

### Create a team

```bash
curl -X POST https://$FUGUE_URL/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "team": "cx",
    "label": "Customer Experience team"
  }'
```

Response:
```json
{
  "ok": true,
  "token": "fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gE-abc123xyz",
  "team": "cx",
  "label": "Customer Experience team"
}
```

> ⚠️ **Save this token immediately.** It is shown only once. Only the SHA-256 hash is stored.

### Store the team token as a secret

Give this token to the team for their applications:

```bash
# For the team's own OpenShift project/namespace:
oc create secret generic fugue-token \
  --namespace=cx-team-project \
  --from-literal=FUGUE_TOKEN="fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gE-abc123xyz"
```

### List teams

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://$FUGUE_URL/admin/teams
```

### Revoke a team

```bash
curl -X DELETE https://$FUGUE_URL/admin/teams/cx \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Takes effect immediately — all in-flight requests with the old token will complete, but new ones are rejected.

### Rotate a team token

```bash
# 1. Revoke old
curl -X DELETE https://$FUGUE_URL/admin/teams/cx \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 2. Create new
curl -X POST https://$FUGUE_URL/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team": "cx", "label": "CX team (rotated 2026-05)"}'

# 3. Distribute new token to the team
```

---

## Add a DAG

### 1. Create the DAG in your DAGs repository

```bash
cd your-fugue-dags-repo

# Create directory structure
mkdir -p dags/cx/customer-summary/prompts
```

### 2. Write `dag.ts`

```typescript
// dags/cx/customer-summary/dag.ts
import { z } from "zod";
import type { DagRegistration } from "@fugue/host/contract";
import { defineDag, createFetchNode, createLlmNode } from "@fugue/framework";

const InputSchema = z.object({
  customerId: z.string().min(1),
});

const fetchNode = createFetchNode({
  id: "fetch-crm",
  inputSchema: z.object({ customerId: z.string() }),
  outputSchema: z.object({ customer: z.any() }),
  fetch: async (input, ctx) => {
    // Your data fetching logic here
    return { ok: true, value: { customer: { name: "Alice", id: input.customerId } } };
  },
});

const summarizeNode = createLlmNode({
  id: "summarize",
  inputSchema: z.any(),
  outputSchema: z.object({ summary: z.string() }),
  promptName: "summary",    // loads from prompts/summary.txt
  model: "gpt-4o-mini",    // overridden by host's Azure deployment
  buildInput: (input) => ({ customerName: input.customer.name }),
});

const dag = defineDag({
  id: "customer-summary",
  nodes: { "fetch-crm": fetchNode, "summarize": summarizeNode },
  edges: [{ from: "fetch-crm", to: "summarize" }],
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

### 3. Add prompt templates (if using `createLlmNode`)

```text
# dags/cx/customer-summary/prompts/summary.txt
Customer: {{customerName}}

Summarize this customer's account status in 2-3 sentences.
```

### 4. (Optional) Per-DAG config

Set per-DAG runtime config (`timeoutMs`, `maxConcurrent`, `cacheTtlMs`,
`checkpointTtlMs`, `circuitBreaker`) in the `config` field of the exported
`DagRegistration` in `dag.ts` — see [writing-dags.md](./writing-dags.md#per-dag-config).

> A sibling `fugue.yaml` is **not** read by the host yet, so values placed there have
> no runtime effect. Use the `config` object until file-based merging is wired.

### 5. Commit and push

```bash
git add dags/cx/customer-summary/
git commit -m "feat(cx): add customer-summary DAG"
git push origin main
```

### 6. Wait for sync

The host polls every `DAGS_POLL_INTERVAL_MS` (default 30s). Watch the logs:

```bash
oc logs -l app=fugue-host -f | grep -i "sync\|loaded\|customer-summary"
```

You'll see:
```json
{"level":"info","msg":"Sync complete: 4 DAGs loaded","sha":"abc1234","loaded":4,"errors":0}
```

### 7. Verify

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://$FUGUE_URL/dags | jq '.dags[] | select(.id == "customer-summary")'
```

---

## Execute a DAG

### From a team's application

```bash
curl -X POST https://$FUGUE_URL/dags/customer-summary/run \
  -H "Authorization: Bearer fug_<team-cx-token>" \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust-001"}'
```

### Response format

**Success (200):**
```json
{
  "ok": true,
  "data": { "summary": "Alice has been a customer since..." },
  "runId": "f644de42-2085-44cf-880d-e9efd659c590",
  "durationMs": 3200
}
```

**Validation error (400):**
```json
{
  "ok": false,
  "error": "input-validation-failed",
  "message": "input validation failed for DAG 'customer-summary': 1 issue(s)",
  "dagId": "customer-summary",
  "details": { "issues": [{ "path": ["customerId"], "message": "Required" }] }
}
```

**Concurrency exceeded (429):**
```json
{
  "ok": false,
  "error": "dag-concurrency-exceeded",
  "message": "concurrency limit exceeded for DAG 'customer-summary'",
  "dagId": "customer-summary"
}
```

The response includes a `Retry-After: 5` header.

---

## Monitoring & Troubleshooting

### Structured logging

All logs are JSON lines:
```json
{"level":"info","msg":"Sync complete: 3 DAGs loaded","sha":"abc123","loaded":3,"errors":0,"ts":"2026-05-26T..."}
{"level":"warn","msg":"DAG load failed (isolated): /tmp/fugue-dags/dags/billing/broken/dag.ts","error":{...},"ts":"..."}
```

### Key log messages to watch for

| Level | Message | Meaning |
|-------|---------|---------|
| `info` | `Host fully booted and ready` | Startup complete |
| `info` | `Sync complete: N DAGs loaded` | Successful sync cycle |
| `warn` | `DAG load failed (isolated)` | One DAG has errors but others are fine |
| `warn` | `Git pull failed, existing DAGs remain active` | Git unreachable; continues with stale |
| `warn` | `Redis liveness probe failed — host degraded (redis-disconnected)` | Redis lost after boot; host degrades, keeps serving from memory |
| `info` | `Redis recovered — host returned to ready` | A later probe succeeded; host auto-recovers |
| `error` | `Redis is unreachable — host cannot start` | Fatal — won't boot without Redis |

### Health endpoints for monitoring

```bash
# Liveness (is the process alive?)
curl https://$FUGUE_URL/health
# → 200 always if process is running

# Readiness (is it serving DAGs?)
curl https://$FUGUE_URL/readiness
# → 200 {"ready":true,"dagCount":3,"phase":"ready"}
# → 503 {"ready":false,"dagCount":0,"phase":"booting"}
```

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Pod won't start | Missing `ADMIN_TOKEN` or `REDIS_URL` | Check secrets are mounted |
| `readiness` returns 503 | DAGs repo clone failed | Check `DAGS_REPO_URL` and git credentials |
| DAG not appearing | Path doesn't match `dags/{team}/{name}/dag.ts` | Fix directory structure |
| 401 on DAG calls | Token invalid or revoked | Re-provision the team |
| 403 on DAG calls | Token's team ≠ DAG's team | Check team ownership in path |
| 503 `dag-disabled` | Circuit breaker is open | Wait 30s for half-open, or push a git fix |
| `prompt-not-found` | Missing `.txt` file in `prompts/` dir | Add the file and push |

---

## Scaling Considerations

### Single-instance model (current)

The host is designed as a **single-instance, in-memory state** system (ADR-0040):
- Host state machine is in-memory (not distributed)
- Circuit breaker state is in-memory
- Concurrency counters are in-memory

**For horizontal scaling:** Deploy multiple instances with a load balancer, but note:
- Each instance independently syncs from git (no coordination needed)
- Concurrency limits are per-instance (effective limit = `MAX_GLOBAL_CONCURRENCY × instances`)
- Circuit breakers are per-instance (one instance tripping doesn't affect others)

### Resource sizing

| Load | Replicas | CPU | Memory |
|------|----------|-----|--------|
| Light (<10 RPS) | 1 | 200m-500m | 256Mi-512Mi |
| Medium (10-50 RPS) | 2 | 500m-1000m | 512Mi-1Gi |
| Heavy (>50 RPS) | 3+ | 1000m+ | 1Gi+ |

Memory is dominated by:
- Node.js/Bun heap for concurrent DAG executions
- In-memory prompt templates
- LLM response buffers

### Redis sizing

- Token storage: negligible (<1KB per team)
- Cache entries: depends on DAG cache usage
- Checkpoints: depends on DAG complexity × concurrent runs

---

## Upgrading

### Rolling update

```bash
# Build and push new image
podman build -f packages/host/Dockerfile -t your-registry.example.com/fugue/host:1.1.0 .
podman push your-registry.example.com/fugue/host:1.1.0

# Update the deployment
oc set image deployment/fugue-host \
  fugue-host=your-registry.example.com/fugue/host:1.1.0

# Watch rollout
oc rollout status deployment/fugue-host
```

The host handles graceful shutdown:
1. Receives SIGTERM
2. Stops accepting new requests
3. Waits for in-flight requests to complete (up to `DRAIN_TIMEOUT_MS`)
4. Closes Redis connections
5. Exits cleanly

OpenShift's `terminationGracePeriodSeconds: 45` gives enough time for the drain.

### DAG updates (no host restart needed)

DAGs are updated by pushing to the git repository. The host auto-syncs within `DAGS_POLL_INTERVAL_MS`. No restart required.

---

## Security Checklist

- [ ] `ADMIN_TOKEN` is 32+ chars of random data
- [ ] `ADMIN_TOKEN` is stored in an OpenShift secret, not in deployment YAML
- [ ] Redis has a password set
- [ ] Redis is not exposed outside the cluster
- [ ] The OpenShift route uses TLS (edge termination)
- [ ] Team tokens are distributed via secure channels (1Password, Vault)
- [ ] DAGs repo uses branch protection (no force-push to main)
- [ ] Container runs as non-root (built into Dockerfile)
- [ ] Resource limits are set to prevent noisy-neighbor issues
