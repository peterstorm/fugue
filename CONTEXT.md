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
| **Phase** | The current state of a run: `pending`, `running`, `retrying`, `awaiting-human`, `suspended`, `retrying-hook`, `succeeded`, `failed`. |

### State Machine Kernel

| Term | Definition |
|------|-----------|
| **Machine** | A generic state machine: `transition(state, event, context) → (state, context)`. |
| **Executor** | An async function that observes the current phase and produces the next event. Lives in the imperative shell. |
| **Transition** | A pure function that computes the next (phase, context) from (phase, event, context). No I/O. |
| **JobLike** | Durable job handle: `updateData`, `updateProgress`, `appendEvent`. Backed by in-memory, BullMQ+Redis, or the file backend (`file/` subpath). |
| **Checkpoint** | A persisted snapshot of node outputs for crash-resume. |
| **Fingerprint** | A content-hash of DAG topology + predicate versions. Detects shape drift between checkpoint write and resume. |
| **FrameworkVersion** | Content-hash of the framework's runtime semantics (validation, retry, coercion). Resume rejects checkpoints from a different version to prevent silent behavioral drift. |

### Type Safety

| Term | Definition |
|------|-----------|
| **Branded ID** | `RunId`, `NodeId`, `DagId` — string newtypes with compile-time brands. Only smart constructors or `__brand` escapes produce them. |
| **Checkpoint identifier ownership** | The `Checkpointer` port is typed with branded identifiers end-to-end (`saveNode(runId: RunId, state: NodeState)`, `NodeState.nodeId: NodeId`, `RunMeta.dagId: DagId`) — `state.nodeId` is the ONE node address source, so a mismatched key/state pair is unrepresentable. Adapters KEEP runtime re-validation: a brand bypass is possible, and the file backend re-validates for path safety (NFR-010). `DagId` is the stricter domain (no `:` — Redis key-namespace escape). `DagDef.id` stays `string` at the authoring surface; consumers bridge with `dagId(dag.id)` (deepening round D1). |
| **Corrupt Checkpoint Address** | A dropped per-node checkpoint entry’s discriminated address: `{ kind: "node-key", nodeKey }` when a stored node key is recoverable, or `{ kind: "digest-filename", fileName }` when only the file address is known. `RunState.corruptNodeAddresses` never erases this distinction. |
| **Required Corruption Observability** | Persisted Checkpointer adapters must emit a warning before reporting a corrupt-entry drop as successful. `reportCorruptCheckpointEntry` owns the policy: a logger failure becomes typed `cache-error(load)` for both Redis and file; it never rejects raw or disappears. |
| **Result\<T, E\>** | Either-style type: `Ok<T>` or `Err<E>`. No exceptions cross module boundaries. |
| **FrameworkError** | Discriminated union of 27 error kinds, exhaustively formatted via `formatFrameworkError`. The framework also owns `PersistedFrameworkErrorSchema`, the loose exhaustive wire parser composed by persistence adapters; adapters do not redeclare the error ADT. |
| **Capability** | A resource a node requires. Derived from `keyof CapabilityRegistry`. Built-ins: `"llm"`, `"cache"`, `"prompts"`, `"judgeLlm"`, `"http"`, `"clock"`. Extensible via module augmentation (ADR-0051). Validated at run start before any node executes. |
| **CapabilityRegistry** | Extensible interface mapping capability names to client types. Adapter packages augment it via `declare module "@fuguejs/framework"`. |
| **CapabilityHandle\<K\>** | Runtime lifecycle wrapper: `{ name, client, connect?, close?, healthCheck? }`. Adapters produce these; runtime manages lifecycle. |
| **AdapterFactory\<K, C\>** | `(config: C) => CapabilityHandle<K>`. Standard factory shape for adapter packages. |
| **HttpCapability** | Built-in capability for HTTP API calls. Returns `Result`, validates responses against Zod schemas. |
| **ClockCapability** | Built-in `"clock"` capability. Nodes read time through `ctx.clock` instead of ambient `Date`; `systemClock` is the production default, `fixedClock` pins time for deterministic tests. |
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
| **FreshnessIndex** | Port interface for witness tracking. Conflict lookup and durable logical-write acknowledgement are separate questions: `findConflict` selects the latest write, while `hasRecordedWrite` addresses `(runId, nodeId, executionEpoch, newWitness)` even after supersession. Three adapters: `InMemoryFreshnessIndex` (single-process), Redis-backed (distributed), file-backed (digest-addressed singletons, `file/` subpath). |
| **Freshness Completion Proof** | Durable set of node IDs whose post-wave freshness bookkeeping completed. It is distinct from node outputs because output persistence can precede witness emission; retries and replacement workers use this proof to emit only genuinely outstanding bookkeeping. |
| **Freshness Execution Epoch** | Durable non-negative generation stamped onto every write witness. Bookkeeping retries preserve the epoch; each valid HITL reroute increments it before replacement work executes, so a same-valued re-execution is distinct from an ambiguously acknowledged retry. |
| **`checkFreshness` (batch)** | The same stale-read rule in BATCH form over an event log. Off the runtime path — used for post-hoc forensics and as the differential oracle a property test checks `InMemoryFreshnessIndex` against, so the rule cannot drift between the two implementations. Not exported from the package barrel. |

