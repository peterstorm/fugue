# PR Remediation Plan — v4 (safe-wins tier)

**Date:** 2026-06-02
**Branch:** feat/azure-foundry-observability
**Findings:** 0 critical, 14 advisory — user selected the **safe-wins tier (1-8)**.

The branch passed all six review agents with **zero critical** findings. The
items below are improvements on already-correct, multiply-reviewed code: doc
accuracy, type tightening, and test additions. No behavior change to shipping
paths (the one incidental coherence fix in `setUpTracing`'s catch is called out).

## Safe-wins fixes (selected)

### Fix 1 — ADR-0044 inaccurate composite-wrapping location
- **Source:** comment-analyzer
- **File:** `docs/adr/0044-thin-factories-bootstrap-composition.md:112-113`
- **Issue:** Claims the app's `observability-composition.ts` "wraps it in
  `CompositeSpanExporter`," but wrapping actually happens inside
  `initTracing`/`normalizeExporter` (only for N≥2). Contradicts ADR-0046 and
  ADR-0044's own line 106-108. Neither app file constructs a composite.
- **Fix:** Reword to "builds the exporter list and passes it to the widened
  `initTracing`, which wraps it in a `CompositeSpanExporter` only when ≥2
  backends are selected (ADR-0046)."

### Fix 2 — ADR-0049 lists `compute_aggregate` as shared
- **Source:** comment-analyzer
- **File:** `docs/adr/0049-foundry-native-eval-path-selectable.md:89-91, 129-131`
- **Issue:** Lists `compute_aggregate` among functions "written once / shared,"
  but the Foundry path uses its own `compute_aggregate_foundry` (differing SDK
  metric-key shapes). Only `parse_cases`/`build_eval_data`/`format_results_table`
  are literally shared.
- **Fix:** Move aggregation out of the "written once" list; describe it as shared
  *semantics* (same `AggregateResult`, ≥4.0 threshold, fail-closed-on-missing)
  implemented per-backend. Soften the Invariant at 129-131 to "equivalent
  aggregation semantics."

### Fix 3 — `ResolvedFoundryLeg.active.effective` not narrowed
- **Source:** type-design-analyzer
- **File:** `apps/customer-summary/src/observability-composition.ts:240-246`
- **Issue:** The `active` arm types `effective` as the full `ResolvedObservability`
  union, though an active leg always means Foundry succeeded ⇒ `with-foundry`.
- **Fix:** Narrow to `Extract<ResolvedObservability, { kind: "with-foundry" }>`.
  Pure type tightening — `resolveFoundryLeg` already narrows `resolved` past the
  `isFoundryEnabled` guard before building the `active` arm.

### Fix 4 — `DEFAULT_MODELS` keyed by `string`
- **Source:** type-design-analyzer
- **File:** `apps/customer-summary/src/config.ts:139`
- **Issue:** `Record<string, string>` hides a latent `undefined` that
  `bootstrap.ts:276-277` relies on never occurring.
- **Fix:** `Record<Config["LLM_PROVIDER"], string>` — a missing provider becomes a
  compile error and `DEFAULT_MODELS[provider]` is `string`, not `string | undefined`.

### Fix 6 — bootstrap "continue without tracing" catch path untested
- **Source:** pr-test-analyzer
- **File:** `apps/customer-summary/src/bootstrap.ts:154` (no `bootstrap.test.ts`)
- **Issue:** The catch that keeps the app booting when `initTracing` throws is the
  one untraced seam; it lives inline in monolithic `bootstrap()` (needs Redis/LLM),
  so it cannot be unit-tested as-is.
- **Fix:** Extract the tracing-init block into an exported, seam-injectable
  `setUpTracing(resolved, config, log, seams?)` returning
  `{ tracing, observer, foundrySinkForFlush }` (behavior-preserving). Add
  `__tests__/setup-tracing.test.ts` driving the catch path with a throwing
  `initTracing` seam. **Incidental:** the catch now returns a coherent
  `{ null, NoopObserver, null }` instead of leaving the observer/sink half-wired
  (this resolves advisory 10, which the user did not separately select — it is a
  strict improvement and the natural result-type of the extraction).

### Fix 7 — eval CLI startup fail-closed guards untested
- **Source:** pr-test-analyzer
- **File:** `apps/customer-summary/eval/run.py:486-488, 495-497`
- **Issue:** Non-numeric `EVAL_WORKERS` `ValueError` guard and `load_cases`
  failure guard (both fail-closed `return 1`) have no coverage.
- **Fix:** Add tests in `test_backend_selector.py` asserting `rc == 1` + the named
  error message for each, without dispatching any backend.

### Fix 8 — single-backend `passed=False → rc=1` tail unasserted
- **Source:** pr-test-analyzer
- **File:** `apps/customer-summary/eval/run.py:533-535`
- **Issue:** `TestMainDispatch` only stubs `passed=True`; the single-backend
  failure tail (distinct from the tested `both` failure) is unasserted.
- **Fix:** Add a `passed=False` dispatch test asserting `rc == 1`.

## Deferred (within tier, on inspection)

### Fix 5 — `AzureMonitorInnerOpts` re-admits `{}`
- **File:** `packages/framework/src/tracing/azure-monitor-exporter.ts:51-54`
- **Reason:** The `{ createInner }`-only test seam (no `auth`) **deliberately**
  hands the factory empty opts `{}` (documented at line 87). `AzureMonitorInnerOpts`
  must therefore permit `{}` — it is the SDK's exact input shape and a required,
  legitimate state, not an erased invariant. Tightening it would break the
  documented no-auth seam. The "at least one present" invariant is correctly
  enforced *upstream* by `AzureMonitorAuth` + the runtime `resolveOpts` throw.
  No change is the correct call.

## Validation Commands
```bash
cd packages/framework && bun run typecheck
cd apps/customer-summary && bun run typecheck && bun test
cd apps/customer-summary/eval && python3 -m pytest test_backend_selector.py test_run.py -q  # if pytest available
```
