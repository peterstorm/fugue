# MLflow OTLP Tracing Pipeline

## Overview

The framework exports traces via the **OpenTelemetry Protocol (OTLP)**. Span attributes follow the **OTel GenAI semantic conventions** (`gen_ai.*`) wherever the spec covers what we're emitting, with a small framework-owned `ai.*` namespace for things the spec doesn't address (cost, DAG/run/node identity, guardrail outcomes). See ADR 0023.

The default exporter targets MLflow's OTLP endpoint (`POST /v1/traces`); any other GenAI-aware OTLP backend (Phoenix, Langfuse, Honeycomb, Tempo) works by swapping the exporter in bootstrap — the framework emits standard names.

No `@mlflow/core` dependency — uses pure `@opentelemetry/api` and `@opentelemetry/sdk-node`.

## Source-of-truth split

| Source of truth | Attribute / event |
| --- | --- |
| `gen_ai.*` (OTel GenAI semconv) | `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.request.{temperature,top_p,max_tokens}`, `gen_ai.response.{model,id,finish_reasons}`, `gen_ai.usage.{input,output}_tokens`, `gen_ai.tool.{name,call.id,type,call.arguments,call.result}`, `error.type`, events `gen_ai.{system,user,assistant}.message` |
| `ai.*` (framework-owned) | `ai.llm.cost_usd`, `ai.llm.has_thinking`, `ai.guardrail.passed`, `ai.node.{id,kind}`, `ai.span.type`, `ai.dag.id`, `ai.run.id`, event `ai.llm.cost`, events `ai.node.{input,output}` |

Constants live in `packages/framework/src/tracing/semantic-conventions.ts`. Call sites import from there rather than using string literals.

## Architecture

```
tracer.startActiveSpan() creates OTel spans
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  NodeSDK with TailSamplingProcessor                 │
│                                                     │
│  TailSamplingProcessor                              │
│     └─ Buffers ALL spans per-trace                  │
│     └─ On root span end: evaluate PersistencePolicy │
│     └─ If flush → MlflowOtlpExporter               │
│     └─ If discard → cleanup SpanAttributeRegistry   │
└─────────────────────────────────────────────────────┘
         │
         ▼ (on flush)
┌─────────────────────────────────────────────────────┐
│  MlflowOtlpExporter                                 │
│  1. Read SpanAttributeRegistry for each span        │
│  2. Inject object attrs onto ReadableSpan.attributes│
│  3. Forward to OTLPTraceExporter (protobuf)         │
│     → POST /v1/traces with x-mlflow-experiment-id   │
└─────────────────────────────────────────────────────┘
         │
         ▼ (MLflow server)
┌─────────────────────────────────────────────────────┐
│  MLflow OTLP handler → log_spans()                  │
│  - Creates/merges trace_info                        │
│  - Stores spans in `spans` table                    │
│  - Extracts mlflow.llm.cost → span_metrics table   │
│  - Extracts mlflow.chat.tokenUsage → trace_metrics  │
└─────────────────────────────────────────────────────┘
```

## Span Creation

Spans are created with `tracer.startActiveSpan()` from `@opentelemetry/api`. The executor creates:

- **Root span**: `run:{dagId}` with `mlflow.spanType = "CHAIN"`
- **Node spans**: `node:{nodeId}` with `mlflow.spanType` mapped from node kind (LLM→"LLM", fetch→"RETRIEVER", etc.)
- **Eval-judge spans**: `eval-judge:{id}` with `mlflow.spanType = "TOOL"`

Inputs/outputs are stored via `SpanAttributeRegistry` as `mlflow.spanInputs` / `mlflow.spanOutputs` (object attributes that OTel SDK would reject as primitives).

## The Object Attribute Problem

OTel's JS SDK only accepts primitive attribute values (`string | number | boolean | Array<...>`). Calling `span.setAttribute("mlflow.llm.cost", {input_cost: 0.001})` is silently dropped.

MLflow's server expects `mlflow.llm.cost` as a **structured object** (decoded from protobuf `kvlist_value`).

### Solution: SpanAttributeRegistry

