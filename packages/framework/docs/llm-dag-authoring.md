# DAG Authoring Reference (LLM-Optimized)

Minimal, copy-paste-ready reference for generating Fugue DAGs. This file ships
inside `@fuguejs/framework`; the relative links below resolve both in the
monorepo and under `node_modules/@fuguejs/` (the packages are siblings either way).

- Type-system deep dive: [`dag-type-system.md`](./dag-type-system.md).
- The `DagRegistration` + `fugue.yaml` + discovery contract: [`writing-dags.md`](../../host/docs/writing-dags.md) (ships in `@fuguejs/host`).
- Reading files (Excel/CSV from disk, SharePoint, OneDrive): [`llm-document-source.md`](../../document-source/docs/llm-document-source.md) (ships in `@fuguejs/document-source`).
- Parsing `.xlsx` bytes → typed rows: `@fuguejs/xlsx` (`parseWorkbook`).
- Writing a capability adapter: [`adapter-authoring.md`](./adapter-authoring.md).
- Runnable, lint-tested examples (one per pattern): [`examples/`](./examples/).

---

## Minimal Complete Example

```ts
// dags/my-team/my-dag/dag.ts
import { z } from "zod";
import type { DagRegistration } from "@fuguejs/host/contract";
import { defineDag, createFetchNode, createLlmNode, createTransformNode, DAG_INPUT, ok } from "@fuguejs/framework";
import type { Result, FrameworkError } from "@fuguejs/framework";

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
  model: "claude-sonnet-4-6",        // a current model id — see "Model ids" below
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
    // The request flows in over an explicit DAG_INPUT edge — no node receives
    // the DAG input implicitly (see "Input Wiring Rules"). `fetch-user` gets the
    // validated request as its bare input.
    { from: DAG_INPUT, to: "fetch-user" },
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

## Node Factories

### `createFetchNode` — external data retrieval

```ts
createFetchNode<I, O>({
  id: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
  fetch: (input: I, ctx: NodeContext) => Promise<Result<O, FrameworkError>>,
  requires?: readonly Capability[],  // default: [] — capabilities this node needs (see "Capabilities")
  sideEffects?: SideEffectProfile,   // default: { kind: "reads", resource: id } — see "Side effects, idempotency & freshness"
})
```

`requires` is how a fetch node declares the I/O capabilities it needs (e.g.
`["http"]`, `["documents"]`, `["db"]`). Each declared name narrows `ctx` so the
matching field is typed non-null — `requires: ["http"] as const` makes
`ctx.http` available without a null check. See the **Capabilities** section.

```ts
// fetch node that calls a JSON API via the built-in `http` capability:
createFetchNode({
  id: "fetch-user",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: UserSchema,
  requires: ["http"] as const,
  fetch: async (input, ctx) =>
    ctx.http.get(`https://api.example.com/users/${input.id}`, { schema: UserSchema }),
})
```

### `createSourceNode` — a root fetch that consumes no DAG input

A **source node** is a root that produces its output from the context alone —
it takes no input, so its `fetch` receives only `ctx`. Use it for the parallel
root fetches of a multi-source DAG (see `defineSources`). No node receives the
DAG input implicitly; a source consumes nothing, and the request reaches
downstream nodes over `DAG_INPUT` edges.

```ts
createSourceNode<O>({
  id: string,
  outputSchema: z.ZodType<O>,
  fetch: (ctx: NodeContext) => Promise<Result<O, FrameworkError>>,  // no input arg
  requires?: readonly Capability[],
  sideEffects?: SideEffectProfile,   // default: { kind: "reads", resource: id }
})

