---

# Design: Fugue Runtime — Shared DAG Hosting Package

**Created:** 2026-05-13
**Status:** Brainstorm
**Goal:** Eliminate per-app boilerplate by extracting a reusable `@fugue/runtime` package that teams import, pass their DAG definitions to, and get a production-ready server with zero infrastructure wiring.

---

## Problem

Today, building a new DAG-powered application requires duplicating ~15 files of boilerplate from `apps/customer-summary`:

- Server setup (Hono, routes, health/readiness endpoints)
- Bootstrap (LLM client selection, Redis connection, tracing init, prompt registry)
- Config loading (env vars, Zod validation)
- Graceful shutdown (flush traces, disconnect Redis)
- Request handling (abort controllers, timeouts, run ID generation)
- Checkpointing wiring (Redis adapter → NodeContext)
- Cache wiring (Redis adapter → NodeContext)

The actual creative work per DAG is small: node implementations, DAG definition (edges/nodes), and prompts. Everything else is identical across applications.

For 2-3 teams adopting the framework in the next 6 months, this boilerplate is a real adoption barrier. Each team would need to understand and maintain infrastructure code that has nothing to do with their domain.

## Non-Goals

- **Multi-tenant platform / centralized deployment** — each team deploys their own runtime instance. We are not building an internal PaaS.
- **Dynamic DAG loading / hot reload** — DAGs are compiled into the binary. Adding a DAG is a code change + deploy.
- **YAML/JSON DAG definitions** — DAGs are TypeScript. The type system is the validation layer.
- **Shared observability backend** — each team configures their own tracing destination (MLflow, Azure AI Foundry, etc.).

## Target Experience

A team's entire application becomes:

```typescript
// index.ts
import { createRuntime } from "@fugue/runtime";
import { customerSummaryDag } from "./dags/customer-summary.js";
import { invoiceProcessorDag } from "./dags/invoice-processor.js";

export default createRuntime({
  dags: [customerSummaryDag, invoiceProcessorDag],
});
```

Running `bun run index.ts` gives you:
- `POST /dags/:dagId/run` — execute a DAG with input
- `GET /health` — liveness probe
- `GET /readiness` — checks Redis, tracing backend
- Tracing, caching, checkpointing, graceful shutdown — all handled

## Architecture

### Three-Layer Model

```
┌─────────────────────────────────────────────┐
│  Team's Code (DAG definitions)              │
│  - Node implementations                     │
│  - DAG wiring (nodes + edges)               │
│  - Prompts                                  │
│  - Domain-specific config                   │
└─────────────────┬───────────────────────────┘
                  │ exports DagRegistration[]
                  ▼
┌─────────────────────────────────────────────┐
│  @fugue/runtime (this package)              │
│  - Server (Hono)                            │
│  - Bootstrap (LLM, Redis, tracing)          │
│  - Config (env vars + sensible defaults)    │
│  - Request lifecycle (abort, timeout, runId)│
│  - Health / readiness                       │
│  - Graceful shutdown                        │
└─────────────────┬───────────────────────────┘
                  │ uses
                  ▼
┌─────────────────────────────────────────────┐
│  @fugue/framework (existing library)        │
│  - DAG executor                             │
│  - Tracing / content filter                 │
│  - Caching / checkpointing                  │
│  - LLM clients                             │
│  - Retry / error handling                   │
└─────────────────────────────────────────────┘
```

### DagRegistration — The Contract

Each DAG exports a registration object that the runtime consumes. This is the primary API surface:

```typescript
interface DagRegistration<I = unknown, O = unknown> {
  /** The DAG definition (nodes, edges, schemas). */
  readonly dag: DagDef;

  /** 
   * Node implementations keyed by node ID.
   * Each entry is the `run` function for that node.
   */
  readonly nodes: Record<string, NodeImpl>;

  /**
   * Prompts used by this DAG, keyed by name.
   * Can be inline strings or file paths (resolved relative to the DAG directory).
   */
  readonly prompts?: Record<string, string | { file: string }>;

  /**
   * Optional route override. Defaults to `/dags/${dag.id}/run`.
   * Allows custom paths like `/summarize` for backwards compat.
   */
  readonly route?: string;

  /**
   * Optional capabilities this DAG needs beyond the defaults.
   * E.g., specific LLM model, dedicated Redis namespace, custom tools.
   */
  readonly config?: DagConfig;
}
```

### Open Question: Node Implementation Shape

Today, nodes are defined inline in `DagDef` via `createLlmNode`, `createTransformNode`, etc. The `run` function is baked into the node definition. This means the DAG definition already contains the implementations.

Two options for how `DagRegistration` relates to this:

**Option A: DagDef stays as-is, registration is just metadata.**
The `DagRegistration` wraps an existing `DagDef` (which already has `run` functions) and adds routing/config. Simple, no framework changes needed.

```typescript
export const customerSummaryDag: DagRegistration = {
  dag: buildCustomerSummaryDag(), // existing DagDef with run functions
  route: "/summarize",
};
```

**Option B: Separate definition from implementation.**
The `DagDef` becomes a pure graph declaration (nodes, edges, schemas — no `run`). Implementations are supplied separately. This enables: DAG visualization without importing all dependencies, static analysis of the graph, and potentially swapping implementations for testing.