A side-channel registry stores object-valued attributes keyed by `spanId`. The framework emits *only* primitive `gen_ai.*` and `ai.*` attributes — the MLflow exporter derives the object-valued `mlflow.*` attributes from those primitives and stores them in the registry:

```typescript
// In mlflow-otlp-exporter.ts (indexDerivedAttrs):
SpanAttributeRegistry.set(spanId, {
  "mlflow.llm.cost":        { input_cost, output_cost, total_cost }, // from ai.llm.cost event
  "mlflow.chat.tokenUsage": { input_tokens, output_tokens, total_tokens }, // from gen_ai.usage.*
  "mlflow.spanInputs":      { system_prompt, user_prompt, ... }, // from gen_ai.{system,user}.message events
  "mlflow.llm.model":       attrs[GEN_AI_REQUEST_MODEL],
  "mlflow.llm.provider":    attrs[GEN_AI_SYSTEM],
});
```

At export time the exporter wraps each `ReadableSpan` in a `Proxy` whose `attributes` getter merges the registry entry on top of the underlying primitive attributes — the original span object is never mutated. The `otlp-transformer` handles objects natively (emits `kvlist_value`), bypassing the SDK's validation.

### Declarative translator tables

The MLflow translation logic in `mlflow-otlp-exporter.ts` is two tables:

- `ATTR_MAP` — simple `from → to` attribute renames (e.g. `gen_ai.request.model → mlflow.llm.model`).
- `EVENT_HANDLERS` — events whose payloads merge into MLflow's object-valued attributes (`gen_ai.system.message → mlflow.spanInputs.system_prompt`, etc.).

Adding a new vendor adapter (Langfuse, Phoenix) is a copy-paste-and-edit operation on these tables — no framework changes required.

## Tail-Based Sampling

The `TailSamplingProcessor` implements trace-level sampling:

1. **Buffers** all spans per-trace as they end
2. **Decides** when the root span ends (no parent span ID)
3. **Evaluates** the `PersistencePolicy` with a `RunSummary` (error?, retries?, cost)
4. **Exports** all buffered spans if policy says flush, or discards them

This enables decisions based on the complete trace outcome (errors, retries, cost) rather than head-based sampling.

Currently configured as `anyOf(errorOnly(), hadRetry(), ratio(0.1))` — traces with errors or retries always flush; the rest are tail-sampled at `TRACE_SAMPLE_RATIO` (default `0.1`).

## Key Files

| File | Purpose |
|------|---------|
| `packages/framework/src/tracing/semantic-conventions.ts` | Source-of-truth constants for `gen_ai.*` and `ai.*` names |
| `packages/framework/src/tracing/span-attribute-registry.ts` | Side-channel for object-valued MLflow attributes |
| `packages/framework/src/tracing/mlflow-otlp-exporter.ts` | Translator tables + OTLP forwarder |
| `packages/framework/src/observer/tail-sampling-processor.ts` | Buffers spans, applies persistence policy |
| `packages/framework/src/tracing/init.ts` | Wires pipeline (single processor) |
| `packages/framework/src/tracing/span-enrich.ts` | Emits cost + prompt events on the active LLM span |
| `packages/framework/src/llm/spans.ts` | `withLlmSpan`/`withToolSpan` + GenAI attribute helpers |

## Configuration

```typescript
import { initTracing, createMlflowExporter, anyOf, errorOnly, hadRetry, ratio } from "@fugue/framework";

const exporter = createMlflowExporter({ url: "http://mlflow:5000", experimentId: "0" });

const handle = await initTracing({
  exporter,
  policy: anyOf(errorOnly(), hadRetry(), ratio(0.1)),
});
```

`TracingConfig` takes `{ exporter, policy }` — there is no `trackingUri`/`experimentId` on it. The MLflow tracking server and experiment are configured on the exporter: `createMlflowExporter({ url, experimentId })`. The exporter's `url` is the OTLP endpoint base — the exporter POSTs to `{url}/v1/traces` — and `experimentId` is sent as the `x-mlflow-experiment-id` header. The `exporter` field also accepts a non-empty list of exporters for multi-backend export (see [Multi-Backend Trace Export](#multi-backend-trace-export-mlflow--azure-ai-foundry)).

## Why Not Use MlflowSpanExporter?

