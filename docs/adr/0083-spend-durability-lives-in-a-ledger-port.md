# ADR-0083: Spend durability lives in a ledger port; Redis appends lock-free

## Status
Accepted

## Date
2026-08-27

## Context

ADR-0082 made the per-run LLM budget mean money instead of tokens. It did not make it survive anything.

`createMeteredLlm` is constructed inside `createNodeContextForDag`, and its meter starts at `emptyMeter()`. The HITL run executor calls that factory **once per execution slice** (`hitl/adapters/run-executor.ts`). So a run that parks for a human decision and resumes comes back with an empty meter: **five parks, six budgets.** A crash-looping run is worse — every restart is a fresh ceiling.

Nothing durable existed to rehydrate from. Usage reaches OTel spans and the `llm.metered` log line, but `types/events.ts` carries no usage at all and `RunMeta` has no spend field. F6 is what made this urgent rather than theoretical: before durable resume, losing the meter meant losing the run too, so the two failure modes were indistinguishable.

The hard part is not storage. It is that spend accrues **per call**, concurrently, from a decorator that may be running several calls at once — while the thing being stored, `Spend`, contains a `PricedSpend` union whose `unpriced` member carries a *set* of model names. A naive durable counter is a read-modify-write, and a read-modify-write under concurrency loses increments.

## Options Considered

1. **A ledger port storing spend as independently-appendable fields**
   - Pros: `Spend`'s monoid is (sum, sum, sum, set-union), and every one of those has an atomic Redis primitive (`HINCRBY`, `SADD`); appends need no lock, no CAS, and no transaction, because each command is individually correct under any interleaving; the storage shape is derived from the value's algebra rather than invented beside it.
   - Cons: the three increments and the set-add are not atomic *together*, so a crash mid-append can record one axis of one call without the others.

2. **Store spend in the checkpoint (`RunMeta`)**
   - Pros: no new port, no new key, no new TTL; resume already reads it.
   - Cons: the checkpoint records **node-terminal state** and is written when a node completes; spend accrues per LLM call, several times inside one node. Writing a checkpoint per call would abuse a store built for a different rhythm, and writing per node would lose everything a long tool loop burned before crashing. Rejected.

3. **Persist spend once per slice, at slice end**
   - Pros: two round trips per slice instead of two per call; no concurrency question at all.
   - Cons: a crash mid-slice loses the *entire slice's* spend, which is precisely the crash-loop case the budget most needs to survive. It fixes park/resume and leaves the worse hole open. Rejected.

4. **A transactional append (`MULTI`/`WATCH`)**
   - Pros: the four fields move together, so a partial record is impossible.
   - Cons: buys exactness at the price of a round trip on every call plus a retry loop, and introduces a half-applied-transaction failure mode that is harder to reason about than the partial write it prevents. The partial write is bounded and directional (see below); this is not obviously better and is definitely more machinery. Rejected.

5. **Fail the slice OPEN when the ledger cannot be read** (assume zero)
   - Pros: a Redis outage never stops a run.
   - Cons: "we could not read what this run has spent" and "this run has spent nothing" become the same thing — which IS the refill-on-resume bug, deliberately reintroduced and now triggerable by an outage. Rejected for budgeted runs; accepted for unbudgeted ones, where there is no ceiling to protect and failing would turn a metering outage into an availability outage.

## Decision

**A `SpendLedgerPort` with two operations: hydrate once per slice, append once per settled call.**

```ts
type SpendLedgerPort = {
  read: (runId: RunId) => Promise<Result<Spend, HostError>>;
  add:  (runId: RunId, delta: Spend) => Promise<Result<void, HostError>>;
};
```

**The encoding is chosen so that appending IS `addSpend`.** `domain/spend-record.ts` flattens a `Spend` to three numeric sums plus a set of model names, and the `priced`/`unpriced` discriminant is **derived from the set's emptiness** rather than stored beside it — a stored discriminant could contradict the set it describes. Redis then gets `HINCRBY` ×3 and `SADD`, all atomic and commutative, so concurrent appends cannot lose an increment or corrupt the record. No lock, no CAS, no transaction.

**`add` returns nothing.** The in-process meter already knows the run's figure, and a total assembled from several independent atomic commands could disagree with a concurrent writer's view — nothing would be able to trust it.

**Reads fail closed under a declared budget, open without one.** An unreadable ledger refuses a *budgeted* slice at context construction; an unbudgeted one logs and meters from zero.

**Write failures never fail the call.** The provider has already run and the tokens are already spent; refusing the result would waste them and lose the output too. What is lost is durability, so it is logged at `error` under a declared budget and `warn` without one.

**Three adapters.** Redis for distributed durability; file for the F6 single-writer file runtime; in-process for a single-process deployment, where it still carries spend across the slices of one process and is documented as not surviving a restart.