// Parallel root fetch — produces from a capability, takes no request:
createSourceNode({
  id: "fetch-weights",
  outputSchema: WeightsSchema,
  requires: ["documents"] as const,
  fetch: async (ctx) => readWeights(ctx.documents),
})
```

A source node is marked `isSource: true` and MUST be a root (zero incoming
edges). `defineDag` rejects a non-source root with `root-expects-input`, and a
source with an incoming edge with `source-has-incoming`.

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
  model: string,                   // a provider model id — see "Model ids" below
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

### `createEvalJudgeNode` — LLM quality gate (runs after the pipeline)

Eval judges score the DAG's output against a rubric. They are **not** placed in
`nodes`/`edges` — pass them to `defineDag`'s `evalJudges` array. A judge uses the
`judgeLlm` capability (kept separate from `llm`), so it never takes a `requires`.

```ts
createEvalJudgeNode({
  id: string,
  criteria: readonly string[],          // dimensions to score, e.g. ["factuality", "relevance"]
  threshold?: number,                   // pass mark, default 0.8
  rubric?:                              // omit to auto-generate from `criteria`
    | { source: "template"; templateId: string }
    | { source: "inline"; text: string },
  model?: string,                       // judge model; default is a small/cheap model
})
```

> **Note — LLM node capabilities are automatic.** Unlike `createFetchNode`,
> `createLlmNode` and `createLlmWithToolsNode` declare their own `requires`
> (`["llm","prompts"]` and `["llm"]` respectively) — you don't pass `requires`
> to them. Only fetch nodes (which do arbitrary I/O) take an author-set
> `requires`.

### Model ids

`model` is a provider model-id string passed through to the configured LLM
client — the framework does not validate it (`fugue capabilities` lists
*capabilities*, not models). Use a **current** id; ids carrying an explicit
release date (e.g. `claude-sonnet-4-5`) are usually the stale form and get
retired. As of this writing the current Claude ids are `claude-opus-4-8`
(most capable) and `claude-sonnet-4-6` (speed/intelligence balance); the
authoritative list lives in the host's LLM-provider configuration, not in
this doc.

Two conventions:

- **Pin a literal** id when the DAG always wants the same model — but surface
  it as a factory option so tests and environments can override it (see *DAG
  factory with injected seams*), rather than hardcoding it at module scope.
- **`<MODEL>` placeholder** — the `fugue new` scaffold writes the current id
  into generated `dag.ts`; when copying an example by hand, treat a literal
  id as a value to confirm, not gospel.

### Emitting confidence from a node

`Confidence` is a semantic bucket with provenance (`{high|medium|low|unknown}`
+ source) — never a raw number. Factories default to `confidence: { mode:
"none" }`; to emit, override the `NodeDef` field by spreading the factory
result (the same pattern as `humanReview`). Have the LLM pick a **bucket** in
its output schema and extract it:

```ts
import { confidence } from "@fuguejs/framework";
import type { LlmNodeDef } from "@fuguejs/framework";

const node = createLlmNode<In, Out>({ /* …, output schema includes
  confidence: z.enum(["high", "medium", "low"]) — a bucket, never a number */ });

// Annotate the widened type explicitly — under `composite: true` the inferred
// spread type trips TS4023 (unexportable NodeId brand) without it.
export const withConfidence: LlmNodeDef<In, Out> = {
  ...node,
  confidence: {
    mode: "value",
    extract: (output: Out) => confidence(output.confidence, "self-reported-bucket"),
  },
};
```

Downstream predicates can then gate on it via `minConfidence` (see "Predicate
shape").

---

## Capabilities

A capability is a typed client the runtime injects into a node's `ctx`. A node
names what it needs with `requires`; at run start — **before any node runs** —
the runtime validates the wired context satisfies every declared capability,
failing fast with `Err({ kind: "missing-capability", missing: [...] })` if not.
Each declared name is also narrowed to non-null in `ctx`, so `requires: ["http"]
as const` lets you write `ctx.http.get(...)` with no null check.

Only **`createFetchNode`** takes an author-set `requires` (fetch nodes do the
I/O). LLM nodes declare their own; transforms and guardrails are pure and
require nothing.

### Built-in capabilities (ship with the framework)

Run `fugue capabilities` for the authoritative, machine-readable list. As of now:

| Name | Client type | Notes |
|---|---|---|
| `llm` | `LlmClient` | Auto-declared by `createLlmNode` / `createLlmWithToolsNode`. |
| `prompts` | `PromptAccess` | Auto-declared by `createLlmNode`. |
| `judgeLlm` | `LlmClient` | Used by `createEvalJudgeNode`; separate from `llm`. |
| `cache` | `ContextCacheAdapter` | Result/context cache. |
| `http` | `HttpCapability` | Schema-validated JSON HTTP. Declare `requires: ["http"]` on a fetch node. |
| `clock` | `ClockCapability` | Injectable wall clock — `ctx.clock.now(): Date`. Declare `requires: ["clock"]` instead of calling `new Date()`/`Date.now()` directly, so a time-dependent node is deterministic in tests (`fixedClock(at)`) without monkey-patching globals. Only fetch/source nodes may require it; pure transforms stay clock-free. |

### Custom capabilities (adapter-provided)

Anything beyond HTTP — files, databases, queues — is a custom capability added
by an adapter package that augments `CapabilityRegistry` (TypeScript module
augmentation) and ships a `CapabilityHandle` the host wires at boot. The DAG
never names the provider; only the capability:

```ts
import { localPathRef } from "@fuguejs/document-source"; // brings the `documents` capability into scope

