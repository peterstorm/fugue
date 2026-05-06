# MLflow OTLP Tracing Pipeline

## Overview

The framework exports traces to MLflow via the **OpenTelemetry Protocol (OTLP)** endpoint (`POST /v1/traces`). This is MLflow's intended ingest path for non-Python SDKs and ensures that span-level metrics (cost, token usage) are correctly populated in the SQL store for the UI's Cost Breakdown card.

No `@mlflow/core` dependency — uses pure `@opentelemetry/api` and `@opentelemetry/sdk-node`.

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

A side-channel registry stores object-valued attributes keyed by `spanId`:

```typescript
// In enrichLlmSpan():
SpanAttributeRegistry.set(spanId, {
  "mlflow.llm.cost": { input_cost, output_cost, total_cost },
  "mlflow.chat.tokenUsage": { input_tokens, output_tokens, total_tokens },
  "mlflow.spanInputs": { model, system_prompt, user_prompt },
});
```

The `MlflowOtlpExporter` pops from the registry and mutates `ReadableSpan.attributes` before the `otlp-transformer` serializes the protobuf. The transformer handles objects natively (emits `kvlist_value`), bypassing the SDK's validation.

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
| `packages/framework/src/observer/span-attribute-registry.ts` | Side-channel for object attributes |
| `packages/framework/src/observer/mlflow-otlp-exporter.ts` | Injects attrs + forwards to OTLP |
| `packages/framework/src/observer/tail-sampling-processor.ts` | Buffers spans, applies policy |
| `packages/framework/src/observer/init-tracing.ts` | Wires pipeline (single processor) |
| `packages/framework/src/tracing/span-enrich.ts` | Registers cost/tokens in registry |
| `packages/framework/src/executor/executor.ts` | Creates spans, sets inputs/outputs via registry |

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
