# Plan: Structural-match predicates for conditional edges

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Replace function-typed guards on conditional edges with
*structural-match predicates* — data, not code — so replay determinism
becomes a system guarantee, predicates become serializable / hashable /
inspectable, and routing path/value typos fail at edit time against the
upstream output schema.

**Touches:**
- `packages/framework/src/types/dag.ts` — `Guard`/`EdgeDef`/`EdgeDefInput`
- `packages/framework/src/dag-runtime/conditional.ts` — `decideRoute`, predicate evaluator
- `packages/framework/src/dag-runtime/executor.ts` — observer event payload (predicate is now data)
- `packages/framework/src/dag-runtime/transition-helpers.ts` — replay path
- `packages/framework/src/executor/validate-dag.ts` — guard-throw error becomes obsolete
- `packages/framework/src/types/errors.ts` — drop `guard-threw`, add `predicate-malformed`
- `packages/framework/src/types/events.ts` — `RouteDecidedEvent.predicate` payload
- `docs/library-ux.md` §8 — rewrite the guard syntax
- `docs/dag-type-system.md` §6.3 — mark Option A as shipped
- `docs/adr/0015-conditional-edges.md` — note the predicate refactor
- New: `docs/adr/0016-structural-match-predicates.md`
- Tests: rewrite `conditional-edges-routing.test.ts`,
  `conditional-edges-replay.test.ts`, drop the throwing-guard test
  (impossible by construction)

---

## Problem

Today's `Guard` is `(output: unknown) => boolean`. This is a discipline
contract for purity, not a system guarantee. The known failure modes:

1. **Replay non-determinism.** A guard that closes over `Date.now()` or
   external state silently produces different routing decisions on
   replay. Property tests use random pure guards by construction, so
   the regression doesn't surface.
2. **Non-serializable.** Closures don't survive JSON, don't survive
   process boundaries. Durable workflows that need to ship the DAG
   through Redis Streams or BullMQ can't carry the guard. Today this
   isn't blocking because the DAG is reconstructed at the worker; if
   we ever want fully-portable workflow definitions, closures break.
3. **Not fingerprintable.** A semantic change to a guard
   (`o.kind === "yes"` → `o.kind === "y"`) does not change the DAG
   fingerprint, so cached results are silently reused. Detection
   relies on the author bumping `FRAMEWORK_VERSION`.
4. **Not inspectable.** Observer events carry `[Function]`, not the
   matched predicate. Operators reading routing decisions can't see
   *why* a branch fired.
5. **Path typos are runtime errors.** `(o: any) => o.kid === "yes"`
   evaluates to `false` silently. The author sees a wrongly-routed run
   and has to dig.

---

## Non-goals

- **Boolean composition / comparisons.** `and`/`or`/`not`/`<`/`>` stay
  out of the predicate vocabulary. Authors who need them add a
  classifier node upstream that pre-computes a routing key. This is
  the documented escape hatch.
- **Eliminating closures everywhere.** Node `transform` / `run`
  functions are unaffected — only edge guards are converted.
- **Backwards-compatibility shim.** No "function or predicate, both
  work" overload. Conditional edges aren't in production yet; the
  rewrite is total and we delete the old shape.
- **Fully-derived predicate types.** The predicate's `Predicate<O>`
  type is inferred from the upstream output's TS type. We don't
  attempt to derive it from `outputSchema._def` (the zod runtime
  schema) — TS type inference is enough.

---

## Design

### 1. Predicate type

`packages/framework/src/types/dag.ts`:

```ts
/**
 * A structural-match predicate over a node's output. The predicate's
 * keys are paths into the output; values are expected matches. A
 * `oneOf` value matches any of the listed values. The predicate is
 * pure by construction — there is no closure to capture state.
 *
 * `O` is the upstream node's output type. With `outputSchema` carrying
 * a zod-inferred TS type, predicates are checked against the actual
 * shape at edit time.
 */
export type Predicate<O> = {
  readonly [K in keyof O]?: O[K] | { readonly oneOf: readonly O[K][] };
};
```

Constraints:

- Only top-level field equality / oneOf is supported. Nested paths
  (`{ "user.role": "admin" }`) are out of scope. If the routing key is
  nested, the author either restructures the output or adds a
  classifier node.
