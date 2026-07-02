# PR Remediation Plan — Round 3

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-b (PR #33)
**Findings:** 1 critical, 15 advisory (6 agents: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead)

## Critical Fixes

### Fix 1: compose drops gauntlet advisories from machine-readable outcome
- **Source:** silent-failure-hunter, type-design-analyzer, comment-analyzer, architecture-tech-lead (independent)
- **Files:** packages/framework/src/cli/compose.ts:479-494, new.ts:457, types.ts:200-205
- **Issue:** `writeAuthoredScaffold` hardcodes `advisories: []`; runCompose returns it unchanged, so `ComposeOutcome.ok.result.advisories` is always `[]`, violating the documented NewResult contract that runNewFrom honors. Tooling parsing compose's JSON never sees lint advisories.
- **Fix:** Make `writeAuthoredScaffold` take `advisories` as a parameter (type forces both callers to decide); runCompose hoists the accepted verdict alongside lastProven and threads its advisories. Test: compose with non-empty-advisory fake gauntlet asserts advisories on the ok outcome (also covers the io.say advisory-display branch).

## Advisory Fixes

1. compose.ts:341 — enforce `dag.team === options.team` in the schema gate as a repair-loop problem. Test.
2. bin/fugue.ts:164-171 — only fold rl.question rejection to `closed` when the interface actually closed (track isClosed); otherwise rethrow.
3. compose.ts:391-408, 484-490 — preserve stack (`e.stack ?? e.message`) in gauntlet-failed / write-failed problems.
4. gauntlet.ts:74 — staging rm failure: stderr warning instead of empty catch.
5. authored-codegen.ts:300 — throw "authored-codegen invariant" for unwired human-review inExpr instead of silent `z.never()` fallback.
6. bin/fugue.ts:159 — SIGINT handler prints "interrupted — finishing the current step, then aborting…" to stderr.
7. bin/fugue.ts:138-140 — missing ANTHROPIC_API_KEY emits `{ ok: false, problems }` JSON envelope, exit 1.
8. vocabulary.ts:29-32 — deep-freeze CONFIDENCE_FIELD.
9. compose.ts:263-267 — carry last proven draft as typed `draft` field on the failure arm of ComposeOutcome instead of marker-line smuggling in problems; update bin/tests.
10. new.ts:92 — add `mode: "shape" | "from"` discriminant to ParsedNewArgs/ParsedNewFromArgs; bin matches on it.
11. identifiers.ts:83 — narrow IdentifierSource.kind / nodeRefName to `keyof typeof NODE_FACTORY_NAME`.
12. Single-source KEBAB/KEBAB_IDENT/IDENT regexes in identifiers.ts; import from authored.ts, compose.ts, new.ts, authored-codegen.ts.
13. bin/fugue.ts:156-171 — extract `readlineComposeIo` adapter into src/cli/compose-io.ts over a structural readline interface; test with fake emitter (close mid-question, close before, rejection).
14. Tests (authored/compose): human-review outside linear (fix misleading title at authored.test.ts:264); llm × router gauntlet fixture (route on confidence enum); superRefine rules (node referenced twice, sources entry not source, assemble of kind source, duplicate router case label, dup node id, dup field name); fugueAuthored wrong-version rejection; accept-vocabulary variants (y/accept/no/quit/exit, case-insensitive).
15. Tests (bin): visualize --raw contract (bare diagram stdout / stderr+exit1 / rejected elsewhere); new --from vs shape dispatch — subprocess tests.

## Validation Commands
```bash
cd packages/framework && bun test src/__tests__/cli/ && bunx tsc --noEmit
```

## Deferred
- AbortSignal threading into sendStructured for true SIGINT cancellation (API change across LlmClient; feedback message shipped instead).
- Monorepo-wide typecheck errors in @fuguejs/host/examples — pre-existing on main, out of scope.
