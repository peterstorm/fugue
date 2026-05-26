# DAG Authoring Reference (LLM-Optimized)

Minimal, copy-paste-ready reference for generating Fugue DAGs.
For deep dives: `library-ux.md`, `dag-type-system.md`, `packages/host/docs/writing-dags.md`.

---

## Minimal Complete Example

```ts
// dags/my-team/my-dag/dag.ts
import { z } from "zod";
import type { DagRegistration } from "@fugue/host/contract";
import { defineDag, createFetchNode, createLlmNode, createTransformNode, ok } from "@fugue/framework";
import type { Result, FrameworkError } from "@fugue/framework";

// --- Schemas ---
const InputSchema = z.object({ userId: z.string() });

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

const SummarySchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
});

// --- Nodes ---
const fetchUser = createFetchNode({
  id: "fetch-user",
  inputSchema: InputSchema,
  outputSchema: UserSchema,
  fetch: async (input, _ctx): Promise<Result<z.infer<typeof UserSchema>, FrameworkError>> => {
    // Replace with real data source
    return ok({ id: input.userId, name: "Alice", email: "alice@example.com" });
  },
});

const summarize = createLlmNode({
  id: "summarize",
  inputSchema: UserSchema,
  outputSchema: SummarySchema,
  promptName: "user-summary",
  model: "claude-sonnet-4-20250514",
  buildInput: (input) => ({
    userName: input.name,
    userEmail: input.email,
  }),
});

// --- DAG ---
const dag = defineDag({
  id: "user-summary",
  nodes: {
    "fetch-user": fetchUser,
    "summarize": summarize,
  },
  edges: [
    { from: "fetch-user", to: "summarize" },
  ],
  outputNodeId: "summarize",
});

// --- Registration ---
const registration: DagRegistration = {
  dag,
  inputSchema: InputSchema,
};

export default registration;
```

---

## Node Factories (4 types)

### `createFetchNode` — external data retrieval

```ts
createFetchNode<I, O>({
  id: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
  fetch: (input: I, ctx: NodeContext) => Promise<Result<O, FrameworkError>>,
  sideEffects?: SideEffectProfile,  // default: { kind: "reads", resource: id }
})
```

### `createTransformNode` — pure data transformation (no I/O)

```ts
createTransformNode<I, O>({
  id: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
  transform: (input: I) => Result<O, FrameworkError>,  // synchronous, pure
})
```

### `createLlmNode` — structured LLM call with prompt template

```ts
createLlmNode<I, O>({
  id: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
  promptName: string,              // loads template from ctx.prompts
  model: string,                   // e.g. "claude-sonnet-4-20250514", "gpt-4o"
  buildInput: (input: I) => Record<string, unknown>,  // fills {{placeholders}}
  system?: string,                 // override system prompt
  thinking?: { type: "enabled"; budgetTokens: number },
  skipWhen?: (input: I) => boolean,  // must pair with skipDefault
  skipDefault?: O,
  computeCacheKey?: (input: I) => string,
})
```

### `createLlmWithToolsNode` — LLM with tool-use loop

```ts
createLlmWithToolsNode<I, O>({
  id: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
  model: string,
  tools: readonly ToolDef<unknown, unknown>[],
  buildUser: (input: I) => string,       // user message builder
  system?: string,
  promptName?: string,                   // optional registry lookup
  toolChoice?: "auto" | "required" | { name: string },
  maxIterations?: number,                // default: 10
  thinking?: { type: "enabled"; budgetTokens: number },
  skipWhen?: (input: I) => boolean,
  skipDefault?: O,
})
```

### `createGuardrailNode` — pure validation (never blocks pipeline)

```ts
createGuardrailNode<I, T>({
  id: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<GuardrailResult<T>>,
  validate: (input: I) => GuardrailResult<T>,  // pure, no I/O
})
```

---

## DAG constructors

Four constructors, in order of preference. Each delegates to the same
module-load validator and produces the same branded `DagDef`.

| Constructor | Use when |
|---|---|
| `defineLinearDag` | Sequential pipeline A→B→C. Edges inferred from array order. |
| `defineFanOut` | One source, N parallel branches, optional join. |
| `defineDiamond` | One source, N parallel branches, **required** join. |
| `defineRouter` | Classifier with predicate-driven cases plus a **required** default. |
| `defineDag` | Anything else — fallback when no shape helper fits. |

