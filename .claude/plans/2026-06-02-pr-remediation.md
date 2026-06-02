# PR Remediation Plan

**Date:** 2026-06-02
**Branch:** feat/azure-foundry-observability
**Findings:** 2 critical, ~20 advisory (deduplicated across 6 review agents)

Review cohort: code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-agent. All agents reported
**0 critical correctness/fault-isolation/backwards-compat defects** in the
TypeScript; the two criticals are a fabricated requirement citation and an ADR
that drifted from the implemented type. The advisory set is hardening + hygiene.

## Critical Fixes

### Fix 1: Fabricated requirement citation `FR-060`
- **Source:** comment-analyzer
- **File:** apps/customer-summary/src/shutdown.ts:6
- **Issue:** Comment cites `FR-060`, which is not in this feature's spec
  (FR-001..FR-029); it belongs to the unrelated durable-runtime spec. Off-
  critical-path teardown is governed by **FR-028**.
- **Fix:** Replace `FR-060` with `FR-028`.

### Fix 2: ADR-0050 documents an abandoned type shape
- **Source:** comment-analyzer
- **File:** docs/adr/0050-backend-selection-in-app-config.md (Pure-resolver
  section + second Positive consequence)
- **Issue:** ADR says `ResolvedObservability` is a flat `auth: ResolvedAuth | null`
  with `isFoundryEnabled = auth !== null`. The shipped code is a discriminated
  union on `kind` (`mlflow-only` | `with-foundry`); `observability.ts` documents
  this deliberate divergence, but the ADR was never updated.
- **Fix:** Update both passages to describe the discriminated union (stronger
  "illegal states unrepresentable" story).

## Advisory Fixes

### Fix 3: Parity tolerance hardcoded `tol=0.5` (drift risk)
- **Source:** code-reviewer
- **File:** apps/customer-summary/eval/run.py:420
- **Fix:** Drop the explicit `tol=0.5` so `parity_within_tolerance(deltas)`
  inherits `parity.PARITY_TOLERANCE`, matching the adjacent `format_parity_table`.

### Fix 4: Partial-missing scorer is fail-OPEN despite "fail-closed" log text
- **Source:** silent-failure-hunter
- **Files:** apps/customer-summary/eval/run.py:151-181;
  apps/customer-summary/eval/foundry_eval.py compute_aggregate_foundry
- **Issue:** When SOME expected scorers are missing the code logs "fail-closed"
  but still averages the survivors and can report PASS. A silently-dropped
  scorer (judge misconfig / SDK shape drift) averages away to green.
- **Fix:** When `missing` is non-empty, return a FAILED aggregate (passed=False)
  over the surviving means — actually fail closed, matching the log + the
  feature's fail-closed contract.

### Fix 5: Brand asymmetry + duplicated finiteness predicate
- **Source:** type-design-analyzer (D4, D5)
- **File:** packages/framework/src/observer/foundry-event-mapping.ts
- **Fix:** Brand event `measurements` as `Record<string, FiniteNumber>` (symmetry
  with `metric.value`), and delete `isFinite_` — reuse the `asFinite` smart
  constructor inside `finiteMeasurements`. Invariant moves into the type.

### Fix 6-7: Stale review-cycle labels in comments
- **Source:** comment-analyzer (E1)
- **Files:** azure-monitor-exporter.ts ("Fix 1"/"Fix 2");
  foundry_eval.py:133,291,323 ("C1"/"Fix 5"); run.py:437 ("C2")
- **Fix:** Strip the round-numbering prefixes; keep the explanatory prose.

### Fix 8: `foundry_eval.py` docstring overstates evaluate_fn default
- **Source:** comment-analyzer (E2)
- **File:** apps/customer-summary/eval/foundry_eval.py:21-24
- **Fix:** Default is `_real_evaluate` (a lazy wrapper), not
  `azure.ai.evaluation.evaluate` directly.

