# PR Remediation Plan — Round 8

**Date:** 2026-07-04
**Branch:** feat/deterministic-core-phase-b
**Findings:** 0 critical, 10 advisory (5-agent parallel review: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-tech-lead)

Zero criticals — the CLI/authoring surface is mature. Per the review-and-fix workflow's "only advisory" edge case, the user opted for the **targeted high-value set**: concrete, low-risk fixes only. Larger refactors (DescribedNode narrowing, parseDagRegistration guard, seam injection) were deferred.

## Advisory Fixes Applied

### Fix 1: runPromptsSync breaks the JSON-envelope contract on a corrupt registry
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/cli/prompts.ts:93 (throw origin :82; bin call fugue.ts:108)
- **Issue:** `runPromptsSync` called `readRegistry` unwrapped, so a malformed `registry.json` threw a raw stderr stack + exit 1 instead of the stdout-JSON `{ok:false,problems}` envelope that `runPromptsCheck` returns for the same input — a machine-consumer contract violation on exactly the input `check` handles gracefully.
- **Fix:** Wrapped the `readRegistry` call in the same try/catch shape as `runPromptsCheck`, returning `{ok:false, problems:[...]}`. Chose fail-with-envelope over silent-overwrite so a hand-edited registry (and its version history) isn't clobbered without the operator knowing.

### Fix 2: llmInputFields lacks an exhaustiveness backstop
- **Source:** type-design-analyzer, code-reviewer (Concern A)
- **File:** packages/framework/src/cli/authored-codegen.ts:540-563
- **Issue:** A raw `switch (s.shape)` with no `default`. `noImplicitReturns` is off (only `strict: true`), so adding a sixth `Shape` would make the function silently return `undefined`, crashing downstream on `.map`. Every sibling walker in the file uses ts-pattern `.exhaustive()`; this was the outlier.
- **Fix:** Added `default: return assertNever(s);` (imported from `./types.js`), making a new unhandled Shape a compile-time error, consistent with the rest of the module.

### Fix 3: number/boolean field types never exercised in codegen
- **Source:** pr-test-analyzer (rating 5/10)
- **File:** packages/framework/src/cli/authored-codegen.ts:85-99 (test: src/__tests__/cli/authored.test.ts)
- **Issue:** Every fixture used only `string`/`enum` fields, so the `z.number()`/`z.boolean()` zodExpr and `0`/`false` defaultExpr arms emitted into generated `dag.ts` untested and were never compiled by the gauntlet. `FieldTypeSchema` makes both authorable, so an LLM composing a DAG will emit them. Bun line coverage masked the miss.
- **Fix:** Added a `linear-scalar-fields` fixture with number + boolean output fields. The existing gauntlet acceptance loop automatically drives it through codegen → defineDag → lint → describe, compiling the scalar-type arms.

## Deferred (documented, not fixed)

- **bumpPatch** silently resets a non-semver registry version to "1.0.0" with no signal (silent-failure, prompts.ts:55) — low impact, registry is machine-managed
- **DescribedNode.kind/sideEffects** widened to bare `string` from closed unions; narrow to `NodeKind`/`SideEffectKind` for parity with `DescribedEdge` (type-design, build-described-dag.ts:29-30)
- **describe.ts validate-by-cast** (`registration.dag as DagDef`); introduce a shared `parseDagRegistration` guard (type-design, describe.ts:31-38; mirrors lint.ts:139)
- **NodePlan.inExpr** conflates "source has no input" with "not yet wired"; model as discriminated union (type-design, authored-codegen.ts:130-131)
- **runDescribe stderr leak** + **writeAuthoredScaffold not seamed** on the compose accept path (architecture, conf 75-78)
- Router-predicate nonexistent-field reject case (test gap, authored.ts:518-520)

## Validation Commands
```bash
bunx tsc --noEmit                                          # exit 0
cd packages/framework && bun test --path-ignore-patterns='dist/**'  # 1874 pass, 0 fail
```
