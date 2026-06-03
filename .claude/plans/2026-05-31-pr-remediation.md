# PR Remediation — 2026-05-31

- **Date:** 2026-05-31
- **Branch:** feat/azure-foundry-observability
- **Review outcome:** 0 critical / advisory-only. All findings are documentation accuracy + a defensive validation guard + a test-dependency pin.

## Fixes applied (this agent — Python + Markdown)

- **Fix A** — `apps/customer-summary/eval/run.py` docstring: `MLFLOW_EXPERIMENT_NAME` default corrected from `customer-summary-eval` to `Default` (matches code default at run.py:318 and both docs).
- **Fix B** — `apps/customer-summary/eval/run.py` `--mode` env-default validation guard. Added `ALLOWED_MODES = ("full", "ci")`; extended the parse_args NOTE comment to cover both `--backend`/`EVAL_BACKEND` and `--mode`/`EVAL_MODE`; added a re-validation guard in `main()` (parallel to the backend guard) so a typo like `EVAL_MODE=cii` fails loud instead of silently running LLM judges (Azure cost) when CI-only was intended.
- **Fix C** — `apps/customer-summary/eval/foundry_eval.py` module docstring: narrowed the reuse claim to reflect reality — it reuses only `build_eval_data` from run.py and produces the same `AggregateResult` shape; it defines its own `compute_aggregate_foundry`.
- **Fix D** — `docs/eval-pipeline.md`: narrowed the matching "reuses the shared pure core" overstatement to reuse of `build_eval_data` + same `AggregateResult` shape; kept credentials / column-rename / "only scoring call + adapter differ" intact.
- **Fix E** — `docs/tracing-pipeline.md`: replaced stale `ratio(1.0)` sampling claim with the real default `anyOf(errorOnly(), hadRetry(), ratio(0.1))` and the `TRACE_SAMPLE_RATIO` (default `0.1`) tail-sampling description.
- **Fix F** — `apps/customer-summary/eval/requirements.txt`: pinned `pytest>=8.0` so the new `test_*.py` suites run in a clean env.

## Handled by sibling agent (TypeScript)

- `require()` → `createRequire`
- `ResolvedObservability` `foundryEnabled` derivation
- composite-exporter unused-binding
- observability-composition buffer comment

## Validation

See agent report for which validation path was used (pytest vs ast.parse) and the result.
