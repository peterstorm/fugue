# Writing DAGs for the Fugue Host

This guide explains how to create a DAG that the Fugue Host will discover, validate, and serve via HTTP.

> **Quick reference:** For a copy-paste-ready skeleton and all node factory signatures,
> see [`docs/llm-dag-authoring.md`](../../../docs/llm-dag-authoring.md).

## Directory Convention

The host discovers DAGs using the glob pattern `dags/{team}/{dag-name}/dag.ts`:

```
your-dags-repo/
├── dags/
│   ├── cx/                          # team name
│   │   ├── customer-summary/        # DAG name
│   │   │   ├── dag.ts               # ← DagRegistration default export
│   │   │   ├── prompts/             # optional prompt templates
│   │   │   │   ├── synthesis.txt
│   │   │   │   └── registry.json
│   │   │   └── fugue.yaml           # optional deployment config (see Per-DAG Config)
│   │   └── intent-classifier/
│   │       └── dag.ts
│   └── billing/
│       └── invoice-processor/
│           └── dag.ts
├── package.json                     # shared deps for all DAGs
└── bun.lock
```

**Key rules:**
- `dag.ts` must have a **default export** conforming to `DagRegistration`
- The **team** is the `team` field of a sibling `fugue.yaml` if present, else extracted from the path: `dags/{team}/...`
- DAG ID comes from the `dag.id` field in the registration
- DAG ID must match `[A-Za-z0-9_-]{1,128}` (no colons)

## The DagRegistration Contract

```typescript
// dag.ts
import { z } from "zod";
import type { DagRegistration } from "@fugue/host/contract";
import { defineDag, createLlmNode, createFetchNode } from "@fugue/framework";

// 1. Define your input schema
const InputSchema = z.object({
  customerId: z.string().min(1),
});

// 2. Build your DAG
const dag = defineDag({
  id: "customer-summary",
  nodes: {
    "fetch-data": createFetchNode({ /* ... */ }),
    "synthesize": createLlmNode({ /* ... */ }),
  },
  edges: [
    { from: "fetch-data", to: "synthesize" },
  ],
  outputNodeId: "synthesize",
});

// 3. Export the registration
const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
  route: "/summarize",          // optional: custom route (default: DAG ID)
  config: {
    timeoutMs: 90_000,          // optional: override host default (clamped to MAX_DAG_TIMEOUT_MS)
    maxConcurrent: 5,           // optional: override host default
    cacheTtlMs: 600_000,        // optional: per-DAG cache TTL (else DEFAULT_CACHE_TTL_MS)
    checkpointTtlMs: 86_400_000,// optional: per-DAG checkpoint TTL (else DEFAULT_CHECKPOINT_TTL_MS)
    circuitBreaker: {           // optional: per-DAG circuit-breaker override
      failureThreshold: 3,      //   else CIRCUIT_BREAKER_THRESHOLD
      resetTimeoutMs: 15_000,   //   cooldown before a half-open probe (else 30s)
    },
  },
  meta: {
    description: "Summarizes customer data using LLM",
    version: "1.0.0",
  },
};

export default registration;
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `dag` | `DagDef` | The DAG definition (from `defineDag()`) |
| `inputSchema` | `z.ZodType` | Zod schema for request body validation |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `route` | `string` | DAG ID | Custom route path |
| `config.timeoutMs` | `number` | `DEFAULT_DAG_TIMEOUT_MS` | Per-DAG timeout (clamped to `MAX_DAG_TIMEOUT_MS`) |
| `config.maxConcurrent` | `number` | `DEFAULT_DAG_CONCURRENCY` | Per-DAG concurrency limit (enforced per FR-051) |
| `config.cacheTtlMs` | `number` | `DEFAULT_CACHE_TTL_MS` | Per-DAG cache entry TTL |
| `config.checkpointTtlMs` | `number` | `DEFAULT_CHECKPOINT_TTL_MS` | Per-DAG checkpoint entry TTL |
| `config.circuitBreaker.failureThreshold` | `number` | `CIRCUIT_BREAKER_THRESHOLD` | Failures before the DAG's circuit opens |
| `config.circuitBreaker.resetTimeoutMs` | `number` | `30_000` | Cooldown before a half-open probe |
| `meta.description` | `string` | `""` | Human-readable description |
| `meta.version` | `string` | `"0.0.0"` | Semver version |

## Prompt Templates

If your DAG uses `createLlmNode` with `promptName`, place prompt files in a `prompts/` directory alongside `dag.ts`:

```
customer-summary/
├── dag.ts
└── prompts/
    ├── synthesis.txt           # template with {{placeholders}}
    ├── synthesis-system.txt    # system prompt (optional)
    └── registry.json           # version tracking (optional)
```

The host pre-loads all `.txt` files at DAG discovery time and provides them via `ctx.prompts.get("name")`.

**Template syntax:**
```
Customer: {{customerName}} ({{customerId}})
Account Type: {{accountType}}

Recent Conversations ({{conversationCount}} total):
{{conversations}}

