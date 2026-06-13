# PR Remediation Plan — Pass 5

**Date:** 2026-06-13
**Branch:** feat/llm-authoring-improvements
**Findings:** 0 critical, 14 advisory (scope: fix 13 — all worthwhile, skip TD2)

Six-agent review (code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead). Zero critical.
code-reviewer + architecture found nothing. Remaining advisories below.

## Critical Fixes

None.

## Advisory Fixes

### D1: built-in capability comment omits `clock`
- **Source:** comment-analyzer · **File:** `packages/framework/src/types/node.ts:471`
- **Fix:** Add `clock` to the enumerated built-ins list (branch added it as a built-in).

### D2: `fugue capabilities` sample JSON missing `clock`
- **Source:** comment-analyzer · **File:** `packages/framework/docs/llm-dag-authoring.md:1167`
- **Fix:** Append a `clock` entry to the `builtin[]` array in the sample output.

### D3: cross-doc ref wrong for installed package
- **Source:** comment-analyzer · **File:** `packages/document-source/docs/llm-document-source.md:7`
- **Fix:** Point to `@fuguejs/framework/docs/llm-dag-authoring.md`.

### D4: mixed-language placeholder names in JSDoc
- **Source:** comment-analyzer · **File:** `packages/framework/src/executor/define-sources.ts:88`
- **Fix:** Use English names matching the authoring guide (`fetchBranches`, `fetchPastCustomers`).

### D5: stale `claude-sonnet-4-5` ids
- **Source:** comment-analyzer · **File:** `docs/library-ux.md:1245,1254,1280,1288`
- **Fix:** Bump to `claude-sonnet-4-6` for consistency with `features.md`.

### A1: total swallow of zod introspection throw
- **Source:** silent-failure-hunter · **File:** `packages/framework/src/llm/zod-schema.ts:39`
- **Fix:** Add `fwLogger().debug` on the catch so a future render regression is diagnosable (keeps no-false-positive behaviour).

### TD1: magic `"__dag__"` id smuggled into a `NodeId` field
- **Source:** type-design-analyzer · **File:** `packages/framework/src/executor/validate-dag.ts:119`
- **Fix:** Change `invalid-dag-input-edge` to carry the raw edge endpoints `{ from, to }` as strings instead of branding a fabricated `NodeId`. Touches `errors.ts`, `error-factories.ts`, formatter, both call sites.

### T1–T6: missing test coverage
- **Source:** pr-test-analyzer
- T1 `define-sources.ts` join-declares-`$input` request edge
- T2 `cli/new.ts` `takeValue` flag-as-value branch
- T3 `cli/new.ts` `runPromptsSync` failure path in `runNew`
- T4 `cli/lint.ts` `analyzer-failed` branch
- T5 `types/clock.ts` `fixedClock` fresh-`Date`-per-call invariant
- T6 `cli/new.ts` `isDirNonEmpty` non-ENOENT rethrow

## Deferred

### T3: `runPromptsSync` failure path in `runNew`
- **Reason:** Unreachable without mocking. `runPromptsSync`'s contract is "return `ok: true` or throw" — it never yields `ok: false`. So the `if (!sync.ok)` guard in `runNew` is defensive against a contract that cannot currently be violated; exercising it would require `mock.module`, which this codebase avoids.
- **Recommendation:** Leave the defensive guard; revisit only if `runPromptsSync` ever gains a genuine `ok: false` return.

### TD2: `isDagInput(id: string)` branding backdoor
- **Reason:** Sound today — the guard only succeeds for the exact `"$input"` constant. Changing the signature to `NodeId` ripples through callers (`validate-dag.ts` calls it on raw strings) for no behavioural gain.
- **Recommendation:** Leave as-is; documented.

## Validation Commands
```bash
bun run typecheck
bun test
bun scripts/check-doc-links.ts
```
