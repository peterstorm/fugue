# Observability Backends

Fugue emits two observability signals — execution **traces** and post-hoc **evaluation** scores — and each signal's backend is a **configuration-driven, fan-out-capable choice**. Without any code changes, a consuming application decides where each signal is sent: MLflow (the default for both signals), Azure AI Foundry, or — for traces — both at once.

This document is the single reference for **how to select** each backend, **how authentication works**, and the **fan-out / fault-isolation** behavior. For the trace pipeline internals see [tracing-pipeline.md](./tracing-pipeline.md); for the eval pipeline see [eval-pipeline.md](./eval-pipeline.md).

MLflow is never removed or degraded. With Foundry not enabled, MLflow behavior is byte-for-byte equivalent to today and all existing tests pass unchanged (FR-003/FR-027, SC-006).

---

## Selection Matrix

| Signal | Selector | Values | Default | Semantics |
|---|---|---|---|---|
| **Traces** | `OBSERVABILITY_TRACE_BACKENDS` (env / app config) | comma-separated `mlflow`, `foundry` | `mlflow` | one = exclusive export; two = dual export (fan-out) |
| **Evaluations** | `EVAL_BACKEND` (env) or `--backend` (CLI) | `mlflow` \| `foundry` \| `both` | `mlflow` | `both` runs both paths and checks parity |

### Trace backends (`OBSERVABILITY_TRACE_BACKENDS`)

A comma-separated list. **One** backend = exclusive export to that backend; **two** = the same spans fan out to both simultaneously (FR-002). MLflow is the default, so the unconfigured app behaves exactly as before (FR-003).

The value is validated at **startup, fail-closed** (FR-006): unknown tokens, blank entries, and duplicates are rejected with a clear error rather than silently ignored. It parses into a frozen, deduped, order-preserving tuple of backends.

```bash
# Default — MLflow only (identical to pre-Foundry behavior)
OBSERVABILITY_TRACE_BACKENDS=mlflow

# Foundry only (exclusive)
OBSERVABILITY_TRACE_BACKENDS=foundry

# Dual export — same spans to both, for migration / comparison
OBSERVABILITY_TRACE_BACKENDS=mlflow,foundry
```

Order is preserved (it determines the exporter list order), but export is concurrent so order does not affect delivery.

### Evaluation backend (`EVAL_BACKEND` / `--backend`)

