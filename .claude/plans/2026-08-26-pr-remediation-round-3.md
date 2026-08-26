# PR Remediation Round 3 — F4 Prompt Caching (PR #38)

**Date:** 2026-08-26
**Branch:** `feat/f4-prompt-caching`
**Subject commit:** `294ceba` (the round-2 remediation)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-08-26-f4-prompt-caching-round-3`
**Prior plans:** `.claude/plans/2026-08-26-pr-remediation.md`, `…-round-2.md`

## Adjudication outcome

| Bucket | Count |
|---|---|
| Critical found | **0** |
| Critical refuted | 0 |
| Critical surviving | **0** |
| Advisory | 10 |

**No Refutation Panel ran** — the engine routes only a non-empty critical set through
it, so `panel` is `null` in `result.json`. There is no refuted-finding audit.

Five of the seven reviewers returned clean, each independently re-verifying the
round-1 and round-2 fixes rather than trusting the commit messages. The criticals
have dried up: 1 → 2 → 0 across the three rounds. What remains is coverage and tidying.

## Advisory dispositions

### Accepted (8)

| ID | Fix |
|---|---|
| `pr-test-analyzer-1` | The fake client's per-turn `cacheWriteTokens`/`cacheReadTokens` are asserted by no test. My own plan added them "so DAG-level tests can exercise cache accounting without a provider" — an unpaid promise. Pin that a scripted turn's cache figures accumulate into the final response. |
| `pr-test-analyzer-2` | `withTurnBreakpoint`'s skip-on-`thinking`/`redacted_thinking`/empty-content guard is untested. It exists because the compiler surfaced a real provider constraint (Anthropic rejects `cache_control` on thinking blocks); pin the documented behaviour so it survives the day `thinking` is enabled on the loop. |
| `pr-test-analyzer-3` | The node-level `cache` config is never exercised end-to-end — every existing test drives the client or the pipeline directly. This is the exact surface a node author touches (FR-PC-001). One test per factory asserting the field reaches the request. |
| `pr-test-analyzer-4` | `runCacheReadTokens` is a dead export — zero callers, zero tests. **Delete it** rather than test it: adding coverage for an unused export entrenches it, and `typescript-patterns.md` names dead exports as the pool `tsc`'s unused-code flags cannot catch. |
| `pr-test-analyzer-5` | `accumulate`'s cache-field arithmetic is only ever fuzzed for finiteness, never asserted correct across sequential calls. Cheap to pin at the pure-unit layer. |
| `code-simplifier-1` | `AnthropicSdkLike` splits `anthropic-client.ts`'s import block in half. Move it below the imports. (Round 2's simplifier chose not to flag this; it was never adjudicated either way, so this is a fresh call, not a re-litigation.) |
| `code-simplifier-4` | `metered-llm.ts`'s `record()` manually re-lists all four `TokenUsage` fields instead of `...usage`. This is the sharpest finding of the round: the `TokenUsage` header comment **I wrote** warns that manual field-listing is how a future field gets silently dropped — and then this code does exactly that. Spread it. |
| `code-simplifier-5` | `settle()`'s failure branch hand-simulates `...partial` with a ternary; object-spread of `undefined` is already a no-op. Note the reviewer's own caveat, verified: the neighbouring `...(budget !== undefined ? { budget } : {})` must **not** get the same treatment, because `budget` is a bare number and `{...5}` spreads nothing. |

### Deferred (1)

| ID | Reason |
|---|---|
| `code-simplifier-2` | Hoisting the duplicated `LlmSkipConfig`/`LlmWithToolsSkipConfig` into one shared type. Both are pre-existing and unrelated to caching, and the reviewer itself flagged it as "borderline `deepen` territory… flagging rather than merging unilaterally" because the fix adds a new import edge between the two node factories. That is a structural decision, not remediation of this diff. |

### Dismissed (1)

| ID | Reason |
|---|---|
| `code-simplifier-3` | Inlining `eval-judge.ts`'s five `configured*` aliases. Pre-existing code with no relationship to prompt caching; this PR touched that file only for the `enrichLlmSpan` call signature and the logger fallback. Rewriting five unrelated local bindings is precisely the drive-by churn the distill rules warn makes a diff unreviewable. |

## Support paths

Two accepted fixes must touch files **outside** the frozen 49-file scope, so the
remediation start input registers them explicitly:

- `packages/framework/src/__tests__/llm-fake-client.test.ts` (`pr-test-analyzer-1`)
- `packages/framework/src/__tests__/llm-with-tools-factory.test.ts` (`pr-test-analyzer-3`)
- `.claude/plans/2026-08-26-pr-remediation-round-3.md` (this plan)

## Validation commands

```bash
bun run --filter '*' typecheck
cd packages/framework && bun test --path-ignore-patterns='dist/**'
cd packages/host && bun test
bun run check:docs
```
