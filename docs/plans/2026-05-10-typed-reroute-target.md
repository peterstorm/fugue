# Plan: Typed reroute target — `HumanAction.targetNodeId`

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Constrain `HumanAction.targetNodeId` to the literal union of
node ids in the DAG being run. Authors writing
`return { action: "reroute", targetNodeId: "fect" }` get an edit-time
error instead of an `invalid-reroute` runtime failure deep inside the
state machine.

**Touches:**
- `packages/framework/src/types/dag.ts` — phantom `Ids` generic on `DagDef`
- `packages/framework/src/dag-runtime/types.ts` — `HumanAction<Ids>`, `DagMachineContext<Ids>`, `DagPhase<Ids>`
- `packages/framework/src/dag-runtime/run-dag-stateful.ts` — `DagRunOpts<Ids>`, `runDagStateful` generic
- `packages/framework/src/executor/executor.ts` — `RunOptions<Ids>`, `runDag` generic
- `packages/framework/src/dag-runtime/transition-helpers.ts` — internal helpers stay string-typed (not on the call boundary)
- `packages/framework/src/dag-runtime/transition.ts` — same
- `packages/framework/src/dag-runtime/executor.ts` — same
- Apps: `apps/customer-summary/src/server.ts` (or wherever
  `onHumanReview` is wired) gets free type-protection
- New: `docs/adr/0018-typed-reroute-target.md`

---

## Problem

Today's `HumanAction`:

```ts
export type HumanAction =
  | { action: "approve" }
  | { action: "approve-with-edit"; newOutput: unknown }
  | { action: "reject"; reason: string }
  | { action: "reroute"; targetNodeId: string };
```

`targetNodeId` is `string`. A reviewer hook returning the wrong id
(typo, refactor lag, copy-paste error from another DAG) reaches the
state machine, fails `waveIndexOf` lookup, and surfaces as
`invalid-reroute` at runtime — typically observed only when a real
human review fires that branch in production.