createFetchNode({
  id: "fetch-report",
  inputSchema: z.object({ period: z.string() }),
  outputSchema: ReportSchema,
  requires: ["documents"] as const,   // ctx.documents is now typed non-null
  fetch: async (input, ctx) => {
    const bytes = await ctx.documents.getContent(localPathRef(`${input.period}.xlsx`));
    if (!bytes.ok) return bytes;       // capabilities return Result — never throw
    return parseWorkbook(bytes.value, RowSchema);
  },
})
```

- Reading files (Excel/CSV from disk, SharePoint, OneDrive): [**`llm-document-source.md`**](../../document-source/docs/llm-document-source.md).
- Writing your own adapter (`db`, S3, …): [**`adapter-authoring.md`**](./adapter-authoring.md).
- `fugue describe <dag>` reports the capabilities a specific DAG requires; the
  set actually *available* is a deployment choice (which handles the host wired).

---

## Side effects, idempotency & freshness

Every node carries a `sideEffects: SideEffectProfile` declaring how it touches
the outside world. The factories set a sensible default, so you only specify it
when a node **writes** or makes a **non-idempotent external call** and you need
the framework's safety machinery.

| Factory | Default profile | How to override |
|---|---|---|
| `createTransformNode`, `createGuardrailNode` | `{ kind: "none" }` | — (pure, cannot carry extractors) |
| `createFetchNode` | `{ kind: "reads", resource: id }` | pass a `sideEffects` field |
| `createLlmNode`, `createLlmWithToolsNode` | `{ kind: "external-call", resource: "llm:<model>" }` | spread + override the returned def (see below) |

The four kinds, and what each may carry:

- **`none`** — pure compute. No resource, no extractors.
- **`reads`** — fetches external state. May carry `extractWitness`.
- **`writes`** — mutates a resource you own. May carry `idempotencyKey` **and** freshness witnesses.
- **`external-call`** — calls someone else's API. May carry `idempotencyKey`.

`SideEffectKind`, `SideEffectProfile`, `Witness`, `WitnessValue`,
`ResourceName`, plus the `witness`, `witnessValue`, and `resourceName` smart
constructors, all import from `@fuguejs/framework`.

### Idempotency keys — dedupe writes & external calls

Trigger: a `writes`/`external-call` node whose **repeat is destructive** — a
charge, an email, a row insert (a node *may* re-run on crash-resume or a
queue-level retry). On every run the framework calls `idempotencyKey(input)`,
emits the result as the `ai.node.idempotency_key` span attribute, and **fails
the node closed if the closure throws** (no key ⇒ no safe write).

The framework does **not** itself store or dedupe on the key — it computes and
propagates it, and the **downstream sink must honor it**: Stripe/SendGrid
`Idempotency-Key` headers, `INSERT … ON CONFLICT DO NOTHING`, an upsert keyed on
the value, etc. The key is your contract with that sink, made deterministic and
observable.

```ts
import { resourceName } from "@fuguejs/framework";

createFetchNode({
  id: "charge-customer",
  inputSchema: ChargeSchema,
  outputSchema: ReceiptSchema,
  requires: ["http"] as const,
  sideEffects: {
    kind: "external-call",
    resource: resourceName("stripe:charges"),
    idempotencyKey: (input) => `charge:${input.invoiceId}`, // pass as Stripe's Idempotency-Key header
  },
  fetch: async (input, ctx) => ctx.http.post(/* … */),
})
```

LLM nodes are already deduped by `ctx.cache` (keyed on input hash), so they
rarely need a key. To add one anyway, spread the returned def — same pattern as
emitting confidence, since the factory owns `sideEffects`:

```ts
const node = createLlmNode<In, Out>({ /* … */ });
export const deduped: LlmNodeDef<In, Out> = {
  ...node,
  sideEffects: { ...node.sideEffects, idempotencyKey: (input) => `summary:${input.docId}` },
};
```

### Freshness witnesses — optimistic concurrency for read-then-write

Trigger: two runs can **read the same resource, then write it** — the classic
lost-update race (e.g. two agents updating the same record). A `reads` node
emits a **witness** (a version token); the `writes` node declares which witness
it is *conditioned on* and the new witness its write produced. If an intervening
write superseded the conditioned-on witness, the framework emits a
`FreshnessViolationEvent` the operator sees and the node can route on.
Fail-closed: an extractor that throws aborts the wave rather than writing blind.

```ts
import { witness, witnessValue, resourceName } from "@fuguejs/framework";

// reads → emit the version it saw. Resource-free: the framework stamps
// `resource` from the profile, so the witness can't name a different resource.
sideEffects: {
  kind: "reads",
  resource: resourceName("postgres:customers:123"),
  extractWitness: (out) => witnessValue("version", String(out.xmin)),
}

