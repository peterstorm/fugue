# PR #40 remediation — F3 spend ledger

**Branch:** `feat/f3-spend-ledger`
**Head at review:** `7d8f665`
**Review run:** `.claude/reviews/review-and-fix-runs/2026-08-27-f3-spend-ledger`
**Result digest:** `7748b09ead264c498f226773ba3db8d1975825be1bd1ca63780da6f98189b6cc`

## Adjudicated outcome

| | |
|---|---|
| Reviewers | 7 |
| Surviving criticals | **4 unique** (5 rows; `silent-failure-hunter-1`/`-4` are the same finding) |
| Refuted criticals | **0** |
| Advisories | 18 rows → **12 unique** |
| Panel | 3 lenses, threshold 2 — **every critical upheld 3–0** |

This is the sharpest review of the three. The panel did not merely confirm the findings; on C2 it produced a **concrete in-repo trigger the reviewer had not identified** (`createInMemoryRedisFake` in `supervisor/registry/redis-registry-adapter.ts` implements `RedisPort` without the three new primitives), turning a hypothetical into a reproducible path.

## Surviving criticals — all mandatory

### C1 · `code-reviewer-1` — spend keys collide with a checkpoint key

`packages/host/src/domain/cache-keys.ts:91`

`buildSpendKey` is `checkpointKeyPrefix(...) + "spend"`. `buildCheckpointKey` is `checkpointKeyPrefix(...) + nodeId`. `ID_PATTERN` admits the literal `spend` as a node id, and **nothing reserves it** — unlike `DAG_INPUT = "$input"`, which is deliberately spelled outside `ID_PATTERN` for exactly this reason.

So a DAG with a node named `spend` — a *completely natural name in the domain this PR adds* — makes the checkpoint writer's `SET` land on the ledger's `HASH`. Redis `SET` is type-agnostic and destroys it. Every later `HINCRBY`/`HGETALL` returns `WRONGTYPE`, and for a budgeted run `createNodeContextForDag` then throws on every subsequent slice: **the run is permanently bricked**. For an unbudgeted run it silently meters from zero — the refill-on-resume bug this PR exists to close, reintroduced.

**Panel 3–0.** *reproduction* traced it to `run-node.ts:258` writing a checkpoint for every node; *blast-radius* confirmed both the corruption and the bricking, noting the key has no TTL when `checkpointTtlMs` is unset.

**Mine.** I reused `checkpointKeyPrefix` and appended a plain word into a namespace whose whole grammar is caller-supplied node ids.

**Fix.** Spell the segment `$spend` — `$` is rejected by `ID_PATTERN`, so no valid `NodeId` can ever produce it — and add a property test proving disjointness from `buildCheckpointKey` over arbitrary valid node ids (this also closes A3).

### C2 · `silent-failure-hunter-1`/`-4` — silent downgrade to a non-durable ledger

`packages/host/src/adapters/node-context-factory.ts:444`

```ts
const spendLedger = ledgerRedis.ok ? createRedisSpendLedger({...}) : shared.spendLedger;
```

A bare ternary. `spendLedgerRedis`'s error — which carries the exact message naming the missing primitives — is **discarded**, and durable cross-process spend is silently replaced by a process-local map. The adjacent unreadable-ledger branch *does* log, which makes the asymmetry an oversight rather than a policy.

Worse, ADR-0083 line 68 claims this construction exists so "a host wired with a Redis adapter that cannot increment **fails at boot with a clear message naming what is missing**." The *intent* lens caught that the promised message is never emitted anywhere: `spendLedgerRedis` has no other call site. **My ADR describes behaviour my code does not have.**

**Panel 3–0**, with the in-repo trigger above.

**Fix.** Log at `error` before falling back, naming the missing primitives; state the fallback in the ADR as what it actually is.

### C3 · `pr-test-analyzer-1` — the ledger-write-failed log is untested

`packages/host/src/adapters/metered-llm.ts:243`

`llm.ledger-write-failed` and its documented `error`-under-budget / `warn`-without split appear in exactly one place in the repo: the production line. Zero test hits. The one test that drives a failing append asserts only that the call still succeeds, and its own comment says "that is what gets logged" — without ever looking at the logger.

**Fix.** Assert the line, its payload, and both severity branches.

### C4 · `comment-analyzer-1` — orphaned JSDoc with `@satisfies` tags

`packages/host/src/adapters/node-context-factory.ts:67`

The `createNamespacedCache` doc block — carrying `@satisfies FR-013`/`FR-041` traceability — sits above the unrelated `reportWithoutThrowing`, while the real `createNamespacedCache` at line 132 has no doc at all.

