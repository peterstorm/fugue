# Architecture Plan: AI Summary DAG Framework

**Spec:** 2026-04-28-ai-summary-dag
**Created:** 2026-04-29
**Status:** Draft

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  apps/customer-summary                                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ HTTP API  │→ │ DAG Builder  │→ │ Domain Types +   │  │
│  │ (Hono)   │  │ (wires nodes)│  │ Zod Schemas      │  │
│  └──────────┘  └──────────────┘  └──────────────────┘  │
│        ↓              ↓                                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Nodes: fetchCustomer → parseTranscripts →        │   │
│  │   extractFeatures → synthesize → formatOutput    │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌──────────┐  ┌────────────────┐    │
│  │ Prompts/     │  │ Fixtures/│  │ Eval/          │    │
│  │ (versioned)  │  │ (CRM)   │  │ (judge rubric) │    │
│  └──────────────┘  └──────────┘  └────────────────┘    │
└──────────────────────────┬──────────────────────────────┘
                           │ depends on
┌──────────────────────────▼──────────────────────────────┐
│  packages/framework  (@ai-summary/framework)             │
│  ┌───────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐  │
│  │ Executor  │ │ Observer │ │Checkpoint │ │ LLM     │  │
│  │ (topo-    │ │ (plug-   │ │ Store     │ │ Cache   │  │
│  │  sort +   │ │  gable)  │ │ (Redis)   │ │ (Redis) │  │
│  │  parallel)│ │          │ │           │ │         │  │
│  └───────────┘ └──────────┘ └───────────┘ └─────────┘  │
│  ┌───────────┐ ┌──────────┐ ┌───────────┐              │
│  │ Prompt    │ │ LLM      │ │ Types     │              │
│  │ Loader    │ │ Adapter  │ │ (exists)  │              │
│  └───────────┘ └──────────┘ └───────────┘              │
└──────────────────────────────────────────────────────────┘
                           │ I/O edges
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌─────────┐  ┌──────────────┐
         │ Redis  │  │ MLflow  │  │ Anthropic API│
         └────────┘  └─────────┘  └──────────────┘
```

---

## 2. Key Architectural Decisions

### AD-1: Executor strategy — topological sort with Promise.all parallelism

**Options considered:**
- **(A) Topo-sort + Promise.all on each level** — group nodes by dependency depth, run each level in parallel. Simple, ~150 LOC.
- **(B) Event-driven queue** — nodes enqueue themselves when deps resolve. More flexible but harder to reason about for linear DAGs.
- **(C) Recursive resolve** — each node resolves its deps recursively. Simple but no parallelism without memoization.

**Decision: A.** v1 DAGs are linear/shallow. Level-based parallel is sufficient, trivially debuggable, and doesn't preclude conditional edges later (just changes level assignment).

### AD-2: Observer interface — sync event emitter, not async middleware

**Options considered:**
- **(A) Sync callback interface** — `Observer.on(event: ObserverEvent): void`. Observer must not block execution. MLflow batches internally.
- **(B) Async middleware chain** — observers can await. Richer but couples observer latency to execution.

**Decision: A.** Observers should never slow down the DAG. MLflow's SDK handles batching/flushing internally. Fire-and-forget with a flush at run-end.

### AD-3: Checkpoint + cache store — single Redis client, separate key namespaces

No alternative considered — Redis is spec-mandated. Key design:
- Checkpoint: `cp:{dagId}:{runId}:{nodeId}` → JSON, TTL 24h
- Cache: `llmc:{promptVersionHash}:{modelVersion}:{inputHash}` → JSON, TTL 24h

### AD-4: LLM integration — `@anthropic-ai/sdk` with `@mlflow/anthropic` wrapper

Spec-mandated. Single `tracedAnthropic` client injected into `NodeContext.llm`. No abstraction layer.

### AD-5: HTTP framework — Hono

Lightweight, Bun-native, zero-config. Single route `POST /summarize`. No middleware beyond JSON parsing.

### AD-6: Error handling — Result<T, FrameworkError> everywhere in functional core

Already established in `types/result.ts`. Nodes return `Result`. Executor collects errors as values. HTTP shell converts to response shape at the edge.

---

## 3. File Structure

```
packages/framework/src/
├── types/                    # ✅ EXISTS — node, dag, result, errors, events, span
├── executor/
│   ├── topo-sort.ts          # Pure: DagDef → NodeDef[][] (levels)
│   ├── run-dag.ts            # Imperative shell: executes levels, checkpoints, emits events
│   └── resume.ts             # Load checkpoint, determine remaining nodes, delegate to run-dag
├── observer/
│   ├── observer.ts           # Observer interface + composite observer
│   └── mlflow-observer.ts    # MLflow implementation using @mlflow/anthropic
├── checkpoint/
│   ├── checkpoint-store.ts   # Interface: get/set/exists/delete per node
│   └── redis-checkpoint.ts   # Redis implementation, 24h TTL
├── cache/
│   ├── llm-cache.ts          # Interface: get/set with hash key
│   └── redis-llm-cache.ts    # Redis implementation, 24h TTL
├── prompt/
│   ├── prompt-loader.ts      # Load from fs, compute content-hash version
│   └── prompt-registry.ts    # Registry of loaded prompts for a run
├── llm/
│   └── llm-adapter.ts        # Wraps tracedAnthropic: structured output, schema validation, retry-once
├── node-builders/
│   ├── fetch-node.ts         # Builder: (config) => NodeDef<I,O,E> for fetch kind
│   ├── transform-node.ts     # Builder: (config) => NodeDef<I,O,E> for transform kind
│   └── llm-node.ts           # Builder: (config) => NodeDef<I,O,E> for llm kind (adds prompt+cache+retry)
├── dag-builder.ts            # Fluent API: dag("id").node(...).edge(...).build() → DagDef
└── index.ts                  # Barrel export

