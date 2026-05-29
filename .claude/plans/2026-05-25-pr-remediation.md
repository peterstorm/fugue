# PR Remediation Plan

**Date:** 2026-05-25
**Branch:** feat/fugue-host
**Findings:** 1 critical, 2 advisory

---

## Critical Fixes

### Fix 1: Host typecheck fails on fresh checkout — missing `--build` flag
- **Source:** code-reviewer / type-design-analyzer
- **File:** `packages/host/package.json`
- **Issue:** The `typecheck` script runs `tsc --noEmit` which fails with TS6305 errors on a fresh
  checkout because `packages/host/tsconfig.json` has `"references": [{"path": "../framework"}]`.
  TypeScript project references require the referenced package to have its `.d.ts` output files
  present. Since `packages/framework` uses `composite: true` and exports from `src/`, the framework
  must be compiled before host's typecheck can succeed.
  `bun run --filter '*' typecheck` runs all packages in parallel — framework's `tsc --noEmit` never
  emits `.d.ts`, so host's resolution always fails on a clean checkout.
- **Fix:** Change `"typecheck": "tsc --noEmit"` → `"typecheck": "tsc --build --noEmit"` in
  `packages/host/package.json`. With TypeScript 6 (≥5.3), `--build --noEmit` builds referenced
  projects (emitting their `.d.ts`) then typechecks the current project without emitting.

---

## Advisory Fixes

### Fix 2: `as any` cast in dead-code exhaustive branch
- **Source:** type-design-analyzer
- **File:** `apps/customer-summary/src/dag/nodes/assemble-response.ts:65`
- **Issue:** The `default:` branch of the switch is a `never` dead-code path (the `_exhaustive`
  binding on line 63 already marks it), but the message interpolation uses `(extraction as any).branch`
  which unnecessarily disables type checking. Even in unreachable code, `as any` is bad practice and
  could mask real type errors if the union is ever widened.
- **Fix:** Replace `(extraction as any).branch` with `(extraction as { branch: string }).branch` — a
  safe cast that preserves the property access without widening to `any`.

### Fix 3: `apps/customer-summary/tsconfig.json` missing project references
- **Source:** code-reviewer / architecture-agent
- **File:** `apps/customer-summary/tsconfig.json`
- **Issue:** Customer-summary imports from `@fugue/framework` and `@fugue/host` but its tsconfig has
  no `"references"` array. This means:
  1. `tsc --build` at the root won't guarantee framework and host are compiled before
     customer-summary in incremental builds.
  2. TypeScript language server won't automatically resolve types from source.
  Currently works because resolution falls back to workspace symlinks pointing to source files
  (`"main": "src/index.ts"`), but this is fragile — it depends on workspace linking and the
  framework not requiring a pre-built `.d.ts`.
- **Fix:** Add `"references": [{"path": "../../packages/framework"}, {"path": "../../packages/host"}]`
  to `apps/customer-summary/tsconfig.json`.

---

## Deferred

None.

---

## Validation

```bash
# After applying fixes — should all pass on a fresh state:
cd packages/host && bun run typecheck        # should pass (builds framework first)
cd apps/customer-summary && bun run typecheck  # should pass
bun run typecheck                             # root — all packages
bun test                                      # 2985+ tests
```