### Fix 9: bootstrap MLflow health-probe comment over-claims checkRedis parity
- **Source:** comment-analyzer (E3)
- **File:** apps/customer-summary/src/bootstrap.ts:348
- **Fix:** `checkRedis` does no live I/O; reword the "matches checkRedis's bounded
  intent" clause.

### Fix 10: Test fake uses magic `cb({ code: 0 })`
- **Source:** pr-test-analyzer (C3)
- **File:** apps/customer-summary/src/__tests__/observability-composition.test.ts:61-68
- **Fix:** Name the success code via a local constant documenting it mirrors
  `ExportResultCode.SUCCESS` (app stays decoupled from direct OTel import).

### Fix 11: Untested — `run_both_backends` Foundry-leg exception isolation
- **Source:** pr-test-analyzer (C1, rating 7/10)
- **File:** apps/customer-summary/eval/test_backend_selector.py
- **Fix:** Add a case where `run_foundry_backend` RAISES during `--backend=both`;
  assert rc==1, MLflow still ran, stderr names the Foundry-leg failure.

### Fix 12: Untested — `resolveFoundryLeg` throwing `buildSink` branch
- **Source:** pr-test-analyzer (C2, rating 5/10)
- **File:** apps/customer-summary/src/__tests__/observability-composition.test.ts
- **Fix:** Add a case: exporter builds, sink construction throws → MLflow-only
  degraded `effective`, logged.

## Deferred (documented, not fixed)

- **D1 — non-empty tuple for `traceBackends`:** Would propagate the proven
  non-empty invariant into the type and delete one unreachable throw. Deferred:
  `.filter()`/loop construction (config transform, resolveFoundryLeg degraded
  path) erases tuple-ness, forcing equivalent `as` casts back — net-neutral on
  invariant strength, and the current single documented unreachable-throw is
  honest defense-in-depth. Advisory, not a defect.
- **D2 — `ResolvedAuth` weak union:** Both arms identical today, but the union is
  the correct shape for the planned entra-id `TokenCredential` field. Leave.
- **D3 / F2 — `FoundryRunSummaryObserver` double-buffering / unbounded inner
  Map:** Bounding holds under the wrapping `BufferedObserver` contract (TTL
  eviction). Removing the redundancy needs a framework `Observer`-with-summary
  capability — out of remediation scope.
- **D6 — dead `Proxy` translate branch:** Documented forward seam for a future
  `ATTR_MAP`; removing it loses the extension point. Leave with its comment.
- **D7 — shared-policy invariant not type-enforced:** Not cleanly expressible in
  TS without a nominal token; production path threads the same instance.
- **F1 — entra-id `useAzureMonitor` global-provider coupling:** ✅ **FIXED** in a
  follow-up commit (initially deferred). Investigation of `applicationinsights@3.15.0`
  internals proved `useAzureMonitor` was unnecessary: an ISOLATED client
  (`useGlobalProviders: false`) authenticates via AAD by setting
  `config.aadTokenCredential`, which the shim's lazy `initialize()`/`parseConfig()`
  forwards into the isolated `TelemetryClientProvider`'s Azure Monitor exporter
  (verified at `shim-config.js:107-109` and `telemetryClientProvider.js:83/109/135`).
  Both auth modes now build an isolated client — entra-id differs only by attaching
  the credential — so the sink no longer registers a process-global OTel provider
  and can never race the framework's `NodeSDK` `TracerProvider`. The `useAzureMonitor`
  import, the `configureGlobalPipeline` seam, and the `AzureMonitorInit` type are gone.
- **F5 — per-export `setTimeout` allocation:** Micro-optimization; timers are
  `unref`'d and cleared. Only worth it if profiled.
- **B2 — eval verdict ignores errored-case count:** Pre-existing on `main`
  byte-for-byte (not introduced here); a min-success-rate gate is out of scope.

## Validation Commands
```bash
cd packages/framework && bun run typecheck && bun test
cd apps/customer-summary && bun run typecheck && bun test
# Python eval (pytest unavailable in CI env — static review only)
cd apps/customer-summary/eval && python -m pytest -q  # if available
```
