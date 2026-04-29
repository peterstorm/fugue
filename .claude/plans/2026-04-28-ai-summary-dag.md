# Plan: AI Summary Tool with DAG-Based Workflow Framework

**Spec:** `/Users/hansen142/dev/agentic/ai-summary/.claude/specs/2026-04-28-ai-summary-dag/spec.md`
**Brainstorm:** `/Users/hansen142/dev/agentic/ai-summary/.claude/specs/2026-04-28-ai-summary-dag/brainstorm.md`
**Research:** `/Users/hansen142/dev/agentic/ai-summary/.claude/specs/2026-04-28-ai-summary-dag/mlflow-research.md`

## Summary

Bun-workspaces monorepo. `packages/framework/` is a small (~500 LOC target) DAG executor exposing three typed node kinds (`fetch`, `transform`, `llm`), an `Observer` interface with a buffered MLflow implementation, a Redis-backed `Checkpointer` and `Cache`, a file-based prompt registry, and zod-validated boundaries. Pure functional core, imperative shell at edges. Hand-rolled `Result<T, E>`, no thrown exceptions in business logic. `apps/customer-summary/` composes a linear DAG (`fetchCustomerRecord` → `extractFeatures` → `synthesize` → `assembleResponse`) behind a Hono HTTP service, returning a discriminated-union JSON response. A Python sidecar (`eval/run.py`) invoked via podman from `bun run eval` runs `mlflow.genai.evaluate()` for CI-gated scoring.

## File Structure

### Repo root

```
ai-summary/
  package.json                          # workspaces: ["packages/*", "apps/*"]
  bunfig.toml
  tsconfig.base.json                    # strict, NodeNext, ES2023
  tsconfig.json                         # references
  .gitignore
  README.md                             # short, points to spec/plan
  infra/
    compose.yaml                        # mlflow + redis + python-eval
    eval.Dockerfile
    .env.example
  scripts/
    infra-up.sh
    infra-down.sh
```

### `packages/framework/`

```
packages/framework/
  package.json
  tsconfig.json
  src/
    index.ts
    types/
      result.ts            # Result<T,E>, helpers (ok/err/andThen/map/mapErr/isOk/isErr)
      node.ts              # NodeKind, NodeDef<I,O,E>, NodeContext
      dag.ts               # DagDef, EdgeDef (linear-only in v1)
      span.ts              # SpanKind: LLM|RETRIEVAL|EVALUATOR|GUARDRAIL|DECISION|TRANSFORM|FETCH|CHAIN
      events.ts            # ObserverEvent discriminated union (incl. SubSpanEvent)
      errors.ts            # FrameworkError variants
    executor/
      executor.ts          # runDag, resumeRun
      topo.ts              # Kahn topo sort (wave-parallel)
      validate.ts          # zod boundary validation
    nodes/
      fetch.ts             # FetchNode factory
      transform.ts         # TransformNode factory (purified ctx)
      llm.ts               # LlmNode factory (cache, retry-once, cost, thinking)
    observer/
      observer.ts          # Observer interface + NoopObserver
      buffered.ts          # BufferedObserver (tail-based persistence)
      policy.ts            # PersistencePolicy combinators
      mlflow.ts            # MLflowObserver wrapping @mlflow/tracing withSpan
    cache/
      cache.ts
      redis-cache.ts
      hash.ts              # stable JSON hash
    checkpoint/
      checkpointer.ts
      redis-checkpointer.ts
    prompts/
      registry.ts          # FilePromptRegistry
      hash.ts
    llm/
      client.ts            # LlmClient interface
      anthropic-client.ts  # tracedAnthropic wrapper
      fake-client.ts       # FakeLLMClient for tests
      cost.ts              # price table + computeCostUsd
    util/
      logger.ts            # operational logging only
  test/
    executor.test.ts
    transform.test.ts
    llm-retry.test.ts
    buffered-observer.test.ts
    persistence-policy.test.ts
    redis-checkpointer.test.ts
    redis-cache.test.ts
    prompt-registry.test.ts
    second-dag.test.ts     # SC-007 hello-world DAG
```

### `apps/customer-summary/`

