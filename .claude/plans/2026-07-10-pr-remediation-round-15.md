# PR Remediation Plan — Round 15

**Date:** 2026-07-10
**Branch:** feat/deterministic-core-phase-b
**Findings:** 1 critical, 19 advisory
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead

## Critical Fixes

### Fix 1: formatLintError stack/detail preservation is completely unpinned (mutation-verified)
- **Source:** pr-test-analyzer
- **File:** packages/framework/src/cli/types.ts:186 (fix lands in tests)
- **Issue:** Reverting round-14 Fix 2 to `` `${e.kind}: ${e.message}` `` (silently dropping `import-failed` stacks and `describe-failed`/`dag-definition-error` `detail` payloads) passes all 339 CLI tests. compose.test.ts:321 constructs a `detail` payload but only asserts `toContain("describe-failed")`.
- **Fix:** In compose.test.ts:321 add `expect(outcome.problems[0]).toContain('detail:')` and an assertion that the simulated message survives (e.g. `toContain('"message":"simulated"')` — match actual serialization). Add a sibling row with an `import-failed` error carrying a `stack`, asserting the stack survives into `problems` for both the compose path and `runNewFrom`'s problems envelope (new.ts:512).
- **Applied:** compose.test.ts describe-failed test now pins `detail:` + `"message":"simulated"` in problems[0] (verified against actual JSON serialization); new sibling compose test pins an import-failed `stack` surviving into gauntlet-failed problems; authored.test.ts runNewFrom gauntlet-failure test now carries a stack and asserts it survives the problems envelope.

## Advisory Fixes

### Fix 2: promptText `{{` scrub is non-idempotent
- **Source:** code-reviewer (runtime-verified)
- **File:** packages/framework/src/cli/authored-codegen.ts:98
- **Issue:** `text.replace(/\{\{/g, "{ {")` re-creates `{{` from odd/overlapping brace runs: `"{{{text}}"` → `"{ {{text}}"`, still a live placeholder. Defense-in-depth layer fails on exactly the adversarial class it exists for (schema layer still blocks production reachability).
- **Fix:** `text.replace(/\{(?=\{)/g, "{ ")` (lookahead keeps the second brace in scan — no `{{` survives; idempotent). Extend the pin test with `{{{text}}` and `{{{{` inputs asserting no `{{` survives in the emitted prompt body.
- **Applied:** `TEMPLATE_OPENERS` (identifiers.ts — the single source) changed to the lookahead `/\{(?=\{)/g` with `promptText`'s replacement now `"{ "` (preserves the single-sourcing invariant); new authored.test.ts pin over `{{{text}}` / `{{{{` asserts no `{{` survives the Task line; the existing `{ {text}}` pin is unchanged (same output under the lookahead).

### Fix 3: Anthropic sendWithTools drops stop_reason — max_tokens truncation stays retriable
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/anthropic-client.ts:271-285 (with tool-use-loop.ts:213-229 as consumer)
- **Fix:** When `response.stop_reason === "max_tokens"` in the `call` closure, surface a typed non-retriable `node-crash` (stop_reason in the message, mirroring sendStructured) or thread `stopReason` onto `TurnResult` so parse-failure arms downgrade retriability. Pin with a test.
- **Applied:** sendWithTools `call` closure short-circuits `stop_reason === "max_tokens"` to a NON-retriable node-crash naming the stop_reason and carrying the turn's own usage (token attribution preserved through `withAccumulatedUsage`); pinned in anthropic-client.test.ts.

### Fix 4: OpenAI never classifies truncation (`response.status === "incomplete"`)
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/openai-client.ts:283-318 (sendStructured), :413-449 (sendWithTools)
- **Fix:** Mirror the Anthropic treatment — derive `truncated = response.status === "incomplete"` and make the `!rawText`/JSON-parse/schema-validation arms non-retriable when truncated, in both send paths. Pin with tests.
- **Applied:** sendStructured derives `truncated`/`retriability` and threads them through the `!rawText`/JSON-parse/schema arms (messages name `response.status: incomplete`); sendWithTools `call` closure short-circuits incomplete to a NON-retriable node-crash carrying the turn's usage (mirrors Fix 3). Pinned in openai-client.test.ts: retriability added to the existing missing-output_text test, plus new JSON-parse/schema-arm and sendWithTools truncation tests.