### Human-in-the-Loop (HITL)

| Term | Definition |
|------|-----------|
| **Human Review Gate** | A node declares `humanReview: { prompt }`. After execution, the run pauses in `awaiting-human`. |
| **HumanAction** | The reviewer's response: `"approve"`, `"approve-with-edit"`, `"reject"`, `"reroute"`. |
| **HumanInterventionEvent** | Phase 4 capstone: first-class telemetry capturing the full decision context (confidence, side-effects, prior witnesses). |
| **Run Owner Team** | Immutable resource owner captured from the registered DAG when a durable HITL run is accepted. Historical status, approval authorization, and review routing use this persisted team; later DAG reassignment/removal cannot transfer access. |
| **Run Lease** | Runtime-authenticated, run-bound worker ownership capability. One composition-owned authority exposes separate issuer and verifier capabilities backed by a private WeakMap: the queue receives only issuance, stores receive only verification, and another authority cannot recognize or reissue the lease. The Redis owner token is absent from the value; every HITL checkpoint/status write proves issuance and atomically verifies the hidden token, while renewal failure aborts the active slice. |
| **Pending Review Delivery** | Durable gate-notification state: `notification-required` until delivery succeeds, then atomically `notified`. Failed delivery remains retriable and cannot produce a suspended but unnotified run. Team-routed delivery fails closed when the Run Owner Team has no stored conversation; it never falls back to another/default channel. |
| **Run Publication Uncertainty** | A conservative accepted creation outcome used when Redis metadata acknowledgement is lost and exact removal/absence cannot be proved. Acceptance requires either published metadata or a confirmed **Run Creation Intent** in the active index, so wakeup/reconciliation can always reconstruct the queued run. |
| **Run Creation Intent** | A losslessly serialized Redis checkpoint envelope containing the initial lifecycle metadata and framework checkpoint. It starts as a non-runnable preparation; only an explicitly promoted recovery intent may substitute for missing metadata after an ambiguous publication acknowledgement. |

### Multi-Tenant Lifecycle

| Term | Definition |
|------|------------|
| **Tenant Purge Lease** | Runtime-proven reservation of one exact deregistration tombstone. The registry refuses revival/reconfiguration while the lease is active; only its holder may hard-delete after all idempotent footprint steps succeed. Partial failure releases the lease but retains the tombstone for retry. |
| **Tenant-Owned Root** | A canonical filesystem path rooted at the tenant-id namespace: `fsRoot` is `/srv/<tenantId>` or a descendant; `dagsRoot` is `/dags/<tenantId>` or a descendant. Registration rejects host paths, aliases, and sibling-tenant roots before either recursive purge or DAG discovery can receive them. |

### Observability

| Term | Definition |
|------|-----------|
| **Observer** | Single-method interface: `observe(event: ObserverEvent): void`. 13 event types via discriminated union. |
| **ObserverEvent** | Union of: `run-start`, `node-start`, `node-end`, `node-skipped`, `node-error`, `sub-span`, `run-end`, `route-decided`, `node-pruned`, `witness-captured`, `write-attempted`, `freshness-violation`, `human-intervention`. |
| **BufferedObserver** | Accumulates per-run events, applies tail-sampling persistence policy, emits `RunSummary`. |
| **PersistencePolicy** | Combinable predicates (`alwaysOn`, `errorOnly`, `ratio`, `hadRetry`, `anyOf`, `allOf`, `custom`) that decide whether a run's events are flushed to the exporter. |
| **Tracer** | OTel trace interface. Carries infrastructure telemetry (latency, token costs) — separate from Observer domain events. |

### Queue & Scheduling

| Term | Definition |
|------|-----------|
| **QueueBackend** | Port: `createQueue`, `createWorker`, `close`. Two adapters: in-memory, BullMQ. |
| **WorkerHandle** | `onFailed`, `onExhausted`, `onError`, `close`. Queue-level retry is distinct from DAG-level retry. |
| **CronScheduler** | Drives periodic DAG runs via a registry of `TaskConfig` entries with cron expressions. |
| **DeadLetterNotifier** | Called when a job exhausts all queue-level attempts. |