```
apps/customer-summary/
  package.json
  tsconfig.json
  src/
    index.ts               # bin entry
    config.ts              # zod-validated env
    server.ts              # Hono app
    schemas/
      response.ts          # SummaryResponse discriminated-union
      summary.ts           # FR-105 synthesis output schema
      crm.ts               # fixture record schema
    sources/
      conversation-source.ts
      json-fixture-source.ts
    dag/
      summary-dag.ts
      tokens.ts            # ~6k budget heuristic
      nodes/
        fetch-customer.ts
        extract-features.ts
        synthesize.ts
        assemble-response.ts
    extraction/
      sentiment.ts
      topics.ts
      recency.ts
    bootstrap.ts
  prompts/
    synthesis.txt
    registry.json          # name -> {version, hash}
  fixtures/
    customers/cust-001.json … cust-020.json
    eval/cases.json        # [{customer_id, reference_summary}]
  eval/
    run.py
    scorers.py
    requirements.txt
    README.md
  test/
    extract-features.test.ts
    sentiment.test.ts
    topics.test.ts
    recency.test.ts
    summary-dag.test.ts
    server.test.ts
    response-schema.test.ts
```

## Component Design

### 1. Result type and error model

```ts
type Ok<T>  = { ok: true;  value: T }
type Err<E> = { ok: false; error: E }
type Result<T, E> = Ok<T> | Err<E>
```

Hand-rolled (see AD-8). All node functions return `Promise<Result<O, E>>`. Executor catches uncaught exceptions and wraps them as `Err(NodeCrashError)`. `FrameworkError` is a discriminated union: `validation` | `retry-exhausted` | `checkpoint-missing` | `checkpoint-expired` | `prompt-not-found` | `cache-error` | `node-crash` | `cycle-detected`.

### 2. Node interface

```ts
interface NodeDef<I, O, E> {
  id: string
  kind: NodeKind                       // "fetch" | "transform" | "llm"
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  deps: string[]
  run: (input: I, ctx: NodeContext) => Promise<Result<O, E>>
}
```

`NodeContext` carries `runId`, `dagId`, `observer`, `cache`, `prompts`, `llm`, `logger`, `signal`. Transform nodes receive a `purify()`-stripped context that lacks `cache` / `llm` / `prompts` — purity enforced at construction, not runtime.

`LlmNode` factory takes `{ promptName, model, outputSchema, buildInput, skipWhen?, computeCacheKey? }`. The `run` it produces:

1. Resolve prompt from `PromptRegistry` → `{ text, hash, version }`. Err if missing (FR-031).
2. Compute cache key from `(promptHash, modelId, hash(structuredInput))` (FR-051).
3. Cache lookup; on hit emit `cache_hit=true`, return cached.
4. Call `ctx.llm.sendStructured({ system, user, model, schema, thinking })`.
5. Validate against `outputSchema`. On failure, retry once (FR-021). Second failure → `Err(validation)`.
6. Compute `cost_usd` from token counts; emit attrs `prompt_version`, `model_version`, `tokens_in`, `tokens_out`, `cost_usd`, `cache_hit`, `prompt_hash`, `llm.thinking` (truncated to 4 KB; longer opens a child sub-span).
7. Cache the validated response.

### 3. DAG executor

`runDag(dag, input, ctx, opts?)`:

- Validate DAG: no cycles, all deps exist.
- Kahn topo sort produces an ordered list of waves; each wave runs via `Promise.all`. v1 has waves of size 1; the contract is forward-compat to v2.
- Per node:
  - If `opts.resumeRunId` and node output present in checkpoint → emit `node.skipped` with cached output.
  - Validate input → on fail, `Err(validation)`.
  - `observer.onNodeStart` → `node.run(input, ctx)` → on `Ok`, validate output, write checkpoint, `observer.onNodeEnd`. On `Err`, `observer.onNodeError`, then `observer.onRunEnd({ status: "error" })`, return.
- After last node, `observer.onRunEnd({ status: "ok" })`.
- `resumeRun(runId, dag, ctx)` is a separate API surface for clarity.

### 4. Observer subsystem

**`Observer` interface (no MLflow types leak):**

```ts
interface Observer {
  onRunStart(e: RunStartEvent): void
  onNodeStart(e: NodeStartEvent): void
  onNodeEnd(e: NodeEndEvent): void
  onNodeSkipped(e: NodeSkippedEvent): void
  onNodeError(e: NodeErrorEvent): void
  onSubSpan(e: SubSpanEvent): void          // forward-compat: RETRIEVAL/EVALUATOR/GUARDRAIL/DECISION
  onRunEnd(e: RunEndEvent): void
}
```