apps/customer-summary/src/
├── domain/
│   ├── schemas.ts            # Zod schemas: CrmRecord, SentimentMarker, TopicKeyword, SummaryOutput, ApiResponse
│   ├── extraction.ts         # Pure: parseTranscripts, extractSentiment, extractTopics, scoreRecency, budgetSelect
│   └── types.ts              # Branded types: CustomerId, RunId
├── adapters/
│   ├── conversation-source.ts        # Interface
│   └── json-fixture-source.ts        # Fixture implementation
├── dag/
│   ├── customer-summary-dag.ts       # Wires 5 nodes into a DagDef
│   └── nodes/
│       ├── fetch-customer.ts         # fetch node: CustomerId → CrmRecord
│       ├── parse-transcripts.ts      # transform: CrmRecord → ParsedTranscripts
│       ├── extract-features.ts       # transform: ParsedTranscripts → ExtractionFeatures
│       ├── synthesize.ts             # llm node: ExtractionFeatures → SummaryOutput
│       └── format-output.ts          # transform: SummaryOutput → ApiResponse
├── prompts/
│   ├── synthesis-v1.md               # Versioned prompt file
│   └── eval-judge-v1.md              # Judge rubric prompt
├── fixtures/
│   ├── customers/                    # ~20 CRM JSON fixtures
│   └── references/                   # Matching reference summaries
├── eval/
│   ├── run-eval.ts                   # CLI entry: load fixtures, run DAG, score, exit code
│   ├── judge.ts                      # Pure: build judge prompt, parse score
│   └── report.ts                     # Pure: aggregate scores, format report
├── server.ts                         # Hono app: POST /summarize → run DAG → respond
└── index.ts                          # Entry: start server
```

---

## 4. Data Flow — Customer Summary DAG

```
CustomerId
    │
    ▼
[fetch-customer]  (fetch node)
    │ CrmRecord | not_found | no_history
    ▼
[parse-transcripts]  (transform node)
    │ ParsedTranscripts | insufficient_data
    ▼
[extract-features]  (transform node)
    │ { sentiment_markers, topic_keywords, top_recency_scored_utterances }
    ▼
[synthesize]  (llm node — single Claude call)
    │ SummaryOutput { headline, recent_issues, sentiment, topics, suggested_next_action }
    ▼
[format-output]  (transform node)
    │ ApiResponse (discriminated union on `status`)
    ▼
