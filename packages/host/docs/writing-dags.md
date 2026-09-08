# Writing DAGs for the Fugue Host

This guide explains how to create a DAG that the Fugue Host will discover, validate, and serve via HTTP.

> **Quick reference:** For a copy-paste-ready skeleton and all node factory signatures,
> see [`docs/llm-dag-authoring.md`](../../framework/docs/llm-dag-authoring.md).

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
import type { DagRegistration } from "@fuguejs/host/contract";
import { defineDag, createLlmNode, createFetchNode, DAG_INPUT } from "@fuguejs/framework";

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
    { from: DAG_INPUT, to: "fetch-data" },   // feed the request into the root
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

### Feeding the request in (`DAG_INPUT` edges and source nodes)

As of 0.2.0 no node implicitly receives the DAG input. Every non-source entry
node must receive the request over an explicit `{ from: DAG_INPUT, to: <node> }`
edge (`DAG_INPUT` is the reserved `"$input"` source, imported from
`@fuguejs/framework`); a root with no such edge fails validation with
`root-expects-input`. A root that consumes no request at all is a *source* —
build it with `createSourceNode` (it sets `isSource`) instead of wiring a
`DAG_INPUT` edge.

```typescript
edges: [{ from: DAG_INPUT, to: "fetch-data" }, /* ... */]
```

See [`docs/llm-dag-authoring.md`](../../framework/docs/llm-dag-authoring.md) for
the canonical authoring guide.

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

## Mapped execution and durable addresses

Author maps with the framework's
[`createMapNode`](../../framework/docs/llm-dag-authoring.md#createmapnode--runtime-width-fan-out).
A child uses the root host-selected origin, broker and LLM meter, with its own
NodeId and structural DagId. It shares the root RunId, signal, clients, spend
authority and host cache/prompt closures. **Child DagId is structural identity,
not permission to select a new host resource namespace.** Child requirements
are checked before predecessor work, even for zero width, then minted for each
actual child invocation; the map itself requests only `checkpointer`. Describe/
manifest capabilities use the same bounded outer/direct-child runtime inventory's
sorted, deduplicated union, without expanding topology or widening map `requires`.

The host has two distinct checkpoint record spaces. Let
`P = fugue:<tenant>:<rootDag>:<run>:`; all entries below retain that root prefix.

| Record | Redis address | Meaning |
|---|---|---|
| Root node output | `P<nodeId>` (STRING) | Canonical write-only output; unchanged bytes. |
| Mapped child node output | `P<mapNodeId>@<childNodeId>@<index>@<executionEpoch>` (STRING) | Actual child writer output; sibling maps, indices and generations are distinct. |
| Fan completions | `P$nodes` (HASH), field `dag@<mapNodeId>@<index>@<executionEpoch>` | Readable `Checkpointer` state used to resume a partial fan. |
| Fan checkpoint metadata | `P$meta` (STRING) | Run-bound Checkpointer metadata, separate from output records. |
| Run spend | `P$spend` (HASH) | Shared run spend ledger, not a node checkpoint. |

`CheckpointWriter` is a framework write-only port:
`write(runId, nodeId, value, scope?: MappedChildScope): Promise<void>`, where
`MappedChildScope` is readonly `{ mapNodeId: NodeId; index: MapIndex;
executionEpoch: FreshnessExecutionEpoch }`. The runtime supplies a frozen scope
on actual child writes and no scope on root writes. `buildCheckpointKey` uses
`compositeNodeKey(realChildNodeId, { namespace: mapNodeId, index,
attempt: executionEpoch })`; it does not forge a NodeId or add an index-only
suffix. `@` is outside the NodeId grammar, and reserved `$meta`/`$nodes`/`$spend`
remain disjoint. This scope is address data, not new host authority.
The host writer rejects a requested runId differing from its closure-bound run
before scope/value observation, key encoding, serialization, diagnostics or any
Redis/checkpoint-spend effect. Its `Promise<void>` rejects with
`checkpoint writer is scoped to run <boundRun> and was asked for <askedRun>`.
Matching-run root/mapped writes retain the keys above and existing TTL/retention;
this guard does not make the addressable port an unforgeable capability.

Fan lookup/save use the current persisted **parent `freshnessExecutionEpoch`**
as `attempt`, not a retry count. Same-generation retry/replacement reuses
acknowledged indices. Backward reroute advances the epoch before replacement
work, including same-valued inputs and reroutes directly to the fan. The host
writer is not read for resume; the separate readable Checkpointer is wired only
when Redis hash operations are available. External effects without acknowledged
fan completion may repeat after a crash; this is not an exactly-once effect claim.

**Corrupt state is not a missing index.** The mapped fan rejects every nonempty
loaded `corruptNodeAddresses` before replay/gather, metadata seeding, child work,
saves or reduction, including zero width, unrelated/old-epoch keys and opaque
digest filenames. File/Redis adapters still warn/drop corrupt records and report
both address ADT variants; the stricter fan returns attributable `checkpoint-corrupt`.
Public `runDag` preserves it as `retry-exhausted` with
`rootErrorKind: checkpoint-corrupt` and the serialized original error in `lastError`
(default zero retries: one attempt). Repeated loads cannot bypass this refusal.
There is **no automatic destructive cleanup**. Inspect and repair the underlying
storage, then rerun, accounting for effects already acknowledged; deleting corrupt
work is not a safe recovery shortcut. Healthy prefixes are reused and genuinely
missing indices execute normally.

Host response-cache keys remain `fugue:<tenant>:<rootDag>:cache:<key>`; mapping
does not add an index/epoch to that independent cache policy. Existing checkpoint
TTL and spend-retention commit policy remain in force. Child jobs are private
and local, never the root durable JobLike. Children do not begin/end an observer
root lifecycle or inherit root background ownership; child judges finish before
completion acknowledgement. Nested maps, child human review and child freshness
extractors are refused against the immutable execution snapshot. Gather, then
review at root level. No recursive child fingerprint, indexed broker audit schema
or root child-quality-summary aggregation is promised.

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
3. If `bun.lock` changed → `bun install --frozen-lockfile`
4. Discover and load all DAGs
5. Atomically swap the registry (immutable snapshot)
6. Force-reset all circuit breakers

**Error isolation:** A broken DAG file doesn't affect other DAGs. The host logs the error and continues serving the healthy ones.
