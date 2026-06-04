# Fugue — Context & Ubiquitous Language

## Project Identity

**Fugue** is a DAG-shaped, durable runtime for LLM-bearing workflows. It provides
typed orchestration of multi-step AI pipelines with crash-resume, human-in-the-loop
gates, freshness-aware state management, and production observability.

## Ubiquitous Language

### Core Execution

| Term | Definition |
|------|-----------|
| **DAG** | A directed acyclic graph of nodes connected by edges. The unit of orchestration. |
| **Node** | A single computation step with typed input/output schemas, a declared side-effect profile, and a capability set. |
| **Edge** | A connection between nodes. Three kinds: `unconditional`, `conditional` (with a predicate), `default` (fallback when no conditional matches). |
| **Wave** | A set of nodes at the same topological depth that can execute concurrently. The DAG is compiled into an ordered sequence of waves. |
| **Run** | A single execution of a DAG with a specific input. Identified by a `RunId`. |
| **Phase** | The current state of a run: `pending`, `running`, `retrying`, `awaiting-human`, `retrying-hook`, `succeeded`, `failed`. |

### State Machine Kernel

| Term | Definition |
|------|-----------|
| **Machine** | A generic state machine: `transition(state, event, context) → (state, context)`. |
| **Executor** | An async function that observes the current phase and produces the next event. Lives in the imperative shell. |
| **Transition** | A pure function that computes the next (phase, context) from (phase, event, context). No I/O. |
| **JobLike** | Durable job handle: `updateData`, `updateProgress`, `appendEvent`. Backed by in-memory or BullMQ+Redis. |
| **Checkpoint** | A persisted snapshot of node outputs for crash-resume. |
| **Fingerprint** | A content-hash of DAG topology + predicate versions. Detects shape drift between checkpoint write and resume. |
| **FrameworkVersion** | Content-hash of the framework's runtime semantics (validation, retry, coercion). Resume rejects checkpoints from a different version to prevent silent behavioral drift. |

### Type Safety

| Term | Definition |
|------|-----------|
| **Branded ID** | `RunId`, `NodeId`, `DagId` — string newtypes with compile-time brands. Only smart constructors or `__brand` escapes produce them. |
| **Result\<T, E\>** | Either-style type: `Ok<T>` or `Err<E>`. No exceptions cross module boundaries. |
| **FrameworkError** | Discriminated union of 17+ error kinds, exhaustively formatted via `formatFrameworkError`. |
| **Capability** | A resource a node requires. Derived from `keyof CapabilityRegistry`. Built-ins: `"llm"`, `"cache"`, `"prompts"`, `"judgeLlm"`, `"http"`. Extensible via module augmentation (ADR-0051). Validated at run start before any node executes. |
| **CapabilityRegistry** | Extensible interface mapping capability names to client types. Adapter packages augment it via `declare module "@fuguejs/framework"`. |
| **CapabilityHandle\<K\>** | Runtime lifecycle wrapper: `{ name, client, connect?, close?, healthCheck? }`. Adapters produce these; runtime manages lifecycle. |
| **AdapterFactory\<K, C\>** | `(config: C) => CapabilityHandle<K>`. Standard factory shape for adapter packages. |
| **HttpCapability** | Built-in capability for HTTP API calls. Returns `Result`, validates responses against Zod schemas. |
| **ValidatedNodeContext** | Phantom-branded `NodeContext` proving capability validation passed. Only `validateCapabilities` can produce it. |

### Routing & Confidence

| Term | Definition |
|------|-----------|
| **Predicate** | A function-based routing condition on a node's output, with a label, version, and optional `minConfidence` gate. |
| **Confidence** | A branded value: `{ bucket, source, raw? }`. Never a bare number. Framework routes on bucket ordering, never compares raw values. |
| **ConfidenceBucket** | Semantic level: `"high"`, `"medium"`, `"low"`, `"unknown"`. Ordered for predicate gating. |
| **ConfidenceSource** | Provenance: `"self-reported-bucket"`, `"self-reported-numeric"`, `"logprob"`, `"classifier-probability"`, `"ensemble-agreement"`, `"heuristic"`. |
| **Decision** | The result of evaluating all outgoing predicates from a node: chosen targets, pruned targets, default-taken flag, and evidence. |
| **Evidence** | Colocated with every routing decision: upstream output, confidence, per-predicate results, timestamp. |

### Freshness & Witnesses

| Term | Definition |
|------|-----------|
| **Side-Effect Profile** | Declared on every node: `"none"`, `"reads"`, `"writes"`, `"external-call"`. Determines freshness tracking behavior. |
| **Witness** | A token asserting the version of a resource at a point in time: `{ kind, resource, value }`. |
| **Freshness Violation** | Detected when a write's `conditionedOn` witness has been superseded by a later write to the same resource. |
| **FreshnessIndex** | Port interface for witness tracking. Two adapters: `InMemoryFreshnessIndex` (single-process), Redis-backed (distributed). |

### Human-in-the-Loop (HITL)

| Term | Definition |
|------|-----------|
| **Human Review Gate** | A node declares `humanReview: { prompt }`. After execution, the run pauses in `awaiting-human`. |
| **HumanAction** | The reviewer's response: `"approve"`, `"approve-with-edit"`, `"reject"`, `"reroute"`. |
| **HumanInterventionEvent** | Phase 4 capstone: first-class telemetry capturing the full decision context (confidence, side-effects, prior witnesses). |

### Observability