- `oneOf` is the only "or" primitive. No `and`, no `not`, no
  comparisons. The classifier-node escape hatch covers everything else.
- Empty predicate `{}` matches every output (vacuously true). The
  validator should reject this — empty predicates are nearly always
  bugs, and an "always-true" routing edge should be unconditional.

### 2. Edge variant

```ts
export type EdgeDef =
  | { readonly from: string; readonly to: string }
  | { readonly from: string; readonly to: string; readonly when: Predicate<unknown> }
  | { readonly from: string; readonly to: string; readonly kind: "default" };

export type EdgeDefInput<Ids extends string, OutputsByNodeId = Record<string, unknown>> =
  | { readonly from: Ids; readonly to: Ids }
  | {
      readonly from: Ids;
      readonly to: Ids;
      readonly when: Ids extends keyof OutputsByNodeId
        ? Predicate<OutputsByNodeId[Ids]>
        : Predicate<unknown>;
    }
  | { readonly from: Ids; readonly to: Ids; readonly kind: "default" };
```

The `OutputsByNodeId` map is built from the inferred `Nodes` record:

```ts
type OutputOf<N> = N extends NodeDef<unknown, infer O, unknown> ? O : never;
type OutputsByNodeId<Nodes> = { [K in keyof Nodes]: OutputOf<Nodes[K]> };
```

In `DagDefInput<Nodes>` we plumb `OutputsByNodeId<Nodes>` into the
edge type so a guard's predicate is typed against the actual upstream
output schema.

**This requires `<const Nodes>` inference to preserve each node's
output type.** Since the helpers already return
`NodeDef<I, O, FrameworkError> & { id: Id }`, the `O` is preserved.
We only need to thread it through `DagDefInput`'s edges generic.

### 3. Predicate evaluator

`packages/framework/src/dag-runtime/conditional.ts`:

```ts
export const evaluatePredicate = <O>(pred: Predicate<O>, output: O): boolean => {
  for (const key of Object.keys(pred) as (keyof Predicate<O>)[]) {
    const expected = pred[key] as unknown;
    const actual = (output as Record<string, unknown>)[key as string];

    if (
      typeof expected === "object" &&
      expected !== null &&
      "oneOf" in expected &&
      Array.isArray((expected as { oneOf: unknown[] }).oneOf)
    ) {
      if (!(expected as { oneOf: readonly unknown[] }).oneOf.includes(actual)) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
};
```

Pure, total, side-effect-free. Replaces the `try { e.when(output) }`
block in `decideRoute`. The `guard-threw` failure mode is gone — a
predicate cannot throw because it cannot execute arbitrary code.

The remaining failure mode is `predicate-malformed`: a runtime check
that the predicate has the expected shape (object, no `__proto__`
keys, every value is either a literal or `{ oneOf: [...] }`). This is
defense-in-depth for `as Predicate<...>` casts; in practice the type
system catches malformed predicates at edit time.

### 4. Observer event payload

`route-decided` carries the matched predicate verbatim:

```ts
export interface RouteDecidedEvent {
  readonly type: "route-decided";
  readonly runId: string;
  readonly dagId: string;
  readonly fromNodeId: string;
  readonly chosenTargets: readonly string[];
  readonly prunedTargets: readonly string[];
  readonly defaultTaken: boolean;
  /** The predicate that matched, or `null` when default fired. Serializable JSON. */
  readonly matchedPredicate: Predicate<unknown> | null;
  readonly timestamp: Date;
}
```

This is the user-visible win for inspectability — operators see
`matchedPredicate: { kind: "summarize" }` rather than `[Function]`.

### 5. Errors

`packages/framework/src/types/errors.ts`:

- **Remove** `guard-threw`. Predicates can't throw.
- **Add** `predicate-malformed { fromNodeId, message }` — runtime
  defense-in-depth.

The validator's checks for else-totality, edge uniqueness, etc. are
unchanged.

### 6. Fingerprint

`packages/framework/src/checkpoint/fingerprint.ts` — currently hashes
edges by `from->to`. New: include `when` predicate when present, since
predicate semantics now change cache validity.

