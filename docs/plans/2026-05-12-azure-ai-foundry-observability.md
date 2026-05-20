---

# Plan: Azure AI Foundry Observability Integration

**Created:** 2026-05-12
**Status:** Draft
**Goal:** Add Azure AI Foundry as an observability backend alongside MLflow. Traces, LLM metrics, and DAG execution events should be viewable in the Foundry portal's Tracing tab via Application Insights.

---

## Background

Azure AI Foundry's observability is **purely OpenTelemetry-based**. There is no proprietary ingestion API — traces flow through standard OTel exporters into Application Insights, and the Foundry portal reads from there. This aligns well with our existing architecture: we already emit OTel spans with `gen_ai.*` semantic conventions and accept any `SpanExporter` via `initTracing()`.

### Current Architecture

```
LLM/DAG nodes emit OTel spans
         │
         ▼
TailSamplingProcessor (buffers per-trace, consults PersistencePolicy)
         │
         ▼
SpanExporter (currently: MlflowOtlpExporter)
         │
         ▼
MLflow OTLP endpoint
```

### Target Architecture

```
LLM/DAG nodes emit OTel spans
         │
         ▼
TailSamplingProcessor (shared)
         │
         ▼
CompositeExporter ──┬──→ MlflowOtlpExporter ──→ MLflow
                    │
                    └──→ AzureMonitorExporter ──→ Application Insights ──→ Foundry Portal
```

Observer events (domain-level) flow separately:

```
DAG executor emits Observer events
         │
         ▼
BufferedObserver (PersistencePolicy gate)
         │
         ▼
AiFoundryObserver ──→ custom metrics / structured logs → Application Insights
```

---

## Non-Goals

- Replacing MLflow. Both backends coexist; the consumer app chooses which to enable.
- Building Foundry-specific UI or dashboards. We emit signals; the portal handles visualization.
- Using the Python `azure-ai-projects` SDK. We're a TypeScript framework; we use the JS/Node equivalents.
- Prompt flow integration. We emit standard OTel traces, not prompt flow execution data.

---

## Design

### Phase 1: OTel Span Export to Application Insights

**Effort: ~1 day. Zero framework changes.**

AI Foundry reads traces from Application Insights. We wire up the `@azure/monitor-opentelemetry-exporter` as a `SpanExporter`.

#### 1a. New file: `packages/framework/src/tracing/azure-monitor-exporter.ts`

Factory function, following the `createMlflowExporter()` pattern:

```ts
import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

export interface AzureMonitorConfig {
  /** Application Insights connection string */
  connectionString: string;
}

export function createAzureMonitorExporter(
  config: AzureMonitorConfig,
): SpanExporter {
  return new AzureMonitorTraceExporter({
    connectionString: config.connectionString,
  });
}
```

This is intentionally thin — no attribute translation needed because we already emit `gen_ai.*` conventions that Foundry understands natively.

#### 1b. Composite exporter support in `initTracing()`

Currently `initTracing()` accepts a single `SpanExporter`. Change to accept `SpanExporter | SpanExporter[]`. When an array is passed, wrap with a `CompositeSpanExporter` that fans out `export()` and `shutdown()` calls.

```ts
// tracing/composite-exporter.ts
export class CompositeSpanExporter implements SpanExporter {
  constructor(private readonly exporters: SpanExporter[]) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let remaining = this.exporters.length;
    let hasError = false;
    for (const exporter of this.exporters) {
      exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) hasError = true;
        if (--remaining === 0) {
          resultCallback({ code: hasError ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
        }
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.shutdown()));
  }
}
```

#### 1c. Changes to `init.ts`

```diff
 export interface TracingConfig {
-  readonly exporter: SpanExporter;
+  readonly exporter: SpanExporter | readonly SpanExporter[];
   readonly policy: PersistencePolicy;
 }
```

Normalize to `CompositeSpanExporter` when array is passed.

#### 1d. Consumer wiring (in `apps/customer-summary` or equivalent)