// writes → declare what it's conditioned on + the new version it produced
sideEffects: {
  kind: "writes",
  resource: resourceName("postgres:customers:123"),
  // conditionedOn returns a FULL witness — a write may condition on a different
  // resource it read upstream, so you name that resource explicitly.
  extractConditionedOn: (input) => witness("version", resourceName("postgres:customers:123"), String(input.customerVersion)),
  // newWitness is this node's own resource → resource-free, framework-stamped.
  extractNewWitness:    (out)   => witnessValue("version", String(out.newXmin)),
}
```

Rules:

- `extractWitness` (reads) and `extractNewWitness` (writes) return a resource-free `witnessValue(kind, value)` — they always witness the node's *own* resource, which the framework stamps. A profile↔witness resource mismatch is therefore unrepresentable, not a thing you can get wrong.
- `extractConditionedOn` (writes) returns a full `witness(kind, resourceName(...), value)` — its resource is a genuine free variable (you may condition on a resource read upstream), so you name it explicitly with a branded `resourceName(...)`.
- A `writes` node declares **both** `extractConditionedOn` and `extractNewWitness`, or **neither** — one without the other fails `fugue lint` at load time.
- Witness `kind` is one of `version | etag | timestamp | lsn | idempotency-key | custom`.

Note: idempotency keys and freshness witnesses are **independent** — a node can
declare both, either, or neither. They solve different problems (dedupe one
logical operation vs. detect a concurrent overwrite), and neither allocates work
across callers; that's an application-level concern (e.g. a claims table).

Deep dive + rationale: the freshness-witness ADR (ADR-0025) and `features.md` §9
in the `fugue` monorepo — the contract above is the shipped summary.

---

## DAG constructors

Six constructors, in order of preference. Each delegates to the same
module-load validator and produces the same branded `DagDef`. Every single-entry
helper (`defineLinearDag`, `defineFanOut`, `defineDiamond`, `defineRouter`) wires
the request to its entry node automatically with a `DAG_INPUT` edge — you don't
add it. `defineSources` adds a `DAG_INPUT` edge to a join/assemble node only when
that node's fan-in schema declares a `"$input"` key.

| Constructor | Use when |
|---|---|
| `defineLinearDag` | Sequential pipeline A→B→C. Edges inferred from array order. |
| `defineSources` | **N parallel source roots → keyed fan-in join → optional assemble.** The most common real shape; the entry roots are source nodes. |
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
    { from: DAG_INPUT, to: "nodeA" },                         // request → entry node
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
- Wire the request in with `{ from: DAG_INPUT, to: "<entry>" }` — every non-source
  node that needs the DAG input gets it over an explicit `DAG_INPUT` edge.
  `DAG_INPUT` is never a `to`, and a `DAG_INPUT` edge is always unconditional.
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
    timeoutMs?: number,                    // default: 30_000 (clamped to host MAX_DAG_TIMEOUT_MS)
    maxConcurrent?: number,                // default: 10 (enforced per-DAG)
    cacheTtlMs?: number,                   // default: host DEFAULT_CACHE_TTL_MS
    checkpointTtlMs?: number,              // default: host DEFAULT_CHECKPOINT_TTL_MS
    circuitBreaker?: {                     // optional per-DAG override
      failureThreshold?: number,           //   default: host CIRCUIT_BREAKER_THRESHOLD
      resetTimeoutMs?: number,             //   default: 30_000 (half-open cooldown)
    },
  },
  meta?: {
    description?: string,
    version?: string,                      // semver
  },
};

export default registration;
```

### Configuration & environment

Two kinds of configuration, two homes:

- **Required env vars → `fugue.yaml` `env:`.** List the names a DAG cannot run
  without (API keys, connection strings). The host checks them at load time and
  **refuses to register the DAG** if any are unset — fail-closed, before a
  single request. Read them inside the node (`ctx`/process env) knowing the host
  already guaranteed their presence.
- **Optional, defaulted config → a factory option.** A value with a safe default
  (a model id, a brand string, a feature flag) may be read once at module scope
  from `process.env` — but **surface it as a `create…Dag(opts)` option** so tests
  and alternate environments can override it without mutating `process.env`:

  ```ts
  export const OPENER_MODEL = process.env.OPENER_MODEL ?? "claude-sonnet-4-6";
  export const createOpenerDag = (opts: { model?: string } = {}) =>
    defineDag({ /* … uses opts.model ?? OPENER_MODEL … */ });
  ```

  A bare module-scope `process.env` read with no factory seam is the smell: it
  can't be overridden in a test and isn't declared anywhere a deployer can see.

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
import { defineLinearDag } from "@fuguejs/framework";

const dag = defineLinearDag({
  id: "pipeline",
  nodes: [nodeA, nodeB, nodeC],
  // Edges inferred: A→B→C. outputNodeId: nodeC.
  // The request is wired to nodeA automatically via a DAG_INPUT edge.
});
```

### Multi-source join (N roots → fan-in → assemble) — `defineSources`

The most common real-world shape: several independent **source nodes** fetched
in parallel, a `join` that fans them in (an object keyed by source id), and an
optional `assemble` stage. The request reaches `join`/`assemble` *only* when that
node declares a `"$input"` key in its fan-in schema — then `defineSources` adds
the `DAG_INPUT` edge for you. No pass-through "read-request" node, no
`inputSchema: z.unknown()` roots.

```ts
import { defineSources, createSourceNode, createTransformNode, ok } from "@fuguejs/framework";

