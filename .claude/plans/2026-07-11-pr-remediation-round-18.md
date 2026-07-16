# PR Remediation Plan — Round 18

**Date:** 2026-07-11
**Branch:** feat/deterministic-core-phase-b
**Findings:** 1 critical (cross-repo, design), 7 advisory (deduped against rounds 15–17)
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead

## Critical Fix

### Fix 1 (design): @fugue-integrity stamp contradicts "implement the placeholders" (VERIFIED by two agents)
- **Source:** code-reviewer + silent-failure-hunter (both verified by execution)
- **Files:** packages/framework/src/cli/authored-codegen.ts, src/cli/new.ts (+ loom's fugue-generated-integrity rule)
- **Issue:** `stampGenerated` hashed the WHOLE body and stamped "DO NOT EDIT", but the same scaffold's `nextSteps`/README instruct implementing the `Placeholder` fetch/transform/source bodies. Under loom orchestration every implementation wave tripped loom's wave-gate; the "regenerate from AuthoredDag" remedy cannot express bodies and destroys the work.
- **Fix:** **Structural-region hashing.** authored-codegen emits `// @fugue-body-start`/`// @fugue-body-end` around the three placeholder-body emitters and exports `structuralProjection` (collapses each region to one marker). `stampGenerated` now hashes `structuralProjection(body)` with a corrected 3-line banner (regenerate structure / implement @fugue-body regions). The machine-owned structure is hashed; placeholder bodies are excluded. loom's rule applies the identical projection. Verified end-to-end: fresh scaffold + body-implemented both pass; structural rewire is flagged. `authored.test.ts` updated to project + assert the body-edit-preserves-hash / structure-edit-breaks-hash contract.

## Advisory Fixes (all applied)

1. lint-checks.ts:64: literal 0x00 NUL byte in `edgeKey` → `\0` escape (restores text-diffable git; runtime-identical).
2. anthropic-client.ts sendStructured no-tool_use arm: append `truncateErrorBody(JSON.stringify(response.content))` body snapshot (parity with OpenAI + the sendWithTools residual arm).
3. llm-errors.ts: deleted the redundant `isRateLimit` arm in `classifyLlmError` (fully subsumed by the `TRANSIENT_HTTP_STATUSES` duck-typed arm); removed the hardcoded 429; 429 classification unchanged.
4. types/errors.ts: added `httpStatus?: number` to the `node-crash` variant; populated at both HTTP-origin non-retriable sites (httpFailureToError, classifyLlmError); non-HTTP node-crash omits it (pinned).
5. Comment accuracy: new.ts module header now names `--from` artifacts (sidecar + integrity banner); openai-client incomplete "TRUNCATED" comments → "TRUNCATED or filtered (see incomplete_details.reason)"; PartialTokenUsage docblock broadened to the clients' terminal-status short-circuits.
6. Test pins (all mutation-verified): sendWithTools failed no-usage row (error.usage undefined); residual-status no-usage row; sendStructured incomplete+reason row.
7. identifiers.ts: `pascalCase` unexported; `camelCase` kept (real caller) but both narrowed from bare `string` to branded `KebabIdent`.

## Deferred (unchanged standing items)
- Truncation-policy extraction into llm-errors.ts (re-assessed round 17 as pre-Phase-C; scope grown by 2 residual arms); turn() retriability flattening; runCompose state-machine reification; io.ask/io.say rethrow boundary; Temperature branding; gauntlet advisories; TEMPLATE_OPEN coupling property.
- Note: fugue deliberately does NOT verify its own stamp — detection lives solely in loom's `fugue-generated-integrity` rule (docs corrected loom-side).

## Validation
```bash
cd packages/framework && bunx tsc --noEmit && bunx tsc --noEmit -p tsconfig.bin.json && bun test
# 1972 pass / 0 fail, both tsc configs clean
```
