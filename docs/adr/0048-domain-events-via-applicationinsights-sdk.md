# ADR-0048: Domain Events and Metrics via the Application Insights SDK

## Status
Accepted — Implemented

## Date
2026-05-31

## Context

Beyond raw traces, operators monitoring production DAG runs need to see higher-level
*domain* signals in Foundry: run-level completion summaries, routing decisions (which target
was chosen, which were pruned), pruned branches with their reason, and pre-aggregated metrics
for cost, token consumption, run/node latency, and cache-hit rate, dimensioned by DAG and node
identity. These are exactly the signals raw spans do not directly express, and they back
requirements FR-018, FR-019, and FR-020.

Two forces shape the decision. First, the destination is fixed: Foundry's monitoring view
queries Application Insights `customEvents` and `customMetrics`, against the same backend and
connection string the trace exporter already uses — the connection-string config surface is
established in ADR-0050 and the exporter composition in ADR-0044, while ADR-0047 establishes the
Azure / Foundry SDKs as hard dependencies. Second, the framework's
observability is a deliberate dual-channel design — the **Observer** channel carries domain
events, while the **OpenTelemetry** channel carries infrastructure telemetry (spans, LLM
cost/token usage). Domain-event volume must be gated by the *same* persistence policy that
gates trace export, so that a discarded trace never leaves orphaned domain events behind
(FR-021, SC-010).

The question is which mechanism emits the domain-event/metric channel: the OpenTelemetry
metrics API, additional OTel spans, or the Application Insights Node SDK directly.

## Options Considered

1. **OpenTelemetry metrics API** (`MeterProvider` + `PeriodicExportingMetricReader` +
   `AzureMonitorMetricExporter`)
   - Pros: Vendor-neutral instrument types; consistent with the OTel tracing channel
   - Cons: Stands up a second pipeline (meter provider, periodic reader, a separate exporter)
     for the *same* Application Insights destination already reached by the trace exporter —
     more moving parts for no new backend; the events half of the requirement (route-decided,
     node-pruned with a free-form reason and chosen/pruned target lists) maps poorly onto
     metric instruments and would *still* need a `trackEvent`-style call, so this option cannot
     stand alone

2. **Emit domain events as additional OTel spans**
   - Pros: Single OTel pipeline; reuses existing span export wiring
   - Cons: Conflates the two channels of the dual-channel design (Observer = domain events,
     OTel = infrastructure telemetry); domain-event gating would be governed by span
     tail-sampling rather than by the shared `PersistencePolicy` instance, breaking the
     "no orphaned domain events" invariant; abuses spans to carry what are semantically events
     and metrics

3. **Application Insights Node SDK directly** (`TelemetryClient.trackEvent` / `trackMetric`)
   - Pros: `customEvents` + `customMetrics` are precisely what the Foundry monitoring view
     queries; `trackEvent` carries arbitrary typed properties (run id, dag id, node id, reason,
     chosen/pruned targets) and `trackMetric` supports pre-aggregated values with dimensions — a
     direct fit for FR-018/019/020 with one SDK and one connection string already used by the
     trace exporter; fewest moving parts (SIMPLICITY)
   - Cons: Couples the emitting adapter to a specific vendor SDK (mitigated by a port — see
     Decision); does not give a vendor-neutral metrics abstraction

## Decision
**Emit domain events and metrics through the Application Insights Node SDK, behind a
vendor-neutral `FoundryTelemetrySink` port, wrapped in `BufferedObserver` that shares the
trace exporter's `PersistencePolicy` instance.**

Architecture:

- **`AiFoundryObserver`** (`packages/framework/src/observer/ai-foundry-observer.ts`) translates
  framework observer callbacks into sink calls: `trackEvent` for run-summary, route-decided, and
  node-pruned; `trackMetric` for the pre-aggregated cost/token/latency/cache-hit metrics. It is
  **vendor-neutral** — it depends only on the `FoundryTelemetrySink` port
  (`trackEvent` / `trackMetric` / `flush`), never on `applicationinsights` directly.
- **`FoundryTelemetrySink`** is the port (exported from the observer package). The
  `applicationinsights`-backed implementation is an **app-layer adapter**
  (`apps/customer-summary/src/foundry-sink.ts`), keeping the SDK dependency out of the framework.
