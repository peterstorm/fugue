# Plan: F3 — The Budget Capability

**Status:** complete (PR-A/B/C/D shipped in implementation branches)
**Branch:** `feat/f3-budget-capability-surface` (PR-D completion)
**Predecessor:** F4 (prompt caching, PR #38, merged `6b41c6e`)
**Successor it unblocks:** F1 (dynamic fan-out)

---

## 1. Problem

The 08-02 spike describes F3 as an absence: *"There is **no** token or cost budget"*
(`docs/spikes/2026-08-02-graph-engineering-findings.md:156-157`). That is no longer the
accurate framing, and starting from it would build the wrong thing.

A budget **does** exist. `llmBudgetTokens` is a real per-run ceiling, enforced before
every LLM call by a pure decision function with a concurrency-reservation gate and a
documented overshoot bound. It is careful code.

The problem is that it is **wrong in four specific ways**, and F4 just made the first
one worse:

### P1 — After F4, a token ceiling no longer approximates spend

`runTotal` is `tokensIn + tokensOut` (`packages/host/src/domain/llm-meter.ts:51`). Every
prompt token counts 1.0 against the ceiling. But F4 shipped the knowledge that prompt
tokens are not fungible: a cache read bills at **0.1×** and a cache write at **1.25×**
(5m) or **2.0×** (1h) — `packages/framework/src/llm/cost.ts:51-52`.

Two runs, each `tokensIn: 100_000`, `tokensOut: 10_000`, identical under today's ceiling:

| Run | Composition | Input cost, in 1.0× token-equivalents |
|---|---|---|
| A — caching off | 100k uncached | 100_000 |
| B — conversation policy, warm | 95k read + 5k uncached | 95k × 0.1 + 5k = **14_500** |
| C — conversation policy, 1h, cold | 100k write | 100k × 2.0 = **200_000** |

Run C costs **13.8× more than run B** while all three are indistinguishable to
`budgetDecision`. The ceiling was a serviceable proxy for money when every token cost
the same. F4 severed that, and the meter already carries the fields needed to fix it
(`cacheWriteTokens`, `cacheReadTokens`) — it simply does not use them for the decision.

**This is the single strongest argument for doing F3 now rather than after F1.** F4 did
not just leave the budget alone; it degraded it.

### P2 — The budget is not durable, so parking or crashing refills it

`createMeteredLlm` is called inside `createNodeContextForDag`
(`packages/host/src/adapters/node-context-factory.ts:429`), and its meter starts at
`emptyMeter()`. `createNodeContextForDag` is invoked **once per execution slice** by the
HITL run executor (`packages/host/src/hitl/adapters/run-executor.ts:172`).

Therefore: a run that parks for a human decision and resumes gets a **fresh budget**. A
run that parks five times gets six times its configured ceiling. The usage figures reach
OTel spans (`packages/framework/src/llm/spans.ts:112`) and the host log
(`llm.metered`), but `packages/framework/src/types/events.ts` carries no usage at all,
and `RunMeta` (`packages/framework/src/checkpoint/checkpointer.ts:350`) has no spend
field — so there is nothing durable to rehydrate from even if we wanted to.

F6 made runs survive process death. That is precisely what turned an in-process counter
from "adequate" into "a hole": before durable resume, losing the meter meant losing the
run too.

### P3 — It is not a capability, so no node can see it

Built-in capabilities are `llm, cache, prompts, judgeLlm, http, clock`
(`packages/framework/src/types/node.ts:189-196`). A node cannot declare
`requires: ["budget"]`, cannot ask what remains, and cannot adapt. The budget is an
ambient guard that only ever does one thing: refuse.

This is the difference between spend protection and the **quality control** the research
note argues for — *"maxWidth + budget + slot control stop 'spawn 50 agents for a simple
query'"* (`docs/spikes/2026-08-12-web-research-addendum.md:52`). A fan-out node that can
read `remaining()` narrows itself; a fan-out node that cannot, hits the wall mid-wave and
fails the run.

### P4 — Only `shared.llm` is metered

`createMeteredLlm` wraps exactly one client. Any LLM client that reaches a node through
the capabilities bag instead — and `makeNodeContext` reads `caps.judgeLlm`
(`packages/framework/src/shared/make-node-context.ts:56`) — arrives **raw**. Judge tokens
would be neither metered nor budgeted. The capability whose entire purpose is *"kept
distinct from the main `llm` client so judging never contends with generation"*
(`types/node.ts:239-244`) is also distinct from the budget.

---

## 2. Verified current state

Everything below was read, not recalled.

| Fact | Location |
|---|---|
| Pure meter; `runTotal = tokensIn + tokensOut` | `host/src/domain/llm-meter.ts:51` |
| `RunUsage` already stores the cache split (F4) | `host/src/domain/llm-meter.ts:31-46` |
| Reservation gate bounds concurrent overshoot | `host/src/domain/llm-meter.ts:294` |
| Decorator is per-`NodeContext`, in-process | `host/src/adapters/metered-llm.ts:83` |
| Only `shared.llm` is wrapped | `host/src/adapters/node-context-factory.ts:429` |
| Ceiling source is `dag.config.llmBudgetTokens` | `host/src/adapters/node-context-factory.ts:432` |
| Config schema: positive int, optional | `host/src/domain/config.ts:966-967` |
| Context rebuilt per execution slice | `host/src/hitl/adapters/run-executor.ts:172` |
| `llm-budget-exceeded` carries settled cumulative only | `framework/src/types/errors.ts:243-256` |
| Maps to HTTP 429 | `host/src/http/handlers/run-dag.ts:326` |
| Cost model exists, unused by the budget | `framework/src/llm/cost.ts:84-104,121` |
| Observer events carry no usage | `framework/src/types/events.ts` (no `tokensIn`) |
| A wave runs unbounded-parallel | `framework/src/dag-runtime/wave-execution.ts:133` |

---

## 3. Constraints the design must respect

- **The overshoot-by-one contract is a published guarantee** (FR-W1-004 / SC-003, and
  the `errors.ts` doc comment). Whatever F3 changes, at most one call may pass a reached
  ceiling in the sequential case, and the concurrent case stays bounded by the learned
  reservation.
- **`llmBudgetTokens` has shipped** (v0.5.1) and may be set in live deployments. It gets
  a normalizing parse into the new representation, not a breaking rename. This is the one
  place the "no backwards compatibility for unshipped code" rule does not apply, because
  it shipped.
- **Fail closed.** The spike says it, and the certification-seam note repeats it for the
  capability-minting path (`web-research-addendum.md:23`). An unknown price, a
  non-finite figure, an unreachable ledger — every one of these refuses, never allows.
- **A budget may only ever narrow.** If a run request carries a ceiling, it composes with
  the DAG's as `min`, never `max`. Deny-by-default.
- **The pre-call gate must stay in-process.** SC-002/SC-004 claim zero added network
  round trips. §D3 amends this claim honestly rather than quietly breaking it.

---

## 4. Design

### D1 — `Spend`: the value type that owns the money vocabulary

F4's lesson, applied again. `TokenUsage` succeeded because one type owned the token
vocabulary and every consumer spread it. `Spend` does the same for cost.

```ts
/** Integer micro-USD. Money in a float accumulates drift; a ceiling comparison must not. */
export type MicroUsd = number & { readonly __brand: "MicroUsd" };

export interface Spend {
  readonly tokens: number;      // tokensIn + tokensOut, all-inclusive (F4 semantics)
  readonly calls: number;       // settled provider calls
  readonly usd: PricedSpend;    // see below
}
```

The cost of a call is not always knowable — `costRatesFor` returns a fallback for an
unrecognised model and `computeCostUsd` merely warns
(`framework/src/llm/cost.ts:40,121`). A number cannot represent "unknown", and defaulting
to zero would make an unpriced model **free**, which fails open. So:

```ts
export type PricedSpend =
  | { readonly kind: "priced";   readonly micros: MicroUsd }
  | { readonly kind: "unpriced"; readonly models: UnpricedModels; readonly knownMicros: MicroUsd };
// As shipped (`framework/src/types/spend.ts`): `UnpricedModels` is a NON-EMPTY
// readonly ARRAY, not a Set — sorted and de-duplicated so `addSpend` stays
// commutative under structural equality — and `knownMicros` carries the priced
// portion as a lower bound, which is what makes a refusal message actionable.
```

`unpriced` is absorbing under addition: `priced + unpriced = unpriced`, carrying the union
of offending model names. A run that touched one unpriced model can never report a
trustworthy dollar figure again, and the type says so. The names ride along so the
refusal message can name what to add to `PRICE_TABLE`.

Conversion happens once, at the client boundary, from `costBreakdownUsd`'s float:
`Math.round(usd * 1e6)`. Floats stay display-only.

### D2 — `Ceilings`: what "over budget" means, as an ADT

```ts
export type Ceiling =
  | { readonly kind: "tokens"; readonly limit: number }
  | { readonly kind: "usd";    readonly limit: MicroUsd }
  | { readonly kind: "calls";  readonly limit: number };

/** At least one ceiling — an empty budget is spelled `undefined`, not `{}`. */
export type Ceilings = readonly [Ceiling, ...Ceiling[]];
```

A run is over budget when **any** ceiling is reached. Modelling it as a non-empty list
rather than `{tokens?, usd?, calls?}` removes the `{}` state — "a budget that budgets
nothing" — which would otherwise need a guard at every read site. `undefined` already
means unbudgeted (FR-W1-006); two spellings of the same thing is the illegal state.

`calls` is included because it is the cheapest possible circuit-breaker for the
retry-amplification failure the vault records: *"A buggy tool that always errors out
burns tokens until `maxIterations`"*
(`learning/autonomous-agents-in-production/constraining-llm-outcomes-per-state-graph-node.md:91`).
A call ceiling catches a loop that a token ceiling only catches expensively.

**Why not slots.** The addendum argues *"Budget = slots, not just dollars"*
(`web-research-addendum.md:31`). It is right about the eventual shape and wrong about the
timing. A concurrency slot is a **gauge**, not a monotone counter: exceeding it should
*queue*, not *refuse*. Folding it into `Ceiling` would make `refuse because concurrency`
representable — a state that must never occur. And there is nothing for it to constrain
yet: waves run `Promise.all` over a **statically authored** node set
(`wave-execution.ts:133`), so today's maximum width is a property of the DAG file,
readable in `fugue visualize`. F1 is what makes width data-dependent and unbounded.
**Slots ship with F1, as a separate gauge type.** Recorded here so the next reader does
not re-derive the question.

### D3 — `SpendLedgerPort`: making the budget survive a resume

A new host port, with the two adapters the port rule requires (Redis for parity with the
existing checkpointer, file for F6 parity):

```ts
export interface SpendLedgerPort {
  /** Durable spend for a run. Absent ⇒ zero. */
  read(runId: RunId): Promise<Result<Spend, HostError>>;
  /** Monotone accumulate. Must be atomic per key (Redis: HINCRBY; file: journal append). */
  add(runId: RunId, delta: Spend): Promise<Result<Spend, HostError>>;
}
```

Wiring:

- **Hydrate once per slice.** `createNodeContextForDag` reads the ledger and seeds the
  meter, so the pre-call gate is still a pure in-process comparison against a correct
  cumulative. One read per slice, not per call.
- **Write on settle.** The `settle` path awaits `add` after the provider call returns.
- **Fail closed on hydration.** If the ledger read fails and a ceiling is declared, the
  slice refuses. An unreadable ledger is indistinguishable from a spent one; guessing
  zero is exactly the "refill on resume" bug, formalised.

**Amending the zero-round-trip claim.** `metered-llm.ts:11-14` currently claims *"Zero
network round trips are added"* (SC-002/SC-004). After D3 that is false for the settle
path. The honest restatement, which goes in the header and in the requirements:

> The **admission decision** adds zero round trips — it is a pure comparison against an
> in-process meter hydrated once per slice. The **settle** path adds one ledger write per
> provider call, sequenced after a call that already cost seconds.

A ~0.5 ms `HINCRBY` after a multi-second LLM call is noise. Silently invalidating a
documented success criterion would not be.

**The loss window, stated rather than hidden.** A crash between provider-settle and
ledger-write loses at most one call's spend. That is the same magnitude as the existing
overshoot-by-one allowance and is documented as such — not discovered later.

### D4 — `budget` as the seventh built-in capability

```ts
export interface BudgetCapability {
  readonly spent: () => Spend;
  readonly remaining: () => Remaining;
}

export type Remaining =
  | { readonly kind: "unbudgeted" }
  | { readonly kind: "budgeted"; readonly headroom: readonly CeilingHeadroom[] };

// Available token/call amounts remain numbers; available USD amounts are
// MicroUsd. Unpriced USD remains its own explicit headroom member.
```

Adding a key to `BUILTIN_CAPABILITY_KEYS` requires a matching `BaseNodeContext` field and
a `BUILTIN_CAPABILITY_INFO` entry — both compile-enforced by the existing
`_BuiltinKeysComplete` assertion and the `satisfies Record<BuiltinCapabilityKey, …>`
clause (`types/node.ts:318` and `types/node.ts:257`). The registry does the policing for us.

**Read-only, deliberately.** The spike proposes `spend()` **and** `remaining()`
(`graph-engineering-findings.md:160`). This plan ships only the reads, and the reason
matters: spend is a *consequence* of a metered provider call, not an action a node
performs. A node-callable `spend(n)` would let the ledger disagree with the provider's
reported usage — the exact class of illegal state that `runTotal`-derived-never-stored and
the `TokenUsage` consolidation were built to prevent. Metering non-LLM costs (a paid HTTP
API) is a real future need, and the right shape for it is a *meter registered by the
capability*, not a raw spend call handed to node authors. Out of scope; recorded in §9.

**On determinism.** A node that branches on `remaining()` is nondeterministic under
re-execution. This is not a new hazard: `clock` is already a capability with exactly this
property, and is documented as such (*"Injectable wall-clock source… so any
time-dependent node is deterministic without monkey-patching globals"*,
`types/node.ts:251-256`). `budget` joins that family, gets the same warning in
`BUILTIN_CAPABILITY_INFO`, and gets a test fake for the same reason. Checkpoint replay
restores recorded outputs rather than re-running, so the exposure is bounded to retries.

### D5 — A refusal that says which ceiling, and on what basis

This is where the round-3 deferral `type-design-analyzer-4` gets paid off. The reviewer's
point was that `cumulative` on `llm-budget-exceeded` is settled-only while the *decision*
may have been driven by a projection — the figure and the reason can disagree, and only a
comment currently reconciles them.

With multiple ceilings that ambiguity becomes untenable: an operator seeing "budget
exceeded" cannot tell whether they hit tokens, dollars, or calls. The error grows a
discriminated cause:

```ts
readonly kind: "llm-budget-exceeded";
readonly runId: RunId;
readonly nodeId: NodeId;
readonly cause: {
  readonly ceiling: Ceiling;                        // WHICH limit
  readonly basis: "settled" | "projected";          // WHY, unambiguously
  readonly observed: number;                        // the figure compared, in the ceiling's unit
};
```

`basis: "projected"` states outright that the reservation drove the refusal, so
`observed` no longer has to pretend to be a settled figure. The old flat
`cumulative`/`budget` pair is derivable from `cause` for the persisted-error schema
(`errors.ts:380-429`), which needs a migration entry either way.

### D6 — One metered path, not two

The round-3 deferral `code-simplifier-8`. `sendStructured` and `sendWithTools` in
`metered-llm.ts:231-260` are structurally identical: `admit` → `try/settle` →
`catch/logThrown` → `finally/release`. It was borderline tidying at 30 lines.

F3 makes it load-bearing. Each path must additionally: hydrate-or-refuse, price the
response, accumulate three ceiling dimensions, and await the ledger write. Duplicating
that twice is where the divergence bug lands — and it would land on the *judge* path,
the one with no test coverage today (§P4). One `metered(op, call)` helper, both public
methods as thin adapters over it.

### D7 — Cover every LLM client, not just `shared.llm`

`createNodeContextForDag` meters `shared.llm` and hands `extractClients(shared.capabilities)`
through untouched. F3 meters **every** client that reaches the context, sharing one
run-scoped meter across them — a budget that one client can bypass is not a budget.

The sharing is the point: judge tokens and generation tokens draw on the same ceiling
because they cost the same money. `attribution(nodeId)` already tags the log line, and the
metering line gains the client's capability key so an operator can still see the split.

---

## 5. Requirements

| ID | Requirement |
|---|---|
| FR-B-001 | A ceiling may be declared in tokens, micro-USD, or calls; at least one, any combination. |
| FR-B-002 | A run is refused when **any** declared ceiling is reached, before the call. |
| FR-B-003 | Cost is computed from the F4 cache split — read at 0.1×, write at the TTL's multiplier. |
| FR-B-004 | An unpriced model under a declared **usd** ceiling refuses, naming the model. |
| FR-B-005 | An unpriced model under only token/call ceilings runs normally. |
| FR-B-006 | Spend is durable per `runId`; a resumed slice hydrates it before admitting any call. |
| FR-B-007 | An unreadable ledger under a declared ceiling refuses the slice (fail closed). |
| FR-B-008 | `llmBudgetTokens` parses into `[{kind:"tokens",limit}]` with byte-identical behaviour. |
| FR-B-009 | A request-supplied ceiling narrows the DAG's; it can never widen it. |
| FR-B-010 | `budget` is a built-in capability exposing `spent()` / `remaining()`; no `spend()`. |
| FR-B-011 | Absent ceilings never refuse — metering and ledger writes still happen (FR-W1-006 preserved). |
| FR-B-012 | Every LLM client on the context shares one run-scoped meter. |
| FR-B-013 | `llm-budget-exceeded` names the ceiling, the basis, and the observed figure. |
| SC-B-001 | Sequential overshoot past a reached ceiling stays at most one call (SC-003 preserved). |
| SC-B-002 | The **admission** decision adds zero network round trips (restated SC-002/SC-004). |
| SC-B-003 | A park/resume cycle does not increase total spend beyond the ceiling by more than the documented one-call loss window. |

---

## 6. Test strategy

**Property tests** (`fast-check`, per `rules/property-testing.md`) — these are business
rules, so they get properties, not examples:

- `addSpend` is a monoid: associative, `ZERO_SPEND` identity, commutative.
- `unpriced` is absorbing and its model set is a union.
- Monotonicity: no sequence of `add` calls ever decreases any component.
- **The regression that motivates the feature**: for any usage with a non-zero cache
  split, cost-denominated spend and token-denominated spend diverge in the direction the
  multipliers predict. A change that reverts to counting cache reads at 1.0× fails.
- Refusal soundness: `admit` returns `refuse` **iff** some declared ceiling is reached by
  settled-or-projected spend — the biconditional, so neither over- nor under-refusal
  survives.

**Durability tests** — the P2 hole, pinned:

- Meter → ledger → fresh meter hydrated from the ledger reproduces the cumulative.
- A simulated park/resume across two `createNodeContextForDag` calls against one fake
  ledger refuses at the ceiling. *This test fails on `main` today* — it is the executable
  statement of the bug.
- Ledger read failure + declared ceiling ⇒ refuse. Ledger read failure + no ceiling ⇒ run.
- Both adapters (Redis, file) satisfy one shared port contract suite, including
  concurrent `add` under `Promise.all` — atomicity is the whole reason for the port.

**Coverage tests** — the P4 hole:

- A judge client wired through the capabilities bag is metered and draws on the same
  ceiling as `llm`.

**Preserved-contract tests** — every existing `llm-meter` / `metered-llm` test must pass
with only the `llm-budget-exceeded` shape updated. If a behavioural test needs rewriting,
that is a signal the change broke a published guarantee, not that the test was wrong.

---

## 7. Work breakdown

| # | Work | Package |
|---|---|---|
| 1 | `Spend`, `MicroUsd`, `PricedSpend`, monoid + properties | framework `types/spend.ts` |
| 2 | `Ceiling`/`Ceilings` ADT, parse from config, `narrow` (FR-B-009) | framework |
| 3 | `spendOfResponse(model, usage, cache)` bridging `cost.ts` → `Spend` | framework `llm/` |
| 4 | Meter: multi-ceiling decision, `cause` on refusal, reservation preserved | host `domain/llm-meter.ts` |
| 5 | `SpendLedgerPort` + Redis adapter + file adapter + shared contract suite | host |
| 6 | `metered-llm`: unify both paths (D6), hydrate, price, write-behind | host |
| 7 | `budget` capability: registry entry, context field, info, test fake | framework `types/node.ts` |
| 8 | Meter every context client (D7) | host `node-context-factory.ts` |
| 9 | Config: `budget` block + `llmBudgetTokens` normalizing parse | host `domain/config.ts` |
| 10 | `llm-budget-exceeded` shape + persisted-error schema migration | framework `types/errors.ts` |
| 11 | Docs (§8) | — |

Order is dependency-real: 1→3 feed 4; 5 is independent and can land first; 6 needs 4+5;
7 needs 4; 10 rides with 4.

**Suggested PR split** — this is too large for one review:

- **PR-A**: items 1, 2, 3, 10 — pure framework types and the cost bridge. No behaviour
  change beyond the error shape; establishes the vocabulary.
- **PR-B**: items 4, 6, 9 — the cost-denominated decision and the unified path, still
  in-process. Fixes P1 and P3-adjacent cleanup.
- **PR-C**: items 5, 8 — the ledger and full client coverage. Fixes P2 and P4.
- **PR-D**: item 7 — the capability surface, once the thing it exposes is correct.

Each is independently shippable and independently revertible.

---

## 8. Documentation

- **ADR-0082** — *Spend is cost-denominated; an unpriced model fails closed.* The
  substantive decision, and the one a future reader will otherwise re-litigate.
- **ADR-0083** — *Budget durability lives in a ledger port, not the checkpoint.* Records
  why spend is not `RunMeta` state: it accrues per call, not per node-terminal-state, and
  a checkpoint write per LLM call would abuse a store built for a different rhythm.
- **`CONTEXT.md`** — `Spend`, `Ceiling`, `MicroUsd`, `SpendLedger` into the ubiquitous
  language, alongside the F4 "Prompt Cache vs Response Cache" section.
- **`docs/features.md`** — a §22 for the budget capability.
- **`metered-llm.ts` header** — the amended round-trip claim (D3). Non-optional: the
  current text becomes false the moment PR-C lands.
- **`docs/spikes/2026-08-02-graph-engineering-findings.md`** — a dated note that F3's
  premise ("there is no budget") was superseded by this plan's §1. Leaving a spike to
  assert something the code contradicts is how the next reader gets misled.

---

## 9. Explicitly out of scope

| Deferred | Why, and to where |
|---|---|
| Concurrency slots / rate ceilings | Different semantics (gauge, queues rather than refuses) and nothing unbounded to constrain until dynamic width exists → **F1**. See D2. |
| Node-callable `spend()` for non-LLM cost | Needs a registered-meter design, not a raw mutator; would let the ledger disagree with provider truth. See D4. |
| Cross-run / per-tenant budgets | A different aggregate with a different lifetime; the ledger port is the right seam to add it behind later. |
| A live price feed | `PRICE_TABLE` stays static and hand-maintained. `unpriced` is what makes that safe. |
| Budget-aware retry policy | Retry currently has its own budget (`retryLimits`); unifying the two is a real deepening and deserves its own session. |

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Ledger write on the settle path adds latency to every call | It is off the admission path and after a multi-second call; measured, and documented in D3 rather than claimed away. |
| Stale `PRICE_TABLE` silently misprices a run | `unpriced` is absorbing and refuses under a usd ceiling; the model name rides in the refusal so the fix is obvious. |
| Fail-closed hydration turns a Redis blip into refused runs | Only when a ceiling is declared. The alternative — assuming zero — is the P2 bug reintroduced deliberately, which is worse. |
| The error-shape change breaks a downstream consumer | Persisted-error schema gets a migration entry; 429 mapping is unchanged; `cause` is additive to a kind that already existed. |
| Scope creep into F1 | D2 draws the slots line explicitly and §9 records it. |

---

## 11. Definition of done

- Every requirement in §5 has a test that fails without its implementation.
- The park/resume durability test — the one that fails on `main` today — passes.
- `bun run typecheck` clean at the repo root; framework and host suites green.
- ADR-0082 and ADR-0083 written; `CONTEXT.md` and `docs/features.md` updated.
- The `metered-llm.ts` round-trip claim matches what the code actually does.
- The 08-02 spike carries its superseding note.
- A round of `/review-and-fix` to zero surviving criticals, as F4 had.

---

## 12. Deviations from this plan, as built

**PR-A and PR-B were merged into one change.** §7 split them so that PR-A carried
"pure framework types and the cost bridge, no behaviour change beyond the error
shape". Building it that way would have landed `Spend`, `Ceiling` and
`spendOfCall` with no production caller until the following PR — four dead
exports, which is the exact smell the F4 round-3 review flagged and which the
typescript rules name as the pool `tsc` cannot catch. The shipped change is the
whole in-process, cost-denominated budget: every symbol it adds has a caller.
PR-C (the ledger) and PR-D (the capability) stand as planned.

**`scaleSpend` / `maxSpend` replaced the reserved-amount sum.** D3 assumed the
reservation would keep summing reserved amounts. It cannot: `Spend` has no
honest subtraction once an `unpriced` call is in the sum, so releasing exactly
what was reserved is not expressible. The reservation counts in-flight calls
instead and projects `inFlight x maxObservedCall`. This is marginally more
conservative than the previous sum of older, smaller estimates — the fail-closed
direction — and it deleted the release bookkeeping entirely.

**`reachedBy` also guards a non-finite LIMIT.** The plan only anticipated a
non-finite observation. A test written for the sanitizing constructor exposed
that a `Ceiling` bypassing `ceilings()` with a `NaN` limit never refuses:
`observed >= NaN` is false forever. `Ceiling` is a plain structural type, so
nothing prevents such a value reaching the comparison. Both sides are now
guarded.

**One fix outside the plan's scope: `llm.metered` was logging model output.**
`record` spreads what it is handed, and `settle` handed it the whole
`LlmResponse` — which extends `TokenUsage` but also carries `output`,
`thinking`, and `rawText`. Model output and chain-of-thought were reaching an
info-level log line with none of the redaction the span path applies to the same
content. Pre-existing, unrelated to budgets, and inside the function this change
rewrites, so it was fixed here rather than filed: `pickUsage` narrows a response
to exactly its four figures, with a regression test.

**ADR-0083 was not written.** It records a decision about the ledger port, which
this change does not build. It belongs with PR-C.

---

## 13. PR-C, as built

The durable ledger shipped. Deviations from §D3:

**The encoding, not a lock, is what makes appends safe.** D3 assumed `add` would
be an atomic increment and left it there. Working through it surfaced that
`Spend` is not purely numeric — `unpriced` carries a SET of model names — so a
single `HINCRBY` could not express it. The record is three sums plus a set
union, which is exactly `Spend`'s monoid, and Redis has an atomic primitive for
each. Concurrent appends therefore need no lock, no CAS, and no transaction.
That property is now the reason the design is what it is, and it is pinned by an
order-independence property test run against both adapters.

**`add` returns nothing**, where D3 had it return the new total. A total
assembled from several independent atomic commands can disagree with a
concurrent writer's view, so nothing could trust it — and the in-process meter
already knows the figure.

**`RedisPort` grew three methods** (`hIncrBy`, `hGetAll`, `expire`), all generic
Redis primitives rather than domain-shaped ones, parsed once at construction so
a misconfigured adapter is detected in ONE place and DOWNGRADES loudly (an
`error` log naming the missing primitives) rather than failing — refusing every
run over a metering capability would turn a configuration gap into an outage.

**The file adapter did not ship in PR-C.** D3 named Redis and file. Redis and
in-process shipped first; PR-D subsequently added the framework File Spend
Store and host adapter described in §14.

**P4 (metering every client) stayed out of PR-C.** PR-D subsequently closed it
with typed `clientKind: "llm"` metadata and one Run Spend Authority (§14).

**One test-infrastructure finding, worth recording.** `packages/host/tsconfig.json`
excludes `src/__tests__`, so those files are NEVER typechecked. Adding a
required field to `SharedInfra` compiled cleanly and then failed at runtime in
six fixtures. Out of scope to fix here, but it means the host's largest test
directory has no compile-time contract with the code it tests.

---

## 14. PR-D, as built — F3 complete

PR-D shipped the seventh built-in, read-only `budget` capability. `spent()`
returns a fresh deeply immutable settled snapshot; `remaining()` returns
admission-safe projected headroom using the same `projectedSpend` function as
the next admission gate. Reached numeric axes clamp to zero and unknown USD
cost remains an explicit `unpriced` union member.

The mutable accounting cell moved from each decorator into one
`RunSpendAuthority` per execution slice. `ctx.llm`, `judgeLlm`, and every custom
boot-scoped LLM handle marked `clientKind: "llm"` delegate to that authority and
therefore share one meter, reservation state, ledger, ceiling, budget view, and
client-key-attributed logs. The conditional `CapabilityHandle` type requires the
marker for LLM clients and forbids it for non-LLM clients; no structural runtime
detection was introduced.

File durability shipped as a high-level `createFileSpendStore` on
`@fuguejs/framework/file`, with strict V1 records, digest ownership,
verified-directory/symlink checks, one F6 lock domain per run, and whole-record
atomic replacement. The host's `createFileSpendLedger` is a thin
`FrameworkError` → `spend-ledger-unavailable` adapter. Stock Redis-first wiring
and the in-process fallback remain unchanged; file-runtime embedders inject the
adapter explicitly.

This closes P3, P4, and the PR-C file gap. The remaining deferred work in §9
(concurrency slots, non-LLM registered meters, cross-run budgets, live pricing,
and retry-policy unification) remains intentionally out of scope.