// Parallel roots are SOURCE nodes — no inputSchema; fetch is (ctx) => …
const fetchWeights = createSourceNode({ id: "fetch-weights", outputSchema: WeightsSchema,
  requires: ["documents"] as const, fetch: async (ctx) => readWeights(ctx.documents) });
const fetchBranches = createSourceNode({ id: "fetch-branches", outputSchema: BranchesSchema,
  requires: ["documents"] as const, fetch: async (ctx) => readBranches(ctx.documents) });

// join: fan-in keyed EXACTLY by the source node ids (fugue lint checks this).
const ScoreFanIn = z.object({ "fetch-weights": WeightsSchema, "fetch-branches": BranchesSchema });
const score = createTransformNode({ id: "score", inputSchema: ScoreFanIn, outputSchema: ScoredSchema,
  transform: (i) => ok(scoreLeads(i["fetch-weights"], i["fetch-branches"])) });

// assemble: declares "$input" → defineSources wires { from: DAG_INPUT, to: "assemble" }.
const AssembleFanIn = z.object({ score: ScoredSchema, $input: RequestSchema });
const assemble = createTransformNode({ id: "assemble", inputSchema: AssembleFanIn, outputSchema: ScoredSchema,
  transform: (i) => ok(applyRequest(i.score, i.$input)) });

const dag = defineSources({
  id: "lead-scoring",
  sources: [fetchWeights, fetchBranches],   // run concurrently in wave 0
  join: score,                              // fan-in keyed by source ids
  assemble,                                 // optional second stage = output node
});
```

### Fan-out (parallel siblings) — `defineFanOut`

```ts
import { defineFanOut } from "@fuguejs/framework";

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
import { defineDiamond } from "@fuguejs/framework";

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
import { defineRouter } from "@fuguejs/framework";

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

A **human-review gate** (ADR-0060) pauses a run until a human decides
(approve / reject / approve-with-edit / reroute). Use the first-class helpers:
`createHumanReviewNode` for a typed passthrough gate, or
`withHumanReview(node, { prompt })` to gate a node that *also* does work (e.g. an
LLM draft you want approved before it ships). Setting the gate routes the run to
the durable state machine; the host wires the resume machinery
(`RunOptions.onHumanReview`) — the DAG only declares the gate. See
[`examples/10-human-review.ts`](./examples/10-human-review.ts), or scaffold one
with `fugue new <team>/<name> --shape linear --review`.

```ts
import {
  createHumanReviewNode,
  createTransformNode,
  defineDag,
  ok,
} from "@fuguejs/framework";

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
    // Typed passthrough gate: the run pauses here; the reviewer sees `process`'s
    // output (and may edit it via approve-with-edit).
    "review": createHumanReviewNode({
      id: "review",
      schema: ProcessedSchema,
      prompt: "Please review the processed data",
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

To gate a node that performs work — rather than inserting a separate passthrough —
wrap it with `withHumanReview`, which preserves the node's input/output types:

```ts
"process": withHumanReview(
  createTransformNode({ id: "process", inputSchema, outputSchema, transform }),
  { prompt: "Approve the processed data before continuing" },
),
```

Per-node `NodeDef` fields that have *no* factory option (e.g. `retry`) are still
applied by spreading the factory result: `{ ...node, retry: { /* … */ } }`.

### DAG factory with injected seams (testability)

A module-scope `const dag = defineDag(...)` is untestable the moment a node
depends on a non-deterministic seam — a model id, a brand, anything a test needs
to pin. The fix is a **factory** that takes the seams as options and threads them
into the nodes; production calls it with no args, tests pass fakes.

```ts
export const createOpenerDag = (opts: { model?: string; brand?: string } = {}) =>
  defineSources({
    id: "lead-opener",
    sources: [fetchWeights, fetchBranches],
    join: scoreLead,
    assemble: createDraftOpener(opts.model ?? DEFAULT_MODEL, opts.brand ?? DEFAULT_BRAND),
  });

