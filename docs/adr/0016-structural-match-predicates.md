# ADR 0016: Structural-match predicates for conditional edges

**Status:** Accepted
**Date:** 2026-05-10
**Plan ref:** `docs/plans/2026-05-10-structural-predicates.md`
**Supersedes:** ADR 0015's `when: Guard` closure form (rest of ADR 0015 unchanged).
**Related:** ADR 0007 (legacy fast path), ADR 0009 (runtime routing by node config).

## Context

ADR 0015 introduced conditional edges with `when: (output: unknown) => boolean` closures. Guards were required to be pure, but this was a *discipline contract*, not a system guarantee, with several failure modes that surfaced over time:

1. **Replay non-determinism.** A guard closing over `Date.now()` or external state silently routes differently on replay. Property tests use random pure guards by construction, so the regression doesn't surface.
2. **Non-serializable.** Closures don't survive JSON, don't survive process boundaries. Fully-portable workflow definitions are impossible.
3. **Not fingerprintable.** A semantic change to a guard (`o.kind === "yes"` → `o.kind === "y"`) does not change the DAG fingerprint, so cached results are silently reused unless the author manually bumps `FRAMEWORK_VERSION`.
4. **Not inspectable.** Observer events carry `[Function]`, not the matched predicate; operators can't see *why* a branch fired without source-diving.
5. **Path typos are runtime errors.** `(o: any) => o.kid === "yes"` evaluates to `false` silently — the author sees a wrongly-routed run and has to dig.

Conditional edges had not yet been adopted by any production code, so the rewrite is total (no compatibility shim).

## Decision

Replace the closure-typed guard with a **structural-match predicate** — a pure data value evaluated by the framework.

```ts
export type Predicate<O> = {
  readonly [K in keyof O]?: O[K] | { readonly oneOf: readonly O[K][] };
};

export type EdgeDef =
  | { from: string; to: string }
  | { from: string; to: string; when: Predicate<unknown> }
  | { from: string; to: string; kind: "default" };
```

The predicate's keys are top-level field names of the upstream output; the values are the expected matches. A `{ oneOf: [...] }` value matches any of the listed values. A multi-key predicate requires every key to match (logical AND across keys). Inside `defineDag<const Nodes>(...)`, `Predicate<O>` is parameterized by the actual `from`-node's output type via a distributive `EdgeDefInput` — path typos and value-type mismatches fail to compile.

**No boolean composition.** `and`/`or`/`not`/`<`/`>` stay out of the predicate vocabulary. Authors who need them add a **classifier node** upstream that pre-computes a routing key. The DAG topology grows by one node per non-trivial decision; in exchange, the classifier's logic is unit-testable in isolation and the routing artifact is a first-class observable.

**Empty predicate rejected.** `{}` is vacuously true; the validator rejects it because an "always-true" routing edge should be unconditional instead.

**Evaluator is pure and total.** `evaluatePredicate(pred, output)` iterates the predicate's keys, checks each against `output` (by `===` for literals, `includes` for `oneOf`), returns boolean. Cannot throw. The previous `guard-threw` error is gone; in its place, `predicate-malformed` exists as defense-in-depth against predicates introduced via `as`-casts that bypass the type system.

**Observer event payload.** `RouteDecidedEvent` carries `matchedPredicate: Predicate<unknown> | null` — the literal predicate object that fired, or `null` when the default fired or no conditional edges exist on the source.

**Fingerprint.** Each conditional edge contributes `${from}->${to}|when:${stableJson(pred)}` to the DAG fingerprint; default edges contribute `|default`. Editing a predicate now changes the fingerprint and invalidates cached results without a manual `FRAMEWORK_VERSION` bump.

## Consequences

**Wins**

- **Replay determinism is system-guaranteed.** Predicates are pure data; the evaluator is the only candidate for non-determinism, and it's a single small pure function under property test.
- **Serializable.** Predicates survive `JSON.stringify`, Redis Streams, process boundaries. Workflow definitions can be shipped through queues without closure tricks.
- **Hashable.** Semantic predicate edits invalidate cached results automatically.
- **Inspectable.** Operators read `matchedPredicate: { kind: "summarize" }` from observer events instead of `[Function]`.
- **Edit-time type-checking.** With `<const Nodes>` inference, predicates type-check against the upstream output's TS type; `o.kid` typos and value-type mismatches fail to compile.

**Costs**

- **Expressivity squeeze.** Authors needing `and`/`or`/`not`/comparisons must upstream-classify. The classifier-node pattern is documented in `library-ux.md` §8 with a worked example.
- **`Predicate<unknown>` for hand-rolled DAGs.** When the upstream output type isn't inferred (`defineDagFromArray`, `as`-casts), `keyof unknown = never` and the predicate degrades to `{}` at edit time. The module-load validator and the runtime `validatePredicateShape` defense-in-depth catch malformed predicates either way.
- **Total rewrite of conditional-edge tests.** Mechanical (one-shot search-and-replace from `when: () => ...` to `when: { ... }`); no production code used closures.

**Out of scope**

- **Nested paths** (`{ "user.role": "admin" }`). Authors restructure the output or upstream-classify. Revisit if real-world DAGs accumulate this pattern.
- **Negation primitive** (`{ not: ... }`). Classifier-node pattern covers it. Revisit if `oneOf: [everything-except-x]` patterns accumulate.
- **Empty-predicate rejection at the type level.** Possible but messy via intersection types; runtime validator is the safety net.
