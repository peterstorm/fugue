# PR Remediation Plan — side-effects witness idempotency

**Date:** 2026-06-08
**Branch:** docs/side-effects-witness-idempotency
**Findings:** 1 critical, 11 advisory (across 6 review agents)

Six review agents (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-agent) all independently
confirmed the core ADR-0025 resource-free witness design is sound, fully tested,
and type-checks. code-reviewer and architecture-agent found **zero** issues.

## Critical Fixes

### Fix 1: Stale `extractConditionedOn` JSDoc timing claim
- **Source:** comment-analyzer
- **File:** packages/framework/src/types/side-effects.ts:44-45
- **Issue:** JSDoc says "Called with the node's assembled input **before
  execution**" but the extractor is invoked post-wave (after the node completes,
  `freshness-emission.ts` operating on `newOutputs`). Directly contradicts
  `docs/observability/state-transitions.md:515` ("Called after the node
  completes"). This PR edited this exact block without fixing the stale clause.
- **Fix:** Reword to "Called after the node completes, with its assembled
  input" to match implementation and sibling doc.

## Advisory Fixes (applied)

### Fix 2: ADR-0025 amendment doesn't name the compile-time mechanism
- **Source:** comment-analyzer
- **File:** docs/adr/0025-freshness-witness-contract.md (amendment)
- **Fix:** Add a clause noting `WitnessValue.resource?: never` is what makes a
  full `Witness` unassignable to the extractor slot at compile time.

### Fix 3: Import-list sentence omits new public surface
- **Source:** comment-analyzer
- **File:** docs/llm-dag-authoring.md:304-306
- **Fix:** Add `WitnessValue` to the type list and `witnessValue` to the
  constructor list — the examples below call `witnessValue(...)`.

### Fix 4: `stampWitness` empty-value re-validation claim untested
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/__tests__/freshness-extraction-types.test.ts
- **Fix:** Add a test that `stampWitness` rejects a hand-built empty `value`
  (the load-bearing claim in the `WitnessValue` doc).

### Fix 5: `stampWitness` has no direct roundtrip unit test
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/__tests__/freshness-extraction-types.test.ts
- **Fix:** Assert `stampWitness(rn, witnessValue(k, v))` equals
  `witness(k, rn, v)` — pins argument order independent of emission wiring.

### Fix 6: Compile-time guarantee missing for the symmetric `extractNewWitness` slot
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/__tests__/freshness-extraction-types.test.ts
- **Fix:** Add a parallel `@ts-expect-error` case proving a full `Witness` is
  rejected from the `extractNewWitness` (writes) slot.

### Fix 7: Tautological `WitnessKind` coverage test
- **Source:** pr-test-analyzer (quality note)
- **File:** packages/framework/src/__tests__/freshness-extraction-types.test.ts:146
- **Fix:** Replace the hand-maintained `toHaveLength(6)` with a
  `satisfies Record<WitnessKind, ...>` exhaustiveness pattern that fails to
  compile if a variant is added/removed.

## Deferred (documented — pre-existing / non-blocking design questions)

All flagged by reviewers as "not introduced by this branch" or "none block the
branch":

- **`witness()` accepts raw `string` resource** (type-design): tightening to
  `ResourceName` is a breaking signature change to a public constructor and a
  separate API decision; the constructor already validates non-empty.
- **Writes partial-extractor state representable at type level** (type-design):
  caught at runtime + `validate-dag`; encoding `{both}|{neither}` is a
  pre-existing broader type change.
- **`extractConditionedOn` resource never cross-referenced upstream**
  (type-design): by design — the resource is a genuine free variable; a
  `validate-dag` advisory is the right non-breaking mitigation, separate scope.
- **Silent skip when a `reads` node omits `extractWitness`** (silent-failure):
  intentional opt-in, documented.
- **`witnessValue()` duplicates the non-empty check** (type-design): intentional
  per the documented unbranded rationale.
- **`stampWitness` reachable via deep file-path import** (architecture):
  acceptable pre-1.0 barrel-as-contract convention.

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit
cd apps/customer-summary && bunx tsc --noEmit
bun test packages/framework/src/__tests__/freshness-extraction-types.test.ts
bun test packages/framework/src/__tests__/
```
