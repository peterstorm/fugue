# DAG type system — how the soundness guarantees actually work

A focused walkthrough of the TypeScript machinery behind `defineDag`,
`DagDef`, and the edit-time guarantees they provide. Read this if you're
working on the framework itself or curious about why the API is shaped
the way it is.

For the user-facing description, see `library-ux.md` §1.

---

## 0. What we're trying to enforce

| Guarantee | Where caught |
| --- | --- |
| `runDag` only accepts validated DAGs (no hand-rolled `DagDef` literals) | Edit time (the brand) |
| `edges[].from` / `edges[].to` reference known nodes | Edit time (literal id union) |
| `outputNodeId` references a known node | Edit time (literal id union) |
| `retryLimits` keys reference known nodes | Edit time (mapped over literal keys) |
| Record key matches `node.id` | Module load (validator) |
| Else-totality, output reachability, edge uniqueness | Module load (validator) |
| Cycles | First call (`topoSort`) |
| Predicate version in fingerprint | Module load (fingerprint changes when `version` bumps) |

Edit time means `tsc` produces a squiggle on the line. Module load means
the moment the file containing the DAG is imported (so: tests run it; CI
catches it; the app fails fast at boot).

---

## 1. The brand

### Definition

```ts
// packages/framework/src/types/dag.ts
declare const __dagValidated: unique symbol;

export interface DagDef {
  readonly id: string;
  readonly nodes: readonly NodeDef<unknown, unknown>[];
  readonly edges: readonly EdgeDef[];
  // ...
  readonly [__dagValidated]: true;
}
```

Three things going on:

- **`declare const __dagValidated: unique symbol`.** The `unique symbol`
  type denotes a single, unforgeable type-level identity. `declare const`
  means there is no runtime value — it exists purely as a name in the
  type namespace.
- **`readonly [__dagValidated]: true`.** Indexing `DagDef` with that
  symbol type yields `true`. Any object that wants to be assigned to
  `DagDef` must structurally have this property.
- **No re-exports of the symbol.** `__dagValidated` is module-private. No
  caller can write a literal with that key, because they don't have the
  symbol value to use as a computed property name. The type checker
  enforces presence; the absence of any runtime symbol means the
  property *can't even be created* outside the validator.

### Why this works

```ts
const naked: DagDef = {       // ❌ Property '[__dagValidated]' is missing
  id: "x",
  nodes: [],
  edges: [],
};
```