Option A is pragmatic and requires zero framework changes. Option B is cleaner but needs the framework to change how nodes are defined. **Recommendation: start with A, evolve to B if separation proves valuable.**

### Config & Environment

The runtime handles all environment configuration with sensible defaults:

```typescript
interface RuntimeConfig {
  // Server
  port?: number;                    // default: 3000

  // LLM
  llm?: LlmClientConfig;           // auto-detected from env vars
  
  // Infrastructure
  redis?: { url: string };          // default: redis://localhost:6379
  
  // Observability
  tracing?: {
    exporter: "mlflow" | "azure-foundry" | "otlp" | SpanExporter;
    sampleRatio?: number;           // default: 0.1
    contentFilter?: ContentFilter;  // default: piiScrubber
  };
}
```

LLM client auto-detection logic (from current bootstrap):
1. `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` → Azure OpenAI client
2. `OPENAI_API_KEY` → OpenAI client
3. `ANTHROPIC_API_KEY` → Anthropic client
4. None → FakeLlmClient (dev mode, logs warning)

Teams can override any of this programmatically:

```typescript
export default createRuntime({
  dags: [myDag],
  config: {
    tracing: {
      exporter: "azure-foundry",
      contentFilter: piiScrubber,
    },
  },
});
```

### Request Lifecycle

The runtime standardizes how requests are handled:

```
POST /dags/:dagId/run  { input: {...} }
        │
        ▼
  Validate dagId exists
        │
        ▼
  Generate runId (UUID)
        │
        ▼
  Create AbortController (with timeout)
        │
        ▼
  Build NodeContext (inject LLM, cache, tracer, contentFilter)
        │
        ▼
  runDag(dag, input, ctx)
        │
        ▼
  Return { status, runId, output } or { status, runId, error }
```

### Health & Readiness

Standardized across all deployments:

- `GET /health` → always 200 (liveness)
- `GET /readiness` → checks Redis connectivity, tracing backend reachability
- `GET /dags` → list registered DAGs with their routes and metadata

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new requests
2. Wait for in-flight DAG runs to complete (with timeout)
3. Flush pending traces
4. Disconnect Redis
5. Exit

## What Stays in Team Code

Teams are responsible for:

1. **Node implementations** — the actual business logic (fetch from CRM, transform data, etc.)
2. **DAG definitions** — nodes, edges, schemas
3. **Prompts** — LLM prompt templates
4. **Domain-specific config** — which models to use, custom schemas, etc.
5. **Tests** — unit tests for nodes, integration tests for the DAG
6. **Deployment config** — Dockerfile, k8s manifests, CI pipeline (though we could provide templates)

## Scaffolding (create-fugue-app)

Optional CLI to generate a new DAG project:

```bash
bunx create-fugue-app my-invoice-processor
```

Generates:
```
my-invoice-processor/
  package.json          # depends on @fugue/runtime, @fugue/framework
  tsconfig.json
  index.ts              # createRuntime({ dags: [...] })
  dags/
    example/
      dag.ts            # example DagDef with 2 nodes
      nodes/
        fetch.ts        # example fetch node
        process.ts      # example LLM node
      prompts/
        system.md       # example prompt
  Dockerfile
  .env.example
```

## Migration Path for customer-summary

The existing `apps/customer-summary` becomes the proof that the runtime works:

1. Extract bootstrap/server logic into `@fugue/runtime`
2. Rewrite `apps/customer-summary` to use `createRuntime()`
3. Verify all existing tests still pass
4. Verify MLflow traces still land correctly

The customer-summary app should shrink from ~15 files to ~5 (nodes, DAG definition, prompts, index, tests).

## Open Questions

1. **Multiple LLM clients per DAG** — some DAGs might want different models for different nodes (cheap model for extraction, expensive model for synthesis). How does the runtime expose this? Per-node model override in config? Multiple named LLM clients?

2. **Shared node libraries** — if multiple teams need "fetch from Salesforce" or "call internal API X", should there be a `@fugue/nodes-common` package? Or is copy-paste fine for 2-3 teams?

3. **Background/async DAG runs** — the current API is synchronous (request → run DAG → respond). Should the runtime support fire-and-forget with status polling? This matters for long-running DAGs (minutes, not seconds).

4. **Per-DAG Redis namespacing** — if multiple DAGs share a Redis instance, their cache keys could collide. Should the runtime auto-prefix keys with the DAG ID?

5. **Auth/authz** — should the runtime have any built-in authentication, or is that always handled by the infrastructure layer (API gateway, service mesh)?

6. **Webhook/event triggers** — beyond HTTP POST, should DAGs be triggerable by events (queue messages, cron, webhooks)?

## Next Steps

1. Validate this design against the customer-summary app — can it actually be expressed as a `DagRegistration`?
2. Design the `createRuntime()` API in detail
3. Extract bootstrap logic from customer-summary into runtime package
4. Migrate customer-summary to use the runtime
5. Write the scaffolder

---

*This document captures initial brainstorming. The design should be validated through the specify → architecture → implement cycle before building.*
