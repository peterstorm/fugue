# PR #41 remediation — round 4

- **Branch:** `feat/f3-budget-capability-surface`
- **Revision reviewed:** `2bd35c5aa69950e72a93814c56757f4b55572562`
- **Review run:** `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round4`
- **Frozen scope:** the paths in that run's authoritative `result.json`
- **Support paths:** this plan and `packages/host/src/__tests__/runtime-capabilities.test.ts`, a focused regression surface newly added for the accepted guarded-diagnostics advisory
- **Refuted criticals:** none

## Surviving critical findings

1. **`code-reviewer-1` — inherited `init.capabilities`:** accept a capability bag only when `capabilities` is an own property of `NodeContextInit`; add direct and `Object.prototype` regressions proving inherited bags cannot inject built-in or custom authority.
2. **`silent-failure-hunter-1` — throwing `mintFor` accessor:** read and type-check `broker.mintFor` inside the existing snapshot Result fence, classify hostile accessors/proxies as validation errors, and prove run-start/run-end telemetry remains balanced.
3. **`comment-analyzer-1` — stale one-call concurrency claim:** correct the module-level SC-003/FR-W1 language to distinguish sequential pre-call overshoot from estimate-based concurrent admission.
4. **`comment-analyzer-2` — stale one-call durability window:** document that the crash window is every concurrently settled append still pending, while each individual append retains cost-first directional partial-write behavior.

## Advisory dispositions

### Accepted

1. **`code-reviewer-2` — BigInt Zod details:** preserve valid internal Zod issues but convert response details to an immutable JSON-safe wire tree before `c.json`; cover bigint minima/maxima/literal values and confirm a structured 400 response.
2. **`code-reviewer-3` — specialized `invalid_format`:** require `pattern`, `prefix`, `suffix`, and `includes` for their corresponding format discriminants; add positive and negative cases.
3. **`silent-failure-hunter-2` — runtime capability logs:** route all optional-selection diagnostics through the existing guarded logger so logger transport failures cannot abort successful wiring; add a throwing-logger regression.
4. **`pr-test-analyzer-1` — retry-budget mint throw:** prove a throwing `mintFor` is classified non-retriable and invoked once even with retry budget.
5. **`pr-test-analyzer-2` — positive Zod issue coverage:** exercise every canonical issue discriminant, including recursive variants and custom params, so parser tightening cannot reject valid errors unnoticed.
6. **`pr-test-analyzer-3` — Redis ordering:** pin cost-first `HINCRBY` order and fail-fast partial append behavior with a recording/failing Redis fake.
7. **`comment-analyzer-3` — context factory header:** say the factory threads caller-supplied run identity and signal rather than creating them.
8. **`comment-analyzer-4` — meter attribution:** document that the pure meter keys by run ID; DAG/node attribution belongs to the Run Spend Authority diagnostics.
9. **`code-simplifier-1` — executor fixture:** reuse `testNodeContext` for the local executor fixture while preserving overrides.
10. **`code-simplifier-2` — routing DAG duplication:** extract the shared two-way routing DAG builder parameterized by router output.
11. **`code-simplifier-3` — spend-store operation union:** give the repeated internal union one `SpendStoreOperation` name.

### Deferred

1. **`architecture-tech-lead-1` — typed context-factory Result seam:** unchanged from rounds 2–3. A correct migration must update the public context factory, error ADT, HTTP shell, HITL worker shell, host wiring, integration tests, and dozens of direct factory tests atomically. Partial wrapping would create competing error channels.
2. **`architecture-tech-lead-2` — split wide Redis port:** valid architectural deepening, but it spans cache, checkpoints, HITL, admission, tokens, locks, and spend rather than this F3 remediation. It requires a dedicated port migration with consumer-owned interfaces and adapter/integration tests; narrowing only the spend caller would leave the public shallow seam in place.

### Dismissed

None.

## Validation

```bash
bun test packages/framework/src/__tests__/make-node-context-merge.test.ts \
  packages/framework/src/__tests__/per-node-minting.test.ts \
  packages/framework/src/__tests__/executor.test.ts \
  packages/framework/src/__tests__/conditional-edges-routing.test.ts \
  packages/framework/src/__tests__/file-spend-store.test.ts
bun test packages/host/src/__tests__/middleware/error-handler.test.ts \
  packages/host/src/__tests__/runtime-capabilities.test.ts \
  packages/host/src/__tests__/spend-ledger.test.ts
bun run typecheck
bun run check:docs
git diff --check
bun run test
```
