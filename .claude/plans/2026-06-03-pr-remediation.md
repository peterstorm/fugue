# PR Remediation Plan

**Date:** 2026-06-03
**Branch:** feat/azure-foundry-observability
**Findings:** 0 critical, 8 advisory (acted on); remainder deferred/skipped with rationale

This is the v13 review cycle of the Azure Foundry observability feature (58 files
vs main, ~9077 insertions). A 6-agent cohort (code-reviewer, silent-failure-hunter,
pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent) reported
**0 critical** across the board — consistent with the v9–v12 clean cycles. The
advisories below are genuine polish; the cheap, high-value wins were applied.

## Advisory Fixes Applied

### Fix 1 (C + I): Extract a single `isCacheHit` predicate (exhaustive)
- **Source:** type-design-analyzer + architecture-agent
- **Files:** `packages/framework/src/observer/foundry-event-mapping.ts`,
  `packages/framework/src/observer/index.ts`,
  `apps/customer-summary/src/observability-composition.ts`
- **Issue:** The cache-hit rule (`node-skipped` reason `checkpoint`) was duplicated
  in `mapEventToFoundry` (a non-exhaustive `if (reason !== "checkpoint")`) and the
  app's `FoundryRunSummaryObserver.cacheHitCount` filter — across two packages with
  no compile-time link. A new skip reason would compile silently into the wrong
  branch.
- **Fix:** New exported `isCacheHit(NodeSkippedEvent)` in the pure mapping module,
  using ts-pattern `.exhaustive()` over the reason union (a new reason becomes a
  compile error). Both call sites now consume it — single source of truth.

### Fix 2 (A): Log health-probe rejections in `checkReadiness`
- **Source:** silent-failure-hunter
- **File:** `apps/customer-summary/src/server.ts`
- **Issue:** `.catch(() => false)` on `checkRedis`/`checkMlflow` discarded the
  rejection reason at the site — safe today only because current implementers
  self-log; a future probe throwing without internal logging would flip readiness
  silently.
- **Fix:** Catch now `log.debug`s the rejection (safe-by-construction breadcrumb).

### Fix 3 (B): Numeric guard on the MLflow canonical-key scorer branch
- **Source:** silent-failure-hunter
- **File:** `apps/customer-summary/eval/run.py`
- **Issue:** `compute_aggregate` accepted `metrics[canonical_key]` without the
  `isinstance(value, (int, float)) and not bool` guard the Foundry path applies —
  a non-numeric value (None/str/bool, shape drift) would be folded into
  `overall_mean` unchecked.
- **Fix:** Both canonical and suffix-fallback branches now require a numeric value
  and cast to `float`; a non-numeric value falls through to the fail-closed
  missing-scorer path. Symmetric with `foundry_eval.compute_aggregate_foundry`.

### Fix 4 (D): Fault-isolate the standalone `backend=foundry` dispatch
- **Source:** code-reviewer (sub-threshold)
- **File:** `apps/customer-summary/eval/run.py`
- **Issue:** The `backend == "foundry"` branch called `run_foundry_backend` with no
  try/except, so a missing-credentials `RuntimeError` surfaced as a raw traceback —
  inconsistent with the `backend=both` Foundry guard.
- **Fix:** Wrapped in the same named fail-closed handler (distinct ERROR message,
  exit 1).

### Fixes 5–8 (E–H): Edge-path test coverage
- **Source:** pr-test-analyzer
- **Files:** `composite-exporter.test.ts`, `azure-monitor-exporter.test.ts`,
  `foundry-event-mapping.test.ts`, `test_run.py`, `test_parity.py`,
  `test_backend_selector.py`
- Added: composite rate-limit at the 1000th occurrence (locks the `Math.log10`
  power-of-ten float edge); Azure exporter empty/multi-span batch forwarding;
  run-end all-non-finite measurements omitting the bag on the event channel;
  `isCacheHit` unit + coupling tests; MLflow non-numeric/bool canonical value
  fail-closed; standalone-foundry-leg-raises fault isolation; `compute_parity`
  NaN mean fails closed.

## Deferred (documented, not minimal/in-scope)
- **ResolvedAuth 2-arm DU with structurally identical arms** (`observability.ts`):
  intentional seam for future entra-id-specific payload — no behaviour change to
  make; left as-is.
- **FoundryRunSummaryObserver double-buffer / bounded-growth invariant in comment**:
  documented and enforced by the wrapping `BufferedObserver` contract; a real
  refactor (derive summary from the buffered replay slice) is larger than the
  "minimal edit" remit and was rated low severity by both agents.

## Skipped (out of scope)
- Two comment-analyzer doc advisories (`docs/tracing-pipeline.md:81`,
  `docs/eval-pipeline.md:85`) are **pre-existing on main** in the MLflow sections,
  not Foundry-feature drift.

## Validation Commands
```bash
# Framework
(cd packages/framework && bun run typecheck && bun test)
# App
(cd apps/customer-summary && bun run typecheck && bun test)
# Python eval (needs pytest+pandas+numpy; libstdc++/zlib on Nix)
(cd apps/customer-summary/eval && python -m pytest -q)
```

## Validation Results
- Framework: typecheck ✅; **2666 pass** (+8 new), 0 new failures. 11 pre-existing
  failures are stale `dist/` compiled CLI tests — identical on clean HEAD,
  unrelated to this feature (a separate build-hygiene wart).
- App: typecheck ✅; **184 pass, 0 fail**.
- Python eval: **76 pass** (+4 new), 0 fail.