The file adapter is deliberately split at the ownership seam. The framework's
high-level `createFileSpendStore` owns F6 locking, verified-directory checks,
digest addressing, strict V1 parsing, and atomic rename. The host's
`createFileSpendLedger(root)` only translates `FrameworkError` into the
`spend-ledger-unavailable` HostError and satisfies `SpendLedgerPort`. It stores:

```text
<root>/<sha256(runId)>.json
<root>/<sha256(runId)>.lock/        # transient owner
<root>/<sha256(runId)>.lock.fence/  # lock protocol metadata
```

Unlike Redis's independently atomic field algebra, file `add` takes the per-run
F6 lock, strictly reads the prior complete snapshot, folds `addSpend`, and
atomically renames one replacement record. Lock-free reads therefore observe
either the complete prior snapshot or the complete next snapshot. Corruption,
non-integer/negative figures, crossed embedded run IDs, and symlink substitution
are typed failures, never zero. No adapter retries `add`: its additive contract
cannot distinguish a lost acknowledgement from a lost commit, so a blind retry
could double-count.

## Consequences

- The park/resume hole is closed. A run that parks with 45 of a 40-token budget spent resumes already over and refuses immediately, and there is a test that fails without the ledger.
- **The "zero network round trips" claim in `metered-llm.ts` is now false as stated and has been restated rather than deleted.** The ADMISSION decision still adds none — it is a pure comparison against a counter hydrated once per slice. The SETTLE path adds one append per call, sequenced after a call that already cost seconds. The guarantee that mattered (an LLM call is never delayed by budget bookkeeping *before* it is made) is unchanged.
- **Loss window: one call.** A crash between a provider call settling and its append loses that call's spend — the same magnitude as the documented overshoot-by-one allowance, and for the same structural reason: the record is written after the fact it records.
- **Partial-append window: one axis of one call**, and directional. The order is cost-first, so if the process dies mid-append the axis most likely to be under a tight ceiling is the one already recorded. A partial record always UNDER-reports; it never over-reports and never corrupts.
- `RedisPort` gained `hIncrBy`, `hGetAll`, and `expire`. All three are generic Redis primitives rather than domain-shaped methods, and none is on the per-tenant ACL's denied list. The ledger parses them once at construction (`spendLedgerRedis`), so the missing-primitive case is detected in one place rather than null-checked per call.
- **An adapter that cannot increment DOWNGRADES; it does not refuse.** `createNodeContextForDag` falls back to the in-process ledger, because refusing every run over a metering capability would turn a configuration gap into an outage. The downgrade is logged at `error` naming the missing primitives and the consequence (`per-run LLM budgets reset when this process restarts`), which is the only place that fact exists — an earlier draft of this ADR claimed the host "fails at boot", which was never what the code did.
- **Spend keys are spelled `$spend` / `$spend:unpriced`, and the `$` is load-bearing.** They share `checkpointKeyPrefix` with `buildCheckpointKey`, whose final segment is a caller-supplied `NodeId` — and `ID_PATTERN` admits the literal `spend`. A plain segment collided with the checkpoint of a node named `spend`, letting the checkpoint writer's `SET` destroy the ledger's `HASH` (Redis `SET` is type-agnostic), which silently zeroed a run's recorded spend and then permanently refused every later slice of a budgeted run on `WRONGTYPE`. `$` is outside `ID_PATTERN`, the same technique `DAG_INPUT = "$input"` uses, and `cache-keys.test.ts` proves the disjointness over arbitrary node ids rather than trusting a comment. **Any future key added beneath the checkpoint prefix inherits this constraint.**
- Spend keys live under the same `fugue:<tenant>:` prefix as every other key, so the per-tenant ACL scopes them unchanged. Their TTL follows the checkpoint TTL and is refreshed on every append, so it measures idleness rather than age. **No configured checkpoint TTL means no spend expiry** — a record that expired while its checkpoint survived would resume the run with a refilled budget.
- One Run Spend Authority now owns the slice's meter and reservations. The main client, `judgeLlm`, and every boot-scoped capability-bag client explicitly marked `clientKind: "llm"` delegate to it, so client choice cannot bypass the ceiling.
- The file adapter closes F6 restart durability without changing stock selection: the stock host remains Redis-first with its in-process fallback; a file-runtime embedder explicitly injects `createFileSpendLedger(root)` as `SharedInfra.spendLedger`.
- File roots and retention are embedder-owned. No backend selector is inferred from `DAGS_LOCAL_PATH`, and no fsync/network-filesystem guarantee is claimed.

## Related

- ADR-0082 — budgets denominated in spend (what this makes durable)
- ADR-0060 — durable HITL suspend/resume (the per-slice NodeContext this works around)
- ADR-0078 — journal single-writer contract (the file-adapter shape, when it lands)
- `docs/plans/2026-08-27-f3-budget-capability.md` §D3 — the plan this implements, and where it deviates
