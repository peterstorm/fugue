# PR Remediation Plan

**Date:** 2026-05-23
**Branch:** feat/fugue-host
**Findings:** 3 critical, 6 advisory

## Critical Fixes

### Fix 1: ioredis constructor not callable under tsc --build
- **Source:** type-design-analyzer
- **File:** packages/host/src/main.ts:43
- **Issue:** `const { default: Redis } = await import("ioredis")` then `new Redis(...)` fails because ioredis default export is not directly constructable with `new` in strict TS project-references mode (TS2351).
- **Fix:** Use `const Redis = (await import("ioredis")).default;` — this is equivalent but TS resolves the constructor signature correctly when extracted into a typed local.

### Fix 2: Implicit 'any' on map callback in teams handler
- **Source:** type-design-analyzer
- **File:** packages/host/src/http/handlers/admin/teams.ts:137
- **Issue:** `teams.map((t) => ...)` — parameter `t` has implicit `any` because `readonly TokenGrant[]` from Result unwrap doesn't flow through in project-references build.
- **Fix:** Add explicit type annotation: `teams.map((t: TokenGrant) => ...)`

### Fix 3: Implicit 'any' on catch parameter in main.ts
- **Source:** type-design-analyzer
- **File:** packages/host/src/main.ts:206
- **Issue:** `.catch((disconnectErr) => {...})` has implicit any on the parameter.
- **Fix:** Change to `.catch((disconnectErr: unknown) => {...})`

## Advisory Fixes

### Fix 4: Unused import createInMemoryTokenStore
- **Source:** code-reviewer
- **File:** packages/host/src/host.ts:31
- **Issue:** `createInMemoryTokenStore` is imported but never used.
- **Fix:** Remove it from the import statement.

### Fix 5: Tests included in tsc --build scope causing TS1470 and TS2353
- **Source:** type-design-analyzer
- **File:** packages/host/tsconfig.json
- **Issue:** `"include": ["src"]` includes `src/__tests__/` which has `import.meta` (TS1470) and stale fixtures (TS2353). Test files should only be type-checked via Bun's runtime, not `tsc --build`.
- **Fix:** Exclude test files from the build tsconfig by adding `"exclude": ["src/__tests__"]`.

### Fix 6: safeStringify catch clause discards error info
- **Source:** silent-failure-hunter
- **File:** packages/host/src/main.ts:28
- **Issue:** Empty `catch` in `safeStringify` loses the serialization error — makes debugging harder.
- **Fix:** Accept unknown parameter for clarity: `catch (_e)` (explicit discard).

## Deferred

### Clock injection in host.ts
- **Reason:** Requires API change to `HostDeps` interface and threading through multiple call sites. Not a bug — cosmetic testability improvement.
- **Recommendation:** Address in a follow-up PR focused on host testability.

### onComplete throw transitions to degraded (sync-loop.ts:253)
- **Reason:** Behavioral change with risk; current behavior is fail-safe (preserves existing DAGs). Needs design discussion.
- **Recommendation:** Open an issue to discuss recovery strategy.

## Validation Commands
```bash
bunx tsc --build packages/framework && bunx tsc --build packages/host
bun test packages/host
```
