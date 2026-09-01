# @fuguejs/framework

DAG-shaped, durable runtime for LLM-bearing workflows. See [`docs/adr/`](../../docs/adr/) for the decision record; this file is a reference for the public surface exported from `src/index.ts`.

## Docs

Authoring guidance ships in this package, version-locked to the code — read it
straight from `node_modules/@fuguejs/framework/docs/`:

- [`docs/llm-dag-authoring.md`](./docs/llm-dag-authoring.md) — the primary authoring reference (node factories, constructors, `Result`, the `fugue` CLI). Start here.
- [`docs/examples/`](./docs/examples/) — runnable, lint-tested golden DAGs, one per shape. The canonical copy-paste source.
- [`docs/dag-type-system.md`](./docs/dag-type-system.md) — the type-system guarantees behind `defineDag`.
- [`docs/adapter-authoring.md`](./docs/adapter-authoring.md) — writing a capability adapter.

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

- `DagDef`, `DagDefInput`, `EdgeDef`, `EdgeDefInput`, `EdgeDefRawInput`, `Predicate` — the validated DAG shape and edge-predicate vocabulary (ADR 0015, ADR 0016).
- `NodeDef`, `NodeKind`, `NodeRetryConfig`, `NodeHumanReviewConfig` — node authoring contract.
- `Capability`, `BaseNodeContext`, `NodeContext`, `TypedNodeContext`, `NodeContextInit` — capability-typed `NodeContext`. Declare `requires` on a `NodeDef` and the `ctx` parameter is typed accordingly — `requires: ["llm"]` yields `ctx.llm: LlmClient` (non-null).
- `ClockCapability` plus the `systemClock` / `fixedClock` constructors — the `clock` capability (`requires: ["clock"]`); `fixedClock` pins time for deterministic tests, `systemClock` is the production default.
- `RunId`, `NodeId`, `DagId` plus the `runId`, `nodeId`, `dagId` smart constructors — branded identifiers; raw strings cross the boundary at the entry points (`defineDag`, `makeNodeContext`, `runDag`) and become branded once.
- `ContextCacheAdapter`, `CacheLookup`, `PromptAccess`, `Logger`, `Tracer` — pluggable seams.
- `ObserverEvent` (and the per-event types `RunStartEvent`, `NodeStartEvent`, `NodeEndEvent`, `NodeSkippedEvent`, `NodeErrorEvent`, `SubSpanEvent`, `RunEndEvent`, `RouteDecidedEvent`, `NodePrunedEvent`, `WitnessCapturedEvent`, `WriteAttemptedEvent`, `FreshnessViolationEvent`, `HumanInterventionEvent`), `SpanKind` — the typed event envelope flowing through the `Observer` interface (which lives under `observer/`).
- `Result`, `Ok`, `Err`, `ok`, `err`, `isOk`, `isErr`, `andThen`, `andThenAsync`, `map`, `mapAsync`, `mapErr`, `unwrapOr`, `fold`, `orElse`, `tryCatch`, `tryCatchAsync`, `sequenceFirst`, `sequenceAll`, `tap`, `tapErr`, `fromNullable` — the `Either` shape used everywhere errors are returned (no exceptions across module boundaries). (`unwrap` is available via direct path import for tests but intentionally excluded from the barrel.)
- `FrameworkError` (re-exported from `types/errors.js`) — discriminated error union.

Internal inference helpers (`ConsistentNodes`, `OutputOf`, `OutputsByNodeId`, `NodesRecord`) live in `types/dag-internals.ts` and are intentionally not re-exported.

### `executor/`

- `defineDag`, `defineDagFromArray`, `DagDefinitionError` — type-driven DAG constructor(s) with `outputNodeId` enforcement.
- `defineSources`, `SourcesDagConfig` — constructor for source-rooted DAGs; validates fan-in keys against source-node ids at definition time.
- `validateDagShape`, `recordFromNodeArray`, `withRetryLimits` — pure validation utilities. `withRetryLimits` returns `Result<DagDef, FrameworkError>` and re-enters the same parser, so unknown node IDs and invalid counts cannot launder the validation brand.
- `runDag`, `resumeRun`, `RunOptions` — execution entry points. Always route through the durable state machine (ADR 0021). `RunOptions` includes `jobLike`, `onHumanReview`, `onBackground`, `retryLimits`, and the ADR 0019 routing advisory toggle `suppressRoutingWarnings`. (`onTrace` is available on `RunOptions`.)

### `nodes/`

Built-in node factories (each declares its capability `requires`):

- `createFetchNode`, `FetchNodeConfig`
- `createSourceNode`, `SourceNodeConfig` — a root node that takes no DAG input (`z.void()`), for DAGs that begin from sources rather than `$input`
- `createTransformNode`, `TransformNodeConfig`
- `createHumanReviewNode`, `HumanReviewNodeConfig`, `withHumanReview` — human-in-the-loop gates (ADR 0060). `createHumanReviewNode` is a typed passthrough that pauses for a decision; `withHumanReview(node, { prompt })` gates any existing node. A gated node routes the run to the durable state machine (host supplies `RunOptions.onHumanReview`).
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

- `Checkpointer` interface plus `RunMeta`, `NodeState`, `RunState`, `InMemoryCheckpointer`, `RedisCheckpointer`. Both backends enforce framework-version stamping on resume — see the §"Versioning" section — and the `checkpoint-expired` / `checkpoint-corrupt` / `checkpoint-version-mismatch` error kinds.
- `dagFingerprint`, `FRAMEWORK_VERSION` — byte-stable DAG hash and the version constant stamped into checkpoint meta.

