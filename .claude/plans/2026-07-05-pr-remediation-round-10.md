# PR Remediation Plan — Round 10

**Date:** 2026-07-05
**Branch:** feat/deterministic-core-phase-b
**Findings:** 0 critical, 8 advisory (deduped from 6-agent review)

## Advisory Fixes

### Fix 1: stale dag.authored.json survives shape-mode --force regeneration
- **Source:** code-reviewer
- **File:** packages/framework/src/cli/new.ts (~line 236, runNew --force branch)
- **Issue:** Shape-mode `runNew --force` over a prior --from/compose scaffold neither
  overwrites nor removes the tool-written `dag.authored.json` sidecar; a later
  `fugue new --from dag.authored.json --force` silently resurrects the old DAG.
  Breaks the documented regen fixed point.
- **Fix:** In runNew's --force branch, remove a leftover dag.authored.json the same way
  stale prompts are reconciled. Add test.

### Fix 2: OpenAI client forwards temperature alongside reasoning
- **Source:** silent-failure-hunter + type-design + pr-test-analyzer
- **File:** packages/framework/src/llm/openai-client.ts:205-211
- **Issue:** `thinking: enabled` sets `body.reasoning` and temperature is still
  forwarded; reasoning models reject the combo with an opaque HTTP 400 node-crash.
- **Fix:** At request-build time, when both thinking enabled and temperature defined,
  return/throw a typed validation FrameworkError (illegal state caught at the seam) —
  do NOT silently drop. Add tests: (a) temperature threading presence at 0 / absence
  when unset (mirror anthropic-client.test.ts:123), (b) thinking+temperature →
  validation error.

### Fix 3: process-level SIGINT handler leaks past compose completion
- **Source:** silent-failure-hunter
- **File:** packages/framework/bin/fugue.ts:179-194
- **Issue:** `process.on("SIGINT", interrupt)` never deregistered; Ctrl-C during
  post-completion stdout drain prints misleading message and second press
  exit(130)-truncates the final JSON payload.
- **Fix:** `process.removeListener("SIGINT", interrupt)` in the existing finally.

### Fix 4: structureOrder hand-duplicates structureRefs walk
- **Source:** type-design + architecture-tech-lead
- **Files:** packages/framework/src/cli/authored.ts:357, authored-codegen.ts:504
- **Fix:** Export structureRefs from authored.ts; define
  `structureOrder = (dag) => structureRefs(dag.structure).map(([id]) => id)`.

### Fix 5: gauntlet.ts lifecycle comment claims wrong bound
- **File:** packages/framework/src/cli/gauntlet.ts:25
- **Fix:** "bounded per draft by maxRepairs (each refinement starts a fresh budget),
  acceptable for an interactive session".

### Fix 6: DescribeResult failure-arm rationale false for describe-failed path
- **File:** packages/framework/src/cli/types.ts:274
- **Fix:** Correct the comment: on describe-failed, accumulated schema warnings are
  deliberately dropped (import-failed genuinely has none).

### Fix 7: parseRegistrationMeta degrade contract untested
- **File:** packages/framework/src/cli/describe.ts:16-27
- **Fix:** Add test: missing/mis-typed meta.description/version → ""/"0.0.0", no throw.

### Fix 8: (covered by Fix 2 tests) openai temperature threading untested

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit && bun test
```
