# PR Remediation Plan (v3)

**Date:** 2026-06-02
**Branch:** feat/azure-foundry-observability
**Findings:** 0 critical, 9 advisory (6-agent cohort)
**Scope chosen by user:** Recommended set — fix #1, #2, #3, #4, #8, #9; skip cosmetic #5/#6; leave #7 optional.

All six reviewers reported `CRITICAL_COUNT: 0`. The items below are advisory hardening.

## Advisory Fixes (in priority order)

### Fix 2: run.py total-empty-metrics severity (error-handling consistency)
- **Source:** silent-failure-hunter (A2)
- **File:** apps/customer-summary/eval/run.py:157
- **Issue:** When MLflow returns NO metrics at all (`metrics == {}`, every row errored) AND no scorer matched, control fell to the `else` WARNING branch. The sibling Foundry path (`foundry_eval.py:139-154`) logs the same failure mode at ERROR. Verdict was already fail-closed; only the log severity was inconsistent.
- **Fix:** Change the gate from `if not scorer_means and metrics:` to `if not scorer_means:` and mirror foundry_eval's detail wording (empty-dict vs none-matching). Update `test_run.py::test_empty_metrics` to assert the ERROR + "NO metrics" wording (was silent on text). Partial-missing case stays WARNING (covered by `test_partial_missing_scorer_fails_closed`).

### Fix 4: carry `FiniteNumber` brand through the sink ports (type invariant)
- **Source:** type-design-analyzer (A1)
- **Files:** packages/framework/src/observer/ai-foundry-observer.ts:28-40; apps/customer-summary/src/foundry-sink.ts:47-51
- **Issue:** `mapEventToFoundry` brands every metric value/measurement as `FiniteNumber`, but `FoundryTelemetrySink` / `AppInsightsClient` typed them as plain `number`/`Record<string,number>` — the proven NaN/Infinity-unrepresentable invariant evaporated exactly at the AI-ingestion call.
- **Fix:** Type the port's `trackMetric.value` as `FiniteNumber` and `measurements` as `Record<string, FiniteNumber>` on both `FoundryTelemetrySink` (framework) and `AppInsightsClient` (app). `FiniteNumber` is already exported from the framework root barrel. `forwardEmission` already passes branded values, so this only tightens the contract.

### Fix 1: surface `childFailureCounts` to a readiness/diagnostics signal (observability gap)
- **Source:** silent-failure-hunter (A1), pr-test-analyzer, architecture (×3 — strongest signal)
- **Files:** packages/framework/src/tracing/init.ts (TracingHandle); apps/customer-summary/src/server.ts (HealthDeps + /readyz); apps/customer-summary/src/bootstrap.ts (health wiring)
- **Issue:** `CompositeSpanExporter.childFailureCounts` is documented "exposed for health checks" but has no consumer. A constructed-but-persistently-failing secondary backend (e.g. Foundry export erroring while MLflow succeeds) is visible only via rate-limited logs.
- **Fix:** Add `TracingHandle.exporterFailures(): ReadonlyArray<ChildFailureCount> | null` (null when no Composite — single backend). Add an optional `tracingExporterFailures` getter to `HealthDeps`; bootstrap wires it from the handle. `/readyz` surfaces the counts **informationally** — like MLflow, a failing secondary trace backend yields `ready-degraded` but NEVER gates the 503 (FR-026: a Foundry fault must not remove the pod).

### Fix 3: assert bootstrap's single-shared-policy wiring (test gap)
- **Source:** pr-test-analyzer (rated 6/10)
- **File:** apps/customer-summary/src/__tests__/observability-composition.test.ts (new describe block)
- **Issue:** The FR-021/SC-010 shared-policy guarantee was verified only at the composition layer with a test-threaded policy, not that the SAME instance reaches both `initTracing` and the observer (bootstrap's wiring).
- **Fix:** New test reproducing bootstrap's exact composition with ONE policy const: assert `initTracing({ exporter: composed.exporters, policy }).policy === policy` (referential) AND that the observer's flush/drop decision is governed by that same instance (behavioral, deterministic custom policy). Closes the gap via the reviewer's sanctioned alternative.

### Fix 8: ADR-0047 "static imports / no dynamic-import indirection" claim (doc accuracy)
- **Source:** comment-analyzer (A1)
- **File:** docs/adr/0047-azure-foundry-sdks-hard-dependencies.md:29-30, 50
- **Issue:** The ADR's positive-consequence claim contradicts the as-built framework exporter, which lazy-loads `@azure/monitor-opentelemetry-exporter` via `createRequire(__filename)+require()` (azure-monitor-exporter.ts:43,178) so the MLflow-only path never loads the Azure SDK. The hard-dependency *decision* is accurate; only the "everything is statically imported" nuance is wrong.
- **Fix:** Amend the two claims to state that "hard dependency, always installed" does not imply "always eagerly imported": the framework exporter intentionally lazy-loads via `createRequire` while the dependency stays unconditionally installed; the app-layer `applicationinsights` import is static.

### Fix 9: eval docs attribute `context` column to MLflow scorers (doc accuracy)
- **Source:** comment-analyzer (A2)
- **File:** docs/eval-pipeline.md:98
- **Issue:** The DataFrame table lists `context` as "Used by: faithfulness, relevance", contradicting `run.py:100-106` (docstring: context is "not for any MLflow grading context") and `run_evaluation`'s `col_mapping` which never routes `context` into a scorer.
- **Fix:** Update the `context` row's "Used by" to reflect it exists only for the Foundry path's query/response/context/ground_truth schema, not consumed by any MLflow scorer. (No parallel table exists in eval/README.md — confirmed; comment-analyzer over-attributed.)

## Skipped (per user)
- #5 ResolvedAuth structurally-identical union arms — cosmetic.
- #6 unreachable credential-only AzureMonitorAuth arm — not a defect (valid for framework consumers).
- #7 degraded-fallback marker — optional; left for a follow-up.

## Validation Commands
```bash
cd packages/framework && bun run typecheck && cd ../../apps/customer-summary && bun run typecheck
bun test packages/framework/src/tracing packages/framework/src/observer apps/customer-summary/src/__tests__
# Python (env-dependent): cd apps/customer-summary/eval && python -m pytest test_run.py
```