The brand is a phantom field at the type level. There is no runtime cost
(the validator doesn't actually attach the property — see §6). If
someone really wants to bypass it they can write `as unknown as DagDef`,
but at that point they've explicitly opted out, and `grep` finds it.

### Why `unique symbol` and not a string-literal field

```ts
// alternative — fragile
interface DagDef {
  readonly __validated: "yes";
}
```

This *also* fences out `{...}` literals, but a caller can satisfy it
with `{ ..., __validated: "yes" }`, no cast required. `unique symbol`
makes the key itself unreachable from outside the module.

---

## 2. The `defineDag` signature

```ts
export const defineDag = <const Nodes extends NodesRecord>(
  input: DagDefInput<Nodes>,
): DagDef => {
  const result = validateDagShape(input as unknown as DagDefInput);
  if (!result.ok) {
    throw new DagDefinitionError(input.id, result.error);
  }
  return result.value;
};
```

The interesting parts are `<const Nodes>` and `DagDefInput<Nodes>`.

### `<const Nodes>` — preserving literal types

Without `const`, generic inference *widens* an inferred record-literal
type to its base type:

```ts
function f<T>(x: T): T { return x; }
const r = f({ fetch: 1, summarize: 2 });
// inferred T: { fetch: number; summarize: number }
```

That's already pretty narrow, but for our purposes we need
`keyof T = "fetch" | "summarize"` rather than `string`. The default
inference algorithm sometimes picks the wider form for reasons that
matter when nesting generics. `<const T>` (TypeScript 5.0+) tells the
compiler:

> Treat this argument as if it were a `const`-asserted literal. Preserve
> tuple types, preserve readonly arrays, preserve narrow string literal
> keys, etc.

So:

```ts
defineDag<const Nodes>(...);   // call site infers Nodes = { fetch: NodeDef, summarize: NodeDef }
                                // keyof Nodes = "fetch" | "summarize"
```

That's the whole basis for edge-typo protection.

### `extends NodesRecord` — the constraint

```ts
export type NodesRecord = { readonly [id: string]: NodeDef<any, any, any> };
```

Two notes:

- We use a **string-index signature**, not `Record<string, NodeDef<...>>`.
  Empirically, `Record<string, X>` as a constraint causes TS to widen
  the inferred record literal to `Record<string, X>` — losing the
  literal keys we just paid for with `<const Nodes>`. The index-signature
  shape `{ [id: string]: X }` accepts the same set of values but doesn't
  force inference to widen. This is the kind of subtle TS quirk that's
  hard to explain except by trying both and seeing which keeps the
  literal keys.
- `NodeDef<any, any, any>` is a **deliberate variance leak**. Each node's
  generic parameters (input/output/error types) are typically
  heterogeneous within one DAG. The strict bound
  `NodeDef<unknown, unknown>` would reject nodes that have more
  specific I/O types — co/contravariance bites in both directions. `any`
  on the parameters is the simplest escape; we recover safety at the
  call boundary because every node is invoked through `runNode`, which
  runs `inputSchema.parse` / `outputSchema.parse` (the runtime gate).

### `DagDefInput<Nodes>` — typed edges and output

```ts
export type EdgeDefInput<Ids extends string> =
  | { readonly from: Ids; readonly to: Ids }
  | { readonly from: Ids; readonly to: Ids; readonly when: Guard }
  | { readonly from: Ids; readonly to: Ids; readonly kind: "default" };

export interface DagDefInput<Nodes extends NodesRecord = NodesRecord> {
  readonly id: string;
  readonly nodes: Nodes;
  readonly edges: readonly EdgeDefInput<keyof Nodes & string>[];
  readonly outputNodeId?: keyof Nodes & string;
  readonly retryLimits?: { readonly [K in keyof Nodes]?: number };
  // ...
}
```

Two key idioms:

- **`keyof Nodes & string`.** `keyof X` returns `string | number | symbol`
  in the worst case (object indices can be any of those). Intersecting
  with `string` narrows it back to a `string` subtype, which is what
  edge `from`/`to` need. With `<const Nodes>` and a string-keyed record
  literal, this evaluates to the union of literal keys.
- **`{ readonly [K in keyof Nodes]?: number }`** for `retryLimits`. Mapped
  type over the literal keys — values are optional, keys are constrained.
  Typing `retryLimits: { fech: 3 }` (typo) fails at edit time the same
  way edges do.

The default type parameter `Nodes extends NodesRecord = NodesRecord` lets
internal code refer to `DagDefInput` without specifying the generic when
it's been erased to the runtime shape.

---

## 3. The brand applier — `validateDagShape`

```ts
export const validateDagShape = (
  input: DagDefInput,
): Result<DagDef, FrameworkError> => {
  // ... structural checks ...
  const runtimeDag = {
    id: input.id,
    nodes: entries.map(([, n]) => n),
    edges,
    // ...
  } as unknown as DagDef;

  return ok(runtimeDag);
};
```

The double cast `as unknown as DagDef` is required because the constructed
object structurally lacks the brand property — but the type system needs
to see the brand. `as unknown` discards type information; the second `as`
re-asserts the wider type. This is the *only* place in the codebase where
a `DagDef` is minted, and it's behind a structural-validity gate.

The brand carries no runtime data — at runtime, `runtimeDag[__dagValidated]`
is `undefined`. The brand exists purely to fence out literal construction
elsewhere.

---

## 4. The array fallback — and why it's a separate function

`defineDag` accepts a record. For dynamically-built DAGs (test helpers,
config-driven node arrays) we expose a second function:

```ts
export const defineDagFromArray = (input: {
  readonly id: string;
  readonly nodes: readonly NodeDef<any, any, any>[];
  readonly edges: readonly EdgeDef[];          // string-typed
  readonly outputNodeId?: string;              // string-typed
  // ...
}): DagDef => {
  const nodesRecord = Object.fromEntries(input.nodes.map((n) => [n.id, n]));
  const result = validateDagShape({ ...input, nodes: nodesRecord });
  if (!result.ok) throw new DagDefinitionError(input.id, result.error);
  return result.value;
};
```

The validation guarantees are identical. The only thing you give up is
edit-time edge typing — `from`/`to` are `string`, not the literal id
union, because the array form doesn't carry the keys at the type level.

### Why not a single function with overloads?

An earlier version had:

```ts
export function defineDag<const Nodes extends NodesRecord>(input: DagDefInput<Nodes>): DagDef;
export function defineDag(input: DagDefArrayInput): DagDef;
export function defineDag(input: any): DagDef { ... }
```

Both overloads pointed to the same implementation. In theory a record
input matches the first; an array input matches the second. In practice
TS's overload resolution algorithm broke the record-overload's literal
inference: when both overloads were present, calls like
`defineDag({ nodes: { fetch, summarize }, edges: [...] })` failed both
overloads and reported only the array-overload error ("'fetch' does not
exist in type `readonly NodeDef[]`"). The literal-inference path on
overload 1 silently degraded.

This is a known class of TS quirk: when overloads exist, the inference
done for one overload can cross-contaminate the constraint resolution
for another, even though semantically they're independent. It's not a
bug, just an emergent property of how the algorithm works in the
presence of structural typing.

We chose the cleaner option: two functions, two names. Each one keeps
its inference algorithm clean. The cost (one extra function name) is
trivial; the win (no inference flakiness) is permanent.

---

## 5. The discriminated union for edges

```ts
export type EdgeDef =
  | { readonly from: NodeId; readonly to: NodeId; readonly kind: "unconditional" }
  | { readonly from: NodeId; readonly to: NodeId; readonly kind: "conditional"; readonly when: Predicate<unknown> }
  | { readonly from: NodeId; readonly to: NodeId; readonly kind: "default" };
```

Three variants discriminated by an explicit `kind` tag on *every*
variant. This is the runtime shape — what code sees after `defineDag`
strips literal id types. Why an explicit tag:

- Single-field narrowing (`e.kind === "conditional"`) replaces the
  brittle `"when" in e && !("kind" in e)` field-presence checks of
  earlier revisions. A new variant can't silently fall through a
  presence test that happened to match.
- Authors are not burdened by the tag: the **input** shape
  (`EdgeDefRawInput` / `EdgeDefInput`) still accepts the implicit
  unconditional form `{ from, to }` and the implicit conditional form
  `{ from, to, when }`. `defineDag` materializes the explicit
  `kind: "unconditional"` / `kind: "conditional"` after validation, so
  existing edge literals keep working unchanged.
- Narrowing happens through three centralized helpers:

```ts
export const isUnconditionalEdge = (e: EdgeDef): e is Extract<EdgeDef, { kind: "unconditional" }> =>
  e.kind === "unconditional";
export const isConditionalEdge = (e: EdgeDef): e is Extract<EdgeDef, { kind: "conditional" }> =>
  e.kind === "conditional";
export const isDefaultEdge = (e: EdgeDef): e is Extract<EdgeDef, { kind: "default" }> =>
  e.kind === "default";
```

A unit test forbids ad-hoc `"when" in e` checks elsewhere — narrowing
goes through the helpers, so adding a fourth variant later updates one
place.

The `EdgeDefInput<Ids>` form (used inside `defineDag`) parameterizes
`from`/`to` over the literal id union and distributes the conditional
branch so each edge's `when` is typed against the actual `from` node's
output. `DAG_INPUT` (the virtual `$input` source) is admissible as
`from` on the unconditional form only.

---

## 6. What we don't catch at the type level — and could we?

The honest framing: each gap is a *cost/benefit choice we made*, not a
TS limitation. Below, each one with a concrete proposal and what it
would cost.

### 6.1 Per-node `deps` cross-typing — deep dive

**Status (2026-05-10): obsoleted by ADR 0017.** `deps` no longer exists
on `NodeDef` — edges are the single source of truth, and the runtime
derives each node's input wiring from incoming edges at compile time.
Zero `deps` typos possible because there's no `deps` field to typo. The
options below are kept for historical context; they discuss the design
space that fed into the final decision (remove the field rather than
typo-proof it). See ADR 0017 and `library-ux.md` §1, §8.3 for the
shipped surface.

The structural problem is that `NodeDef` literals are *constructed
independently of the DAG they end up in*:

```ts
const fetch = createFetchNode({ id: "fetch", ... });          // file A
const extract = createTransformNode({
  id: "extract",
  deps: ["fetch"],       // ← we need this 'fetch' to be type-checked
  // ...
});                                                           // file B
const dag = defineDag({ nodes: { fetch, extract }, edges: [...] });  // file C
```

When the author writes `deps: ["fetch"]` in file B, the compiler has no
way to know what other nodes will share the same DAG. The id union
*does not exist* at the point where the literal is being type-checked.

There are three families of solutions, each trading something different.

#### Option A — Builder pattern with progressive narrowing

```ts
// Sketch — not implemented.
defineDag("summary")
  .addNode("fetch", fetchConfig)
  .addNode("extract", { deps: ["fetch"], ... })          // 'fetch' is keyof prior
  .addNode("synthesize", { deps: ["extract", "fetch"] }) // both checked
  .edges(({ ids }) => [
    { from: ids.fetch, to: ids.extract },
    { from: ids.extract, to: ids.synthesize },
  ])
  .build();
```

The implementation skeleton:

```ts
interface DagBuilder<Nodes extends NodesRecord> {
  addNode<const K extends string, I, O>(
    id: K,
    config: NodeConfig<I, O> & { deps?: readonly (keyof Nodes & string)[] },
  ): DagBuilder<Nodes & Record<K, NodeDef<I, O, FrameworkError>>>;
  edges(
    spec: (ctx: { ids: { [K in keyof Nodes]: K } }) => readonly EdgeDefInput<keyof Nodes & string>[],
  ): DagBuilder<Nodes>;
  build(): DagDef;
}
```

Each `.addNode` returns a builder typed with the accumulated id union;
subsequent `deps` are constrained against `keyof Nodes`. Edge
construction takes a callback receiving an `ids` record so authors can
write `ids.fetch` (typed) instead of `"fetch"` (string).

**The hard cost.** Authors must declare nodes *in topological order*:
deps before dependents. Current code lets you construct `fetch` and
`synthesize` in any file, in any order, then assemble them in any
sequence — they're independent values. With the builder, `synthesize`
cannot be added before `extract`, which cannot be added before `fetch`.

In practice this means:

- Reordering nodes when refactoring becomes a load-bearing operation.
  Move `synthesize.addNode(...)` before its deps and the type-check
  fails.
- Diamonds are fine (`A → B`, `A → C`, `B → D`, `C → D`): you can pick
  any topological order.
- Conditional fan-out is fine: the router goes first, then the
  branches.
- Cycles are *trivially* type-prevented: you can never reference an id
  that hasn't been added, so a cycle would require referencing a node
  that doesn't exist yet. That's a real bonus — type-level cycle
  prevention falls out for free.

**The other costs.** The builder fluent API:

- Loses the ergonomic `defineDag({ ... })` shape that takes a single
  literal — you have to thread state through method calls.
- Doesn't compose with `defineDagFromArray` (the dynamic case) — the
  builder has no array form.
- Makes evalJudges/retryLimits/etc. either trailing methods
  (`.evalJudges([...])`) or part of `.build({ ... })`.

#### Option B — Two-phase: declare ids upfront, then nodes

```ts
const dag = defineDag({
  ids: ["fetch", "extract", "synthesize"] as const,    // declare ids first
  nodes: {
    fetch: createFetchNode({ /* deps inferred from ids? no. */ }),
    extract: createTransformNode({ deps: ["fetch"] }),
  },
});
```

This *looks* clean but doesn't actually solve the typing problem. The
`deps: ["fetch"]` inside `createTransformNode` runs in the context of
`createTransformNode`'s call site — it knows nothing about the
surrounding `defineDag` call, so it can't constrain `deps` to the `ids`
tuple.

You could fix this by making node helpers themselves aware of an id
union, e.g. `createTransformNode<I, O, const Id, AllIds>(...)`. But
then every helper invocation must explicitly thread the `AllIds` union
in — back to the same ergonomic problem as Option A, plus repetition.

#### Option C — Closure-scoped DSL

```ts
const dag = defineDag(($) => {
  const fetch = $.transform("fetch", { /* ... */ });
  const extract = $.transform("extract", { deps: [fetch] });   // <- pass node ref, not string
  const synthesize = $.transform("synthesize", { deps: [fetch, extract] });
  return {
    edges: [
      $.edge(fetch, extract),
      $.edge(extract, synthesize),
    ],
    output: synthesize,
  };
});
```

Instead of typing `deps: ["fetch"]` as a string, you pass *the node
reference itself* — typed, IDE-completable, refactoring-safe (rename
the const, all references update). The helper internally extracts
`node.id`.

This is actually quite elegant:

- No declaration-order constraint relative to literals (you can write
  the consts in any order; just have to reference them after
  declaration, which TS enforces anyway).
- No string-keying anywhere user-facing.
- Cycles still type-prevented (can't reference a const before it's
  declared).
- Refactoring tools (rename, find references) work natively.

The cost:

- The internal id strings still need to be stable for fingerprinting,
  observability, and replay — so `$.transform(id, ...)` keeps an
  explicit id parameter, and callers must keep id and var name in sync
  manually (or the helper widens the const to whatever name was used).
- Edges become typed pairs of references (`$.edge(from, to)`) rather
  than literals — slightly more code to write, much less prone to
  typos.
- Backwards compatibility: the `defineDag({ ... })` shape would either
  go away or become a second entry point. Two ways to declare a DAG
  is a smell.

#### Recommendation

**Defer.** The validator catches deps typos at module load — same
lifecycle event as a tsc squiggle would surface (the file is imported,
the error is thrown, the test runner reports it). The strictly earlier
feedback is "while typing in the editor" vs "the moment you save and
the test re-runs," which is hundreds of milliseconds.

The cost of Option A (forced topo-order declaration) is permanent and
real. Option C (closure DSL) is more compelling but is a substantial
rewrite of the construction API. Option B doesn't actually work.

If we did pick one, **Option C** is the best long-term shape — it
sidesteps the topo-order issue and gives refactoring-safe references —
but it's a significant API redesign that should be motivated by actual
pain, not theoretical pain. Concretely: ship the framework as-is; if
operators report frequent deps-typo discoveries late in development,
revisit with Option C.

### 6.2 Record-key vs `node.id` consistency — **DONE**

Each node-creator helper now carries a `<const Id extends string>`
generic and returns `NodeDef<...> & { id: Id }`, so the literal id
flows through:

```ts
export const createTransformNode = <I, O, const Id extends string = string>(
  config: TransformNodeConfig<I, O, Id>,
): NodeDef<I, O, FrameworkError> & { readonly id: Id } => { ... };
```

`DagDefInput` then enforces consistency via a mapped type:

```ts
export type ConsistentNodes<Nodes extends NodesRecord> = {
  readonly [K in keyof Nodes]: string extends Nodes[K]["id"]
    ? Nodes[K]                                    // wide string id — defer to validator
    : Nodes[K] extends { readonly id: K }
      ? Nodes[K]                                  // literal matches key
      : { readonly __error: `nodes['${K & string}'].id must equal '${K & string}'` };
};

export interface DagDefInput<Nodes extends NodesRecord = NodesRecord> {
  readonly nodes: Nodes & ConsistentNodes<Nodes>;
  // ...
}
```

The `string extends Nodes[K]["id"]` branch is load-bearing — it lets
hand-rolled nodes (or any custom helper that doesn't preserve literal
id) compile. We don't *force* literal ids, we just enforce the
consistency constraint when they exist. Mismatches turn into a
sentinel object type that no real `NodeDef` satisfies, so the compiler
points at the offending entry with the descriptive `__error` string in
its diagnostic.

**Why the `string extends X` branch is needed:** if `Nodes[K]["id"]` is
the wide `string` type (no literal preservation), we cannot compare it
to `K` at the type level — the check would always fail. Distinguishing
"no literal info to check" from "literal info that disagrees" is the
job of `string extends X`, which evaluates to `true` only when `X` is
the wide `string`.

### 6.3 Guard purity — deep dive

**Status (2026-05-10): shipped via ADR 0016.** A simplified Option A
landed: `Predicate<O> = { [K in keyof O]?: O[K] | { oneOf: O[K][] } }`,
typed against the upstream output via `<const Nodes>` inference,
serializable, hashable, and surfaced in observer events. The notes below
are kept for historical context — they discuss the design space that fed
into the final decision. See `library-ux.md` §8 for the shipped surface
and ADR 0016 for the decision record.

The original definition:

```ts
type Guard = (output: unknown) => boolean;
```

Functions are opaque to the type system — there is no
`Pure<(x) => boolean>` you can write that excludes closures over
mutable state, calls to `Date.now()`, or random number generation. So
the question is: what *system-level* mechanism could replace
"discipline + property tests" with "guarantee."

#### Option A — Replace functions with a predicate DSL

The most powerful option. Predicates become **data**, not code:

```ts
export type Predicate =
  | { kind: "literal"; value: boolean }                   // for unconditional truthy/falsy
  | { kind: "field-eq"; path: string; value: unknown }
  | { kind: "field-in"; path: string; values: readonly unknown[] }
  | { kind: "field-cmp"; path: string; op: "<" | ">" | "<=" | ">="; value: number }
  | { kind: "matches"; path: string; regex: string }
  | { kind: "exists"; path: string }
  | { kind: "and"; preds: readonly Predicate[] }
  | { kind: "or"; preds: readonly Predicate[] }
  | { kind: "not"; pred: Predicate };

type EdgeDef =
  | { from: string; to: string }
  | { from: string; to: string; when: Predicate }     // data, not function
  | { from: string; to: string; kind: "default" };

// Evaluator (internal):
const evaluate = (pred: Predicate, output: unknown): boolean => {
  switch (pred.kind) {
    case "literal": return pred.value;
    case "field-eq": return getPath(output, pred.path) === pred.value;
    case "field-in": return pred.values.includes(getPath(output, pred.path));
    case "field-cmp": {
      const v = getPath(output, pred.path);
      if (typeof v !== "number") return false;
      switch (pred.op) {
        case "<": return v < pred.value;
        case ">": return v > pred.value;
        case "<=": return v <= pred.value;
        case ">=": return v >= pred.value;
      }
    }
    case "matches": return new RegExp(pred.regex).test(String(getPath(output, pred.path)));
    case "exists": return getPath(output, pred.path) !== undefined;
    case "and": return pred.preds.every((p) => evaluate(p, output));
    case "or": return pred.preds.some((p) => evaluate(p, output));
    case "not": return !evaluate(pred.pred, output);
  }
};
```

What this **buys**:

- **Pure by construction.** No closure, no `Date.now()`, no I/O —
  predicates can only inspect the output. Replay determinism is a
  *system guarantee*, not a discipline contract.
- **Serializable.** Predicates survive checkpointing/serialization
  intact. The current closure-based form can't be serialized at all
  (functions don't round-trip through JSON).
- **Hashable / fingerprintable.** A DAG fingerprint can include the
  exact predicate, not just an opaque `[Function]`. This means a
  semantic change to a guard invalidates cached results, where today
  it doesn't.
- **Inspectable.** Observer events can carry the matched predicate. A
  human looking at `route-decided` events sees *why* a branch fired,
  not just `chosenTargets: ["yes-branch"]`.
- **Statically typed against the upstream output schema.** With a bit
  more work, `field-eq.path` could be typed as
  `Path<UpstreamOutputType>` (a string literal union of valid paths)
  and `value` as the field's actual type. Schema-driven guards.

What this **costs**:

- **Expressivity loss.** Composite logic gets verbose:

  ```ts
  // Function form:
  when: (o: any) => o.confidence < 0.7 && (o.category === "a" || o.category === "b")

  // Predicate form:
  when: {
    kind: "and",
    preds: [
      { kind: "field-cmp", path: "confidence", op: "<", value: 0.7 },
      { kind: "field-in", path: "category", values: ["a", "b"] },
    ],
  }
  ```

  ~3x as many tokens. Readable, but heavier. A helper API
  (`P.and(P.lt("confidence", 0.7), P.in("category", ["a", "b"]))`) can
  recover most of the ergonomics.

- **Coverage gap.** Some real-world routing logic doesn't fit a fixed
  vocabulary: "if any element of `output.items` has `score > 0.8`."
  You'd need to extend the DSL with `field-some` / `field-every`
  primitives. Eventually you're building a query language. There's a
  long tail of "weird routing logic that doesn't fit" — at some point
  authors will want to escape the DSL.
- **Path safety.** `path: "confidence"` is a string. Without
  `Path<T>`-style typing, typos in the path silently make the
  predicate evaluate `undefined`. Recoverable, but loses one of the
  edit-time wins. Adding `Path<T>` requires plumbing the upstream
  schema's TS type into the edge variant — workable but heavy.

#### Option B — Sandboxed evaluation

Run the function in a Web Worker / VM context with a frozen `globalThis`
that exposes nothing impure. No `Date.now`, no `Math.random`, no I/O.
Authors keep writing functions; the framework runs them in a guaranteed
pure environment.

What this buys:
- Authors don't change anything; existing closures keep working.

What this costs:
- Sandboxes are Node-version-specific and notoriously leaky.
- Performance overhead of a sandbox per guard evaluation, per wave.
- Replay still has to call the sandbox to re-evaluate. If guard purity
  fails, replay diverges silently — same outcome as today, just more
  expensive.

Not a real fix. Skip.

#### Option C — AST inspection at construction time

When `defineDag` sees a function guard, parse it (e.g. via `acorn`),
walk the AST, reject if it references anything outside its parameter:
no globals, no closure variables, no `await`, no `Date.now`.

```ts
const isPureGuard = (fn: Function): boolean => {
  const ast = acorn.parse(fn.toString(), { ecmaVersion: 2022 });
  // walk ast, check Identifier nodes against an allowlist
  // ...
};
```

What this buys:
- Authors keep writing closures.
- Module-load failure on impure guards. No discipline required.

What this costs:
- Adds an AST library dependency.
- Function source isn't always available (minifiers, transpilers,
  inlined functions, anonymous arrow functions defined inline). The
  detection is unreliable.
- False negatives are easy: `(o) => o[evilKey]` where `evilKey` is a
  closed-over computed property name. AST inspection passes but the
  guard is impure.
- "Pure" in JS isn't a clean category — `o.toString()` could be
  monkey-patched, `Array.prototype.includes` could be redefined.
  Strict purity is impossible without a sandbox.

A weaker version of this — **lint rule** — is feasible: an ESLint plugin
that inspects guard literals at edit time and warns on closure
references. Catches the common cases without runtime cost. Doesn't
catch the adversarial ones, but adversarial isn't the threat model
(the threat is "developer writes `Date.now()` because they didn't
think about replay").

#### Option D — Replay sampling

Don't *prevent* impure guards — *detect* them in production by sampled
re-execution. Periodically re-run a captured wave-done event through
the same DAG and compare the active set. Divergence proves a guard is
impure (or some other determinism violation).

What this buys:
- No author API change at all.
- Catches impurity that AST inspection misses (e.g. monkey-patched
  prototypes affecting the guard).

What this costs:
- Detective, not preventive — operators see the alert after the
  divergence happened.
- Sampling overhead.
- Distinguishing guard impurity from other determinism violations
  (e.g. a node with non-deterministic output that the guard depends
  on) needs careful instrumentation.

Useful as a defense-in-depth layer alongside any of A–C.

#### Recommendation

**Open question for v4.x. Not blocking.** Closures + property tests +
explicit documentation is what we ship now. The right next step
depends on what we observe:

- If routing logic in the wild fits a small vocabulary (mostly
  field-eq + field-in + boolean combinations), **Option A** (predicate
  DSL) is the strongest move. Pure by construction; serializable;
  fingerprintable. Worth the expressivity cost.
- If routing logic is varied and complex enough that the DSL would
  become a query language, **Option C lint rule + Option D sampling**
  is more pragmatic. Catches the common mistake without forcing a
  rewrite of every guard.
- If the framework starts targeting environments where serialization
  matters (durable workflows, cross-process replay, persistence to
  Redis Streams of guard logic), **Option A becomes mandatory** —
  closures simply can't survive those boundaries.

The decision is downstream of usage data. Today, ship with closures
and property tests; instrument routing decisions in the observer
events; revisit when there's signal.

### 6.4 Cycle detection, else-totality, output reachability

**Status:** all caught at module load by the validator.
**Could we catch them earlier?** *In principle*, yes. In practice, no.

Cycle detection in TS types looks like this:

```ts
type Reachable<Edges, From, Visited = never> =
  // recurse over Edges, marking visited nodes, abort if From appears in Visited
  ...;
type HasCycle<Nodes, Edges> = {
  [K in keyof Nodes]: K extends Reachable<Edges, K, K> ? "cycle" : "ok";
};
```

This works for tiny graphs. At ~10 nodes the recursion depth + union
explosion blows past TS's instantiation budget (default 5M, hard cap at
50M) and the compiler errors with "type instantiation excessively
deep." Realistic DAGs in the agent space have 20-100 nodes. We'd be
shipping a feature that only works for trivial cases — and worse,
*silently* stops working as the DAG grows.

Else-totality and output-reachability have the same property. Both are
graph traversal problems. Both blow the budget at realistic scale.

**Cost:** even attempting these adds compile-time cost to small DAGs
that pays for itself only marginally — the validator runs in <1ms and
runs at the same lifecycle stage (module load). No production user
sees the difference between "tsc squiggle on import line" and "throw
on import line."

**Worth it?** No. The validator is the right tool. Type-level versions
would be a research project, not a feature.

### 6.5 Optional-deps partitioning

**Status (2026-05-10): obsoleted by ADR 0017.** `optionalDeps` no longer
exists on `NodeDef` — the runtime derives `{ required, optional }` from
edges (unconditional-from-always-active source → required; everything
else → optional). Authors cannot misclassify because they don't
classify. The historical analysis below is preserved for context.

**Original status:** caught at module load (a `deps` whose only incoming
edge was conditional had to move to `optionalDeps`).
**Could we catch it earlier?** Yes — but only if 6.1 (deps cross-typing)
and 6.2 (key/id consistency) are done first. With both in place:

```ts
type IncomingFor<Edges, Id> = ...; // extract { source, variant } per edge into Id
type AllowedDeps<Edges, Id> = ...; // sources whose edges include unconditional+default
type RequireOptionalDeps<Edges, Id> = ...; // sources whose only edges are conditional

type ValidNodeShape<N extends NodeDef, Edges, Id> =
  N extends { deps: infer D; optionalDeps?: infer O }
    ? D extends readonly AllowedDeps<Edges, Id>[]
      ? O extends readonly (...)[]
        ? N
        : { __error: "optionalDeps mismatch" }
      : { __error: "deps must use optionalDeps for this conditional source" }
    : N;
```

**Cost:** this stacks on top of 6.1 + 6.2. Heavy mapped-type recursion
over edges + nodes. Probably hits the instantiation budget for medium
DAGs.

**Worth it?** No, even if 6.1 and 6.2 land. Validator is sufficient.

---

### Summary — the real frontier

| Gap | Tractable? | Status |
| --- | --- | --- |
| Edge endpoints (`from`/`to`) | ✓ | **Done.** |
| `outputNodeId` | ✓ | **Done.** |
| `retryLimits` keys | ✓ | **Done.** |
| Record-key vs `node.id` | Yes — `<const Id>` on helpers + `ConsistentNodes` mapped type | **Done.** |
| Per-node `deps` cross-typing | Yes — closure DSL (Option C in §6.1) is the best long-term shape | Deferred. Validator catches at module load; no production user pain. |
| Guard purity | Yes — predicate DSL (Option A in §6.3), or lint rule + replay sampling | Deferred. Discipline + property tests for now; revisit when serialization or cross-process replay forces it. |
| Cycles, else-totality, output reachability | TS-feasible for ≤10 nodes | Not pursued. Validator is the right tool. |
| Optional-deps partitioning | Stacks on the deps work | Not pursued. Marginal value. |

The shipped frontier is "everything an author can typo at edit time
gets caught at edit time." The remaining items are more nuanced: the
deps and guard cases each have multiple viable approaches with real
tradeoffs, and the right call depends on operational data we don't
have yet.

---

## 7. Putting it together — the lifecycle of a DAG

```ts
// 1. Author writes the DAG.
export const summaryDag = defineDag({
  id: "summarize",
  nodes: { fetch, extract, synthesize },
  edges: [
    { from: "fetch", to: "extract" },
    { from: "extract", to: "synthesize" },
  ],
  outputNodeId: "synthesize",
});
```

What happens:

| Step | Where | What |
| --- | --- | --- |
| Inference | `tsc` | `<const Nodes>` infers `Nodes = { fetch, extract, synthesize }`. `keyof Nodes & string = "fetch" \| "extract" \| "synthesize"`. Edges and `outputNodeId` get squiggles on typos. |
| Module load | Node import | `defineDag` executes. `validateDagShape` checks key/id consistency, edge endpoints, `$input`-edge well-formedness, edge uniqueness, conditional-predicate well-formedness, source/root invariant, else-totality, freshness-extractor consistency, and output reachability. On failure: throws `DagDefinitionError`. On success: returns the input cast (via `as unknown as DagDef`) to the branded type. |
| First `runDag` call | Runtime | `compileDagToMachine` calls `topoSort` for cycle detection and wave assignment. |
| Per-wave execution | Runtime | `runWave` filters by `activeNodeIds`, executes nodes, fires guards (which may throw `guard-threw`). |

The brand carries the proof that `validateDagShape` succeeded: anywhere
a `DagDef` is in scope, structural soundness has already been verified.
`compileDagToMachine` and `runDagInner` no longer re-run `validateDagShape`
internally — the type tells them they don't need to.

---

## 8. Edits checklist for future contributors

If you change any of these, you must update something in this doc:

- `DagDef`'s shape — re-derive what `validateDagShape` brands.
- `DagDefInput`'s generics — re-check that literal inference still flows
  through `<const Nodes>` (write a `__brand-check.ts` and confirm `tsc`
  fires on typos).
- `EdgeDef` variants — update the narrowing helpers and the unit test
  that forbids ad-hoc `"when" in e`.
- `validateDagShape`'s return type — the `Result<DagDef, ...>` brand-
  applier contract is load-bearing.

`__dagValidated` itself is one line and unlikely to need changes. If
you do change it: rename the symbol (so old `as DagDef` casts in the
wild break loudly), and audit all `as DagDef` / `as unknown as DagDef`
sites.
