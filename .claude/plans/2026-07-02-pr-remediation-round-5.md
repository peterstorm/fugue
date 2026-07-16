# PR Remediation Plan — Round 5

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-b
**Findings:** 1 critical, 25 advisory (deduplicated across 6 agents)

## Critical Fixes

### Fix 1: runDescribe docstring contradicts behavior
- **Source:** comment-analyzer
- **File:** packages/framework/src/cli/describe.ts:19-20
- **Issue:** Claims "On lint failure, returns the same errors[] runLint would have produced" — contradicts types.ts DescribeResult doc and behavior (analyzeDag checks not re-run; describe also emits describe-failed).
- **Fix:** Reword: "On import/definition failure, returns the same LintError shapes importDagFile produces; lint-only analyzer checks (e.g. fan-in-key-mismatch) are not re-run — see DescribeResult."

## Advisory Fixes

### Code
1. authored-codegen.ts:235 — `jsonShape` interpolates enum values as `"${v}"` unescaped; a schema-legal value with a double quote garbles the prompt shape hint. Use `JSON.stringify(v)`, matching zodExpr. (code-reviewer)
2. new.ts:244-275 — wrap runNew's mkdir + write batch in try/catch returning `{ ok: false, problems: ["write failed: <stack>"] }` like runNewFrom:397-404, preserving the stdout-JSON contract. (silent-failure-hunter)
3. describe.ts:72-76 — add always-present `warnings: readonly string[]` to DescribeResult's ok arm; populate from schemaWarnings (keep stderr echo). (silent-failure-hunter)
4. compose.ts:486-528 — empty trimmed accept-prompt answer: io.say a hint and re-ask instead of burning an LLM round on "Refinement request: " (pin with test). (silent-failure-hunter + pr-test-analyzer)
5. bin/fugue.ts:166-174 — second Ctrl-C during in-flight round is silently swallowed; on second interrupt() write "force-quitting" to stderr and process.exit(130). (silent-failure-hunter)

### Types
6. compose.ts:361-363 + 425-427 — narrow DraftAttempt/Proven failure `outcome` to `Extract<ComposeOutcome, { ok: false }>`. (type-design-analyzer)
7. compose.ts:65-83 — brand ComposeOptions.team (KebabIdent) and require non-empty intent at the boundary. (type-design-analyzer)
8. identifiers.ts:105-142 — define KebabIdent brand + parseKebabIdent in the import-free module; narrow name-constructor parameters. (type-design-analyzer)
9. types.ts:62 — add exact-key check so extra keys in SHAPE_HELPER_NAME fail compile (`type _NoExtraShapes = Exclude<keyof typeof SHAPE_HELPER_NAME, Shape> extends never ? true : never`). (type-design-analyzer)
10. types.ts:47/221/240 — non-empty tuple types for LintResult.errors / NewResult.problems / DescribeResult failure arm (attempt; defer if producers can't prove non-emptiness cleanly). (type-design-analyzer)
11. vocabulary.ts:34-49 — make FieldTypeSchema/FieldSpecSchema arrays `.readonly()` so inferred types are ReadonlyArray; drop the identity-typed freeze cast (attempt; defer if ripple too wide). (type-design-analyzer)
12. compose.ts:96-103 — split ComposeOutcome failure arm per reason so draft is required for write-/gauntlet-failed, absent for aborted (attempt; defer if consumers ripple too wide). (type-design-analyzer)

### Tests
13. Fixture: llm node as fan-out/diamond join (fan-in JSON.stringify wiring). (pr-test-analyzer)
14. Fixture: llm node as router case/default handler. (pr-test-analyzer)
15. Schema reject: `team: "Bad_Team"`. (pr-test-analyzer)
16. Closed stream mid multi-question round — aborted, no further LLM calls. (pr-test-analyzer)
17. gauntlet.ts:106 — add removeBase seam to GauntletDeps; test warn-not-throw on unexpected errno. (pr-test-analyzer)
18. visualize.ts:35 — unit assertion for `_x<hex>_` escape fallback. (pr-test-analyzer)
19. new.ts:428 — test pinning --force stale-file behavior. (pr-test-analyzer)

### Comments
20. bin/fugue.ts:241 — name both known rejection paths (readline failures propagated by compose-io; dynamic imports). (comment-analyzer)
21. types.ts:174 — "across all three CLI commands" → "across all CLI commands"; header "errors payload" → "errors/problems payload". (comment-analyzer)
22. new.ts:347 — gauntlet stages "codegen → defineDag import → lint → describe". (comment-analyzer)
23. compose.ts:99 — draft absent "on any abort (explicit 'abort' answer or closed input stream)". (comment-analyzer)

## Deferred (structural refactors, tracked for a dedicated pass)

- authored-codegen.ts wiringPlan consolidation (four parallel per-shape encodings → one derived map). (architecture)
- new.ts scaffold-write machinery dedup between runNew and writeAuthoredScaffold. (architecture)
- scanFlags shared flag-parsing kernel for parseNewArgs/parseComposeArgs. (architecture)
- **Types item 10** (non-empty tuples for LintResult.errors / NewResult.problems / DescribeResult failure arm): attempted 2026-07-02 and reverted — six producer sites cannot prove non-emptiness without `as` casts (lint.ts:127/157 pass through `imported.errors` / length-checked accumulated arrays TS can't narrow, describe.ts:27 passes through `imported.errors`, new.ts:384/405 build problems via `.map()` which always infers `T[]`). Making it honest requires tuple-typing `ImportedDagFile`/`analyzeDag`/`AuthoredParseResult` producers too — a dedicated pass, not a remediation edit.
- **Types item 8, partial**: `dagFactoryName`/`dagOptsInterfaceName` keep `string` parameters (documented in identifiers.ts) — they serve both the authored pipeline (KEBAB_IDENT names) and `new-templates.ts`'s golden scaffolds, whose names follow `fugue new`'s plain-KEBAB rule; narrowing them to `KebabIdent` would force `fugue new` to reject names it accepts today. All node-level constructors + `dagLevelIdentifiers` + `IdentifierSource` are narrowed to the new `KebabIdent` brand.
- **Types item 7, naming deviation**: `ComposeOptions.team` is branded `Kebab` (new brand, `parseKebab`), not `KebabIdent` — teams follow plain KEBAB everywhere (AuthoredDag schema, `fugue new` path parsing; authored.ts documents "team … never become[s] bare identifiers"), so a KEBAB_IDENT brand would have narrowed compose's accepted team vocabulary versus the rest of the CLI.

## Validation Commands
```bash
bunx tsc -p packages/framework --noEmit && bun test packages/framework
```