Examples for each are in "Common Patterns" below.

### `defineDag` — the manual fallback

```ts
defineDag({
  id: string,                    // must match [A-Za-z0-9_-]{1,128}
  nodes: {                       // record keyed by node id
    [nodeId]: NodeDef,           // key MUST match node.id
  },
  edges: [                       // array of edge objects
    { from: "nodeA", to: "nodeB" },                           // unconditional
    { from: "nodeA", to: "nodeC", when: predicate },          // conditional
    { from: "nodeA", to: "nodeD", kind: "default" },          // else/fallback
  ],
  outputNodeId?: string,         // which node's output is the DAG result
  evalJudges?: EvalJudgeNodeDef[],
  defaultRetryLimit?: number,    // 0 = no retry (default)
  retryLimits?: { [nodeId]: number },
})
```

### Edge rules

- `from`/`to` must reference keys in `nodes` — TypeScript catches typos at edit time
- Simple DAGs only need `{ from, to }` (unconditional)
- Conditional edges need a `when: Predicate<T>` object
- If any conditional edges leave a node, a `kind: "default"` edge is required (else-totality)
- `outputNodeId` must be reachable via *unconditional or default* edges only —
  a conditional-only branch is never a valid explicit output (use a join node
  downstream of all branches instead, or omit `outputNodeId` for
  last-active-node fallback)

### Predicate shape (for conditional edges)

```ts
{
  label: string,                           // human-readable, for observability
  version: number,                         // bump when logic changes
  check: (value: T, confidence) => boolean,
  minConfidence?: ConfidenceBucket,        // optional short-circuit
}
```

---

## DagRegistration (for host deployment)

```ts
const registration: DagRegistration = {
  dag: DagDef,                             // from defineDag()
  inputSchema: z.ZodType<unknown>,         // validates HTTP request body

  // Everything below is optional:
  route?: string,                          // default: `/dags/${dag.id}/run`
  config?: {
    timeoutMs?: number,                    // default: 30_000
    maxConcurrent?: number,                // default: 10
  },
  meta?: {
    description?: string,
    version?: string,                      // semver
  },
};

export default registration;
```

---

## Common Patterns

> **Prefer shape helpers over manual `defineDag` whenever a pattern matches.**
> The helpers enforce the shape at the type level (e.g. `defineRouter` makes
> the `default` branch *required*, eliminating else-totality errors), and
> they delegate to `defineDag`'s validator so all checks still run.
>
> Use raw `defineDag` only when no helper matches your topology.

### Linear pipeline (A → B → C) — `defineLinearDag`

```ts
import { defineLinearDag } from "@fugue/framework";

const dag = defineLinearDag({
  id: "pipeline",
  nodes: [nodeA, nodeB, nodeC],
  // Edges inferred: A→B→C. outputNodeId: nodeC.
});
```

### Fan-out (parallel siblings) — `defineFanOut`

```ts
import { defineFanOut } from "@fugue/framework";

// One source → N parallel branches → optional join
const dag = defineFanOut({
  id: "enrich-customer",
  source: triggerNode,
  branches: [fetchCrm, fetchBilling, fetchSupport],
  join: mergeNode,   // optional — omit to leave branches unjoined
});
// With join: edges source→{crm,billing,support}, then {crm,billing,support}→merge.
//            outputNodeId: merge. merge receives a fan-in object keyed by
//            each branch's id (see "Input Wiring Rules" below).
// Without join: outputNodeId is the last branch in the array.
```

### Diamond (fan-out + fan-in) — `defineDiamond`

```ts
import { defineDiamond } from "@fugue/framework";

const dag = defineDiamond({
  id: "diamond",
  source: sourceNode,
  branches: [branchA, branchB],
  join: joinNode,           // required (vs optional in defineFanOut)
});
// outputNodeId: joinNode. join receives { "branch-a": ..., "branch-b": ... }.
```

### Conditional routing — `defineRouter`

```ts
import { defineRouter } from "@fugue/framework";

const dag = defineRouter({
  id: "intent-router",
  classifier: classifyIntent,
  cases: {
    "simple-category": {
      when: (out) => (out as { category: string }).category === "simple",
      to: simpleHandler,
    },
    "complex-category": {
      // Advanced form: provide a full Predicate when you need explicit
      // version, label, or `minConfidence` control.
      whenPredicate: {
        label: "complex-route",
        version: 2,
        check: (out) => (out as { category: string }).category === "complex",
        minConfidence: "medium",
      },
      to: complexHandler,
    },
  },
  default: fallbackHandler,   // REQUIRED — eliminates else-totality errors
  // outputNodeId is optional. If set, it must be the default branch or a
  // descendant — conditional-only branches are unreachable via the
  // unconditional/default edge graph used for output reachability.
});
```

