# PR Remediation Round 2 — F4 Prompt Caching (PR #38)

**Date:** 2026-08-26
**Branch:** `feat/f4-prompt-caching`
**Subject commit:** `1fd8761` (the round-1 remediation)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-08-26-f4-prompt-caching-round-2`
**Round-1 plan:** `.claude/plans/2026-08-26-pr-remediation.md`

## Adjudication outcome

| Bucket | Count |
|---|---|
| Critical found | 2 |
| Critical refuted | 0 |
| **Critical surviving (mandatory)** | **2** |
| Advisory | 6 raw / 5 distinct |

Refutation Panel: lenses `reproduction`, `intent`, `security`; threshold 2-of-3.
Both criticals **upheld** by `reproduction` and `intent`. `security` returned
`uncertain` on both, correctly declining to adjudicate a telemetry/documentation
accuracy question through a security lens. **No finding was refuted**, so there is
no refuted-finding audit to report.

Round 1's C1 (the missing OpenAI request-shape regression) was independently
verified as fixed by four of the seven reviewers.

## Surviving criticals — mandatory

Both are the *same wrong claim*, written in two places, and both are mine.

### C1 — `packages/framework/src/types/llm.ts:111`

The `LlmRequest.cache` doc says that for OpenAI the policy "only shapes what that
client **REPORTS** (`cacheReadTokens`), never what it sends."

**That is false.** `openAiUsage()` computes `cacheReadTokens` unconditionally from
`usage.input_tokens_details.cached_tokens`; `req.cache` is never read anywhere in
`openai-client.ts`. The panel reproduced it directly: the FR-PC-010 tests call
`sendOnce(usage)` with no `cache` argument at all and still get `cacheReadTokens`
populated — demonstrating the opposite of policy-shaped reporting.

The two facts are **independent**, not causal:
1. OpenAI ignores the field entirely on request construction (it caches automatically).
2. The client reports `cached_tokens` as `cacheReadTokens` regardless of what was declared.

**Fix:** state them as two independent facts. The plan doc already phrases it
correctly (FR-PC-010: "a request-construction no-op **and still** reports…") — use
that as the template, as the reviewer suggested.

### C2 — `docs/adr/0081-prompt-caching-as-a-declared-policy.md:74`

"OpenAI honours the policy only in what it *reports*" — the same causal error, in
the ADR's Consequences section. Same fix.

**Scope check:** `grep` over `packages/`, `docs/`, `CONTEXT.md` and `README.md`
confirms these are the only two sites; `docs/features.md` and `CONTEXT.md` describe
the asymmetry correctly, and the plan doc is already right.

## Advisory dispositions

### Accepted (4)

| ID | Fix |
|---|---|
| `silent-failure-hunter-1` + `pr-test-analyzer-1` (same finding) | Round 1's plan committed to an FR-PC-006 error-arm test for **both providers**; only the OpenAI side was written. Add the Anthropic mirror — a `node-crash` error arm carrying non-zero cache figures. My round-1 fix was incomplete against its own stated scope. |
| `pr-test-analyzer-2` | The round-1 `eval-judge` fallback (a throwing `ctx.logger` now falls back to the framework logger) has no test proving the breadcrumb actually survives — only that the result contract does. Pin it with the repo's existing `setFrameworkLogger` + recording-logger idiom. Adding a behaviour and not pinning it is the same class of gap round 1's C1 was. |
| `type-design-analyzer-1` | Make `PromptCachePlan` a discriminated union so the ttl/breakpoint pairing is structural rather than conventional. The reviewer's point lands: this PR gives `BudgetDecision`/`AdmitDecision` exactly that treatment while `prompt-cache.ts`'s own header invokes "illegal states unrepresentable" for its boolean fields — and the pairing is currently held only by there being one producer. Also deletes a property test that becomes unrepresentable rather than merely unobserved. |
| `code-simplifier-1` | Collapse the seven `err(withAccumulatedUsage(…, accumulated, corr))` repetitions in `toolUseLoop` into one local `fail` helper. Every one of those call sites was rewritten by this PR (the signature changed from two counters to one value), so this is this diff's duplication, not pre-existing churn. |

### Deferred (carried from round 1, not re-raised)

`type-design-analyzer-4` (settled-vs-projected `cumulative`) and `code-simplifier-8`
(unifying `metered-llm`'s two reserve/settle/release paths) stand as deferred. The
round-2 architecture and simplifier reviewers both explicitly declined to
re-litigate `code-simplifier-8`, citing the round-1 reasoning as sound.

### Dismissed

None this round.

## Validation commands

```bash
bun run --filter '*' typecheck
cd packages/framework && bun test --path-ignore-patterns='dist/**'
cd packages/host && bun test
bun run check:docs
```
