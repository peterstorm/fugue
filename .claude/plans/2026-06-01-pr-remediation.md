# PR Remediation Plan

**Date:** 2026-06-01
**Branch:** feat/azure-foundry-observability
**Findings:** 1 critical, 23 advisory (deduplicated across 6 agents)

This is the v9 review cycle. Prior rounds (v7, v8) fixed the shutdown wedge in the
framework, sink flush, type invariants, eval correctness, and comment hygiene.

## Critical Fixes

### Fix 1: Unguarded trace flush/shutdown can wedge the rest of shutdown
- **Source:** silent-failure-hunter
- **File:** apps/customer-summary/src/bootstrap.ts:346-375
- **Issue:** `await tracing.flush()` / `await tracing.shutdown()` run unguarded. The
  default single-backend path unwraps to a bare exporter (bypassing CompositeSpanExporter's
  never-reject guarantee), and the inner OTel shutdown chain propagates rejections. A
  rejecting trace shutdown therefore skips the BufferedObserver sweep dispose (leaking the
  sweep timer — the exact wedge prior rounds fixed), the Foundry sink drain (losing the
  final domain-event batch), and `redis.disconnect()`. The Foundry-sink flush directly
  below was already guarded; the trace steps were not.
- **Fix:** Guard each shutdown step (trace flush, trace shutdown, observer dispose, redis
  disconnect) independently so one failure cannot abort the others, mirroring the existing
  Foundry-sink try/catch.

## Advisory Fixes (applied this cycle — cheap & safe)

### Fix 2: Magic literal `0` instead of `ExportResultCode.SUCCESS`
- **Source:** architecture-agent (A4)
- **File:** packages/framework/src/tracing/azure-monitor-exporter.ts:221
- **Fix:** Import `ExportResultCode` (runtime) and compare against `.SUCCESS`, matching the
  sibling composite-exporter. Guards against a future enum reordering silently inverting
  the branch.

### Fix 3: ADR-0049 says adapter "raises"; it actually fails closed
- **Source:** comment-analyzer
- **File:** docs/adr/0049-foundry-native-eval-path-selectable.md:120-124
- **Fix:** Reword to "fails closed — surfaces the missing scorers / actual keys on stderr
  and returns a FAILED aggregate" (foundry_eval.py never raises on shape mismatch).

### Fix 4: ADR-0050 describes a discriminated union; shipped type is flat nullable interface
- **Source:** comment-analyzer
- **File:** docs/adr/0050-backend-selection-in-app-config.md:126-129, 148-150
- **Fix:** Describe the as-built `ResolvedObservability` (flat interface, `auth: ResolvedAuth
  | null`, foundry-enabled derived via the `isFoundryEnabled` type guard).

### Fix 5: composite-exporter cites undefined label "AD-2"
- **Source:** comment-analyzer
- **File:** packages/framework/src/tracing/composite-exporter.ts:10, 136
- **Fix:** Replace "(AD-2)" with "(ADR-0045)" — the actual decision record for this policy.

### Fix 6: `except OSError: pass` swallows temp-file cleanup failure with no log
- **Source:** silent-failure-hunter
- **File:** apps/customer-summary/eval/foundry_eval.py:285-286
- **Fix:** Emit a one-line stderr warning so a leaking temp dir is visible. Stays
  best-effort (still in `finally`, cannot affect verdict).

### Fix 7: FoundryRunSummaryObserver standalone-usability claim vs no-TTL leak
- **Source:** silent-failure-hunter, type-design-analyzer, architecture-agent (3 agents)
- **File:** apps/customer-summary/src/observability-composition.ts:114-118
- **Fix:** Qualify the comment so the bounded-buffer invariant is documented as
  contract-enforced by the wrapping BufferedObserver, and note standalone use is
  test-only (no orphan eviction). Production wiring is leak-free; this prevents a future
  maintainer from relying on standalone use that has no TTL.

## Deferred (design refactors / test additions — not correctness bugs)

These are judgment-call refactors that would alter the established fault-isolation
composition or add net-new tests; they are NOT applied this cycle to avoid regressing
verified behavior. Recommended for a dedicated follow-up:

- **A1 double-buffering**: `FoundryRunSummaryObserver` re-buffers and recomputes the summary
  the wrapping `BufferedObserver` already buffers. Correct but duplicated work/state.
- **A2 dead seam**: `RunSummaryExtras.totalTokens` is unreachable on the observer-derived
  channel; cost/tokens only flow via spans.
- **A3 speculative generality**: empty `ATTR_MAP` + identity `translateSpanForFoundry` +
  unreachable Proxy rename path; per-export no-op array allocation.
- **A5 factory indirection**: double-layer factory plumbing in bootstrap/compose with
  impossible-state throw guards.
- **A6 type duplication**: `AppInsightsClient` and `FoundryTelemetrySink` near-identical
  shapes that can drift.
- **A7 column-rename coupling**: `foundry_eval.build_foundry_rows` couples to
  `run.build_eval_data` column names with no typed/guarded input contract.
- **Dispatch-loop duplication**: the FoundryEmission→sink loop is duplicated between
  `AiFoundryObserver.observe` and `FoundryRunSummaryObserver.emitRunSummary`.
- **Python eval test gaps (5)**: per-row-drop WARNING branch, MLflow `compute_aggregate`
  non-canonical fallback + fail-closed branches, `build_evaluators` credential RuntimeError,
  `call_summarize` response parsing.
- **Partial-init**: tracing init failure leaves a live Foundry observer with no trace
  pipeline; "continuing without tracing" understates state.
- **FakeLlmClient prod fallback**: pre-existing app behavior, logged at warn; out of scope.

## Validation Commands

```bash
bun run --filter @ai-summary/framework typecheck
bun run --filter @ai-summary/framework test
bun run --filter customer-summary test
```
