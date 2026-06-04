# PR Remediation Plan — v7

**Date:** 2026-06-04
**Branch:** feat/extensible-capabilities
**Findings:** 0 critical, 5 advisory (6 agents). Net actionable: 4 fixes, 1 deferred.

9th review cycle (`main...HEAD`, 109 files / 8578 insertions). Five of six agents found
**zero** issues; code-reviewer, silent-failure-hunter, and architecture-tech-lead all
returned clean. The v6 fixes (Redis probe `status === "wait"` guard, `extractClients`
duplicate-name throw, non-empty `missing` tuple, `readonly T[]` workbook rows) are all
verified still in place. The branch is mature; remaining items are hygiene.

## Advisory Fixes

### Fix 1: `extractWitness` never directly asserted (silent witness regression)
- **Source:** pr-test-analyzer
- **File:** `apps/customer-summary/src/__tests__/fetch-customer-http.test.ts`
- **Issue:** Tests call `node.run` and assert outputs, but none asserts the freshness
  witness payload. A regression in the witness string (dropping `conversations.length`,
  or the `"not-found"` sentinel for a null customer) would pass silently. The witness is
  load-bearing for stale-read detection.
- **Fix:** Add a test invoking `node.sideEffects.extractWitness(...)` for both the
  present-customer and null-customer cases, asserting witness `kind`/`resource`/`value`.

### Fix 2: `Capability` admits reserved-name collisions that can never validate
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/types/node.ts:141`
- **Issue:** `Capability = keyof CapabilityRegistry & string`. A consumer who augments
  `CapabilityRegistry` with a reserved key (e.g. `logger: SomeCap`) can write
  `requires: ["logger"]` — it type-checks, `TypedNodeContext` types `ctx.logger` as the
  custom cap, yet `makeNodeContext`/`validateCapabilities` fail it closed at runtime. A
  representable illegal state, resolved only by a runtime guard.
- **Fix:** Define `Capability = Exclude<keyof CapabilityRegistry & string,
  ReservedNonCapabilityKey>`. Makes `requires: ["logger"]` a **compile error at the
  consumer's use site** (where the augmented registry is visible) instead of a guaranteed
  runtime failure. No-op for the framework's own built-ins (none collide), so
  `BUILTIN_CAPABILITY_KEYS satisfies` and `_BuiltinKeysComplete` are unaffected. Keep the
  runtime guard as defense-in-depth; update the comment block to note the compile-time
  half now covers consumer augmentation too.

### Fix 3 (doc): ADR-0052 stale "Today, with one adapter" parenthetical
- **Source:** comment-analyzer
- **File:** `docs/adr/0052-document-source-capability.md:119-121`
- **Issue:** Parenthetical describes a pre-extraction single-adapter state as the present,
  contradicting the same ADR's "second adapter (`@fugue/fs`) … runtime ref-guard is
  load-bearing rather than theoretical" (lines 134-138). `FileRef` already has four
  variants consumed by two adapters.
- **Fix:** Reword to past tense reflecting the delivered two-adapter reality.

### Fix 4 (doc): adapter-authoring.md §2 is dist-era; shipped packages are source-first
- **Source:** comment-analyzer (broadened — agent caught the `references` block; the whole
  §2 is the same drift)
- **File:** `docs/adapter-authoring.md:33,40-43,45-59`
- **Issue:** §2 prescribes `main`/`types` → `dist/`, a `references: [{ path:
  "../framework" }]` tsconfig block, and a `bunx tsc --build` step "so `dist/` exists".
  Every shipped package (`@fugue/pg`, `-fs`, `-ms-graph`, `document-source`, `xlsx`) is
  source-first: `main`/`exports` → `./src/index.ts`, no `references` block, no build step
  needed for cross-package imports.
- **Fix:** Rewrite §2 to match source-first reality — `main`/`exports` → `src/index.ts`,
  drop `references`, replace the "needs the dependency built" note with the source-first
  resolution model (Bun resolves the workspace package directly from `src/index.ts`).

## Deferred

### `FakePgRoute` doesn't encode which operation a route targets
- **Source:** type-design-analyzer
- **Reason:** The proposed discriminated union (`{ kind: "rows" } | { kind: "count" }`)
  does **not** solve the stated problem. The fake's routes are a `Record<string, …>` keyed
  by SQL string; the same fake exposes both `query` and `execute`, and the test author
  picks the method at call time independently of the route entry. There is no type-level
  link between a route and the method that reads it, so a discriminator on the route cannot
  prevent a `{ rowCount }`-route-read-by-`query` mismatch. The fix as suggested adds churn
  (every README example + test fixture grows a `kind` tag) without addressing the concern.
  Test-support only, negligible blast radius (a mismatch fails the test's own assertion).
- **Recommendation:** Revisit only if a future design ties route entries to an operation
  (e.g. separate `queryRoutes` / `execRoutes` maps), which *would* make the mismatch
  unrepresentable.

## Validation Commands
```bash
bun run typecheck
bun test
```
