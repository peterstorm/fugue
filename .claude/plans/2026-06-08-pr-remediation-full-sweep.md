# PR Remediation Plan — Full Sweep

**Date:** 2026-06-08
**Branch:** docs/side-effects-witness-idempotency
**Findings:** 0 critical, 8 advisory (item 9 deferred)

Six review agents (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-agent) found **zero
critical** issues. The implementation was rated a model example of the project
standard. The advisories below are the agreed "boil the ocean" follow-ups.

## Advisory Fixes

### Fix 1: Brand `resource:` in doc code examples
- **Source:** comment-analyzer
- **File:** docs/observability/state-transitions.md:153,176,407,415,424,501,523
- **Issue:** `sideEffects.resource` is typed `ResourceName`, but code examples pass
  a raw string `resource: "postgres:orders"` next to a branded
  `resourceName(...)` sibling — internally inconsistent and would not type-check.
- **Fix:** Wrap every `resource:` literal in `sideEffects` TS examples with
  `resourceName(...)`. JSON event blocks and interface-reference shapes stay raw
  strings (serialized shapes).

### Fix 2: Mark superseded ADR Decision blocks
- **Source:** type-design-analyzer
- **File:** docs/adr/0025-freshness-witness-contract.md:24-32,43-47,81-87
- **Issue:** The ADR Decision body still shows pre-change signatures
  (`resource: string`, extractors returning `Witness`, old `findConflict`); only
  the bottom Amendment supersedes them, with no inline marker.
- **Fix:** Add inline "(superseded — see Amendment …)" markers to the stale blocks.

### Fix 3: Actionable `stampWitness` guard
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/types/freshness.ts:128
- **Issue:** If an extractor returns `undefined`/malformed, `stampWitness`
  dereferences it and throws a generic `TypeError`. Fail-closed is preserved, but
  the operator-facing message is unactionable.
- **Fix:** Guard `if (!wv) throw …` naming the authoring mistake before deref.

### Fix 4: Pin "stray resource overridden" contract
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/__tests__/freshness-extraction-types.test.ts
- **Issue:** No test pins that a hand-built `WitnessValue` carrying a stray
  runtime `resource` is overridden by the stamped resource.
- **Fix:** Add an assertion that `stampWitness` ignores a smuggled `resource`.

### Fix 5: Witness-extraction test for the non-HTTP node
- **Source:** pr-test-analyzer
- **File:** apps/customer-summary/src/__tests__/fetch-customer.test.ts (new)
- **Issue:** `fetch-customer.ts` has the same `witnessValue`/"not-found" logic as
  the HTTP node but no extraction test.
- **Fix:** Mirror the two HTTP witness-extraction assertions for the source node.

### Fix 6: Strengthen features.md stamp comment
- **Source:** comment-analyzer
- **File:** docs/features.md:417-421
- **Issue:** Comment frames the guarantee as a runtime stamp, omitting the
  stronger compile-time-unrepresentable framing the type/JSDoc make.
- **Fix:** Mirror the "compile error, not runtime overwrite" framing.

### Fix 7: Property coverage of resource-free → stamp path
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/__tests__/freshness-check-property.test.ts
- **Issue:** Properties build full `Witness` events directly; the new
  `stampWitness` path is never property-exercised.
- **Fix:** Add a property: for any `(ResourceName, WitnessValue)`, `stampWitness`
  yields a `Witness` whose resource is the stamped one and whose `(kind, value)`
  equal the input.

### Fix 8: Promote standalone `resource` fields to `ResourceName`
- **Source:** type-design-analyzer, architecture-agent
- **File:** packages/framework/src/types/freshness.ts:159 (FreshnessConflict),
  packages/framework/src/types/events.ts:170 (FreshnessViolationEvent)
- **Issue:** These two `resource` fields remain raw `string` while the rest of the
  authoring surface is branded `ResourceName`, allowing a denormalized copy to
  drift from the witness it describes.
- **Fix:** Tighten both to `ResourceName`. Construction sites already supply a
  `ResourceName` (`conditionedOn.resource`), so no widening is needed.

## Deferred

### Item 9 — `extractConditionedOn` free-variable validation + writes "both-or-neither" union
- **Reason:** `extractConditionedOn`'s resource is an inherent free variable that
  fails open if mis-named; encoding "both extractors or neither" requires a
  broader `SideEffectProfile` union redesign. Both are larger design changes
  beyond this remediation's scope and already caught at runtime/validate-dag.
- **Recommendation:** Track as a follow-up ADR amendment.

## Validation Commands
```bash
bun run -F @fuguejs/framework typecheck
bun run -F @fuguejs/customer-summary typecheck
bun test
```