// prod:  createOpenerDag()
// test:  createOpenerDag({ model: "fake-model" })  // wired to a FakeLlmClient
```

The **clock** is no longer a factory seam: a node that needs the time declares
`requires: ["clock"]` and reads `ctx.clock.now()`; tests inject `fixedClock(at)`
via `makeNodeContext`, so the run is deterministic without a `now` option. Use a
factory for the seams that remain capability-shaped (model, brand). Module-scope
`defineDag` is fine for a DAG with no seams.

### Sharing nodes across DAGs

When several DAGs read the same sources, define the shared **source nodes**, row
schemas, and the fan-in schema fragment ONCE in a shared module (e.g. `lib/`) and
import them — don't duplicate per `dag.ts`. Source nodes (no `inputSchema`) are
inherently reusable because they carry no per-DAG request shape. Export the
fan-in fragment next to the nodes so each DAG's join schema spreads it:

```ts
// lib/sources.ts
export const fetchWeights = createSourceNode({ id: "fetch-weights", /* … */ });
export const fetchBranches = createSourceNode({ id: "fetch-branches", /* … */ });
export const SourceFanInSchemas = {
  "fetch-weights": WeightsSchema,
  "fetch-branches": BranchesSchema,
} as const;

// dags/leads/lead-scoring/dag.ts
const ScoreFanIn = z.object(SourceFanInSchemas);   // keys = the shared source ids
```

---

## Input Wiring Rules

No node receives the DAG input implicitly. The request enters the graph only over
edges from the reserved virtual source `DAG_INPUT` (spelled `"$input"`); it is
seeded at run start and then behaves like any other source. How a node receives
its input depends on its incoming edges:

| Incoming edges | Node receives as input |
|---|---|
| 0 edges | **Nothing** — the node must be a *source* (`createSourceNode`); `fetch` takes only `ctx`. A non-source root is a `root-expects-input` error. |
| 1 edge | The upstream node's output directly. A single `{ from: DAG_INPUT, to: n }` edge delivers the validated request to `n` as its bare input. |
| 2+ edges | Object keyed by source node id: `{ "node-a": outputA, "node-b": outputB }`. `DAG_INPUT` participates as the `"$input"` key: a fan-in that also wants the request declares `$input` in its `z.object({...})` schema. |

`DAG_INPUT` is a source like any other: a bare value on a single edge, the
`"$input"` slot in a fan-in. It is never an edge *target*, and a `DAG_INPUT` edge
is always unconditional (no `when`, no `kind: "default"`). Design your node's
`inputSchema` accordingly — and remember `fugue lint` checks that a fan-in's
object keys equal its incoming source ids (including `"$input"`).

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

### Prompt versioning

Three layers, two automatic and one opt-in:

1. **Cache safety (automatic).** Every LLM cache key gets the prompt
   fingerprint appended (hash of the system prompt + un-interpolated user
   template). Editing a prompt — or the `system` string — always misses the
   old cache, even with a custom `computeCacheKey`. No stale outputs from a
   predecessor prompt.
2. **Trace attribution (automatic).** LLM spans carry `ai.prompt_hash`, so a
   trace identifies exactly which prompt version produced an output.
3. **Explicit versions (opt-in).** Add `prompts/registry.json` next to the
   prompt files:

   ```json
   { "user-summary": { "version": "1.0.0", "hash": "<sha256/16>" } }
   ```

   When this file exists, the host validates every prompt's hash against it
   at load time and REFUSES to register the DAG on any drift (hash mismatch,
   unregistered prompt, registered-but-missing file) — "prompt edited without
   version bump" becomes a deploy failure, not a silent change. Without the
   file, prompts are versioned implicitly by git only.

Authoring workflow — never hand-edit hashes:

```bash
# after editing any prompts/*.txt (new prompt → 1.0.0, edited → patch bump):
bunx fugue prompts sync  dags/<team>/<name>
# CI / pre-merge (exit 1 on drift):
bunx fugue prompts check dags/<team>/<name>
```

---

## Result Type

All node functions return `Result<T, FrameworkError>` — `ok(value)` on success,
`err(...)` on failure. **Build errors with the `frameworkError.*` factories**,
not raw object literals: the factories brand the `nodeId`, fill required fields,
and keep call sites stable as the error types evolve. The kinds an author
typically constructs are `validation`, `transient`, and `node-crash` — all
carry the (branded) `nodeId`. There is **no** `permanent` kind: a deterministic
failure is `node-crash` with `retriability: "non-retriable"`.

```ts
import { ok, err, frameworkError } from "@fuguejs/framework";
import type { Result, FrameworkError } from "@fuguejs/framework";

// Success
return ok(value);

// Bad input / bad upstream data — names the problem, optional path
return err(frameworkError.validation("score", "CVR not found", "cvr"));

// Retriable failure — the runtime applies the node's retry budget
return err(frameworkError.transient("fetch-user", "API timeout"));

