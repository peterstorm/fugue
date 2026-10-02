# Plan: F1 PR-D1 — Bounded-Concurrency Fan Scheduling with Probe-then-Project Budget Admission

**Spec:** .claude/specs/2026-10-02-f1-pr-d-fan-scheduling/spec.md
**Created:** 2026-10-02
**Revised:** 2026-10-02 (plan-alignment round 1: FR-018 carve-out, FR-025 mixed drain, FR-026 refusal seed, FR-060 self-contained refusal event)

## Summary

Runtime-width map fans gain an authored `childConcurrency` (default 1), capped host-wide by `FAN_CHILD_CONCURRENCY_MAX` (default 8). They also gain a probe-then-project whole-fan budget admission gate with a selectable per-child estimator: largest-seen, p50, p90 or p95, using nearest-rank and falling back to largest-seen below 5 samples.

The design is **Approach B (admission core + self-contained slot tasks)**. A pure Mealy machine `fanStep` (LC-1) decides what may start next and how the fan ends: probe, projection, drain, first-error-by-index, attached refusal, and index-ordered reduce. A tiny async interpreter in `run-mapped-fan.ts` runs per-index slot tasks that keep today's exact replay → execute → validate → save body.

A **refusal seed** is persisted per execution epoch on refusal and evaluated before any dispatch on resume. This makes resume-after-refusal deterministic (FR-026).

This plan is **PR D1 only** (US1–US4 + US7). Nested fans (US5) and adaptive concurrency plus static sibling limits (US6, US8) are explicitly deferred to D2/D3; see **Deferred Scope**.

---

## Deferred Scope (explicit — NOT in this plan)

The user split the spec into three PRs at the interview (Q4). Implementation agents MUST NOT start any of the following. Plan-alignment should treat these spec ids as deferred, not missing.

| PR | Spec ids | Content | Interview items carried forward |
|---|---|---|---|
| **D2 — nested fans** | US5; AS-032..035, AS-047, AS-048; FR-040..043; SC-012 | Map inside a mapped child at depth 2, rejected at depth ≥3. Needs a dispatcher in the `mapped-child` `ExecutionScope` and a recursive child inventory in `prepareDagRun`. Lifts three bans: `run-node.ts:575`, `validate-dag.ts:227`, `cli/authored.ts:335`. Also needs nested refusal attribution (a scope path in `fan-budget-refused`). | Q9 (nested checkpoint addressing, where namespace encoding is the leading option) is open for the D2 run. The D1 `FanRefusal.scopePath` is reserved so D2 is additive. The D1 seed address (`fan-seed@<map>@0@<epoch>`) must be re-scoped by D2's addressing decision. |
| **D3 — adaptive + static siblings** | US6 (AS-036..039, AS-049, AS-050, AS-055; FR-044, FR-045; SC-015) and US8 (AS-044..046, AS-052..054; FR-047..049; SC-016) | AIMD target inside `[1, effective]` driven by a throttle signal, with a `fan-concurrency-adjusted` event. Also an authored `siblingConcurrency` on static fan-out waves (`executeWave`), capped by the same host max. | Q7 (throttle-signal source, where a child-scoped observer tap is the leading option) is open for the D3 run. The D1 `fanStep` event union is closed but extensible: D3 adds a `throttle` event and an `adaptiveTarget` field without reshaping (AD-2). |

D1 keeps the D2 bans exactly as they are today (`nested mapped execution is unsupported`).

---

## Architectural Decisions

### AD-1: Approach B — pure admission core + self-contained slot tasks

**Choice:** A pure Mealy transition `fanStep(state, event) → { state, commands }` in `dag-runtime/fan/fan-machine.ts` owns admission and termination:
- seed evaluation
- probe batch
- projection before each later dispatch
- drain on failure, refusal or abort
- first-error-by-index with secondaries and an attached refusal
- the index-ordered reduce gate

Each started index runs one async `runSlot(i)` closure in the shell. That closure is today's per-index body unchanged: replay-hit parse, or `executeChild` → `childOutputSchema` parse → `saveNode`. The interpreter is a bounded pool over `Promise.race`. It samples the budget synchronously (`spent()`/`remaining()` are sync) and feeds the snapshots into the machine as event data.

**Why:** Every invariant the spec cares about sits in one small pure machine: NFR-020, FR-005, FR-011, FR-018, FR-021 and FR-025. The already-proven save path stays the same code, which makes FR-004 / SC-001 (C=1 equivalence) low-risk. This was the user's pick for the simplicity/determinism axis.

**Rejected:**
- A: full command-driven scheduler (every effect a command). Purest, but it spreads a 15-line body across about 6 round trips and grows the interpreter into a small effect runtime.
- C: generic `BoundedPool` plus policy plug-ins. This is abstraction ahead of need: D1 has one consumer, and D3's static siblings deliberately get no projection (OOS-014).

### AD-2: The fan scheduler is LC-1, a closed typed reducer

**Choice:** `FanPhase = fan-dispatching | fan-draining{cause} | fan-done{finish}`. `DrainCause` records `failures: readonly IndexedError[]`, `refusal: FanRefusal | null` and `aborted: boolean`, so a mixed drain loses nothing. Illegal transitions are unrepresentable or ignored by construction (see the LC-1 table). Phase literals live only in the machine file (INV-1). D3 extends the event union with `throttle`, and the state gains `target`.

**Why:** Executable-model policy: the lifecycle is the code. Determinism and drain semantics are property-testable without async code.

**Rejected:**
- An imperative worker pool with pure helpers only. Drain and termination ordering would live in async code, where interleaving bugs hide.

### AD-3: Per-child spend = lifetime-window over-approximation (this is M)

**Choice:** `runSlot` samples `budget.spent()` at slot start (before `executeChild`) and at slot settle (after `saveNode`). The child's sample is the per-axis delta of that window:
- `tokens`, `calls` as integers;
- `usd` as `costFloor(usd)` in MicroUsd, flagged `lowerBound` when the spend is unpriced or unknown-usage.

Replayed indices produce no sample. **M** (spec FR-018) is defined as the per-axis maximum of these measured samples over the fan, including drain completions and seeded samples.

**Why:** `BudgetCapability` is run-wide. Under concurrency, a child's true cost is unobservable from it, but the window delta is never less than the child's true settled cost. It is exact at C=1 and needs no host change (OOS-001). Because it can only over-estimate, projection can only refuse earlier, and every bound stated against M is no weaker against true spend.

**Rejected:**
- Host-tagged exact attribution (`spentFor(scope)`). It extends the capability contract and the host meter.
- Batch-average attribution. It under-estimates the largest child.

**Accepted cost:** Over-refusal of up to about (2C−1)× at high C under heavy overlap. Percentile estimators are biased high. Both are documented in ADR-0087.

### AD-4: Projection arithmetic is headroom-native and conservative

**Choice:** This is pure `project(remaining, remainingChildren, estimate)` in `fan/projection.ts`. `remainingChildren` = width − successfully completed, so it includes in-flight slots and the slot about to start. The rule per `Remaining` axis:

