# PR Remediation Plan — Round 17

**Date:** 2026-07-10
**Branch:** feat/deterministic-core-phase-b
**Findings:** 2 critical, 9 advisory
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead

## Critical Fixes

### Fix 1: Round-16 `server_error → retriable` pin is vacuous (soft guard) — mutation to `transient` passes all 31 tests
- **Source:** code-reviewer (mutation-verified)
- **File:** packages/framework/src/__tests__/openai-client.test.ts:752
- **Issue:** `if (!result.ok && result.error.kind === "node-crash")` silently skips both assertions when the kind regresses. Every sibling round-16 test uses the hard pattern; only this one regressed to the soft guard round-15 Fix 9 eliminated.
- **Fix:** Hard-assert `expect(result.error.kind).toBe("node-crash")` before narrowing, matching siblings.

### Fix 2: responseFailedError transient arm drops the failed turn's usage (FR-W0-001 under-count)
- **Source:** type-design-analyzer (critical) + silent-failure-hunter + architecture-tech-lead + code-reviewer (advisory) — 4/6 agents, verified by execution
- **File:** packages/framework/src/llm/openai-client.ts:74-78
- **Issue:** The `rate_limit_exceeded → transient` arm discards the `usage` parameter though the transient variant carries `usage?: PartialTokenUsage`, `withAccumulatedUsage` sums it, and host metered-llm settles budget from `usageOfError` on failures. A failed rate-limited turn's tokens escape budget accounting on a live consumed path.
- **Fix:** `...(usage ? { usage } : {})` on the transient arm; update the docblock (drop "rides along on the node-crash arms"); pin with a usage assertion in the rate-limit tests.

## Advisory Fixes

### Fix 3: responseFailedError callers stamp usage {0,0} when the failed body reports no usage
- **Source:** silent-failure-hunter (verified)
- **File:** packages/framework/src/llm/openai-client.ts:300-303, :454-462
- **Fix:** Pass usage to responseFailedError only when `response.usage` is present, honoring the documented "absent means no attributable tokens" contract (tool-use-loop.ts:127-131).

### Fix 4: Transient errors never populate the typed `httpStatus` field
- **Source:** silent-failure-hunter (verified)
- **File:** packages/framework/src/llm/llm-errors.ts:40 (httpFailureToError), :144 (classifyLlmError duck-typed arm)
- **Fix:** Attach `httpStatus: status` on the transient arms in both places; consumers can branch on it instead of string-matching messages.

### Fix 5: classifyLlmError re-hardcodes `status === 408 || status === 409` instead of reusing TRANSIENT_HTTP_STATUSES
- **Source:** type-design-analyzer
- **File:** packages/framework/src/llm/llm-errors.ts:144
- **Fix:** `TRANSIENT_HTTP_STATUSES.has(status)` (429 intercepted earlier by isRateLimit; identical classification if reached, so reuse is safe).

### Fix 6: Provider `error.message` bypasses truncateErrorBody
- **Source:** type-design-analyzer
- **File:** packages/framework/src/llm/openai-client.ts:72
- **Fix:** `truncateErrorBody(response.error?.message ?? JSON.stringify(response))`.

### Fix 7: incomplete_details dead wire-shape — thread `reason` into the incomplete messages
- **Source:** pr-test-analyzer + type-design-analyzer
- **File:** packages/framework/src/llm/openai-types.ts:93; openai-client.ts:340/:350/:476
- **Fix:** Include `incomplete_details?.reason` in the incomplete-arm messages (distinguishes max_output_tokens from content_filter), mirroring how error.code is surfaced on the failed arm. Pin one row.

### Fix 8: Residual statuses / stop_reasons still fall through to the loop's context-free retriable arm
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/openai-client.ts:486-495; anthropic-client.ts:311-325
- **Fix:** Before handing `textContent: undefined` to the loop, when output is empty and status/stop_reason is a residual value, name it and snapshot the body in the message (mirror sendStructured's no-text arm) so unknown terminal states are diagnosable. Closes the class instead of per-status arms.

### Fix 9 (tests): mutation-survivable gaps
- **Source:** pr-test-analyzer (all mutation-verified)
- **Files:** openai-client.test.ts, compose.test.ts, llm-errors.test.ts
- **Fix:** (a) status:"failed" + error:null row asserting the body-snapshot fallback and non-retriable node-crash; (b) assert `error.usage` on the sendStructured failed arm (folds into Fix 2/3 pins); (c) `maxQuestionRounds: 0` / `maxRepairRounds: 0` boundary rows for requireRoundBudget; (d) message-passthrough assertion in the duck-typed 408/409 test.

### Fix 10 (docs): comment accuracy
- **Source:** comment-analyzer
- **Files:** llm-errors.ts:20-32 (move TRANSIENT_HTTP_STATUSES above the httpFailureToError JSDoc so the contract doc reattaches to the function); anthropic-client.ts:172 ("transient model behavior" → "retriable (non-deterministic) model behavior" to avoid collision with the FrameworkError `transient` kind); openai-client.ts:63 docblock updated by Fix 2.

### Fix 11 (docs): round-16-deferred doc touch-ups, batched
- **Source:** comment-analyzer (deferred round 16, still open)
- **Files:** llm-errors.ts:1-5 header (module also owns HTTP policy / temperature validation / body truncation); llm-errors.ts:21 "every client's non-OK response arm" claim (Anthropic client never calls it); new-templates.ts:4 examples path (actual: packages/framework/docs/examples/01-linear.ts…10-human-review.ts); new.ts:459-468 runNewFrom docblock.

## Deferred / not applied this round
- Truncation-policy extraction into llm-errors.ts (standing; architecture re-assessed round 17: grown to ~6–7 sites, do before Phase C — but a larger refactor than this round's scope); fold responseFailedError relocation + the fast-check usage-preservation property into it.
- Gauntlet advisories dropped; runNewFrom e.stack; Temperature branding; turn() retriability flattening; runCompose state-machine reification; io.ask/io.say rethrow boundary; TEMPLATE_OPEN/TEMPLATE_OPENERS coupling property; compose-io equivalent-mutant comment; standing rounds 10–16 list.

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit && bunx tsc --noEmit -p tsconfig.bin.json && bun test
```