**`BufferedObserver`** wraps an inner observer and buffers events keyed by `runId`. On `onRunEnd`, computes a typed `RunSummary` (status, durations, retry counts, cache-hit counts, total cost) and applies a `PersistencePolicy.shouldFlush(summary)`; if true, replays buffered events into the inner observer; otherwise drops them. Aggregate counters (run count, total cost) flush regardless — only span persistence is gated.

**`PersistencePolicy` combinators:** `alwaysOn`, `errorOnly`, `ratio(p)`, `hadRetry`, `coldCache`, `anyOf(...)`, `allOf(...)`, `custom(fn)`. Default for app: `anyOf(errorOnly, hadRetry, coldCache, ratio(0.1))`.

**`MLflowObserver`** translates events into nested `mlflow.withSpan` calls. `SpanKind` mapping: `fetch → RETRIEVAL`, `transform → CHAIN`, `llm → LLM` (auto-trace from `@mlflow/anthropic` nests inside). `SubSpanEvent` kinds map to `RETRIEVAL` / `EVALUATOR` / `GUARDRAIL` / `UNKNOWN` (DECISION → `UNKNOWN` until MLflow exposes a richer type). Custom attributes set via `withSpan`'s `attributes` option (the documented MLflow TS path).

### 5. Checkpointer (Redis)

```ts
interface Checkpointer {
  load(runId: string): Promise<Result<RunState, FrameworkError>>
  saveNode(runId: string, nodeId: string, state: NodeState): Promise<Result<void, FrameworkError>>
  setMeta(runId: string, meta: RunMeta): Promise<Result<void, FrameworkError>>
}
```

`RedisCheckpointer` stores `chkpt:<runId>` as a hash field-per-nodeId, `chkpt:<runId>:meta` for run-level metadata, both with EXPIRE 24h. Tracks `createdAt` so `checkpoint-missing` vs `checkpoint-expired` errors are distinguishable.

### 6. Cache (Redis)

```ts
interface Cache {
  get<T>(key: string): Promise<Result<T | null, FrameworkError>>
  set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>>
}
```

Key format `cache:llm:<promptHash>:<modelId>:<inputHash>`. JSON values, fixed 24h TTL (FR-052). Stable hashing (sorted keys, canonical numbers) so semantically equal inputs produce equal keys.

### 7. Prompt registry

```ts
interface PromptRegistry {
  load(name: string): Promise<Result<{ text: string; hash: string; version: string }, FrameworkError>>
}
```

`FilePromptRegistry({ dir, registryPath })` reads `dir/<name>.txt`, hashes (sha256, hex truncated to 16), cross-checks `registry.json`. Hash mismatch returns `Err(prompt-not-found)` so prompt edits demand an explicit version bump.

### 8. LLM client

```ts
interface LlmClient {
  sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>>
}
```

`AnthropicLlmClient` wraps `tracedAnthropic(new Anthropic())`. Captures `thinking` blocks if present. Validation lives in the `LlmNode`, not the client — the client returns text + token counts + thinking. `FakeLLMClient({ responses })` for tests.

### 9. HTTP layer (Hono)

`POST /summarize` body `{ customer_id, resume_run_id? }`. Handler validates body, builds `runId` (or uses `resume_run_id`), invokes `runDag`/`resumeRun`. Returns 200 with the discriminated-union response. Returns 500 only for true framework crashes — business outcomes (no_history, not_found, insufficient_data, ok) are all 200 (FR-106). `GET /healthz` reports redis + mlflow reachability.

### 10. App DAG composition

Linear (FR-102, FR-006):

```
fetchCustomerRecord  →  extractFeatures  →  synthesize  →  assembleResponse
        (fetch)            (transform)         (llm)         (transform)
```

- `fetchCustomerRecord`: `{ customerId } → { customer: CrmRecord | null }`.
- `extractFeatures`: classifies into `branch ∈ { ok, not_found, no_history, insufficient_data }`; in `ok` branch produces `sentiment_markers`, `topic_keywords`, `top_recency_scored_utterances`, `recent_utterances_within_budget` (~6k tokens).
- `synthesize`: `skipWhen(input => input.branch !== "ok")` (passthrough for non-ok branches). For `ok`, calls Claude with structured-output schema (FR-105).
- `assembleResponse`: pure mapping into the discriminated-union response (FR-106).

`skipWhen` keeps the v1 graph linear (no conditional edges). v2 will replace it with real conditional edges; the `DECISION` SubSpanEvent slot is already reserved.

### 11. Eval sidecar (Python)

