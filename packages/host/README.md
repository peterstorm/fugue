# @fuguejs/host

The Fugue Host is a production-grade runtime that discovers, loads, and serves DAG-based AI workflows via HTTP. It polls a git repository for DAG definitions, validates them at load time, and exposes them as authenticated REST endpoints with concurrency limiting, circuit breaking, and graceful shutdown. DAGs may suspend at **human-review gates** (durable approve/reject/resume over HTTP or Microsoft Teams) and reach the outside world through **identity-scoped capabilities** brokered per request.

## Docs

Shipped in this package — read from `node_modules/@fuguejs/host/docs/`:

- [`docs/writing-dags.md`](./docs/writing-dags.md) — the `DagRegistration` + `fugue.yaml` + discovery contract DAG authors deploy against.
- [`docs/auth.md`](./docs/auth.md) — admin / team-token / OIDC auth and team isolation.
- [`docs/deployment.md`](./docs/deployment.md) — container + Redis + OpenShift deployment.
- [`docs/hitl-teams.md`](./docs/hitl-teams.md) — human-in-the-loop approvals in Microsoft Teams (webhook + Bot Framework transports).

For authoring DAGs themselves, see [`@fuguejs/framework/docs/llm-dag-authoring.md`](../framework/docs/llm-dag-authoring.md).

## Injectable file spend ledger

The stock host remains Redis-first. An embedder running the framework's F6 file
runtime can explicitly install the durable file adapter instead of relying on
the in-process fallback. The adapter carries `authoritative`/`file`/`restart`
metadata, so capable Redis does not override this injection and only a selected
memory fallback is reported as not durable:

```ts
import { createFileSpendLedger, formatHostError } from "@fuguejs/host";
import type { SharedInfra } from "@fuguejs/host";

const ledger = createFileSpendLedger("/var/lib/fugue/spend");
if (!ledger.ok) throw new Error(formatHostError(ledger.error));

const shared: SharedInfra = {
  // ...llm, redis, tracer, logger, capabilities...
  llmPricingModel: { kind: "request" },
  spendLedger: ledger.value,
};
```

