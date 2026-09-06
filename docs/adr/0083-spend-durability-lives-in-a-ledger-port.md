# ADR-0083: Spend durability lives in a ledger port; Redis appends transactionally

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

1. **A ledger port storing spend across a hash plus set**
   - Pros: `Spend`'s monoid is (sum, sum, sum, set-union), mapped directly to `HINCRBY` and `SADD`.
   - Cons: the two keys cannot be read as one snapshot. Independent expiry can erase unpriced evidence while numeric spend survives, and `HGETALL` followed by `SMEMBERS` has an expiry-between-reads race even if writes use one transaction. Rejected.

2. **Store spend in the checkpoint (`RunMeta`)**
   - Pros: no new port, no new key, no new TTL; resume already reads it.
   - Cons: the checkpoint records **node-terminal state** and is written when a node completes; spend accrues per LLM call, several times inside one node. Writing a checkpoint per call would abuse a store built for a different rhythm, and writing per node would lose everything a long tool loop burned before crashing. Rejected.

3. **Persist spend once per slice, at slice end**
   - Pros: two round trips per slice instead of two per call; no concurrency question at all.
   - Cons: a crash mid-slice loses the *entire slice's* spend, which is precisely the crash-loop case the budget most needs to survive. It fixes park/resume and leaves the worse hole open. Rejected.

4. **One-hash optimistic saturating append (`WATCH`/`HGET`/`MULTI`/`EXEC`)**
   - Pros: reserved marker fields, numeric fields, and one retention deadline share one aggregate key. The transaction computes each axis with the same safe-integer saturation as `addSpend`, so durable Redis state remains readable after cumulative overflow. Marker union and all numeric replacements commit together; hydration remains one `HGETALL`.
   - Cons: one optimistic transaction per delegated LLM attempt, with three field reads and conflict retries. Only an `EXEC null` is retried because Redis proves it did not commit; a thrown/lost acknowledgement remains ambiguous and is never replayed. **Selected.**

5. **Fail the slice OPEN when the ledger cannot be read** (assume zero)
   - Pros: a Redis outage never stops a run.
   - Cons: "we could not read what this run has spent" and "this run has spent nothing" become the same thing — which IS the refill-on-resume bug, deliberately reintroduced and now triggerable by an outage. Rejected for budgeted runs; accepted for unbudgeted ones, where there is no ceiling to protect and failing would turn a metering outage into an availability outage.

## Decision

**A `SpendLedgerPort` with two operations: hydrate once per slice, append once per delegated LLM attempt settled by the authority.**

Every delegated attempt consumes the `calls` axis, including typed failures, malformed returns, and throws. When no trustworthy usage exists it contributes one call plus a durable `unknown` usage marker; known token and USD figures remain lower bounds. A call-only ceiling remains evaluable, while token/USD ceilings fail closed before another provider attempt. Malformed runtime `Result` values are parsed at the authority shell and returned as typed non-retriable `node-crash` errors after settlement.

```ts
type SpendLedgerPort = {
  read: (runId: RunId) => Promise<Result<Spend, HostError>>;
  add:  (runId: RunId, delta: Spend) => Promise<Result<void, HostError>>;
};
```

**The encoding preserves `addSpend`'s saturating commutative axes across the full safe-integer domain.** `domain/spend-record.ts` flattens a `Spend` into ONE Redis hash: three established numeric fields plus reserved `$usage:unknown` and `$unpriced:<canonical-encoded-model>` fields whose value is exactly `1`. Usage uncertainty and the `priced`/`unpriced` discriminant are **derived from marker-field presence** rather than stored as mutable tags. The adapter watches the aggregate hash, reads the three numeric fields, computes each replacement with the same `Number.MAX_SAFE_INTEGER` saturation as the in-process monoid, then queues marker `HSET`s first, nonzero numeric `HSET`s cost-first (`micros`, `tokens`, `calls`), and one optional `EXPIRE`. Every `MULTI`/`EXEC` sharing that command connection — including checkpoint/spend-retention commits that do not themselves WATCH — enters the same local serializer, because any EXEC on the connection can consume its connection-scoped WATCH state. Cross-process writers remain concurrent: `EXEC null` proves one won and safely retries from a fresh read. Any thrown or lost acknowledgement remains a typed ambiguous failure and is never replayed. No Lua, second key, or split hydration read is used.

**`add` returns nothing.** The in-process meter already knows the run's figure, and the durability port only acknowledges whether the append transaction was observed as successful. Returning a total would add an unused read-model contract to a write seam and still could not resolve a lost acknowledgement.

**Reads fail closed under a declared budget, open without one.** An unreadable ledger refuses a *budgeted* slice at context construction; an unbudgeted one logs and meters from zero.

**Write failures stop budgeted execution.** The provider has already run, so the in-process authority still settles the attempt exactly once and never retries the ambiguous additive write. But returning success under a declared budget would allow a later slice to hydrate stale spend, so an unacknowledged append returns a typed non-retriable node failure. Unbudgeted execution preserves the provider outcome and logs at `warn`, because no ceiling depends on durable accounting.

