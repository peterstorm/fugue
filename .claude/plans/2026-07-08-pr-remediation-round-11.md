# PR Remediation Plan — Round 11

**Date:** 2026-07-08
**Branch:** feat/deterministic-core-phase-b
**Findings:** 3 critical (1 code, 2 docs), 10 advisory

## Critical Fixes

### Fix 1: Prototype-key corruption in the prompt registry
- **Source:** type-design-analyzer (verified live)
- **File:** packages/framework/src/cli/prompts.ts:176-189, :250
- **Issue:** `runPromptsSync`/`runPromptsCheck` accumulate into plain `Record`s with
  filesystem-derived keys. A prompt file named `__proto__.txt` hits the prototype
  setter — sync reports ok:true while writing `{}`; `existing[name]` prototype-chain
  reads misclassify Object.prototype names (`constructor`, `toString`) as existing
  entries. Sync/check never converge.
- **Fix:** Accumulate in a `Map`, convert via `Object.fromEntries` at the serialization
  edge; guard registry reads with `Object.hasOwn`. Add tests for `__proto__.txt` and
  `constructor.txt`.

### Fix 2: lint.ts module header claims lint is import-only
- **Source:** comment-analyzer
- **File:** packages/framework/src/cli/lint.ts:5-9
- **Issue:** Header says "anything caught here is what defineDag already validated" —
  contradicted by the analyzeDag structural checks (fan-in-key errors, advisories)
  runLint performs.
- **Fix:** Rewrite header: import surfaces DagDefinitionError as JSON, then analyzeDag
  runs schema-aware checks defineDag cannot see.

### Fix 3: Generated README "Scaffolded by" line drops --review
- **Source:** comment-analyzer
- **File:** packages/framework/src/cli/new-templates.ts:885
- **Issue:** Provenance line omits `--review`; re-running the printed command with
  `--force` silently regenerates without the human-review gate.
- **Fix:** Append `${ctx.review ? " --review" : ""}`; reflect the gate in the Shape line.

## Advisory Fixes

### Fix 4: Reserve `opts` in RESERVED_IDENTIFIERS
- **File:** packages/framework/src/cli/identifiers.ts:248 (gate at authored.ts:402)
- **Issue:** llm dag-factory binds `opts` as a parameter; a node id `opts` passes
  parseAuthoredDag then shadows the module-level node const — broken module, opaque
  gauntlet error, burned repair rounds.
- **Fix:** Add "opts" with rationale comment; mention in compose SYSTEM_PROMPT avoid-list.
  Add test scaffolding a node id per claimed parameter binding.

### Fix 5: compose repair loop short-circuits environment-class errors
- **File:** packages/framework/src/cli/compose.ts:520-542
- **Issue:** `import-failed`/`analyzer-failed` LintErrors are unfixable by the LLM but
  are fed through up to 3 paid repair rounds, then misreported as "repair-exhausted".
- **Fix:** Classify verdict errors; short-circuit unrepairable kinds to the
  `gauntlet-failed` arm with the draft attached. Add test.

### Fix 6: openai-client 4xx retriability untested
- **File:** packages/framework/src/__tests__/openai-client.test.ts
- **Fix:** Add 400 → non-retriable node-crash tests (sendStructured + sendWithTools);
  assert retriability: "retriable" on the existing 500 test.

### Fix 7: new.ts header understates --force side effects
- **File:** packages/framework/src/cli/new.ts:7-8
- **Fix:** Mention --force reconciliation deletes tool-owned artifacts.

### Fix 8: authoredReadme omits prompts check for LLM dags
- **File:** packages/framework/src/cli/new.ts:445-453
- **Fix:** Thread hasLlm; conditionally include `fugue prompts check <dir>`, mirroring
  the template-mode readme.

### Fix 9: temperature JSDoc omits OpenAI thinking rejection
- **File:** packages/framework/src/types/llm.ts:45-50
- **Fix:** Add clause: cannot combine with thinking on OpenAI (pre-flight validation error).

### Fix 10: redundant-passthrough doc missing sole-source conjunct
- **File:** packages/framework/src/cli/types.ts:92-99
- **Fix:** Add "and whose sole incoming source is DAG_INPUT".

### Fix 11: TemplateCtx.team drops the Kebab brand
- **File:** packages/framework/src/cli/new-templates.ts:65 (raw YAML interpolation :877)
- **Fix:** Type `team: Kebab` so YAML safety is structural.

## Deferred

### PromptsResult ok:boolean → discriminated union (type advisory)
- **Reason:** `problems` is legitimately populated on both arms (warnings vs failures
  distinction needs design, not a mechanical split). Touches bin + tests.
- **Recommendation:** Fold into a dedicated CLI-result-shape pass.

### Unconstrained temperature primitive (type advisory)
- **Reason:** Branded Temperature or per-provider range pre-flight is an API design
  choice (Anthropic caps 1, OpenAI 2); JSDoc contract clarified in Fix 9.
- **Recommendation:** Decide brand vs seam pre-flight alongside the sampling union below.

### LlmRequest sampling discriminated union (architecture advisory)
- **Reason:** Port API change affecting both adapters and all callers; deletes the
  round-10 pre-flight. Not a point fix.
- **Recommendation:** Dedicated change: `sampling: {kind:"temperature"|"thinking"}`,
  Anthropic returns typed validation for un-honorable thinking.

### Scaffold writer consolidation (architecture advisory)
- **Reason:** runNew vs writeAuthoredScaffold unification is a structural refactor
  (pure plan + single writer) with test-suite consolidation; high churn.
- **Recommendation:** Standalone refactor PR.

### DescribedDag brand / fast-check permutation property / SIGINT drain test
- **Reason:** Low practical risk (single producer behind Result) / optional hardening /
  acknowledged inherently flaky.

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit && bun test
```
