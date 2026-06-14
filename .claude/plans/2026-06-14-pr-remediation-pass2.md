# PR Remediation Plan — Pass 2

**Date:** 2026-06-14
**Branch:** feat/human-review-authoring
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead (6-agent parallel pass)
**Findings:** 1 critical, ~10 advisory (deduplicated). code-reviewer + architecture-tech-lead returned clean.

## Critical Fixes

### Fix C1: smoke `pollUntil` mis-reports a run that completes without parking
- **Source:** silent-failure-hunter
- **File:** `examples/hitl-smoke/smoke-logic.ts:32-33` (consumed at `smoke.ts:100`)
- **Issue:** `isPollDone(status, "suspended")` is true only for `suspended`/`failed`. A humanReview DAG that runs straight through to `completed` WITHOUT ever parking at the gate — the exact dropped-gate regression this smoke test exists to catch — never matches, so `pollUntil` spins to the 20s timeout and throws an opaque `timed out waiting for 'suspended'` instead of reporting the contract violation.
- **Fix:** Treat ANY terminal status (`completed` / `failed`) as poll-done. When waiting for `suspended` and the run reaches `completed`, `pollUntil` returns and the existing assertion at `smoke.ts:101` fires with an actionable `run did not park (status 'completed')`. Add a test pinning `isPollDone("completed", "suspended") === true`.

## Advisory Fixes

### Fix A1: `withHumanReview` silently overwrites an existing gate (double-gate)
- **Source:** silent-failure-hunter, pr-test-analyzer, type-design-analyzer (3-agent consensus)
- **File:** `packages/framework/src/nodes/human-review.ts:37-47`
- **Issue:** `withHumanReview(withHumanReview(node, a), b)` spreads `humanReview: b` over `a`, silently dropping the first prompt. Re-gating is an illegal state for a helper whose entire purpose is making the gate explicit.
- **Fix:** Throw at construction if `node.humanReview !== undefined`. A node carries at most one review gate. Add a test.

### Fix A2: `parseDecision` silently coerces malformed `SMOKE_DECISION` to approve
- **Source:** silent-failure-hunter
- **File:** `examples/hitl-smoke/smoke-logic.ts:13-14`
- **Issue:** `raw === "reject" ? "reject" : "approve"` runs the happy path on any typo (`Reject`, `approev`). An operator exercising the reject path who fat-fingers it gets a green "HITL loop OK" that never tested rejection.
- **Fix:** `parseDecision` returns a `ParsedDecision` sum type — `{ ok: true, decision }` for `approve`/`reject`/unset (unset → default approve), `{ ok: false, raw }` for anything else. The shell (`smoke.ts`) fails loudly with `process.exit(2)`, matching the `ADMIN_TOKEN` guard. Update the unit tests.

### Fix A4: `NewOptions.review` is optional while sibling flags are required
- **Source:** type-design-analyzer
- **File:** `packages/framework/src/cli/new.ts:42`, `:259`
- **Issue:** `review?: boolean` has three states (true/false/undefined) where two suffice; `llm`/`force` are required `boolean`. `parseNewArgs` always sets `review`, so the `?` only forces a needless `?? false` fallback.
- **Fix:** Make `review` a required `boolean`; drop the `?? false`. Update the test call sites to pass `review: false` explicitly.

### Fix A5: `NewResult.review === false` defaulting is unasserted
- **Source:** pr-test-analyzer
- **File:** `packages/framework/src/__tests__/cli/new.test.ts`
- **Issue:** the `--review` happy path asserts `review === true`; the no-`--review` case (stable-JSON contract: `review` is the literal `false`, not absent) is untested.
- **Fix:** add `expect(result.review).toBe(false)` to a non-review scaffold test.

## Deferred (documented, not applied this pass)

### A3: prompt non-empty invariant lives in a runtime guard + comment, not the type
- **Source:** type-design-analyzer (×2: primitive-obsession + choke-point bypass)
- **File:** `packages/framework/src/types/node.ts:48-51`, `:436`
- **Reason deferred:** The real fix (brand `prompt` as `NonEmptyString` with a parse constructor) changes an exported framework type, introduces new public API, and ripples into host-package test fixtures (`makeNode` in `service.test.ts:159` uses `Partial<NodeDef>`; `hitl-http.test.ts:30` builds `humanReview: { prompt }` literals). That is a deliberate type-system design decision, not a targeted remediation edit, and warrants explicit sign-off.
- **Mitigation in place:** Both helpers route through `withHumanReview`'s construction guard (the single choke point), which is present and tested for empty + whitespace prompts. The bypass requires deliberately hand-constructing a `humanReview: { prompt: "" }` literal past the documented front door.
- **Recommendation:** Introduce `NonEmptyString` (or `ReviewPrompt`) with a `parsePrompt` constructor; change `withHumanReview`'s param to raw `{ prompt: string }` parsed internally; type `NodeHumanReviewConfig.prompt` as the brand. Makes the runtime throw redundant (true parse-don't-validate) and the literal-bypass a compile error.

### A6: `--force` re-scaffold leaves stale files behind
- **Source:** silent-failure-hunter
- **File:** `packages/framework/src/cli/new.ts:208-240`
- **Reason deferred:** `--force` overwrites files individually but never clears the target dir, so a re-scaffold without `--llm` over a prior `--llm` dir leaves an orphaned `prompts/` + `registry.json`. The correct fix (clearing the dir under `--force`) changes destructive CLI behavior (`rm -rf` of a user directory) and deserves explicit design, not an automated edit.
- **Recommendation:** Either clear the target dir under `--force` before writing, or document that `--force` overwrites-but-does-not-clean.

### Sub-threshold (no action)
- Non-atomic batched writes (`new.ts:210-240`) — acknowledged in comments; the real cause propagates (not swallowed). Documented trade-off.
- `gate.run(input, {} as never)` ctx in `human-review.test.ts` — harmless for a pure passthrough (2/10).
- `parseNewArgs` value-flag followed by a bare positional yields a misleading "missing path" message — still errors, low severity.
- `createHumanReviewNode` passthrough identity tested by example not fast-check — trivially correct by construction (pr-test-analyzer: "not required").
- `docs/examples/10-human-review.ts` byte-identical copy unguarded — pre-existing convention across all `docs/examples/01-09`, not introduced here.

## Validation Commands
```bash
cd packages/framework && bun run typecheck && bun test src/__tests__/human-review.test.ts src/__tests__/cli/new.test.ts
cd examples/hitl-smoke && bun test smoke-logic.test.ts && bunx tsc --noEmit -p tsconfig.json
```
