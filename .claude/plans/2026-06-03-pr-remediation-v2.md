# PR Remediation Plan (v14 cycle)

**Date:** 2026-06-03
**Branch:** feat/azure-foundry-observability
**Findings:** 0 critical, 6 advisory (all reviewer-flagged defensible/intentional)
**Scope decision:** User opted to fix the 3 actionable advisories (#1, #2, #5).

## Review Summary

Six-agent parallel cohort (code, errors, tests, types, comments, architecture) ran
against the full branch diff vs `main` (59 files, 9419 insertions). **Zero critical
findings.** Every contract (never-throw, fault-isolation, fail-closed, backwards-compat,
graceful degradation) is directly tested; both typechecks pass.

The 6 advisories were all explicitly flagged by the reviewers themselves as
defensible / intentional / correct-as-wired. The user selected the 3 actionable
ones below; the other 3 (bootstrap `Observer` shutdown cast, `foundry-sink`
`as unknown as` SDK casts, double-buffering redundancy) were left as-is per the
reviewers' own "no change needed" assessments.

## Fixes Applied

### Fix 1: Symmetric fault-isolation of the MLflow leg in `run_both_backends`
- **Source:** silent-failure-hunter
- **File:** `apps/customer-summary/eval/run.py:419`
- **Issue:** The Foundry leg was fault-isolated (try/except → distinct error, rc=1)
  but the MLflow leg was not; an MLflow raise aborted `--backend=both` with a bare
  traceback before the Foundry leg/parity ran. Loud + fail-closed, not a silent
  failure — pure presentation asymmetry.
- **Fix:** Wrapped `run_mlflow_backend` in a named-error guard symmetric with the
  Foundry leg: prints a DISTINCT "MLflow-leg ... FAILED" message to stderr and
  returns 1 fail-closed. Added the symmetric test
  `test_mlflow_leg_raises_is_fault_isolated` (asserts rc=1, Foundry never
  dispatched, "MLflow-leg" on stderr).

### Fix 2: `NonEmptyString` brand for `connectionString` (illegal-state-unrepresentable)
- **Source:** type-design-analyzer
- **Files:** `azure-monitor-exporter.ts:67`, `observability.ts:42`, `config.ts:86`
- **Issue:** `connectionString` typed as bare `string` permits `""` at compile time;
  the non-blank invariant was only enforced at runtime + config normalization.
- **Fix:** Added `packages/framework/src/types/non-empty-string.ts` —
  `NonEmptyString = string & { brand }` with the sole smart constructor
  `asNonEmptyString` (returns the untrimmed original when non-blank, else
  `undefined`). Minted at the config parse boundary (`APPLICATIONINSIGHTS_CONNECTION_STRING`
  transform), threaded unchanged through `ResolvedAuth` and `AzureMonitorAuth`.
  A blank connection string is now unrepresentable at compile time, with the
  runtime guard retained for the dynamic (env-derived) boundary. Production code
  needed no construction changes — the brand flows naturally; only the type defs,
  the mint, and the test construction sites changed.

### Fix 5: Integration smoke test for the real-`require` Azure load path
- **Source:** architecture-tech-lead
- **File:** `packages/framework/src/tracing/azure-monitor-exporter.test.ts`
- **Issue:** Every test injected the `createInner` seam, so the real synchronous
  load `createRequire(__filename)` → `require("@azure/...")` → destructure →
  `new AzureMonitorTraceExporter(opts)` was never exercised; a package
  export-shape or `__filename`-anchor regression would surface only in production.
- **Fix:** Added a smoke test that constructs the exporter with real auth and NO
  seam, asserting it loads the SDK and returns a usable `SpanExporter`
  (construction only — the OTel exporter is passive, so no network/background
  work). Closes the seam-only gap.

## Validation Commands

```bash
# Typecheck (both packages)
cd packages/framework && bun run typecheck      # ✅ clean
cd apps/customer-summary && bun run typecheck    # ✅ clean

# Tests
cd packages/framework && bun test src/           # ✅ 1383 pass, 0 fail
cd apps/customer-summary && bun test             # ✅ 184 pass, 0 fail
# Python eval: run.py compiles; run_both_backends both branches verified directly
# (pytest unavailable in this sandbox — new test mirrors the existing Foundry-leg test)
```

## Notes

- 11 failures in the full `bun test` sweep are stale `dist/__tests__/**` compiled
  artifacts (lint/describe/bin), pre-existing and unrelated to this change — the
  `src/` equivalents all pass.

## Deferred (not actionable / reviewer "no change needed")

- **bootstrap.ts:421** `Observer as Partial<Disposable> & { close?: () => void }` —
  defensive shutdown probe; model an optional dispose member only if it becomes
  load-bearing.
- **foundry-sink.ts:119,125** `as unknown as` SDK narrowing casts — single-sited
  in `defaultSeams`, sound, already documented.
- **observability-composition.ts double-buffering** — correct as-wired (bounded by
  the same terminal `run-end`); intentional temporal coupling documented inline.
