# PR Remediation Plan

**Date:** 2026-06-08
**Branch:** docs/side-effects-witness-idempotency
**Findings:** 1 critical (deduplicated), 6 advisory to fix; rest deferred (pre-existing / out of scope)

The branch refactors the freshness witness contract (ADR-0025): self-referential
extractors (`extractWitness`, `extractNewWitness`) now return a resource-free
`WitnessValue`; the framework stamps the node's `resource` via `stampWitness()`
at emission. Goal: make a resource mismatch between the profile and its witness
*unrepresentable*.

## Critical Fixes

### Fix 1: Emission-level test proving the framework stamps the profile resource
- **Source:** pr-test-analyzer (CRITICAL ×2), architecture-agent, type-design-analyzer
- **File:** packages/framework/src/__tests__/freshness-emission.test.ts
- **Issue:** No test asserts the load-bearing claim of this PR — that the emitted
  `witness-captured`/`write-attempted` event carries the *profile's* resource
  regardless of what the extractor returns. Every existing test supplies an
  extractor whose resource already equals `se.resource`, so `stampWitness` could
  be a no-op and all tests would still pass.
- **Fix:** Add tests where the extractor returns a resource-free `witnessValue(...)`
  and assert the emitted witness carries `se.resource`. Cover the reads path
  (`extractWitness`) and the writes path (`extractNewWitness` stamped to
  `se.resource` while `extractConditionedOn` keeps its own *different* upstream
  resource verbatim).

## Advisory Fixes

### Fix 2: Make the "unrepresentable" guarantee type-level (`resource?: never`)
- **Source:** type-design-analyzer (D), comment-analyzer, pr-test-analyzer
- **File:** packages/framework/src/types/freshness.ts
- **Issue:** `WitnessValue = {kind, value}` is structurally a subset of `Witness`,
  so a full `Witness` (with a wrong resource) is assignable to a
  `WitnessValue`-typed extractor slot and still compiles; `stampWitness` silently
  drops the smuggled resource. The "unrepresentable" comment is runtime-only.
- **Fix:** Add `resource?: never` to `WitnessValue` so returning a full `Witness`
  from a self-referential extractor is a *type error*. Makes the comment literally
  true. (Compiler then surfaces every test still returning a full witness → Fix 4.)

### Fix 3: `witnessValue()` empty-value guard test
- **Source:** type-design-analyzer (B), pr-test-analyzer
- **File:** packages/framework/src/__tests__/freshness-extraction-types.test.ts
- **Issue:** The `witnessValue("x", "")` throw (freshness.ts:82-84) is untested.
- **Fix:** Add `expect(() => witnessValue("version", "")).toThrow()`.

### Fix 4: Migrate untouched test files to resource-free `witnessValue(...)`
- **Source:** comment-analyzer (C), pr-test-analyzer
- **File:** freshness-emission.test.ts, freshness-full-pipeline.test.ts,
  freshness-witness-conflict-detected.test.ts, freshness-witness-no-conflict.test.ts,
  human-intervention-event.test.ts, persisted-context-no-closures.test.ts (as the
  compiler flags them under Fix 2)
- **Issue:** These still pass full `witness(...)` into resource-free extractor
  slots, compiling only via structural subtyping and reproducing exactly the
  redundant pattern this branch removes.
- **Fix:** Replace `witness(kind, resource, value)` with `witnessValue(kind, value)`
  in `extractWitness`/`extractNewWitness` slots. `extractConditionedOn` keeps full
  `witness(...)`.

### Fix 5: Document the brand-asymmetry rationale
- **Source:** type-design-analyzer (E)
- **File:** packages/framework/src/types/freshness.ts
- **Fix:** One-line note near `WitnessValue` explaining no swap hazard +
  re-validation at the stamp chokepoint, so it isn't needlessly branded later.

### Fix 6: Correct ADR-0025 `stampWitness` signature + public/internal contradiction
- **Source:** comment-analyzer (A), architecture-agent
- **File:** docs/adr/0025-freshness-witness-contract.md
- **Issue:** Documents `stampWitness(resource, value)` (real signature takes a
  `WitnessValue` object) and calls it "internal" while it is publicly exported.
- **Fix:** Correct the signature to `stampWitness(resource, witnessValue)` and
  describe it as public.

### Fix 7: Remove dead imports
- **Source:** code-reviewer, silent-failure-hunter, architecture-agent
- **File:** fetch-customer.ts (`err`, `CrmRecord`), fetch-customer-http.ts (`err`),
  freshness-extraction-types.test.ts (`mkWitness`)
- **Fix:** Drop the unused import bindings.

## Deferred (pre-existing / out of scope — not introduced by this branch)

- Broad `catch (e)` attributing framework-invariant throws to the user-extractor
  message (cosmetic; behavior is correct, fail-closed).
- `write-attempted` emitted before `recordWrite` confirmation (at-least-once,
  pre-existing on main, observable not silent).
- `docs/observability/state-transitions.md` illustrative examples using bare-string
  `resource:` without `resourceName()` (pre-existing illustrative style).

## Validation Commands
```bash
bun run typecheck
bun test
```
