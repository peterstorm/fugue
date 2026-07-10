# PR Remediation Plan — Round 16

**Date:** 2026-07-10
**Branch:** feat/deterministic-core-phase-b
**Findings:** 3 critical, 3 advisory applied (remaining advisories deferred/doc-only)
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead

## Critical Fixes

### Fix 1: OpenAI `response.status === "failed"` sails past the incomplete short-circuit (sendWithTools)
- **Source:** silent-failure-hunter (executed and confirmed)
- **File:** packages/framework/src/llm/openai-client.ts:425
- **Issue:** The round-15 short-circuit handled only `"incomplete"`. A 200 body with `status: "failed"` and a populated `error: { code, message }` (the Responses API failure envelope) had empty `output` → `toolCalls: []`, `textContent: undefined` → the tool-use-loop's context-free retriable "Final turn had no text content to parse" arm. The provider's stated reason was lost and a deterministic failure (invalid_prompt) retried blindly, burning budget.
- **Fix:** New pure `responseFailedError(response, nodeId, usage?)` helper: surfaces `error.code`/`error.message` verbatim, derives retriability from the code (`rate_limit_exceeded` → transient, `server_error` → retriable node-crash, any other code → non-retriable), carries the turn's usage. Added a `status === "failed"` short-circuit before the incomplete check in sendWithTools.
- **Applied:** `ResponsesApiResponse` gained `error` + `incomplete_details` fields; helper + short-circuit added. Pinned in openai-client.test.ts (invalid_prompt → non-retriable with code/message/usage; server_error → retriable).

### Fix 2: OpenAI `response.status === "failed"` stays retriable (sendStructured)
- **Source:** silent-failure-hunter (executed and confirmed)
- **File:** packages/framework/src/llm/openai-client.ts:272
- **Issue:** `truncated` tested only `"incomplete"`, so a `failed` response took the `!rawText` arm with `retriability: "retriable"`; `response.error` survived only if it fit the 200-char body-truncation window.
- **Fix:** Same `responseFailedError` short-circuit added at the top of the sendStructured response handling, before the rawText/parse/schema arms.
- **Applied:** Pinned in openai-client.test.ts (invalid_prompt → non-retriable carrying code + message; rate_limit_exceeded → transient).

### Fix 3: Anthropic `stop_reason === "refusal"` lost and misclassified retriable (sendWithTools)
- **Source:** silent-failure-hunter (executed and confirmed)
- **File:** packages/framework/src/llm/anthropic-client.ts:277
- **Issue:** The short-circuit tested only `"max_tokens"`. A `refusal` turn (in the vendored SDK's StopReason union) has no tool_use and no text → `lastTextBlock` undefined → the loop's generic retriable no-text arm. stop_reason lost; a deterministic refusal retried.
- **Fix:** Added a `stop_reason === "refusal"` short-circuit (non-retriable node-crash naming the stop_reason, carrying the turn's usage — identical shape to the max_tokens arm).
- **Applied:** Pinned in anthropic-client.test.ts sendWithTools (refusal → non-retriable, message names stop_reason, usage attributed).

## Advisory Fixes

### Fix 4: Anthropic `refusal` stays retriable (sendStructured)
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/anthropic-client.ts:172
- **Fix:** Extended the `truncated`-based retriability derivation to also mark `stop_reason === "refusal"` non-retriable (`nonRetriable = truncated || refusal`). Deterministic under compose's pinned temperature 0.
- **Applied:** Pinned in anthropic-client.test.ts sendStructured (refusal → non-retriable).

### Fix 5: Blanket non-429 4xx → non-retriable misclassifies HTTP 408/409
- **Source:** silent-failure-hunter
- **File:** packages/framework/src/llm/llm-errors.ts (httpFailureToError + classifyLlmError duck-typed arm)
- **Issue:** 408 Request Timeout and 409 Conflict are transient by RFC and retried by both providers' SDKs; the round-15 policy made them permanent node failures.
- **Fix:** Carved 408/409 into the transient set in the single shared policy (`TRANSIENT_HTTP_STATUSES = {408, 409, 429}`) and mirrored the carve-out in the `classifyLlmError` duck-typed status arm.
- **Applied:** llm-errors.test.ts updated — the fast-check 400–599 property now asserts 408/409/429 transient; explicit 408/409 rows for both `httpFailureToError` and `classifyLlmError`.

## Deferred / not applied this round
- **Truncation policy duplicated at 4 sites** (architecture + type-design advisory): extract a shared `truncatedTurnError`/`retriabilityFor` into llm-errors.ts, and document the sendStructured "truncated-but-parseable accepted" asymmetry. Folds naturally with the `responseFailedError` precedent; deferred to keep this round scoped to the fail-open criticals.
- **sendStructured truncation arms carry no usage** (FR-W0-001 latent): the sendStructured `max_tokens`/`incomplete` arms don't attach usage while sendWithTools does. Latent today (`error.usage` consumed only by the loop). Fold into the truncation-policy extraction above.
- **Gauntlet `advisories` dropped by every failure consumer**; **runNewFrom read-failure drops e.stack**; **compose.ts round-budget RoundBudget brand**; **classifyAnswer empty-arm**; **TEMPLATE_OPEN/TEMPLATE_OPENERS coupling property test**; **doc-scope touch-ups** (llm-errors header, httpFailureToError "every client", runNewFrom docblock, new-templates.ts examples path, NUL-separator comments) — all advisory, batched for a follow-up doc/quality pass.
- **compose-io.ts equivalent-mutant comment** (test-quality, rating 3); **runCompose state-machine reification** (architecture, before Phase C adds arms).
- Standing deferrals (rounds 10–15): turn() retriability flattening, io.ask/io.say rethrow boundary, Temperature branding, dag-definition-error.dagId branding, DescribeWarning union, dual topology walks, host workspace typecheck.

## Validation Commands
```bash
cd packages/framework && bunx tsc --noEmit && bunx tsc --noEmit -p tsconfig.bin.json && bun test
```
