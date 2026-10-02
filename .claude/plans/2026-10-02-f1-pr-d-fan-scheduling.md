# Plan: F1 PR-D1 — Bounded-Concurrency Fan Scheduling with Probe-then-Project Budget Admission

**Spec:** .claude/specs/2026-10-02-f1-pr-d-fan-scheduling/spec.md
**Created:** 2026-10-02

## Summary

Runtime-width map fans gain an authored `childConcurrency` (default 1), capped host-wide by `FAN_CHILD_CONCURRENCY_MAX` (default 8). They also gain a probe-then-project whole-fan budget admission gate with a selectable per-child estimator (largest-seen | p50 | p90 | p95, nearest-rank, fallback below 5 samples). The design is **Approach B (admission core + self-contained slot tasks)**. A pure Mealy machine `fanStep` (LC-1) decides what may start next and how the fan ends: probe, projection, drain, first-error-by-index and index-ordered reduce. A tiny async interpreter in `run-mapped-fan.ts` runs per-index slot tasks that keep today's exact replay → execute → validate → save body.

This plan is **PR D1 only** (US1–US4 + US7). Nested fans (US5) and adaptive concurrency plus static sibling limits (US6, US8) are explicitly deferred to D2/D3; see **Deferred Scope**.

---

## Deferred Scope (explicit — NOT in this plan)

The user split the spec into three PRs at the interview (Q4). Implementation agents MUST NOT start any of the following. Plan-alignment should treat these spec ids as deferred, not missing.

| PR | Spec ids | Content | Interview items carried forward |
|---|---|---|---|
| **D2 — nested fans** | US5; AS-032..035, AS-047, AS-048; FR-040..043; SC-012 | Map inside a mapped child at depth 2, rejected at depth ≥3. Needs a dispatcher in the `mapped-child` `ExecutionScope` and a recursive child inventory in `prepareDagRun`. Lifts three bans: `run-node.ts:575`, `validate-dag.ts:227`, `cli/authored.ts:335`. Also needs nested refusal attribution (a scope path in `fan-budget-refused`). | Q9 (nested checkpoint addressing, where namespace encoding is the leading option) is open for the D2 run. The D1 `fan-budget-refused` reserves a `scopePath` field (AD-6) so D2 is additive. |
| **D3 — adaptive + static siblings** | US6 (AS-036..039, AS-049, AS-050, AS-055; FR-044, FR-045; SC-015) and US8 (AS-044..046, AS-052..054; FR-047..049; SC-016) | AIMD target inside `[1, effective]` driven by a throttle signal, with a `fan-concurrency-adjusted` event. Also an authored `siblingConcurrency` on static fan-out waves (`executeWave`), capped by the same host max. | Q7 (throttle-signal source, where a child-scoped observer tap is the leading option) is open for the D3 run. The D1 `fanStep` event union is closed but extensible: D3 adds a `throttle` event and an `adaptiveTarget` field without reshaping (AD-2). |

D1 keeps the D2 bans exactly as they are today (`nested mapped execution is unsupported`).

---

## Architectural Decisions

### AD-1: Approach B — pure admission core + self-contained slot tasks

**Choice:** A pure Mealy transition `fanStep(state, event) → { state, commands }` in `dag-runtime/fan/fan-machine.ts` owns admission and termination:
- probe batch
- projection before each later dispatch
- drain on failure, refusal or abort
- first-error-by-index with secondaries
- the index-ordered reduce gate

Each started index runs one async `runSlot(i)` closure in the shell. That closure is today's per-index body unchanged: replay-hit parse, or `executeChild` → `childOutputSchema` parse → `saveNode`. The interpreter is a bounded pool over `Promise.race`. It samples the budget synchronously (`spent()`/`remaining()` are sync) and feeds the snapshots into the machine as event data.

**Why:** Every invariant the spec cares about sits in one small pure machine: NFR-020, FR-005, FR-011, FR-018 and FR-021. The already-proven save path stays the same code, which makes FR-004 / SC-001 (C=1 equivalence) low-risk. This was the user's pick for the simplicity/determinism axis.

**Rejected:**
- A: full command-driven scheduler (every effect a command). Purest, but it spreads a 15-line body across about 6 command/event round trips and grows the interpreter into a small effect runtime.
- C: generic `BoundedPool` plus policy plug-ins. This is abstraction ahead of need: D1 has one consumer, and D3's static siblings deliberately get no projection (OOS-014).

### AD-2: The fan scheduler is LC-1, a closed typed reducer

**Choice:** `FanPhase = fan-dispatching | fan-draining{cause} | fan-done{finish}`. `DrainCause = failure | refusal{breach} | abort`. Illegal transitions are unrepresentable or ignored by construction (see the LC-1 table). Phase literals live only in the machine file (INV-1). D3 extends the event union with `throttle`, and the state gains `target`.

**Why:** Executable-model policy: the lifecycle is the code. Determinism and drain semantics are property-testable without async code.

**Rejected:**
- An imperative worker pool with pure helpers only. Drain and termination ordering would live in async code, where interleaving bugs hide.

### AD-3: Per-child spend = lifetime-window over-approximation

**Choice:** `runSlot` samples `budget.spent()` at slot start and at slot settle. The child's sample is the per-axis delta of that window:
- `tokens`, `calls` as integers;
- `usd` as `costFloor(usd)` in MicroUsd, flagged `lowerBound` when the spend is unpriced or unknown-usage.

Replayed indices produce no sample.

