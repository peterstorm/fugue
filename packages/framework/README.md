# @ai-summary/framework

DAG-shaped, durable runtime for LLM-bearing workflows. See [`docs/adr/`](../../docs/adr/) for the decision record; this file is a reference for the public surface exported from `src/index.ts`.

The barrel is deliberately narrow. Anything not listed below is an internal detail — import from the concrete file path if you have a documented need (tests do this routinely), but treat that as a private contract subject to change without a major bump.

## Adding to the public surface

Before re-exporting a new symbol from `src/index.ts`:

1. Does an external consumer need it, or can it stay private? Default to private.
2. Is it durable across the next refactor, or is it the current shape of an internal? Internals churn.
3. Does it widen the framework's API contract — i.e., would a rename break a downstream consumer? If yes, name it deliberately.
4. Cite an ADR or plan section in the inline comment near the export.

The framework has no external consumers as of 2026-05-11; the surface is at its narrowest. Resist growing it.

## Authoring surface

Types and entry points that workflow authors touch.

### `types/`

- `DagDef`, `DagDefInput`, `EdgeDef`, `EdgeDefInput`, `Predicate` — the DAG shape and edge-predicate vocabulary (ADR 0015, ADR 0016).
- `NodeDef`, `NodeKind`, `NodeRetryConfig`, `NodeHumanReviewConfig` — node authoring contract.
- `Capability`, `CapabilityFields`, `BaseNodeContext`, `TypedNodeContext`, `NodeContextInit` — capability-typed `NodeContext`. Declare `requires` on a `NodeDef` and the `ctx` parameter is typed accordingly — `requires: ["llm"]` yields `ctx.llm: LlmClient` (non-null).
- `ContextCacheAdapter`, `CacheLookup`, `PromptAccess`, `Logger`, `Observer`, `Tracer` — pluggable seams.
- `Result`, `Ok`, `Err`, `ok`, `err`, `isOk`, `isErr`, `andThen`, `map`, `mapErr`, `unwrap`, `unwrapOr` — the `Either` shape used everywhere errors are returned (no exceptions across module boundaries).
- `FrameworkError` (re-exported from `types/errors.js`) — discriminated error union.

Internal inference helpers (`ConsistentNodes`, `OutputOf`, `OutputsByNodeId`, `NodesRecord`) live in `types/dag-internals.ts` and are intentionally not re-exported.

### `executor/`

- `defineDag`, `defineDagFromArray`, `DagDefinitionError` — type-driven DAG constructor(s) with `outputNodeId` enforcement.
- `validateDagShape`, `recordFromNodeArray` — pure validation utilities.
- `runDag`, `resumeRun`, `RunOptions` — execution entry points. Always route through the durable state machine (ADR 0021). `RunOptions` includes `jobLike`, `onHumanReview`, `onBackground`, `onTrace`, `retryLimits`, and the ADR 0019 routing advisory toggle `suppressRoutingWarnings`.

### `nodes/`

Built-in node factories (each declares its capability `requires`):

- `createFetchNode`, `FetchNodeConfig`
- `createTransformNode`, `TransformNodeConfig`
- `createLlmNode`, `LlmNodeConfig`
- `createLlmWithToolsNode`, `LlmWithToolsNodeConfig`
- `createGuardrailNode`, `GuardrailNodeConfig`, plus the `GuardrailResult` / `GuardrailSkipped` / `GuardrailValidated` / `GuardrailCheck` shapes
- `createEvalJudgeNode`, `EvalJudgeNodeConfig`, `EvalJudgeNodeDef`, `EvalJudgeResult`, `EvalJudgeResponse`, `EvalJudgeResponseSchema`, `toEvalJudgeResult`, `failOpenResult`
- `JUDGE_SYSTEM_FRAME`, `generateDefaultRubric`, `resolveRubric`, `assembleJudgeUserMessage` — prompt-assembly helpers for custom judge nodes.

### `llm/`

- `LlmClient`, `LlmRequest`, `LlmResponse`, `LlmRuntime`, `SendWithToolsRequest` — client contracts.
- `AnthropicLlmClient`, `OpenAILlmClient` — production clients. Both map provider-specific rate-limit errors to `Err({ kind: "transient" })`.
- `FakeLlmClient` plus `FakeResponseProvider`, `FakeToolUseTurn`, `FakeFinalTurn`, `FakeWithToolsScript` — deterministic test client.
- `ToolDef`, `tool`, `assertValidToolName`, `ensureToolNames` — typed tool-call surface (ADR 0012).
- `withLlmSpan`, `withToolSpan`, `setLlmUsageAttributes`, `setToolIoAttributes`, `LlmSpanMeta`, `ToolSpanMeta` — span helpers for custom LLM integrations.
- `computeCostUsd`, `PRICE_TABLE` — cost-attribution utilities.

### `prompts/`, `cache/`

- `FilePromptRegistry`, `PromptRegistry`, `PromptEntry`, `computePromptHash` — filesystem-backed prompt registry.
- `Cache` interface plus `InMemoryCache`, `RedisCache` — node-output cache backends.
- `stableHash` — deterministic structural hash used by the cache layer.

### `observer/`

Domain event bus (typed). Tracing-specific concerns (OTel exporters, span helpers) live in `tracing/`:

- `Observer` interface plus `NoopObserver`, `RecordingObserver`.
- `BufferedObserver`, `computeRunSummary`, `dispatchEvent`, `RunSummary`, `AggregateCounters` — durable summary + dispatch helpers.
- `PersistencePolicy` plus the policy combinators `alwaysOn`, `errorOnly`, `ratio`, `hadRetry`, `coldCache`, `anyOf`, `allOf`, `custom`.
- `TailSamplingProcessor` — span tail-sampling (forwards to `tracing/`).
- The `OBSERVER_STRICT` env toggle rethrows observer exceptions in tests.

