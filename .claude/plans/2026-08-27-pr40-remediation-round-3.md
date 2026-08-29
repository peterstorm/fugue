# PR #40 remediation — round 3

**Branch:** `feat/f3-spend-ledger`
**Head at review:** `2329036`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-08-27-f3-spend-ledger-round-3`
**Result digest:** `80514635470a07acd9a98b91aa7bf85792ef0e5e51d8910d746244c8de9ed407`

## Adjudicated outcome

| | |
|---|---|
| Surviving criticals | **0** |
| Refuted | 0 |
| Advisories | **9 unique** (11 rows) |
| Panel | **did not run** — the engine routes only a non-empty critical set through it |

**Criticals across the three rounds: 4 → 4 → 0.**

Four of seven reviewers returned entirely clean (`code-reviewer`, `type-design-analyzer`, `comment-analyzer`, and `architecture-tech-lead` with only a restated deferral). Each independently re-verified rounds 1 and 2 by reading the fix sites rather than trusting the plans' "as applied" notes — `comment-analyzer` grepped all 25 files to confirm no occurrence of the "fails at boot" claim survives anywhere.

The character of the findings changed completely. Round 1 found a data-corrupting key collision; round 2 found stale claims and untested log lines; round 3 found **one real test defect and eight pieces of test-fixture duplication**. That is what converged looks like.

## The one finding that is a defect rather than tidying

### A1 · `pr-test-analyzer-1` (+ `code-reviewer`, below its own bar) — a tautological assertion

`packages/host/src/__tests__/node-context-factory.test.ts:1266`

```ts
expect((await shared.spendLedger.read(testRunId)).ok && (await shared.spendLedger.read(testRunId)).ok).toBe(true);
```

I wrote this in round 2 to prove spend reached Redis "not the SharedInfra fallback". It proves nothing: `createInMemorySpendLedger().read()` never returns `err`, so `.ok && .ok` is `true` regardless of which ledger was written.

Two reviewers found it independently; `code-reviewer` rated it ~30 confidence and reported it as a sub-threshold observation rather than a finding, which is the right call given the test's *other* assertions (`capable.seen.length`, the `$spend` key prefix) do carry the proof.

**Accept.** Assert what was actually meant: the fallback ledger holds `NO_SPEND`, because the write went elsewhere.

## Advisory dispositions — 7 accepted, 2 deferred

| Finding | Disposition |
|---|---|
| `pr-test-analyzer-1` — tautological assertion | **accept** (above) |
| `silent-failure-hunter-1` — the unreadable-ledger `warn` is unasserted | **accept** — every other diagnostic in this feature is now pinned; this is the last one, and it is the fail-open branch of FR-B-007 |
| `code-simplifier-1` — `ledger`/`hydrated` boilerplate repeated ~36× | **accept** — I threaded two required fields through an existing suite by hand; a default builder is what should have absorbed that |
| `code-simplifier-2` — three `SharedInfra` literals ignore `baseSharedInfra` | **accept** — the file's own fixture exists to prevent exactly this, and its header says so |
| `code-simplifier-3` — `fakeLlm`/`structuredReq` defined three times | **accept** — I added the third copy in round 2, in a file whose comment already flagged the duplication once |
| `code-simplifier-4` — the two-armed `createMeteredLlm` recomputes one ternary | **accept** — hoist it |
| `code-simplifier-5` — repeated four-statement ledger setup | **accept** — one helper |
| `architecture-tech-lead-1` — extract the ledger resolution out of the factory | **defer** — the reviewer explicitly restates round 1's `atl-1` at the same 78–80% confidence and says so: *"not a new discovery… restated as advisory rather than re-litigated as if new."* The reason for deferring has not changed: it is an interface change to a 550-line shell touching three unrelated features. It is now recorded twice, which is the right way for it to graduate into its own session |
| `code-simplifier-6` — `setIfValue`/`setIfValues` duplicate a watch/compare loop | **defer** — pre-existing, in `redis-connectivity`'s transaction helpers, untouched by this feature. Collapsing two concurrency-sensitive Redis transaction paths is not a line item in a ledger PR |

## Validation

```
bun run typecheck
cd packages/framework && bun test    # expect 3305 pass / 0 fail
cd packages/host    && bun run test  # expect ≥ 2357 + 10 pass / 0 fail
```

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-08-27-pr40-remediation-round-3.md`

## As applied

The one defect and all six accepted tidying findings landed.

**The tautological assertion now asserts the thing it was named for.** It reads
the fallback ledger's VALUE and requires `NO_SPEND` — which is what
distinguishes the two backends, where `.ok` never could. Verified non-vacuous:
the in-memory ledger genuinely holds nothing because every append went to Redis.

**The unreadable-ledger warn was the last unasserted diagnostic in this
feature.** Rounds 1-3 have now pinned every one of them: the metering line, the
budget refusal, `llm.ledger-write-failed` (both severities),
`spend-ledger.ttl-refresh-failed`, the "NOT durable" downgrade, and now
"Spend ledger unreadable". Nothing this feature logs is unverified.

**The test duplication was self-inflicted and is gone.** `ledger`/`hydrated`
became required fields and I threaded them through ~35 pre-existing cases by
hand; `freshLedger()` absorbs that. `fakeLlm`/`structuredReq` had reached three
byte-identical copies — I added the third myself in round 2, in a file whose own
fixture comment already flagged the duplication. Both now exist once at file
scope, and the four `SharedInfra` builders spread `baseSharedInfra()` rather
than re-declaring it, which is what that fixture was built for.

## Validation evidence

| Check | Before | After |
|---|---|---|
| Repo typecheck | 0 errors | **0 errors** (12/12 packages) |
| Framework | 3305 / 0 fail | **3305 / 0 fail** |
| Host | 2357 + 10 / 0 fail | **2357 + 10 / 0 fail** |

Test count is unchanged, which is correct: this round fixed one assertion,
added one, and deleted duplication without removing coverage.