The `@mlflow/core` JS SDK's `MlflowSpanExporter` uses a different path:
- `POST /api/3.0/mlflow/traces` (StartTraceV3) — creates trace metadata in SQL
- `PUT .../traces.json` — uploads spans as JSON artifacts

This path **does not populate `span_metrics`** because:
1. Spans are stored as artifacts, not parsed by `log_spans()`
2. The server never extracts `mlflow.llm.cost` from artifact data
3. The Cost Breakdown card queries `span_metrics` which remains empty

The OTLP path (`POST /v1/traces`) goes through `log_spans()` which extracts cost from span attributes and writes to `span_metrics`.

## Multi-Backend Trace Export (MLflow + Azure AI Foundry)

The trace pipeline is **fan-out capable**: the same persisted spans can be delivered to one trace backend (exclusive) or to two simultaneously (dual export, for migration/comparison). Backend selection is configuration-driven — no code changes (FR-001/FR-002). MLflow remains the default; Foundry is opt-in.

```
TailSamplingProcessor  ─── flush ──▶  normalizeExporter(config.exporter)
                                            │
              ┌─────────────────────────────┼──────────────────────────────┐
              ▼                             ▼                              ▼
   single SpanExporter           one-element list  [E]          list of N≥2  [A, B, …]
   (used as-is, no wrapper)      (unwrapped to bare E,           (wrapped in
                                  byte-for-byte identical)        CompositeSpanExporter)
```

### `normalizeExporter` and the `[1]`-unwrap byte-for-byte guarantee

`initTracing` accepts a widened exporter config — `SpanExporter | readonly [SpanExporter, ...SpanExporter[]]` — and collapses it to the single `SpanExporter` the `TailSamplingProcessor` consumes. `normalizeExporter` is a **pure function** (functional core, trivially unit-testable):

- a single exporter is used **as-is** — no wrapper introduced;
- a **one-element list** `[E]` is unwrapped to the bare exporter `E` — the export pipeline is then **byte-for-byte identical** to passing `E` directly, with no `CompositeSpanExporter` in the path. This is the critical no-regression guarantee (SC-006): selecting exactly one backend leaves the existing MLflow path unchanged;
- a list of **two or more** is wrapped in a `CompositeSpanExporter`;
- an **empty list** is rejected. The public type models the list as a *non-empty tuple*, so `exporter: []` is a compile error at literal call sites; the runtime check is defense-in-depth for dynamically-built lists crossing the untyped config boundary.

### The Azure AI Foundry exporter

`createAzureMonitorExporter` wraps the official `AzureMonitorTraceExporter` and forwards spans to an Application Insights resource — Foundry's Tracing tab reads from Application Insights. Unlike the MLflow exporter, this is a **pure pass-through**:

- Foundry consumes the framework's vendor-neutral `gen_ai.*` semantic attributes and framework-owned `ai.*` enrichment (cost, node identity, DAG/run identity) **natively** — no translation, no per-node instrumentation changes (FR-008/FR-009). The exporter's `ATTR_MAP` is intentionally **empty**, so `translateSpanForFoundry` is the identity function and spans flow through unmodified. The table exists only as a documented seam for a hypothetical future Foundry-specific rename.
- It **does NOT re-filter content**. Content-capture / PII gating (FR-012) is applied **upstream** in `span-enrich.ts` via the configured `ContentFilter`; by the time a span reaches `export()`, redaction has already happened.
- Failure contract is **log-but-propagate**: on an inner failure it warns via `fwLogger` then forwards the original `ExportResult` unchanged, so the OTel SDK's own retry/backoff still sees the true outcome.

Auth is a discriminated-union config (`{ auth } | { createInner }`) so the empty-auth state is unrepresentable at compile time. See [observability-backends.md](./observability-backends.md) for the connection-string (default) vs. Entra ID (opt-in) auth modes.

### `CompositeSpanExporter` fan-out and fault isolation

When two or more backends are selected, `CompositeSpanExporter` fans out each `export()` to every child concurrently, handing **the same span instances** to every child so run / DAG / node identities stay consistent across backends (FR-011, SC-007). It is vendor-neutral — it knows only the OTel `SpanExporter` contract; all vendor logic lives in the per-vendor child exporters.

