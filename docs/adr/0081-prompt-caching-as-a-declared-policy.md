# ADR-0081: Prompt caching as a declared policy, not a placement API

## Status
Accepted

## Date
2026-08-26

## Context

Fugue sent no `cache_control` anywhere. Every `sendWithTools` turn re-sent the system prompt, the appended JSON-schema instruction, every tool spec and the entire accumulated message history at full input price; a ten-turn loop paid for its prefix ten times. Anthropic prices a cache read at roughly 0.1x the base input rate, so the break-even is two requests. The absence also blocks F1 (runtime-width fan-out): fan-out multiplies one shared prefix by N, and without caching that is N full-price copies.

The provider's caching contract is small but unforgiving, and every rule of it is a way for a caller to be silently wrong:

- Caching is a **prefix match** over the rendered `tools → system → messages` order. A byte change anywhere in the prefix invalidates everything after it, and any content after the last breakpoint is never cached.
- At most **four** `cache_control` breakpoints per request; a fifth is a 400.
- A breakpoint carries a TTL of exactly `5m` (the default, expressed by omitting `ttl`) or `1h`, priced at a 1.25x and 2x write premium respectively.
- The **minimum cacheable prefix is model-dependent** — 512 to 4096 tokens. Below it the provider caches nothing, reads nothing, and raises nothing.
- A breakpoint walks back at most **20 content blocks** to find a prior entry.

A second problem was latent in the existing code and would have become a live one the moment any breakpoint appeared. Anthropic reports `usage.input_tokens` as the **uncached remainder** — cached prompt tokens are excluded and reported separately as `cache_creation_input_tokens` / `cache_read_input_tokens`. The framework's `LlmResponse.tokensIn` was assigned straight from `input_tokens` in six places, and the host's per-run token budget derives its cumulative from that field. Enabling caching would therefore have shrunk every budgeted run's apparent consumption with no error raised. OpenAI is the mirror image: its `input_tokens` **includes** cached tokens, reported under `input_tokens_details.cached_tokens`. Any single shared assumption about "input tokens" is wrong for one of the two providers.

## Options Considered

1. **A declared policy ADT, with the framework deriving breakpoint placement**
   - Pros: the caller states only what it knows — which parts of its prompt are stable — and the four-slot cap, the prefix-ordering rule and the TTL vocabulary never reach it; the two policies fugue emits are structural (end of system, end of the latest turn) so an out-of-range or out-of-order breakpoint is unrepresentable; a `conversation` policy can be excluded from the single-shot request type at compile time, since a single call has no second turn to read what the first wrote; placement is a pure function, testable without a provider.
   - Cons: does not express placements fugue has no use for today (multiple independent prefixes, a breakpoint mid-history); a new placement need means a new union member rather than a caller-side change.

2. **A caller-supplied breakpoint list (indices or block references)**
   - Pros: maximally expressive; supports any placement the provider supports.
   - Cons: puts the four-slot cap, the prefix-match rule and the ordering constraint in every call site, where they can only be enforced at runtime — exactly the class of rule this codebase makes structural elsewhere; every consumer re-derives the same two placements; a wrong index is a 400 from the provider rather than a compile error. Rejected.

3. **Always-on automatic caching**
   - Pros: no API surface at all; every DAG benefits without an edit.
   - Cons: a single call over a large *unique* prefix pays the 1.25x write premium and never reads it back — strictly worse than not caching; cost would change under existing DAGs without any change to their code. Rejected.

4. **Nesting a `TokenUsage` value inside `LlmResponse` (rather than extending it)**
   - Pros: a clean separation between "the answer" and "what it cost".
   - Cons: `tokensIn`/`tokensOut` already lived on `LlmResponse` with exactly the meaning the new type gives them, so nesting is a rename of two public fields across fourteen modules for no behavioural gain. Rejected in favour of `LlmResponse extends TokenUsage`.

## Decision

**Prompt caching is declared as a policy; the framework derives the placement.**