`infra/eval.Dockerfile` builds a python image with `mlflow>=3.6`, `anthropic`, `requests`. `eval/run.py`:

1. Loads `fixtures/eval/cases.json`.
2. POSTs each case to `http://host.containers.internal:<port>/summarize`.
3. Calls `mlflow.genai.evaluate(data=..., scorers=[factuality, completeness, conciseness], judge="claude-haiku")`.
4. Aggregates mean across the three scorers; exits 1 if `< 4.0`.

`bun run eval` wraps `podman-compose -f infra/compose.yaml run --rm eval python /eval/run.py`.

### 12. Concurrency and forward-compat

- Wave-parallel `Promise.all` per topological wave (waves of size 1 in v1).
- `SubSpanEvent` carries `parentSpanId`; DECISION spans for v2 conditional edges already have a landing spot without observer-interface change.

## Architectural Decisions

- **AD-1 — DIY DAG executor (not LangGraph.js):** LangGraph.js is heavyweight and opinionates state/checkpointing. ~300 LOC hand-written executor is fully debuggable and lets us own observer/checkpointer/cache contracts.
- **AD-2 — Plain `@anthropic-ai/sdk` over Claude Agent SDK for v1:** Claude Agent SDK auto-tracing is Python-only; v1 needs one structured synthesis call, no tools/sub-agents. Plain SDK + `tracedAnthropic` gives auto-tracing now; document the deferral.
- **AD-3 — Buffered observer + persistence policy (vs OTel collector tail-sampling):** in-process policy with typed run summaries (retries, cache hits, errors) is more expressive than YAML-configured collector tail sampling, ships zero infra, and avoids sending traces over the wire that will be discarded.
- **AD-4 — DIY file-based prompt registry (vs MLflow Prompt Registry):** MLflow's prompt registry is Python-only with undocumented REST surface; file-based + hash + `registry.json` covers FR-030/031, lives in git, and the one-method `PromptRegistry` interface lets us migrate later cheaply.
- **AD-5 — Python sidecar for eval (vs pure-TS):** `mlflow.genai.evaluate()` is Python-only; reimplementing scorer/dataset/judge plumbing in TS is wasted effort. Eval is offline and CI-only — Python is the right tool, runtime stays pure TS.
- **AD-6 — Hono for HTTP (vs Express, Fastify, raw Bun.serve):** first-class on Bun, zod-typed handlers, tiny footprint, easy in-process testing via `app.fetch(req)`.
- **AD-7 — zod for both DAG IO and LLM structured-output validation:** single schema library, single error shape, JSON-Schema generation for Anthropic structured outputs via `zod-to-json-schema`.
- **AD-8 — Hand-rolled `Result<T, E>` (vs `neverthrow`):** ~80 LOC of utility, no transitive deps, and the executor only needs `andThen`/`map`/`mapErr`. Easier to debug and own; revisit if codebase grows enough to want generators/`safeTry`.
- **AD-9 — Logging vs tracing strictly separated:** `util/logger.ts` is operational stderr; observers are trace data. Tail-based persistence dropping a trace must never drop log lines an engineer needs to debug a 500.
- **AD-10 — Wave-parallel `Promise.all` concurrency:** even with v1 linear DAG, scheduling per topological wave with `Promise.all` is three lines more code and forward-compat to v2 parallel/conditional graphs.
- **AD-11 — `SpanKind` taxonomy decoupled from `NodeKind`:** node kinds are DAG-level; span kinds are trace-level (LLM/RETRIEVAL/EVALUATOR/GUARDRAIL/DECISION). v1 emits FETCH/TRANSFORM/LLM only; type system reserves the rest for sub-spans.
- **AD-12 — Capture `llm.thinking` as span attribute:** Claude extended-thinking content as `llm.thinking` (≤4 KB inline, longer opens a CHAIN sub-span). Reasoning trace inspectable in MLflow without bloating the LLM span.
- **AD-13 — Decision-point spans reserved for v2 conditional edges:** `SubSpanEvent` already includes `kind: "DECISION"`; v2 conditional-edge predicates emit DECISION sub-spans without an observer-interface change.

## Implementation Phases

Five waves, 12 implementation tasks. Framework builds bottom-up before the app consumes it.

### Wave 1 — Foundations (3 parallel)