### File-Backed Durable Runtime (`file/` subpath)

The F6 feature (ADRs 0075–0080) adds a self-contained durable filesystem backend behind the dedicated `@fuguejs/framework/file` subpath: node built-ins only, no optional peer deps (FR-041).

| Term | Definition |
|------|-----------|
| **Event Log (file)** | The durable append-only journal: `events/NNNNNN-<digest>.json` records with contiguous 6-digit sequences and keyed/keyless digest addressing. The authoritative history (ADR-0076). |
| **Checkpoint Projection (file)** | The lagging `checkpoint.json` + per-node files under `<runId>/nodes/`. May lag the log inside the benign lag window; the log always wins on resume (ADR-0077). |
| **Append Lock** | The per-directory `events/append.lock` — a rename-born lock serializing the whole append transaction (list → dedup → sequence → commit) across processes (ADR-0078). |
| **Benign Lag Window** | The window in which the log holds records not yet folded into the checkpoint. Proved harmless by the resume agreement proof — never a corruption (ADR-0077). |
| **Resume Agreement Proof** | The pure `proveResumeAgreement`: full-replay vs checkpoint state-key comparison plus a single-pass strict-prefix scan (genesis included). Closed verdicts: agreement / benign lag / `checkpoint-missing` / `checkpoint-corrupt` (ADR-0077). |
| **Digest Addressing** | Record and node filenames are sha256 hex digests: keyed `sha256(dedupKey)` vs keyless `sha256(sequence ‖ eventJson)` — structurally disjoint by the `|` exclusion; 6-digit lexicographic sequence ceiling (ADR-0076). |
| **Composite Node Address** | `namespace@nodeId@index@attempt` checkpoint addressing with canonical folding; canonical IDs and composite keys are disjoint because `@` is outside the ID charset (ADR-0075). |
| **Freshness Singleton (file)** | Exactly one resource file, `<sha256(resource)>.json`: score-monotonic latest-conflict candidate (max `succeededAtMs`, Redis reverse-binary tie order) plus a TTL-bounded logical-write acknowledgement key set committed in the same atomic replacement. It uses a 24h lazy TTL and refresh-on-every-success (ADR-0079). |
| **FileOperation** | The closed `cache-error` operation vocabulary of the file backend; every file failure is a typed `FrameworkError` whose operation comes from this set (ADR-0080). |

**Deepening-round decisions (2026-08-18).** The interface advisories deferred across review rounds 10–16 were adjudicated once, in a `file/` + `Checkpointer`-port deepening round (plan: `.claude/plans/2026-08-18-file-port-deepening-round.md`):

- **Identifier ownership (D1)** — the port re-typed to branded `RunId`/`NodeId`/`DagId` (see *Checkpoint identifier ownership* under Type Safety).
- **One truthful-branding path (D2)** — `checkpoint-write-failed` is constructed by ONE builder (`buildCheckpointWriteFailed`, `types/error-factories.ts`); the codec re-exports it. The per-backend error-KIND divergence documented in the port's mapping table is a deliberate ADR-0080 surface, not a mirror.
- **Composite-key error channels (D3)** — `parseCompositeNodeKey → … | null` is the read-side classifier over untrusted stored bytes; `CompositeNodeKeyOpts` makes namespace-only input unrepresentable for typed callers while `compositeNodeKey` retains a runtime invariant throw for forged input; the file boundary converts that to the port-level typed `Result`. The contract is pinned in the module header and ADR-0075.
- **Test-owned store (D4)** — `InMemoryCheckpointer` exposes no accessor to its internals; tests adopt a `Map` at construction (`testStore`) and seed stored records directly — the Redis-raw-set analog. Alias-ing the adapter's live internals is unrepresentable.
- **Depth ceiling is a grammar knob (D5)** — `MAX_SAFE_RECORD_DEPTH` (512) lives in the serializer grammar module (`state-machine/serialize.ts`), with the grammar it bounds. The two write-side FR-009 losslessness pre-scans (journal events, node outputs) keep their per-module pinned message corpora, but their accept/reject VERDICTS are pinned to agree on a shared hostile + safe corpus (`losslessness-parity.test.ts`) — drift fails the build.
- **Two clock domains (D6)** — the raw-ms guards (journal `recordedAtMs`, freshness `writtenAtMs`/`sinceMs`) are finiteness-only: the value is STORED as a raw number and consumed by arithmetic, so `Date` representability is out of domain. The ms→Date guards (both checkpointers' `readClock`, the codec serializers' timestamp checks) share ONE encoding, `isRepresentableTimestampMs` (`types/clock.ts`). `±1e300` is the discriminator row (raw-ms accepts, ms→Date rejects), pinned in `clock-parity.test.ts`.

