# @fuguejs/host

The Fugue Host is a production-grade runtime that discovers, loads, and serves DAG-based AI workflows via HTTP. It polls a git repository for DAG definitions, validates them at load time, and exposes them as authenticated REST endpoints with concurrency limiting, circuit breaking, and graceful shutdown.

## Deployment Model: One Host Per Team

Each team gets their own host instance. This gives you:

- **Own API key** — each team configures their LLM provider and key
- **Own model choice** — teams pick any model their provider supports (per-node in DAG code)
- **Own provider** — one team on Anthropic, another on OpenAI, another on Azure
- **Blast radius isolation** — runaway DAGs can't starve other teams
- **Independent scaling** — scale each team's host to their traffic pattern

```
┌───────────────────────────────┐    ┌───────────────────────────────┐
│  fugue-host (team: cx)        │    │  fugue-host (team: leads)     │
│                               │    │                               │
│  LLM_PROVIDER=openai          │    │  LLM_PROVIDER=anthropic       │
│  OPENAI_API_KEY=sk-cx-...     │    │  ANTHROPIC_API_KEY=sk-ant-... │
│  ADMIN_TOKEN=<ops-token>      │    │  ADMIN_TOKEN=<ops-token>      │
│  DAGS_REPO_URL=team's repo    │    │  DAGS_REPO_URL=team's repo    │
│                               │    │                               │
│  DAGs: customer-summary,      │    │  DAGs: lead-scoring,          │
│        intent-classifier      │    │        lead-opener            │
└───────────────────────────────┘    └───────────────────────────────┘
```