### `tracing/`

- `TracingConfig`, `TracingHandle`, `initTracing` — OpenTelemetry SDK wiring with env-driven sample ratio.
- `MlflowOtlpExporter`, `createMlflowExporter`, `MlflowOtlpExporterConfig` — MLflow-shaped OTLP exporter.
- `enrichLlmSpan`, `EnrichLlmSpanOpts` — span-enrichment helper.
- Re-exports from `semantic-conventions.js` — GenAI/MLflow attribute keys.

### `checkpoint/`

- `Checkpointer` interface plus `RunMeta`, `NodeState`, `RunState`, `InMemoryCheckpointer`, `RedisCheckpointer`. Includes ADR 0017 framework-version enforcement and the `checkpoint-expired` / `checkpoint-corrupt` / `checkpoint-version-mismatch` error kinds.
- `dagFingerprint`, `FRAMEWORK_VERSION` — byte-stable DAG hash and the version constant stamped into checkpoint meta.

## State-machine kernel (durability core)

NFR-021. The kernel is the foundation of the runtime; most callers reach it via `runDag`.

- `Machine<S, C, E>`, `Executor<S, C, E>`, `JobLike<S, C, E>`, `RecordedEvent`, `RunOptions`, `TraceEvent`.
- `runStateMachine` — the kernel loop. Append, transition, persist, repeat. Idempotent under crash + resume via deterministic dedup keys (ADR 0014).
- `createInMemoryJob`, `InMemoryJob`, `InMemoryJobOptions` — non-durable `JobLike` for in-process runs.
- `replayEvents`, `replayEventsUntil`, `replayEventSlice` — pure folds for testing and forensic replay.
- `toJson`, `fromJson` — documented serialization helpers for custom `JobLike` backends.

The transition primitives (`handleWaveDone`, `handleNodeFailed`, `advanceToNextWave`, `computeBackoffMs`, ...) and `serializeValue`/`deserializeValue` are intentionally not re-exported — they are internal to the kernel.

## DAG runtime

The compilation layer between `DagDef` and the kernel.

- `DagPhase`, `DagEvent`, `DagMachineContext`, `HumanAction` — the kernel's `S`, `E`, `C` for a DAG plus the human-action shape (`approve` / `reject` / `approve-with-edit`).
- `dagTransition` — pure transition function for the DAG machine.
- `compileDagToMachine` — `DagDef` → `Machine<DagPhase, DagEvent, DagMachineContext>`.
- `buildDagExecutor` — the `Executor` side: takes a `DagPhase`, runs the wave, returns a `DagEvent`.
- `topoSort` — wave decomposition utility (re-exported from `shared/`).
- `runDagStateful`, `runDagAsWorkerJob`, `DagRunOpts` — direct kernel-mode entry points. `runDag` is the recommended entry; these exist for callers that want kernel control.

## Queue layer

Transport-agnostic durable-queue contract.

- `QueueBackend`, `QueueHandle`, `WorkerHandle`, `MarkerStore`, `DeadLetterNotifier`, `DeadLetterOpts`, `EnqueueOpts`, `QueueOpts`, `WorkerOpts`, `EventLogOpts` — backend contract.
- `attachDeadLetterHandler` — DLQ wiring; rethrows on notifier failure.
- `createInMemoryBackend`, `adaptInMemoryJob`, `createInMemoryMarkerStore`, `InMemoryBackend` — in-process backend.

## Queue-BullMQ adapter

- `createBullMQBackend` — production backend. `close()` resolves on clean shutdown and throws an `AggregateError` whose `errors` array carries the individual close failures on partial shutdown.
- `defaultStreamKey`, `adaptBullMQJob`, `AdaptBullMQJobOpts` — `JobLike` adapter; uses Lua-script atomic dedup.
- `createRedisMarkerStore`, `createRedisStreamReader`, `EventLogReader` — Redis-backed marker + event-log readers.

## Scheduler

NFR-021. Transport-agnostic cron scheduler (the BullMQ-or-other binding is the caller's concern; `scheduler/**` is forbidden from importing `queue-bullmq/**` by `scripts/check-imports.ts`).

- `TaskConfig`, `TaskRegistry`, `RegistryDiff`, `CatchUpDecision` — scheduler types.
- `decideCatchUp` — pure decision helper for missed cron fires.
- `CronScheduler`, `CronSchedulerOpts`, `createCronScheduler` — scheduler factory. Exponential backoff on consecutive failures.

Internals (`hasCycle`, `diffRegistry`) are not re-exported.

## NodeContext helpers

- `makeNodeContext` — capability-validated `NodeContext` constructor; declares which fields are present and which are typed-out.
- `consoleLogger`, `noopTracer`, `noopObserver` — always-present-default implementations of the non-capability seams.

## Boundary rules

Enforced by `scripts/check-imports.ts` and `__tests__/boundary-imports.test.ts`:

- `scheduler/**` must not import `bullmq` / `ioredis` / `queue-bullmq/**`.
- `executor/**` and `dag-runtime/**` must not import from each other (shared utilities live in `shared/`).

Adding a new layer? Add a rule. Adding a cross-layer import? It will fail CI.

## Test conventions

- Redis-gated tests use `process.env.REDIS_URL` to skip cleanly when no Redis is reachable.
- Property tests use `fast-check`.
- Boundary lints (`check-imports`) run in `bun run check`.

## Versioning

`FRAMEWORK_VERSION` (in `src/version.ts`) is stamped into every checkpoint meta row. A mismatched value on resume returns `Err({ kind: "checkpoint-version-mismatch" })` rather than corrupting state silently (ADR 0017). Bump it whenever validation, retry, or output-coercion semantics change.