The eval suite selects its backend at run time (FR-004). The `--backend` CLI flag **wins** over the `EVAL_BACKEND` env var, which defaults to `mlflow` (FR-005). `both` runs both scoring paths over the same results and enforces a parity tolerance (SC-005). See [eval-pipeline.md](./eval-pipeline.md#evaluation-backends-mlflow--azure-ai-foundry) for the full backend table, scorer-name parity, and the ±0.5 parity contract.

```bash
# Run from apps/customer-summary/ (so the default EVAL_CASES_PATH=fixtures/eval/cases.json resolves)
python3 eval/run.py --mode=full                      # mlflow (default)
python3 eval/run.py --mode=full --backend=foundry    # Foundry-native (azure-ai-evaluation)
EVAL_BACKEND=foundry python3 eval/run.py --mode=ci   # env selector; --backend overrides
python3 eval/run.py --mode=full --backend=both       # both + parity (±0.5)
```

---

## Authentication (Foundry traces)

Foundry's Tracing tab reads from an **Application Insights** resource, so the trace exporter authenticates to Application Insights. Two modes are supported, selected by `AZURE_AUTH_MODE`.

| Mode | `AZURE_AUTH_MODE` | Auth governed by | Connection string |
|---|---|---|---|
| Connection string (default) | `connection-string` | the connection string itself | **required** |
| Entra ID (opt-in) | `entra-id` | `DefaultAzureCredential` | **still required** |

### Connection string — default (FR-022)

The default authentication method is an Application Insights connection string supplied via configuration:

```bash
OBSERVABILITY_TRACE_BACKENDS=foundry
APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=…;IngestionEndpoint=https://….applicationinsights.azure.com/;…"
# AZURE_AUTH_MODE defaults to connection-string
```

A blank value (`APPLICATIONINSIGHTS_CONNECTION_STRING=`) is normalized to absent.

### Entra ID — opt-in (FR-023)

Entra ID authentication is opt-in via `AZURE_AUTH_MODE=entra-id`, using the standard default Azure credential mechanism (`DefaultAzureCredential` from `@azure/identity`) — managed identity, environment credentials, Azure CLI login, etc. When a credential is supplied it governs authentication, while the connection string still carries the ingestion endpoint.

```bash
OBSERVABILITY_TRACE_BACKENDS=foundry
AZURE_AUTH_MODE=entra-id
APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=…;IngestionEndpoint=https://….applicationinsights.azure.com/;…"
```

### A connection string is required even under Entra ID

This is the key, non-obvious rule: **a connection string must be supplied for *both* auth modes.** The Azure Monitor SDK needs it to locate the ingestion endpoint regardless of how authentication is performed — Entra ID governs *auth*, not *endpoint discovery*. Project-endpoint auto-discovery of the connection string is explicitly **out of scope** this iteration (FR-024); this iteration uses a connection string (default) or Entra ID (opt-in), and Entra ID still requires the connection string for the endpoint.

A `foundry` selection with no connection string is contradictory config and is rejected at **startup**, fail-closed (FR-006), with a clear message — not deferred to a silent drop at export time. The same invariant is re-checked defense-in-depth in the pure observability resolver (`resolveObservabilityBackends`) for any `Config` built outside the normal load path.

The Foundry exporter's auth config is modeled as a discriminated union so the empty-auth state (`{}`) is a **compile error**, not a runtime-only failure — at least one of {connection string, credential} is required by the type. The runtime guard exists only for the dynamic/env config boundary.

### Eval credentials are independent

The Foundry **evaluation** path authenticates separately, reusing the existing Azure OpenAI judge credentials (`AZURE_OPENAI_*`, FR-015). These are distinct from the Application Insights trace auth above. See [eval-pipeline.md](./eval-pipeline.md).

---

## Fan-out / Dual-Export Behavior

When two trace backends are selected, the framework wraps them in a `CompositeSpanExporter` that fans out each export to every child concurrently. The **same span instances** are delivered to every backend, so run / DAG / node identities are consistent across MLflow and Foundry (FR-011, SC-007).

Selecting exactly one backend introduces **no composite wrapper**: a one-element exporter list is unwrapped to the bare exporter, byte-for-byte identical to single-backend behavior (SC-006). See [tracing-pipeline.md](./tracing-pipeline.md#normalizeexporter-and-the-1-unwrap-byte-for-byte-guarantee).

Foundry consumes the framework's vendor-neutral `gen_ai.*` and framework-owned `ai.*` attributes (cost, node identity, DAG/run identity) **natively** — no translation or per-node instrumentation changes (FR-008/FR-009). Content-capture / PII gating (`LLM_TRACE_PROMPTS`) is applied **upstream** during span enrichment and applies equally to every backend (FR-012); the Foundry exporter never re-filters.

The existing **tail-sampling persistence policy** gates which traces are exported, applying equally to Foundry and MLflow (FR-010, SC-010): the count of traces Foundry ingests equals the count the policy admits, and a discarded trace produces **no** domain events.

### Domain events & metrics layer (Foundry)

When Foundry is enabled, an `AiFoundryObserver` records DAG **domain events** and **pre-aggregated metrics** to a Foundry / Application Insights telemetry sink (`FoundryTelemetrySink`), in addition to raw spans. The pure mapping (`foundry-event-mapping.ts`) is the functional core; the observer is the fail-tolerant I/O boundary and **never throws** — a misbehaving sink or mapping bug cannot break a run.

| Emission | Trigger | Dimensions |
|---|---|---|
| `fugue.run.summary` (event) | run-end | run duration, status, node count, retry count, cache-hit count (FR-019, SC-008) |
| `fugue.route.decision` (event) | route-decided | chosen / pruned targets, default-taken (FR-018) |
| `fugue.node.pruned` (event) | node-pruned | nodeId, reason (FR-018) |
| `fugue.run.latency_ms` (metric) | run-end | dimensioned by `dagId` (FR-020) |
| `fugue.node.latency_ms` (metric) | node-end | dimensioned by `dagId`, `nodeId` (FR-020) |
| `fugue.node.cache_hit` (metric) | **node-skipped with `reason=checkpoint`** | dimensioned by `dagId`, `nodeId` (FR-020) |

> **Cost and token usage are NOT on the domain-event channel — they reach Foundry via the span/trace channel.** This is a dual-channel architecture (see the two-signal split at the top of this document and [tracing-pipeline.md](./tracing-pipeline.md)). The run-summary event is produced by the app-layer run-summary bridge (`FoundryRunSummaryObserver` → `mapRunSummaryToFoundry`), which derives its `RunSummary` purely from observer events. That path knows nothing about LLM cost or tokens: it supplies only `cacheHitCount`, leaving `totalCostUsd` and `totalTokens` undefined. `mapRunSummaryToFoundry` therefore **drops** the run-summary's total-cost field and never emits the `fugue.run.cost_usd` or `fugue.run.tokens` metrics on the domain-event channel. Instead, LLM cost and token usage flow to Foundry on the **OTel span channel** — `ai.llm.cost_usd` on LLM spans and the `gen_ai.usage.*` token attributes (see the [source-of-truth split](./tracing-pipeline.md#source-of-truth-split)). (`mapRunSummaryToFoundry` *does* carry total cost when called with a `RunSummary` whose `totalCostUsd` is populated, but the shipped observer-derived path never populates it.)

So the domain-event run summary carries exactly: **run duration, status, node count, retry count, and cache-hit count.** A cache hit is recorded specifically on a **checkpoint skip** (`node-skipped reason=checkpoint`) — an `already-completed` skip is a retry-pass artifact, not a cache hit. Only finite numeric measurements are emitted (Application Insights rejects `NaN`/`Infinity`).

Domain-event and metric emission is governed by the **same persistence policy instance** as trace export, by wrapping the observer in a `BufferedObserver` that shares the tail-sampler's policy — so a discarded trace produces no orphaned domain events (FR-021, SC-010).

---

## Fault Isolation

A failing or slow observability backend MUST NOT fail or delay a DAG run; export errors are logged, not propagated (FR-025, SC-009). The guarantees:

- **Off the critical path.** All export — single, dual, and the domain-events/metrics layer — happens during the post-run tail-sampling flush, asynchronously. Enabling Foundry adds no measurable latency to run completion at p50/p95 (FR-028, SC-004).
- **One backend never affects another.** `CompositeSpanExporter` returns `SUCCESS` if **any** child succeeds and `FAILED` only if **every** child fails; a single dead backend is isolated, counted, and rate-limit-logged (FR-026, SC-007). One backend killed mid-run leaves the other receiving the run's traces and the run completing successfully.
- **A hung backend cannot wedge the pipeline.** Each child's export is bounded by a per-child settle deadline (`EXPORT_SETTLE_TIMEOUT_MS`, 30s); a non-firing callback is counted as that child's failure so the composite always settles.
- **Lifecycle never rejects.** `shutdown()` / `forceFlush()` fan out via `Promise.allSettled`; partial failure is logged at `warn`, and a total outage (every child failed) is additionally logged once at `error` so a full outage is distinguishable from full success.
- **The Foundry exporter logs but propagates** inner failures (warns, then forwards the original `ExportResult`) so the OTel SDK's own retry/backoff still observes the true outcome.
- **The domain-events observer never throws** — every mapping and sink call is wrapped and failures are logged.

For the exact policy and counters (`childFailureCounts`, rate-limited logging), see [tracing-pipeline.md](./tracing-pipeline.md#compositespanexporter-fan-out-and-fault-isolation).

---

## Configuration Reference

| Variable | Default | Scope | Description |
|---|---|---|---|
| `OBSERVABILITY_TRACE_BACKENDS` | `mlflow` | app | Comma-separated trace backend(s): `mlflow`, `foundry`. One = exclusive, two = dual export. Validated fail-closed at startup. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | — | app | Application Insights connection string. **Required** when `foundry` is selected — for both auth modes. |
| `AZURE_AUTH_MODE` | `connection-string` | app | `connection-string` (default) or `entra-id` (opt-in, `DefaultAzureCredential`). |
| `LLM_TRACE_PROMPTS` | `false` | app | PII gate: include prompts/outputs in spans (applies to every trace backend). |
| `EVAL_BACKEND` | `mlflow` | eval | `mlflow` \| `foundry` \| `both`. `--backend` CLI flag overrides. |
| `AZURE_OPENAI_*` | — | eval | Azure OpenAI judge credentials, reused by both eval backends. |

The Azure / Foundry SDK packages are **hard dependencies, always installed** (FR-029): every application carries the dependency weight in exchange for simpler, unconditional wiring — there is no optional/lazy-load path.