```ts
import { createMlflowExporter } from "@ai-summary/framework/tracing";
import { createAzureMonitorExporter } from "@ai-summary/framework/tracing";
import { initTracing, errorOnly, anyOf, ratio } from "@ai-summary/framework";

const handle = initTracing({
  exporter: [
    createMlflowExporter({ endpoint: process.env.MLFLOW_TRACKING_URI }),
    createAzureMonitorExporter({
      connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    }),
  ],
  policy: anyOf(errorOnly(), ratio(0.1)),
});
```

#### What this gives us

- Full DAG execution traces visible in Foundry portal Tracing tab
- LLM spans with model, tokens, cost, latency — all via existing `gen_ai.*` attributes
- Node-level spans with `ai.node.id`, `ai.node.kind`, `ai.span.type`
- Tail-sampling via `PersistencePolicy` controls volume/cost to App Insights
- Zero changes to any node, LLM client, or observer code

### Phase 2: Attribute Translation Layer (Optional)

**Effort: ~1 day. One new file.**

If Foundry's portal expects specific attribute names beyond standard `gen_ai.*` (e.g., prompt flow metadata fields), add a translation proxy following the `MlflowOtlpExporter` pattern.

#### 2a. `packages/framework/src/tracing/azure-foundry-exporter.ts`

Wraps `AzureMonitorTraceExporter` with span-proxy-based attribute injection, mirroring `mlflow-otlp-exporter.ts`:

| Framework attribute | Azure/Foundry attribute | Notes |
|---|---|---|
| `ai.span.type` | `ai.span.type` | Already standard |
| `ai.llm.cost_usd` | `ai.llm.cost_usd` | May need to also emit as metric |
| `ai.dag.id` | `ai.dag.id` | Maps to "flow" in Foundry metrics |
| `ai.node.id` | `ai.node.id` | Maps to "node" in Foundry metrics |
| `gen_ai.*` | `gen_ai.*` | Pass-through, already standard |

Translation table is likely thin or empty — Foundry consumes standard OTel. This phase exists as a safety net for any quirks discovered during integration testing.

### Phase 3: Observer-Based Domain Events

**Effort: ~2 days. One new file + tests.**

The `Observer` provides structured domain events that OTel spans don't capture: routing decisions, pruned branches, run-level summaries with cost/retry/cache aggregates. These are valuable for Foundry's evaluation and monitoring features.

#### 3a. `packages/framework/src/observer/azure-foundry-observer.ts`

Implements `Observer` interface. Strategy: emit domain events as **custom OTel events** (span events) or **Application Insights custom events/metrics** via the `applicationinsights` Node SDK.

| Observer event | Target in App Insights |
|---|---|
| `onRunEnd` | Custom event `dag.run.completed` with `duration`, `status`, `nodeCount`, `retryCount`, `cacheHitCount`, `totalCostUsd` |
| `onNodeError` | Exception telemetry with `nodeId`, `dagId`, `error`, `stack` |
| `onRouteDecided` | Custom event `dag.route.decided` with `fromNodeId`, `chosenTargets`, `prunedTargets`, `defaultTaken` |
| `onNodePruned` | Custom event `dag.node.pruned` with `nodeId`, `reason` |
| `onNodeEnd` | Custom metric `node.duration` with `nodeId`, `dagId` dimensions |
| `onNodeSkipped` | Custom event `dag.node.skipped` with `reason` |

#### 3b. Integration with `BufferedObserver`

Wrap `AiFoundryObserver` inside `BufferedObserver` so the same `PersistencePolicy` gates both OTel span export and Observer event dispatch:

```ts
const foundryObserver = new AiFoundryObserver({ connectionString });
const buffered = new BufferedObserver(foundryObserver, policy);

// Pass to runDag
await runDag(dag, input, {
  observer: buffered,
  // ...
});
```

#### 3c. Metrics via Application Insights

Emit pre-aggregated metrics that show up in Foundry's monitoring:

| Metric name | Type | Dimensions |
|---|---|---|
| `dag.token_consumption` | counter | `dagId`, `nodeId`, `model`, `token_type` |
| `dag.run_latency` | histogram | `dagId`, `status` |
| `dag.run_cost_usd` | counter | `dagId` |
| `dag.node_latency` | histogram | `dagId`, `nodeId`, `nodeKind` |
| `dag.cache_hit_rate` | gauge | `dagId` |

