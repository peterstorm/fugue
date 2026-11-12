# ADR-0090: Concurrent fan scheduling and whole-fan projection

## Status
Accepted. Implemented by F1 PR-D1 on `feat/f1-pr-d-fan-scheduling`, which is not
yet merged. It amends [ADR-0086](0086-root-owned-mapped-child-execution.md): the
sequential fan is superseded. It adds a second fan address space under
[ADR-0085](0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md)'s
grammar.

## Date
2026-11-12 (decisions taken 2026-10-02 in the PR-D specification and plan-alignment round 1)

## Context

ADR-0086 made a runtime-width `map` one root-owned node that runs a prepared child
DAG over a bounded array. Its children run **one at a time**
([F1 plan §12](../plans/2026-09-06-f1-runtime-width-fanout.md#the-fan-is-sequential--superseded)).
Two properties depended on that. A run that hit its spend ceiling mid-fan stopped
at a known index. The reducer received outputs in index order on fresh and resumed
runs alike.

Sequential dispatch leaves two gaps:

1. **Wall clock.** A wide fan of slow, independent LLM children takes N × latency.
2. **Budget is discovered, not projected.** The host per-call meter
   (ADR-0082/0083) refuses the *call* that would breach a ceiling. A 40-child fan
   can therefore admit child 1, spend most of the budget, and be refused at
   child 31. The run has paid for 30 children and gets no reduced result. F1
   plan §4 D4 asked for projection instead: refuse *before* starting work that
   cannot finish.

Concurrency makes the second gap worse. With C children in flight, "which child
hit the ceiling" is a race. The read-only `BudgetCapability` is run-wide, so it
cannot attribute spend to a particular child.

The constraints are fixed by earlier decisions:
- The framework only **reads** budget. Dispatch and spend authority stay with the
  root (ADR-0086, F3).
- There is no new host port and no change to the per-call meter.
- Run ceilings come only from DAG configuration; a caller can only tighten them.
- The fingerprint stays structure-only.
- In-flight runs must resume across the deploy, so there is no
  `FRAMEWORK_VERSION` bump.

## Decision

The decision has thirteen parts (plan AD-1 to AD-13). They are condensed here in
dependency order. The full plan is
`.claude/plans/2026-10-02-f1-pr-d-fan-scheduling.md`.

### 1. Concurrency surface (AD-8)

| Setting | Who sets it | Default | Meaning |
|---|---|---|---|
| `childConcurrency` | DAG author, on the map node (`createMapNode`, `createCollectMapNode`, AuthoredDag `map`) | `1` | The most children of **this fan** in flight at once |
| `estimator` | DAG author, on the map node | `"largest-seen"` | How projection predicts one more child's spend (§5) |
| `FAN_CHILD_CONCURRENCY_MAX` | Host operator, environment | `8` | Host-wide ceiling on every fan's child concurrency |

- **Effective concurrency** is `C = min(childConcurrency, FAN_CHILD_CONCURRENCY_MAX)`.
- **Clamp.** When the authored value exceeds the cap, the fan logs one warning
  and emits one `fan-start` event with `clamped: true`, each once per fan start.
- **Validation.** Both settings are positive safe integers, branded
  `ChildConcurrency` and `FanConcurrencyCap`. Each brand has a throwing
  definition-time constructor and a `Result`-returning parser.
  - An invalid authored value or estimator is rejected at definition or load,
    naming the node and the value.
  - An invalid host value fails startup, naming the setting.
- **Operator cap of 1.** A cap of `1` makes every fan sequential.
- **No overrides.** There is no per-run and no per-tenant override.
- **Storage.** The authored settings are frozen on `mapping.scheduling`. They are
  excluded from the DAG fingerprint, so redeploying with a different concurrency
  or a larger budget never invalidates saved children.
- **Naming.** Each name contains *child* or *fan* on purpose (FR-035). The names
  must not be confused with the **run-level** limits:
  - `MAX_GLOBAL_CONCURRENCY` limits concurrent runs host-wide.
  - `DEFAULT_DAG_CONCURRENCY` and the `fugue.yaml` setting `maxConcurrent` limit
    concurrent runs of one DAG.

  Neither run-level limit says anything about parallelism inside a run.
  `maxConcurrency` was rejected because it collides with the run-level names.

### 2. A pure admission core with self-contained slot tasks (AD-1, AD-2)

The scheduler is a closed typed reducer, **LC-1**: `fanStep(state, event) →
{ state, commands }` in `dag-runtime/fan/fan-machine.ts`.
- **Phases:** `fan-dispatching | fan-draining{cause} | fan-done{finish}`.
- **Events:** `start`, `slot-settled`, `abort`.
- **Commands:** `replay`, `dispatch`, `emit-projection`, `emit-refused`,
  `persist-seed`, `finish`.

It owns every scheduling decision:
- seed evaluation;
- the probe batch;
- projection before each later dispatch;
- the drain;
- first-error-by-index;
- the index-ordered reduce gate.

The phase literals exist only in the machine file (INV-1). `fan-done` is
absorbing.

`run-mapped-fan.ts` is a thin interpreter:
- It runs one `runSlot(i)` task per started index. That task is **today's per-index
  body, unchanged**: replay-hit parse, or `executeChild` → `childOutputSchema`
  parse → `saveNode`.
- It awaits `Promise.race` over at most C slots.
- It samples `budget.spent()` and `budget.remaining()` synchronously and passes
  the snapshots to the machine as event data.
- It never uses `Promise.all`, and it never returns while a slot is pending.

D3 (adaptive concurrency) extends the event union with `throttle` and adds a
target to the state. Nothing in D1 needs reshaping for that.

**Rejected alternatives:**
- A fully command-driven scheduler. It spreads a 15-line body over about six
  round trips and turns the interpreter into an effect runtime.
- A generic `BoundedPool` with policy plug-ins. It is abstraction ahead of need:
  there is one consumer, and static siblings deliberately get no projection.

### 3. Budget authority stays at the root (AD-7)

- **`FanRuntime`.** The root `ExecutionScope` carries
  `FanRuntime { budget: BudgetCapability | null; cap: FanConcurrencyCap; logger }`.
  It is built once in `runDagStatefulOutcome` from the root-validated base context.
- **Cap fallback.** The cap comes from `DagRunOpts.fanConcurrencyCap`. Without
  it, the cap is `DEFAULT_FAN_CONCURRENCY_CAP` (8).
- **Requirements.** `MapNodeDef.requires` stays `["checkpointer"]`, so the
  capability gate does not refuse map DAGs that have no budget.
- **No budget.** A null budget is treated as an unbudgeted fan.

### 4. The per-child spend measure M (AD-3)

`runSlot` samples run-wide `spent()` twice: before `executeChild` and after
`saveNode`. The per-axis delta of that window is the child's **spend sample**:
- `tokens` and `calls` are integers.
- `usd` is the floor in MicroUsd. The sample is flagged `lowerBound` when that
  spend is unpriced or has unknown usage.
- Replayed indices produce no sample.

**M** is the per-axis maximum of all measured samples of the fan. It includes
drain completions and seeded samples.

The window also counts siblings' concurrent spend, so it is never less than the
child's true settled cost:
- At C=1 it is exact.
- It needs no host change.
- It can only over-estimate, so projection can only refuse *earlier*. Every bound
  stated against M is therefore no weaker against true spend.

**Accepted cost:**
- At high C under heavy overlap, the over-estimate can reach about (2C−1)× a
  child's true cost. The fan may then refuse work that would in fact have fitted.
- Percentile estimators inherit this upward bias.

The fan is meant to stop early and conservatively, and this is the price of
measuring without a host attribution port. Two alternatives were rejected:
- Exact host-tagged attribution (`spentFor(scope)`) extends the capability
  contract.
- Batch averaging under-estimates the largest child.

### 5. Probe, then project (AD-4, AD-5)

- **Probe batch.** Without a refusal seed (§8), the first `min(C, unreplayed)`
  dispatches form the probe batch. They are dispatched **without projection**,
  because there is no estimate yet.
- **Projection.** Every later dispatch is preceded by
  `project(remaining, remainingChildren, estimate)`.
  - `remainingChildren` = width − successfully completed. It counts in-flight
    slots and the slot about to start.
  - The partial spend of in-flight children appears both in the host's projected
    spend and in `remainingChildren × estimate`. That double count is deliberate
    and conservative.

The projection reads only the existing headroom ADT:

| Headroom kind | Refuse when | `lowerBound` |
|---|---|---|
| `unbudgeted` | never: no projection | — |
| `available` (tokens / calls / usd) | `remainingChildren × estimate[axis] > amount` (amount = ceiling − host projected spend, including reservations, floored at 0) | false |
| `unpriced` (usd) | `observedAtLeast + remainingChildren × estimate.usd > limit` | true |
| `unknown-usage` (tokens or usd) | `observedAtLeast + remainingChildren × estimate[axis] > limit` | true |

The first breached axis in ceiling order is reported.

**Estimators** form the closed set `largest-seen | p50 | p90 | p95`:
- A percentile is **nearest-rank** over the per-axis samples, so it is always an
  observed integer and MicroUsd-safe.
- With fewer than 5 samples, a percentile **falls back to largest-seen**. Seeded
  samples count toward the five.
- Every refusal and every projection event records `estimatorApplied`: the
  estimator actually used, which may be the fallback.
- Linear interpolation was rejected because it yields fractional MicroUsd and is
  less conservative.

### 6. The overshoot guarantee (AD-12, FR-018)

Under the **largest-seen** estimator, with C the effective concurrency and M the
largest measured per-child spend (§4), the system guarantees exactly the following
(FR-018, verbatim):

> - (a) Post-refusal: spend incurred after a projection refusal decision is ≤ (C−1) × M (at most C−1 children are in flight, each ≤ M).
> - (b) Post-probe, no cost spike: when no child's measured spend exceeds the per-child estimate in force at its admission, dispatches after the probe batch cause no spend beyond any ceiling. Therefore total post-probe overshoot ≤ (C−1) × M.
> - (c) Probe carve-out: the unprojected probe batch (FR-010) is bounded by C × M and by the host per-call meter.
> - (d) Cost spike: a child whose spend exceeds the estimate in force at its admission is bounded only by the host per-call meter (FR-019). This MUST be documented.
> - Under a percentile estimator, (a) still holds and (b) is best-effort only; this MUST be documented. The host per-call meter remains the hard stop.

In short:
- **(a)** Post-refusal spend ≤ (C−1)·M. This holds unconditionally.
- **(b)** There is no post-probe overshoot when the run is *spike-free*: every
  child's measured spend is ≤ the estimate in force at its admission. Total
  post-probe overshoot is therefore ≤ (C−1)·M. A probe child has no estimate at
  its own dispatch, so the estimate in force for it is the first one applied
  after it. A probe child that costs more than that estimate is a spike, and its
  overshoot belongs to the (c) carve-out. Example: C = 2, costs [2, 1, 1, 1] and
  a ceiling of 4 end at 5, within (c), not in breach of (b).
- **(c)** The probe carve-out is ≤ C·M, plus the host per-call meter.
- **(d)** A **cost spike** is bounded only by the host per-call meter (FR-019).

**Why each holds:**
- **(a)** The refused dispatch would have taken the C-th slot. At the decision
  point at most C−1 children are in flight, and each one's remaining spend is at
  most its window, which is ≤ M.
- **(b)** Let t* be the last admission. Projection admitted it, so
  `spend(t*) + R(t*)·e(t*) ≤ ceiling` held at that moment. Every child that still
  had spend to incur was admitted at or before t*. Under largest-seen, estimates
  never decrease. With no spike, final spend ≤ ceiling.
  - On lower-bound axes (unpriced or unknown-usage), (b) holds against the known
    lower bound, not against the true cost, which may be higher.
- **(c)** The probe has no estimate, so it is unprojected. Once the probe has
  overshot, the first projection after it sees `amount = 0` and refuses any child
  whose estimate is non-zero.
- **(d)** Projection cannot see a child that costs far more than everything
  observed before it. At C=1, a child costing 100× its predecessors is admitted
  on the old estimate and overshoots by more than (C−1)·M = 0.
  - This is why the specification was tightened in round 1, from an
    unconditional "post-probe ≤ (C−1)·M" (false in general) to the four clauses
    above.
  - The host per-call meter, unchanged (OOS-003), is the only bound on a spike.
    It remains **the hard stop for every call under every estimator**. Fan
    projection is an earlier, coarser gate, not a replacement.

**Percentile estimators.**
- (a) still holds: it depends only on how many children are in flight, not on
  the estimate.
- (b) is **best effort only**. A percentile is below the maximum, so a child
  above the percentile counts as a cost spike by definition, and percentile
  estimates are not monotone.
- Choosing p50/p90/p95 trades that guarantee for fewer refusals of fans with one
  outlier-expensive child.

**Evidence.**
- `fan-overshoot.property.test.ts` (≥1,000 cases) drives the machine against a
  simulated run-wide spend model with arbitrary per-child costs, interleavings
  and headroom kinds. It asserts (a) always, (b) on spike-free runs, and (c)
  always.
- An example test in `map-fan-concurrency.test.ts` pins (d): the per-call meter
  stops a spike, and projection does not.

### 7. Drain, errors and abort (AD-6, AD-10)

**Drain.** A terminal child failure, a refusal or an abort starts the **drain**:
- No new dispatch.
- In-flight children finish, and their successful outputs are validated and saved.
  Paid-for work is never discarded.
- The signal is checked before every start decision and after every settle.
- A reduce is honoured only if the signal is still not aborted. This preserves
  ADR-0086's final abort gate.
- A rejected slot promise becomes a non-retriable `node-crash` for that index.
- Children keep their own node retry policies inside the epoch. The fan adds no
  retry.

**Errors.** One frozen `FanRefusal` record carries:
- the axis and its ceiling;
- `perChildEstimate` and `estimatorApplied`;
- `effectiveConcurrency`;
- `completed` (which includes drain completions) and `remaining`;
- `lowerBound`;
- the redeploy `hint`;
- `scopePath`, which is `[]` in D1 and reserved for nested attribution.

Outcomes, in precedence order **child failure > refusal > abort**:

| Drain cause | Returned error |
|---|---|
| One child failure, no refusal | The **bare primary error, exactly as today** |
| Several failures and/or failure + refusal | `fan-child-failed { primary, causes }`, where `causes` is `secondaries`, `refusal` or `secondaries-and-refusal` |
| Refusal only | `fan-budget-refused { refusal }`, non-retriable |
| Abort only | the existing `{ kind: "aborted", reason: "signal" }` |

- **Primary.** The primary is the lowest-index failure, and every other observed
  failure is a secondary.
- **No drop.** A refusal that coincides with a failure is attached, never
  dropped, and its `fan-refused` event is still emitted (FR-025).
  - At C=1 a refusal never coexists with a failure, because no sibling is in
    flight when a refusal happens.
- **Abort.** An abort during a failure or refusal drain does not change the error.
- **Construction.** Both kinds are built only through `frameworkError.fanBudgetRefused` and
  `.fanChildFailed` (INV-2). That guarantees every refusal carries the hint and
  its diagnostic fields.
- **HTTP.** The host maps `fan-budget-refused` to the class of `llm-budget-exceeded`
  (429, does not trip the breaker). `fan-child-failed` takes its primary's class.

**Rejected:**
- Carrying the refusal only on the event, which drops FR-014 data from the error.
- Always wrapping failures, which breaks C=1 error identity.
- Reusing `llm-budget-exceeded`, which blurs a per-call breach with a fan
  projection.

### 8. The refusal seed lifecycle (AD-11)

A refused fan must refuse again deterministically on resume. Re-probing would spend
up to C more children per resume. It is also non-deterministic when the remainder is
≤ C, because a remainder that fits in one probe batch would run unprojected.

**Write.** When the machine reaches `fan-done` with any refusal, bare or attached,
it emits `emit-refused` → `persist-seed` → `finish`, in that order.
- The seed:

  ```
  FanRefusalSeed = { version: 1; estimator; samples: readonly SpendSample[];
                     estimate: SpendSample; ceilings: readonly Ceiling[]; refusal: FanRefusal }
  ```

  - `samples` includes drain completions and any prior seeded samples.
  - `ceilings` holds every budgeted ceiling of the `Remaining` snapshot at the
    refusal decision.
- **Where it is stored.** The seed is stored **per execution epoch** through the
  fan's existing `checkpointer` port, with
  `saveNode(runId, { nodeId: mapNodeId, output: seed, … }, { namespace: "fan-seed", index: 0, attempt: epoch })`.
  - The stored key is `fan-seed@<mapNodeId>@0@<executionEpoch>`.
  - It is saved before the fan returns.
- **Save failure.** A failed seed save returns its typed `checkpoint-write-failed`
  and fails closed, the same rule as a child save. The `fan-refused` event has
  already been emitted.

**Read.** The fan's single existing `checkpointer.load` already returns every
entry. The shell looks up the current epoch's seed and parses it with
`FanRefusalSeedSchema`:
- The schema is strict zod with `version: 1`. It requires at most one ceiling
  per axis, and the refusal's ceiling must be one of `ceilings`.
- A corrupt entry triggers ADR-0086's whole-fan corruption refusal.
- A schema failure is a `validation` error naming the fan. It fails closed.

**Evaluate before any dispatch.** On resume:
1. **No seed.** The normal probe runs.
2. **Seed present, no unreplayed work.** The fan reduces normally; the drain
   may have finished everything.
3. **Seed present, unreplayed > 0, no ceiling raised: sticky refusal.**
   - The fan goes straight to `fan-done` with `fan-budget-refused`, and
     `fan-refused{sticky: true}` is emitted.
   - The refusal reports: completed = replayed count; remaining = unreplayed;
     the seeded estimate; the *current* effective concurrency.
   - **0 children are dispatched**, whatever the remainder size, including ≤ C,
     and whatever the variation in per-child cost.
4. **Seed present, a ceiling raised.** This means a redeploy with a larger
   budget.
   - There is **no unprojected probe**. The estimator starts from the seeded
     samples, and projection runs before *every* dispatch, including the first
     (FR-010 as amended).
   - If the raise is enough, the fan completes and reuses every saved index.
     Otherwise it refuses again with a refreshed seed.

**When a ceiling counts as raised.** `ceilingsRaised(seeded, current)` is true iff:
- the current headroom is unbudgeted; or
- a seeded axis is absent now; or
- some axis has `current.limit > seeded.limit`.

Equal or lower limits keep the refusal sticky. Ceilings come only from DAG
configuration and cannot change without a redeploy (OOS-004, FR-052), so "not
raised" means "not redeployed with a larger budget". **The refusal is sticky until
a redeploy raises a ceiling.**

**Reroute.** A reroute advances the execution epoch, so a prior epoch's seed is
never read. The rerouted fan probes afresh.

**Rejected:**
- Re-probing on resume.
- Persisting samples on every completion: a hot-path write for a refusal-only
  need.
- Relying on the per-call meter: it produces the wrong error kind.

### 9. Purely additive persistence (AD-9)

- There is no `FRAMEWORK_VERSION` bump, no new `NodeState` field, no codec change
  and no backend change. In-flight runs resume across the deploy.
- `dagFingerprint` does not see `scheduling`.
- Fan completions keep ADR-0086's `dag@<mapNodeId>@<index>@<executionEpoch>`.
  Index-ordered reduce makes concurrency invisible to stored outputs.
- The seed is the one new entry. It uses a **second fan address space**,
  `fan-seed`, inside ADR-0075/0085's existing composite grammar. The `fan-seed`
  namespace is disjoint from `dag`, so a seed can never be mistaken for a child
  completion.
- The two new error kinds extend `PersistedFrameworkErrorSchema` additively.

**Rejected:**
- Storing the seed in the root `JobLike` data: ADR-0086 forbids the fan from
  touching root durable state.
- A new `NodeState` field: it changes the persisted shape in three backends.

### 10. C=1 equivalence is a checkable contract (AD-13)

At effective concurrency 1, the following are byte-identical to the pre-change
sequential runner:
- dispatch order;
- checkpoint `load`/`setMeta`/`saveNode` calls and their order;
- reducer input;
- returned errors.

`map-fan-c1-equivalence.test.ts` verifies this against a golden trace recorded
from the merge-base runner.

Two things are outside that trace:
- The new observer events are additive.
- A budgeted C=1 fan whose projection breaches now refuses (and writes a seed)
  earlier than the old meter-only stop. That is the feature working as intended.

### Observability

The `ObserverEvent` union gains three events:

| Event | When | Key fields |
|---|---|---|
| `fan-start` | Once per fan start | width, replayed, seeded, authored, cap, effective, clamped, estimator |
| `fan-projection` | At each projection | effective concurrency, axis, per-child estimate, `estimatorApplied`, `remainingChildren`, `verdict`, `lowerBound` |
| `fan-refused` | At the refusal point | embedded `FanRefusal`, `sticky`, `attachedToChildFailure` |

`fan-refused` is self-contained (FR-060): it answers "why was this fan refused?"
without a join against the other two events. The run-status API is unchanged
(FR-061).

## Alternatives not chosen

- **Keep the fan sequential and add only projection.** This fixes the budget gap
  but not the wall-clock gap. Note that `FAN_CHILD_CONCURRENCY_MAX=1` restores
  exactly this behaviour host-wide.
- **Cancel in-flight siblings on failure or refusal** (OOS-005). This throws away
  paid-for work. The drain saves it instead.
- **Probe one child before going wide** (OOS-006). That gives a narrower
  carve-out, but serializes the first child of every fan.
- **A host reserve/admit port** (OOS-001). This would give exact attribution and
  pre-reservation, but it creates a new spend-authority seam. Reading the
  existing headroom ADT is enough for an earlier, coarser gate.
- **Author-declared per-child estimates** (OOS-002). These are guesses that drift
  from reality. Measured samples do not drift.

## Consequences

**Positive:**
- Wide fans of independent children finish in about ⌈N/C⌉ child latencies instead
  of N.
- A fan that cannot finish inside its budget is refused before it spends the rest.
  The refusal is a distinct, typed, persisted outcome that names the remedy.
- Resume-after-refusal is deterministic. A redeploy with a larger budget resumes
  and reuses every saved child.
- C=1 is byte-identical to the old fan, so an operator can switch concurrency off
  host-wide with `FAN_CHILD_CONCURRENCY_MAX=1`.
- The scheduling invariants are tested as pure properties of one reducer, not as
  races in async code:
  - in-flight ≤ C;
  - index-ordered reduce;
  - lowest-index primary with complete secondaries;
  - refusal never dropped;
  - sticky 0-dispatch refusal;
  - FR-018 (a)–(c).

**Negative and accepted:**
- **Over-refusal.** Lifetime-window measurement over-refuses under heavy overlap
  (up to about (2C−1)× at high C). Percentile estimators are biased high for the
  same reason.
- **Probe carve-out.** The probe batch is unprojected and can overshoot by up to
  C·M. The per-call meter still bounds every call, and an operator can lower the
  cap.
- **Cost spikes.** A spike is bounded only by the per-call meter. Under
  percentile estimators, the no-overshoot property (b) is best effort.
- **More concurrent provider calls.** Concurrency multiplies across run-level
  limits: up to `MAX_GLOBAL_CONCURRENCY` runs × C children can be calling a
  provider at once. Operators size provider rate limits accordingly. There is no
  cross-fan or tenant-level rate limiting (OOS-007).
- **Static siblings.** Static fan-out siblings in one wave still run unbounded
  and unprojected (OOS-014).

**Evidence limits:** the property and example suites prove the scheduler,
projection, error assembly and seed logic against simulated spend and the in-memory
and file checkpointers. The host composition test proves the cap, the clamp and a
real-Redis seed surviving a process restart. These tests do not prove provider
rate-limit behaviour at high C, exactly-once external effects, or deployed
infrastructure.

## Deferred (separate PRs)

- **D2: nested fans.** A map inside a mapped child (depth 2) needs nested
  checkpoint addressing, and that addressing must re-scope the seed address
  `fan-seed@<map>@0@<epoch>`. `FanRefusal.scopePath` is reserved for nested
  attribution.
  - Peak concurrent leaf children would be bounded by the product
    Co_eff × Ci_eff.
  - Until D2, nested maps remain refused (ADR-0086), so a fan's peak is C.
- **D3: adaptive and static siblings.** An AIMD target within `[1, C]` driven by
  provider throttling, and an authored `siblingConcurrency` on static fan-out
  waves under the same host cap.

## Related

- [ADR-0086](0086-root-owned-mapped-child-execution.md): root-owned mapped child
  execution. Amended: its sequential fan is superseded here.
- [ADR-0085](0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md):
  composite addressing on every backend. The `fan-seed` namespace rides it with no
  grammar change.
- [ADR-0075](0075-composite-checkpoint-node-key-encoding-with-canonical-folding.md):
  the composite grammar.
- [ADR-0082](0082-budgets-are-denominated-in-spend-not-tokens.md) and
  [ADR-0083](0083-spend-durability-lives-in-a-ledger-port.md): spend-denominated
  ceilings, the per-call meter, and the ledger.
- [F1 plan §12–§13](../plans/2026-09-06-f1-runtime-width-fanout.md#12-what-pr-b-decided-that-this-plan-did-not-specify)
- Specification: `.claude/specs/2026-10-02-f1-pr-d-fan-scheduling/spec.md`
  (FR-001–FR-062).
- Plan: `.claude/plans/2026-10-02-f1-pr-d-fan-scheduling.md` (AD-1–AD-13, LC-1,
  INV-1–INV-6).
