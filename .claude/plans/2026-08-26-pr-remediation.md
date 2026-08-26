# PR Remediation — F4 Prompt Caching (PR #38)

**Date:** 2026-08-26
**Branch:** `feat/f4-prompt-caching` (worktree `.claude/worktrees/f4-prompt-caching`)
**Subject commit:** `4359bf3`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/2026-08-26-f4-prompt-caching`
**Frozen scope:** the 46 files listed in `result.json.scope` (the exact PR diff)

## Adjudication outcome

| Bucket | Count |
|---|---|
| Reviewers | 7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier) |
| Critical found | 1 |
| Critical refuted | 0 |
| **Critical surviving (mandatory)** | **1** |
| Advisory | 26 raw / 17 distinct after de-duplication |

Refutation Panel: lenses `reproduction`, `intent`, `blast-radius`; threshold 2-of-3.
`architecture-tech-lead-1` — **upheld** by `reproduction` and `blast-radius`; `intent`
returned `uncertain` (correctly noting the finding never disputes that the asymmetry is
deliberate, only that the claimed regression test does not exist). No finding was refuted,
so there is no refuted-finding audit to report.

## Surviving critical — mandatory

### C1 — `packages/framework/src/llm/openai-client.ts`
**Claim:** `LlmClient`'s two adapters disagree on the `cache` contract (Anthropic honours it,
OpenAI silently ignores it on request construction), and ADR-0081's claim that the asymmetry
"is pinned by a regression test in each client" is **false** for the OpenAI request-construction
side — no test asserts the OpenAI request body is unaffected by a declared cache policy.

**Verified independently:** `openai-client.ts` never reads `req.cache` in either
`sendStructured` or `sendWithTools`; `openai-client.test.ts` contains zero occurrences of
"cache" despite already owning a fetch-body-capturing harness; `prompt-cache-clients.test.ts`'s
OpenAI section only exercises response-usage normalisation and never sets a `cache` field.

**Why it is critical rather than advisory:** the defect is not the asymmetry (that is designed
and documented) — it is that a shipped ADR asserts a safety net that does not exist. A reviewer
trusting ADR-0081 would not know to add it, and `llm.ts`/`llm-with-tools.ts` thread `cache` into
this client on every OpenAI-backed node.

**Fix:** add an OpenAI request-shape regression block to `prompt-cache-clients.test.ts` that
calls `sendStructured` with `{ kind: "static-prefix" }` and `sendWithTools` with
`{ kind: "conversation" }`, capturing the outgoing request body and asserting it is deep-equal
to the same call with `cache` omitted — the exact mirror of the existing Anthropic FR-PC-004
tests. This makes ADR-0081's sentence true rather than editing it away.

## Advisory dispositions

Duplicates collapsed (`type-design-analyzer-5..8` restate `1..4`; `comment-analyzer-2` and
`code-simplifier-4` restate `comment-analyzer-1`; `code-simplifier-10` restates
`type-design-analyzer-2`).

### Accepted (14)

| ID | Fix |
|---|---|
| `silent-failure-hunter-1` | `eval-judge.ts`'s local `warnWithoutThrowing` swallows a throwing `ctx.logger.warn` with no breadcrumb. Route it through the shared `logFrameworkWithoutThrowing` fallback so a hostile logger cannot erase the warning entirely. |
| `pr-test-analyzer-1` | Test `enrichLlmSpan`'s cache span attributes and `llm.cost` cache components (`span-enrich.test.ts`). |
| `pr-test-analyzer-2` | Assert `cacheWriteTokens`/`cacheReadTokens` on both `llm.metered` and `llm.call-failed` log lines (`metered-llm.test.ts`). |
| `pr-test-analyzer-3` | FR-PC-006: assert cache figures survive onto a usage-carrying **error** arm, both providers (`prompt-cache-clients.test.ts`). |
| `pr-test-analyzer-4` | Exercise `openAiUsage`'s `Number.isFinite` guard with a non-numeric `cached_tokens`. |
| `type-design-analyzer-1` | `openAiUsage` clamps `cacheReadTokens` but not `tokensIn`; `anthropicUsage` clamps nothing. Route both through one `sanitizeCount` so the `TokenUsage` invariant holds at construction for every producer. |
| `type-design-analyzer-2` | Pin `TokenDelta` to the framework's `TokenUsage` with a compile-time equivalence assertion, so a future field on `TokenUsage` fails the build instead of being silently dropped at the host boundary. |
| `type-design-analyzer-3` | One-line comment on `PartialTokenUsage` recording that partiality is expressed by field optionality, not by the alias. |
| `comment-analyzer-1` | De-duplicate the tripled `CostBreakdownUsd`/`costUsd` JSDoc rationale in `cost.ts` (introduced by this PR's own distill pass). |
| `code-simplifier-1` | Import `ToolLoopProvider` by name in `anthropic-client.ts` instead of an inline `import(...)` type. |
| `code-simplifier-2` | Same in `openai-client.ts`. |
| `code-simplifier-3` | Hoist the mid-file `import { match } from "ts-pattern"` in `openai-client.ts` to the top block. |
| `code-simplifier-7` | Drop the no-op `?? undefined` on `cacheWriteTtl` in `llm-pipeline.ts`. |
| `code-simplifier-9` | Extract the repeated `dagId/runId/nodeId` attribution triple in `metered-llm.ts`. |
| `code-simplifier-11` | Extract the repeated OpenAI `fetch`-stub/restore ceremony into `_prompt-cache-helpers.ts`. |

### Deferred (2)

| ID | Reason |
|---|---|
| `type-design-analyzer-4` | `llm-budget-exceeded.cumulative` has no type-level settled-vs-projected distinction. The variant is **pre-existing** (host budget work, FR-W1-003), not introduced by this PR, and drawing the distinction is an interface change across the error ADT and its persisted wire schema — deepen territory, not remediation of this diff. |
| `code-simplifier-8` | Unifying `metered-llm`'s `sendStructured`/`sendWithTools` scaffolding into one `runMetered` closure. The duplication is **pre-existing**, and the shared code is the reserve→settle→rethrow→release concurrency path where a subtle refactor error is silent. Deserves its own change with focused tests rather than riding a caching PR. |

### Dismissed (1)

| ID | Reason |
|---|---|
| `code-simplifier-5` / `-6` | Conditional-spread (`...(x ? { x } : {})`) → plain assignment in `llm.ts`/`llm-with-tools.ts`. The claim of behavioural equivalence is **sound** (`exactOptionalPropertyTypes` is not enabled — verified in `tsconfig.base.json`), but the pattern is the established local idiom for all three fields (`thinking`, `signal` pre-date this PR; `cache` follows them), and the change would make `"cache" in req` newly true on every request for no behavioural gain. A non-zero surface change for zero benefit. |

## Validation commands

```bash
bun run --filter '*' typecheck          # expect 0 errors
cd packages/framework && bun test --path-ignore-patterns='dist/**'   # expect 0 fail
cd packages/host && bun test                                          # expect exit 0
bun run check:docs                                                    # expect all links resolve
```
