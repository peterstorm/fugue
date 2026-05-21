# ADR-0043: OTel Tracing for Host Operations

## Status
Accepted

## Date
2026-05-20

## Context

The host orchestrates multiple subsystems (git sync, DAG import, HTTP request routing, concurrency management, circuit breaking) that can fail in production. Diagnosing issues like "why did this DAG take 45s to respond" or "why did sync fail silently" requires distributed tracing that correlates events across subsystem boundaries.

The framework (`@fugue/framework`) already has its own OpenTelemetry instrumentation — it traces node execution, LLM calls, and DAG run lifecycle. The host adds a layer above: request routing, concurrency acquisition, DAG selection, and the sync loop itself. These host-level spans provide the "outer envelope" that framework spans nest inside.

The question is whether to use OTel's standard instrumentation, a custom tracing system, or rely on structured logging alone.

## Options Considered

1. **Console/structured logging only**
   - Pros: Zero dependency, simple, works everywhere
   - Cons: No correlation between events (which log lines belong to the same request?), no latency visualization, no span hierarchy, insufficient for production debugging of multi-step failures, no integration with observability platforms (Jaeger, Tempo, Datadog)

2. **Custom tracing implementation**
   - Pros: Tailored to exact needs, no external spec to follow
   - Cons: Reinvents OTel poorly, no ecosystem tooling support, different protocol than framework's existing OTel traces, maintenance burden, no W3C trace context propagation

3. **Full OpenTelemetry instrumentation for host-level operations**
   - Pros: Industry standard, framework already uses OTel (traces compose naturally via parent-child spans), rich ecosystem of exporters (OTLP, Jaeger, Zipkin), W3C trace context propagation across HTTP boundaries, zero-code instrumentation for Bun HTTP via auto-instrumentation
   - Cons: OTel SDK adds initialization boilerplate, spans have memory cost (acceptable at host scale), requires collector/backend infrastructure for production use

## Decision
**Full OpenTelemetry instrumentation for host-level operations. Framework retains its own independent tracing; host spans provide the outer context.**

Host-level spans cover:
- **HTTP request lifecycle:** `host.request` span wrapping each incoming HTTP request, with attributes for DAG ID, route, method
- **Concurrency acquisition:** `host.concurrency.acquire` span measuring wait/rejection time
- **DAG execution dispatch:** `host.dag.run` span that becomes the parent of framework's internal `dag.execute` span
- **Git sync loop:** `host.sync.poll` span per poll cycle, `host.sync.clone` and `host.sync.pull` for git operations
- **DAG import:** `host.dag.import` span per DAG module dynamic import, capturing validation success/failure
- **Circuit breaker transitions:** `host.circuit.transition` event (span event, not full span) recording state changes

Span hierarchy for a typical request:
```
host.request (HTTP handler)
  └── host.concurrency.acquire
  └── host.dag.run (dispatch)
      └── dag.execute (framework)
          └── node.execute (framework)
              └── llm.call (framework)
```

Configuration: `OTEL_EXPORTER_OTLP_ENDPOINT` env var. When unset, tracing is a no-op (no-op tracer provider). This allows development without a collector.

## Consequences

**Positive:**
- End-to-end request traces from HTTP ingress through host routing to framework execution to LLM calls — single trace ID correlates everything.
- Production debugging: latency breakdowns show exactly where time is spent (concurrency queue? LLM? sync blocking?).
- Framework and host traces compose naturally — framework's spans automatically become children of host's dispatch span via OTel context propagation.
- Standard tooling: any OTel-compatible backend (Jaeger, Grafana Tempo, Datadog) works out of the box.
- No-op when unconfigured — zero overhead in development/test without a collector.

**Negative:**
- Requires collector infrastructure in production (Jaeger, OTLP collector, or SaaS). Without it, traces go nowhere.
- OTel SDK initialization adds ~50ms to startup. Negligible for a long-running host process.
- Span memory overhead per-request. At <100 concurrent requests, this is immaterial.
- OTel API surface is large and evolving — must pin SDK versions to avoid churn. Mitigated: host uses only the tracing API (not metrics or logs from OTel).
