# Design: Decouple Instrumentation from MLflow

**Created:** 2026-05-06
**Status:** Approved
**Goal:** Make the framework's instrumentation vendor-neutral by replacing MLflow-specific attribute names with framework-defined semantic conventions, and confining all MLflow knowledge to a single pluggable exporter.

---

## Problem

The executor (`executor.ts`) and span enrichment (`span-enrich.ts`) hardcode MLflow's proprietary attribute names (`mlflow.spanType`, `mlflow.spanInputs`, `mlflow.spanOutputs`, `mlflow.llm.cost`, etc.) directly in the core execution path. This creates vendor lock-in: swapping to Jaeger, Tempo, Honeycomb, or any standard OTLP backend requires editing the framework's core files.

Additionally, `SpanAttributeRegistry` exists as a global side-channel solely because MLflow needs object-valued attributes that OTel SDK rejects. This is an MLflow-specific workaround leaking into framework-level code.

---

## Design

### Principle

**The framework speaks generic semantic conventions. The exporter speaks vendor.**

---

### Layer 1: Framework Semantic Conventions

The executor and LLM nodes use only:
- **Flat primitive OTel attributes** (string, number, boolean)
- **OTel span events** for structured/large payloads

#### Span Attributes (flat primitives)

| Attribute | Type | Description |
|-----------|------|-------------|
| `ai.node.id` | string | Node identifier |
| `ai.node.kind` | string | "llm" \| "fetch" \| "transform" \| "guardrail" |
| `ai.span.type` | string | "chain" \| "llm" \| "retriever" \| "tool" |
| `ai.dag.id` | string | DAG identifier |
| `ai.run.id` | string | Run identifier |
| `ai.llm.model` | string | Model name |
| `ai.llm.provider` | string | Provider name |
| `ai.llm.tokens_in` | number | Input token count |
| `ai.llm.tokens_out` | number | Output token count |
| `ai.llm.cost_usd` | number | Total cost (float) |
| `ai.llm.has_thinking` | boolean | Whether reasoning was produced |
| `ai.guardrail.passed` | boolean | Guardrail verdict |

#### Span Events (structured payloads)

| Event Name | Payload | When |
|------------|---------|------|
| `ai.node.input` | `{ data: <JSON string of input> }` | Node execution start |
| `ai.node.output` | `{ data: <JSON string of output> }` | Node execution end |
| `ai.llm.request` | `{ system, user, model, prompt_name }` | LLM call |
| `ai.llm.cost` | `{ input_cost, output_cost, total_cost }` | LLM call complete |
| `ai.llm.thinking` | `{ content: <full reasoning text> }` | When model produces thinking |

---

### Layer 2: MLflow Exporter (vendor adapter)

`MlflowOtlpExporter` becomes the **only** file that knows about MLflow's schema. Before export, it transforms spans:

1. **`ai.span.type`** → `mlflow.spanType` (uppercased: CHAIN, LLM, RETRIEVER, TOOL)
2. **`ai.node.input` event** → `mlflow.spanInputs` (object attribute via registry)
3. **`ai.node.output` event** → `mlflow.spanOutputs` (object attribute via registry)
4. **`ai.llm.cost` event** → `mlflow.llm.cost` (object attribute)
5. **`ai.llm.request` event** → merges into `mlflow.spanInputs`
6. **`ai.llm.thinking` event** → `mlflow.llm.thinking` (string attribute)
7. **`ai.llm.model`** → `mlflow.llm.model`
8. **Token usage attrs** → `mlflow.chat.tokenUsage` (object attribute)

The `SpanAttributeRegistry` moves **inside** the MLflow exporter as a private implementation detail — it's no longer a framework-level concern.

---

### Layer 3: Generic `initTracing`

`init-tracing.ts` becomes backend-agnostic:

```typescript
export interface TracingConfig {
  readonly exporter: SpanExporter;  // any OTel-compatible exporter
  readonly policy: PersistencePolicy;
}

export function initTracing(config: TracingConfig): TracingHandle { ... }
```

A separate `createMlflowExporter(opts)` factory lives in the MLflow adapter module. Users wire it up in bootstrap:

```typescript
import { createMlflowExporter } from "@ai-summary/framework/exporters/mlflow";
const exporter = createMlflowExporter({ url, experimentId });
const tracing = await initTracing({ exporter, policy });
```

For a standard OTLP backend:
```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
const exporter = new OTLPTraceExporter({ url: "http://tempo:4318/v1/traces" });
const tracing = await initTracing({ exporter, policy });
```

---

### Layer 4: Tail-Sampling Processor

Currently reads `mlflow.llm.cost` from `SpanAttributeRegistry`. After refactor:
- Reads `ai.llm.cost_usd` directly from span attributes (it's a flat number)
- No more dependency on `SpanAttributeRegistry`

---

## File Changes

| File | Action |
|------|--------|
| `executor.ts` | Replace `mlflow.*` → `ai.*` attrs; use `span.addEvent()` for inputs/outputs |
| `tracing/span-enrich.ts` | Replace `mlflow.*` → `ai.*` attrs + events; remove SpanAttributeRegistry import |
| `observer/span-attribute-registry.ts` | Move into MLflow exporter module (private) |
| `observer/mlflow-otlp-exporter.ts` | Move to `exporters/mlflow.ts`; add transform logic (read events → build MLflow objects) |
| `observer/tail-sampling-processor.ts` | Read `ai.llm.cost_usd` from span attributes instead of registry |
| `observer/init-tracing.ts` | Make generic: accept `SpanExporter` param instead of constructing MLflow exporter |
| `observer/index.ts` | Update exports |
| `apps/customer-summary/src/bootstrap.ts` | Wire up `createMlflowExporter()` explicitly |

---

## What Stays the Same

- `PersistencePolicy` — already vendor-neutral
- `Observer` interface (application-level events) — already vendor-neutral
- `BufferedObserver` — already vendor-neutral
- All node implementations — untouched
- Tail-sampling decision logic — same, just reads different attribute name

---

## Migration Path

1. Define `ai.*` constants in a new `tracing/semantic-conventions.ts`
2. Refactor executor + span-enrich to use constants + span events
3. Move SpanAttributeRegistry into MLflow exporter
4. Add event→attribute transformation in MLflow exporter
5. Make `initTracing` generic
6. Update bootstrap
7. Run tests — behavior should be identical

---

## Success Criteria

- Zero `mlflow` string literals outside `exporters/mlflow.ts`
- Swapping to vanilla `OTLPTraceExporter` requires changing only bootstrap (1 file in app)
- All existing tests pass
- MLflow UI still shows spans with correct inputs/outputs/costs (verified via smoke test)

---

## Out of Scope

- Eval judges (LLM-as-judge) — these have MLflow-specific scoring semantics that are orthogonal to instrumentation
- Changing the tail-sampling algorithm
- Adding new backends (just proving the abstraction works)
