# Brainstorm Summary

**Building:** Azure AI Foundry as a selectable observability backend alongside the existing MLflow backend, for both traces and evals, so a consuming app can choose where each signal is sent — including running both side-by-side for migration.

**Approach:** Vendor-pluggable observability backends, env/yaml-selected, fan-out capable. Generalize the trace pipeline so `initTracing` composes a LIST of `SpanExporter`s via a new `CompositeSpanExporter` (1 element = exclusive backend, 2 = dual-export / migration). Add an Azure Monitor / Foundry exporter factory (`createAzureFoundryExporter()` / `createAzureMonitorExporter()`) mirroring the existing `createMlflowExporter()`, built on `@azure/monitor-opentelemetry-exporter` → Application Insights, with the Foundry portal reading from there. Drive backend selection from env + `fugue.yaml` (per ADR-0042 zod+env+yaml config) so ops can switch without code changes. For evals, add a parallel `azure-ai-evaluation` SDK (Python) path in `apps/customer-summary/eval/`, selectable alongside the existing `mlflow.evaluate()` path. MLflow remains the default and is never removed.

**Key Constraints:**
- Never remove or regress MLflow; it stays the default backend.
- Reuse the existing vendor-neutral `gen_ai.*` / `ai.*` semantic conventions — Foundry consumes standard OTel, so no per-node instrumentation changes.
- Foundry / Azure SDK deps (`@azure/monitor-opentelemetry-exporter`, `@azure/identity`, optional `@azure/ai-projects`, `azure-ai-evaluation`) must be OPTIONAL / lazily loaded — apps not using Foundry must not pay the dependency cost.
- Honor existing PII / content-capture gating in `span-enrich.ts` / content-filter.
- `PersistencePolicy` and `TailSamplingProcessor` must continue to gate volume — Application Insights bills per GB.
- Azure OpenAI is already the eval judge model, so judge credentials largely exist and should be reused.

**In Scope:**
- `CompositeSpanExporter` enabling `initTracing` to accept a list of exporters (exclusive = 1-element case; dual-export = 2).
- Azure Monitor / Foundry `SpanExporter` factory mirroring `createMlflowExporter()` / `MlflowOtlpExporter`.
- Env + `fugue.yaml` backend selection for tracing (list of backends) and evals (single backend).
- Foundry-native eval path using `azure-ai-evaluation` SDK in `apps/customer-summary/eval/`, selectable alongside `mlflow.evaluate()`.
- Auth wiring: connection string OR Entra ID via `@azure/identity`, optionally project-endpoint auto-discovery via `@azure/ai-projects`.

**Out of Scope:**
- Replacing MLflow.
- Building Foundry portal UI / dashboards (we emit signals; the portal visualizes).
- Foundry prompt flow integration.
- Auto-eval-on-ingest (not available in OSS; Databricks / managed-only).

**Open Questions:**
- Auth default: connection-string vs Entra ID (`DefaultAzureCredential`) vs project-endpoint auto-discovery — which is the documented default path?
- Is the Observer → App Insights domain-events layer (draft plan Phase 3) in this iteration or deferred?
- Exact `fugue.yaml` schema keys for backend selection (e.g. `observability.tracing.backends`, `observability.evals.backend`).
- How is eval-path selection surfaced — CLI flag (`--backend=foundry|mlflow`) vs env var?