**Why:** `BudgetCapability` is run-wide. Under concurrency, a child's true cost is unobservable from it, but the window delta is never less than the child's true settled cost. It is exact at C=1. It needs no host change (OOS-001). Because it can only over-estimate, projection can only refuse earlier, never later.

**Rejected:**
- Host-tagged exact attribution (`spentFor(scope)`). It extends the capability contract and the host meter.
- Batch-average attribution. It under-estimates the largest child and breaks FR-018.

**Accepted cost:** Over-refusal of up to about (2C−1)× at high C under heavy overlap. Percentile estimators are biased high. Both are documented in ADR-0087.

### AD-4: Projection arithmetic is headroom-native and conservative

**Choice:** This is pure `project(remaining, remainingChildren, estimate)` in `fan/projection.ts`. `remainingChildren` = width − successfully completed, so it includes in-flight slots and the slot about to start. The rule per `Remaining` axis:

| Headroom kind | Refuse when | `lowerBound` |
|---|---|---|
| `unbudgeted` | never; no projection | — |
| `available` (tokens / calls / usd) | `remainingChildren × estimate[unit] > amount` (amount = ceiling − the host's projected spend, including reservations) | false |
| `unpriced` (usd) | `observedAtLeast + remainingChildren × estimate.usd > ceiling.limit` | true |
| `unknown-usage` (tokens or usd) | `observedAtLeast + remainingChildren × estimate[unit] > ceiling.limit` | true |

The first breached axis in ceiling order is reported. A null `ctx.budget` behaves as `unbudgeted`.

**Why:** It reads only the existing headroom ADT (FR-012, FR-013). The partial spend of in-flight children is counted both inside the host's projected spend and inside `remainingChildren × estimate`. That double count is deliberate and conservative.

**Rejected:**
- Re-deriving ceilings from `dag.config` in the framework. The framework never sees ceilings directly; headroom is the contract.

### AD-5: Estimators — closed union, nearest-rank, fallback below 5

**Choice:** `FanEstimator = "largest-seen" | "p50" | "p90" | "p95"`, branded and parsed in `types/fan-scheduling.ts`. `estimate(samples, estimator) → { perAxis, applied }`:
- Percentile = nearest-rank over the per-axis sample multiset.
- With fewer than 5 samples, `applied = "largest-seen"`.
- The refusal and the `fan-projection` event carry `applied`.

**Why:** FR-046 / SC-014. Nearest-rank always returns an observed integer value (MicroUsd-safe) and is conservative. No new dependencies.

**Rejected:**
- Linear-interpolation percentiles: they produce fractional MicroUsd and are less conservative.

### AD-6: Error model — `fan-budget-refused` always, `fan-child-failed` only with secondaries

**Choice:** Two new `FrameworkError` kinds, built only via `frameworkError.fanBudgetRefused` / `.fanChildFailed` (INV-2).

- `fan-budget-refused { nodeId (fan id), axis, ceiling, perChildEstimate, estimatorApplied, completed, remaining, lowerBound, hint, scopePath: readonly [] }`
  - `scopePath` is reserved and always empty in D1; D2 fills it.
  - `completed` includes children that finished during the drain (FR-022).
  - The `hint` text names "redeploy the DAG with a larger budget".
  - Non-retriable in `retriabilityOf`, so the root node retry policy never loops it.
- `fan-child-failed { nodeId, primary: { index, error }, secondary: readonly { index, error }[] (non-empty) }`
  - Returned ONLY when more than one child failed during the drain.
  - Retriability = the primary's retriability.
  - With exactly one failure (always the case at C=1), the bare child error is returned exactly as today. That keeps FR-004 error equivalence.
- If a refusal and child failures both occur, the fan returns the lowest-index child failure. Child failures outrank refusal because they are real errors. The refusal is attached as a secondary only through the `fan-refused` event, not the error.
- Abort returns the existing `{ kind: "aborted", reason: "signal" }`, which is already distinct from both new kinds (FR-024).
- Both new kinds are added to `PersistedFrameworkErrorSchemaDefinition` (the exhaustiveness type forces this), `formatFrameworkError`, and host `domain/framework-error-http.ts` (exhaustive).

**Why:** These are distinct, typed, persisted outcomes (FR-014, FR-015, FR-021), with C=1 errors unchanged.

**Rejected:**
- Always wrapping failures: this breaks C=1 equivalence.
- Reusing `llm-budget-exceeded` or `policy-refusal`: this blurs a per-call breach with a fan projection.

### AD-7: Budget and cap are root-owned fan resources, not node requirements

**Choice:** The `root` variant of `ExecutionScope` gains `fan: FanRuntime`, built once in `runDagStatefulOutcome`:

```
FanRuntime = Readonly<{ budget: BudgetCapability | null; cap: FanConcurrencyCap; logger: Logger }>
```

It is built from the root-validated base context (`validatedCtx.budget`) and `opts.fanConcurrencyCap ?? DEFAULT_FAN_CONCURRENCY_CAP` (8). `MapNodeDef.requires` stays `["checkpointer"]`. The framework only reads budget (ADR-0086 root authority, FR-012).

**Why:** It keeps the map's frozen requirement policy, so there is no capability-gate change for unbudgeted embedders. Authority stays with the root, never with the minted node overlay.

**Rejected:**
- `requires: ["checkpointer","budget"]`: the gate would refuse map DAGs without a budget.
- Conditional requires: these depend on the config, which breaks frozen map policy.

### AD-8: Concurrency surface — authored `childConcurrency`, host `FAN_CHILD_CONCURRENCY_MAX`

**Choice:**
- **Branded types** in `types/fan-scheduling.ts`:
  - `ChildConcurrency` (positive safe int) and `FanConcurrencyCap` (positive safe int).
  - Each has a throwing constructor (definition-time sites, matching the `maxWidth` precedent) and a Result-returning `parse*`.
- **Authored fields:** `childConcurrency?: number` (default 1) and `estimator?: FanEstimator` (default `"largest-seen"`).
  - They are accepted by `createMapNode`, `createCollectMapNode` and the AuthoredDag `map` schema, and emitted by codegen.
  - They are stored on `mapping.scheduling`, frozen by `snapshotMapping`.
- **Effective value:** `effectiveConcurrency(authored, cap) → { effective, clamped }` (pure). A clamp emits `logger.warn` plus a `fan-start` event with `clamped: true` (FR-033). The clamp happens once per fan start (SC-010).
- **Host:** `HostConfigSchema.FAN_CHILD_CONCURRENCY_MAX` (z coerce, int, min 1, default 8). An invalid value fails startup with an error naming the setting (FR-032). It is threaded through `run-executor.ts` into `runResumableDagJob` opts as `fanConcurrencyCap`.
  - This is operator config, not a per-run API. No HTTP or request field is added (FR-034).
- **Naming:** The names are documented beside, and distinctly from, `MAX_GLOBAL_CONCURRENCY` / `DEFAULT_DAG_CONCURRENCY` (FR-035).

**Why:** These are the user's interview picks (Q14–Q16). The `child*` prefix avoids collision with the run-level concurrency names.

**Rejected:**
- `maxConcurrency`: collides with the run-level naming.
- A nested `scheduling` authored object: more ceremony than D1 needs.
- Per-tenant config: FR-030 rules it out.

### AD-9: Purely additive persistence — no version bump, fingerprint unchanged

**Choice:**
- No `FRAMEWORK_VERSION` bump.
- `dagFingerprint` is untouched, so `scheduling` is excluded (it is non-structural; FR-051). A test pins that fingerprint(dag) is independent of `childConcurrency`/`estimator`.
- Checkpoint keys and value shape are unchanged: `dag@<map>@<index>@<epoch>`, the same as FR-007.
- The new error kinds extend the persisted schema additively.

**Why:** Index-ordered reduce makes concurrency semantically invisible to stored outputs. In-flight runs resume across the deploy (Q12).

**Rejected:**
- A version bump: it strands in-flight resumes.
- Fingerprinting the scheduling settings: changing concurrency would invalidate a resume for no semantic reason.

### AD-10: Drain and abort await in-flight slots; no fan-level retry

**Choice:**
- The interpreter never returns while any slot promise is pending.
- On a terminal failure, refusal or abort (signal checked before every start decision and after every settle), the machine stops emitting `start`. In-flight slots finish, and their successful outputs are validated and saved (FR-020, FR-023, SC-007).
- When `phase = fan-done`, a `reduce` finish is honoured only if the signal is still not aborted. This preserves today's final abort gate.
- A rejected slot promise is converted at the boundary to `node-crash` (non-retriable) for that index.
- Children keep their own node retry policies inside the same epoch (FR-009). The fan adds no retry.

**Why:** There are no orphan writes after the fan returns, and paid-for work is never lost.

**Rejected:**
- Fire-and-forget on abort.
- A fan-level transient retry.

### AD-11: Resume semantics — re-probe, and an honestly scoped overshoot bound

**Choice:**
- A resumed fan replays every saved `(index, epoch)` key, so replay is not dispatch and costs no probe slot. It then probes again with `min(C, unreplayed)` children. Samples are not persisted (AD-9).
- **AS-014 holds without redeploy.** Take a constant per-child cost x. Refusal happened because `R·x > H`. After a probe of k ≤ C children, `(R−k)·x > H − k·x` is the same inequality, so the fan refuses again. The k probe children are saved and reused.
  - Edge case: the unreplayed remainder ≤ C, so the whole remainder fits in the probe and projection never runs. The host per-call meter is then the stop (FR-019), surfacing as `llm-budget-exceeded`. This is documented in ADR-0087 and the error hint.
- **FR-018 / NFR-021 are implemented as the provable statement:** once the projection refuses, at most C−1 children are in flight (the refused dispatch would have been the C-th slot). Each costs ≤ M (the largest per-child spend observed by run end), so spend after the refusal point is ≤ (C−1)·M.
  - The probe batch itself is admitted without projection. Its overshoot is bounded by C·M and by the host meter, as accepted in brainstorm ("can overshoot by up to one batch").
  - **Spec tension flagged for plan-alignment:** FR-018's wording does not separate the probe from the post-refusal drain.

**Why:** It avoids persisting estimator state (no checkpoint shape change). It is exact about what can be proven, rather than asserting a bound the probe can violate.

**Rejected:**
- Persisting per-child spend on fan completions: this changes the persisted NodeState in 3 backends.
- Skipping the probe on resume: this contradicts AS-009.

### AD-12: C=1 equivalence is defined over FR-004's trace

**Choice:** At effective concurrency 1, the following are byte-identical to today, verified against a golden trace recorded from the pre-change `runMappedFan` (SC-001): dispatch order, checkpoint `load`/`setMeta`/`saveNode` calls and their order, reducer input, and returned errors.

The new `fan-start`/`fan-projection` observer events are additive and outside the FR-004 trace.

A budgeted C=1 fan whose projection breaches now refuses earlier than today's meter-only stop. That is US2 working as intended, not an equivalence break. The equivalence suite runs unbudgeted and within-budget fixtures, and also covers AS-028 (host max 1).

**Why:** It makes "identical" a checkable contract rather than a vibe.

---

## File Structure

### Types (framework `types/`, pure)

```
packages/framework/src/types/fan-scheduling.ts            — NEW: ChildConcurrency, FanConcurrencyCap brands + ctors/parsers, FanEstimator union + parser, DEFAULT_FAN_CONCURRENCY_CAP=8, FanScheduling record
packages/framework/src/types/fan-scheduling.test.ts       — NEW
packages/framework/src/types/dag.ts                        — MapNodeDef.mapping gains `scheduling: FanScheduling`
packages/framework/src/types/errors.ts                     — fan-budget-refused, fan-child-failed variants; persisted schema; formatFrameworkError; retriabilityOf
packages/framework/src/types/error-factories.ts            — frameworkError.fanBudgetRefused / fanChildFailed (sole constructors, INV-2)
packages/framework/src/types/events.ts                     — FanStartEvent, FanProjectionEvent, FanRefusedEvent in ObserverEvent union
packages/framework/src/types/index.ts                      — exports
packages/framework/src/__tests__/fan-errors.test.ts        — NEW: format, retriability, persisted round-trip
```

### Fan core (framework `dag-runtime/fan/`, pure — `pureModules` entry added)

```
packages/framework/src/dag-runtime/fan/fan-machine.ts                 — NEW: LC-1 FanState/FanEvent/FanCommand/fanStep, initFan
packages/framework/src/dag-runtime/fan/projection.ts                  — NEW: project(remaining, remainingChildren, estimate) → Admit | Breach
packages/framework/src/dag-runtime/fan/estimator.ts                   — NEW: SpendSample, estimate(samples, estimator) (nearest-rank)
packages/framework/src/dag-runtime/fan/spend-window.ts                — NEW: spendDelta(before: Spend, after: Spend) → SpendSample
packages/framework/src/dag-runtime/fan/error-order.ts                 — NEW: orderFailures(failures) → primary/secondary
packages/framework/src/dag-runtime/fan/effective-concurrency.ts       — NEW: effectiveConcurrency(authored, cap)
packages/framework/src/dag-runtime/fan/__tests__/projection.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/estimator.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/error-order.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/fan-machine.test.ts
packages/framework/src/dag-runtime/fan/__tests__/fan-machine.property.test.ts
packages/framework/src/dag-runtime/fan/__tests__/effective-concurrency.test.ts
```

### Fan shell (framework, imperative)

```
packages/framework/src/dag-runtime/run-mapped-fan.ts       — REWRITE as thin shell: corruption refusal + setMeta (unchanged), initFan, interpreter loop, runSlot (today's body + spend window), event emission
packages/framework/src/dag-runtime/execution-scope.ts      — root scope gains `fan: FanRuntime`
packages/framework/src/dag-runtime/run-dag-stateful.ts     — DagRunOpts.fanConcurrencyCap; build FanRuntime in runDagStatefulOutcome
packages/framework/src/dag-runtime/run-node.ts             — pass execution.scope.fan to runMappedFan
packages/framework/src/executor/run-dag.ts                 — forward fanConcurrencyCap through runResumableDagJob opts
packages/framework/src/__tests__/fan-test-harness.ts       — NEW: deterministic deferred-child harness (controllable resolve order, fake budget with scripted spend)
packages/framework/src/__tests__/map-fan-concurrency.test.ts      — NEW: example tests (AS-001..013, 019..024)
packages/framework/src/__tests__/map-fan-interleaving.property.test.ts — NEW: SC-003/006/007 over arbitrary interleavings
packages/framework/src/__tests__/map-fan-c1-equivalence.test.ts   — NEW: golden trace vs pre-change runner (SC-001)
packages/framework/src/__tests__/map-fan-resume.test.ts           — NEW: AS-014/015/024, SC-008, SC-009
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
packages/host/src/__tests__/integration/mapped-host-composition.test.ts — extend: cap applied end-to-end, clamp warning + event, real ledger refusal/resume
```

### Docs

```
docs/adr/0087-concurrent-fan-scheduling-and-whole-fan-projection.md — NEW
docs/adr/0086-root-owned-mapped-child-execution.md         — amend "Bounded v1" + Consequences: sequential superseded by ADR-0087
docs/adr/README.md                                         — index entry
docs/plans/2026-09-06-f1-runtime-width-fanout.md           — §12 "The fan is sequential" superseded; §13 contract update
packages/host/README.md, packages/host/docs/deployment.md  — FAN_CHILD_CONCURRENCY_MAX, distinct from run-level limits; resume-after-refusal; percentile best-effort bound
CONTEXT.md                                                 — terms: Child Concurrency, Fan Concurrency Cap, Effective Concurrency, Probe Batch, Projection, Per-Child Estimate, Fan Budget Refusal, Drain
```

---

## Component Design

### Fan scheduling types

**Responsibility:** Parse-don't-validate brands and closed unions for fan scheduling configuration.
**Files:** `packages/framework/src/types/fan-scheduling.ts`
**Interface:**

```ts
export type ChildConcurrency = number & { readonly [__childConcurrency]: true };
export type FanConcurrencyCap = number & { readonly [__fanCap]: true };
export type FanEstimator = "largest-seen" | "p50" | "p90" | "p95";
export const DEFAULT_FAN_CONCURRENCY_CAP: FanConcurrencyCap; // 8
export const childConcurrency: (n: number) => ChildConcurrency;          // throws at definition sites (maxWidth precedent)
export const parseChildConcurrency: (nodeId: NodeId, n: unknown) => Result<ChildConcurrency, FrameworkError>;
export const fanConcurrencyCap: (n: number) => FanConcurrencyCap;
export const parseFanEstimator: (nodeId: NodeId, v: unknown) => Result<FanEstimator, FrameworkError>;
export type FanScheduling = Readonly<{ childConcurrency: ChildConcurrency; estimator: FanEstimator }>;
export const DEFAULT_FAN_SCHEDULING: FanScheduling; // { 1, "largest-seen" }
```

**Depends on:** none

### Fan errors and events

**Responsibility:** Typed, persisted, formatted outcomes and structured observability for fans.
**Files:** `types/errors.ts`, `types/error-factories.ts`, `types/events.ts`
**Interface:**

```ts
| { kind: "fan-budget-refused"; nodeId: NodeId; axis: "tokens" | "calls" | "usd";
    ceiling: Ceiling; perChildEstimate: number; estimatorApplied: FanEstimator;
    completed: number; remaining: number; lowerBound: boolean; hint: string;
    scopePath: readonly Readonly<{ mapNodeId: NodeId; index: MapIndex }>[] }   // [] in D1
| { kind: "fan-child-failed"; nodeId: NodeId;
    primary: Readonly<{ index: MapIndex; error: FrameworkError }>;
    secondary: readonly [IndexedError, ...IndexedError[]] }

FanStartEvent      { type: "fan-start"; runId; dagId; nodeId; width; replayed; authored; cap; effective; clamped; estimator }
FanProjectionEvent { type: "fan-projection"; runId; dagId; nodeId; axis; estimate; estimatorApplied; remainingChildren; verdict: "admit" | "refuse"; lowerBound }
FanRefusedEvent    { type: "fan-refused"; runId; dagId; nodeId; completed; remaining; axis; ceiling; estimate; estimatorApplied; lowerBound }
```

**Depends on:** Fan scheduling types (`FanEstimator`)

### Fan pure helpers

**Responsibility:** Total, pure arithmetic for spend windows, estimation, projection, error ordering and effective concurrency.
**Files:** `dag-runtime/fan/{spend-window,estimator,projection,error-order,effective-concurrency}.ts`
**Interface:**

```ts
type SpendSample = Readonly<{ tokens: number; calls: number; usdMicros: MicroUsd; lowerBound: boolean }>;
spendDelta(before: Spend, after: Spend): SpendSample                         // per-axis max(0, after−before)
estimate(samples: readonly SpendSample[], e: FanEstimator): Readonly<{ perChild: SpendSample; applied: FanEstimator }>
project(remaining: Remaining, remainingChildren: number, est: SpendSample):
  | { kind: "admit"; checks: readonly AxisCheck[] }
  | { kind: "breach"; axis; ceiling; projected; estimate; lowerBound }      // first breached in ceiling order
orderFailures(fs: readonly IndexedError[]): Readonly<{ primary: IndexedError; secondary: readonly IndexedError[] }>
effectiveConcurrency(authored: ChildConcurrency, cap: FanConcurrencyCap): Readonly<{ effective: number; clamped: boolean }>
```

**Depends on:** Fan scheduling types; `types/budget-capability.ts` (`Remaining`), `types/spend.ts`

### Fan machine (LC-1)

**Responsibility:** Decide which indices start, when projection runs, when draining begins, and the single final outcome.
**Files:** `dag-runtime/fan/fan-machine.ts`
**Interface:**

```ts
type DrainCause = { kind: "failure" } | { kind: "refusal"; breach: Breach } | { kind: "abort" };
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
  | { type: "replay"; index: MapIndex }     // shell parses stored hit, feeds slot-settled (no dispatch, no probe slot)
  | { type: "dispatch"; index: MapIndex }   // shell starts runSlot(i)
  | { type: "emit-projection"; record: ProjectionRecord }
  | { type: "emit-refused"; record: RefusalRecord }
  | { type: "finish"; finish: FanFinish };
initFan(cfg: { nodeId; width; replayedIndices: ReadonlySet<number>; effective: number; estimator: FanEstimator }): FanState
fanStep(s: FanState, e: FanEvent): Readonly<{ state: FanState; commands: readonly FanCommand[] }>
```

**Rules:**
- Indices start in ascending order.
- Replays are emitted before any dispatch of a higher index, so a C=1 ordering is identical to today.
- The first `min(effective, unreplayed)` dispatches are the probe and carry no projection. Every later dispatch first evaluates `project(...)` against the `admission` in the triggering event.
- `inFlight ≤ effective` always holds.
- `fan-done` is reached only when `inFlight = 0`:
  - `reduce` with index-ordered values only when there are no failures and no refusal or abort;
  - otherwise `fail`, with precedence lowest-index child failure (bare, or `fan-child-failed` when more than one) > refusal (`fan-budget-refused`) > abort (`aborted`).
- A replay-parse failure or a save failure is a `failed` slot outcome for that index.

**Depends on:** Fan pure helpers, Fan errors and events

### Fan shell (`runMappedFan`)

**Responsibility:** Run the I/O around the machine. That means width resolution, the checkpoint load and corruption refusal (unchanged, before any dispatch), `setMeta` seeding, the interpreter loop, `runSlot`, budget sampling, event emission and the reducer call.
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
2. Execute the commands. `dispatch` adds `runSlot(i)` to the in-flight map.
3. `await Promise.race(inFlight)`.
4. Check abort, then step `slot-settled` with a fresh `remaining()` snapshot.
5. Repeat until a `finish` command arrives.

Never `Promise.all`; never return with pending slots. `runSlot` samples `spent()` before `executeChild` and after `saveNode`.

**Depends on:** Fan machine, Fan scheduling types

### Authoring surface

**Responsibility:** Accept, validate, freeze, generate and describe `childConcurrency`/`estimator`.
**Files:** `nodes/map.ts`, `shared/validate-dag.ts`, `cli/authored.ts`, `cli/authored-codegen.ts`, `describe/build-described-dag.ts`
**Interface:**
- `MapExecutionConfig` gains `childConcurrency?: number; estimator?: FanEstimator`.
- AuthoredDag `map` gains `childConcurrency?: int ≥ 1; estimator?: "largest-seen"|"p50"|"p90"|"p95"` (strict).
- An invalid value is rejected with an error naming the node and the value (AS-029, AS-051).

**Depends on:** Fan scheduling types

### Host cap

**Responsibility:** Operator-controlled host-wide cap, validated at startup and applied to every run.
**Files:** `packages/host/src/domain/config.ts`, `packages/host/src/hitl/adapters/run-executor.ts`, `packages/host/src/domain/framework-error-http.ts`
**Interface:**
- `FAN_CHILD_CONCURRENCY_MAX: z.coerce.number().int().min(1).default(8)`.
- `runResumableDagJob(dag, input, ctx, { …, fanConcurrencyCap: fanConcurrencyCap(config.FAN_CHILD_CONCURRENCY_MAX) })`.
- HTTP classification: `fan-budget-refused` maps to the same class as `llm-budget-exceeded`; `fan-child-failed` delegates to the primary's class.

**Depends on:** Fan scheduling types (brand), Fan errors (kinds)

---

## Data Flow

```
run-node (map) ─▶ runMappedFan(shell)
   resolveMappedItems ─▶ checkpointer.load ─▶ corrupt? ─▶ err(checkpoint-corrupt)  [0 dispatches]
   effectiveConcurrency(authored, cap) ─▶ warn+fan-start event
   initFan(replayedIndices) ─▶ fanStep(start, remaining())
      └▶ commands: replay(i) | dispatch(i) | emit-* | finish
   runSlot(i): spent()₀ ─▶ executeChild ─▶ childOutputSchema ─▶ saveNode ─▶ spent()₁ ─▶ spendDelta
      └▶ fanStep(slot-settled(i, outcome, remaining()))  … loop (Promise.race over ≤ C slots)
   finish.reduce(ordered) ─▶ (abort gate) ─▶ mapping.reduce   |   finish.fail(error) ─▶ err(error)
```

The machine sees only data: Remaining snapshots, spend samples and slot outcomes. All I/O, time and budget reads live in the shell.

---

## Lifecycles

### LC-1: Fan scheduler lifecycle

**Machine file:** `packages/framework/src/dag-runtime/fan/fan-machine.ts`
**Kind:** typed-reducer
**States:** fan-dispatching, fan-draining, fan-done

| Event | From | To |
|---|---|---|
| start (no unreplayed work left after replays) | fan-dispatching | fan-done |
| start (dispatch probe batch) | fan-dispatching | fan-dispatching |
| slot-settled (completed or replayed; more work or in-flight) | fan-dispatching | fan-dispatching |
| slot-settled (completed; projection breach before next dispatch) | fan-dispatching | fan-draining |
| slot-settled (failed, terminal) | fan-dispatching | fan-draining |
| slot-settled (last slot; nothing pending, nothing in flight) | fan-dispatching | fan-done |
| abort | fan-dispatching | fan-draining |
| slot-settled (in-flight remain) | fan-draining | fan-draining |
| slot-settled (last in-flight slot) | fan-draining | fan-done |
| abort (cause escalates to abort only when no failure recorded) | fan-draining | fan-draining |

`fan-done` is terminal: any event there returns the same state and no commands, which the property tests pin. When draining is entered with zero in-flight slots, the machine goes straight to `fan-done`.

---

## Invariants

### INV-1: Fan phase literals only in the machine file

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-fan-phase-literals-in-machine.json`
**Statement:** The literals `"fan-dispatching"`, `"fan-draining"` and `"fan-done"` appear only in `dag-runtime/fan/fan-machine.ts` (tests excepted). The shell and every other module consume phases through the machine's exported guards and types and never re-implement transitions.

### INV-2: Fan errors constructed only via factories

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-2-fan-errors-via-factory.json`
**Statement:** No object literal with `kind: "fan-budget-refused"` or `kind: "fan-child-failed"` is built outside `types/error-factories.ts` (tests excepted). Every refusal therefore carries the redeploy hint, the lower-bound flag and estimator-applied fields (FR-014).

### INV-3: Fan concurrency brands only from smart constructors

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-3-no-raw-fan-brand-cast.json`
**Statement:** `ChildConcurrency` and `FanConcurrencyCap` are never produced by an `as` cast outside `types/fan-scheduling.ts` (tests excepted).

### INV-4: Fan core is pure

**Tier:** advisory
**Statement:** `dag-runtime/fan/` has no I/O, no `Date.now`/`Math.random`, no async and no `Promise` usage.
- **Backstop:** `packages/framework/src/dag-runtime/fan/` was added to `.claude/linter/rules/config.json` `pureModules` in this phase. The programmatic purity rule therefore enforces it, but only in the full/wave-gate lint tier, not on every edit.
- It is tiered advisory because no per-edit regex rule can be scoped to that directory.

### INV-5: Index-ordered reduce, first-error-by-index, ≤ C in flight, no reduce after refusal/abort

**Tier:** advisory
**Statement:** These properties (NFR-020, FR-003, FR-005, FR-016, FR-021) hold under every completion interleaving. They are behavioural properties, not lexical ones. They are enforced by `fan-machine.property.test.ts` and `map-fan-interleaving.property.test.ts` (≥1,000 cases each), not by a lint rule.

### INV-6: No interpreter return with pending slots; no `Promise.all` in the fan interpreter

**Tier:** advisory
**Statement:** `runMappedFan` awaits every in-flight slot before returning (AD-10). This is not regex-checkable without path scoping: `Promise.all` is legitimately used in `wave-execution.ts`. It is enforced by the drain/abort harness tests, which assert zero pending slot promises at return.

---

## Implementation Phases

Eleven tasks in five waves. The machine → shell → integration chain is inherently serial, so waves 3–5 are narrower than the 4–6 target. That is deliberate and unavoidable.

### Phase 1: Foundations (no dependencies)

- **T1: Fan scheduling types.** Brands, parsers, `FanEstimator`, `DEFAULT_FAN_CONCURRENCY_CAP`, `FanScheduling`. Add `mapping.scheduling` to `MapNodeDef`. Add `DagRunOpts.fanConcurrencyCap` (type only) and export them.
  - **Files:** `types/fan-scheduling.ts`, `types/fan-scheduling.test.ts`, `types/dag.ts`, `types/index.ts`, `dag-runtime/run-dag-stateful.ts` (opts field only)
- **T2: Fan errors.**
  - Add both kinds, their factories, the persisted schema entries, `formatFrameworkError` and `retriabilityOf` (refusal non-retriable; `fan-child-failed` uses the primary's retriability).
  - Classify both kinds in the host's HTTP error mapping.
  - `estimatorApplied` is typed as a string-literal union locally if T1 has not landed; reconcile on merge, as T1 and T2 share only the `FanEstimator` alias.
  - **Files:** `types/errors.ts`, `types/error-factories.ts`, `__tests__/fan-errors.test.ts`, `packages/host/src/domain/framework-error-http.ts`
- **T3: Fan observer events.** Add the three event variants to the `ObserverEvent` union and fix exhaustive consumers flagged by `tsc` (observer/tracing/host log sinks).
  - **Files:** `types/events.ts`, any exhaustive consumers found
- **T4: Host config.** Add `FAN_CHILD_CONCURRENCY_MAX` with startup validation and tests (default 8, value 1, invalid value).
  - **Files:** `packages/host/src/domain/config.ts`, `packages/host/src/__tests__/config.test.ts`

### Phase 2: Pure helpers, authoring, host plumbing (depends on Phase 1)

- **T5: Fan pure helpers + property tests.** `spendDelta`, `estimate` (nearest-rank, fallback below 5), `project` (all headroom kinds), `orderFailures`, `effectiveConcurrency`. Covers SC-005, SC-014, and SC-006 at the helper level.
  - **Files:** `dag-runtime/fan/{spend-window,estimator,projection,error-order,effective-concurrency}.ts` + `__tests__/*`
- **T6: Authoring surface.** `createMapNode`/`createCollectMapNode` config, `snapshotMapping` freezing and validation, AuthoredDag schema, codegen emission, describe projection, and the fingerprint-independence test. Covers AS-029, AS-051 and AD-9.
  - **Files:** `nodes/map.ts`, `shared/validate-dag.ts`, `cli/authored.ts`, `cli/authored-codegen.ts`, `describe/build-described-dag.ts`, `__tests__/map-node.test.ts`, `__tests__/cli/authored-map.test.ts`, `__tests__/fan-fingerprint.test.ts`
- **T7: Host cap plumbing.** `run-executor` passes `fanConcurrencyCap(config.FAN_CHILD_CONCURRENCY_MAX)`, and `runResumableDagJob` forwards the opt. Unit-test that the opt is forwarded.
  - **Files:** `packages/host/src/hitl/adapters/run-executor.ts`, `packages/framework/src/executor/run-dag.ts`
- **T8: Docs.**
  - Write ADR-0087 (AD-1..AD-12 condensed: lifetime-window attribution, the overshoot statement and probe caveat, resume re-probe, the percentile best-effort bound).
  - Amend ADR-0086; update the ADR index.
  - Update F1 plan §12/§13.
  - Update the host README and deployment docs (`FAN_CHILD_CONCURRENCY_MAX` versus `MAX_GLOBAL_CONCURRENCY`/`DEFAULT_DAG_CONCURRENCY`; resume-after-refusal requires a redeploy).
  - Add the CONTEXT.md terms.
  - Rewrite the fan-runner header comment in T10.
  - **Files:** `docs/adr/0087-*.md`, `docs/adr/0086-*.md`, `docs/adr/README.md`, `docs/plans/2026-09-06-f1-runtime-width-fanout.md`, `packages/host/README.md`, `packages/host/docs/deployment.md`, `CONTEXT.md`

### Phase 3: Fan machine LC-1 (depends on Phase 1 + T5)

- **T9: `fan-machine.ts`.** `initFan`/`fanStep` with property tests:
  - in-flight ≤ C;
  - dispatch ascending, with replays never dispatched;
  - probe = min(C, unreplayed) with no projection;
  - projection precedes every post-probe dispatch;
  - no dispatch after drain begins;
  - `fan-done` only at in-flight = 0;
  - reduce input is index-ordered under arbitrary settle orders (SC-003);
  - primary = lowest index and secondaries complete (SC-006);
  - refusal `completed` counts drain completions (FR-022);
  - post-refusal admitted work ≤ C−1 slots (AD-11 / SC-004 statement);
  - `fan-done` is absorbing;
  - C=1 command sequence matches the sequential order.
  - **Files:** `dag-runtime/fan/fan-machine.ts`, `dag-runtime/fan/__tests__/fan-machine.test.ts`, `dag-runtime/fan/__tests__/fan-machine.property.test.ts`

### Phase 4: Shell wiring (depends on Phase 3 + T7)

- **T10: `runMappedFan` interpreter.**
  - Thread `FanRuntime` through `ExecutionScope` root → `run-node` → `runMappedFan`.
  - Build `FanRuntime` in `runDagStatefulOutcome`.
  - Write the interpreter loop and `runSlot` with the spend window, plus event emission, the clamp `logger.warn` and span attributes (`fugue.fan.effective_concurrency`, `fugue.fan.clamped`).
  - Build the deterministic harness, the example tests and the interleaving property tests.
  - Rewrite the header comment (FR-062).
  - **Files:** `dag-runtime/run-mapped-fan.ts`, `dag-runtime/execution-scope.ts`, `dag-runtime/run-node.ts`, `dag-runtime/run-dag-stateful.ts`, `__tests__/fan-test-harness.ts`, `__tests__/map-fan-concurrency.test.ts`, `__tests__/map-fan-interleaving.property.test.ts`

### Phase 5: Equivalence, resume and host integration (depends on Phase 4)

- **T11: Integration closure.**
  - **C=1 golden equivalence (SC-001, AS-001, AS-028):** capture the trace from the pre-change runner at merge-base into a fixture first.
  - **Speedup (SC-002):** fake clock, N ∈ {1, C−1, C, C+1, 5C}.
  - **Resume:**
    - refusal without redeploy refuses again with 0 re-dispatches (SC-008);
    - after a ceiling raise via a redeployed DAG config, the fan completes;
    - drain-saved indices are reused (SC-007, AS-024);
    - corruption at C>1 → 0 dispatches (SC-009);
    - reroute epoch not replayed (AS-008).
  - **Host composition:** cap 8 default and cap 1, a clamp producing exactly 1 warn and 1 `fan-start{clamped}` (SC-010/011), and a real-ledger refusal across a restart.
  - **Files:** `__tests__/map-fan-c1-equivalence.test.ts`, `__tests__/fixtures/fan-c1-golden.json`, `__tests__/map-fan-resume.test.ts`, `packages/host/src/__tests__/integration/mapped-host-composition.test.ts`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Fan scheduling types | ctor/parse accept/reject, defaults | — | parse ∘ show round-trip for valid ints |
| Fan errors/events | format text includes redeploy hint and lower-bound wording; retriability | persisted round-trip via `PersistedFrameworkErrorSchema`; host HTTP class | — |
| Pure helpers | estimator fallback at 0/1/4 samples, percentile from 5th (SC-014); projection per kind | — | projection across all headroom kinds (SC-005, ≥1,000 cases); nearest-rank result ∈ samples and monotone in p; `orderFailures` primary = min index, secondaries = rest (SC-006) |
| Fan machine (LC-1) | scripted scenarios per LC-1 row; absorbing `fan-done` | — | arbitrary settle orders and outcomes: in-flight ≤ C; ordered reduce (SC-003); post-refusal ≤ C−1 slots and overshoot ≤ (C−1)·M (SC-004); no dispatch after drain; C=1 command order = sequential |
| Fan shell | AS-002..013, 019..023 via deterministic harness; zero pending slots at return | real in-memory checkpointer; file checkpointer resume | arbitrary interleavings × failure sets: saved-index reuse, 0 re-dispatch (SC-007) |
| Authoring surface | AS-029/051 errors name node and value; codegen emits fields; describe shows scheduling | authored → codegen → defineDag round-trip | fingerprint invariant under arbitrary scheduling |
| Host cap | config default 8 / 1 / invalid (AS-025, AS-030) | composition: cap applied, clamp warn + event, ledger-backed refusal/resume (AS-014/015) | — |

The deterministic harness gives each child a manually resolved deferred and gives the budget a scripted `Spend` timeline. No real timers are used; the SC-002 timing test uses a fake clock.

---

## Security & NFR Notes

- **Authority:** The framework only reads `BudgetCapability` from root-owned `FanRuntime`. There are no writes and no new port (FR-012, OOS-001). The host per-call meter stays the hard stop (FR-019). Map `requires` is unchanged, so the minting/broker surface is unchanged.
- **Resource safety:** Concurrency is bounded by min(authored, operator cap). An operator setting cap = 1 restores sequential behaviour host-wide (FR-031).
- **Performance:** The scheduler is O(1) per step apart from estimator sorting, which is O(n log n) on settled samples per projection. That is negligible for any width up to `maxWidth`; insertion into a sorted array is acceptable.
- **Determinism:** With concurrency fixed at C, reducer input, errors and saved indices are interleaving-independent. Only event timing varies.

---

## Verification

1. `bun run typecheck` passes (exhaustive `FrameworkError`, `ObserverEvent` and persisted-schema checks catch missed consumers).
2. `bun run test` is green. That includes the fan property suites (≥1,000 cases each) and `map-fan-c1-equivalence.test.ts` with 0 diffs.
3. `bun "$LOOM_DIR"/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules < /dev/null` succeeds.
4. Full-tier lint shows no purity violations under `dag-runtime/fan/`.
5. `bun run check:docs` passes (ADR-0087 links, F1 plan anchors).
6. Manual check: run a host with `FAN_CHILD_CONCURRENCY_MAX=1`, then with the default, on a sample map DAG (`childConcurrency: 4`). Observe the `fan-start` event and the clamp warning, and confirm the run statuses are unchanged (FR-061).
