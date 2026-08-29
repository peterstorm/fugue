# PR #40 remediation — round 2

**Branch:** `feat/f3-spend-ledger`
**Head at review:** `6b479d2`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-08-27-f3-spend-ledger-round-2`
**Result digest:** `be5ff7c09f84c7392fa4d14769956a0971a067e99055f5340e041e0a604e60e5`

## Adjudicated outcome

| | |
|---|---|
| Surviving criticals | **4 unique** (6 rows; two pairs are the same finding from different reviewers) |
| Refuted | **0** |
| Advisories | **11 unique** |
| Panel | `reproduction`, `intent`, `test-coverage`; threshold 2 |

Round 1 fixed the code. Round 2 found that **three of the four new criticals are the same defect class round 1 was about**: a claim — in a comment, a test fixture, or a doc — asserting a guarantee the code does not provide. Fixing C2's behaviour did not fix the four other places that described the old behaviour.

All seven reviewers independently re-verified round 1's C1–C4 and A1–A10 as genuinely landed, by reading the fix sites rather than trusting the plan's "as applied" notes.

## Surviving criticals

### RC1 · `silent-failure-hunter-1` / `code-simplifier-1` — the required `logger` is never supplied

`packages/host/src/__tests__/spend-ledger.test.ts:73, 220, 242, 256`

Round 1's A1 made `RedisSpendLedgerDeps.logger` **required** so a TTL-refresh failure could never be silently lost. All four test constructions omit it.

Three things had to line up for this to survive: `packages/host/tsconfig.json` excludes `src/__tests__`, so `bun run typecheck` never sees the file; `bun test` does not typecheck; and the fake's `expire` always returns `ok`, so the one branch that dereferences `logger` is unreachable. The panel added a fourth: `logWithoutThrowing` takes `LogPort | undefined` and optional-chains, so even reaching it would **silently no-op** rather than throw.

**I flagged this exact tsconfig gap in PR-C's own commit message as a "test-infrastructure finding" — and then it immediately bit me in the very next commit.**

**Fix.** Supply a logger at all four sites, and add the expire-failure case that A1 exists for (closes advisory `pta-2`).

### RC2 · `silent-failure-hunter-2` / `pr-test-analyzer-1` — C2's fix is exercised by every test and asserted by none

`packages/host/src/adapters/node-context-factory.ts:451`

`createMockRedis()` implements no `hIncrBy`/`hGetAll`/`expire`, so `spendLedgerRedis` returns `err` on **every** `createNodeContextForDag` test. C2's `error` log therefore fires on every run, into a no-op logger, unasserted. And the `ok` branch — the code that actually selects and wires the Redis-backed ledger — is reached by no test anywhere.

This is exactly what C3 was raised for last round, reproduced by C3's own remediation two paragraphs later in the same plan. Nothing would catch a swapped `tenant`/`dagId` into `createRedisSpendLedger`, or `ttlSec` failing to thread through.

**Fix.** A capability-complete `RedisPort` fixture (closes `architecture-tech-lead-1`), assertions on both branches, and a case proving the Redis-backed ledger is actually selected and wired with the right namespace.

### RC3 · `comment-analyzer-1` — the "fails at boot" claim survives in three more places

`packages/host/src/adapters/spend-ledger-redis.ts:41`

Round 1 corrected this false claim in ADR-0083 and nowhere else. It is still asserted by the JSDoc on `SpendLedgerRedis` — the very type the bug was about — and by `spend-ledger.test.ts:195` and the F3 plan's "as built" section (advisories `ca-4`, `ca-6`).

**Fix.** Correct all three to describe the downgrade.

### RC4 · `comment-analyzer-2` — the stated safety direction is backwards

`packages/host/src/domain/spend-record.ts:68`

The doc says a malformed figure means "erring toward MORE spend recorded, never less, because a budget that under-counts is a budget that fails open." `safeFigure` maps non-finite and negative to **zero** — the minimum. The panel traced a concrete path: `micros: "1e999"` or `"corrupt"` → `Infinity`/`NaN` → `0`, i.e. strictly less.

Worse, because `spendOfRecord` is total, this never trips `hydrated.ok === false`, so FR-B-007's fail-closed check does not engage: a budgeted run proceeds believing it has spent nothing.

**Fix.** State the true rationale. Zero is a **bounded** under-report of one field; `NaN` would propagate into every later sum and make `observed >= limit` false forever, disabling the budget on every axis permanently. The bounded loss is chosen over the unbounded one — which is a real argument, and not the one the comment made.

## Advisory dispositions — all 11 accepted

| Finding | Disposition |
|---|---|
| `code-reviewer-1` — C2 log unverified | accept (RC2) |
| `silent-failure-hunter-3` — duplicate of RC4 | accept (RC4) |
| `pr-test-analyzer-2` — A1's ttl-refresh log untested | accept (RC1) |
| `type-design-analyzer-1` / `comment-analyzer-3` — the "ONE list" claim is false | accept — **the code is right and the comment is wrong.** `code-simplifier` argued correctly that the `\|\|` chain is load-bearing: TS cannot narrow from a computed array, and collapsing it would need an assertion the rules discourage. So the guard stays; the comment stops claiming a chokepoint it does not have |
| `type-design-analyzer-2` — `{hydrated:"unknown", limits}` representable | accept — couple the two fields so a budgeted run cannot be metered from a guess |
| `comment-analyzer-4` / `-6` — "fails at boot" in test and plan | accept (RC3) |
| `comment-analyzer-5` — stale `idArb` reference | accept |
| `architecture-tech-lead-1` — no capability-complete fixture | accept (RC2) |
| `code-simplifier-2` — `createNamespacedCache` repeats the report closure | accept — the sibling factory below it already factored exactly this |

## Deferred, with the measurement that justifies it

**`packages/host/tsconfig.json` excluding `src/__tests__`** is the root cause of RC1 and would have caught it at compile time. I measured it rather than guessing: removing the exclude yields **389 errors across 69 files**, of which **exactly 4 are RC1**. Fixing 385 unrelated pre-existing errors is its own PR, not a line item in a ledger remediation.

Recorded here so the next person has the number instead of the intuition.

## Validation

```
bun run typecheck
cd packages/framework && bun test    # expect 3305 pass / 0 fail
cd packages/host    && bun run test  # expect ≥ 2353 + 10 pass / 0 fail
```

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-08-27-pr40-remediation-round-2.md`