**Plan decision codes.** The F6 plan's `AD-1`…`AD-6` codes — cited in `file/*` and `checkpoint/*` comments — map to the ADRs one-to-one:

| Plan code | ADR |
|-----------|-----|
| AD-1 | ADR-0075 — composite checkpoint node-key encoding |
| AD-2 | ADR-0076 — on-disk layout, digest-filename adaptation |
| AD-3 | ADR-0077 — resume agreement proof (carries the numbered proof steps) |
| AD-4 | ADR-0078 — journal single-writer contract and append serialization |
| AD-5 | ADR-0079 — file FreshnessIndex |
| AD-6 | ADR-0080 — failure surface |

(Other features' AD codes — e.g. the queue-bullmq/state-machine AD-3/AD-4 references — belong to their own spec's plan and are not part of this mapping.)

(FR/SC/NFR numbers in host-pod comments (`packages/host/src/supervisor/`) and app comments (`apps/customer-summary/src/`) cite their owning spec and are qualified in the code as `<spec> FR-xxx` — `multi-tenant spec FR-xxx` (2026-06-18 single-host), `observability spec FR-xxx` (2026-05-30 Foundry), `F6 spec FR-xxx`, `host spec FR-xxx` (2026-05-20), `ai-summary spec FR-xxx` (2026-04-28), `keycloak-entra spec NFR-xxx` (2026-06-16). The specs assign the same numbers to different requirements (e.g. multi-tenant FR-028 = audit records, F6 FR-028 = corrupt-node drop, observability FR-028 = off-critical-path export), so an unqualified number grep returns several meanings — the qualification in the comment is the disambiguation. A grouped citation takes one qualifier for the group: `(multi-tenant spec FR-032, SC-011)`.)

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
| `file/` | `types/`, `checkpoint/`, `state-machine/` | Durable file backend: event journal, checkpointer, freshness index, job, resume (subpath `@fuguejs/framework/file`) |
| `cache/` | `types/` | Response caching — in-memory + Redis adapter |
| `queue/` | `types/`, `state-machine/` | Queue abstractions |
| `queue-bullmq/` | `queue/`, `state-machine/` | BullMQ adapter |
| `tracing/` | `types/` | OpenTelemetry integration |

**Subpath exports.** The main barrel (`@fuguejs/framework`) is dependency-light. Adapters that pull heavy optional peer deps live behind dedicated subpaths so consumers who do not need them never load them:

| Subpath | Exports | Optional peer dep |
|---------|---------|-------------------|
| `@fuguejs/framework/redis` | `RedisCache`, `RedisCheckpointer`, `RedisFreshnessIndex` | `ioredis` |
| `@fuguejs/framework/bullmq` | BullMQ queue/worker adapters | `bullmq`, `ioredis` |
| `@fuguejs/framework/file` | File backend: journal, checkpointer, freshness index, job, resume | none (node built-ins only — FR-041) |

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
9. **Clock guards follow the storage domain** — raw-ms values are finiteness-guarded only; ms→Date values are guarded for finiteness AND representability (`isRepresentableTimestampMs`). The two-domain split is a pinned invariant (`clock-parity.test.ts`), not a convention.

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
| `domain/host-error.ts` | Discriminated union of host errors, exhaustively mapped to HTTP status via `httpStatusFor` |
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

**HITL subsystem (`hitl/`).** Durable human-review suspend/resume (ADR-0060).

| Component | Responsibility |
|-----------|---------------|
| `hitl/service.ts` | Suspend/resume orchestration: park a run, resolve a decision, resume execution |
| `hitl/human-review-hook.ts` | Bridges the framework's `onHumanReview` hook to the durable run store |
| `hitl/run-store-job.ts` / `adapters/run-queue.ts` / `run-store.ts` / `run-executor.ts` | BullMQ-over-Redis durable run queue, store, and resume worker |
| `hitl/identity.ts` | Binds the approving identity to the resolved decision |
| `hitl/adapters/webhook-notifier.ts` / `bot/` | Teams approval transports — deep-link webhook and in-Teams Bot Framework cards |

**Identity-scoped capabilities (`adapters/`).** Per-identity capability brokering (ADRs 0051–0059).

| Component | Responsibility |
|-----------|---------------|
| `adapters/keycloak-broker.ts` / `keycloak-token-endpoint.ts` | Mint a downscoped per-identity token via Keycloak Standard Token Exchange |
| `adapters/entra-wif.ts` | Entra workload-identity-federation exchange for MS Graph access |
| `adapters/graph-capability.ts` | Identity-scoped MS Graph document capability |
| `adapters/metered-llm.ts` | LLM capability wrapper that meters token usage per identity |
| `adapters/broker-audit.ts` | Audit trail for brokered capability grants |
