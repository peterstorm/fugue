# PR Remediation Plan — Pass 6

**Date:** 2026-06-13
**Branch:** feat/llm-authoring-improvements
**Findings:** 0 critical, 13 advisory (6-agent review)
**Scope chosen:** "Everything actionable" — fix all in-scope advisories plus Y1 and the pre-existing doc-rot items C2/C3. No-action items (Y4, Y5) left as documented design notes.

## Advisory Fixes

### Y3: `LintResult.advisories` always-present array
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/cli/types.ts:28`, `packages/framework/src/cli/lint.ts`
- **Issue:** `advisories?` optional on both variants — `undefined` and `[]` both mean "none". Consumers branch on `?? []`.
- **Fix:** Make `advisories` a required `readonly LintAdvisory[]` on both variants; `runLint` always emits it (possibly empty). Consumers (`cli.test.ts`) keep working.

### Y2: Optional `$input` key has undefined semantics
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/llm/zod-schema.ts:50`, `packages/framework/src/executor/define-sources.ts:69`
- **Issue:** `objectSchemaKeys` returns optional props, so `declaresInputKey` wires a request edge for an *optional* `$input`, then `assertFanInKeys` treats it as required — undefined semantics.
- **Fix:** Add `objectSchemaRequiredKeys` (shared `renderObjectSchema` helper). In `defineSources`, reject a declared-but-optional `$input` key at definition time with a clear `DagDefinitionError` — the DAG request is always delivered, so `$input` must be required (parse-don't-validate).

### Y1: `isSource: true` permits a non-void `inputSchema`
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/types/node.ts:395`, enforced in `validate-dag.ts`
- **Issue:** The type permits `{ isSource: true, inputSchema: z.object(...) }`; the source/void correlation is enforced only by the `createSourceNode` constructor.
- **Decision:** A full discriminated-`NodeDef` refactor (the "make it unrepresentable at the type level" fix) ripples across the entire `NodeDef` surface and 100+ tests, and the variance-leak `NodeDef<any,any,any>` casts erase the discriminant at most boundaries anyway — disproportionate and high-risk for a remediation pass. Instead enforce the invariant at **definition time**: `validateDagShape` rejects a source node whose `inputSchema` rejects `undefined` (i.e. isn't the unit schema). This makes the illegal state throw at module load — the actual risk (hand-built / dynamically-built source nodes) — without destabilizing the type surface.

### C1: lint `errors[].kind` table omits `analyzer-failed`
- **Source:** comment-analyzer
- **File:** `packages/framework/docs/llm-dag-authoring.md:1094`
- **Fix:** Add the `analyzer-failed` row (it is a real `runLint` error kind).

### C2: `createLlmNode` non-existent `deps:` field
- **Source:** comment-analyzer (pre-existing on main)
- **File:** `docs/library-ux.md:1243`
- **Fix:** Remove the `deps: [...]` line — dependencies come from edges, not a node field.

### C3: dated model ids in host README
- **Source:** comment-analyzer (pre-existing on main)
- **File:** `packages/host/README.md:254`
- **Fix:** Replace dated `claude-…-YYYYMMDD` ids with current aliases, matching the framework's own "use current ids" guidance.

### T1–T5: residual test gaps (pr-test-analyzer)
- **T1** `new.test.ts` — assert generated content guarantees: every `--llm` scaffold pins a current (non-dated) model id; the linear scaffold routes errors through `frameworkError.*` (no raw `err({ kind })`).
- **T2** `scripts/check-doc-links.ts` — extract the pure checker, add a fixture test for the "escapes packages/" branch, wire it into the CI docs job so it actually runs.
- **T3** `cli.test.ts` — new fixture + test: a B2 redundant-passthrough advisory propagates through `runLint` on the `ok: true` path; assert advisories ride alongside.
- **T4** `fan-in-keys.test.ts` — direct tests for `describeFanInKeyMismatch` only-missing and only-extra branches.
- **T5** source-node test — assert `createSourceNode` honours a custom `sideEffects` override (and defaults otherwise).

## No-action (documented design notes)
- **Y4** `DAG_INPUT` brand re-widening — cosmetic; brand earns its keep at `EdgeDefInput.from`.
- **Y5** `fanInKeyCheck` Set dedup of duplicate ids — defense-in-depth; real check is `duplicate-edge` in validate-dag.

## Validation Commands
```bash
(cd packages/framework && bunx tsc --noEmit && bun run test)
(cd packages/host && bunx tsc --noEmit && bun run test)
bun run check:docs
bun test scripts/
```