Every other `HumanAction` field is structurally constrained at edit
time:
- `approve` has no payload.
- `approve-with-edit.newOutput` is `unknown` (intentional — the
  reviewer can replace any node's output, schema-validated downstream).
- `reject.reason` is a free-form string (intentional — reviewer
  comment).

`reroute.targetNodeId` is the one field that *should* be constrained
and isn't.

---

## Non-goals

- **Constraining `targetNodeId` at the validator level only.** Already
  done — the runtime check exists. The goal is the *earlier* failure.
- **Constraining `approve-with-edit.newOutput`.** Reviewer override
  should be schema-validated by the node, not statically restricted.
- **Constraining `reject.reason` shape.** Free-form by design.
- **Threading `Ids` through internal `transition-helpers` /
  `transition` / executor.** Internal code stays string-typed. The
  generic is a call-boundary affordance, not a runtime change.

---

## Design

### 1. Phantom `Ids` on `DagDef`

`packages/framework/src/types/dag.ts`:

```ts
declare const __dagIds: unique symbol;

export interface DagDef<Ids extends string = string> {
  readonly id: string;
  readonly nodes: readonly NodeDef<unknown, unknown, unknown>[];
  readonly edges: readonly EdgeDef[];
  readonly outputNodeId?: string;
  readonly evalJudges?: readonly EvalJudgeNodeDef[];
  readonly retryLimits?: Readonly<Record<string, number>>;
  readonly defaultRetryLimit?: number;
  readonly [__dagValidated]: true;
  /** Phantom — carries the literal union of node ids for opts threading. */
  readonly [__dagIds]?: Ids;
}
```

The brand stays. The new phantom field carries the literal id union
for the type system; at runtime, indexing `dag[__dagIds]` is
`undefined`. Two phantom fields, both via unforgeable `unique symbol`s.

`defineDag` infers and brands:

```ts
export const defineDag = <const Nodes extends NodesRecord>(
  input: DagDefInput<Nodes>,
): DagDef<keyof Nodes & string> => { ... };
```

`defineDagFromArray` returns `DagDef<string>` (the wide default — no
literal id info to thread).

### 2. `HumanAction<Ids>`

`packages/framework/src/dag-runtime/types.ts`:

```ts
export type HumanAction<Ids extends string = string> =
  | { readonly action: "approve" }
  | { readonly action: "approve-with-edit"; readonly newOutput: unknown }
  | { readonly action: "reject"; readonly reason: string }
  | { readonly action: "reroute"; readonly targetNodeId: Ids };
```

Default `Ids = string` keeps everything backwards-compat for code that
doesn't propagate the generic.

### 3. `runDagStateful` / `DagRunOpts` threading

```ts
export interface DagRunOpts<I, O, Ids extends string = string>
  extends Omit<RunOptions<DagPhase, DagMachineContext, DagEvent>, "errorEventOf"> {
  readonly jobLike?: JobLike<DagPhase, DagMachineContext>;
  readonly onHumanReview?: (req: {
    nodeId: Ids;
    output: unknown;
    prompt: string;
  }) => Promise<HumanAction<Ids>>;
  readonly retryLimits?: { readonly [K in Ids]?: number };
  readonly onBackground?: (p: Promise<void>) => void;
}

export const runDagStateful = async <I, O, Ids extends string = string>(
  dag: DagDef<Ids>,
  input: I,
  nodeCtx: NodeContext,
  opts?: DagRunOpts<I, O, Ids>,
): Promise<Result<O, FrameworkError>> => { ... };
```

When the caller writes:

```ts
await runDagStateful(summaryDag, input, ctx, {
  onHumanReview: async (req) => {
    // req.nodeId is "fetch-crm" | "extract-features" | ... | "assemble-response"
    if (req.nodeId === "synthesize") {
      return { action: "reroute", targetNodeId: "fetch-crm" };  // ✓
    }
    return { action: "reroute", targetNodeId: "fech" };  // ✗ — type error
  },
});
```

`Ids` is inferred from `summaryDag: DagDef<keyof Nodes & string>` —
the call site requires no explicit annotation.

### 4. `runDag` threading

`packages/framework/src/executor/executor.ts`:

Same shape, plus the generic:

```ts
export const runDag = async <I, O, Ids extends string = string>(
  dag: DagDef<Ids>,
  input: I,
  ctx: NodeContext,
  opts?: RunOptions<I, O, Ids>,
): Promise<Result<O, FrameworkError>> => { ... };
```

`RunOptions` gets the same treatment as `DagRunOpts`.

### 5. Internal types stay string-typed

`DagMachineContext` does *not* take an `Ids` generic. The runtime is
generic-erased — the state machine processes `string`-typed events
and contexts. The `Ids` generic exists only on the call boundary
where authors write hook implementations.

This is deliberate:
- Threading `Ids` through `DagPhase`, `DagEvent`, `dagTransition`,
  `handleHumanResponse`, etc., would explode the generic surface
  with no marginal type-safety win — the events all carry strings
  anyway, and the only `Ids`-typed field is the one the author
  writes.
- Erasure happens at the boundary: when `runDagStateful` receives
  an `onHumanReview` hook returning `HumanAction<Ids>`, the resolved
  action is passed to `dagTransition` as the wider `HumanAction<string>`.
  The runtime check (`waveIndexOf`) is unchanged — defense-in-depth
  for `as HumanAction<string>` casts.

### 6. `retryLimits` keys also typed

Almost free — `retryLimits: { [K in Ids]?: number }` constrains keys
to known node ids. Already done in `DagDefInput<Nodes>`; we extend
the same treatment to `DagRunOpts.retryLimits` so call-time overrides
get the same protection as authoring-time entries.

### 7. App migration

The `customer-summary` app already uses `defineDag(...)` for
`createSummaryDag`. The returned `DagDef` is now
`DagDef<"fetch-crm" | "extract-features" | "synthesize" | "grounding-guardrail" | "assemble-response">`.
Calls to `runDag(summaryDag, ...)` infer `Ids` automatically. No
explicit generic annotations needed.

If any caller wires `onHumanReview` (none today; HITL isn't used in
customer-summary), they'd get the typed payload for free.

---

## Test plan

- **Type-level test.** New file `__type-checks/typed-reroute.ts`:

  ```ts
  const dag = defineDag({
    id: "t",
    nodes: { a: nodeA, b: nodeB },
    edges: [{ from: "a", to: "b" }],
  });

  void runDagStateful(dag, null, ctx, {
    onHumanReview: async (req) => {
      // @ts-expect-error — "c" is not a known node id
      return { action: "reroute", targetNodeId: "c" };
    },
  });
  ```

  Compiles iff `@ts-expect-error` correctly catches the typo.

- **Runtime test.** `dag-runtime-stateful.test.ts` already covers
  reroute behaviorally — verify those tests still pass after the
  generic threading.

- **Loose-typing test.** `defineDagFromArray(...)` returns
  `DagDef<string>`. The hook payload's `targetNodeId` is `string`,
  no edit-time constraint. Document this in §6.6 of the type-system
  doc.

---

## ADR 0018

- **Context:** `HumanAction.targetNodeId` is the only `HumanAction`
  field that can structurally be wrong at edit time but isn't
  type-checked. Validator catches it at the runtime reroute event,
  which is observed only when an actual human review reroutes —
  typically late in development or in production.
- **Decision:** Add a phantom `Ids` generic to `DagDef`,
  parameterize `HumanAction` and `DagRunOpts.onHumanReview` over it,
  thread the union from `defineDag`'s record-key inference through
  to the hook return type. Internal state-machine types stay
  string-typed.
- **Consequences:** Reroute typos fail at edit time. Call-time
  `retryLimits` keys also become type-checked. The generic threading
  adds one phantom field to `DagDef` and one type parameter to
  `runDag`/`runDagStateful` — no runtime cost, no API break for code
  that defaults to `string`.

---

## Risks

1. **Generic explosion in caller code.** `runDagStateful<I, O, Ids>` —
   three generics. TS infers all three from arguments, so call sites
   stay clean. Explicit annotation is rare. Verified by the existing
   test files.
2. **Internal vs boundary asymmetry.** Internal types stay
   string-typed; call boundary is `Ids`-typed. The asymmetry is
   intentional but worth documenting in `dag-type-system.md`.
3. **`defineDagFromArray` degrades to `DagDef<string>`.** Authors who
   build DAGs dynamically lose the protection. Acceptable — the
   array-shape variant is the documented "less typing" path.
