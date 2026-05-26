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
│   │   │   └── fugue.yaml           # optional per-DAG config
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
- The **team** is extracted from the path: `dags/{team}/...`
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
    timeoutMs: 90_000,          // optional: override host default
    maxConcurrent: 5,           // optional: override host default
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
| `config.timeoutMs` | `number` | `DEFAULT_DAG_TIMEOUT_MS` | Per-DAG timeout |
| `config.maxConcurrent` | `number` | `DEFAULT_DAG_CONCURRENCY` | Per-DAG concurrency limit |
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

## Per-DAG Config (fugue.yaml)

Optional — place alongside `dag.ts`:

```yaml
team: cx
owner: platform-team
route: /summarize
maxConcurrent: 5
timeoutMs: 90000
cacheTtlMs: 600000
checkpointTtlMs: 86400000
```

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