### Conditional routing — manual `defineDag` form

When `defineRouter` is too restrictive (e.g. routes that fan out to multiple
targets, or non-classifier-shaped topologies), drop down to `defineDag`:

```ts
const dag = defineDag({
  id: "router-manual",
  nodes: {
    "classify": classifier,
    "handle-simple": simpleHandler,
    "handle-complex": complexHandler,
  },
  edges: [
    {
      from: "classify",
      to: "handle-simple",
      when: {
        label: "simple-category",
        version: 1,
        check: (output) => output.category === "simple",
      },
    },
    { from: "classify", to: "handle-complex", kind: "default" },
  ],
  outputNodeId: "handle-complex",  // or omit for last-active-node
});
```

### With guardrail

```ts
const dag = defineDag({
  id: "guarded",
  nodes: {
    "fetch": fetchNode,
    "synthesize": llmNode,
    "check-facts": guardrailNode,   // validates synthesize output
    "assemble": assembleNode,
  },
  edges: [
    { from: "fetch", to: "synthesize" },
    { from: "synthesize", to: "check-facts" },
    { from: "fetch", to: "check-facts" },          // guardrail gets source data too
    { from: "check-facts", to: "assemble" },
    { from: "synthesize", to: "assemble" },         // assemble gets both
  ],
  outputNodeId: "assemble",
});
```

### With retries and human review

```ts
const dag = defineDag({
  id: "durable",
  nodes: {
    "fetch": fetchNode,
    "process": createTransformNode({
      id: "process",
      inputSchema: FetchOutputSchema,
      outputSchema: ProcessedSchema,
      transform: (input) => ok(processData(input)),
    }),
    "review": createTransformNode({
      id: "review",
      inputSchema: ProcessedSchema,
      outputSchema: ProcessedSchema,
      transform: (input) => ok(input),
      humanReview: { prompt: "Please review the processed data" },  // pauses here
    }),
  },
  edges: [
    { from: "fetch", to: "process" },
    { from: "process", to: "review" },
  ],
  outputNodeId: "review",
  defaultRetryLimit: 3,
  retryLimits: { "fetch": 5 },   // fetch gets more retries
});
```

---

## Input Wiring Rules

How a node receives its input depends on incoming edges:

| Incoming edges | Node receives as input |
|---|---|
| 0 edges (root node) | The DAG's initial input (validated by `inputSchema`) |
| 1 edge | The upstream node's output directly |
| 2+ edges | Object keyed by source node id: `{ "node-a": outputA, "node-b": outputB }` |

Design your node's `inputSchema` accordingly.

---

## Prompt Templates

Place `.txt` files alongside `dag.ts` in a `prompts/` directory:

```
prompts/user-summary.txt
```

Template syntax: `{{placeholder}}` — replaced by keys from `buildInput()`.

```
User: {{userName}} ({{userEmail}})

Generate a summary with key points.
```

Loaded by the host at discovery time. Accessed via `promptName` in `createLlmNode`.

---

## Result Type

All node functions return `Result<T, FrameworkError>`:

```ts
import { ok, err } from "@fugue/framework";
import type { Result, FrameworkError } from "@fugue/framework";

// Success
return ok(value);

// Failure
return err({ kind: "transient", message: "API timeout" });
return err({ kind: "validation", message: "Invalid response shape" });
return err({ kind: "permanent", message: "Customer not found" });
```

---

## Checklist for a Valid DAG

- [ ] Every node key in `nodes` matches that node's `id`
- [ ] Every `edges[].from` and `edges[].to` references a key in `nodes`
- [ ] No duplicate edges (same `from`+`to` pair)
- [ ] Output node is reachable via unconditional/default edges from roots
- [ ] If conditional edges leave a node, a `kind: "default"` edge exists (else-totality)
- [ ] `inputSchema` of downstream nodes matches what upstream produces
- [ ] Root nodes' `inputSchema` matches the DAG-level `inputSchema`
- [ ] `export default` a `DagRegistration` object