**Three adapters.** Redis for distributed durability; file for the F6 single-writer file runtime; in-process for a single-process deployment, where it still carries spend across the slices of one process and is documented as not surviving a restart. Every adapter carries closed backend/durability/role metadata. Stock memory is `redis-fallback`; file and Redis are restart-durable `authoritative` bindings.

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

Unlike Redis's atomic additive transaction, file `add` takes the per-run F6
lock, strictly reads the prior complete snapshot, folds `addSpend`, and
atomically renames one replacement record. Lock-free reads therefore observe
either the complete prior snapshot or the complete next snapshot. Corruption,
non-integer/negative figures, crossed embedded run IDs, and symlink substitution
are typed failures, never zero. No adapter retries `add`: its additive contract cannot distinguish a lost acknowledgement from a lost commit, so a blind retry could double-count. Production ioredis construction also sets `autoResendUnfulfilledCommands: false`; an unfulfilled additive `EXEC` is never automatically replayed after reconnect.

## Consequences

- The park/resume hole is closed. A run that parks with 45 of a 40-token budget spent resumes already over and refuses immediately. Unknown usage also survives resume and keeps token/USD admission closed.
- **The "zero network round trips" claim in `metered-llm.ts` is now false as stated and has been restated rather than deleted.** The ADMISSION decision still adds none — it is a pure comparison against a counter hydrated once per slice. The SETTLE path adds one append per call, sequenced after a call that already cost seconds. The guarantee that mattered (an LLM call is never delayed by budget bookkeeping *before* it is made) is unchanged.
- **Loss window: every concurrently settled append still pending.** A crash between provider settlement and acknowledged ledger completion can lose every call whose transaction is not known committed. With concurrent calls this is not bounded to one call; the record necessarily follows the facts it records.
- **Each acknowledged Redis append is complete.** Usage/model marker fields, nonzero saturated numeric axes, and the configured single-key TTL refresh commit together. All same-connection transactions serialize behind an active WATCH; second-client writes still produce an `EXEC null` conflict and retry because no append committed. Any command error, malformed result list, or thrown/lost acknowledgement returns one typed append failure; the adapter and ioredis never replay a transaction that may already have committed.
- `RedisPort` gained the optional consumer-owned `appendSpend` transaction operation, `hGetAll` for the sole read, and `commitCheckpointAndRetainSpend` for one atomic checkpoint write plus spend-retention refresh. The ledger parses and receiver-binds exactly those capabilities once at construction (`spendLedgerRedis`). The production operation inspects every `EXEC` result and uses no Lua or command on the per-tenant ACL's denied list.
- **An adapter that cannot increment DOWNGRADES; it does not refuse.** `createNodeContextForDag` falls back to the in-process ledger, because refusing every run over a metering capability would turn a configuration gap into an outage. The downgrade is logged at `error` naming the missing primitives and the consequence (`per-run LLM budgets reset when this process restarts`), which is the only place that fact exists — an earlier draft of this ADR claimed the host "fails at boot", which was never what the code did.
- **The sole spend key is spelled `$spend`, and the `$` is load-bearing.** It shares `checkpointKeyPrefix` with `buildCheckpointKey`, whose final segment is a caller-supplied `NodeId`; `$` is outside `ID_PATTERN`, so a node checkpoint cannot collide with and type-destroy the hash. `cache-keys.test.ts` proves this over arbitrary node ids. **Any future key added beneath the checkpoint prefix inherits this constraint.**
- The spend hash lives under the same `fugue:<tenant>:` prefix as every other key, so the per-tenant ACL scopes it unchanged. With no configured checkpoint TTL, spend has no expiry. Otherwise its TTL is the maximum of the checkpoint TTL and any authoritative resumable-run lifetime (currently `HITL_RUN_TTL_SEC`). A later checkpoint transaction writes the checkpoint with its own DAG TTL while refreshing spend with that longer lifetime; resumable HITL state therefore cannot outlive accounting.
- One Run Spend Authority now owns the slice's meter and reservations. The main client, `judgeLlm`, every boot-scoped capability-bag client explicitly marked `clientKind: "llm"`, and every explicitly marked broker-delivered LLM delegate to it. Each binding carries a pricing-model policy; fixed bindings reject conflicting request models before provider egress. Augmented subtypes declare `runScopedOperations`; the host, not adapter code, binds those aliases to the metered surface, so client choice cannot bypass the ceiling.
- The file adapter closes F6 restart durability without changing stock selection: the stock host explicitly wires a Redis-first in-process fallback; a file-runtime embedder injects `createFileSpendLedger(root)` as authoritative `SharedInfra.spendLedger`. Redis capability detection cannot silently displace that injected file authority, and only an actually selected memory fallback logs “NOT durable.”
- File roots and retention are embedder-owned. No backend selector is inferred from `DAGS_LOCAL_PATH`, and no fsync/network-filesystem guarantee is claimed.

## Related

- ADR-0082 — budgets denominated in spend (what this makes durable)
- ADR-0060 — durable HITL suspend/resume (the per-slice NodeContext this works around)
- ADR-0078 — journal single-writer contract (the file-adapter shape, when it lands)
- `docs/plans/2026-08-27-f3-budget-capability.md` §D3 — the plan this implements, and where it deviates