HTTP 200 JSON
```

**Early-exit handling:** `fetch-customer` returns `Result<CrmRecord, "not_found">`. `parse-transcripts` returns `Result<ParsedTranscripts, "no_history" | "insufficient_data">`. On `Err`, downstream nodes are skipped (executor checks `Result.ok`), and `format-output` maps the error variant to the correct `{ status: "..." }` response.

**Alternative considered:** Have the executor support short-circuit on Err and handle it at the HTTP layer. Rejected because it pushes domain logic (mapping error variants to response shapes) into the shell.

---

## 5. Core Interfaces

### Observer (framework)
```typescript
interface Observer {
  readonly on: (event: ObserverEvent) => void;  // sync, non-blocking
  readonly flush: () => Promise<void>;           // called at run-end
}
```

### CheckpointStore (framework)
```typescript
interface CheckpointStore {
  readonly save: (runId: string, nodeId: string, output: unknown) => Promise<void>;
  readonly load: (runId: string, nodeId: string) => Promise<Result<unknown, FrameworkError>>;
  readonly exists: (runId: string, nodeId: string) => Promise<boolean>;
  readonly loadRun: (runId: string) => Promise<Result<ReadonlyMap<string, unknown>, FrameworkError>>;
}
```

### LlmCache (framework)
```typescript
interface LlmCache {
  readonly get: (key: string) => Promise<unknown | null>;
  readonly set: (key: string, value: unknown) => Promise<void>;
}
// Key = hash(promptVersion + modelVersion + stableHash(input))
```

### ConversationSource (app adapter)
```typescript
interface ConversationSource {
  readonly getCustomer: (id: CustomerId) => Promise<Result<CrmRecord, "not_found">>;
}
```

### PromptLoader (framework)
```typescript
interface PromptLoader {
  readonly load: (name: string) => Result<{ content: string; version: string }, FrameworkError>;
}
// version = content hash (SHA-256 hex prefix)
```

---

## 6. Implementation Phases

### Wave 1: Framework Core (no I/O dependencies)
Pure functional core — testable without Redis, MLflow, or Anthropic.

| Task | Files | Testability |
|------|-------|-------------|
| 1a. Topo-sort + cycle detection | `executor/topo-sort.ts` | Pure: DagDef in → levels out. Property tests. |
| 1b. DAG builder + validation | `dag-builder.ts` | Pure: builder API → DagDef. |
| 1c. Node builders (fetch, transform, llm stubs) | `node-builders/*.ts` | Pure: config → NodeDef. |
| 1d. Prompt loader (fs-based, content hash) | `prompt/prompt-loader.ts` | Integration: reads fixture prompt files. |
| 1e. Result utilities (already done) | — | — |

### Wave 2: Framework Infrastructure Shell
I/O adapters — integration-tested with real Redis (from `infra:up`).

| Task | Files | Testability |
|------|-------|-------------|
| 2a. Redis checkpoint store | `checkpoint/redis-checkpoint.ts` | Integration: Redis round-trip. |
| 2b. Redis LLM cache | `cache/redis-llm-cache.ts` | Integration: Redis round-trip. |
| 2c. Executor (run-dag) — orchestrates levels, checkpoints, observers | `executor/run-dag.ts` | Unit: inject fake checkpoint + observer. Integration: full run. |
| 2d. Resume logic | `executor/resume.ts` | Unit: given checkpoint map, determine remaining nodes. |
| 2e. Observer interface + composite | `observer/observer.ts` | Pure: composite dispatches to children. |

### Wave 3: App Domain Layer (pure, no LLM)
Customer-summary domain — all transform nodes, schemas, extraction logic. Fully unit-testable.

| Task | Files | Testability |
|------|-------|-------------|
| 3a. Zod schemas (CrmRecord, extraction features, SummaryOutput, ApiResponse) | `domain/schemas.ts` | Pure: schema parse tests. |
| 3b. JSON fixture adapter | `adapters/json-fixture-source.ts` | Integration: reads fixture files. |
| 3c. Extraction functions (sentiment, topics, recency scoring, token budgeting) | `domain/extraction.ts` | Pure: input → output. Property tests for token budget. |
| 3d. Transform nodes (parse-transcripts, extract-features, format-output) | `dag/nodes/*.ts` | Pure: exercise via node builders. |
| 3e. CRM fixtures (~20) + reference summaries | `fixtures/` | Data files. |

### Wave 4: LLM Integration + App Wiring
Connect to Anthropic, MLflow, build the DAG, expose HTTP.

| Task | Files | Testability |
|------|-------|-------------|
| 4a. LLM adapter (tracedAnthropic wrapper, structured output, retry-once) | `framework: llm/llm-adapter.ts` | Integration: real API call (or recorded). |
| 4b. MLflow observer | `framework: observer/mlflow-observer.ts` | Integration: MLflow running. |
| 4c. Synthesis node + prompt file | `app: dag/nodes/synthesize.ts`, `prompts/synthesis-v1.md` | Integration: LLM call + schema validation. |
| 4d. Customer-summary DAG assembly | `app: dag/customer-summary-dag.ts` | Integration: end-to-end with fixtures. |
| 4e. Hono HTTP server + POST /summarize | `app: server.ts` | Integration: HTTP request → JSON response. |

### Wave 5: Eval + Second DAG + Polish
Eval pipeline, reusability proof, CI gating.

| Task | Files | Testability |
|------|-------|-------------|
| 5a. Eval judge (LLM-as-judge with Haiku, rubric prompt) | `app: eval/judge.ts` | Integration: real Haiku call. |
| 5b. Eval runner (CLI, per-fixture + aggregate, exit code) | `app: eval/run-eval.ts` | Integration: full eval run. |
| 5c. Second example DAG (hello-world 2-node, framework tests) | `framework: src/__tests__/hello-dag.test.ts` | Unit: proves reusability (SC-007). |
| 5d. Resume integration test (SC-008) | `framework: src/__tests__/resume.test.ts` | Integration: interrupt + resume. |
| 5e. CI configuration (eval gate) | Root scripts / CI config | SC-009. |

---

## 7. Dependency Graph Between Waves

```
Wave 1 (framework core, pure)
    ↓
Wave 2 (framework infra shell)
    ↓           ↘
Wave 3 (app domain, pure)  ← can start after Wave 1 (parallel with Wave 2 partially)
    ↓           ↙
Wave 4 (LLM + wiring) — needs Wave 2 + Wave 3
    ↓
Wave 5 (eval + polish) — needs Wave 4
```

**Wave 3 can start in parallel with Wave 2** because app domain logic only depends on framework types (Wave 1), not on Redis/observer implementations.

---

## 8. Testing Strategy

| Layer | Approach | Mocks needed |
|-------|----------|--------------|
| Topo-sort, DAG builder | Property tests (fast-check) | None |
| Extraction functions | Property tests + unit tests | None |
| Zod schemas | Parse/reject tests | None |
| Node builders | Unit: config → NodeDef shape | None |
| Executor | Unit: inject `CheckpointStore` + `Observer` as plain objects | Fake implementations (not mocks) |
| Redis stores | Integration with real Redis | None — real Redis from `infra:up` |
| LLM adapter | Integration with real Anthropic API | None — recorded responses for CI |
| End-to-end DAG | Integration with fixtures | Real everything |
| Eval | Integration — real LLM judge | None |

**Key principle:** Transform nodes and extraction functions are pure → 80%+ of app logic is testable with zero I/O. Only checkpoint store, cache, LLM adapter, and MLflow observer need integration tests.

---

## 9. Risk Mitigations in Architecture

| Risk | Architectural mitigation |
|------|--------------------------|
| Executor complexity creep | Topo-sort is a pure function; executor is <200 LOC imperative shell calling it |
| Observer overhead | Sync fire-and-forget; flush only at run-end |
| Stale cache | Key includes prompt version + model version + input hash; any change invalidates |
| LLM output schema drift | Zod validation on every response + retry-once; typed errors surface clearly |
| Prompt version drift | Content-hash loader refuses to run on missing prompt |

---

## 10. Spec Coverage Matrix

| Requirement | Wave | Files |
|-------------|------|-------|
| FR-001 (topo execution) | 1a, 2c | topo-sort.ts, run-dag.ts |
| FR-002 (3 node kinds) | 1c | node-builders/*.ts |
| FR-003 (schema validation) | 1c, 2c | node-builders, run-dag |
| FR-004 (errors as values) | exists | result.ts, errors.ts |
| FR-005 (declarative DAG) | 1b | dag-builder.ts |
| FR-006 (linear only v1) | 1a | topo-sort.ts |
| FR-010–013 (observability) | 2e, 4b | observer.ts, mlflow-observer.ts |
| FR-020–021 (structured output) | 4a | llm-adapter.ts |
| FR-030–031 (prompt versioning) | 1d | prompt-loader.ts |
| FR-040–042 (checkpointing) | 2a, 2c, 2d | redis-checkpoint.ts, run-dag.ts, resume.ts |
| FR-050–052 (LLM cache) | 2b, 4a | redis-llm-cache.ts, llm-adapter.ts |
| FR-060 (cost capture) | 4a, 4b | llm-adapter.ts, mlflow-observer.ts |
| FR-100–106 (app) | 3a–3e, 4c–4e | domain/*, dag/*, server.ts |
| FR-110–113 (eval) | 5a, 5b | eval/*.ts |
| FR-120 (infra:up) | exists | infra/compose.yaml, scripts/ |
| SC-007 (second DAG) | 5c | hello-dag.test.ts |
| SC-008 (resume test) | 5d | resume.test.ts |
