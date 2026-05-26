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

## `defineDag` — the only DAG constructor

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

### Linear pipeline (A → B → C)

```ts
// Option 1: explicit edges
const dag = defineDag({
  id: "pipeline",
  nodes: { "step-a": nodeA, "step-b": nodeB, "step-c": nodeC },
  edges: [
    { from: "step-a", to: "step-b" },
    { from: "step-b", to: "step-c" },
  ],
  outputNodeId: "step-c",
});

// Option 2: defineLinearDag (edges inferred from array order)
import { defineLinearDag } from "@fugue/framework";

const dag = defineLinearDag({
  id: "pipeline",
  nodes: [nodeA, nodeB, nodeC],
  // edges: automatically [A→B, B→C], outputNodeId: nodeC
});
```

### Fan-out (parallel fetch)

```ts
const dag = defineDag({
  id: "fan-out",
  nodes: {
    "fetch-crm": fetchCrm,
    "fetch-billing": fetchBilling,
    "merge": mergeNode,
  },
  edges: [
    { from: "fetch-crm", to: "merge" },
    { from: "fetch-billing", to: "merge" },
  ],
  outputNodeId: "merge",
});
// fetch-crm and fetch-billing run in parallel (same wave)
// merge receives { "fetch-crm": ..., "fetch-billing": ... } as input
```

### Diamond (fan-out + fan-in)

```ts
const dag = defineDag({
  id: "diamond",
  nodes: {
    "source": sourceNode,
    "branch-a": branchA,
    "branch-b": branchB,
    "join": joinNode,
  },
  edges: [
    { from: "source", to: "branch-a" },
    { from: "source", to: "branch-b" },
    { from: "branch-a", to: "join" },
    { from: "branch-b", to: "join" },
  ],
  outputNodeId: "join",
});
```

### Conditional routing

```ts
const dag = defineDag({
  id: "router",
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