All structural rules are validated at module load by `defineDag()` — invalid
DAGs throw `DagDefinitionError` immediately, with a message pointing at the problem.

---

## Verifying with the `fugue` CLI

The `fugue` binary (`packages/framework/bin/fugue.ts`) validates and
introspects a DAG file without needing to start the host. **All output is JSON
on stdout**, designed for machine consumption.

### `fugue lint <path>`

Imports a `dag.ts`, runs `defineDag()`'s validator, and prints a structured
diagnostic. Exits `0` on success, `1` on failure, `2` on bad CLI usage.

```bash
$ bunx fugue lint dags/cx/customer-summary/dag.ts
{
  "ok": true,
  "path": "/abs/path/to/dag.ts"
}
```

Failure example (edge endpoint typo):

```bash
$ bunx fugue lint dags/cx/broken/dag.ts
{
  "ok": false,
  "path": "/abs/path/to/dag.ts",
  "errors": [
    {
      "kind": "dag-definition-error",
      "dagId": "broken",
      "message": "[defineDag] DAG 'broken' is unsound: edge endpoint 'c' is not a node...",
      "detail": { "kind": "edge-endpoint-missing", "...": "..." }
    }
  ]
}
```

Possible `errors[].kind` values:

| Kind | Meaning |
|---|---|
| `import-failed` | The module failed to import (syntax error, missing dep, etc.). |
| `no-default-export` | The module compiled but has no default export. |
| `missing-dag-field` | Default export exists but doesn't have a `.dag` field. |
| `dag-definition-error` | `defineDag()` rejected the DAG. The typed `FrameworkError` is on `errors[].detail`. |

### `fugue describe <path>`

Prints a structured summary of a valid DAG: input/output JSON Schemas, wave
plan, prompts referenced, capabilities required. Exits 0/1/2 like `lint`.

```bash
$ bunx fugue describe dags/cx/customer-summary/dag.ts
{
  "ok": true,
  "path": "/abs/path/to/dag.ts",
  "dag": {
    "id": "customer-summary",
    "route": "/dags/customer-summary/run",
    "description": "...",
    "version": "1.0.0",
    "inputSchema": { "type": "object", "properties": { ... } },
    "outputSchema": { "type": "object", "properties": { ... } },
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
    "capabilities": ["cache","llm","prompts"]
  }
}
```

On lint failure, `describe` returns the same `errors[]` array as `lint`.

### Typical LLM authoring loop

1. Generate `dag.ts` from a template.
2. Run `bunx fugue lint dag.ts`. If `ok: false`, switch on `errors[0].kind`
   and `errors[0].detail.kind` to decide what to fix.
3. Once lint is green, run `bunx fugue describe dag.ts` to confirm the input
   schema, wave plan, and prompts match the intent.

---

## Discovering existing DAGs

When composing a *new* DAG against DAGs that are already deployed, you don't
need to read their source — the host exposes machine-readable endpoints.

### `GET /dags` — list

```bash
curl http://host:3000/dags \
  -H "Authorization: Bearer fug_team-token"
```

Returns `{ dags: [{ id, route, description, version, healthy }], count }`.
A team token sees only DAGs belonging to its team; admin sees all.

### `GET /dags/:id/manifest` — full schema

```bash
curl http://host:3000/dags/customer-summary/manifest \
  -H "Authorization: Bearer fug_team-token"
```

Returns the same JSON shape `fugue describe` emits (without the `path`
wrapper) plus team metadata:

```jsonc
{
  "id": "customer-summary",
  "route": "/dags/customer-summary/run",
  "team": "cx",
  "healthy": true,
  "sha": "a1b2c3d...",
  "loadedAt": 1716700000000,
  "inputSchema": { /* JSON Schema for the request body */ },
  "outputSchema": { /* JSON Schema for the response data */ },
  "nodes": [ ... ],
  "edges": [ ... ],
  "waves": [ ... ],
  "prompts": [ ... ],
  "capabilities": [ ... ]
}
```

Auth: same team-isolation rules as `POST /dags/:id/run`. Schemas can leak
PII field names and internal model identifiers, so a team token cannot
manifest another team's DAG.

### When to use which

| Goal | Use |
|---|---|
| Local file (pre-deploy) | `fugue describe path/to/dag.ts` |
| Deployed DAG (live host) | `GET /dags/:id/manifest` |
| Just enumerate what's live | `GET /dags` |