### Fix 5: 200-with-non-JSON body bypasses the hardened malformed-success arm
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/openai-client.ts:172 (`postResponses`)
- **Fix:** Read `await httpRes.text()`, `JSON.parse` in try/catch; on failure return the existing `{ ok: false, status, bodyText }` shape so the error carries `HTTP 200` + `truncateErrorBody(text)`. Pin with a test.
- **Applied:** `postResponses` now reads `.text()` and JSON.parses in try/catch; a non-JSON 200 body returns `{ ok: false, status: 200, bodyText }` → `HTTP 200` + truncated body via the shared HTTP policy (retriable node-crash). Pinned with an HTML-interstitial test.

### Fix 6: `cause: "threw"/"rejected"` runtime values unpinned (mutation-verified)
- **Source:** pr-test-analyzer
- **Files:** compose.test.ts:670, :777, :437
- **Fix:** Add one `expect(outcome.cause).toBe(...)` in each of the three tests (gauntlet throw → "threw"; write throw → "threw"; write rejected → "rejected").
- **Applied:** all three `expect(outcome.cause).toBe(...)` assertions added (gauntlet throw → "threw"; write throw → "threw"; write rejected → "rejected").

### Fix 7: Anthropic sendStructured schema-construction pre-flight unpinned (mutation-verified)
- **File:** packages/framework/src/llm/anthropic-client.ts:124
- **Fix:** Mirror anthropic-client.test.ts:361 for sendStructured: throwing schema construction → `kind: "validation"`, zero wire calls.
- **Applied:** anthropic-client.test.ts sendStructured pre-flight test added: `{}` as schema → `validation` with nodeId, zero stub calls.

### Fix 8: OpenAI sendStructured pre-flight untested (symmetric)
- **File:** packages/framework/src/llm/openai-client.ts:178
- **Fix:** Same one-test addition (cf. openai-client.test.ts:480 for the sendWithTools arm).
- **Applied:** openai-client.test.ts sendStructured pre-flight test added: `{}` as schema → `validation` with nodeId, `fetchCalls` empty.

### Fix 9: Vacuous guarded-if narrowing in truncation tests
- **Files:** packages/framework/src/__tests__/anthropic-client.test.ts:187; openai-client.test.ts:263
- **Fix:** Convert soft guards to hard assertions (`expect(r1.error.kind).toBe("node-crash")` before narrowing) so arm reclassification cannot pass vacuously.
- **Applied:** anthropic truncation test's r1/r2 soft guards converted to hard `expect(error.kind).toBe("node-crash")` before narrowing; same hardening applied to openai's missing-output_text (status: incomplete) test; all new Fix 3/4/5 tests use the hard pattern.

### Fix 10: aborted arm drops gauntlet-proven draft on `cause: "input-closed"`
- **Source:** type-design-analyzer
- **File:** packages/framework/src/cli/compose.ts:127 (sites :585, :684)
- **Issue:** The union's principle is "hitting a wall never discards proven work"; input-closed (Ctrl-D / piped-stdin exhaustion) is a wall, not a decision, yet `lastProven` vanishes.
- **Fix:** Add `draft?: AuthoredDag` (lastProven) on the `input-closed` cause, keep absence for `user`; update the arm doc; pin with a test.
- **Applied:** the aborted arm is split into `cause: "user"` (no draft field — absence is structural) and `cause: "input-closed"` (optional `draft` = lastProven), with the arm docs rewritten to match the producer sites exactly; both input-closed sites (compose.ts interview + accept prompt) attach `lastProven` via conditional spread. Pinned: accept-prompt closed → `draft` equals the proven dag; interview closed → `draft` undefined.

### Fix 11: classifyAnswer precondition lives in a doc comment
- **File:** packages/framework/src/cli/compose.ts:450
- **Fix:** Trim internally (idempotent for the current caller); keep the doc.
- **Applied:** `classifyAnswer` trims internally (the refine arm carries the trimmed text); doc updated; three padded-input rows added to the classifier test table.

