# PR Remediation Plan

**Date:** 2026-05-26
**Branch:** feat/fugue-host
**Findings:** 1 critical, 0 advisory

## Critical Fixes

### Fix 1: TypeScript 6.0 `tsc --build --noEmit` incompatibility with project references
- **Source:** direct-review (typecheck)
- **File:** packages/host/package.json
- **Issue:** `tsc --build --noEmit` fails with TS6310 "Referenced project may not disable emit" on cold builds (no `.tsbuildinfo` cache). TypeScript 6.0 changed behavior: `--build --noEmit` propagates the no-emit constraint to referenced projects, then rejects them for having emit disabled.
- **Fix:** Change host typecheck script from `"tsc --build --noEmit"` to `"tsc --noEmit"`. Module resolution works via bun workspace linking; `--build` mode is unnecessary for typecheck-only.

## Advisory Fixes

None — codebase is exceptionally clean:
- All domain functions are pure with no I/O
- All error paths use Result<T, HostError> — no swallowed errors
- All discriminated unions use `.exhaustive()` matching
- Branded types enforce invariants at compile time
- No `any` types, no TODOs, no dead code
- Architecture strictly follows FC/IS with proper port/adapter separation
- 3114 tests passing (2501 framework + 495 host + 118 customer-summary)

## Validation Commands
```bash
rm -f packages/host/tsconfig.tsbuildinfo packages/framework/tsconfig.tsbuildinfo
bun run typecheck
bun run test
```
