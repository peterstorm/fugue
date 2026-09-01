# ADR-0082: Budgets are denominated in spend, and an unpriced model fails closed

## Status
Accepted

## Date
2026-08-27

## Context

The host has enforced a per-run LLM budget since W1: `llmBudgetTokens`, compared before every call against a cumulative of `tokensIn + tokensOut`, with a concurrency reservation bounding overshoot. It is careful code and it worked, because before prompt caching every prompt token cost the same and a token count was a serviceable proxy for money.

ADR-0081 ended that. A cache read bills at **0.1x** the base input rate and a cache write at **1.25x** (`5m`) or **2.0x** (`1h`). Three runs, each reporting `tokensIn: 100_000` and `tokensOut: 10_000`, are indistinguishable to a token ceiling:

| Composition | Input cost, in 1.0x token-equivalents |
|---|---|
| 100k uncached | 100_000 |
| 95k cache-read + 5k uncached | **14_500** |
| 100k cache-write at `1h` | **200_000** |

The most expensive costs **13.8x** the cheapest while every one of them consumes exactly 110,000 units of the same ceiling. F4 did not merely leave the budget alone; it made the budget a worse proxy for spend than it had been. The figures needed to fix it — `cacheWriteTokens`, `cacheReadTokens` — were already on the meter, and the cost arithmetic was already in `llm/cost.ts`. Only the decision was still counting tokens.

A second problem sat inside the refusal itself. `llm-budget-exceeded` carried a `cumulative` field documented as the SETTLED figure, while the decision that produced it might have come from the PROJECTION including in-flight reservations. The two were reconciled by a comment, so an operator could legitimately read `cumulative 100 >= budget 250` and conclude the host had refused a call it had no reason to refuse.

A third: `PRICE_TABLE` is hand-maintained, and `computeCostUsd` returns **0** for a model it does not recognise. Zero is a defensible answer for a display figure. As budget input it means FREE — an unpriced model would consume no budget at all, making "use a model nobody added to the table" the cheapest available route past a dollar ceiling.

## Options Considered

1. **`Spend` as a multi-axis value, with ceilings as a non-empty set**
   - Pros: money becomes expressible, and tokens and calls remain expressible beside it — they answer genuinely different questions ("how much context moved", "how many round trips", "what did it cost") and an operator may want any subset; duplicate axes collapse to their minimum in the smart constructor, which makes narrowing and construction the same operation; "no budget" keeps exactly one spelling (`undefined`), so no read site needs a limits-that-limit-nothing branch.
   - Cons: three axes instead of one number; the refusal has to say which axis it means.

2. **Replace the token ceiling with a dollar ceiling outright**
   - Pros: one axis, and the one that means what an operator meant.
   - Cons: a dollar ceiling is unevaluable on an unpriced model, so the only budget available would be the one that fails closed hardest; a call ceiling is the cheapest circuit-breaker for a tool loop stuck retrying and cannot be expressed in dollars at all; `llmBudgetTokens` shipped in v0.5.1 and would have no honest translation. Rejected.

3. **Keep tokens, and weight them by the cache multipliers**
   - Pros: no new type; one number stays one number.
   - Cons: produces a figure that is neither tokens nor money — an operator setting `llmBudgetTokens: 100000` would be configuring a unit with no external referent, and could not reconcile it against a provider invoice or against the `tokensIn` on the same log line. Rejected.

4. **A `spend()` method on a node-facing budget capability** (proposed by the 08-02 spike)
   - Pros: lets a node account for non-LLM cost.
   - Cons: spend is a CONSEQUENCE of a metered provider call, not an action a node performs; a caller-driven mutator lets the accumulator disagree with the provider's reported usage, which is precisely the class of illegal state that deriving-never-storing was introduced to prevent. Deferred, and if it returns it should be a registered meter rather than a raw mutator.

5. **Fail OPEN on an unpriced model under a dollar ceiling** (treat unknown cost as zero)
   - Pros: never refuses a run for a reason the operator did not configure.
   - Cons: the failure mode is unbounded spend, silently, on exactly the models most likely to be new and expensive. Rejected without much hesitation.

## Decision

**Spend, not tokens.** The meter accumulates a `Spend` — `{ tokens, calls, usd }` — and `llm/cost.ts` gains `spendOfCall`, the single producer of budget-facing cost. It reuses the same cache-weighted arithmetic ADR-0081 established, so the multipliers reach the budget through exactly one path.

**Money is a bounded exact integer.** `MicroUsd` (1e-6 USD, branded) is what ceilings compare against; the raw USD float stays display-only. Every in-memory value is a non-negative safe integer. Every positive per-call cost rounds upward at the float→integer boundary, so repeated sub-micro-dollar calls cannot disappear from the USD total. Positive overflow, including infinity, saturates at `Number.MAX_SAFE_INTEGER`, which is fail-closed because every valid monetary ceiling is then reached. Within that domain, settlement order cannot introduce float drift or operator disagreement.

