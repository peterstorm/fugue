# PR Remediation Plan

**Date:** 2026-06-13
**Branch:** feat/llm-authoring-improvements
**Findings:** 3 critical, ~16 advisory (across 6 review agents)

## Critical Fixes

### Fix 1: `runLint` silently swallows analyzer failures
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/cli/lint.ts:136-142
- **Issue:** `catch {}` resets analyzer errors and returns `ok: true`. A throw in
  `analyzeDag` (schema introspection, future assertion) makes a DAG with a real
  `fan-in-key-mismatch` silently pass lint, with no diagnostic.
- **Fix:** Surface the analyzer throw as a new `analyzer-failed` `LintError`
  (`ok: false`) instead of swallowing. CLI is pure (no logging) so the error
  rides the structured Result channel.

### Fix 2: `createFetchNode` doc/error rot — source nodes come from `createSourceNode`
- **Source:** comment-analyzer
- **Files:** node.ts:393-395, validate-dag.ts:225+247, define-sources.ts:9,32,107
- **Issue:** Comments AND author-facing error messages say to build source nodes
  "with `createFetchNode` without an `inputSchema`". False — `createFetchNode`'s
  `inputSchema` is required and it never sets `isSource`. Source nodes come from
  `createSourceNode`.
- **Fix:** Replace all references with `createSourceNode`.

### Fix 3: Clock doc contradicts golden example 09
- **Source:** comment-analyzer
- **Files:** docs/llm-dag-authoring.md:813, docs/examples/09 + examples/dags/09 + test
- **Issue:** Guide says "the clock is no longer a factory seam" (use
  `requires: ["clock"]` / `ctx.clock.now()` / `fixedClock`), but the canonical
  factory-seams example 09 demonstrates the clock AS a `now: () => Date` seam.
- **Fix:** Migrate example 09's clock to the capability; keep `model` as the
  factory seam. Update both shipped copies + the test (wire `fixedClock`).

## Advisory Fixes

### Fix 4: `lint-checks.ts` header omits B2 (redundant-passthrough)
- packages/framework/src/cli/lint-checks.ts:1-11 — header documents B1+B3, but
  B2 `redundant-passthrough` is implemented (lines 200-239). Add it.

### Fix 5: Authoring guide stale advisory kinds
- docs/llm-dag-authoring.md:1106-1109 — "the only kind is `shape-helper-hint`" is
  stale; `redundant-passthrough` also exists. Update.

### Fix 6: `check-doc-links.ts` dead `void statSync`
- scripts/check-doc-links.ts:97 — discarded I/O that can only throw outside the
  structured `problems` collection. Remove.

### Fix 7: `DAG_INPUT` cast lacks static assertion
- packages/framework/src/types/ids.ts:46 — add a compile/load-time assertion that
  `!ID_REGEX.test("$input")`, so the load-bearing invariant is enforced, not just
  commented.

### Fix 8: `fugue new` records registry.json before sync success check
- packages/framework/src/cli/new.ts:198-202 — `written.push(registry.json)` runs
  before the `sync.ok` check, so a failed prompts-sync reports a file that didn't
  sync. Move the push after the check.

### Fix 9: `defineSources` header names external repo `fugue-dags`
- packages/framework/src/executor/define-sources.ts:1-2 — unverifiable cross-repo
  claim prone to rot. Describe the shape without naming the external repo.

## Deferred (larger design changes — out of scope for minimal remediation)

- `isSource?: boolean` → discriminated node variant (type-design). Backstopped by
  runtime `validateDagShape`; requires NodeDef redesign + broad test impact.
- `NodeDef<any,any,any>` variance leak on join/assemble → generic over source-id
  map (type-design + architecture). Needs type-level design work.
- Extract shared `objectSchemaKeys` helper + definition-time fan-in validation in
  `defineSources` (architecture issue 1+2). Enhancement, not a bug; deferred to
  keep this commit focused on correctness/doc fixes.
- `provenance` unvalidated public field; `*Unchecked` brand fence. Justified by
  docs; low impact.
- Test-coverage gaps (runLint integration, defineFanOut B3 hint, declaresInputKey
  guards, topoSort unknown-target). Additive; follow-up.

## Validation Commands
```bash
bun run --filter @fuguejs/framework typecheck
bun run --filter @fuguejs/host typecheck
bun test --cwd packages/framework
bun test --cwd packages/examples
bun scripts/check-doc-links.ts
```