The auth layer still adds value in this model:
- `ADMIN_TOKEN` = platform operations (monitoring, debugging, provisioning)
- `fug_...` team token = application credential (what the team's services use)
- Applications never hold the admin key — separation of privilege

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Fugue Host                                   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  HTTP Layer (Hono)                                            │  │
│  │  /health  /readiness  /admin/*  /dags  /dags/:id/run         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌──────────┐  ┌────────────┴─────────┐  ┌──────────────────┐    │
│  │ Auth     │  │ Domain (pure)         │  │ Sync Loop        │    │
│  │ Middleware│  │ • HostState machine   │  │ • git pull       │    │
│  │          │  │ • Registry (immutable) │  │ • module load    │    │
│  │          │  │ • Concurrency limiter  │  │ • registry swap  │    │
│  │          │  │ • Circuit breaker      │  │                  │    │
│  └──────────┘  └───────────────────────┘  └──────────────────┘    │
│                              │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐  │
│  │  Adapters (imperative)                                       │  │
│  │  • GitSync (Bun.spawn → git)    • ModuleLoader (import())   │  │
│  │  • TokenStore (Redis)           • NodeContextFactory         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐  │
│  │  Infrastructure                                              │  │
│  │  Redis (tokens, cache, checkpoints)   LLM (team's provider)  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Start Redis

```bash
redis-server --daemonize yes
```

### 2. Create a DAGs directory

```bash
mkdir -p /tmp/my-dags/dags/my-team/my-dag/prompts
```

### 3. Write a DAG

```typescript
// /tmp/my-dags/dags/my-team/my-dag/dag.ts
import { z } from "zod";
import type { DagRegistration } from "@fuguejs/host/contract";
import { defineDag, createLlmNode } from "@fuguejs/framework";

const summarize = createLlmNode({
  id: "summarize",
  model: "gpt-4o-mini",              // team picks their model
  promptName: "summarize",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  buildInput: (input) => ({ text: input.text }),
});

const dag = defineDag({
  id: "my-dag",
  nodes: { summarize },
  edges: [],
  outputNodeId: "summarize",
});

const registration: DagRegistration = {
  dag,
  inputSchema: z.object({ text: z.string() }),
  meta: { description: "Summarize text", version: "1.0.0" },
};

export default registration;
```

### 4. Add a prompt template

```text
# /tmp/my-dags/dags/my-team/my-dag/prompts/summarize.txt
Text to summarize:
{{text}}

Produce a concise 2-3 sentence summary.
```

### 5. Add fugue.yaml

```yaml
# /tmp/my-dags/dags/my-team/my-dag/fugue.yaml
team: my-team
```

### 6. Start the host

```bash
DAGS_LOCAL_PATH=/tmp/my-dags \
DAGS_REPO_URL=https://unused.git \
REDIS_URL=redis://localhost:6379 \
ADMIN_TOKEN=$(openssl rand -base64 32) \
LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-proj-your-key \
PORT=3000 \
bun run packages/host/src/main.ts
```

### 7. Provision the team token

```bash
# Create the team
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team": "my-team", "label": "My team"}'
# → { "ok": true, "token": "fug_...", "team": "my-team" }

# Call the DAG with the team token
curl -X POST http://localhost:3000/dags/my-dag/run \
  -H "Authorization: Bearer fug_<token-from-above>" \
  -H "Content-Type: application/json" \
  -d '{"text": "The quick brown fox jumped over the lazy dog."}'
```

---

## Configuration

All configuration is via environment variables, validated at startup with Zod. The host **refuses to start** if required variables are missing or invalid.

### Required

| Variable | Description |
|----------|-------------|
| `DAGS_REPO_URL` | Git URL for the DAGs repository |
| `REDIS_URL` | Redis connection URL — **all host instances can share one Redis instance** (keys are namespaced) |
| `ADMIN_TOKEN` | Admin bearer token (min 16 chars) — used for team provisioning and ops |

### LLM Provider (team chooses one)

| Variable | Required when | Description |
|----------|--------------|-------------|
| `LLM_PROVIDER` | Always (default: `anthropic`) | `anthropic`, `openai`, or `azure` |
| `ANTHROPIC_API_KEY` | `LLM_PROVIDER=anthropic` | Team's Anthropic API key |
| `OPENAI_API_KEY` | `LLM_PROVIDER=openai` | Team's OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | `LLM_PROVIDER=azure` | Team's Azure endpoint URL |
| `AZURE_OPENAI_API_KEY` | `LLM_PROVIDER=azure` | Team's Azure API key |
| `AZURE_OPENAI_DEPLOYMENT` | `LLM_PROVIDER=azure` | Team's Azure deployment name |
| `AZURE_OPENAI_API_VERSION` | No (default: `2025-03-01-preview`) | Azure API version |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DAGS_REPO_BRANCH` | `main` | Branch to track |
| `DAGS_POLL_INTERVAL_MS` | `30000` | Git polling interval (ms) |
| `DAGS_LOCAL_PATH` | — | Skip git clone, read from this path (dev mode) |
| `PORT` | `3000` | HTTP listen port |
| `REDIS_PROBE_INTERVAL_MS` | `10000` | Redis liveness probe interval (ms) |
| `MAX_GLOBAL_CONCURRENCY` | `50` | Max concurrent DAG runs |
| `DEFAULT_DAG_CONCURRENCY` | `10` | Default per-DAG concurrency limit |
| `DEFAULT_DAG_TIMEOUT_MS` | `60000` | Default per-DAG timeout (ms) |
| `MAX_DAG_TIMEOUT_MS` | `120000` | Hard ceiling on DAG timeout |
| `DRAIN_TIMEOUT_MS` | `30000` | Graceful shutdown drain period |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before circuit opens |
| `CIRCUIT_BREAKER_WINDOW_MS` | `60000` | Failure counting window |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | Cooldown before half-open probe |
| `DEFAULT_CACHE_TTL_MS` | `300000` | Default cache entry TTL (5 min) |
| `DEFAULT_CHECKPOINT_TTL_MS` | `86400000` | Default checkpoint TTL (24 hr) |
| `DOCUMENTS_ADAPTER` | — | Documents capability adapter (`fs`) |
| `DOCUMENTS_FS_ROOT` | — | Root dir for fs documents (required when adapter=fs) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry exporter endpoint |
| `MLFLOW_TRACKING_URI` | — | MLflow tracking server URI |
| `MLFLOW_EXPERIMENT_ID` | — | MLflow experiment ID |

---

## LLM & Model Selection

### How models work

The LLM provider and API key are configured at the host level (one per team's host instance). The **model** is chosen per-node in DAG code:

```typescript
const expensive = createLlmNode({
  id: "deep-analysis",
  model: "gpt-4o",           // full-power model for complex reasoning
  // ...
});

const cheap = createLlmNode({
  id: "classify",
  model: "gpt-4o-mini",     // cheap model for simple classification
  // ...
});
```

Different nodes in the same DAG can use different models. The `model` string is sent directly to the provider API.

### Provider-specific behavior

| Provider | Model routing |
|----------|--------------|
| **OpenAI** | Per-node `model` sent directly. Teams use any model their key has access to: `gpt-4o`, `gpt-4o-mini`, `o4-mini`, etc. |
| **Anthropic** | Per-node `model` sent directly: `claude-sonnet-4-20250514`, `claude-haiku-4-20250514`, etc. |
| **Azure** | `AZURE_OPENAI_DEPLOYMENT` overrides per-node model. All calls route through one deployment. Deploy multiple host instances for multiple Azure models. |

---

## Authentication & Team Provisioning

The host uses bearer token authentication with two tiers:

| Tier | Source | Purpose |
|------|--------|---------|
| **Admin** | `ADMIN_TOKEN` env var | Platform ops: provisioning, monitoring, debugging |
| **Team** | Generated via `POST /admin/teams` | Application credential: what the team's services use |

### First-time setup (at deploy time)

After the host starts, provision the team:

```bash
curl -X POST http://fugue-host:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team": "cx", "label": "CX team production"}'
```

**Response:**
```json
{
  "ok": true,
  "token": "fug_a3x8k9m2pL4vR8nT1wF6jH3cY5aD0gEabc123xyzQ_dK-abcdef",
  "team": "cx",
  "label": "CX team production"
}
```

> ⚠️ **The token is shown ONCE.** Only the SHA-256 hash is stored in Redis. If lost, revoke and re-create.

Store the token in the team's secret management (1Password, Vault, K8s secrets) and configure their applications to use it.

### How applications authenticate

```bash
curl -X POST http://fugue-host:3000/dags/customer-summary/run \
  -H "Authorization: Bearer fug_<team-token>" \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust-001"}'
```

### Why the team token layer exists (even with one team per host)

- Applications never hold the admin key — leaked app credential ≠ admin access
- Admin can revoke/rotate the app credential without restarting the host
- Clear audit separation: admin ops vs application traffic
- If you later add DAGs from multiple teams to the same host, isolation is already wired

For the full auth guide (token anatomy, security internals, rotation workflow, operational runbook), see **[`docs/auth.md`](docs/auth.md)**.

---

## HTTP API

### Unauthenticated

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe — always `200` |
| `GET` | `/readiness` | Readiness — `200` when serving, `503` during boot/drain |

### Admin (requires `ADMIN_TOKEN`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/teams` | Provision a team token |
| `GET` | `/admin/teams` | List provisioned teams |
| `DELETE` | `/admin/teams/:team` | Revoke a team token (immediate) |

### DAG Execution (requires valid token)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dags` | List registered DAGs |
| `GET` | `/dags/:id/manifest` | DAG schema/structure manifest |
| `POST` | `/dags/:id/run` | Execute a DAG |
| `POST` | `/<custom-route>` | Execute via custom route override |

### Response Format

**Success (200):**
```json
{
  "ok": true,
  "data": { "summary": "..." },
  "runId": "f644de42-2085-44cf-880d-e9efd659c590",
  "durationMs": 3200
}
```

**Error (4xx/5xx):**
```json
{
  "ok": false,
  "error": "input-validation-failed",
  "message": "input validation failed for DAG 'customer-summary': 1 issue(s)",
  "dagId": "customer-summary",
  "details": { "issues": [{ "path": ["customerId"], "message": "Required" }] }
}
```

| Status | Error | When |
|--------|-------|------|
| 400 | `input-validation-failed` | Request body fails Zod schema |
| 400 | `body-parse-failed` | Not valid JSON |
| 401 | `unauthorized` | Missing or invalid token |
| 403 | `forbidden` | Token can't access this DAG's team |
| 404 | `dag-not-found` | DAG ID doesn't exist |
| 408 | `timeout` | Exceeded timeout |
| 429 | `dag-concurrency-exceeded` | Per-DAG concurrency limit hit |
| 429 | `global-concurrency-exceeded` | Global limit hit |
| 503 | `dag-disabled` | Circuit breaker open |

---

## Writing DAGs

See the full guide in [`docs/writing-dags.md`](docs/writing-dags.md).

### Directory Convention

```
your-dags-repo/
├── dags/
│   └── my-team/
│       └── customer-summary/
│           ├── dag.ts              ← DagRegistration (default export)
│           ├── prompts/
│           │   └── synthesis.txt   ← {{placeholder}} templates
│           └── fugue.yaml          ← team, route, timeout overrides
├── package.json
└── bun.lock
```

### The DagRegistration Contract

```typescript
import type { DagRegistration } from "@fuguejs/host/contract";

const registration: DagRegistration = {
  dag,                              // from defineDag()
  inputSchema: InputSchema,         // Zod schema for HTTP body validation
  route: "/summarize",              // optional custom route (default: /dags/:id/run)
  config: {
    timeoutMs: 90_000,              // per-DAG timeout
    maxConcurrent: 5,               // per-DAG concurrency limit
    cacheTtlMs: 600_000,            // cache entry TTL
    checkpointTtlMs: 86_400_000,    // checkpoint TTL
    circuitBreaker: {               // per-DAG circuit breaker
      failureThreshold: 3,
      resetTimeoutMs: 15_000,
    },
  },
  meta: { description: "...", version: "1.0.0" },
};

export default registration;
```

### Per-DAG Config (fugue.yaml)

```yaml
team: my-team               # team owning this DAG
owner: platform             # individual owner (metadata)
route: /summarize           # custom route override
maxConcurrent: 5            # concurrency limit
timeoutMs: 90000            # timeout (ms)
cacheTtlMs: 600000          # cache TTL
checkpointTtlMs: 86400000   # checkpoint TTL
env:                        # required env vars (fail-closed)
  - MY_SECRET_KEY
```

`fugue.yaml` **wins** over `dag.ts` `config` for any field it sets.

---

## Hot Reload

DAGs are updated by pushing to the git repository. No host restart needed.

1. Host polls git every `DAGS_POLL_INTERVAL_MS` (default 30s)
2. `git pull --ff-only` → compare SHA
3. If `bun.lockb` changed → `bun install --frozen-lockfile`
4. Discover and load all DAGs
5. Atomically swap the registry (immutable snapshot)
6. Force-reset all circuit breakers

A broken DAG file doesn't affect others — the host logs the error and continues serving healthy DAGs.

---

## Deployment

See [`docs/deployment.md`](docs/deployment.md) for the full OpenShift guide.

### Minimal production setup

```bash
# Environment for a team's host instance
DAGS_REPO_URL=https://github.com/org/team-dags.git
REDIS_URL=redis://:password@redis:6379
ADMIN_TOKEN=<generated-32-byte-random>
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-team-key
PORT=3000
```

After deploy:
```bash
# One-time: provision the team
curl -X POST http://host:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team": "my-team"}'
# → Save the returned fug_... token for the team's apps
```

---

## Tests

```bash
bun test                    # All tests across all packages
bun test packages/host      # Host tests only
bun run typecheck           # TypeScript validation
```

---

## Further Documentation

| Document | Contents |
|----------|----------|
| [`docs/auth.md`](docs/auth.md) | Full auth guide: token anatomy, security model, rotation, operational runbook |
| [`docs/writing-dags.md`](docs/writing-dags.md) | DAG authoring: directory convention, contract, prompts, per-DAG config |
| [`docs/deployment.md`](docs/deployment.md) | OpenShift deployment: container, Redis, secrets, monitoring, scaling |