```ts
const edgeKey = (e: EdgeDef): string => {
  if (isConditionalEdge(e)) return `${e.from}->${e.to}|when:${stableJson(e.when)}`;
  if (isDefaultEdge(e)) return `${e.from}->${e.to}|default`;
  return `${e.from}->${e.to}`;
};
```

`stableJson` is a key-sorted JSON serializer — already exists in the
cache module.

### 7. Replay determinism

Property test (replaces the random-guard version): generate random
predicates, generate random output samples, run live + replay, assert
identical `(state, outputs, activeNodeIds, route-decided events)`.

Because predicates are pure data, the only way to introduce
non-determinism would be the evaluator itself — which is the test's
target. A passing property test proves system-level determinism, not
just guard-author discipline.

### 8. Migration

Rewrite the four conditional-edges tests:

- `conditional-edges-routing.test.ts` — replace every `when: (o) => ...`
  with `when: { ... }`. Delete the guard-throws test (no longer
  possible).
- `conditional-edges-replay.test.ts` — same; the property test is
  rewritten to generate random predicates.
- `conditional-edges-reroute.test.ts` — same.
- `conditional-edges-validator.test.ts` — drop tests that rely on
  closure guards; add tests for the empty-predicate rejection.

Apps: nothing — no app uses conditional edges yet.

---

## Test plan

- **Unit: evaluator.** `evaluatePredicate({ kind: "yes" }, { kind: "yes", extra: 1 })` → `true`. Same with `oneOf`. `kind` mismatch → `false`. Empty predicate → handled by validator.
- **Unit: validator.** Empty predicate rejected. Predicate referencing nonexistent path is *not* rejected at validate-dag (zod schema mismatch is a runtime concern); tested separately.
- **Routing tests.** Same shapes as today, predicate syntax instead of closures. 2-way, 3-way, default fires, branch-then-rejoin, output mismatch.
- **Replay property test.** 100 randomly-generated DAGs with random predicates and random outputs. Live and replay produce identical state.
- **Edit-time tests.** A `__type-checks.ts` file with `@ts-expect-error` directives confirming path typos and value-type mismatches fail to compile.

---

## ADR 0016

- **Context:** ADR 0015 introduced conditional edges with closure
  guards. Replay determinism was a discipline contract; closures broke
  serialization and fingerprinting; path/value typos went undetected
  at edit time.
- **Decision:** Replace `Guard = (output) => boolean` with
  `Predicate<O> = { [K in keyof O]?: O[K] | { oneOf: O[K][] } }`.
  Predicates are pure data, evaluated by the framework, typed against
  upstream output schemas. Boolean composition uses classifier nodes
  upstream.
- **Consequences:** Replay determinism becomes system-guaranteed.
  Predicates are serializable, hashable, observer-friendly, and
  edit-time type-checked. Authors who need complex routing logic
  upstream-classify; the DAG topology grows by one node per complex
  decision, but routing decisions become observable artifacts.

---

## Open questions

1. **Negation primitive `{ not: ... }`?** Skip for now. The
   classifier-node pattern covers it. If real-world DAGs accumulate
   `kind: { oneOf: [everything-except-x] }` patterns, revisit.
2. **Nested paths (`{ "user.role": "admin" }`)?** Skip. Authors
   restructure the output or classify upstream.
3. **Empty-predicate rejection at the type level?** Possible via
   `Predicate<O> & { [K: string]: unknown }` but messy; rely on
   runtime validator instead.

---

## Risks

1. **Migration breakage.** All conditional-edge tests rewritten. Risk
   is mechanical (typos in the rewrite); mitigated by run-all-tests
   after the change.
2. **Predicate expressivity squeeze.** Authors who want complex logic
   discover the missing primitives. Mitigation: classifier-node
   pattern documented in `library-ux.md` §8 with a worked example.
3. **`Predicate<unknown>` for hand-rolled DAGs.** When the upstream
   output type isn't inferred (e.g. via `defineDagFromArray` or `as`
   casts), the predicate type degrades to `Predicate<unknown>` =
   empty object. Edit-time path typing is lost; module-load validator
   stays the safety net. Acceptable.