These align with Foundry's built-in metric namespace patterns (`promptflow standard metrics`) but use our `dag.*` namespace.

### Phase 4: Authentication & Configuration

**Effort: ~0.5 days.**

#### 4a. Support both auth modes

```ts
export interface AzureFoundryConfig {
  /** App Insights connection string — simplest auth, no Entra ID needed */
  connectionString?: string;
  /** Entra ID credential — uses DefaultAzureCredential from @azure/identity */
  useEntraId?: boolean;
  /** Optional: AI Foundry project endpoint for auto-discovering connection string */
  projectEndpoint?: string;
}
```

When `projectEndpoint` is provided, use `@azure/ai-projects` to call `telemetry.getApplicationInsightsConnectionString()` at startup, avoiding hardcoded connection strings.

#### 4b. Environment variable conventions

| Env var | Purpose |
|---|---|
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Direct App Insights connection |
| `AZURE_AI_FOUNDRY_PROJECT_ENDPOINT` | Auto-discover connection string |
| `AZURE_AI_FOUNDRY_ENABLED` | `true` to enable (default `false`) |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `true` to include prompt/completion text (PII!) |

---

## Dependencies

| Package | Purpose | Phase |
|---|---|---|
| `@azure/monitor-opentelemetry-exporter` | OTel span export to App Insights | 1 |
| `@azure/identity` | Entra ID auth (optional) | 4 |
| `@azure/ai-projects` | Connection string discovery (optional) | 4 |
| `applicationinsights` | Custom events/metrics SDK (optional) | 3 |

Only Phase 1's dependency is required. Phases 3-4 dependencies are optional and lazily loaded.

---

## File Changes Summary

| File | Change | Phase |
|---|---|---|
| `tracing/azure-monitor-exporter.ts` | **New** — factory function | 1 |
| `tracing/composite-exporter.ts` | **New** — fan-out exporter | 1 |
| `tracing/init.ts` | **Edit** — accept `SpanExporter[]` | 1 |
| `tracing/azure-foundry-exporter.ts` | **New** — attribute translation (if needed) | 2 |
| `observer/azure-foundry-observer.ts` | **New** — domain event → App Insights | 3 |
| `index.ts` / `advanced.ts` | **Edit** — re-export new public API | 1-3 |
| Consumer app bootstrap | **Edit** — wire up exporter + observer | 1 |

---

## Risks & Open Questions

1. **Attribute compatibility** — Will Foundry's Tracing tab correctly render our `ai.*` custom attributes, or does it only display `gen_ai.*`? Needs integration testing. Mitigation: Phase 2 exists for this.

2. **Volume/cost** — Application Insights charges per GB ingested. The `PersistencePolicy` already gates this, but we should document recommended policies for production (e.g., `anyOf(errorOnly(), ratio(0.05))`).

3. **Node.js SDK maturity** — The `@azure/monitor-opentelemetry-exporter` is GA for Node.js. The `@azure/ai-projects` JS SDK may be less mature than the Python equivalent. Phase 4's auto-discovery may need to be deferred.

4. **Dual-export latency** — `CompositeSpanExporter` fans out in parallel, but doubles network calls. Both exporters are async and non-blocking, so this shouldn't affect DAG execution latency. Monitor export queue depth.

5. **Content capture & PII** — Our `span-enrich.ts` already gates content via `includeContent`. Foundry's `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env var is separate from our flag. Need to unify or document the interaction.

---

## Estimated Total Effort

| Phase | Effort | Blocking? |
|---|---|---|
| Phase 1: OTel export to App Insights | 1 day | No — standalone |
| Phase 2: Attribute translation | 0.5-1 day | Depends on integration testing |
| Phase 3: Observer → App Insights events/metrics | 1.5-2 days | No — standalone |
| Phase 4: Auth & config | 0.5 days | No — standalone |
| **Total** | **3.5-4.5 days** | |

Phase 1 alone gives 80% of the value. Phases 2-4 are incremental improvements that can be deferred.