### Fix 12: maxQuestionRounds/maxRepairRounds admit NaN/negative/fractional
- **File:** packages/framework/src/cli/compose.ts:95
- **Issue:** `rounds.questions >= NaN` is always false — NaN disables the question bound entirely (unbounded paid turns). Programmatic-only reachability.
- **Fix:** Validate at the runCompose boundary (non-negative integer via `Number.isInteger` + `>= 0`, else throw or clamp with documented behavior); pin with a test.
- **Applied:** `requireRoundBudget` (non-negative integer, else throw — a programmatic-only caller bug) guards both budgets at the runCompose boundary; ComposeOptions docs state the requirement; pinned over NaN/-1/1.5 for both options with zero LLM calls made.

### Fix 13: Provider-divergent 4xx retriability + duplicated HTTP classification
- **Source:** architecture-tech-lead
- **Files:** packages/framework/src/llm/llm-errors.ts:98-111; openai-client.ts:251-275 and :413-437
- **Issue:** Anthropic 401/400 fall through `classifyLlmError` as retriable while OpenAI marks non-429 4xx non-retriable; the 25-line 429/4xx/5xx policy is duplicated verbatim in openai-client.
- **Fix:** Extract pure `httpFailureToError(status, bodyText, nodeId)` into llm-errors.ts; collapse both openai sites onto it; teach `classifyLlmError` the 4xx (≠429) → non-retriable rule via a status duck-type. One test per client pinning 401 → non-retriable; optional fast-check property over 400–599.
- **Applied:** `httpFailureToError` + `truncateErrorBody` extracted to llm-errors.ts; both openai-client sites collapsed onto it (all existing 429/4xx/5xx tests green); `classifyLlmError` gained the duck-typed non-429 4xx → non-retriable arm. Pinned: Anthropic SDK 401 → non-retriable (openai 401 already pinned by the 4xx loop test), httpFailureToError unit tests incl. the HTTP-200 malformed-success arm, fast-check property over 400–599, classifyLlmError 4xx/5xx duck-type test.

### Fix 14: SYSTEM_PROMPT omits the round-14 `{{` schema rejection
- **Source:** comment-analyzer
- **File:** packages/framework/src/cli/compose.ts:381
- **Fix:** Append: purpose/description/field descriptions/enum values "must not contain `{{` (the runtime prompt-placeholder opener)."
- **Applied:** SYSTEM_PROMPT rule appended after the single-line bullet: purpose/description/field descriptions/enum values must not contain `{{` (the runtime prompt-placeholder opener).

### Fix 15: Doc drift (4 sites)
- visualize.test.ts:4 — reword header: only import/definition-class failures are shared with lint (contradicts visualize.ts:5-9).
- lint.ts:135 — "the first failure encountered" → "the accumulated errors" (checkFanInKeys accumulates).
- lint.ts:23 — recast ImportedDagFile rationale around the TDZ-on-re-import hazard, not "once per invocation" (gauntlet path imports twice, second is cache hit).
- openai-client.ts:74 — move the client description onto the `OpenAILlmClient` class (line 103); keep a one-liner on the opts interface.
- **Applied:** all four sites — visualize.test.ts header rewords the shared-failure claim to import/definition-class only (and notes analyzeDag checks are not re-run); lint.ts runLint doc says "the accumulated errors"; ImportedDagFile doc recast around the TDZ-on-re-import hazard (successful re-imports are harmless cache hits — the gauntlet path); the OpenAI client description moved onto the `OpenAILlmClient` class with a one-liner kept on `OpenAILlmClientOpts`.

## Deferred

### Temperature invariant structural enforcement (type-design advisory)
- **Reason:** Branded `Temperature` smart constructor or shared request-normalization step is a port-level design change touching every client and the public API; both current clients enforce via `validateTemperature` and tests pin it.
- **Recommendation:** Fold into the next LlmClient port revision; documented as residual risk at types/llm.ts:56.

### Standing deferrals (rounds 10–14, unchanged)
turn() retriability flattening, io.ask/io.say rethrow boundary, programmatic reserved-id derivation, duplicated scaffold writers, 8x error formatting, dag-definition-error.dagId branding, DescribeWarning union, dual topology walks, host workspace typecheck.

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit && bunx tsc --noEmit -p tsconfig.bin.json && bun test
```