```ts
type CacheTtl = "5m" | "1h";

type SingleShotCachePolicy =
  | { kind: "none" }
  | { kind: "static-prefix"; ttl: CacheTtl };

type ConversationCachePolicy =
  | SingleShotCachePolicy
  | { kind: "conversation"; ttl: CacheTtl };
```

`LlmRequest.cache` accepts the single-shot union; `SendWithToolsRequest.cache` accepts the conversation union. `planPromptCache` (pure, `llm/prompt-cache.ts`) maps a policy to a `PromptCachePlan` of two booleans and a TTL; the clients translate that plan into wire format. `static-prefix` emits one breakpoint at the end of `system`, which caches the tool specs with it because they render first. `conversation` adds a **rolling** breakpoint on the last content block of the latest turn, applied to a copy on the way to the wire so the accumulated history itself never carries `cache_control` — that is what makes it roll without a "strip the previous one" step, and what keeps the emitted count at exactly two however long the loop runs.

**Caching is opt-in everywhere.** Omitting the field is identical to `{ kind: "none" }` and produces a request byte-identical to the pre-caching one. No node kind defaults to caching, including tool loops.

**`tokensIn` keeps its name and gains a stricter meaning: every prompt token.** The clients normalise to it — Anthropic sums `input_tokens + cache_creation + cache_read`, OpenAI passes its already-inclusive total through. The uncached remainder is derived (`uncachedInputTokens`), never stored, the same discipline the host meter already applies to its cumulative total and for the same reason: storing a total beside its parts makes `total !== sum(parts)` representable, and that value feeds a budget decision. The cache split rides alongside as two additional required fields on a single `TokenUsage` value type that `LlmResponse`, `PartialTokenUsage`, the tool loop's cross-turn accumulator, the host meter's delta and span enrichment all share.

**A declared policy that reports neither a write nor a read is logged once per node.** Requested-but-inert caching is the silent-success mode this contract invites, and it is indistinguishable from working caching without the warning.

**Cost weights the three prompt-token classes separately** — uncached at 1.0x, cache-write at 1.25x (`5m`) or 2.0x (`1h`), cache-read at 0.1x — in one implementation shared by `computeCostUsd` and span enrichment, which previously each had their own copy of the arithmetic.

## Consequences

- Illegal placements are unrepresentable rather than rejected: no caller can exceed the breakpoint cap, order a breakpoint after volatile content, or ask a single-shot call for conversation caching.
- A DAG's cost cannot change without an explicit edit to a node config. Existing DAGs are unaffected byte-for-byte.
- Enabling caching can no longer corrupt budget accounting, because the figure the budget reads is the complete prompt count on both providers.
- The two-number token pair is gone from the framework's vocabulary; adding a further usage dimension is a change to one value type rather than to fourteen call sites.
- Usage records written before this change parse into a complete `TokenUsage` with zeroed cache fields (the wire schema defaults them). No checkpoint migration, no format version bump.
- **OpenAI ignores the policy entirely.** The provider offers no request-side cache control and caches automatically, so a declared policy changes neither what that client sends nor what it reports — `cacheReadTokens` reflects whatever the provider did on its own, independent of the field. These are two separate facts, not one causal one: the policy is a request-construction no-op there, *and* the client reports `cached_tokens` regardless. Both halves are pinned by regression tests (request-body identity with and without a policy; usage normalisation with no policy declared).
- Placements fugue does not emit today (multiple independent cached prefixes; a breakpoint mid-history) require a new union member. Accepted: the two shapes cover the framework's node kinds, and a third can be added without touching any caller.
- A turn that appends more than 20 content blocks breaks the provider's lookback chain. Documented, and it surfaces as an inert-policy warning rather than as silence.

## Related

- ADR-0015 — conditional edges (the same "declare the shape, let the runtime place it" discipline at the graph level)
- ADR-0051 — capability registry module augmentation
- `docs/plans/2026-08-26-f4-prompt-caching.md` — the implementation plan and its requirement table
- `docs/spikes/2026-08-12-fugue-loom-convergence-research.md` — F4's place in the roadmap, and why it precedes F1
