# Plan: Derive `deps` and `optionalDeps` from edges

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Drop `deps` and `optionalDeps` from `NodeDef`. Edges become
the single source of truth for topology — the framework derives each
node's input wiring at compile time. `deps` typos become impossible
because there's no field to typo. Nodes become genuinely reusable
(their contract is "I produce O from I", not "I get input from these
specific upstream ids").

**Touches:**
- `packages/framework/src/types/node.ts` — drop `deps` and `optionalDeps`
- `packages/framework/src/nodes/transform.ts`,
  `fetch.ts`, `llm.ts`, `guardrail.ts`, `llm-with-tools.ts`,
  `eval-judge.ts` — drop `deps` from configs
- `packages/framework/src/executor/validate-dag.ts` — replace
  deps↔edges symmetry check with edge-only checks
- `packages/framework/src/dag-runtime/executor.ts` — `runNode` builds
  input from incoming edges, not from `node.deps`
- `packages/framework/src/executor/executor.ts` — same in legacy `runNode`
- `packages/framework/src/dag-runtime/conditional.ts` — `optionalDeps`
  derivation from edge variants
- `packages/framework/src/checkpoint/fingerprint.ts` — drop `deps`
  from the hashed payload (it's redundant with edges)
- Tests: every test that constructs a node via a helper passes
  `deps: [...]` — drop those args. Test helpers that build raw
  `NodeDef` literals drop the field.
- Apps: `apps/customer-summary/src/dag/nodes/*.ts` — drop `deps` from
  every helper invocation
- Docs: `docs/library-ux.md` §1, §8.3; `docs/dag-type-system.md` §6.1
- New: `docs/adr/0017-derive-deps-from-edges.md`

---

## Problem

Today's `NodeDef` carries `deps: readonly string[]` and the optional
`optionalDeps: readonly string[]`. The DAG carries `edges: EdgeDef[]`.
These two views of the same topology must agree — if they drift, the
validator catches it at module load.

This is duplication of information. Specifically:

- **`deps` typos.** `deps: ["fech"]` (typo) is a `string[]` — the
  type system can't tell. The validator catches it, but only at
  module load. An edit-time check would require per-node
  cross-typing, which (per `dag-type-system.md` §6.1) costs either a
  builder DSL (forced topo order) or a closure-scoped DSL (full API
  redesign).
- **`optionalDeps` mismatches.** Authors must remember the rule
  "conditional incoming → optionalDep, default/unconditional →
  dep" and partition deps accordingly. The validator catches mistakes,
  but the rule is mechanical and authors keep forgetting it.
- **Node reusability.** A `NodeDef` with `deps: ["fetch"]` is anchored
  to a specific upstream id. Reusing it in a DAG where the upstream
  is named differently requires either renaming or wrapping. In
  practice nobody reuses nodes across DAGs because of this anchor.

The deeper issue: edges already express the topology. Edges are the
*only* place the topology is authored — the `deps` field is a
read-only mirror that the framework needs at runtime to build node
input. We can compute that mirror from the edges instead of asking
the author to maintain it.

---

## Non-goals

- **Deriving `inputSchema`.** The author still writes
  `inputSchema: z.object({...})` describing what they expect. The
  framework validates the assembled input against it — same as today.
  Auto-derivation from upstream output schemas is a separate question
  (loses flexibility; out of scope here).
- **Removing `id` or `kind`.** Nodes still have an explicit id (used
  by edges, fingerprint, observability) and kind. Only the
  topology-mirroring fields go.
- **Backwards-compat shim.** No "deps optional, edges canonical, both
  work" path. The refactor is total.

---

## Design

### 1. `NodeDef` shape

`packages/framework/src/types/node.ts`:

```ts
export interface NodeDef<I, O, E> {
  readonly id: string;
  readonly kind: NodeKind;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  // deps + optionalDeps removed.
  readonly run: (input: I, ctx: NodeContext) => Promise<Result<O, E>>;
  readonly humanReview?: NodeHumanReviewConfig;
  readonly retry?: NodeRetryConfig;
}
```

Each helper config drops the same fields.

### 2. Per-node input shape — derived rules

`packages/framework/src/dag-runtime/conditional.ts` exports two
helpers (or extends `expandActive` siblings):

```ts
/** All sources of incoming edges to this node, partitioned by variant. */
export const incomingSources = (
  dag: DagDef,
  toNodeId: string,
): {
  readonly required: readonly string[];   // unconditional + default
  readonly optional: readonly string[];   // conditional (when)
} => { ... };
```

The runtime `runNode` builds `nodeInput`:

```ts
const { required, optional } = incomingSources(dag, node.id);

const nodeInput =
  optional.length > 0
    ? Object.fromEntries(
        [...required, ...optional].map((d) => [d, outputs.get(d)]),
      )
    : required.length === 0
      ? dagInput
      : required.length === 1
        ? outputs.get(required[0]!)
        : Object.fromEntries(required.map((d) => [d, outputs.get(d)]));
```

The 0/1/many heuristic is preserved exactly. The only difference is
the source: `required` and `optional` come from edge inspection
instead of `node.deps` and `node.optionalDeps`.

For performance: the framework precomputes
`incomingSources` per node once per `compileDagToMachine` call and
stashes it on `DagMachineContext` (alongside `waves`).

### 3. Validator changes

`packages/framework/src/executor/validate-dag.ts`:

The deps↔edges symmetry checks **disappear** (no `deps` to compare
against). Remaining checks:

- Empty DAG.
- Duplicate node ids (record key collisions).
- Edge endpoints reference known nodes.
- Edge uniqueness per `(from, to)` pair.
- Else-totality (every conditional source has exactly one default).
- Output reachability under unconditional + default edges.
- Record-key vs `node.id` consistency.

The "deps wired only by conditional incoming edge — use optionalDeps"
error class is gone (nothing for the author to misclassify).

### 4. Fingerprint

`packages/framework/src/checkpoint/fingerprint.ts` currently includes
`deps` in the hashed payload. Drop it — the edges payload now
contains the same information.

### 5. Migration of every node creator

For each helper:

```ts
// before
export interface TransformNodeConfig<I, O, Id extends string = string> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly deps: readonly string[];   // <- gone
  readonly transform: (input: I) => Result<O, FrameworkError>;
}

// after
export interface TransformNodeConfig<I, O, Id extends string = string> {
  readonly id: Id;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly transform: (input: I) => Result<O, FrameworkError>;
}
```

Plus `createFetchNode`, `createLlmNode`, `createGuardrailNode`,
`createLlmWithToolsNode`. `createEvalJudgeNode` is unaffected (eval
judges aren't in the `nodes` record).

### 6. App migration

`apps/customer-summary/src/dag/nodes/*.ts` — every helper call drops
its `deps` argument. The DAG already declares the edges; nothing else
needs to change.

```ts
// before
createTransformNode({
  id: "extract-features",
  deps: ["fetch-crm"],            // <- gone
  inputSchema: ...,
  outputSchema: ...,
  transform: ...,
});
```

### 7. Test migration

Roughly the same shape — every test helper that builds a node either
drops `deps:` from its argument, or, if it builds a raw `NodeDef`
literal, drops the field there.

The validator tests around deps↔edges symmetry are deleted (the
checks no longer exist). New tests cover:

- Edge endpoint references unknown node → validation error.
- A node that has no incoming edges receives `dagInput` as `nodeInput`.
- A node with one unconditional incoming edge receives the source's
  output as a bare value.
- A node with multiple incoming edges receives an object.
- A node with any conditional incoming edge receives an object with
  the optional field present-or-absent.

### 8. Replay/checkpoint compatibility

The state-machine context's `waves` and `outputs` shape is unchanged.
The wave plan derives from edges (already does — `topoSort` reads
`dag.edges`). `outputs` keys are node ids (unchanged).

The fingerprint changes (deps dropped from payload), so existing
checkpoints from before this refactor would mismatch. That's expected
— bump `FRAMEWORK_VERSION` so existing checkpoints are rejected on
resume rather than silently mixing old + new semantics.

---

## Test plan

- **Validator tests.** Update / delete deps-symmetry tests; add tests
  for the simplified edge-only checks.
- **Routing tests.** Existing conditional-edges tests should require
  *only* the deletion of `deps`/`optionalDeps` from node configs.
  Behavior unchanged.
- **Input-shape tests.** Property test: random DAG, random outputs,
  assert that the input each node receives matches the derived
  shape (0 → dagInput, 1 → bare, ≥2 → object, any conditional →
  object).
- **Fingerprint test.** Same DAG with `deps` previously matching →
  same fingerprint as without deps. Different edges → different
  fingerprint.

---

## ADR 0017

- **Context:** Author-supplied `deps` duplicated what edges already
  encode. The duplication enabled typo errors that the type system
  couldn't catch (per `dag-type-system.md` §6.1) without a builder
  pattern that forced topo-order declaration. Closure-scoped DSLs
  worked but redesigned the API.
- **Decision:** Edges become the single topological source of truth.
  `deps`/`optionalDeps` are removed from `NodeDef`. The framework
  derives per-node input wiring from edge variants at compile time.
  Required (object-keyed-or-bare) input from unconditional + default
  incoming, optional fields from conditional incoming.
- **Consequences:** Zero `deps` typos possible (no field to typo).
  Nodes become reusable across DAGs (their contract is `I → O`, not
  "wired to specific upstream ids"). Validator surface shrinks (one
  fewer rule). One-time migration of every node helper invocation in
  the codebase.

---

## Risks

1. **Mechanical migration scale.** Every node helper invocation in
   the codebase loses a field. Most are caught by the type system
   (extra-property errors), but raw `NodeDef` literals in tests need
   manual updates. Mitigation: typecheck after each file, run all
   tests at the end.
2. **Lost author signal.** The `deps` field also documented "this
   node consumes these upstreams" right next to the node definition.
   Without it, readers must trace the edges array to understand the
   wiring. Mitigation: in practice, authors usually use IDE
   "find references" to trace upstream-downstream flows; the inline
   `deps` comment is rarely consulted.
3. **Subtle performance.** `incomingSources(dag, nodeId)` runs once
   per node per compile, not per wave per node. Negligible.
4. **`FRAMEWORK_VERSION` bump.** Existing checkpoints become
   un-resumable. Coordinated rollout: ship the new version, drain
   in-flight workflows, then remove the old code path.

---

## Sequencing

This plan is independent of the structural-predicates plan, but
**ship structural predicates first**:

- The predicate refactor only touches the conditional-edges feature
  (small blast radius).
- The deps refactor touches every node creator and every test that
  uses one (large blast radius).
- Doing predicates first lets us validate the smaller change end-to-end
  before kicking off the larger one.

---

## Open questions

1. **Should `inputSchema` *also* be derivable?** A node with one
   unconditional dep could derive its input schema as the upstream's
   output schema. Object-merge for multi-incoming. Out of scope here
   — author still writes `inputSchema` explicitly. Could revisit.
2. **Should the runtime input shape rules be simplified to "always
   object"?** Today: 0 → dagInput, 1 → bare, 2+ → object, any optional
   → object. The 1-bare special case is convenient but inconsistent.
   Out of scope; keep current rules to minimize behavior change.