**Unknown cost is a union member, not a sentinel.**

```ts
type PricedSpend =
  | { kind: "priced";   micros: MicroUsd }
  | { kind: "unpriced"; models: UnpricedModels; knownMicros: MicroUsd };
```

`unpriced` **absorbs** under `addSpend`: once any call in a run was unpriced, no total for that run is trustworthy, and the type says so instead of a comment saying so. It carries the offending model names — so the refusal message names what to add to `PRICE_TABLE` — and `knownMicros`, the priced portion, which is a genuine lower bound and turns "unknown" into "at least $1.23, plus model X".

**A `usd` ceiling against unpriced spend always breaches.** Token and call ceilings do not: they are perfectly evaluable on an unpriced model, and refusing there would apply fail-closed where nothing is unknown. Provider usage uncertainty is separate: a call with no trustworthy usage persists an absorbing unknown marker, after which token and USD ceilings are unevaluable and fail closed while call ceilings remain exact.

**Ceilings are a non-empty, one-per-kind, canonically-ordered list.** `ceilings()` is the only constructor; duplicates collapse to their **minimum**. Composing a DAG's limits with a caller-supplied set is therefore just `ceilings([...dag, ...request])`, and "raise my budget" is not expressible — deny-by-default falls out of the data structure rather than out of a check somebody must remember to write.

**Pricing follows the provider-effective model.** Every LLM binding carries a composition-owned policy: request-selected providers price the request model, while fixed deployments bind one model and reject conflicting requests before egress. The metered boundary parses each request into one immutable own-data snapshot and passes that exact value to both admission and provider egress. Stateful accessors therefore cannot expose one model/cache policy to pricing and another to the provider.

**A refusal names its ceiling and its basis.**

```ts
kind: "llm-budget-exceeded";
cause: Breach;   // { reached | unpriced | unknown-usage }, each carrying `ceiling` and `basis: "settled" | "projected"`
```

The basis is correct **by construction**: the admission gate evaluates settled spend and the projection as two separate calls to `firstBreach`, each told which figure it was handed. Nothing infers afterwards which one drove the decision.

**`llmBudgetTokens` stays, as sugar.** It normalises into `[{ kind: "tokens", limit }]` — the same value the `llmBudget` block produces — so there is one enforcement mechanism rather than a legacy path beside a new one.

## Consequences

- A cached run and an uncached one at identical token counts are now distinguishable by the budget, which is the entire point.
- A dollar ceiling refuses on a model with no price-table entry, including the first time it is used in a run. This is a **deliberate false positive**: adding the model to `PRICE_TABLE` is the fix, and the refusal names the model. DAGs with only token or call ceilings are unaffected.
- The reservation state became simpler while gaining an axis: it counts in-flight calls rather than summing reserved amounts, because `Spend` cannot be subtracted honestly once an `unpriced` call is in the sum. The projection uses the current estimate for every in-flight call — marginally more conservative than the previous sum of older, smaller estimates, which is the fail-closed direction.
- `llm-budget-exceeded` changed shape. It is a control-plane error with a wire schema, so the persisted parser changed with it; the HTTP mapping (429 + `Retry-After`) is untouched.
- The two accounting paths in `metered-llm` are now one. They were duplicated when the shared sequence was four lines; each must now additionally price the response and evaluate several ceilings, which is where two copies would have diverged.
- **At this decision's adoption, the budget was not durable.** A resumable run built a fresh NodeContext per execution slice, so parking and resuming restarted the accumulator at zero. ADR-0083 subsequently introduced the Spend Ledger: current slices hydrate cumulative spend and append every settled call through the selected ledger adapter.
- Also fixed in passing, and unrelated to budgets: `llm.metered` spread the whole `LlmResponse` onto an info-level log line, so model output, `thinking`, and `rawText` were being logged with none of the redaction the span path applies. `pickUsage` narrows a response to exactly its four token figures. See `pickUsage`'s doc comment for why it lists fields where the surrounding convention spreads them.

## Related

- ADR-0081 — prompt caching as a declared policy (the change that made a token ceiling wrong)
- `docs/plans/2026-08-27-f3-budget-capability.md` — the F3 plan, its requirement table, and the deferred work
- `docs/spikes/2026-08-02-graph-engineering-findings.md` §F3 — the original proposal, whose premise ("there is no token or cost budget") this supersedes
- `docs/spikes/2026-08-12-web-research-addendum.md` §A4 — "budget = slots"; slots are deferred to F1, where dynamic width makes them meaningful