The directory is deployment-owned. Its records are strict, digest-addressed,
locked whole snapshots; corruption is a typed read error and budgeted slices
fail closed. The adapter does not retry additive writes.

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
│  │  /health /readiness /admin/* /dags /dags/:id/run             │  │
│  │  /runs/:id /runs/:id/approve /teams/messages                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌──────────┐  ┌────────────┴─────────┐  ┌──────────────────┐    │
│  │ Auth     │  │ Domain (pure)         │  │ Sync Loop        │    │
│  │ Middleware│  │ • HostState machine   │  │ • git pull       │    │
│  │ token+JWT│  │ • Registry (immutable) │  │ • module load    │    │
│  │          │  │ • Concurrency limiter  │  │ • registry swap  │    │
│  │          │  │ • Circuit breaker      │  │                  │    │
│  └──────────┘  └───────────────────────┘  └──────────────────┘    │
│                              │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐  │
│  │  Adapters (imperative)                                       │  │
│  │  • GitSync (Bun.spawn → git)    • ModuleLoader (import())   │  │
│  │  • TokenStore (Redis)           • NodeContextFactory         │  │
│  │  • HITL run store + worker      • Capability broker          │  │
│  │    (durable suspend/resume)       (Keycloak token exchange,  │  │
│  │  • Teams approval transport       JWT validation, metering)  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐  │
│  │  Infrastructure                                              │  │
│  │  Redis (tokens, cache, checkpoints, HITL run store)         │  │
│  │  LLM (team's provider)   Keycloak/Entra (identity, optional)│  │
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
import { defineDag, createLlmNode, DAG_INPUT } from "@fuguejs/framework";

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
  // Under 0.2.0 no node implicitly receives the request — feed the entry
  // node explicitly from the DAG_INPUT ("$input") sentinel.
  edges: [{ from: DAG_INPUT, to: "summarize" }],
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
| `AZURE_OPENAI_DEPLOYMENT` | `LLM_PROVIDER=azure` | Team's arbitrary Azure deployment name, used for routing |
| `AZURE_OPENAI_MODEL` | `LLM_PROVIDER=azure` | Underlying model SKU used for pricing and the per-node model contract (for example `gpt-4o-mini`) |
| `AZURE_OPENAI_API_VERSION` | No (default: `2025-03-01-preview`) | Azure API version |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `DAGS_REPO_BRANCH` | `main` | Branch to track |
| `DAGS_POLL_INTERVAL_MS` | `30000` | Git polling interval (ms) |
| `DAGS_LOCAL_PATH` | — | Skip git clone, read from this path (dev mode) |
| `PORT` | `3000` | HTTP listen port |
| `REDIS_PROBE_INTERVAL_MS` | `10000` | Redis liveness probe interval (ms) |
| `MAX_GLOBAL_CONCURRENCY` | `50` | Max concurrent DAG **runs** host-wide (run-level) |
| `DEFAULT_DAG_CONCURRENCY` | `10` | Default max concurrent **runs** of one DAG (run-level; `fugue.yaml` `maxConcurrent` overrides it per DAG) |
| `FAN_CHILD_CONCURRENCY_MAX` | `8` | Host-wide cap on the **children of one map fan** in flight at once, inside a single run (child-level). Positive integer; an invalid value fails startup naming this setting. `1` makes every fan sequential. See [Map fan child concurrency](#map-fan-child-concurrency-and-budget-projection) |
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

### Map fan child concurrency and budget projection

A runtime-width `map` node (a **fan**) runs its child DAG once per input item. Three
concurrency settings exist, at two different levels, and they are deliberately named
apart:

| Setting | Level | Set by | Bounds |
|---|---|---|---|
| `MAX_GLOBAL_CONCURRENCY` | run | operator (env) | concurrent DAG runs across the host |
| `DEFAULT_DAG_CONCURRENCY` / `fugue.yaml` `maxConcurrent` | run | operator / DAG owner | concurrent runs of one DAG |
| `childConcurrency` on the map node | child | DAG author | that fan's children in flight inside one run (default `1`) |
| `FAN_CHILD_CONCURRENCY_MAX` | child | operator (env) | every fan's `childConcurrency`, host-wide (default `8`) |

**How the effective value is chosen**

- A fan runs at **effective concurrency** `C = min(childConcurrency,
  FAN_CHILD_CONCURRENCY_MAX)`.
- When the authored value exceeds the cap, the fan is clamped. The host logs one
  warning and emits one `fan-start` observer event with `clamped: true`, each
  naming the fan, the authored value and the effective value.
- There is no per-run or per-tenant override.
- An unconfigured fan (`childConcurrency` 1) is sequential and byte-identical to
  earlier releases.
- `FAN_CHILD_CONCURRENCY_MAX=1` forces every fan on the host to be sequential.

**Sizing provider rate limits.** The levels multiply. Up to
`MAX_GLOBAL_CONCURRENCY` runs, each with a fan of up to C children, can be calling
your LLM provider at once.

**Nesting.** Nested maps (a map inside a mapped child DAG) are still refused at
DAG load, so a fan's peak concurrency is C. Once nested fans ship, the peak number
of concurrent leaf children will be bounded by the product of the two levels'
effective concurrencies, `C_outer × C_inner`, and each level is capped by
`FAN_CHILD_CONCURRENCY_MAX`.

**Static siblings.** Static fan-out siblings in one wave are not governed by these
settings.

#### Whole-fan budget projection

When the DAG declares a budget (`llmBudget`, or the legacy `llmBudgetTokens`, in
`fugue.yaml` or the `dag.ts` config), a fan does not wait for the per-call meter to
stop it partway through. It projects instead:

1. **The probe batch.** The first `min(C, remaining)` children are dispatched
   unprojected, because nothing has been measured yet.
2. **Projection.** Before every later dispatch, the fan projects
   `settled + remainingChildren × perChildEstimate` on each budgeted axis. If any
   ceiling would be breached, it refuses.
3. **The estimate.** The per-child estimate comes from the fan's `estimator`:
   - `largest-seen`, the default;
   - `p50`, `p90` or `p95`. These fall back to largest-seen until 5 children
     have settled.

A refusal ends the run with error `fan-budget-refused`: HTTP **429**, the same
class as `llm-budget-exceeded`. It does not trip the circuit breaker and it is
never retried. The error and its `fan-refused` event carry:

- the breached axis and ceiling;
- the per-child estimate and the estimator actually applied;
- the effective concurrency;
- the completed and remaining child counts;
- a `lowerBound` flag (true spend may be higher on an unpriced or unknown-usage
  axis);
- the hint: **redeploy the DAG with a larger budget**.

Children already in flight when a fan refuses, fails or is aborted are not
cancelled. They finish and their outputs are saved (the **drain**).

**Overshoot bounds.** C is the effective concurrency. M is the largest measured
per-child spend: the run-wide spend between a child's dispatch and its settle,
which is never below its true cost. With the default `largest-seen` estimator:

- **(a)** Spend after the refusal decision is ≤ (C−1) × M.
- **(b)** If no child costs more than the estimate in force when it was admitted,
  dispatches after the probe batch never push spend past a ceiling. Total
  post-probe overshoot is therefore ≤ (C−1) × M.
- **(c) Probe carve-out.** The unprojected probe batch is bounded by C × M, and by
  the per-call meter.
- **(d) Cost spike.** A child that costs more than the estimate in force at its
  admission is bounded **only by the host per-call meter**.

Under `p50`, `p90` and `p95`, (a) still holds and (b) is **best effort only**. A
percentile sits below the largest child, so a more expensive child counts as a
spike. Choose a percentile when one outlier child would otherwise make projection
refuse a fan that fits.

Two operational notes:

- The per-call meter stays the hard stop for every LLM call under every estimator.
- Because the measure M over-counts when children overlap, a fan at high C may
  refuse slightly early. That is the conservative direction.

#### Resume after a refusal

A refused fan persists a **refusal seed** for its current execution epoch. The
seed is stored as `fan-seed@<mapNodeId>@0@<epoch>` in the run's checkpoint node
hash, next to the fan's saved children.

- **When it applies.** The seed matters only when the same run is re-executed in
  the same epoch:
  - A synchronous run is never resumed. A new request is a new run, with no seed.
  - A durable (HITL) run that settled `fan-budget-refused` is recorded as failed
    and is not retried.
  - The seed governs a replacement worker that resumes a slice interrupted after
    the refusal but before that failure was recorded. It also governs an
    embedder that resumes the run through the framework's resumable entry point.

  In those cases the fan evaluates the seed before dispatching anything.
- **The refusal is sticky until a redeploy raises a ceiling.** Without such a
  redeploy, the fan refuses again with the same `fan-budget-refused`. It
  dispatches **zero** children, however few remain. The `fan-refused` event
  carries `sticky: true`.
- **What counts as a raise.** Run ceilings come only from the DAG's
  `llmBudget`, and a caller can only tighten them. Restarting the host, or
  redeploying with an equal or lower budget, does not lift the refusal.
- **After a raise.** Push a DAG revision with a larger `llmBudget`. The fan then
  resumes with projection before every dispatch (no new probe batch), and it
  reuses every child already saved. Budget and concurrency changes do not change
  the DAG fingerprint, so saved children stay valid. If the raise is still not
  enough, the fan refuses again with a refreshed seed.
- **Reroute.** A HITL reroute that re-runs the fan starts a new execution epoch.
  The old seed is ignored, and the fan probes afresh.

The authoritative record is ADR-0090, concurrent fan scheduling
(`docs/adr/0090-concurrent-fan-scheduling-and-whole-fan-projection.md` in the
repository). For deployment-side guidance,
see [`docs/deployment.md`](docs/deployment.md#map-fan-concurrency).

### Human-in-the-Loop & Identity (optional)

Only needed when a DAG uses human-review gates or identity-scoped capabilities. HITL approvals run on the BullMQ-over-Redis backend, so a reachable `REDIS_URL` is required.

| Variable | Default | Description |
|----------|---------|-------------|
| `HITL_APPROVAL_BASE_URL` | — | Public base URL embedded in approval deep links |
| `HITL_RUN_TTL_SEC` | `604800` | Suspended-run retention (7 days) |
| `HITL_LOCK_TTL_SEC` | `300` | Per-run worker lock TTL |
| `HITL_WORKER_CONCURRENCY` | `4` | HITL resume-worker concurrency |
| `TEAMS_WEBHOOK_URL` | — | Incoming webhook for deep-link-out Teams approvals |
| `BOT_APP_ID` | — | Bot Framework app id (enables in-Teams button approvals; takes precedence over the webhook) |
| `BOT_APP_PASSWORD` | — | Bot Framework app secret |
| `BOT_TOKEN_URL` | — | Bot Framework token endpoint override |
| `REALM_JWT_ISSUER` | — | OIDC issuer for end-user (realm) JWT validation |
| `REALM_JWT_AUDIENCE` | `fugue-host` | Expected audience for realm JWTs |
| `AGENT_CLIENT_SCOPES` | — | Fail-closed scope policy for brokered capability tokens |

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
| **Anthropic** | Per-node `model` is sent directly. USD-budgeted DAGs must use a model present in the framework pricing authority, such as `claude-sonnet-4-20250514` or `claude-haiku-4-20250514`; unpriced aliases fail closed. |
| **Azure** | `AZURE_OPENAI_DEPLOYMENT` is the routing alias; `AZURE_OPENAI_MODEL` is the underlying fixed pricing SKU. A per-node model that differs from the SKU is rejected before egress. Deploy multiple host instances for multiple Azure models. |

---

## Authentication & Team Provisioning

The host authenticates bearer tokens across three identity tiers:

| Tier | Source | Purpose |
|------|--------|---------|
| **Admin** | `ADMIN_TOKEN` env var | Platform ops: provisioning, monitoring, debugging |
| **Team** | Generated via `POST /admin/teams` | Application credential: what the team's services use |
| **User (OIDC)** | Realm JWT (`REALM_JWT_ISSUER` / `REALM_JWT_AUDIENCE`) | End-user identity for identity-scoped capability brokering; verifier-gated and fail-closed (a JWT is rejected unless the realm verifier is configured) |

See [`docs/auth.md`](docs/auth.md) for the full three-tier model and the capability-broker flow.

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
| `POST` | `/dags/:id/run` | Execute a DAG (synchronous `200`, or `202` queued when the DAG suspends at a human-review gate) |
| `POST` | `/<custom-route>` | Execute via custom route override |

### Human-in-the-Loop (HITL)

A DAG that reaches a `humanReview` gate suspends and the run is durably parked. Approvers drive it forward over HTTP, or in Microsoft Teams (see [`docs/hitl-teams.md`](docs/hitl-teams.md)).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/runs/:runId` | Poll a suspended/terminal run's status |
| `POST` | `/runs/:runId/approve` | Resolve a pending review (approve / reject / approve-with-edit / reroute) |
| `POST` | `/teams/messages` | Bot Framework messaging endpoint for in-Teams approvals |

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

**Suspended at a human-review gate (202):**
```json
{ "runId": "f644de42-2085-44cf-880d-e9efd659c590", "status": "queued" }
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
| 429 | `llm-budget-exceeded` | The host per-call meter refused an LLM call against the DAG's `llmBudget` |
| 429 | `fan-budget-refused` | A map fan's whole-fan projection refused: its remaining children cannot fit the `llmBudget`. Redeploy with a larger budget ([details](#whole-fan-budget-projection)) |
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
maxConcurrent: 5            # concurrent RUNS of this DAG (run-level; not map-fan children)
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
3. If `bun.lock` changed → `bun install --frozen-lockfile`
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

## Contributor verification

From the repository root, use the canonical fail-closed gate:

```bash
bun install --frozen-lockfile
bun run verify
```

It delegates to all 12 workspace scripts, including the host package's intentionally ordered test script and the framework's separate CLI compiler tier. It also verifies the root scripts and shipped-doc links.

For focused host iteration only:

```bash
(cd packages/host && bun run typecheck)
(cd packages/host && bun run test)
```

Focused package commands are not repository parity evidence and Redis-gated suites can skip without `REDIS_URL`. Full verification requires exact Bun 1.4.2, a local `redis-server` binary, and an authorized, ACL-capable disposable Redis test server that the caller starts and stops. Server authentication is optional policy; the canonical guide and CI deliberately prove password authentication. The integration suites write fixtures and ACL users, so never use production or shared Redis. See [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) for the complete setup and the separate production-image Oracle control.

---

## Further Documentation

| Document | Contents |
|----------|----------|
| [`docs/auth.md`](docs/auth.md) | Full auth guide: token anatomy, three-tier security model, rotation, operational runbook |
| [`docs/writing-dags.md`](docs/writing-dags.md) | DAG authoring: directory convention, contract, prompts, per-DAG config |
| [`docs/deployment.md`](docs/deployment.md) | OpenShift deployment: container, Redis, secrets, monitoring, scaling |
| [`docs/hitl-teams.md`](docs/hitl-teams.md) | Human-in-the-loop approvals in Microsoft Teams: webhook + Bot Framework transports |
