# Plan: F4 — Prompt Caching

**Created:** 2026-08-26
**Status:** Implemented — see §14 for deviations from this plan
**Branch:** `worktree-f4-prompt-caching` (worktree `.claude/worktrees/f4-prompt-caching`)
**Baseline:** `main` @ 0.5.1 (F6 file-backed durable runtime merged, PR #37)
**Roadmap position:** F4 in `docs/spikes/2026-08-12-fugue-loom-convergence-research.md` — the recommended
order was `F6 → F4 → F3 → F1 → …`. F6 has shipped; F4 is next and is a hard precondition for
F1 (dynamic fan-out): fan-out over a shared prefix without caching costs ~10× the necessary rate.

---

## 1. Problem

Fugue has **no prompt caching**. `grep -r 'cache_control\|cacheControl\|promptCach' packages/*/src`
returns zero hits at HEAD. Three consequences:

1. **Economics.** Every `sendWithTools` turn re-sends the full system prompt, the appended
   JSON-schema instruction, every tool spec, and the entire accumulated message history at full
   input price. A 10-turn loop pays for its prefix 10 times. Anthropic prices a cache read at
   ~0.1× base input; break-even is two requests.
2. **Blocked roadmap.** F1 (runtime-width fan-out) multiplies the same shared prefix by N. The
   08-02 spike states the ordering constraint plainly: *"Do not start F1 before F3 and F4."*
3. **Silent under-reporting once caching exists anywhere.** Anthropic's `usage.input_tokens`
   **excludes** cached tokens; the cached figures arrive as `cache_creation_input_tokens` and
   `cache_read_input_tokens`. Today `AnthropicLlmClient` sets `tokensIn = usage.input_tokens`
   (`anthropic-client.ts:179`, `:210`, `:293`, `:313`, `:341`, `:350`). The moment a
   cache_control breakpoint appears — whether from us or from a future Anthropic
   auto-caching default — that figure silently becomes "the uncached remainder", and the host's
   per-run token budget (`packages/host/src/domain/llm-meter.ts`) under-counts without any error.
   Adding the breakdown is therefore a **correctness requirement of this change, not a nicety.**

## 2. Verified current state

| Fact | Evidence |
|---|---|
| No caching anywhere | `grep -rn "cache_control\|cacheControl\|promptCach" packages/*/src` → 0 hits |
| System prompt is a bare string on the wire | `anthropic-client.ts:143` `system: req.system`; `:262` `system` |
| Tool loop resends `system` + `tools` + growing `messages` every turn | `anthropic-client.ts:249-269` |
| `tokensIn` = Anthropic `input_tokens` (excludes cache) | `anthropic-client.ts:179-181, 208-213` |
| Token pair is threaded through 14 non-test files | `grep -rln tokensIn packages/*/src` |
| A named usage type already exists | `types/errors.ts:35` `PartialTokenUsage` |
| Usage crosses the persistence boundary | `types/errors.ts:361` `persistedUsageSchema` |
| Cost is computed in **two** places with **two** rate lookups | `llm/cost.ts:23` `computeCostUsd`; `tracing/span-enrich.ts:25,51-52` `getCostRates` |
| Host budget derives its total from the pair | `host/src/domain/llm-meter.ts` `runTotal(u) = u.tokensIn + u.tokensOut` |
| `cache` already means something else in this codebase | `CONTEXT.md:168` — `cache/` is *response* caching (fugue's own, keyed by prompt fingerprint) |
| `fast-check` is available for property tests | `packages/framework/package.json` devDeps |

## 3. External contract (constrains the design)

From the Anthropic prompt-caching contract (loaded via the `claude-api` skill, `shared/prompt-caching.md`):

- **Caching is a prefix match.** Render order is `tools` → `system` → `messages`. A byte change
  anywhere in the prefix invalidates everything after it. A breakpoint on the last `system` block
  therefore caches **tools + system** together.
- **Max 4 `cache_control` breakpoints per request.**
- **`{"type":"ephemeral"}`** = 5-minute TTL; **`{"type":"ephemeral","ttl":"1h"}`** = 1 hour.
- **Economics:** read ≈ 0.1× base input; write = **1.25×** (5m) or **2×** (1h). Break-even is
  2 requests at 5m, 3 at 1h.
- **Minimum cacheable prefix is model-dependent** — 512 / 1024 / 2048 / 4096 tokens depending on
  model. Below it *nothing caches and no error is raised* (`cache_creation_input_tokens: 0`).
- **`usage` fields:** `cache_creation_input_tokens`, `cache_read_input_tokens`. `input_tokens` is
  the **uncached remainder only**; total prompt = the sum of all three.
- **20-block lookback:** a breakpoint walks back at most 20 content blocks to find a prior entry.
  A single turn that appends >20 blocks breaks the chain.
- **Concurrency:** an entry becomes readable only after the first response *begins streaming* —
  N parallel identical requests all miss. (Directly relevant to F1; recorded here for that plan.)
- **OpenAI is the asymmetric case:** caching is automatic with no request-side control, and its
  `input_tokens` **includes** cached tokens (reported under `input_tokens_details.cached_tokens`).

## 4. Design

### D1 — `PromptCachePolicy`: an ADT that makes the provider's rules unrepresentable-when-violated

The author declares *what is stable*; the framework decides *where the breakpoints go*. Callers
never write a breakpoint index, never count to four, and cannot place a breakpoint after volatile
content — because the type gives them no way to express it.

```ts
// framework/src/types/llm.ts  (functional core — pure types)

/** Provider-side prompt-cache lifetime. Not a raw string: the provider accepts exactly two. */
export type CacheTtl = "5m" | "1h";

/**
 * What the caller asserts is stable. The framework derives breakpoint placement.
 *  - "none"          — no cache_control is emitted (default; today's behaviour).
 *  - "static-prefix" — tools + system are stable ⇒ one breakpoint at the end of `system`.
 *  - "conversation"  — additionally roll a breakpoint onto the last block of each completed
 *                      turn, so turn N reads the prefix turn N-1 wrote.
 */
export type SingleShotCachePolicy =
  | { readonly kind: "none" }
  | { readonly kind: "static-prefix"; readonly ttl: CacheTtl };

export type ConversationCachePolicy =
  | SingleShotCachePolicy
  | { readonly kind: "conversation"; readonly ttl: CacheTtl };
```

`LlmRequest.cache?: SingleShotCachePolicy` and `SendWithToolsRequest.cache?: ConversationCachePolicy`.
Two distinct types, not one with a runtime guard: **`{ kind: "conversation" }` on a single-shot
request is a compile error**, because a single-shot call has no second turn to read what the first
wrote. Absent field ≡ `{ kind: "none" }` ≡ today's behaviour, byte-for-byte.

Breakpoint budget by construction: `static-prefix` = 1, `conversation` = 2. Never approaches 4.

**Why an opt-in policy rather than always-on:** a single call with a large *unique* system prompt
that never repeats pays the 1.25× write premium and never reads — strictly worse. Explicit
declaration is also the house style (ADR-0015's conditional edges, `requires: [...] as const`), and
the vault's own guidance for this roadmap: *"compose primitives, never a DSL."*

### D2 — `TokenUsage`: one value type owning the token vocabulary (deepening)

**Deepen finding (advisory, in scope).** `{ tokensIn, tokensOut }` is passed as a loose pair
across 14 non-test files — `LlmResponse`, `PartialTokenUsage`, the tool loop's cross-turn
accumulator, six error arms in each client, `enrichLlmSpan`, the MLflow exporter, `eval-judge`,
the host meter and its metering log. Adding two more raw numbers to that pair multiplies the
places a field can be forgotten. The concept has no owner. **Deletion test:** delete a
`TokenUsage` module and the addition/derivation logic reappears in the tool loop, the meter, the
cost function, and both clients — it earns its keep.

```ts
// framework/src/llm/token-usage.ts — functional core, no I/O

export interface TokenUsage {
  /** ALL prompt tokens: uncached + cache-write + cache-read. Provider-normalised. */
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Prompt tokens written to a new cache entry this call (billed at the write premium). */
  readonly cacheWriteTokens: number;
  /** Prompt tokens served from an existing cache entry (billed at ~0.1×). */
  readonly cacheReadTokens: number;
}

export const NO_TOKENS: TokenUsage;                       // all-zero identity
export const tokensOnly: (tokensIn: number, tokensOut: number) => TokenUsage;
export const addUsage: (a: TokenUsage, b: TokenUsage) => TokenUsage;   // monoid, for the loop
export const uncachedInputTokens: (u: TokenUsage) => number;           // derived, never stored
export const cacheHitRatio: (u: TokenUsage) => number;                 // derived
```

**The load-bearing decision: `tokensIn` keeps its name and gains a stricter meaning — *every*
prompt token.** For Anthropic that means `input_tokens + cache_creation + cache_read` (today's
value when caching is off, so no behaviour change); for OpenAI `input_tokens` is already
inclusive. `uncachedInputTokens` is *derived*, never stored — the same discipline `llm-meter.ts`
already applies to `runTotal`, and for the same reason: storing both a total and its parts makes
`total ≠ sum(parts)` representable, and that value feeds the budget check.

Consequences: the host budget stays correct with no change to its semantics; the MLflow
`total_tokens` stays truthful; no rename churn across 14 files; and the invariant
`cacheWrite + cacheRead ≤ tokensIn` is a property test.

`PartialTokenUsage` becomes an alias of `TokenUsage` (one vocabulary, two names retired to one).

### D3 — One cost module (deepening)

**Deepen finding (advisory, in scope — forced by D2).** `computeCostUsd` (`llm/cost.ts:23`) and
the inline `getCostRates` arithmetic (`tracing/span-enrich.ts:25,51-52`) are two implementations
of the same calculation over the same `PRICE_TABLE`. Under caching they would disagree: one
would learn the multipliers, the other would keep charging cache reads at 10× their price. Fold
the second into the first.

```ts
export const computeCostUsd = (
  model: string,
  usage: TokenUsage,
  writeTtl: CacheTtl = "5m",
): number;
// uncachedInputTokens(u) × 1.00  +  cacheWriteTokens × writeMultiplier(writeTtl)
//   + cacheReadTokens × 0.10  ... all × inputPer1M ; + tokensOut × outputPer1M
// writeMultiplier: "5m" → 1.25, "1h" → 2.00
```

The write TTL is a **parameter, not a stored field**: it is constant per request and the caller
(`llm-pipeline.ts`, which holds the config) always knows it. That keeps `TokenUsage` four plain
numbers with a trivially total monoid, instead of splitting the write count per TTL.

`PRICE_TABLE` staleness (no Opus 5 / Sonnet 5 rows) is **out of scope** — the multipliers are
ratios of whatever base rate a row carries, so no table change is needed for this feature.

### D4 — Observability: caching that silently does nothing must make noise

Below the model's minimum cacheable prefix, the provider caches nothing and returns no error.
This is precisely the silent-success failure mode this codebase legislates against elsewhere
(`Required Corruption Observability`, CONTEXT.md:41). So:

- New semantic-convention constants: `gen_ai.usage.cache_creation_input_tokens`,
  `gen_ai.usage.cache_read_input_tokens` (framework-owned; OTel GenAI semconv has no standard
  cache attribute today — documented as such next to the constants).
- `setLlmUsageAttributes` and `enrichLlmSpan` take a `TokenUsage`, not two numbers.
- `ai.prompt_cache.policy` (`"none" | "static-prefix" | "conversation"`) and
  `ai.prompt_cache.effective` (boolean) on the LLM span.
- **When a policy other than `none` was requested and the call reports zero write **and** zero
  read tokens, `ctx.logger.warn` once per node** naming the likely cause (prefix below the model
  minimum, or a volatile byte in the prefix). Requested-but-inert caching never passes silently.
- MLflow `mlflow.chat.tokenUsage` gains the two cache figures alongside the existing three.

### D5 — Host meter

`RunUsage` in `packages/host/src/domain/llm-meter.ts` gains the two cache fields;
`runTotal` is **unchanged** (`tokensIn + tokensOut`) because D2 keeps `tokensIn` inclusive.
The metering log line gains the breakdown so an operator can see cache effectiveness per node.
`metered-llm.ts` threads `TokenUsage` instead of two numbers on both the `ok` and partial-usage
error paths.

### D6 — Persistence compatibility

`persistedUsageSchema` (`types/errors.ts:361`) parses usage off durable journals written by
0.5.x. Parse, don't validate: the two new fields are `z.number().optional().default(0)` on the
**wire** schema only — an old record parses into a complete `TokenUsage` with zeroes, which is
exactly what it means. The in-memory type keeps all four fields required, so no construction site
can silently omit one. No migration, no version bump of the checkpoint format.

## 5. Requirements

| ID | Requirement |
|---|---|
| FR-PC-001 | A caller declares cache intent as a `PromptCachePolicy`; the framework derives breakpoint placement. A `conversation` policy is unrepresentable on a single-shot request. |
| FR-PC-002 | `static-prefix` emits exactly one `cache_control` breakpoint, on the final `system` block, so tools + system are cached together. |
| FR-PC-003 | `conversation` additionally rolls one breakpoint onto the last content block of the most recently appended turn; total breakpoints per request never exceeds 2. |
| FR-PC-004 | Absent/`none` policy produces a request byte-identical to today's. |
| FR-PC-005 | `TokenUsage.tokensIn` counts every prompt token for every provider (`uncached + write + read`). |
| FR-PC-006 | Cache figures are reported on success **and** on every usage-carrying error arm (extends FR-W0-001 attribution to cached tokens). |
| FR-PC-007 | The tool loop accumulates cache figures across turns via the `TokenUsage` monoid. |
| FR-PC-008 | Cost weights cache-write by TTL (1.25× / 2×) and cache-read by 0.1×. |
| FR-PC-009 | A requested-but-inert cache policy is logged once per node, never silent. |
| FR-PC-010 | OpenAI honours the policy as a request-construction no-op and still reports `cached_tokens` as `cacheReadTokens`. |
| NFR-PC-001 | Usage records written by earlier versions parse into a complete `TokenUsage` (cache fields default 0). |

**Invariants (property-tested):**
- `INV-PC-1` `cacheWriteTokens + cacheReadTokens ≤ tokensIn`
- `INV-PC-2` `addUsage` is associative with `NO_TOKENS` as identity (monoid)
- `INV-PC-3` `uncachedInputTokens(u) ≥ 0` for every well-formed `u`
- `INV-PC-4` cost is monotonic in each token field, and `cost(cacheRead=n) < cost(uncached=n)` for any `n > 0` on a priced model
- `INV-PC-5` breakpoint count ≤ 2 for every policy and every turn index
- `INV-PC-6` a `none` policy yields a params object deep-equal to the pre-change builder's

## 6. Test strategy

**Property tests (`fast-check`, framework package):** INV-PC-1..6, plus round-trip
`persistedUsageSchema.parse(serialize(u)) ≡ u` and old-record-parses-to-zeroes.

**Example tests:**
- `anthropic-client`: for each policy — assert the exact shape handed to `messages.create`
  (system becomes a block array; `cache_control` present on the right block and nowhere else;
  `ttl` present only for `1h`), asserted through the existing structural `AnthropicSdkLike` seam
  — no SDK mocking framework, matching the house pattern.
- `anthropic-client`: usage normalisation — a stubbed response with
  `input_tokens: 10, cache_creation_input_tokens: 900, cache_read_input_tokens: 0` yields
  `tokensIn: 910`; the read-hit case likewise. Both success and each error arm.
- `openai-client`: `input_tokens_details.cached_tokens` maps to `cacheReadTokens` and `tokensIn`
  is **not** double-counted (the asymmetry regression test).
- `tool-use-loop`: cross-turn accumulation of cache figures, including the partial-usage error path.
- `cost`: the four multipliers, both TTLs, and the unknown-model zero path.
- `llm-pipeline`: inert-policy warning fires exactly once and does not fire for `none`.
- `llm-meter` (host): budget arithmetic unchanged when cache fields are zero; correct when not.

**Deleted:** any test asserting the two-number `setLlmUsageAttributes` / `enrichLlmSpan`
signatures — superseded by tests at the `TokenUsage` interface (the interface is the test surface).

**Fake client:** `fake-client.ts` gains per-turn cache figures in its turn spec so DAG-level tests
can exercise cache accounting without a provider.

## 7. Work breakdown

| # | Step | Files |
|---|---|---|
| 1 | `TokenUsage` value type + monoid + derivations, with property tests | `llm/token-usage.ts` (new), `types/errors.ts` (`PartialTokenUsage` → alias), `types/llm.ts` |
| 2 | Persisted schema compatibility + round-trip tests | `types/errors.ts` |
| 3 | `PromptCachePolicy` ADT + pure breakpoint-placement function | `types/llm.ts`, `llm/prompt-cache.ts` (new) |
| 4 | Anthropic client: policy → params, usage normalisation, all six error arms | `llm/anthropic-client.ts` |
| 5 | OpenAI client: no-op policy, `cached_tokens` read, usage normalisation | `llm/openai-client.ts`, `llm/openai-types.ts` |
| 6 | Tool loop: accumulate `TokenUsage` | `llm/tool-use-loop.ts` |
| 7 | Cost unification + multipliers | `llm/cost.ts`, `tracing/span-enrich.ts` |
| 8 | Spans, semconv constants, inert-cache warning, MLflow fields | `llm/spans.ts`, `tracing/semantic-conventions.ts`, `tracing/mlflow-otlp-exporter.ts`, `nodes/llm-pipeline.ts` |
| 9 | Node surface: `cache` on `createLlmNode` / `createLlmWithToolsNode` configs | `nodes/llm.ts`, `nodes/llm-with-tools.ts`, `nodes/eval-judge.ts` |
| 10 | Host meter + metered adapter + metering log | `host/src/domain/llm-meter.ts`, `host/src/adapters/metered-llm.ts` |
| 11 | Fake client turn-spec cache figures | `llm/fake-client.ts` |
| 12 | ADR + docs | see §8 |
| 13 | `distill` apply pass on the diff, green baseline first | — |

Steps 1–3 are pure functional core and land first; 4–6 are the adapter edge; 7–11 are consumers.

## 8. Documentation

- **ADR-0081 — Prompt caching as a declared policy, not a placement API.** Options considered:
  (a) policy ADT with framework-derived placement *(chosen)*; (b) caller-supplied breakpoint list
  (rejected — puts the 4-breakpoint cap and prefix-ordering rule in every caller); (c) always-on
  automatic caching (rejected — pays the write premium on single-shot unique prefixes).
- **CONTEXT.md** — new terms, resolving the naming collision explicitly:
  - **Prompt Cache** — the *provider-side* cache of a request prefix, controlled by
    `PromptCachePolicy`. **Distinct from the `cache` capability**, which is fugue's own
    Response Cache keyed by cache key + prompt fingerprint (CONTEXT.md:168).
  - **Cache Breakpoint**, **Cache TTL**, **Token Usage** (four figures, `tokensIn` inclusive),
    **Inert Cache Policy** (requested but reported zero write and zero read).
- **`docs/features.md`** — new section with the what-it-catches framing used by the other 20.
- **README** — the stale lockstep version line (`0.2.0`, packages are at `0.5.1`) is fixed in
  passing since this change touches the same paragraph's subject matter.

## 9. Explicitly out of scope

- Streaming (`messages.stream`) — the clients are non-streaming today; caching is orthogonal.
- Cache pre-warming (`max_tokens: 0`) — belongs with F1, where fan-out makes it pay.
- Fan-out concurrency sequencing ("send 1, await first token, then fire N−1") — recorded in §3
  for the F1 plan; there is no fan-out to sequence yet.
- `PRICE_TABLE` refresh, and any budget re-denomination from tokens to dollars.
- OpenAI request-side cache control — the provider offers none.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `tokensIn` semantic change is invisible to existing callers | It is a no-op while every policy is `none`; INV-PC-1 and the normalisation tests pin it; the meter's own arithmetic is unchanged |
| Inert caching below the model minimum | FR-PC-009 warning + `ai.prompt_cache.effective` span attribute |
| >20 blocks appended in one tool turn breaks the lookback chain | Documented limitation; surfaces as an inert-policy warning rather than silently |
| Two clients drift on usage normalisation | The asymmetry (Anthropic exclusive / OpenAI inclusive) is pinned by a dedicated regression test in each client |

---

## 14. Deviations from this plan, as built

Recorded so the plan and the code agree rather than diverging quietly.

1. **`TokenUsage` lives in `types/token-usage.ts`, not `llm/token-usage.ts`.** `types/errors.ts`
   and `types/llm.ts` both need it, and `types/**` must not import from `llm/**` — the same
   cycle-avoidance that put the LLM-facing public types in `types/` in the first place. The
   placement module (`llm/prompt-cache.ts`) landed where planned.

2. **`LlmResponse extends TokenUsage`** rather than gaining a nested `usage` field. `tokensIn`
   /`tokensOut` already lived on it with exactly that meaning, so extending keeps every existing
   reader working and lets a response be handed straight to `addUsage` / `computeCostUsd`.
   Same for `TurnResult` in the tool loop, and for the host meter's `TokenDelta`.

3. **The cost module gained `costBreakdownUsd`.** The span's `llm.cost` event wants the
   per-class components; deriving them beside the pricing rules (rather than having the enricher
   reconstruct them from synthetic usage values) means the components and the total cannot drift.
   `costUsd` is now `costBreakdownUsd(...).total` — one arithmetic implementation, three callers.

4. **A constraint the compiler surfaced during implementation:** Anthropic rejects `cache_control`
   on `thinking` / `redacted_thinking` blocks, and the SDK's union encodes that. The rolling turn
   breakpoint therefore skips annotation when the latest block is one of those, exactly as it does
   for an empty content array. Both cases degrade to "no turn breakpoint this turn" and surface
   through the inert-policy signal rather than as a 400.

5. **Two pre-existing lint violations fixed in passing** because the repo's `lint-file` hook blocks
   any edit to a file carrying one: `toolChoiceToAnthropic` and `toolChoiceToOpenAi` were
   `switch` statements where the rules require `ts-pattern`. Behaviour-preserving.

## 15. Verification

| Check | Result |
|---|---|
| Repo-wide typecheck (`bun run --filter '*' typecheck`) | 0 errors |
| Framework suite | 3228 pass, 0 fail, 52 skip (184 files) |
| Host suite | exit 0, 0 failures |
| Doc links (`bun run check:docs`) | 19 files, all links resolve |
| Baseline before this change | 3182 pass / 1 environmental timeout (`boundary-imports`, a filesystem-scan timing flake that passes on re-run) |

New tests: 46 across seven files — `token-usage-property`, `prompt-cache`, `prompt-cache-clients`,
`prompt-cache-conversation`, `prompt-cache-cost`, `prompt-cache-inert`, `prompt-cache-persistence`.