**Not mine** — verified present on `main` at `274cadb`, so it predates this branch. Still a surviving critical in the frozen scope, and mandatory. The third such orphan across three PRs, which is itself the signal: this file's helpers get reordered without their comments.

**Fix.** Move the block onto the function it describes.

## Advisory dispositions — 10 accepted, 2 deferred

| # | Finding | Disposition |
|---|---|---|
| A1 | `sfh-2` — `expire`'s `Result` discarded twice; no logger on `RedisSpendLedgerDeps` | **accept** — a TTL that stops being refreshed silently re-opens the refill bug, and the adapter is structurally unable to report it |
| A2 | `sfh-3` — `reportWithoutThrowing` has no `console` fallback | **defer** — pre-existing, and it changes a shared diagnostic helper used by the cache/checkpoint paths; a behaviour change to every consumer does not belong in a ledger PR |
| A3 | `pta-2` — spend builders missing from `cache-keys.test.ts`'s "every builder" security suite | **accept** — same fix site as C1, and that suite is the file's exhaustiveness contract |
| A4 | `pta-3` — `hIncrBy`/`hGetAll`/`expire` untested in `redis-connectivity.test.ts` | **accept** — I added three primitives to a port whose every other method is unit-tested there, including `expire`'s 1/0→boolean coercion |
| A5 | `tda-1` — `SharedInfra.spendLedger` doc omits that it is a fallback | **accept** — one comment, and C2's fix makes the fallback explicit anyway |
| A6 | `tda-2` — `spend-record.ts` header claims both adapters share the encoding; the in-memory one never imports it | **accept** — a comment asserting a structural guarantee that does not hold is the exact class C4 and the last two PRs' criticals belong to |
| A7 | `tda-3` — clamp predicate defined twice | **accept** — one definition site |
| A8 | `tda-4` — `spendLedgerRedis` restates the required-field check three times | **accept** — one declarative list |
| A9 | `tda-5` — `hydrated?: Spend` conflates "fresh run" and "unknown spend" | **accept** — cheap, and the two states genuinely differ once anything but the admission check reads it |
| A10 | `ca-2` — plan doc's `PricedSpend` snippet predates the shipped type | **accept** — one-line doc correction |
| A11 | `atl-1` — extract the three fail-closed checks into a pure policy function | **defer** — the reviewer names it `deepen` territory and rates 80%; it is an interface change to a 550-line shell touching three unrelated features, and the new check *follows* the existing convention rather than breaking it. Worth its own session |
| A12 | `cs-1` — redundant regex alternation in a test | **accept** — trivial |

## Refuted findings

None. All four criticals were upheld unanimously across all three lenses.

## Validation

```
bun run typecheck
cd packages/framework && bun test    # expect 3305 pass / 0 fail
cd packages/host    && bun run test  # expect ≥ 2335 + 10 pass / 0 fail
```

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-08-27-pr40-remediation.md`
- `packages/host/src/__tests__/domain/cache-keys.test.ts` — C1's disjointness proof / A3
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts` — A4

## As applied

All four criticals and all ten accepted advisories landed. Two notes.

### C1's property test needed its own arbitraries, and the first version was wrong

The disjointness property initially generated node ids from an alphabet
including `:` and reused it for the tenant/dag/run positions too. `DAG_ID_REGEX`
rejects `:` outright — that restriction is why dagIds are safe in Redis key
namespaces at all — so `dagId(":0")` threw and the property failed on a
counterexample that was about the *test*, not the code. The node-id position now
uses the full `ID_PATTERN` alphabet (which is where `:` matters, since
`spend:unpriced` is one of the two colliding names) and the other three keep the
colon-free alphabet their constructors require.

### C2 exposed a false claim in ADR-0083, not just a missing log

The *intent* lens caught something the reviewer's own report had only implied:
ADR-0083 stated that `spendLedgerRedis` exists so a host with an incapable Redis
adapter "fails at boot with a clear message naming what is missing." The code
never did that — it downgraded silently. Adding the log fixes half of it; the
ADR now says what the code actually does (**downgrade, loudly**, because
refusing every run over a metering capability would turn a configuration gap
into an outage). The ADR also now records the `$`-prefix constraint from C1 as
binding on any future key added beneath the checkpoint prefix.

## Validation evidence

| Check | Before | After |
|---|---|---|
| Repo typecheck | 0 errors | **0 errors** (12/12 packages) |
| Framework | 3305 / 0 fail | **3305 / 0 fail** |
| Host | 2335 + 10 / 0 fail | **2353 + 10 / 0 fail** |
