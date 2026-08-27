# PR #39 remediation — F3 budget denominated in spend

**Branch:** `feat/f3-budget-capability`
**Head at review:** `7d1149999011c0ef29912b4a0e3881018bdf5728`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-08-27-f3-budget-spend`
**Result digest:** `1fb0d232214f72a8bbf58c2649a5c96a6d4a63bbf2a0e9afceb58ad57959f27e`

## Adjudicated outcome

| | |
|---|---|
| Reviewers | 7 |
| Surviving criticals | **1** |
| Refuted criticals | **0** |
| Advisory rows | 13 (7 unique; 6 are Machine-Summary duplicates of a `findings` block entry) |
| Panel | 3 lenses (`reproduction`, `intent`, `blast-radius`), threshold 2 |

Two reviewers returned fully clean (`code-reviewer`, `silent-failure-hunter`), each having independently traced the config→decorator wiring rather than trusting the commit message.

## Surviving critical — mandatory

### C1 · `comment-analyzer-1` — orphaned JSDoc block in `cost.ts`

`packages/framework/src/llm/cost.ts:115`

The pre-existing `computeCostUsd` doc block ("…warning once when the model has no price-table entry…") was left stranded when `spendOfCall` was inserted between it and the function it described. It now sits immediately above `spendOfCall`'s own doc block, which states the **opposite** policy ("Unlike `computeCostUsd`, an unknown model does NOT log and does NOT return zero"), while `computeCostUsd` at line 154 carries no doc at all.

**Panel: upheld 3–0.**

- *reproduction* — reproduced verbatim; two consecutive JSDoc blocks precede `spendOfCall` at 142, `computeCostUsd` is bare at 154.
- *intent* — "No reading of authorial intent makes 115-122 a correct description of `spendOfCall`."
- *blast-radius* — tried to contain it and failed: both functions are re-exported from `llm/index.ts` and consumed cross-package (`metered-llm.ts:206`), so the orphan sits on the published API surface. Documentation-only, no runtime path.

**Fix.** Move the block to sit directly above `export function computeCostUsd`. This is my regression: I inserted a function between a comment and its subject.

## Advisory dispositions

All seven unique advisories **accepted**. Nothing deferred, nothing dismissed — each is sound, in-scope, and cheap, and three of them (A3, A4, A5) are the same species of defect as C1 and as the F4 round-3 finding: **a comment claiming a protection the code does not actually provide.**

### A1 · `pr-test-analyzer-1` — accepted

`node-context-factory.test.ts:612` integration-tests only the legacy `llmBudgetTokens` scalar through `createNodeContextForDag`. The actual F3 feature — `dag.config.llmBudget` — is threaded through `dag-factory.ts` and read by `ceilingsOf(dag.config)`, but nothing proves the path from "operator writes `llmBudget.usd`" to "the decorator enforces it". `ceilingsOf` and `createMeteredLlm` are each unit-tested; the seam between them is not.

**Fix.** Add an end-to-end case wiring `llmBudget: { usd }` through the factory to a real dollar refusal, on a priced model so the breach is a genuine cost comparison rather than the unpriced fail-closed path.

### A2 · `pr-test-analyzer-2` — accepted

`PersistedFrameworkErrorSchema.safeParse` is never exercised against an `llm-budget-exceeded` payload. The existing tests round-trip through `JSON.stringify`/`parse` via `FrameworkAugmentedError` — never the Zod schema. This change **rewrote that wire schema** (`persistedBreachSchema`, `persistedCeilingSchema`, `PersistedMicroUsdSchema`), so the durable parse boundary a resumed run reads through is untested.

**Fix.** Add `safeParse` coverage for both `Breach` variants plus a malformed-payload rejection, following the `node-crash` pattern already in the file.

### A3 · `type-design-analyzer-1` + `architecture-tech-lead-1` — accepted

Found independently by two reviewers. `LlmBudgetDeclaration`'s own header says the shape lives in one module because "four hand-copied structural declarations is how an axis added later reaches three of them" — and then the type is used **only** as `ceilingsOf`'s parameter. All five sites (`DagRegistrationConfig`, `ResolvedDagRegistration.config`, `ResolvedDagConfig`, `DagRegistrationSchema`, `FugueYamlSchema`) still hand-declare the pair, structurally compatible by coincidence.

The comment describes protection that does not exist. A third axis reaches exactly the scattering it warns about.

**Fix.** `extends LlmBudgetDeclaration` on the three TS interfaces; export `LlmBudgetDeclarationSchema` and merge it into both Zod schemas.

### A4 · `type-design-analyzer-2` — accepted

`Ceilings` is an unbranded structural tuple, so any module can assign an array literal without passing through `ceilings()` — two `tokens` entries, wrong order, unsanitized limits. The module header already concedes it: "this type is only ever produced there" is convention, not compiler.

Accepted for consistency with A3: the codebase already brands `MicroUsd` and the IDs for exactly this, and every construction site already routes through `ceilings()`, so the brand is nearly free. (`reachedBy` independently hardens the *comparison* against a malformed single ceiling; the brand protects the *collection* invariants.)

**Fix.** Brand the tuple; cast once inside the smart constructor.

### A5 · `type-design-analyzer-3` — accepted

`token-usage.ts`'s header claims "Every `TokenUsage` producer routes through [`sanitizeCount`], so the invariant holds at CONSTRUCTION" — and `tokensOnly`, the constructor covering ~60 call sites, does not. Not a live budget bug (`Spend` re-sanitizes independently), but a malformed count reaches `llm.metered` / `llm.call-failed` verbatim, and the header's guarantee is false for the constructor most callers use.

**Fix.** Route both parameters through `sanitizeCount`; pin it.

### A6 · `code-simplifier-2` — accepted

The `leaky` test double's two methods are byte-identical copies. In a test I wrote in this change.

**Fix.** One shared response builder.

### A7 · `code-simplifier-3` — accepted

`writeTtlOf`'s `"5m"` fallback is the fifth hardcoded copy of the same domain default, tied to the four in `cost.ts` only by a comment saying so — the "two representations of one concept, held together by prose" pattern.

**Fix.** Export `DEFAULT_CACHE_TTL` from `cost.ts`; reference it from all five sites.

## Refuted findings

None. The single critical was upheld unanimously.

## Validation

```
bun run typecheck                    # repo root, all packages
cd packages/framework && bun test    # expect ≥ 3296 pass, 0 fail
cd packages/host    && bun run test  # expect 2295 + 10 pass, 0 fail
```

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-08-27-pr39-remediation.md` — this plan
- `packages/framework/src/__tests__/token-usage-property.test.ts` — home for the A5 regression pin