## As applied

All four criticals and all eleven advisories landed.

**Where a reviewer was wrong, the code won.** `type-design-analyzer` and
`comment-analyzer` both called the `spendLedgerRedis` guard a duplication that
the "ONE list" comment falsely claimed to have removed. `code-simplifier`
independently disagreed and was right: TypeScript cannot narrow `redis.hIncrBy`
to non-`undefined` from a computed array, so the explicit `||` chain is what
earns the assertion-free return literal. The guard stayed; the comment now says
a fourth primitive costs TWO edits and that the compiler catches a missed guard
at the return statement — which is true, where the previous claim was not.

**tda-2 was worth taking seriously.** `MeteredLlmDeps` is now a union, so
declaring `limits` obliges a KNOWN prior spend. The combination that would
silently meter a budgeted run from zero is no longer constructible, rather than
being merely avoided by control flow at one call site. The factory builds the
correct arm from the fail-closed throw it already performs.

**RC2's Redis-backed test found nothing broken, which is the point.** The new
`capableRedis` fixture proves the `ok` branch selects the Redis ledger AND that
the key it writes is `fugue:eng:test-dag:...$spend` — so a swapped
`tenant`/`dagId` argument into `createRedisSpendLedger`, previously invisible to
every test in the file, now fails loudly.

## Validation evidence

| Check | Before | After |
|---|---|---|
| Repo typecheck | 0 errors | **0 errors** (12/12 packages) |
| Framework | 3305 / 0 fail | **3305 / 0 fail** |
| Host | 2353 + 10 / 0 fail | **2357 + 10 / 0 fail** |
