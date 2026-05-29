# PR Remediation Plan

**Date:** 2026-05-29
**Branch:** feat/fugue-host
**Findings:** 2 critical, 0 advisory

---

## Critical Fixes

### Fix 1: Export `LlmNodeDef` / `LlmWithToolsNodeDef` from framework public API + add explicit return type
- **Source:** code-reviewer (TS2883 typecheck failure)
- **File:** `apps/customer-summary/src/dag/nodes/synthesize.ts:17`
- **Issue:** `createSynthesizeNode` is exported but its inferred return type (`LlmNodeDef<ExtractionResult, ...>`) references a type (`LlmNodeDef`) that isn't in the public API of `@fugue/framework`. TypeScript TS2883: "The inferred type of 'createSynthesizeNode' cannot be named without a reference to 'LlmNodeDef' from '../../../node_modules/@fugue/framework/src/nodes/llm.js'. This is likely not portable. A type annotation is necessary."
- **Fix (two-part):**
  1. Add `LlmNodeDef` and `LlmWithToolsNodeDef` to `packages/framework/src/nodes/index.ts` exports — they're already public types, just missing from the barrel.
  2. Add explicit return type annotation to `createSynthesizeNode` using the now-public `LlmNodeDef` import.
- **Validation:** `bun run typecheck` exits 0 across all packages.

### Fix 2: Exclude `dist/` from `bun test` in `@fugue/framework`
- **Source:** pr-test-analyzer (11 test failures on full suite)
- **File:** `packages/framework/package.json` (test script)
- **Issue:** `tsc` output in `packages/framework/dist/` includes compiled copies of all test files. `bun test` picks up both `src/__tests__/**/*.test.ts` and `dist/__tests__/**/*.test.js`. The dist copies fail (path resolution differs) causing 11 spurious failures. When isolated (`bun test src/`), all tests pass.
- **Fix:** Update test script to `bun test --path-ignore-patterns='dist/**'` to exclude the compiled output directory.
- **Validation:** `bun run test` exits 0 with 0 failures (full monorepo).

---

## Advisory Fixes

None — codebase is clean. Previous rounds removed all advisory issues.

---

## Deferred

None.

---

## Validation Commands
```bash
bun run typecheck
bun run test
```