- **`foundry-event-mapping.ts`** (`mapEventToFoundry` / `mapRunSummaryToFoundry`) is a **pure**
  mapping from framework domain events to sink payloads, using exhaustive `ts-pattern` matching
  so a new event variant fails to compile rather than being silently dropped.
- **Shared policy gating:** the observer is wrapped in `BufferedObserver` constructed with the
  *same* `PersistencePolicy` instance used for trace export, handed over via the tracing handle.
  A trace the policy discards therefore produces no domain events — one decision, both channels
  (FR-021).
- **Composition:** wired in `apps/customer-summary/src/observability-composition.ts`, alongside
  the trace pipeline, reusing the shared connection string from the config surface (ADR-0050)
  and the shared `PersistencePolicy` instance.
- **Never throws:** `AiFoundryObserver` swallows-and-logs any sink failure. Observability is
  best-effort and must never fail a DAG run.

**As-built dual-channel cost nuance (load-bearing — framework capability vs. app wiring).**
This is an app-wiring decision, not a framework limitation. The pure
`mapRunSummaryToFoundry` mapper in the framework **is capable** of emitting `totalCost` in the
run-summary event's `measurements` (and a corresponding metric) *when the caller supplies*
`RunSummary.totalCostUsd`; it simply omits cost when that input is `undefined`. The shipped app
wiring (`FoundryRunSummaryObserver` in `apps/customer-summary/src/observability-composition.ts`)
deliberately supplies only `cacheHitCount` and leaves `totalCostUsd` undefined — because LLM
cost is **span-resident**, measured on the OTel span channel (`ai.llm.cost_usd`,
`gen_ai.usage.*`) by the `TailSamplingProcessor`, not on observer events. So in the **shipped
end-to-end path** the run-summary domain event carries `duration`, `status`, `nodeCount`,
`retryCount`, and `cacheHitCount` but **not** total cost or token totals; cost reaches Foundry
via the **span channel** to the *same* Application Insights backend. Because both channels land
in the same resource, FR-019 / SC-008's total-cost requirement is met **end-to-end** — cost is
present in the monitoring view, sourced from spans rather than the run-summary event. The split
is by design: the run-summary event documents run shape; cost lives where it is measured. (An
app that *did* compute a per-run total on the observer side could pass `totalCostUsd` and the
framework would carry it on the event channel too — the framework imposes no ceiling.)

## Consequences

**Positive:**
- Direct fit for the Foundry monitoring view: events become `customEvents`, metrics become
  `customMetrics`, queryable with no translation layer.
- One SDK and one connection string for both trace export (ADR-0047) and the domain-event/metric
  channel — no second pipeline, fewer moving parts (SIMPLICITY).
- "No orphaned domain events" is structurally guaranteed, not merely tested: the shared
  `PersistencePolicy` instance gates both channels through one decision (FR-021, SC-010).
- Vendor lock is contained: the framework depends on the `FoundryTelemetrySink` port; only the
  app-layer adapter touches `applicationinsights`. A future backend swap replaces the adapter,
  not the observer.
- Pure, exhaustive mapping (`ts-pattern`) makes a new domain-event variant a compile error
  rather than a silent omission.

**Negative:**
- Total cost and token totals are absent from the run-summary event; consumers reconstructing a
  per-run total must read the span channel (`ai.llm.cost_usd`, `gen_ai.usage.*`). Both land in
  the same backend, but it is two queries, not one event.
- The metrics are emitted via a vendor SDK rather than the vendor-neutral OTel metrics API;
  switching backends means writing a new sink adapter (the port keeps this localized).
- Best-effort emission: because the observer swallows sink failures, a persistently failing sink
  loses domain events silently except for logs — acceptable, since observability must never fail
  a run.

## References
- ADR-0047 — Azure / Foundry SDKs as hard dependencies (establishes the `applicationinsights`
  SDK this channel's adapter is built on as a hard dependency)
- ADR-0050 — Observability backend selection in the app config layer (supplies the shared
  connection-string config surface this channel reuses)
- ADR-0044 — Thin vendor exporter factories with bootstrap composition (the exporter
  composition and the pattern wiring the sink and observer in the app layer)
- Observer dual-channel design note (`packages/framework/src/observer/observer.ts`,
  "Design note: Observer vs OTel tracing (dual-channel architecture)") — Observer = domain
  events, OTel = infrastructure telemetry