Its fault-isolation policy guarantees one backend can never affect another (FR-025/FR-026, SC-009):

- **SUCCESS-unless-all-fail.** The aggregate result is `SUCCESS` if **at least one** child succeeds, and `FAILED` only if **every** child fails (with an aggregated error). A single dead backend therefore does not inflate `exportFailed`, while a total outage is still surfaced. Both fail-fast and always-SUCCESS were explicitly rejected.
- **Per-child settle deadline.** Each child's callback-based `export` is bounded by `EXPORT_SETTLE_TIMEOUT_MS` (30s). A child whose callback never fires — hung socket, DNS black-hole, never-resolving promise — is counted as **that child's failure** after the deadline so the composite always settles and can never wedge the flush/shutdown boundary. A single fire-once latch shared across the real callback, the synchronous-throw path, and the deadline timer ensures a child settles exactly once (no double-counting).
- **Synchronous throws are isolated** — caught, logged, counted as that child's failure, never rethrown.
- **`shutdown()` / `forceFlush()` never reject.** They fan out via `Promise.allSettled`; per-child rejection is logged at `warn`, and a **total outage** (every child rejected) is additionally logged once at `error` so a full outage is distinguishable from full success rather than masked.
- **`childFailureCounts`** exposes cumulative per-child export-failure counts for health checks. Per-child failure logging is rate-limited to true powers of ten (occurrences 1, 10, 100, …) to surface a misbehaving backend on first occurrence without spamming under high span volume.

### No MLflow regression

Because the `[1]`-unwrap removes any composite wrapper for single-backend configs, and because the Foundry exporter is an additive sibling that never touches the MLflow exporter, MLflow output is byte-for-byte equivalent to pre-multi-backend behavior when Foundry is not enabled (SC-006). All existing tests pass unchanged (FR-027).

### Off the critical path

All export — single, dual, and the domain-events/metrics layer — happens during the **post-run tail-sampling flush**, off the DAG run's critical path (FR-028, SC-004). A slow or failing backend adds no measurable latency to run completion: the run has already returned by the time the flush fans out, and the composite's settle deadline bounds any hang.

### App composition (design)

At the application layer the wiring composes from the configuration resolver (`resolveObservabilityBackends`) outward:

1. The resolver maps the parsed `Config` to a `ResolvedObservability` value (trace backends, and — only when Foundry is enabled — the resolved auth). It fails closed with a typed error on contradictory config.
2. The host builds the **ordered exporter list** from the resolved trace backends — an MLflow exporter for `mlflow`, an Azure Monitor exporter for `foundry` — and passes it to the widened `initTracing` (single → as-is; `[1]` → bare; `[N]` → composite).
3. When Foundry is enabled, an `AiFoundryObserver` over an Application Insights-backed `FoundryTelemetrySink` is wrapped in a `BufferedObserver` that **shares the same `PersistencePolicy` instance** bound to the tail-sampler, so domain events are gated by the same decision as spans (FR-021, SC-010 — a discarded trace produces no orphaned domain events). This replaces the default `NoopObserver`.
4. The default path (no Foundry) is a single MLflow exporter plus the `NoopObserver` — identical to today.

See [observability-backends.md](./observability-backends.md) for the full selection matrix, auth, and the domain-events/metrics layer.

## Limitations

- **ReadableSpan.attributes mutation**: We mutate the attributes object after the SDK's validation. This works because JS doesn't enforce immutability, but could break if a future OTel SDK version freezes the object.
- **Trace ID quotes**: MLflow's `from_otel_proto()` double-encodes the trace ID attribute, resulting in `"tr-..."` (with embedded quotes) in the database. This is cosmetic and doesn't affect UI functionality.
- **Cache hits have no cost**: If an LLM response is served from Redis cache, no cost/token attributes are recorded for that span (correct — no LLM call was made).
- **Foundry connection string still required under Entra ID**: even with `AZURE_AUTH_MODE=entra-id`, an Application Insights connection string must be supplied — the Azure Monitor SDK needs it to locate the ingestion endpoint. Project-endpoint auto-discovery of the connection string is out of scope this iteration (FR-024).