Produce a structured summary.
```

## Per-DAG Config

There are two places to set per-DAG config:

1. **`config` in the exported `DagRegistration`** (in `dag.ts`) — the DAG author's defaults,
   versioned with the code. See [Optional Fields](#optional-fields) above.
2. **A sibling `fugue.yaml`** — deployment/ops config, managed alongside the DAG.

```yaml
# dags/cx/customer-summary/fugue.yaml
team: cx                  # overrides the path-derived team
owner: platform           # surfaced in GET /dags
route: /summarize         # overrides dag.ts route
maxConcurrent: 5
timeoutMs: 90000
cacheTtlMs: 600000
checkpointTtlMs: 86400000
env:                      # fail-closed: the host refuses to load this DAG
  - OPENAI_API_KEY        #   unless every listed env var is set
```

**Precedence:** `fugue.yaml` **wins** over the `dag.ts` `config` for any field it sets
(it's the operational layer); fields it omits fall back to `dag.ts` config, then host defaults.
`team` from `fugue.yaml` overrides the path-derived team; `circuitBreaker` can only be set in
`dag.ts` `config` (not `fugue.yaml`). A malformed or schema-invalid `fugue.yaml` fails that DAG's
load in isolation (other DAGs are unaffected).

## Input Validation

The `inputSchema` is validated at request time. Invalid requests get a `400` response:

```json
{
  "ok": false,
  "error": "input-validation-failed",
  "message": "input validation failed for DAG 'customer-summary': 1 issue(s)",
  "details": {
    "issues": [{ "path": ["customerId"], "message": "Required" }]
  }
}
```

## Calling Your DAG

Once the host loads your DAG:

```bash
curl -X POST http://host:3000/dags/customer-summary/run \
  -H "Authorization: Bearer fug_your-team-token" \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust-001"}'
```

Response:
```json
{
  "ok": true,
  "data": { /* output from your outputNodeId */ },
  "runId": "f644de42-2085-44cf-880d-e9efd659c590",
  "durationMs": 62248
}
```

## Discovering DAGs

Two read-only endpoints surface what's loaded — useful for clients (and AI
authoring tools) that want to compose against existing DAGs:

### `GET /dags`

Returns the list of registered DAGs visible to the caller's team token
(admin tokens see all). One line per DAG with `id`, `route`, `description`,
`version`, `healthy`.

```bash
curl http://host:3000/dags \
  -H "Authorization: Bearer fug_your-team-token"
```

### `GET /dags/:id/manifest`

Returns a structured summary of a single DAG: input/output JSON Schemas,
wave plan, prompts referenced, capabilities required, nodes, edges. Same
team-isolation rules as `POST /dags/:id/run` — a team token can only
manifest its own DAGs.

```bash
curl http://host:3000/dags/customer-summary/manifest \
  -H "Authorization: Bearer fug_your-team-token"
```

Response shape:

```json
{
  "id": "customer-summary",
  "route": "/dags/customer-summary/run",
  "description": "Summarizes customer data using LLM",
  "version": "1.0.0",
  "team": "cx",
  "healthy": true,
  "sha": "a1b2c3d...",
  "loadedAt": 1716700000000,
  "inputSchema": { "type": "object", "properties": { "customerId": {...} } },
  "outputSchema": { "type": "object", "properties": { "summary": {...} } },
  "outputNodeId": "synthesize",
  "nodes": [
    { "id": "fetch-data", "kind": "fetch", "sideEffects": "reads",
      "requires": ["cache"], "humanReview": false },
    { "id": "synthesize", "kind": "llm", "sideEffects": "external-call",
      "requires": ["llm","prompts","cache"], "humanReview": false }
  ],
  "edges": [{ "from": "fetch-data", "to": "synthesize", "kind": "unconditional" }],
  "waves": [["fetch-data"], ["synthesize"]],
  "prompts": ["synthesis"],
  "capabilities": ["cache", "llm", "prompts"]
}
```

This is the contract for cross-DAG composition tooling: read a manifest,
generate a typed client, compose it into a new DAG.

## Error Responses

All errors are structured JSON:

| Status | Error Kind | When |
|--------|-----------|------|
| 400 | `input-validation-failed` | Request body fails schema validation |
| 400 | `body-parse-failed` | Request body isn't valid JSON |
| 401 | `unauthorized` | Missing or invalid token |
| 403 | `forbidden` | Token can't access this DAG's team |
| 404 | `dag-not-found` | DAG ID doesn't exist |
| 408 | `timeout` | Execution exceeded timeout |
| 429 | `dag-concurrency-exceeded` | Per-DAG concurrency limit hit |
| 429 | `global-concurrency-exceeded` | Global concurrency limit hit |
| 503 | `dag-disabled` | Circuit breaker is open |

## Circuit Breaker

Each DAG has an automatic circuit breaker:
- **Closed** → normal operation
- **Open** → after `CIRCUIT_BREAKER_THRESHOLD` failures within `CIRCUIT_BREAKER_WINDOW_MS`
- **Half-open** → after 30s cooldown, allows one test request
- **Force-reset** → when a new git commit is synced, all circuits reset

## Hot Reload

The host polls git every `DAGS_POLL_INTERVAL_MS`:
1. `git pull --ff-only`
2. Compare SHA — skip if unchanged
3. If `bun.lockb` changed → `bun install --frozen-lockfile`
4. Discover and load all DAGs
5. Atomically swap the registry (immutable snapshot)
6. Force-reset all circuit breakers

**Error isolation:** A broken DAG file doesn't affect other DAGs. The host logs the error and continues serving the healthy ones.
