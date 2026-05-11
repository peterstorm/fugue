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

Currently configured with `ratio(1.0)` — all traces are exported.

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
import { initTracing, anyOf, errorOnly, ratio } from "@ai-summary/framework";

const handle = await initTracing({
  trackingUri: "http://mlflow:5000",
  experimentId: "0",
  policy: anyOf(errorOnly(), ratio(1.0)),
});
```

The `trackingUri` is used as the OTLP endpoint URL (`{trackingUri}/v1/traces`). The `experimentId` is sent as an `x-mlflow-experiment-id` header.

## Why Not Use MlflowSpanExporter?

The `@mlflow/core` JS SDK's `MlflowSpanExporter` uses a different path:
- `POST /api/3.0/mlflow/traces` (StartTraceV3) — creates trace metadata in SQL
- `PUT .../traces.json` — uploads spans as JSON artifacts

This path **does not populate `span_metrics`** because:
1. Spans are stored as artifacts, not parsed by `log_spans()`
2. The server never extracts `mlflow.llm.cost` from artifact data
3. The Cost Breakdown card queries `span_metrics` which remains empty

The OTLP path (`POST /v1/traces`) goes through `log_spans()` which extracts cost from span attributes and writes to `span_metrics`.

## Limitations

- **ReadableSpan.attributes mutation**: We mutate the attributes object after the SDK's validation. This works because JS doesn't enforce immutability, but could break if a future OTel SDK version freezes the object.
- **Trace ID quotes**: MLflow's `from_otel_proto()` double-encodes the trace ID attribute, resulting in `"tr-..."` (with embedded quotes) in the database. This is cosmetic and doesn't affect UI functionality.
- **Cache hits have no cost**: If an LLM response is served from Redis cache, no cost/token attributes are recorded for that span (correct — no LLM call was made).