## As applied

All eight planned items landed. Two things happened that the plan did not anticipate.

### An extra fail-open, surfaced by the A1 test

Writing A1 (the `llmBudget.usd` end-to-end case) produced a failing test whose
premise looked right: three $1.00 calls against a $1.50 ceiling, and the third
was **admitted**. The cause was not the wiring under test.

`node-context-factory.test.ts`'s fake client reported `{ tokensIn, tokensOut }`
without the two cache fields. `uncachedInputTokens` subtracted `undefined`, the
cost came out `NaN`, and `usdToMicros` sanitized `NaN` to **zero** — so every
call on a priced model cost $0.00 and no dollar ceiling could ever refuse one.

Sanitizing to zero is correct for a token *count* and wrong for a *cost*,
because zero cost means free. `spendOfCall` now returns `unpriced` when the
computed figure is non-finite: "we could not compute a cost" is the honest
answer, and it is the one that fails closed under a usd ceiling. Pinned in
`prompt-cache-cost.test.ts`; the fixture was separately corrected to report a
complete `TokenUsage`, as both real clients do.

### C1 was briefly re-created while fixing C1

Inserting `DEFAULT_CACHE_TTL` (A7) between the cache-multiplier doc block and
`CACHE_READ_MULTIPLIER` orphaned that block onto the new constant — the same
defect as the critical, introduced by the fix for it, in the same file. Caught
by re-reading the file after the edit; the constant now precedes the block.

### A3 landed slightly wider than planned

The plan proposed `extends LlmBudgetDeclaration` on three interfaces plus a
merged Zod schema. That makes the *types* propagate, but the three merge points
(`applyFugueYaml`, `resolveDefaults`, `dag-factory`) still hand-listed the same
two conditional spreads — which is where a field added later would actually be
dropped. `carryLlmBudget` is now the one carrier all three use, per the
`architecture-tech-lead` recommendation.

## Validation evidence

| Check | Before | After |
|---|---|---|
| Repo typecheck | 0 errors | **0 errors** (12 packages) |
| Framework | 3296 pass / 0 fail | **3305 pass / 0 fail** |
| Host | 2295 + 10 / 0 fail | **2298 + 10 / 0 fail** |

The `Ceilings` brand (A4) proved itself during the change: it immediately
rejected four raw array literals in `budget.test.ts` that had been comparing
against unconstructed tuples.
