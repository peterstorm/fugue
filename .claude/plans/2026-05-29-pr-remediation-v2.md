# PR Remediation Plan

**Date:** 2026-05-29 (v2)
**Branch:** feat/fugue-host
**Findings:** 1 critical, 2 advisory

---

## Critical Fixes

### Fix 1: `defineLinearDag` must throw `DagDefinitionError` not plain `Error`
- **Source:** code-reviewer + cortex-memory gotcha
- **File:** `packages/framework/src/executor/define-linear-dag.ts:40`
- **Issue:** `throw new Error("[defineLinearDag] nodes array must not be empty")` is a plain
  `Error`. The CLI linter in `importDagFile` catches the module-evaluation throw and does
  `if (e instanceof DagDefinitionError)` — only that branch sets
  `kind: "dag-definition-error"` which AI tooling uses for structured error categorisation.
  A plain `Error` falls through to `kind: "import-failed"`, losing the structured detail.
  `defineRouter` and `defineDag` both use `DagDefinitionError`; `defineLinearDag` is the
  odd one out.
- **Fix:**
  1. Import `DagDefinitionError` and `nodeId` from `./define-dag.js`.
  2. Replace `throw new Error(...)` with `throw new DagDefinitionError(config.id, { kind: "validation", nodeId: nodeId(""), message: "defineLinearDag requires at least one node" })`.
- **Validation:** `bun run typecheck` exits 0; existing tests still pass;
  `defineLinearDag({id:"x", nodes:[]})` now throws a `DagDefinitionError`.

---

## Advisory Fixes

### Fix 2: `module-loader.ts` — use `onFileError` callback instead of `console.warn`
- **Source:** code-reviewer
- **File:** `packages/host/src/adapters/module-loader.ts:79`
- **Issue:** `console.warn(...)` bypasses the injected `LogPort` used everywhere else in
  the host. Prompt-file read errors will miss structured logging / observability.
- **Fix:** The `onFileError` callback is already wired; the `console.warn` call should
  delegate to `onFileError?.(filePath, e)` (which is already called just below for the
  same case in a slightly different flow). Consolidate — remove the bare `console.warn`
  and use the callback consistently.
- **Validation:** `bun run typecheck` exits 0.

### Fix 3: `run-dag.ts` — move `ctx` creation inside inner `try` to avoid timer leak
- **Source:** silent-failure-hunter
- **File:** `packages/host/src/http/handlers/run-dag.ts` (between `setTimeout` and inner try)
- **Issue:** `const ctx = deps.createContext(...)` sits between the `setTimeout` call and
  the inner `try/catch` that clears it. If `createContext` throws, `timeoutId` is never
  cleared. Harmless in practice (the abort fires into nothing) but a genuine resource leak
  pattern.
- **Fix:** Move `const ctx = deps.createContext(...)` and `const startTime = deps.clock()`
  to be the first statements inside the inner `try` block.
- **Validation:** `bun run typecheck` exits 0; existing run-dag handler tests pass.

---

## Deferred

None.

---

## Validation Commands
```bash
bun run typecheck
bun test
```