## State-machine kernel (durability core)

NFR-021. The kernel is the foundation of the runtime; most callers reach it via `runDag`.

- `Machine<S, E, C>`, `Executor<S, E, C>`, `JobLike<S, E, C>`, `RecordedEvent`, `RunOptions`, `TraceEvent`.
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

**Single-process constraint.** `resolveDependents` reads the process-local `activeRegistry` to look up downstream task configs when a parent fires. Multi-process deployments must either co-locate the scheduler with workers (so every node sees the same registry) or provide a shared `TaskRegistryStore` port — not yet implemented. See `docs/plans/2026-05-12-pass-4-followups.md` for the deferred work.

## NodeContext helpers

- `makeNodeContext` — capability-validated `NodeContext` constructor; declares which fields are present and which are typed-out.
- `consoleLogger`, `noopTracer`, `noopObserver` — always-present-default implementations of the non-capability seams.

## Boundary rules

Enforced by `scripts/check-imports.ts` and `__tests__/boundary-imports.test.ts`:

- `state-machine/**`, `dag-runtime/**`, and `scheduler/**` must not import `bullmq` / `ioredis` / `queue-bullmq/**`. Transport adapters live in `queue-bullmq/`; the kernel and scheduler stay transport-agnostic.
- `dag-runtime/**` must not import from `executor/**`. The reverse direction (`executor/` → `dag-runtime/`) is allowed: `executor/` is the public-API wrapper around the runtime.
- Pure-core modules (`state-machine/**`, `dag-runtime/transition.ts`, `dag-runtime/retry-policy.ts`, `dag-runtime/wave-resolution.ts`, `dag-runtime/human-resolution.ts`, `dag-runtime/machine.ts`) must not import `@opentelemetry/*`. Tracing belongs to the imperative shell.
- `shared/**` must not import `@opentelemetry/*`, `observer/**`, or `tracing/**`. Telemetry-aware helpers (`run-node.ts`, `node-span.ts`) moved into `dag-runtime/` during pass 3 — the only legitimate consumer. The two NodeContext-stub constructors (`shared/defaults.ts`, `shared/make-node-context.ts`) are exempted by `scopeExcludes`.

Adding a new layer? Add a rule. Adding a cross-layer import? It will fail CI.

## Public surface

- `@fuguejs/framework` — the recommended consumer barrel: `runDag`, observer/tracing init, node-authoring types.
- `@fuguejs/framework/advanced` — kernel-mode entry points (`runDagStateful`, `runDagAsWorkerJob`, `compileDagToMachine`, `buildDagExecutor`, `dagTransition`) for callers building custom machines on top of the framework. Reaching for these is a deliberate choice; the main barrel keeps them off the surface.
- `@fuguejs/framework/bullmq` — the BullMQ transport adapter (`createBullMQBackend`, `adaptBullMQJob`, `createRedisMarkerStore`, `createRedisStreamReader`). Pulls in the optional `bullmq` / `ioredis` peer deps; isolated off the main barrel so transport-agnostic consumers stay clean.
- `@fuguejs/framework/redis` — Redis-backed durable adapters (`RedisCache`, `RedisCheckpointer`, `RedisFreshnessIndex`). Requires the optional `ioredis` peer dep.
- `@fuguejs/framework/testing` — stable import path for test tooling (`FakeLlmClient`, `createFakeHttpCapability`).
- `setFrameworkLogger(...)` / `setFrameworkTracer(...)` — host-injectable logger + OTel tracer seams. Defaults are `console.*` and `trace.getTracer("fugue-framework")` respectively, matching prior behaviour; tests typically pass recording stubs.

## State-Transition Observability

Fugue implements Level 3 observability: for any production failure, a single event-log query answers *why the system believed the next step was safe*. Five primitives close the gap between "what happened" and "why it was believed safe":

1. **Side-effects taxonomy** — every node declares `none`, `reads`, `writes`, or `external-call` with a resource identifier. Required field on `NodeDef`.
2. **Bucketed confidence** — routing decisions carry colocated evidence: upstream output, confidence bucket (`high`/`medium`/`low`/`unknown`) with declared source, and per-predicate evaluation results.
3. **Freshness witness contract** — `reads` nodes emit version witnesses; `writes` nodes declare which witness they're conditioned on; framework detects stale-read→write skew and emits `FreshnessViolationEvent`.
4. **Human intervention telemetry** — `HumanInterventionEvent` captures what the human saw (confidence, side-effects, freshness state) alongside what they decided.
5. **MLflow tag promotion** — all signals promoted to filterable MLflow tags (`mlflow.route.*`, `mlflow.freshness.*`, `mlflow.human.*`, `mlflow.side_effects`).

See [`docs/observability/state-transitions.md`](../../docs/observability/state-transitions.md) for worked examples, dashboard queries, and node-author patterns.

## Test conventions

- Redis-gated tests use `process.env.REDIS_URL` to skip cleanly when no Redis is reachable.
- Property tests use `fast-check`.
- Boundary lints (`check-imports`) run in `bun run check`.

## Versioning

`FRAMEWORK_VERSION` (in `src/checkpoint/fingerprint.ts`) is stamped into every checkpoint meta row by `Checkpointer.write` and verified by `Checkpointer.read`. A mismatched value on resume returns `Err({ kind: "checkpoint-version-mismatch" })` rather than corrupting state silently. Bump it whenever validation, retry, or output-coercion semantics change. ADR 0017 records the most recent bump (`"1"` → `"2"`); the enforcement mechanism itself lives in `checkpoint/checkpointer.ts`.