| Headroom kind | Refuse when | `lowerBound` |
|---|---|---|
| `unbudgeted` | never; no projection | — |
| `available` (tokens / calls / usd) | `remainingChildren × estimate[unit] > amount` (amount = ceiling − the host's projected spend, including reservations; floored at 0 by the host) | false |
| `unpriced` (usd) | `observedAtLeast + remainingChildren × estimate.usd > ceiling.limit` | true |
| `unknown-usage` (tokens or usd) | `observedAtLeast + remainingChildren × estimate[unit] > ceiling.limit` | true |

The first breached axis in ceiling order is reported. A null `ctx.budget` behaves as `unbudgeted`.

**Why:** It reads only the existing headroom ADT (FR-012, FR-013). The partial spend of in-flight children is counted both inside the host's projected spend and inside `remainingChildren × estimate`. That double count is deliberate and conservative.

**Rejected:**
- Re-deriving ceilings from `dag.config` in the framework. The framework never sees ceilings directly; headroom is the contract.

### AD-5: Estimators — closed union, nearest-rank, fallback below 5

**Choice:** `FanEstimator = "largest-seen" | "p50" | "p90" | "p95"`, parsed in `types/fan-scheduling.ts`. `estimate(samples, estimator) → { perAxis, applied }`:
- Percentile = nearest-rank over the per-axis sample multiset.
- With fewer than 5 samples, `applied = "largest-seen"`.
- Seeded samples count toward the 5.
- The refusal, the attached refusal and both events carry `applied`.

**Why:** FR-046 / SC-014. Nearest-rank always returns an observed integer value (MicroUsd-safe) and is conservative.

**Rejected:**
- Linear-interpolation percentiles: they produce fractional MicroUsd and are less conservative.

### AD-6: Error model — one `FanRefusal` record, two error kinds, refusal never dropped

**Choice:**
- **`FanRefusal`** (a frozen record in `types/fan-scheduling.ts`):
  - Fields: `axis`, `ceiling`, `perChildEstimate`, `estimatorApplied`, `effectiveConcurrency`, `completed`, `remaining`, `lowerBound`, `hint`, `scopePath`. `scopePath` is `readonly []` in D1; D2 fills it.
  - `completed` includes children that finished during the drain (FR-022).
  - The `hint` names "redeploy the DAG with a larger budget".
- **`fan-budget-refused { nodeId; refusal: FanRefusal }`**
  - Returned when the drain cause is a refusal with no child failure.
  - Non-retriable in `retriabilityOf`, so the root node retry never loops it.
- **`fan-child-failed { nodeId; primary: { index, error }; causes: FanFailureCauses }`**, where:

  ```
  FanFailureCauses =
      { kind: "secondaries"; secondary: NonEmpty<IndexedError> }
    | { kind: "refusal"; refusal: FanRefusal }
    | { kind: "secondaries-and-refusal"; secondary: NonEmpty<IndexedError>; refusal: FanRefusal }
  ```

  - The fourth combination (one failure, no refusal) is unrepresentable. In that case the **bare primary error is returned exactly as today**, which keeps FR-004 C=1 error identity.
  - Retriability = the primary's retriability.
  - FR-025: the lowest-index child failure is primary, the refusal is attached, and the `fan-refused` event is still emitted.
  - At C=1 a refusal never coexists with a failure, because no sibling is in flight when a refusal happens.
- **Abort** returns the existing `{ kind: "aborted", reason: "signal" }`. Precedence: child failure > refusal > abort. If an abort occurs during a refusal or failure drain, the error is not changed (FR-024).
- **Where the kinds are added:**
  - `PersistedFrameworkErrorSchemaDefinition`: the exhaustiveness type forces this; `FanRefusal` and `FanFailureCauses` are parsed loosely there.
  - `formatFrameworkError` and host `domain/framework-error-http.ts`, both exhaustive.
- **Construction:** only via `frameworkError.fanBudgetRefused` / `.fanChildFailed` (INV-2).

**Why:** These are distinct, typed, persisted outcomes (FR-014, FR-015, FR-021, FR-025), with C=1 errors unchanged and no refusal data lost in a mixed drain.

**Rejected:**
- Refusal carried only on the event: this drops FR-014 data from the error, which the user rejected.
- Always wrapping failures: this breaks C=1 equivalence.
- Reusing `llm-budget-exceeded`: this blurs a per-call breach with a fan projection.

### AD-7: Budget and cap are root-owned fan resources, not node requirements

**Choice:** The `root` variant of `ExecutionScope` gains `fan: FanRuntime`, built once in `runDagStatefulOutcome`:

```
FanRuntime = Readonly<{ budget: BudgetCapability | null; cap: FanConcurrencyCap; logger: Logger }>
```

It is built from the root-validated base context (`validatedCtx.budget`) and `opts.fanConcurrencyCap ?? DEFAULT_FAN_CONCURRENCY_CAP` (8). `MapNodeDef.requires` stays `["checkpointer"]`. The framework only reads budget (ADR-0086 root authority, FR-012).

**Why:** It keeps the map's frozen requirement policy, so there is no capability-gate change for unbudgeted embedders. Authority stays with the root.

**Rejected:**
- `requires: ["checkpointer","budget"]`: the gate would refuse map DAGs without a budget.
- Conditional requires: these depend on the config.

### AD-8: Concurrency surface — authored `childConcurrency`, host `FAN_CHILD_CONCURRENCY_MAX`

**Choice:**
- **Branded types** in `types/fan-scheduling.ts`:
  - `ChildConcurrency` (positive safe int) and `FanConcurrencyCap` (positive safe int).
  - Each has a throwing constructor (definition-time sites, matching the `maxWidth` precedent) and a Result-returning `parse*`.
- **Authored fields:** `childConcurrency?: number` (default 1) and `estimator?: FanEstimator` (default `"largest-seen"`).
  - They are accepted by `createMapNode`, `createCollectMapNode` and the AuthoredDag `map` schema, and emitted by codegen.
  - They are stored on `mapping.scheduling`, frozen by `snapshotMapping`.
- **Effective value:** `effectiveConcurrency(authored, cap) → { effective, clamped }`. A clamp emits `logger.warn` plus a `fan-start` event with `clamped: true`, once per fan start (FR-033, SC-010).
- **Host:** `HostConfigSchema.FAN_CHILD_CONCURRENCY_MAX` (z coerce, int, min 1, default 8). An invalid value fails startup with an error naming the setting (FR-032). It is threaded through `run-executor.ts` into `runResumableDagJob` opts as `fanConcurrencyCap`. This is operator config, not a per-run API (FR-034).
- **Naming:** The names are documented distinctly from `MAX_GLOBAL_CONCURRENCY` / `DEFAULT_DAG_CONCURRENCY` (FR-035).

**Why:** These are the user's interview picks (Q14–Q16).

**Rejected:**
- `maxConcurrency`: collides with the run-level naming.
- A nested `scheduling` authored object.
- Per-tenant config: FR-030 rules it out.

### AD-9: Purely additive persistence — no version bump, fingerprint unchanged, one new composite namespace

**Choice:**
- No `FRAMEWORK_VERSION` bump.
- `dagFingerprint` is untouched, so `scheduling` is excluded (FR-051). A test pins this.
- Fan child completions keep `dag@<map>@<index>@<epoch>` (FR-007).
- The refusal seed (AD-11) is one extra entry written through the existing port:
  - `checkpointer.saveNode(runId, { nodeId: mapNodeId, output: FanRefusalSeed, completedAt }, { namespace: "fan-seed", index: 0, attempt: epoch })`, giving the stored key `fan-seed@<map>@0@<epoch>`.
  - It uses the existing composite grammar (ADR-0075/0085): no codec, port or backend change. The `fan-seed` namespace is disjoint from `dag`.
  - `FanRefusalSeedSchema` (zod, `version: 1`) lives in `types/fan-scheduling.ts`, since `types/` may import zod and `dag-runtime/` may not.
- The new error kinds extend the persisted schema additively.

**Why:** Index-ordered reduce makes concurrency invisible to stored outputs, and the seed rides the port the fan already owns. In-flight runs resume across the deploy (Q12).

**Rejected:**
- A version bump: it strands in-flight resumes.
- A new NodeState field: this changes the persisted shape in 3 backends.
- Seed in the JobLike job data: that is a root-owned durable job, which ADR-0086 forbids the fan from touching.

### AD-10: Drain and abort await in-flight slots; no fan-level retry

**Choice:**
- The interpreter never returns while any slot promise is pending.
- On a terminal failure, refusal or abort (signal checked before every start decision and after every settle), the machine stops emitting `dispatch`. In-flight slots finish, and their successful outputs are validated and saved (FR-020, FR-023, SC-007).
- When `phase = fan-done`, a `reduce` finish is honoured only if the signal is still not aborted. This preserves today's final abort gate.
- A rejected slot promise is converted at the boundary to `node-crash` (non-retriable) for that index.
- Children keep their own node retry policies inside the same epoch (FR-009). The fan adds no retry.

**Why:** There are no orphan writes after the fan returns, and paid-for work is never lost.

**Rejected:**
- Fire-and-forget on abort.
- A fan-level transient retry.

### AD-11: Refusal seed — deterministic resume-after-refusal (FR-017, FR-026, AS-014, AS-056)

**Choice:**
- **Write.** When the machine reaches `fan-done` with a refusal (bare or attached), it first emits `persist-seed { seed }`:

  ```
  FanRefusalSeed = { version: 1; estimator; samples: readonly SpendSample[]; estimate: SpendSample; ceilings: readonly Ceiling[]; refusal: FanRefusal }
  ```

  `samples` holds all measured samples, including drain completions and any prior seeded samples. `ceilings` holds every budgeted `ceiling` in the `Remaining` snapshot at the refusal decision.
  - The shell saves the seed before returning.
  - A seed-save failure returns that typed `checkpoint-write-failed` error and does not swallow it. This is the same fail-closed rule as a child save; the refusal is still emitted as the `fan-refused` event.
- **Read.** The shell's existing single `checkpointer.load` already returns every entry. The shell looks up `fan-seed@<map>@0@<epoch>` and parses it with `FanRefusalSeedSchema`:
  - A corrupt entry hits the existing whole-fan corruption refusal.
  - A schema failure is a `validation` error naming the fan, so it fails closed.
  - A reroute advances the epoch, so the prior epoch's seed is never read.
- **Evaluate before any dispatch** (`initFan` input `seed: FanRefusalSeed | null`; pure `ceilingsRaised(seed.ceilings, remaining)` in `fan/seed.ts`):
  1. No seed: the normal probe (AS-009).
  2. Seed present and unreplayed work = 0: reduce normally. The drain may have finished everything.
  3. Seed present, unreplayed > 0, and **no ceiling raised**: sticky refusal. The machine goes straight to `fan-done` with `fan-budget-refused` (completed = replayed count, remaining = unreplayed, the seeded estimate, `effectiveConcurrency` = current) and dispatches 0 children.
     - This is deterministic regardless of remainder size (including ≤ C) or per-child cost variation, which addresses the report's "constant per-child cost" objection.
     - Ceilings cannot change without a redeploy (OOS-004, FR-052), so "not raised" means "no redeploy".
  4. Seed present, a ceiling raised (a redeploy with a larger budget): the estimator starts from the seeded samples, there is **no unprojected probe**, and projection runs before every dispatch, including the first (amended FR-010). If the raise is sufficient, the fan completes (AS-015), reusing every saved index; otherwise it refuses again with a refreshed seed.
- **`ceilingsRaised(seeded, current)`** is true iff:
  - `current` is `unbudgeted`;
  - or any seeded axis is absent from `current`;
  - or some axis has `current.limit > seeded.limit`.
  - Lowered or equal limits keep the refusal sticky.

**Why:** This makes AS-014 hold in 100% of runs, as SC-008 requires, without assuming constant per-child cost. It persists only what projection needs, additively (AD-9). After a raise, projection starts from real data instead of spending an extra probe batch.

**Rejected:**
- Re-probing on resume: it spends up to C more children per resume and is non-deterministic when the remainder is ≤ C.
- Persisting samples on every completion: this writes on the hot path for a refusal-only need.
- Skipping the seed and relying on the per-call meter: this produces the wrong error kind.

### AD-12: FR-018 overshoot — the provable statement (spec amended in round 1)

**Choice:** Under largest-seen, with C = effective concurrency and M = AD-3's measured per-child maximum, the tests prove exactly the amended FR-018:
- **(a) Post-refusal ≤ (C−1)·M, unconditionally.** At the refusal decision the refused dispatch would have taken the C-th slot, so at most C−1 children are in flight, and each one's remaining spend is ≤ its window ≤ M.
- **(b) No post-probe overshoot when spike-free.** "Spike-free" means every child's measured spend is ≤ the estimate in force at its admission. Let t* be the last admission. Then `spend(t*) + R(t*)·e(t*) ≤ ceiling` holds there. Every child still to spend was admitted at or before t*, under estimates that never decrease under largest-seen, so final spend ≤ ceiling. With (a), total post-probe overshoot ≤ (C−1)·M.
  - On lower-bound axes (unpriced or unknown-usage), (b) holds against the known lower bound.
- **(c) Probe carve-out ≤ C·M** (plus the host per-call meter). Once the probe has overshot, the first post-probe projection sees `amount = 0` and refuses any child with a non-zero estimate.
- **(d) A cost spike** (a child above the estimate at its admission) is bounded only by the host per-call meter (FR-019). This is pinned by an example test and documented in ADR-0087.

**Why:** This is the round-1 user decision. I tightened the wording into (a)–(d) because "post-probe overshoot ≤ (C−1)·M" is false in general. At C=1, a child costing 100× everything seen before is admitted on the old estimate and overshoots by more than 0 = (C−1)·M. The spec Change Log records this precision.

**Rejected:**
- Proving the unconditional "(C−1)·M post-probe" claim, which cannot be proven.
- Projecting the probe batch, which has no estimate (AS-009).

### AD-13: C=1 equivalence is defined over FR-004's trace

**Choice:** At effective concurrency 1, the following are byte-identical to today, verified against a golden trace recorded from the pre-change `runMappedFan` (SC-001): dispatch order, checkpoint `load`/`setMeta`/`saveNode` calls and their order, reducer input, and returned errors.
- The new observer events are additive and outside the FR-004 trace.
- A budgeted C=1 fan whose projection breaches now refuses (and writes a seed), which is earlier than today's meter-only stop. That is US2 working as intended.
- The equivalence suite therefore runs unbudgeted and within-budget fixtures, and also covers AS-028 (host max 1).

**Why:** It makes "identical" a checkable contract.

---

## File Structure

### Types (framework `types/`, pure)

```
packages/framework/src/types/fan-scheduling.ts            — NEW: ChildConcurrency, FanConcurrencyCap brands + ctors/parsers, FanEstimator, DEFAULT_FAN_CONCURRENCY_CAP=8, FanScheduling, SpendSample, FanRefusal, FanFailureCauses, FanRefusalSeed + FanRefusalSeedSchema (zod, version 1), FAN_SEED_NAMESPACE="fan-seed"
packages/framework/src/types/fan-scheduling.test.ts       — NEW (incl. seed schema round-trip, lossless JSON)
packages/framework/src/types/dag.ts                        — MapNodeDef.mapping gains `scheduling: FanScheduling`
packages/framework/src/types/errors.ts                     — fan-budget-refused, fan-child-failed variants; persisted schema; formatFrameworkError; retriabilityOf
packages/framework/src/types/error-factories.ts            — frameworkError.fanBudgetRefused / fanChildFailed (sole constructors, INV-2)
packages/framework/src/types/events.ts                     — FanStartEvent, FanProjectionEvent, FanRefusedEvent in ObserverEvent union
packages/framework/src/types/index.ts                      — exports
packages/framework/src/__tests__/fan-errors.test.ts        — NEW: format, retriability, persisted round-trip of all FanFailureCauses arms
```

### Fan core (framework `dag-runtime/fan/`, pure — `pureModules` entry added)

```
packages/framework/src/dag-runtime/fan/fan-machine.ts                 — NEW: LC-1 FanState/FanEvent/FanCommand/fanStep, initFan (seed-aware)
packages/framework/src/dag-runtime/fan/projection.ts                  — NEW: project(remaining, remainingChildren, estimate)
packages/framework/src/dag-runtime/fan/estimator.ts                   — NEW: estimate(samples, estimator) (nearest-rank)
packages/framework/src/dag-runtime/fan/spend-window.ts                — NEW: spendDelta(before, after) → SpendSample
packages/framework/src/dag-runtime/fan/error-order.ts                 — NEW: orderFailures + finishError(failures, refusal, aborted)
packages/framework/src/dag-runtime/fan/effective-concurrency.ts       — NEW: effectiveConcurrency(authored, cap)
packages/framework/src/dag-runtime/fan/seed.ts                        — NEW: seedFrom(state), ceilingsRaised(seeded, remaining), ceilingsOfRemaining(remaining)
packages/framework/src/dag-runtime/fan/__tests__/projection.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/estimator.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/error-order.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/seed.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/fan-machine.test.ts
packages/framework/src/dag-runtime/fan/__tests__/fan-machine.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/fan-overshoot.property.test.ts   — SC-004 (a)(b)(c) over a simulated spend model
packages/framework/src/dag-runtime/fan/__tests__/effective-concurrency.test.ts
```

### Fan shell (framework, imperative)

```
packages/framework/src/dag-runtime/run-mapped-fan.ts       — REWRITE as thin shell: corruption refusal + setMeta (unchanged), seed lookup/parse, initFan, interpreter loop, runSlot (today's body + spend window), persist-seed, event emission
packages/framework/src/dag-runtime/execution-scope.ts      — root scope gains `fan: FanRuntime`
packages/framework/src/dag-runtime/run-dag-stateful.ts     — DagRunOpts.fanConcurrencyCap; build FanRuntime in runDagStatefulOutcome
packages/framework/src/dag-runtime/run-node.ts             — pass execution.scope.fan to runMappedFan
packages/framework/src/executor/run-dag.ts                 — forward fanConcurrencyCap through runResumableDagJob opts
packages/framework/src/__tests__/fan-test-harness.ts       — NEW: deterministic deferred-child harness (controllable resolve order, scripted Spend timeline, ceiling-raise simulation)
packages/framework/src/__tests__/map-fan-concurrency.test.ts      — NEW: AS-002..013, 019..024, FR-025 mixed drain, cost-spike example (FR-018 d)
packages/framework/src/__tests__/map-fan-interleaving.property.test.ts — NEW: SC-003/006/007 over arbitrary interleavings
packages/framework/src/__tests__/map-fan-c1-equivalence.test.ts   — NEW: golden trace vs pre-change runner (SC-001)
packages/framework/src/__tests__/fixtures/fan-c1-golden.json      — NEW: recorded from merge-base runner
packages/framework/src/__tests__/map-fan-resume.test.ts           — NEW: AS-014/015/024/056, SC-008 (remainder ≤ C, non-constant cost), SC-009, AS-008 seed-ignored-on-reroute
```

### Authoring surface

```
packages/framework/src/nodes/map.ts                        — childConcurrency/estimator config; parse once; freeze into mapping.scheduling
packages/framework/src/shared/validate-dag.ts              — snapshotMapping copies/validates scheduling (forged values → validation error naming node)
packages/framework/src/cli/authored.ts                     — MapNodeSchema: childConcurrency (int ≥1), estimator (enum) optional
packages/framework/src/cli/authored-codegen.ts             — emit childConcurrency/estimator when present
packages/framework/src/describe/build-described-dag.ts     — project scheduling into described map metadata
packages/framework/src/__tests__/map-node.test.ts          — extend (AS-029, AS-051)
packages/framework/src/__tests__/cli/authored-map.test.ts  — extend (schema + codegen)
packages/framework/src/__tests__/fan-fingerprint.test.ts   — NEW: fingerprint independent of scheduling (AD-9)
```

### Host

```
packages/host/src/domain/config.ts                         — FAN_CHILD_CONCURRENCY_MAX (default 8, int ≥1)
packages/host/src/hitl/adapters/run-executor.ts            — pass fanConcurrencyCap(config value) into runResumableDagJob
packages/host/src/domain/framework-error-http.ts           — classify fan-budget-refused / fan-child-failed (exhaustive)
packages/host/src/__tests__/config.test.ts                 — default 8, value 1, invalid → startup error naming setting (SC-011, AS-030)
packages/host/src/__tests__/integration/mapped-host-composition.test.ts — extend: cap applied end-to-end, clamp warning + event, real-ledger refusal → seed in Redis hash → sticky refusal across restart → redeploy with raised ceiling completes
```

### Docs

```
docs/adr/0087-concurrent-fan-scheduling-and-whole-fan-projection.md — NEW
docs/adr/0086-root-owned-mapped-child-execution.md         — amend "Bounded v1" + Consequences: sequential superseded by ADR-0087
docs/adr/0085-composite-checkpoint-addressing-is-port-contract-on-every-backend.md — note the `fan-seed` namespace as a second fan address space (no grammar change)
docs/adr/README.md                                         — index entry
docs/plans/2026-09-06-f1-runtime-width-fanout.md           — §12 "The fan is sequential" superseded; §13 contract update
packages/host/README.md, packages/host/docs/deployment.md  — FAN_CHILD_CONCURRENCY_MAX, distinct from run-level limits; resume-after-refusal (sticky until redeploy raises a ceiling); FR-018 (a)–(d) incl. probe carve-out and cost-spike; percentile best-effort
CONTEXT.md                                                 — terms: Child Concurrency, Fan Concurrency Cap, Effective Concurrency, Probe Batch, Projection, Per-Child Estimate, Fan Budget Refusal, Refusal Seed, Cost Spike, Drain
```

---

## Component Design

### Fan scheduling types

**Responsibility:** Parse-don't-validate brands, closed unions and persisted seed schema for fan scheduling.
**Files:** `packages/framework/src/types/fan-scheduling.ts`
**Interface:**

```ts
export type ChildConcurrency = number & { readonly [__childConcurrency]: true };
export type FanConcurrencyCap = number & { readonly [__fanCap]: true };
export type FanEstimator = "largest-seen" | "p50" | "p90" | "p95";
export const DEFAULT_FAN_CONCURRENCY_CAP: FanConcurrencyCap; // 8
export const childConcurrency: (n: number) => ChildConcurrency;   // throws at definition sites
export const parseChildConcurrency: (nodeId: NodeId, n: unknown) => Result<ChildConcurrency, FrameworkError>;
export const fanConcurrencyCap: (n: number) => FanConcurrencyCap;
export const parseFanEstimator: (nodeId: NodeId, v: unknown) => Result<FanEstimator, FrameworkError>;
export type FanScheduling = Readonly<{ childConcurrency: ChildConcurrency; estimator: FanEstimator }>;
export type SpendSample = Readonly<{ tokens: number; calls: number; usdMicros: MicroUsd; lowerBound: boolean }>;
export type FanRefusal = Readonly<{
  axis: "tokens" | "calls" | "usd"; ceiling: Ceiling; perChildEstimate: number;
  estimatorApplied: FanEstimator; effectiveConcurrency: number;
  completed: number; remaining: number; lowerBound: boolean; hint: string;
  scopePath: readonly Readonly<{ mapNodeId: NodeId; index: MapIndex }>[];   // [] in D1
}>;
export type FanFailureCauses =
  | { kind: "secondaries"; secondary: readonly [IndexedError, ...IndexedError[]] }
  | { kind: "refusal"; refusal: FanRefusal }
  | { kind: "secondaries-and-refusal"; secondary: readonly [IndexedError, ...IndexedError[]]; refusal: FanRefusal };
export type FanRefusalSeed = Readonly<{ version: 1; estimator: FanEstimator; samples: readonly SpendSample[];
  estimate: SpendSample; ceilings: readonly Ceiling[]; refusal: FanRefusal }>;
export const FanRefusalSeedSchema: z.ZodType<FanRefusalSeed>;
export const FAN_SEED_NAMESPACE = "fan-seed";
```

**Depends on:** none

### Fan errors and events

**Responsibility:** Typed, persisted, formatted outcomes and self-contained structured observability for fans.
**Files:** `types/errors.ts`, `types/error-factories.ts`, `types/events.ts`
**Interface:**

```ts
| { kind: "fan-budget-refused"; nodeId: NodeId; refusal: FanRefusal }
| { kind: "fan-child-failed"; nodeId: NodeId; primary: IndexedError; causes: FanFailureCauses }

FanStartEvent      { type: "fan-start"; runId; dagId; nodeId; width; replayed; seeded: boolean; authored; cap; effective; clamped; estimator }
FanProjectionEvent { type: "fan-projection"; runId; dagId; nodeId; effectiveConcurrency; axis; estimate; estimatorApplied; remainingChildren; verdict: "admit" | "refuse"; lowerBound }
FanRefusedEvent    { type: "fan-refused"; runId; dagId; nodeId; refusal: FanRefusal; sticky: boolean; attachedToChildFailure: boolean }
```

`FanRefusedEvent.refusal.effectiveConcurrency` makes the event self-contained (AS-012, FR-060).

**Depends on:** Fan scheduling types

### Fan pure helpers

**Responsibility:** Total, pure arithmetic for spend windows, estimation, projection, error assembly, effective concurrency and seed evaluation.
**Files:** `dag-runtime/fan/{spend-window,estimator,projection,error-order,effective-concurrency,seed}.ts`
**Interface:**

```ts
spendDelta(before: Spend, after: Spend): SpendSample                          // per-axis max(0, after−before)
estimate(samples: readonly SpendSample[], e: FanEstimator): Readonly<{ perChild: SpendSample; applied: FanEstimator }>
project(remaining: Remaining, remainingChildren: number, est: SpendSample):
  | { kind: "admit"; checks: readonly AxisCheck[] }
  | { kind: "breach"; axis; ceiling; projected; estimate; lowerBound }       // first breached in ceiling order
orderFailures(fs: readonly IndexedError[]): Readonly<{ primary: IndexedError; secondary: readonly IndexedError[] }>
finishError(nodeId, failures, refusal: FanRefusal | null, aborted: boolean): FrameworkError
  // bare primary | fan-child-failed{causes} | fan-budget-refused | aborted — AD-6 precedence
effectiveConcurrency(authored: ChildConcurrency, cap: FanConcurrencyCap): Readonly<{ effective: number; clamped: boolean }>
ceilingsOfRemaining(r: Remaining): readonly Ceiling[]
ceilingsRaised(seeded: readonly Ceiling[], current: Remaining): boolean
```

**Depends on:** Fan scheduling types, Fan errors (factories); `types/budget-capability.ts`, `types/spend.ts`

### Fan machine (LC-1)

**Responsibility:** Decide which indices start, when projection runs, when draining begins, whether a seed is persisted, and the single final outcome.
**Files:** `dag-runtime/fan/fan-machine.ts`
**Interface:**

```ts
type DrainCause = Readonly<{ failures: readonly IndexedError[]; refusal: FanRefusal | null; aborted: boolean }>;
type FanPhase =
  | { phase: "fan-dispatching" }
  | { phase: "fan-draining"; cause: DrainCause }
  | { phase: "fan-done"; finish: FanFinish };
type FanFinish = { kind: "reduce"; ordered: readonly unknown[] } | { kind: "fail"; error: FrameworkError };
type SlotOutcome =
  | { kind: "replayed"; value: unknown }
  | { kind: "completed"; value: unknown; sample: SpendSample }
  | { kind: "failed"; error: FrameworkError; sample?: SpendSample };
type FanEvent =
  | { type: "start"; admission: Remaining }
  | { type: "slot-settled"; index: MapIndex; outcome: SlotOutcome; admission: Remaining }
  | { type: "abort" };
type FanCommand =
  | { type: "replay"; index: MapIndex }
  | { type: "dispatch"; index: MapIndex }
  | { type: "emit-projection"; record: ProjectionRecord }
  | { type: "emit-refused"; refusal: FanRefusal; sticky: boolean; attachedToChildFailure: boolean }
  | { type: "persist-seed"; seed: FanRefusalSeed }      // always immediately precedes finish when a refusal exists
  | { type: "finish"; finish: FanFinish };
initFan(cfg: { nodeId; width; replayedIndices: ReadonlySet<number>; effective: number;
               estimator: FanEstimator; seed: FanRefusalSeed | null }): FanState
fanStep(s: FanState, e: FanEvent): Readonly<{ state: FanState; commands: readonly FanCommand[] }>
```

**Rules:**
- Indices start in ascending order, and replays are emitted before any dispatch of a higher index.
- Without a seed, the first `min(effective, unreplayed)` dispatches are the unprojected probe. With a seed, there is no probe: either the AD-11 sticky refusal fires at `start`, or every dispatch is projected.
- `inFlight ≤ effective` always holds.
- `fan-done` is reached only at `inFlight = 0`, and its outcome comes from `finishError`/reduce per AD-6.
- A replay-parse failure or a save failure is a `failed` outcome for that index.

**Depends on:** Fan pure helpers, Fan errors and events

### Fan shell (`runMappedFan`)

**Responsibility:** Run the I/O around the machine. That means width resolution, the checkpoint load and corruption refusal (unchanged, before any dispatch), seed lookup and parse, `setMeta` seeding, the interpreter loop, `runSlot`, budget sampling, seed persistence, event emission and the reducer call.
**Files:** `dag-runtime/run-mapped-fan.ts`, `dag-runtime/execution-scope.ts`, `dag-runtime/run-node.ts`, `dag-runtime/run-dag-stateful.ts`, `executor/run-dag.ts`
**Interface:**

```ts
type FanRuntime = Readonly<{ budget: BudgetCapability | null; cap: FanConcurrencyCap; logger: Logger }>;
// ExecutionScope root: { kind: "root"; executeMappedChild; fan: FanRuntime }
runMappedFan(node, input, ctx, executionEpoch, executeChild, fan: FanRuntime, now): Promise<Result<unknown, FrameworkError>>
interface DagRunOpts { /* … */ readonly fanConcurrencyCap?: FanConcurrencyCap }
```

**Interpreter loop:**
1. `fanStep(start)`.
2. Execute the commands. `dispatch` adds `runSlot(i)` to the in-flight map. `persist-seed` awaits `saveNode` under the `fan-seed` namespace.
3. `await Promise.race(inFlight)`.
4. Check abort, then step `slot-settled` with a fresh `remaining()` snapshot.
5. Repeat until `finish`.

Never `Promise.all`; never return with pending slots.

**Depends on:** Fan machine, Fan scheduling types

### Authoring surface

**Responsibility:** Accept, validate, freeze, generate and describe `childConcurrency`/`estimator`.
**Files:** `nodes/map.ts`, `shared/validate-dag.ts`, `cli/authored.ts`, `cli/authored-codegen.ts`, `describe/build-described-dag.ts`
**Interface:**
- `MapExecutionConfig` gains `childConcurrency?: number; estimator?: FanEstimator`.
- AuthoredDag `map` gains the same optional strict fields.
- An invalid value is rejected with an error naming the node and the value (AS-029, AS-051).

**Depends on:** Fan scheduling types

### Host cap

**Responsibility:** Operator-controlled host-wide cap, validated at startup and applied to every run.
**Files:** `packages/host/src/domain/config.ts`, `packages/host/src/hitl/adapters/run-executor.ts`, `packages/host/src/domain/framework-error-http.ts`
**Interface:**
- `FAN_CHILD_CONCURRENCY_MAX: z.coerce.number().int().min(1).default(8)`.
- `runResumableDagJob(dag, input, ctx, { …, fanConcurrencyCap: fanConcurrencyCap(config.FAN_CHILD_CONCURRENCY_MAX) })`.
- HTTP classification: `fan-budget-refused` maps to the same class as `llm-budget-exceeded`; `fan-child-failed` delegates to the primary's class.

**Depends on:** Fan scheduling types, Fan errors

---

## Data Flow

```
run-node (map) ─▶ runMappedFan(shell)
   resolveMappedItems ─▶ checkpointer.load ─▶ corrupt? ─▶ err(checkpoint-corrupt)  [0 dispatches]
   lookup fan-seed@<map>@0@<epoch> ─▶ FanRefusalSeedSchema ─▶ seed | null
   effectiveConcurrency(authored, cap) ─▶ warn + fan-start event
   initFan(replayedIndices, seed) ─▶ fanStep(start, remaining())
      ├▶ seed && !ceilingsRaised ─▶ emit-refused(sticky) ─▶ persist-seed ─▶ finish(fail fan-budget-refused)   [0 dispatches]
      └▶ commands: replay(i) | dispatch(i) | emit-* | persist-seed | finish
   runSlot(i): spent()₀ ─▶ executeChild ─▶ childOutputSchema ─▶ saveNode ─▶ spent()₁ ─▶ spendDelta
      └▶ fanStep(slot-settled(i, outcome, remaining()))  … loop (Promise.race over ≤ C slots)
   finish.reduce(ordered) ─▶ (abort gate) ─▶ mapping.reduce   |   finish.fail(error) ─▶ err(error)
```

The machine sees only data. All I/O, time and budget reads live in the shell.

---

## Lifecycles

### LC-1: Fan scheduler lifecycle

**Machine file:** `packages/framework/src/dag-runtime/fan/fan-machine.ts`
**Kind:** typed-reducer
**States:** fan-dispatching, fan-draining, fan-done

| Event | From | To |
|---|---|---|
| start (seed present, ceilings not raised, unreplayed > 0: sticky refusal) | fan-dispatching | fan-done |
| start (no unreplayed work after replays) | fan-dispatching | fan-done |
| start (unseeded: dispatch probe batch; seeded and raised: projected dispatch) | fan-dispatching | fan-dispatching |
| start (seeded and raised; first projection breaches) | fan-dispatching | fan-done |
| slot-settled (completed or replayed; more work or in-flight) | fan-dispatching | fan-dispatching |
| slot-settled (completed; projection breach before next dispatch) | fan-dispatching | fan-draining |
| slot-settled (failed, terminal) | fan-dispatching | fan-draining |
| slot-settled (last slot; nothing pending, nothing in flight) | fan-dispatching | fan-done |
| abort | fan-dispatching | fan-draining |
| slot-settled (in-flight remain; failures accumulate) | fan-draining | fan-draining |
| slot-settled (last in-flight slot) | fan-draining | fan-done |
| abort (recorded on cause; never overrides failure or refusal) | fan-draining | fan-draining |

`fan-done` is terminal: any event there returns the same state and no commands, which the property tests pin. When draining is entered with zero in-flight slots, the machine goes straight to `fan-done`. Every transition into `fan-done` whose cause has `refusal ≠ null` emits `emit-refused` then `persist-seed` then `finish`, in that order.

---

## Invariants

### INV-1: Fan phase literals only in the machine file

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-fan-phase-literals-in-machine.json`
**Statement:** The literals `"fan-dispatching"`, `"fan-draining"` and `"fan-done"` appear only in `dag-runtime/fan/fan-machine.ts` (tests excepted). Every other module consumes phases through the machine's exported guards and types and never re-implements transitions.

### INV-2: Fan errors constructed only via factories

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-2-fan-errors-via-factory.json`
**Statement:** No object literal with `kind: "fan-budget-refused"` or `kind: "fan-child-failed"` is built outside `types/error-factories.ts` (tests excepted). Every refusal, bare or attached, therefore carries the redeploy hint, effective concurrency, the lower-bound flag and estimator-applied fields (FR-014, FR-025).

### INV-3: Fan concurrency brands only from smart constructors

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-3-no-raw-fan-brand-cast.json`
**Statement:** `ChildConcurrency` and `FanConcurrencyCap` are never produced by an `as` cast outside `types/fan-scheduling.ts` (tests excepted).

### INV-4: Fan core is pure

**Tier:** advisory
**Statement:** `dag-runtime/fan/` has no I/O, no `Date.now`/`Math.random`, no async and no `Promise` usage.
- **Backstop:** `packages/framework/src/dag-runtime/fan/` is in `.claude/linter/rules/config.json` `pureModules`. The programmatic purity rule enforces it, but only in the full/wave-gate lint tier, not on every edit.
- It is tiered advisory because no per-edit regex rule can be scoped to that directory.

### INV-5: Ordering, bounds and refusal determinism

**Tier:** advisory
**Statement:** The following are behavioural properties enforced by the property suites (≥1,000 cases each), not lint:
- in-flight ≤ C (FR-003);
- index-ordered reduce (FR-005);
- lowest-index primary with complete secondaries and the refusal attached (FR-021, FR-025);
- no reduce after refusal or abort (FR-016);
- FR-018 (a)–(c);
- sticky refusal with 0 dispatches (FR-017).

### INV-6: No interpreter return with pending slots; no `Promise.all` in the fan interpreter

**Tier:** advisory
**Statement:** `runMappedFan` awaits every in-flight slot before returning (AD-10). This is not regex-checkable without path scoping, because `wave-execution.ts` legitimately uses `Promise.all`. It is enforced by harness tests asserting zero pending slot promises at return.

---

## Implementation Phases

Eleven tasks in five waves. The machine → shell → integration chain is inherently serial, so waves 3–5 are narrower than the 4–6 target. That is deliberate and unavoidable.

### Phase 1: Foundations (no dependencies)

- **T1: Fan scheduling types.**
  - Brands and parsers, `FanEstimator`, `DEFAULT_FAN_CONCURRENCY_CAP`, `FanScheduling`, `SpendSample`, `FanRefusal`, `FanFailureCauses`, `FanRefusalSeed` + `FanRefusalSeedSchema`, `FAN_SEED_NAMESPACE`.
  - Add `mapping.scheduling` to `MapNodeDef`, add `DagRunOpts.fanConcurrencyCap` (type only), and export them.
  - **Files:** `types/fan-scheduling.ts`, `types/fan-scheduling.test.ts`, `types/dag.ts`, `types/index.ts`, `dag-runtime/run-dag-stateful.ts` (opts field only)
- **T2: Fan errors.**
  - Add both kinds (`fan-budget-refused { refusal }`; `fan-child-failed { primary, causes }`) and their factories.
  - Add the persisted schema entries, `formatFrameworkError` and `retriabilityOf`.
  - Classify both kinds in the host's HTTP error mapping.
  - Imports `FanRefusal`/`FanFailureCauses` from T1. If T1 has not merged, stub the two type aliases locally and reconcile on merge.
  - **Files:** `types/errors.ts`, `types/error-factories.ts`, `__tests__/fan-errors.test.ts`, `packages/host/src/domain/framework-error-http.ts`
- **T3: Fan observer events.** Add the three event variants (the refusal event embeds `FanRefusal`, which carries `effectiveConcurrency`) and fix exhaustive consumers flagged by `tsc`.
  - **Files:** `types/events.ts`, exhaustive consumers found
- **T4: Host config.** Add `FAN_CHILD_CONCURRENCY_MAX` with startup validation and tests.
  - **Files:** `packages/host/src/domain/config.ts`, `packages/host/src/__tests__/config.test.ts`

### Phase 2: Pure helpers, authoring, host plumbing, docs (depends on Phase 1)

- **T5: Fan pure helpers + property tests.** `spendDelta`, `estimate`, `project`, `orderFailures`, `finishError` (AD-6 precedence), `effectiveConcurrency`, `ceilingsOfRemaining`, `ceilingsRaised`. Covers SC-005, SC-014, SC-006 (helper level) and FR-025 assembly.
  - **Files:** `dag-runtime/fan/{spend-window,estimator,projection,error-order,effective-concurrency,seed}.ts` + `__tests__/{projection,estimator,error-order,seed}.property.test.ts`, `__tests__/effective-concurrency.test.ts`
- **T6: Authoring surface.** `createMapNode`/`createCollectMapNode` config, `snapshotMapping`, AuthoredDag schema, codegen, describe, and the fingerprint-independence test.
  - **Files:** `nodes/map.ts`, `shared/validate-dag.ts`, `cli/authored.ts`, `cli/authored-codegen.ts`, `describe/build-described-dag.ts`, `__tests__/map-node.test.ts`, `__tests__/cli/authored-map.test.ts`, `__tests__/fan-fingerprint.test.ts`
- **T7: Host cap plumbing.** `run-executor` passes `fanConcurrencyCap(...)`, and `runResumableDagJob` forwards it.
  - **Files:** `packages/host/src/hitl/adapters/run-executor.ts`, `packages/framework/src/executor/run-dag.ts`
- **T8: Docs.**
  - ADR-0087 (AD-1..AD-13 condensed; the AD-12 statement (a)–(d) verbatim; AD-11 seed lifecycle; percentile best-effort).
  - Amend ADR-0086, note on ADR-0085, ADR index.
  - F1 plan §12/§13.
  - Host README and deployment docs.
  - CONTEXT.md terms. The fan-runner header comment is rewritten in T10.
  - **Files:** `docs/adr/0087-*.md`, `docs/adr/0086-*.md`, `docs/adr/0085-*.md`, `docs/adr/README.md`, `docs/plans/2026-09-06-f1-runtime-width-fanout.md`, `packages/host/README.md`, `packages/host/docs/deployment.md`, `CONTEXT.md`

### Phase 3: Fan machine LC-1 (depends on Phase 1 + T5)

- **T9: `fan-machine.ts`.** `initFan`/`fanStep`, with these property tests:
  - in-flight ≤ C;
  - dispatch ascending, with replays never dispatched;
  - unseeded probe = min(C, unreplayed) with no projection;
  - projection precedes every post-probe dispatch, and every dispatch when seeded;
  - no dispatch after drain begins;
  - `fan-done` only at in-flight = 0;
  - ordered reduce (SC-003);
  - primary = lowest index, secondaries complete, refusal attached when present (SC-006, FR-025);
  - refusal `completed` counts drain completions (FR-022);
  - `persist-seed` precedes `finish` iff a refusal exists;
  - sticky refusal: seed + not raised + unreplayed > 0 ⇒ 0 dispatches and `fan-budget-refused` (SC-008 core) for arbitrary remainders and arbitrary seeded sample distributions;
  - seed + raised ⇒ no unprojected dispatch;
  - `fan-done` is absorbing;
  - the C=1 command sequence equals sequential order;
  - `fan-overshoot.property.test.ts` drives the machine against a simulated run-wide spend model with arbitrary per-child costs and interleavings and asserts FR-018 (a) always, (b) on spike-free runs, and (c) always (SC-004).
  - **Files:** `dag-runtime/fan/fan-machine.ts`, `dag-runtime/fan/__tests__/fan-machine.test.ts`, `dag-runtime/fan/__tests__/fan-machine.property.test.ts`, `dag-runtime/fan/__tests__/fan-overshoot.property.test.ts`

### Phase 4: Shell wiring (depends on Phase 3 + T7)

- **T10: `runMappedFan` interpreter.**
  - Thread `FanRuntime` through `ExecutionScope` root → `run-node` → `runMappedFan`, and build it in `runDagStatefulOutcome`.
  - Implement seed lookup and parse (`fan-seed` namespace, current epoch), the interpreter loop, `runSlot` with the spend window, and `persist-seed` via `saveNode` (fail closed).
  - Add event emission, the clamp `logger.warn` and span attributes (`fugue.fan.effective_concurrency`, `fugue.fan.clamped`, `fugue.fan.seeded`).
  - Build the deterministic harness, the example tests (including the FR-025 mixed drain and the FR-018 (d) cost-spike example, where the per-call meter stops it) and the interleaving property tests.
  - Rewrite the header comment (FR-062).
  - **Files:** `dag-runtime/run-mapped-fan.ts`, `dag-runtime/execution-scope.ts`, `dag-runtime/run-node.ts`, `dag-runtime/run-dag-stateful.ts`, `__tests__/fan-test-harness.ts`, `__tests__/map-fan-concurrency.test.ts`, `__tests__/map-fan-interleaving.property.test.ts`

### Phase 5: Equivalence, resume and host integration (depends on Phase 4)

- **T11: Integration closure.**
  - **C=1 golden equivalence (SC-001, AS-001, AS-028):** capture the fixture from the merge-base runner first.
  - **Speedup (SC-002):** fake clock, N ∈ {1, C−1, C, C+1, 5C}.
  - **Resume:**
    - SC-008 refusal → resume without redeploy refuses again with 0 dispatches, for remainder > C, remainder ≤ C, and non-constant per-child costs;
    - redeploy with a raised ceiling completes with 0 re-dispatch of saved indices (AS-015);
    - drain-saved reuse (SC-007, AS-024);
    - seed ignored after reroute (AS-008, FR-026);
    - corrupt seed entry → whole-fan refusal (SC-009 path);
    - corruption at C>1 → 0 dispatches (SC-009).
  - **Host composition:**
    - default cap 8 and cap 1 (SC-011);
    - clamp produces exactly 1 warn and 1 `fan-start{clamped}` (SC-010);
    - real-Redis refusal → seed visible in the `$nodes` hash → sticky refusal across a process restart.
  - **Files:** `__tests__/map-fan-c1-equivalence.test.ts`, `__tests__/fixtures/fan-c1-golden.json`, `__tests__/map-fan-resume.test.ts`, `packages/host/src/__tests__/integration/mapped-host-composition.test.ts`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Fan scheduling types | ctor/parse accept/reject, defaults; seed schema rejects wrong version and extra fields | — | seed encode → JSON → `FanRefusalSeedSchema` round-trip (lossless) |
| Fan errors/events | format text includes redeploy hint, effective concurrency and lower-bound wording; retriability (refusal non-retriable, `fan-child-failed` follows primary) | persisted round-trip of `fan-budget-refused` and all three `FanFailureCauses` arms; host HTTP class | — |
| Pure helpers | estimator fallback at 0/1/4 samples, percentile from 5th (SC-014); projection per kind; `ceilingsRaised` table (raise, lower, equal, removed axis, unbudgeted) | — | projection across all headroom kinds (SC-005); nearest-rank ∈ samples and monotone in p; `finishError` precedence and no-drop (FR-021, FR-025, SC-006); `ceilingsRaised` false for any pointwise ≤ |
| Fan machine (LC-1) | scripted scenario per LC-1 row; absorbing `fan-done`; seed paths | — | in-flight ≤ C; ordered reduce (SC-003); sticky refusal 0 dispatches for arbitrary remainders/samples (SC-008 core); FR-018 (a)(b)(c) over a simulated spend model (SC-004); C=1 command order = sequential |
| Fan shell | AS-002..013, 019..024; FR-025 mixed drain; FR-018 (d) spike stopped by meter; zero pending slots at return; seed-save failure fails closed | in-memory and file checkpointers: seed persisted and reloaded | arbitrary interleavings × failure sets: saved-index reuse, 0 re-dispatch (SC-007) |
| Authoring surface | AS-029/051 errors name node and value; codegen emits fields; describe shows scheduling | authored → codegen → defineDag round-trip | fingerprint invariant under arbitrary scheduling |
| Host cap | config default 8 / 1 / invalid (AS-025, AS-030) | composition: cap applied, clamp warn + event, real-Redis refusal → seed → sticky refusal across restart → raised ceiling completes | — |

The deterministic harness gives each child a manually resolved deferred and gives the budget a scripted `Spend` timeline with a mutable ceiling to simulate a redeploy. No real timers are used; the SC-002 timing test uses a fake clock.

---

## Security & NFR Notes

- **Authority:** The framework only reads `BudgetCapability` from the root-owned `FanRuntime`; there are no writes and no new port (FR-012, OOS-001). The seed is written through the fan's existing `checkpointer` port under its own namespace. The host per-call meter stays the hard stop (FR-019) and the only bound on a cost spike (FR-018 d).
- **Resource safety:** Concurrency is bounded by min(authored, operator cap). An operator setting cap = 1 restores sequential behaviour host-wide (FR-031).
- **Performance:** The scheduler is O(1) per step apart from estimator sorting, which is O(n log n) on settled samples per projection. The seed is at most `maxWidth` samples and is written only on refusal.
- **Determinism:** With concurrency fixed at C, reducer input, errors, saved indices and resume-after-refusal outcomes are interleaving-independent. Only event timing varies.

---

## Verification

1. `bun run typecheck` passes (exhaustive `FrameworkError`, `ObserverEvent` and persisted-schema checks catch missed consumers).
2. `bun run test` is green. That includes the fan property suites (≥1,000 cases each) and `map-fan-c1-equivalence.test.ts` with 0 diffs.
3. `bun "$LOOM_DIR"/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules < /dev/null` succeeds.
4. Full-tier lint shows no purity violations under `dag-runtime/fan/`.
5. `bun run check:docs` passes.
6. Manual check: run a host with `FAN_CHILD_CONCURRENCY_MAX=1`, then with the default, on a sample map DAG (`childConcurrency: 4`) with a tight budget.
   - Observe `fan-start` and the clamp warning.
   - Observe a `fan-refused` event carrying effective concurrency, and the `fan-seed@…` entry.
   - Restart: resume refuses again with 0 dispatches. Redeploy with a larger budget: resume completes.
   - Confirm the run statuses are unchanged (FR-061).
