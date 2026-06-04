# PR Remediation Plan (v3)

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Findings:** 0 critical, 6 advisory (6-agent verification cohort, 7th cycle). 3 actionable advisories applied; 3 deferred by design. User elected "fix all 3 actionable + commit/push".

## Context

7th iterative review cycle on the extensible-capability branch (101 files, 7996 insertions). Five of six agents returned 0/0; only `pr-test-analyzer`, `type-design-analyzer`, and `architecture-agent` surfaced advisories. No CRITICAL anywhere. All prior-cycle deliberate patterns (never-throw observers, fail-closed boot validation, single `extractClients` cast, SAS-URL diagnostics, `withTracedCapability` this-binding) re-confirmed intact and unflagged.

## Fixes Applied

### Fix 1 (A3): Route `transient` error construction through the canonical factory (type-design)
- **Source:** type-design-analyzer
- **Files:** `packages/framework/src/types/error-factories.ts:33`, `packages/framework/src/http/http-capability.ts:55`, `packages/adapter-ms-graph/src/index.ts:122`
- **Issue:** The `transient.httpStatus` field (added at `errors.ts:88`) had no constructor in its canonical factory `frameworkError.transient`; two independent inline object literals (`makeTransientError`, `transientErr`) duplicated the `...(httpStatus !== undefined ? {httpStatus} : {})` spread, bypassing the single-construction-boundary intent of `error-factories.ts`.
- **Fix:** Added an optional `httpStatus?` param to `frameworkError.transient` (purely additive — existing 2-arg callers produce identical output). Both `makeTransientError` and `transientErr` now delegate to it, so the spread logic lives in exactly one place; the local helpers only pin their sentinel node id.

### Fix 2 (A1): Test `createFakeHttpCapability` non-2xx-status branch (pr-test-analyzer)
- **Source:** pr-test-analyzer (rating 6/10, important)
- **File:** `packages/framework/src/__tests__/http-capability.test.ts`
- **Issue:** The fake's headline documented feature — a `{status: 404, body}` route producing the same `transient` error with `httpStatus` set as the real capability — was untested. A regression to the status check (`>= 400` vs `< 200 || >= 300`) would silently break fake-backed status-branch tests.
- **Fix:** Added a test asserting a `status: 404` route yields `kind: "transient"` with `httpStatus === 404` and a message containing `404`.

### Fix 3 (A2): Test ms-graph `graphGet` redirect-target-error branch (pr-test-analyzer)
- **Source:** pr-test-analyzer (rating 4/10, low)
- **File:** `packages/adapter-ms-graph/src/__tests__/ms-graph.test.ts`
- **Issue:** The `if (!redirected.ok) return err(mapGraphStatus(...))` branch (an expired presigned download URL → 4xx after a `/content` 302) was untested; the two other redirect branches (success, missing-Location) were covered.
- **Fix:** Added a two-hop fetch-mock test: `/content` returns `302 → cdnUrl`, the off-origin host returns `403`; asserts `node-crash` / non-retriable and that both hops were attempted.

## Deferred (no change — documented design)

- **A4 — `NodeContextInit.capabilities` infra-key collision (type-design):** An augmented capability key colliding with an always-present infra field (`logger`/`tracer`/`observer`) is representable in the type but caught only at runtime by `RESERVED_CONTEXT_KEYS`. Unpreventable in the type because `Capability` is open via module augmentation. Guard is correct and well-documented. Design limitation, not a defect.
- **A5 — Handle `name` not validated against the registry key set at boot (architecture):** A typo'd adapter name passes `topoSortHandles` and surfaces as a run-time `missing-capability` rather than a boot error. Same trust-boundary class as the documented `extractClients` cast; closing it requires a runtime registration list (the registry is not enumerable via module augmentation) — a design choice, not a one-line fix.
- **A6 — `checkHealth` machinery built but unwired (architecture):** Per-adapter health checks exist and are tested, but nothing in the host runtime polls them. Explicitly documented as a follow-up in both `capability-manager.ts` and `capability-handle.ts`. Larger feature, out of scope.

## Validation

```bash
bun run typecheck   # @fugue/framework, @fugue/host, @fugue/customer-summary → all exit 0 (against source)
bun test            # framework: 2604 pass (+1 new A1), 45 fail / 33 err = pre-existing CLI/subprocess/infra (baseline identical)
                    # ms-graph: 72 pass (+1 new A2), 0 fail
```

**Note on `tsc --build`:** Regenerating the gitignored framework `dist/` declarations via project references is blocked by a *pre-existing*, unrelated error — `azure-monitor-exporter.ts:44 TS2441 Duplicate identifier 'require'` (confirmed present with changes stashed). The project's typecheck gate is per-package `tsc --noEmit` against source, which passes. The `error-factories.transient` change is additive (optional param), so the ms-graph delegation is a valid call against the new signature; only the stale local `dist` showed the old 2-arg form.
