# PR Remediation Plan

**Date:** 2026-06-02
**Branch:** feat/azure-foundry-observability
**Findings:** 1 critical, 11 advisory (across 6 review agents)
**Cycle:** v2 (post-`4b3bc2f`; feature reviewed 9+ times prior)

## Review aggregate

| Agent | Critical | Advisory |
|---|---|---|
| code-reviewer | 0 | 0 |
| silent-failure-hunter | 0 | 3 |
| pr-test-analyzer | 0 | 2 |
| type-design-analyzer | 0 | 2 |
| comment-analyzer | 1 | 2 |
| architecture-tech-lead | 0 | 2 (both sub-threshold, no action) |

## Critical Fixes

### Fix 1: shutdown comment scopes batching to one auth mode
- **Source:** comment-analyzer
- **File:** apps/customer-summary/src/shutdown.ts:87-88
- **Issue:** Comment said "the isolated connection-string-mode client batches track calls", but `createAppInsightsClient` (foundry-sink.ts:142) builds an isolated batching client for BOTH auth modes (entra-id only adds a credential). A maintainer could wrongly conclude the final flush is unnecessary under entra-id and drop it, losing the last batch.
- **Fix:** Reword to state the flush is required under both modes; cross-reference `createAppInsightsClient`. Matches the file's own header (shutdown.ts:13-15).

## Advisory Fixes (applied)

### Fix 2: non-empty invariant erased from the type (parse-don't-validate)
- **Source:** type-design-analyzer
- **Files:** config.ts:121, observability.ts:56-62, observability-composition.ts:200-220, :314-327
- **Issue:** `OBSERVABILITY_TRACE_BACKENDS` transform proves non-empty (rejects empty with `z.NEVER`) but returned the widened `readonly TraceBackend[]`, discarding the invariant and forcing an "unreachable" runtime guard in `composeObservability`.
- **Fix:** Introduce `TraceBackends = readonly [TraceBackend, ...TraceBackend[]]`; flow it through `ResolvedObservability`; rebuild exporters from a destructured head/tail (head proven present) → deleted the unreachable guard. Degraded-leg path rebuilds a non-empty tuple too.

### Fix 3: duplicated FoundryEmission→sink dispatch
- **Source:** type-design-analyzer
- **Files:** packages/framework/src/observer/ai-foundry-observer.ts, observer/index.ts, apps/customer-summary/src/observability-composition.ts
- **Issue:** The emission `kind` discriminant → `trackEvent`/`trackMetric` dispatch (with optional-channel spreads) was written verbatim in both `AiFoundryObserver.observe` and `FoundryRunSummaryObserver.emitRunSummary`.
- **Fix:** Extract exported pure `forwardEmission(sink, emission)` in the framework (does NOT catch — callers keep their own try/catch + context-specific log). Both sites now call it.

### Fix 4: empty-but-present metrics logged at WARNING, not ERROR
- **Source:** silent-failure-hunter
- **File:** apps/customer-summary/eval/foundry_eval.py (compute_aggregate_foundry)
- **Issue:** An empty `{}` metrics dict (every row errored) took the WARNING branch even though "SDK ran but produced zero metrics" is a contract failure. Verdict was already fail-closed; only signal severity was wrong.
- **Fix:** When no expected scorer matched at all (`not scorer_means`), log at ERROR with an adaptive message (empty dict vs. keys-but-none-matched). Partial-missing still WARNs. Strengthened `test_empty_metrics` → asserts the ERROR signal.

### Fix 5: EVAL_MODE main() re-validation untested
- **Source:** pr-test-analyzer
- **File:** apps/customer-summary/eval/test_backend_selector.py
- **Issue:** The symmetric partner of the tested `EVAL_BACKEND=foundryy` path — a bogus `EVAL_MODE` env default surviving argparse and being caught in `main()` — had no test, despite the code comment flagging the risk (`EVAL_MODE=cii` silently running LLM judges).
- **Fix:** Added `test_env_mode_default_bypasses_argparse_choices` (parse_args) and `test_bogus_mode_env_exits_nonzero_without_running_backend` (main() fails loud before any dispatch/collect).

### Fix 6: createFoundrySink composer never directly tested
- **Source:** pr-test-analyzer
- **File:** apps/customer-summary/src/__tests__/observability-composition.test.ts
- **Issue:** The production composer `createFoundrySink = foundrySinkOver(createAppInsightsClient(...))` had no direct test (constituents were individually covered).
- **Fix:** Added a test asserting the resolved auth's connection string reaches the isolated client ctor and the returned sink forwards onto that client.

### Fix 7 & 8: comment readability (foundry-sink.ts header)
- **Source:** comment-analyzer
- **File:** apps/customer-summary/src/foundry-sink.ts:28-33
- **Fix:** Reflowed the run-on fail-tolerance sentence. (azure-monitor-exporter.ts:36-41 left as-is — accurate and the density is acceptable; reformatting a correct, valuable comment is churn.)

## Deferred (deliberate, test-locked design decisions — NOT reversed unilaterally)

### Defer A: bootstrap blanket-catch degrades all tracing silently
- **Source:** silent-failure-hunter (advisory)
- **File:** apps/customer-summary/src/bootstrap.ts:78-156
- **Reason:** The `try` wraps MLflow exporter construction AND `initTracing`, so an MLflow/init failure (not just Foundry) is caught, logged at `error`, and the app continues with `tracing = null` while readiness still reports ready. This is the established "observability is best-effort, Redis is the only hard dependency" design — making tracing gate readiness (or fail bootstrap) is a **product decision**, not a remediation. The Foundry-leg isolation it's contrasted with is already handled inside `resolveFoundryLeg`.
- **Recommendation:** If observability-of-observability is wanted, add a `tracing-degraded` health flag surfaced by readiness (without gating traffic). Needs product sign-off.

### Defer B: dropped eval rows warned, not fail-closed
- **Source:** silent-failure-hunter (advisory)
- **File:** apps/customer-summary/eval/foundry_eval.py:340-350
- **Reason:** When the SDK returns fewer rows than submitted, errored rows are averaged into the aggregate and only a WARNING fires. This is the one spot inconsistent with the module's fail-closed posture — BUT it is a **deliberate, tested** choice: `test_fewer_rows_returned_than_submitted_warns` explicitly asserts `agg.passed is True` and the comment states "additive, does NOT change the verdict". Flipping it to fail-closed reverses a tested invariant.
- **Recommendation:** Decide whether SC-002 ("100% of valid cases scored") should make a row drop fail the run. If yes, force `passed=False` on `returned < submitted` and update the test to assert fail-closed. Owner call.

## Validation Commands
```bash
# framework
(cd packages/framework && bun run typecheck && bun test src/observer src/tracing)
# app
(cd apps/customer-summary && bun run typecheck && bun test)
# python eval (needs pytest; pandas/numpy unavailable on this box for build_foundry_rows tests)
python -m pytest test_foundry_eval.py::TestComputeAggregateFoundry test_backend_selector.py -q
```

## Validation Results
- Framework typecheck: ✅  · observer+tracing tests: ✅ 79/79
- App typecheck: ✅  · app tests: ✅ 175/175
- Python: ✅ changed/added tests 10/10 (TestComputeAggregateFoundry + new EVAL_MODE tests). 14 pandas-dependent tests fail on `libstdc++.so.6`-missing numpy — pre-existing environmental, untouched code.
- Framework full suite: 11 fails are Redis(:16379 down) + runLint subprocess — pre-existing/environmental, untouched code.