// Deterministic failure — fast-fails without consuming the retry budget
return err(frameworkError.nodeCrash("fetch-config", "config sheet is missing required rows", {
  retriability: "non-retriable",
}));
```

`frameworkError` also carries the structural factories the framework itself
emits (`missingCapability`, `retryExhausted`, `duplicateEdge`, …) — you rarely
construct those, but they're the same namespace.

<details><summary>Desugared form (what a factory produces)</summary>

A factory call is exactly a branded object literal — this is equivalent to the
`validation` line above, kept only to show the shape. Prefer the factory:

```ts
import { err, nodeId } from "@fuguejs/framework";
return err({ kind: "validation", nodeId: nodeId("score"), message: "CVR not found", path: "cvr" });
```

</details>

### Framework entry points never throw

Capabilities (`ctx.documents.getContent`, `ctx.http.get`, …), `parseWorkbook`
from `@fuguejs/xlsx`, and every framework entry point return `Result` and signal
failure with `err(...)` — including "expected" failures like a missing file or a
missing worksheet. They do **not** throw. A defensive `try/catch` wrapped around
one of them is a smell: it catches nothing and hides the real control flow.
Branch on `.ok` instead:

```ts
const parsed = await parseWorkbook(bytes, RowSchema, { sheet: "Data" });
if (!parsed.ok) return parsed;        // propagate — no try/catch
// … use parsed.value
```

(Genuinely throwing third-party code at the very edge of a fetch node — a
library with no Result contract — is the only place a `try/catch` belongs, and
it should convert straight into an `err(frameworkError.*)`.)

---

## Checklist for a Valid DAG

- [ ] Every node key in `nodes` matches that node's `id`
- [ ] Every `edges[].from` and `edges[].to` references a key in `nodes`
- [ ] No duplicate edges (same `from`+`to` pair)
- [ ] Output node is reachable via unconditional/default edges from roots
- [ ] If conditional edges leave a node, a `kind: "default"` edge exists (else-totality)
- [ ] `inputSchema` of downstream nodes matches what upstream produces
- [ ] Roots are **source nodes** (`createSourceNode`, no `inputSchema`); the request is consumed only via `DAG_INPUT` edges (a single `$input` edge for a bare consumer, the `"$input"` key for a fan-in)
- [ ] A fan-in node's `z.object` keys equal its incoming source ids (including `"$input"` when it has a `DAG_INPUT` edge)
- [ ] Errors are built with `frameworkError.*`, not raw `err({ kind, … })` literals
- [ ] No defensive `try/catch` around capabilities / `parseWorkbook` / framework calls — they return `Result`, they don't throw
- [ ] Required env vars are listed in `fugue.yaml` `env:`; optional defaulted config is a factory option, not a hidden `process.env` read
- [ ] `export default` a `DagRegistration` object

All structural rules are validated at module load by `defineDag()` — invalid
DAGs throw `DagDefinitionError` immediately, with a message pointing at the problem.

---

## Verifying with the `fugue` CLI

The `fugue` binary (`packages/framework/bin/fugue.ts`) validates and
introspects a DAG file without needing to start the host. **All output is JSON
on stdout**, designed for machine consumption.

> Run `bunx fugue …` from a directory whose package depends on
> `@fuguejs/framework` (bun links the bin per dependent). From an unrelated
> directory `bunx` falls through to the npm registry — and rewrites the
> lockfile while failing. Equivalent direct form:
> `bun node_modules/@fuguejs/framework/bin/fugue.ts lint <path>`.

### `fugue new <team>/<name> --shape <shape>`

Scaffolds a **compliant DAG directory** so you start from a lint-clean file
rather than a blank one. The generated `dag.ts` is a parameterized copy of the
golden example for the shape — current model id, `frameworkError.*`, correctly
keyed fan-in schemas, `$input` edges — so it passes `fugue lint` immediately;
you replace the placeholder schemas and node bodies. Exits `0` on success, `1`
on bad arguments or a non-empty target dir.

```bash
$ bunx fugue new leads/lead-opener --shape sources --llm
{
  "ok": true,
  "dir": "/abs/path/dags/leads/lead-opener",
  "shape": "sources",
  "team": "leads",
  "name": "lead-opener",
  "llm": true,
  "files": [
    "dags/leads/lead-opener/dag.ts",
    "dags/leads/lead-opener/fugue.yaml",
    "dags/leads/lead-opener/README.md",
    "dags/leads/lead-opener/prompts/lead-opener.txt",
    "dags/leads/lead-opener/prompts/registry.json"
  ],
  "nextSteps": ["...", "bun ...fugue.ts lint ...", "bun test", "..."]
}
```

Writes under `dags/<team>/<name>/` (relative to the cwd, or `--dir <root>`):
`dag.ts`, `fugue.yaml` (team taken from the path), `README.md`, and — with
`--llm` — a `prompts/<name>.txt` plus a synced `prompts/registry.json`.

| Flag | Effect |
|---|---|
| `--shape <shape>` | **Required.** One of `linear`, `fan-out`, `diamond`, `router`, `sources`. |
| `--llm` | Add an LLM node (bucketed confidence) + `prompts/` + synced `registry.json`. The DAG becomes a factory (`create<Name>Dag({ model })`) so a test can pin the model seam. |
| `--review` | Add a human-review gate (ADR-0060) — a `createHumanReviewNode` that pauses the run for an approve/reject decision. **`--shape linear` only**; for other shapes, gate a node by hand with `withHumanReview`. |
| `--owner <owner>` | Set `fugue.yaml`'s `owner`. |
| `--dir <root>` | Root that contains `dags/`. Defaults to the current directory. |
| `--force` | Overwrite a non-empty target directory. |

`--shape sources` (and source nodes / `$input` edges generally) is the **0.2.0
shape**; scaffolding it requires `@fuguejs/framework` ≥ 0.2.0. The other shapes
emit only pre-0.2.0 APIs.

On bad input the command returns `{ ok: false, problems: [...] }` listing
*every* problem at once (missing `--shape`, a non-kebab name, an unknown flag),
so you fix them in one pass.

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
| `describe-failed` | `defineDag` accepted the DAG but the describe step failed to assemble — usually a framework invariant bug. The `FrameworkError` is on `errors[].detail`. |
| `fan-in-key-mismatch` | A fan-in node (≥2 incoming edges) has a `z.object` input schema whose keys don't equal the set of incoming node ids. Carries `nodeId`, `missingKeys`, `extraKeys`. This compiles but fails at runtime — the single most likely wiring mistake. |
| `analyzer-failed` | `defineDag` accepted the DAG but a structural lint check (`analyzeDag`) threw while inspecting it — a framework/analyzer bug, not an authoring error. Surfaced (never swallowed) so a real `fan-in-key-mismatch` can't silently pass behind a crashed analyzer. |

**Advisories.** Lint may also attach a non-fatal `advisories` array (it never
flips `ok` to `false`). Two kinds today:
- `shape-helper-hint` — emitted when a manual `defineDag` is edge-for-edge
  isomorphic to a shape helper (`defineLinearDag`/`defineFanOut`/`defineDiamond`),
  naming the helper to adopt. A DAG already built with a helper never triggers it.
- `redundant-passthrough` — emitted for the legacy request-carrier idiom: a
  transform whose sole input is `DAG_INPUT` and whose input/output schemas are
  identical. Delete it and wire its consumer directly with a `DAG_INPUT` edge.

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

`sideEffects` is summarized here to its `kind` string only; the full profile
(idempotency key, freshness witnesses) is set in `dag.ts` — see "Side effects,
idempotency & freshness".

### `fugue capabilities`

Lists the framework's **built-in** capabilities (the legal names for a fetch
node's `requires`) plus how to obtain custom, adapter-provided ones. Takes no
path — it is static framework data. Exits `0`.

```bash
$ bunx fugue capabilities
{
  "ok": true,
  "builtin": [
    { "name": "llm",      "clientType": "LlmClient",            "description": "...", "reference": "createLlmNode / createLlmWithToolsNode" },
    { "name": "cache",    "clientType": "ContextCacheAdapter",  "description": "...", "reference": "computeCacheKey on createLlmNode" },
    { "name": "prompts",  "clientType": "PromptAccess",         "description": "...", "reference": "promptName on createLlmNode" },
    { "name": "judgeLlm", "clientType": "LlmClient",            "description": "...", "reference": "createEvalJudgeNode (DagDef.evalJudges)" },
    { "name": "http",     "clientType": "HttpCapability",       "description": "...", "reference": "createFetchNode with requires: ['http']" },
    { "name": "clock",    "clientType": "ClockCapability",      "description": "...", "reference": "createFetchNode with requires: ['clock']" }
  ],
  "custom": {
    "mechanism": "Adapter packages augment CapabilityRegistry and ship a CapabilityHandle the host wires at boot.",
    "howToDeclare": "Add the name to a node's `requires: [...] as const`; ctx.<name> is then typed non-null.",
    "discover": "Run `fugue describe <dag>` to see what a specific DAG requires.",
    "seeAlso": ["@fuguejs/document-source/docs/llm-document-source.md", "@fuguejs/framework/docs/adapter-authoring.md"]
  }
}
```

Use this to learn which capability names are valid before writing `requires` —
the `builtin` list is generated from the framework's registry, so it never drifts.

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
A team token sees only DAGs belonging to its team; admin tokens see all.
Without an auth identity the endpoint returns 401.

### `GET /dags/:id/manifest` — full schema

```bash
curl http://host:3000/dags/customer-summary/manifest \
  -H "Authorization: Bearer fug_team-token"
```

Returns the per-DAG fields `fugue describe` emits under its `dag` key,
hoisted to the top level, with host deployment metadata (`team`, `healthy`,
`sha`, `loadedAt`) appended:

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
