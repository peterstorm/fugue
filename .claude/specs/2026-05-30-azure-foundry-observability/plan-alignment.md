# Plan Alignment Report

**Spec:** .claude/specs/2026-05-30-azure-foundry-observability/spec.md
**Plan:** .claude/plans/2026-05-30-azure-foundry-observability.md
**Date:** 2026-05-30

## Summary

No gaps found. All 29 functional requirements and 10 success criteria are addressed by the plan
by meaning. One intentional config-mechanism deviation (AD-7) was evaluated and judged to satisfy
the underlying requirement; see Notes.

## Gaps

None.

## Notes on the intentional deviation (AD-7)

The spec's wording for config (FR-001) is "environment variables and the application configuration
file," and the original feature framing used "env + fugue.yaml driven." The plan (AD-7) places
backend selection in the **app config layer** (`apps/customer-summary/src/config.ts`, zod-validated
env), not in `fugue.yaml`, on the grounds that `fugue.yaml` is governed by `FugueYamlSchema` as
per-DAG team/owner/route metadata while trace/observer wiring is a process-level bootstrap concern.

This SATISFIES the underlying intent. The defining property in the spec (FR-001, FR-004, US4) is
**code-change-free, configuration-driven backend selection per environment** — not that `fugue.yaml`
specifically be the carrier. No FR or SC strictly mandates `fugue.yaml` as the selection mechanism;
"application configuration file" is satisfied by the app's env-backed `config.ts` layer (the same
surface already carrying `MLFLOW_TRACKING_URI` and `TRACE_SAMPLE_RATIO`). Startup zod validation
covers FR-006. Treated as Covered, deviation noted rather than flagged.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| FR-001 | Trace backend(s) selectable via env/app config, no code changes | Covered |
| FR-002 | Support one or more trace backends; 1=exclusive, 2=fan-out | Covered |
| FR-003 | MLflow default trace backend, behavior identical | Covered |
| FR-004 | Eval backend selectable at run time (env and/or CLI flag) | Covered |
| FR-005 | MLflow eval path remains default | Covered |
| FR-006 | Config validated at startup; invalid/contradictory reported clearly | Covered |
| FR-007 | Export traces so persisted spans visible in Foundry Tracing tab | Covered |
| FR-008 | Spans carry vendor-neutral GenAI attrs, no per-node instrumentation | Covered |
| FR-009 | Spans carry cost, node identity, DAG/run identity enrichment | Covered |
| FR-010 | Tail-sampling policy gates Foundry export equally to MLflow | Covered |
| FR-011 | Dual-export delivers same spans with consistent identities | Covered |
| FR-012 | Content-capture / PII gating continues to apply to Foundry | Covered |
| FR-013 | Foundry-native eval scores the same evaluation cases | Covered |
| FR-014 | Foundry eval records per-case + aggregate scores, visible in Foundry | Covered |
| FR-015 | Foundry eval reuses existing Azure OpenAI judge credentials | Covered |
| FR-016 | MLflow eval remains functional/selectable; no cross-alteration | Covered |
| FR-017 | Foundry aggregate per-scorer scores comparable within tolerance | Covered |
| FR-018 | Record run summaries, routing decisions, pruned branches to Foundry | Covered |
| FR-019 | Run summary includes duration, status, node/retry/cache-hit count, cost | Covered |
| FR-020 | Pre-aggregated cost/token/run+node latency/cache-hit, DAG+node dims | Covered |
| FR-021 | Domain-event/metric emission gated by the same persistence policy | Covered |
| FR-022 | Default auth via App Insights connection string from config | Covered |
| FR-023 | Opt-in Entra ID via DefaultAzureCredential | Covered |
| FR-024 | Project-endpoint auto-discovery not required (out of scope) | Covered |
| FR-025 | Failing/slow backend never fails/delays run; errors logged | Covered |
| FR-026 | One backend failure does not affect another selected backend | Covered |
| FR-027 | Foundry off → existing tests pass unchanged, MLflow unchanged | Covered |
| FR-028 | Export off critical path (async/batched), no measurable latency | Covered |
| FR-029 | Azure/Foundry SDKs are hard deps, always installed | Covered |
| SC-001 | 100% spans visible in Foundry Tracing with GenAI+cost+node identity | Covered |
| SC-002 | 100% of existing eval cases scored via Foundry, visible in Evaluations | Covered |
| SC-003 | Eval backend switchable MLflow/Foundry at run time, zero code change | Covered |
| SC-004 | No measurable p50/p95 run-time increase from export | Covered |
| SC-005 | Mean per-scorer Foundry vs MLflow within +-0.5 for every scorer | Covered |
| SC-006 | Foundry off: existing tests pass; MLflow byte-for-byte equivalent | Covered |
| SC-007 | Dual-export integrity + one backend killed mid-run, run succeeds | Covered |
| SC-008 | Domain-events layer: 100% runs produce run-summary; routes/prunes recorded | Covered |
| SC-009 | Backend made to fail/hang: 0% runs fail/delay; failure logged | Covered |
| SC-010 | Discarded traces not sent to Foundry and produce no domain events | Covered |