| Term | Definition |
|------|-----------|
| **Observer** | Single-method interface: `observe(event: ObserverEvent): void`. 13 event types via discriminated union. |
| **ObserverEvent** | Union of: `run-start`, `node-start`, `node-end`, `node-skipped`, `node-error`, `sub-span`, `run-end`, `route-decided`, `node-pruned`, `witness-captured`, `write-attempted`, `freshness-violation`, `human-intervention`. |
| **BufferedObserver** | Accumulates per-run events, applies tail-sampling persistence policy, emits `RunSummary`. |
| **PersistencePolicy** | Combinable predicates (`alwaysOn`, `errorOnly`, `ratio`, `hadRetry`, `coldCache`, etc.) that decide whether a run's events are flushed to the exporter. |
| **Tracer** | OTel trace interface. Carries infrastructure telemetry (latency, token costs) — separate from Observer domain events. |

### Queue & Scheduling

| Term | Definition |
|------|-----------|
| **QueueBackend** | Port: `createQueue`, `createWorker`, `close`. Two adapters: in-memory, BullMQ. |
| **WorkerHandle** | `onFailed`, `onExhausted`, `onError`, `close`. Queue-level retry is distinct from DAG-level retry. |
| **CronScheduler** | Drives periodic DAG runs via a registry of `TaskConfig` entries with cron expressions. |
| **DeadLetterNotifier** | Called when a job exhausts all queue-level attempts. |

### Architecture Layers

| Layer | Imports From | Responsibility |
|-------|-------------|---------------|
| `types/` | Nothing | Domain types, branded IDs, discriminated unions |
| `shared/` | `types/` | Pure utilities (topo sort, validation, input assembly) |
| `dag-runtime/` | `types/`, `shared/` | Pure transitions + imperative execution shell |
| `state-machine/` | `types/` | Generic state machine kernel |
| `executor/` | `types/`, `shared/`, `dag-runtime/`, `state-machine/` | Public API (`defineDag`, `runDag`) |
| `llm/` | `types/` | LLM client implementations |
| `observer/` | `types/` | Observer implementations |
| `checkpoint/` | `types/` | Checkpoint persistence — in-memory + Redis adapter |
| `cache/` | `types/` | Response caching — in-memory + Redis adapter |
| `queue/` | `types/`, `state-machine/` | Queue abstractions |
| `queue-bullmq/` | `queue/`, `state-machine/` | BullMQ adapter |
| `tracing/` | `types/` | OpenTelemetry integration |

**Subpath exports.** The main barrel (`@fuguejs/framework`) is dependency-light. Adapters that pull heavy optional peer deps live behind dedicated subpaths so consumers who do not need them never load them:

| Subpath | Exports | Optional peer dep |
|---------|---------|-------------------|
| `@fuguejs/framework/redis` | `RedisCache`, `RedisCheckpointer`, `RedisFreshnessIndex` | `ioredis` |
| `@fuguejs/framework/bullmq` | BullMQ queue/worker adapters | `bullmq`, `ioredis` |

`check-imports.ts` enforces that `ioredis` is reachable only from `cache/redis-cache.ts`, `checkpoint/redis-*.ts`, and `queue-bullmq/`.

### Key Invariants

1. **No exceptions across module boundaries** — all errors are `Result<T, FrameworkError>`.
2. **Pure transition, impure execution** — `dagTransition` has no I/O; the executor owns all effects.
3. **Edges are the single source of truth** for topology (no `deps` field on nodes — ADR 0017).
4. **Predicates are never evaluated in the pure transition layer** — the executor pre-computes routing decisions and carries them on events (ADR 0029).
5. **Branded types prevent argument-swap bugs** — `RunId`, `NodeId`, `DagId` are incompatible at compile time.
6. **Capability validation happens once at run start** — before any `node.run` is called.
7. **Freshness is fail-closed** — extractor failures abort the wave; proceeding without witness data would allow stale writes.
8. **Pre-release: no backward-compat shims** — internal renames are first-class refactors, not aliased. No `@deprecated` re-exports for code that has not shipped.

### Host Layer (`@fuguejs/host`)

The host is the **imperative shell** that wires the framework into a production HTTP service.

| Component | Responsibility |
|-----------|---------------|
| `domain/host-state.ts` | Pure state machine: booting → ready → syncing → degraded → draining → stopped |
| `domain/registry.ts` | Immutable snapshot of loaded DAGs (frozen Map) |
| `domain/concurrency.ts` | Pure acquire/release with branded tokens |
| `domain/circuit-breaker.ts` | Pure closed/open/half-open state machine |
| `domain/circuit-guard.ts` | Protocol-enforcing permit token (check→execute→mark) |
| `domain/config.ts` | Zod-validated environment config with sensible defaults |
| `domain/host-error.ts` | 24-variant discriminated union, exhaustive HTTP mapping |
| `adapters/git-sync.ts` | Bun.spawn → git clone/pull/rev-parse with timeout |
| `adapters/module-loader.ts` | Dynamic import + validation + prompt loading |
| `adapters/node-context-factory.ts` | Constructs per-request NodeContext with DAG-namespaced keys |
| `adapters/token-store.ts` | Redis-backed team token persistence |
| `http/router.ts` | Hono app with route-level auth guards |
| `sync/sync-loop.ts` | Timer-driven git poll + registry rebuild |
| `lifecycle/startup.ts` | Boot sequence: Redis ping → clone → load |
| `lifecycle/signals.ts` | SIGTERM/SIGINT → drain → stop |
| `lifecycle/redis-probe.ts` | Post-boot Redis liveness probe → degraded/recovered transitions |
| `host.ts` | Top-level imperative shell wiring all subsystems |
| `main.ts` | Binary entry point (process.exit, real Redis, real git) |