- **T1.1 Repo scaffolding + tooling.** Files: root `package.json` (workspaces), `tsconfig.base.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, package + app `package.json`/`tsconfig.json`. Done: `bun install` + `bun run typecheck` succeed.
- **T1.2 Infra compose + scripts.** Files: `infra/compose.yaml`, `infra/eval.Dockerfile`, `infra/.env.example`, `scripts/infra-{up,down}.sh`. Anchors FR-120, NFR-021. Done: `bun run infra:up` brings up MLflow:5000 + Redis:6379; UI loads.
- **T1.3 Framework core types.** Files: `packages/framework/src/types/{result,node,dag,span,events,errors}.ts`, `index.ts`. Anchors FR-002 to FR-006. Done: strict-mode compile clean; `Result` helpers unit-tested.

### Wave 2 — Framework primitives (5 parallel; depend on Wave 1)

- **T2.1 Executor + topo + boundary validation + node factories.** Files: `executor/{executor,topo,validate}.ts`, `nodes/{fetch,transform,llm}.ts`, tests `executor.test.ts`, `transform.test.ts`, `llm-retry.test.ts`, `second-dag.test.ts`. Anchors FR-001 to FR-006, FR-020, FR-021, SC-007. Done: linear DAG with `FakeLLMClient` runs end-to-end; output validation rejects bad outputs; LLM validation failure retries once; second-DAG (SC-007) passes.
- **T2.2 Observer interface + BufferedObserver + PersistencePolicy.** Files: `observer/{observer,buffered,policy}.ts`, tests `buffered-observer.test.ts`, `persistence-policy.test.ts`. Anchors FR-010 to FR-013, NFR-020/021, observability-A/C. Done: BufferedObserver gates flushes by policy; combinators compose; recording inner observer verifies decisions.
- **T2.3 Redis Checkpointer.** Files: `checkpoint/{checkpointer,redis-checkpointer}.ts`, test `redis-checkpointer.test.ts`. Anchors FR-040 to FR-042, NFR-010, SC-008, US5. Done: round-trip works; resume skips checkpointed nodes; missing vs expired distinguishable.
- **T2.4 Redis Cache + stable hashing.** Files: `cache/{cache,redis-cache,hash}.ts`, test `redis-cache.test.ts`. Anchors FR-050 to FR-052, US6. Done: hits/misses correct; 24h TTL set; key-order-different inputs hash equal.
- **T2.5 Prompt registry.** Files: `prompts/{registry,hash}.ts`, test `prompt-registry.test.ts`. Anchors FR-030, FR-031, NFR-021. Done: load resolves text+hash+version; missing/mismatched returns typed errors.

### Wave 3 — Framework integrations (2 parallel; depend on Wave 2)

- **T3.1 Anthropic LLM client + cost table.** Files: `llm/{client,anthropic-client,fake-client,cost}.ts`. Anchors FR-060, FR-300, NFR-031, SC-010. Done: real client wraps `tracedAnthropic` and captures tokens + thinking; fake client deterministic; pinned price table.
- **T3.2 MLflowObserver.** Files: `observer/mlflow.ts`. Anchors FR-010 to FR-013, FR-301, NFR-020/021, SC-003, observability-A/B/C/D wiring. Done: events translate to nested `withSpan` calls with required attributes; SubSpanEvent path exists for DECISION/EVALUATOR/GUARDRAIL even if unused in v1.

### Wave 4 — App: data, extraction, DAG, server (4 parallel; depend on Wave 3)

- **T4.1 App schemas + ConversationSource + JSON adapter + 20 fixtures.** Files: `schemas/{response,summary,crm}.ts`, `sources/{conversation-source,json-fixture-source}.ts`, `fixtures/customers/cust-001.json` … `cust-020.json`, `fixtures/eval/cases.json`, test `response-schema.test.ts`. Anchors FR-100, FR-101, FR-105, FR-106, FR-200, FR-201, SC-005, US1. Done: 20 fixtures committed; all 4 status branches parse.
- **T4.2 Extraction transforms (pure).** Files: `extraction/{sentiment,topics,recency}.ts`, `dag/tokens.ts`, `dag/nodes/extract-features.ts`, tests `{sentiment,topics,recency,extract-features}.test.ts`. Anchors FR-102 to FR-104, NFR-011. Done: extraction pure; budget caps at ~6000 tokens; branch detection correct.
- **T4.3 Synthesis prompt + LLM node + assemble + DAG composition + bootstrap.** Files: `prompts/synthesis.txt`, `prompts/registry.json`, `dag/nodes/{fetch-customer,synthesize,assemble-response}.ts`, `dag/summary-dag.ts`, `bootstrap.ts`, `config.ts`, test `summary-dag.test.ts`. Anchors FR-102 to FR-106, FR-300, US1. Done: full DAG runs against fixture with `FakeLLMClient`; produces all 4 status variants; happy path emits exactly one LLM call.
- **T4.4 Hono HTTP server + healthz + integration tests.** Files: `server.ts`, `index.ts`, test `server.test.ts`. Anchors FR-100, FR-106, NFR-001/002, US1. Done: `POST /summarize` returns 200 for all 4 branches; `/healthz` reflects redis + mlflow reachability.

### Wave 5 — Eval + end-to-end gate (2 sequential; depend on Wave 4)

- **T5.1 Python eval sidecar.** Files: `apps/customer-summary/eval/{run.py,scorers.py,requirements.txt,README.md}`, `infra/eval.Dockerfile`, `bun run eval` script. Anchors FR-110 to FR-113, NFR-003, SC-005/006/009, US2. Done: `bun run eval` produces aggregate score, exits non-zero below 4.0, logs to MLflow with prompt + model versions per fixture.
- **T5.2 End-to-end observability + resume integration test.** Files: extension to `server.test.ts`, extension to `executor.test.ts` (resume case), `scripts/smoke.ts`. Anchors FR-040 to FR-042, NFR-010/020/021, SC-001/002/003/008/010, US3, US5. Done: resume test shows zero re-execution of checkpointed nodes; smoke run produces complete MLflow trace with all required attributes; warm-cache p95 verified locally.

## Testing Strategy

- **Unit (no mocking libs):** transform nodes tested as pure functions with property tests for invariants (token-budget cap, idempotence, monotonic recency). Fetch nodes tested with the in-memory `JsonFixtureSource`. LLM nodes tested with `FakeLLMClient` keyed by `promptHash → structured output`; failure modes (validation fail → retry → fail) tested by fakes returning bad output the first N times.
- **Observer:** `RecordingObserver` captures emitted events; `BufferedObserver` tested by varying `PersistencePolicy` and asserting on what reaches the inner observer.
- **Checkpointer / Cache:** real Redis spun up via `bun run infra:up`; tests skip cleanly when Redis is not present.
- **Prompt registry:** tmpdir + sample files.
- **Integration:** full DAG with `FakeLLMClient` and JSON fixture asserts the discriminated-union response shape across all 4 branches; resume test (SC-008) interrupts a run and verifies checkpointed nodes are skipped on resume; HTTP tests via `app.fetch(req)` (no listening port required).
- **Eval (CI gate):** `bun run eval` runs the Python sidecar against the dev server; treated as a separate test phase, not `bun test`.

All substitution via constructor injection of interface-conforming fakes. No mocking libraries.

## Out of Scope

- Multi-tenancy, row-level security, per-tenant rate limits.
- Multi-provider LLM gateway, provider failover, cross-provider abstraction.
- Canary/shadow deploys, feature flags, production deployment.
- Kill switches, circuit breakers, automated HITL approvals.
- Tools/actions invoked from inside the DAG.
- Indirect prompt-injection mitigation beyond the structural no-tool guarantee.
- PII redaction at the trace boundary.
- Authentication/authorization on the HTTP API.
- A UI for the support agent.
- Embedding + clustering, semantic-similarity caching.
- Real CRM connectors.
- Token-level LLM streaming.
- Production hosting, on-call, SLOs.
- Conditional DAG edges (v2; not architecturally precluded).
- Multiple LLM calls per summary run.
- MLflow Prompt Registry integration (file-based only).
- Pure-TS eval (Python sidecar only).
- Worker threads / cluster mode.

## Risks Carried Forward

| Risk | Mitigation in this plan |
|---|---|
| `@mlflow/tracing` v0.2.0 ergonomic gaps | `MLflowObserver` is one file; OTLP fallback documented; Observer interface decoupled from MLflow types |
| Token-budget approximation error (no real tokenizer) | Heuristic capped well under 6k; FakeLLMClient tests don't depend on exact counts |
| Buffered observer memory growth on long runs | v1 runs are seconds-long single-customer; bounded by node count |
| Resume correctness with partial node side effects | Only `fetch` has external I/O; reads idempotent; no node writes externally in v1 |
| Python sidecar coupling slowing dev iteration | Eval is offline; runtime stays pure TS; sidecar invoked only from `bun run eval` |
