# PR #41 remediation — review-and-fix round 9

Date: 2026-08-30

Branch: `feat/f3-budget-capability-surface`

Reviewed revision: `3088a7d8c4224d181ee9cc9487193bcf62348690`

Review run: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round9`

Authoritative result: `.claude/reviews/review-and-fix-runs/2026-08-30-pr41-review-and-fix-round9/result.json`

Frozen scope: the 89 paths listed in the authoritative result.

Anticipated support paths outside that scope:

- `.claude/plans/2026-08-30-pr41-remediation-round9.md` — this disposition and validation record.
- `packages/host/src/adapters/redis-connectivity.ts` — production implementation of the complete atomic Redis spend append.
- `packages/host/src/adapters/__tests__/redis-connectivity.test.ts` — regression coverage for the production Redis transaction adapter.
- `packages/host/src/domain/spend-record.ts` — one shared strict hash-field vocabulary for the transactional writer and ledger reader.
- `packages/host/src/__tests__/spend-record.test.ts` — focused one-hash codec and malformed-field properties.
- `packages/host/src/domain/cache-keys.ts` — remove the now-unused second spend-key helper.
- `packages/host/src/__tests__/domain/cache-keys.test.ts` — retain one-key namespace-disjointness coverage.
- `packages/framework/src/llm/cost.ts` — deeply frozen readonly framework pricing authority.
- `packages/framework/src/__tests__/cost.test.ts` — pricing-authority mutation resistance regression.
- `docs/adr/README.md` — ADR index wording synchronized with ADR-0083's accepted one-hash transaction decision.

## Binding approach

Apply `rules/architecture.md`, `rules/typescript-patterns.md`, `code-implementer`, `ts-test-engineer`, and `security-expert`: unknown model pricing under a USD ceiling is refused before provider egress; the complete Redis spend append runs through one atomic consumer-owned port operation; throwing adapters are fenced at their Result-returning seams; and HTTP error discriminants are accepted only from the framework's closed vocabulary. Preserve immutable ADTs, fail-closed budget behavior, and the existing Redis ACL restriction against Lua by using `MULTI/EXEC`, not `EVAL`. Run `distill` in apply mode only after a green focused baseline.

## Surviving critical findings — mandatory

1. **`code-reviewer-1` — independently refreshed Redis TTLs can erase unpriced evidence while numeric spend survives.**
   - First remediation used a hash+set transaction, but the surviving second correction identified the split-key read/expiry race.
   - Final correction uses ONE hash: reserved `$unpriced:<encoded-model>` marker fields first, nonzero `HINCRBY` fields cost-first (`micros`, `tokens`, `calls`), then ONE `EXPIRE` on that hash.
   - Hydration performs ONE `HGETALL`; strict parsing rejects every unknown/malformed field/value and every present numeric value that is not a canonical non-negative safe integer.
   - Production connectivity inspects every EXEC result, uses no Lua, sets `autoResendUnfulfilledCommands: false`, and never retries/replays an ambiguously acknowledged additive append.
   - Regressions pin no second read/key, exact transaction order, malformed-hash refusal, and no driver replay.

2. **`pr-test-analyzer-1` — the unpriced USD test codifies first-call provider egress.**
   - Before admission/reservation, detect a USD ceiling combined with a model absent from the framework `PRICE_TABLE` using an own-property check.
   - Return an `llm-budget-exceeded` unpriced breach naming that model before calling the provider; log through the same budget-exceeded diagnostic path.
   - Token/call-only ceilings remain evaluable and continue to permit unpriced models.
   - Correct the regression to require zero provider calls on the first refused request for both standard LLM operations where practical.

3. **`comment-analyzer-1` — metered LLM header conflates sequential crossing with SC-003.**
   - Attribute the sequential crossing-call allowance to FR-W1-004 and learned concurrent reservation accounting to SC-003; explicitly avoid a one-call claim for cold/larger bursts.

4. **`comment-analyzer-2` — shipped plan claims a one-call crash-loss window.**
   - Replace the claim with the current ADR-0083 contract: every concurrently settled append still pending at process death can be lost; aggregate crash loss is not bounded to one call.

## Advisory dispositions

### Accepted

1. **`code-reviewer-2` — arbitrary `frameworkErrorKind` reflection.**
   - Add/reuse a total closed-vocabulary `FrameworkErrorKind` guard exported by the framework.
   - Only reflect a proven framework kind; malformed/accessor-backed/off-union markers take the logged generic 500 path.
   - Add HTTP non-reflection regressions.

2. **`silent-failure-hunter-1` — thrown Redis TTL refresh misreported as append loss.**
   - Superseded by the complete append transaction above. Because the operation cannot distinguish committed values from failed expiry after ambiguous acknowledgement, typed and thrown transaction failures are one append failure; the separate TTL-warning advisory does not apply.

3. **`silent-failure-hunter-2` — checkpoint `redis.set` throws bypass escalation diagnostics.**
   - Fence the checkpoint write call, route thrown failures through the same `writeFailures.failed` contextual escalation path, and throw a contextual checkpoint failure for the outer typed boundary.
   - Add threshold/context regression coverage.

4. **`type-design-analyzer-1` — detached Redis methods lose receivers.**
   - Bind every method copied into `SpendLedgerRedis` to the source Redis object; add a receiver-dependent adapter regression.

5. **`type-design-analyzer-2` — HostError smart constructors return mutable records.**
   - Freeze each exported first-party HostError smart-constructor result; defensively freeze copied context where the constructor owns a structural context snapshot.
   - Add immutability regressions without changing the public union.

6. **`comment-analyzer-3` — shipped plan maps sequential crossing to SC-003.**
   - Map sequential crossing to FR-W1-004 and reserve SC-003 for learned concurrent reservations.

7. **`comment-analyzer-4` — repeated model append called a total no-op.**
   - State that repetition is a no-op only for the unpriced-model set; token/call figures still append.

8. **`architecture-tech-lead-3` — RunSpendAuthority rethrows LLM adapter contract violations.**
   - Convert a thrown/rejected inner LLM call into a non-retriable typed `node-crash` carrying the request node and safe message; return it through the normal settlement/logging Result path and release the reservation exactly once.
   - Preserve metering of typed Err values that carry partial usage.

9. **`code-simplifier-1` — redundant framework barrel exports.**
   - Remove only type/broker exports already supplied by the leading types barrel; retain unique helper exports and verify public import typechecks.

10. **`code-simplifier-2` — repeated full NodeContext fixture.**
    - Use the existing `testNodeContext` helper in `llm-retry.test.ts`, overriding only behavior under test.

11. **`code-simplifier-3` — duplicated throwing-inner LLM tests.**
    - Table-drive both operations through one shared behavioral assertion while strengthening the expected outcome from rejection to typed non-retriable Err.

### Deferred

1. **`architecture-tech-lead-1` — typed `createNodeContextForDag` Result seam.**
   - Requires coordinated HostError taxonomy, HTTP, HITL, host composition, factory, and integration-test migration. A partial dual exception/Result taxonomy would weaken the seam.

2. **`architecture-tech-lead-2` — capability lifecycle I/O split.**
   - Requires a dedicated module/import/composition/test migration across boot, health, shutdown, and capability extraction. Keep it as one coordinated deepening rather than moving selected functions during a budget-integrity remediation.

## Refuted critical audit

No critical finding was refuted. `comment-analyzer-1` was challenged by the intent lens because the detailed plan separately describes sequential and concurrent behavior, but it survived reproduction and test-coverage review: the test-file header still maps the shorthand to SC-003 and conflicts with the current explicit concurrent-burst tests.

## Second correction disposition

The follow-up review is mandatory and supersedes the round-9 hash+set encoding:

1. Redis Spend Record is one hash and one `HGETALL`; marker fields and numeric axes share one transaction/TTL. Strict parsing fails closed on unknown or malformed controlled fields/values.
2. ioredis construction disables `autoResendUnfulfilledCommands`; no layer retries or replays additive `EXEC` after acknowledgement loss.
3. Framework `PRICE_TABLE` is readonly and deeply frozen at definition; pre-call `RunSpendAuthority` and `spendOfCall` share it.
4. Checkpoint Redis failures retain full key/driver diagnostics only in guarded server logs; the thrown boundary message is fixed and non-identifying for both thrown and typed set failures.
5. `internalInvariantViolated` deeply snapshots/freezes nested context. Cyclic, accessor-hostile, or over-depth input produces a frozen fixed fallback and retains no caller object.

## Validation

Focused validation:

```bash
bun test \
  packages/host/src/__tests__/spend-record.test.ts \
  packages/host/src/__tests__/spend-ledger.test.ts \
  packages/host/src/__tests__/domain/cache-keys.test.ts \
  packages/host/src/adapters/__tests__/redis-connectivity.test.ts \
  packages/host/src/__tests__/metered-llm.test.ts \
  packages/host/src/__tests__/node-context-factory.test.ts \
  packages/host/src/__tests__/middleware/error-handler.test.ts \
  packages/host/src/__tests__/host-error.test.ts \
  packages/framework/src/__tests__/cost.test.ts \
  packages/framework/src/__tests__/errors.test.ts \
  packages/framework/src/__tests__/llm-retry.test.ts
bun run typecheck
bun run check:docs
git diff --check
git diff --no-index --check /dev/null .claude/plans/2026-08-30-pr41-remediation-round9.md
```

Then run the full workspace suite:

```bash
bun run test
```

After a green baseline, run mandatory `distill` apply mode one move at a time and rerun each covering suite. Start registered remediation only after all validation is green; register every actual path outside frozen scope. Loom must install the exact verified index before commit and push.
