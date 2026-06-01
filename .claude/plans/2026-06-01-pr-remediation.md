# PR Remediation Plan

**Date:** 2026-06-01
**Branch:** feat/azure-foundry-observability
**Findings:** 0 critical, ~20 advisory (selected: "All actionable")

Latest review cycle. Zero criticals after prior rounds. This round applies every
actionable advisory from the 6-agent review, skipping only the
reviewer-judged-intentional items (A5 already-completed `[]` mapping,
code-reviewer's confidence-45 partial-scorer comment, T4 dead `ATTR_MAP` branch,
TY2/AR2 standalone-observer convention).

## Ops / safety fixes

### A1: Framework logger never wired in production
- **Source:** silent-failure-hunter
- **File:** apps/customer-summary/src/bootstrap.ts
- **Issue:** `fwLogger()` warnings (composite/exporter/observer fault-isolation)
  bypass the injected `AppLogger` and go to `console.*`. Once an operator injects
  a structured logger the whole "swallow-but-log" story sends logs to the wrong sink.
- **Fix:** call `setFrameworkLogger(log)` early in `bootstrap` (AppLogger is
  structurally a FrameworkLogger).

### A2: MLflow readiness fetch has no timeout
- **Source:** silent-failure-hunter
- **File:** apps/customer-summary/src/bootstrap.ts:329-340
- **Fix:** `fetch(url, { signal: AbortSignal.timeout(2000) })` to bound the probe.

## Type invariants (invariants in types, not comments)

### TY1: ResolvedObservability discriminated union
- **File:** apps/customer-summary/src/observability.ts
- **Fix:** `{kind:"mlflow-only";traceBackends} | {kind:"with-foundry";traceBackends;auth}`.
  `isFoundryEnabled` narrows on `kind`. Makes foundry-without-auth unrepresentable.

### TY3: ResolvedFoundryLeg discriminated union
- **File:** apps/customer-summary/src/observability-composition.ts
- **Fix:** `{outcome:"active";effective;foundryExporter;foundrySink} | {outcome:"inactive";effective}`.
  Couples exporter+sink+effective; removes representable exporter-present/sink-null combo.

### TY4: FoundryEmission metric.value finite-by-type
- **File:** packages/framework/src/observer/foundry-event-mapping.ts
- **Fix:** branded `FiniteNumber` + smart constructor `metricEmission(...)`; `value: FiniteNumber`.
  Dedupes the repeated `isFinite_` push guards.

### TY5: freeze degraded traceBackends
- **File:** apps/customer-summary/src/observability-composition.ts:305-311
- **Fix:** `Object.freeze(...)` so the degraded path preserves the config layer's frozen invariant.

## Hygiene

### A3: clearTimeout on late-settle path
- **File:** packages/framework/src/tracing/composite-exporter.ts (withSettleDeadline)
- **Fix:** defensive `clearTimeout(timer)` in the `if (settled) return;` guards.

### A4: log post-SUCCESS synchronous child throw
- **File:** packages/framework/src/tracing/composite-exporter.ts:204-210
- **Fix:** `fwLogger().warn` in the `else` of the `if (!childCallbackFired)` catch.

### AR3: export SpanExporter type alias from framework
- **Files:** packages/framework/src/tracing/index.ts, apps/customer-summary/src/observability-composition.ts
- **Fix:** framework re-exports `SpanExporter` from `@opentelemetry/sdk-trace-base`;
  app imports it instead of `ReturnType<typeof createAzureMonitorExporter>`.

## Test gaps

### T1: bootstrap graceful-shutdown orchestration
- **Fix:** extract `runGracefulShutdown(handles, log)` into `src/shutdown.ts`; bootstrap
  delegates. New `__tests__/shutdown.test.ts` asserts every step runs even when an
  earlier step throws + null handles skipped.

### T2: per-row-drop WARNING branch
- **File:** apps/customer-summary/eval/test_foundry_eval.py
- **Fix:** fake returns fewer `rows` than submitted; assert the stderr WARNING.

### T3: single-backend dispatch patches the real wrappers
- **File:** apps/customer-summary/eval/test_backend_selector.py
- **Fix:** patch `run.run_foundry_backend`/`run.run_mlflow_backend` (the seam `main()`
  dispatches through), matching the `both` tests.

## Docs

- **C1:** init.ts module docstring — note multi-backend exporter-list capability.
- **C2:** tracing-pipeline.md — retitle/scope-note (no longer MLflow-only).
- **C3:** tracing-pipeline.md Key Files — add composite-exporter.ts + azure-monitor-exporter.ts.
- **C4:** align eval mode-table wording between README and eval-pipeline.md.

## Validation Commands
```bash
bun run typecheck   # framework + app
bun test
cd apps/customer-summary/eval && python -m pytest -q
```
