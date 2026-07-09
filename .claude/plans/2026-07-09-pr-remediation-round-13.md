# PR Remediation Plan — Round 13

**Date:** 2026-07-09
**Branch:** feat/deterministic-core-phase-b (PR #33)
**Findings:** 1 critical, 6 advisory (after dedup across 6 agents)

## Critical Fixes

### Fix 1: Round-12 team/yamlScalar fix is unpinned
- **Source:** pr-test-analyzer (mutation-verified: reverting to raw `` `team: ${ctx.team}` `` passes all 320 CLI tests)
- **File:** packages/framework/src/cli/new-templates.ts:887-888 (test: src/__tests__/cli/new.test.ts)
- **Issue:** The round-12 CRITICAL fix routing `team` through `yamlScalar` has no regression test — the KEBAB-admits-YAML-coercibles bug class (`true`/`null`/`0`/`1e5`) silently reverts.
- **Fix:** Add a test next to the existing yamlScalar block: parse back `fugue.yaml` generated with team `true` (via mustTeam) and assert `typeof parsed.team === "string"`.

## Advisory Fixes

### Fix 2: REPAIRABLE_KINDS is Set<string>, rebuilt per iteration, and unpinned
- **Source:** type-design-analyzer + architecture-tech-lead + pr-test-analyzer (mutation-verified: reverting to round-11 denylist passes all 64 compose tests)
- **File:** packages/framework/src/cli/compose.ts:543
- **Fix:** Hoist to module scope as `const REPAIRABLE_KINDS: ReadonlySet<LintError["kind"]> = new Set([...])` restoring compile-time coupling to the union; add a compose test asserting a `describe-failed` verdict short-circuits to `gauntlet-failed` with zero repair turns paid.

### Fix 3: ReadlineLike doc invites a call that no longer typechecks
- **Source:** comment-analyzer
- **File:** packages/framework/src/cli/compose-io.ts:29
- **Fix:** Reword: the runtime Interface carries `output`, but @types/node does not declare it — callers adapt explicitly (see bin/fugue.ts).

### Fix 4: SYSTEM_PROMPT reserved-id list is an under-inclusive subset
- **Source:** comment-analyzer + architecture-tech-lead
- **File:** packages/framework/src/cli/compose.ts:350
- **Fix:** Add the missing kebab-reachable tokens (`registration`, `z`, `confidence`) and state the generative rule ("ids that camelCase to a framework import/const — e.g. create-*-node, define-*"). Full programmatic derivation deferred (below).

### Fix 5: SendWithToolsRequest.thinking doc factually wrong
- **Source:** comment-analyzer (pre-existing on main, one-line)
- **File:** packages/framework/src/types/llm.ts:139
- **Fix:** Replace "Anthropic-only … ignored by other providers" with the OpenAI reasoning.effort mapping, mirroring the correct sibling doc at llm.ts:41-43.

## Deferred

### compose turn() flattens typed retriability; one 429 kills the session (silent-failure-hunter)
- **Reason:** Requires a retry policy decision (bounded retry on transient vs. surfacing `retriable` on the llm-error arm) — behavior design, not a minimal edit. Recommend deciding before merge of a future phase.

### Unguarded io.ask/io.say throw discards lastProven (silent-failure-hunter)
- **Reason:** Needs an outcome-union decision for the rethrow path (readline EIO race is runtime-rare; rethrow-don't-fold is documented). Recommend a boundary catch emitting a failure outcome with `draft: lastProven`.

### Programmatic derivation of the reserved-id avoid-list (architecture-tech-lead)
- **Reason:** Fix 4 closes today's gap; deriving prose from RESERVED_IDENTIFIERS + coverage-test extension is a structural follow-up.

### Standing deferrals (rounds 10-12, unchanged): duplicated scaffold writers, 8x error formatting, sampling union, dead casts at new.ts:591/606.

## Validation Commands
```bash
bun run typecheck
bun test
```
