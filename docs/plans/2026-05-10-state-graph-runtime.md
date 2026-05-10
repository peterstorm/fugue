# Plan: State-Graph Runtime (cycles, agentic flows)

**Created:** 2026-05-10
**Status:** Sketch — design space exploration, not yet committed
**Goal:** A second runtime, parallel to the DAG runtime, designed
from the ground up for **cyclic** flows: agent loops, critic-regenerate,
plan-and-revise, retrieval-rerank-refine. Cycles, conditional edges,
and shared mutable state are first-class primitives, not retrofits.
Both runtimes share the durable `Machine<S, E, C>` kernel underneath.

**Why a separate runtime, not a DAG extension:** the primitives
needed for loops (iteration counters, region resets, accumulating
state) are not DAG concepts. Bolting them onto the DAG runtime makes
the abstraction leaky. Two runtimes with one kernel keeps each
abstraction honest:

- **DAG runtime** — acyclic, wave-scheduled, node-keyed outputs,
  static plan. Optimal for fan-out/gather workflows.
- **State-graph runtime** (this plan) — cyclic, step-scheduled,
  shared state with reducers, dynamic dispatch. Optimal for agentic
  iteration.

A single workload picks one runtime; you don't mix DAGs and loops
inside the same graph definition.

---

## Status of this plan

This is a **sketch**, not an implementation plan. It documents the
design space so when a concrete consumer appears, we don't have to
rediscover the shape. **Build only when there's a real workload
demanding it.** Today the only candidate consumer is the dotslash
chatbot's hypothetical Phase 4 agentic enrichment
(`../../web/chatbot/docs/plans/2026-05-10-fugue-integration-evaluation.md`),
and that's gated on product wanting self-correcting / multi-step
chat — not committed.

The next step on this plan is **wait**. Don't build until the
workload shape is concrete enough to validate the design choices
below.

---

## Problem

The DAG runtime is the right tool for batch-shaped, fan-out/gather
work (eval runners, summary pipelines, retrieval pipelines). It is
**the wrong tool** for iterative-agent flows:

1. **Cycles are forbidden.** `topoSort` rejects them
   (`packages/framework/src/executor/topo.ts:62-64`). Critic loops,
   plan-revise loops, agent ReAct-style flows have no expression in
   the graph topology.
2. **Outputs are node-keyed and overwritten on re-run.** A loop
   wanting to accumulate scratchpad state across iterations has no
   clean place to put it. The DAG model is "each node produces one
   output for the run."
3. **Wave scheduling is fixed at compile.** Agent flows decide
   "what runs next" at runtime based on accumulated state. Static
   wave plans don't model that.

The note at
`~/dev/notes/remotevault/learning/autonomous-agents-in-production/fugue-outcome-branching.md`
identified the gap; the prior conversation explored bolt-on options
(back-edges, `previousOutput`, loop regions) and concluded they
make the DAG model leaky. A separate runtime is the right answer.

---

## Non-goals

- **Replacing the DAG runtime.** They coexist. DAGs that work today
  keep working. Nothing in this plan touches DAG code.
- **Shared graph definitions.** A `GraphDef` is not a `DagDef` and
  vice versa. No shape conversion. If you want a step that does
  fan-out/gather inside a state-graph, you call `runDag` from inside
  a graph node (composition, not nesting).
- **Streaming outputs from inside graph nodes.** Same non-goal as
  the DAG runtime. Streaming belongs at the application boundary.
- **Multi-writer state.** One node runs at a time; the reducer
  applies its delta. Multi-writer concurrency is the next runtime,
  not this one.
- **Visual graph editors.** Out of scope; could be built externally.

---

## Design sketch

### 1. Surface

```ts
// packages/framework/src/state-graph-runtime/types.ts

import type { z } from "zod";
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeContext, NodeRetryConfig, NodeHumanReviewConfig } from "../types/node.js";

/**
 * Branded sentinel for terminal edges. Edge `to: END` ends the run.
 * Branded so a string typo like `"end"` or `"__end__"` literal is a
 * compile error — only the exported constant satisfies the type.
 */
declare const __END_BRAND__: unique symbol;
export type EndSentinel = string & { readonly [__END_BRAND__]: true };
export const END: EndSentinel = "__end__" as EndSentinel;

/**
 * State must be a Zod object schema (not a primitive, not an array, not a
 * union). Reducers key off field names; the constraint enforces this at the
 * type level. `z.ZodObject<z.ZodRawShape>` is the canonical bound.
 */
export type StateSchema = z.ZodObject<z.ZodRawShape>;

/**
 * Per-field reducer. Called with `prev` (current canonical value) and
 * `delta` (the value the node returned for this field). The runtime
 * only invokes reducers for fields PRESENT in the delta — `delta`
 * is therefore non-undefined unless the field's value type itself
 * permits undefined.
 */
export type Reducer<V> = (prev: V, delta: V) => V;

export interface GraphDef<S extends StateSchema> {
  readonly id: string;
  /** Zod object schema for the shared state. State must be JSON-serializable. */
  readonly stateSchema: S;
  /** Per-field reducers. Default is overwrite. Author-supplied reducers MUST be pure. */
  readonly reducers?: Partial<{ [K in keyof z.infer<S>]: Reducer<z.infer<S>[K]> }>;
  readonly nodes: readonly GraphNodeDef<S>[];
  readonly edges: readonly GraphEdgeDef<S>[];
  readonly entryNodeId: string;
  /** Hard ceiling on total step count. Required (no implicit infinity). */
  readonly maxSteps: number;
}

export interface GraphNodeDef<S extends StateSchema> {
  readonly id: string;
  /**
   * Read shared state, return a state delta. Reducer merges deltas
   * into the canonical state. Returning {} is valid (no-op step).
   */
  readonly run: (
    state: Readonly<z.infer<S>>,
    ctx: NodeContext,
  ) => Promise<Result<Partial<z.infer<S>>, FrameworkError>>;
  readonly retry?: NodeRetryConfig;
  readonly humanReview?: NodeHumanReviewConfig;
}

export interface GraphEdgeDef<S extends StateSchema> {
  readonly from: string;
  /** Either an existing node id or `END`. Validator checks. */
  readonly to: string | EndSentinel;
  /**
   * Optional guard. Pure function of (current) state. The state is
   * typed by the graph's schema — no `unknown` at the call site.
   */
  readonly when?: (state: Readonly<z.infer<S>>) => boolean;
  /**
   * Edge selection priority. When multiple guarded edges from the same
   * `from` could fire, lowest priority wins. Required when there are
   * 2+ guarded edges from the same node; ignored otherwise.
   */
  readonly priority?: number;
}

// Centralised type guards — same discipline as DAG `EdgeDef`.
export const isUnconditionalGraphEdge = <S extends StateSchema>(
  e: GraphEdgeDef<S>,
): e is Omit<GraphEdgeDef<S>, "when"> => e.when === undefined;
export const isEndEdge = <S extends StateSchema>(
  e: GraphEdgeDef<S>,
): boolean => e.to === END;
```

**Type-safety wins from this surface:**

- `GraphEdgeDef<S>.when` is typed as `(state: z.infer<S>) => boolean`,
  not `unknown`. Guard authors get autocomplete and compile-time
  field access.
- `EndSentinel` is branded. `to: "end"` (typo) won't compile.
- `StateSchema = z.ZodObject<z.ZodRawShape>` constrains state to an
  object — required for the `keyof` indexing in `reducers` to type
  correctly. Primitive or array states are rejected by the type
  system, not at runtime.
- `Reducer<V>` is its own type, so authors who want to reuse a
  reducer (`appendArray<T>: Reducer<T[]>`) have a vocabulary.
- `GraphNodeDef.run` returns `Result<Partial<z.infer<S>>, FrameworkError>` —
  delta typed against the schema, framework error typed in the union.

### 2. Execution model

One node runs per **step**. The scheduler:

1. Read current node id from machine state.
2. Run that node with the canonical state read-only.
3. Apply the returned delta through reducers → new canonical state.
4. Append a `step-done` event with `{ nodeId, delta, newStateHash }` to the log.
5. Evaluate outgoing edges of the just-run node, pick the next node
   by guard (first match, declaration order; ties broken by
   `priority`).
6. If next is `END`, transition to `succeeded`. If `step + 1 > maxSteps`,
   transition to `failed { kind: "step-limit-exceeded" }`. Otherwise
   loop.

No topo sort. No waves. The "graph" is genuinely a graph: nodes can
have edges back to themselves or to upstream nodes. The framework
neither knows nor cares about acyclicity.

**Step ordering — load-bearing for replay:**

1. Run node → produces `Result<delta, FrameworkError>`.
2. If `Err`, emit `node-failed` event, transition through retry/fail.
3. If `Ok`, **apply reducers** to fold delta into canonical state.
4. If a reducer throws, surface `reducer-threw` and transition to
   `failed` — `step-done` is **not** emitted (the state is
   indeterminate; the log must reflect that).
5. If reducers succeed, emit `step-done { nodeId, delta }`. State is
   not in the event — it reconstructs by folding deltas through
   reducers on replay. This keeps event-log size proportional to
   delta size, not state size.
6. Evaluate outgoing edges; pick next node; loop.

```ts
// state-graph-runtime/types.ts

import type { HumanAction } from "../dag-runtime/types.js";

/**
 * Graph runs are typed by the same `S` as their `GraphDef`. The
 * runtime erases the generic at the kernel boundary
 * (`Machine<GraphPhase, GraphEvent, GraphMachineContext>`), but the
 * surface API preserves the type so users see typed states.
 */
export type GraphPhase<S extends StateSchema = StateSchema> =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly currentNodeId: string; readonly step: number }
  | {
      readonly kind: "retrying";
      readonly currentNodeId: string;
      readonly step: number;
      readonly attempt: number;
      readonly nextDelayMs: number;
    }
  | {
      readonly kind: "awaiting-human";
      readonly nodeId: string;
      readonly state: Readonly<z.infer<S>>;
      readonly step: number;
    }
  | { readonly kind: "succeeded"; readonly state: Readonly<z.infer<S>> }
  | { readonly kind: "failed"; readonly error: FrameworkError };

/**
 * Graph-flavoured human action. Extends the DAG `HumanAction` union
 * with one new variant: rerouting can optionally rewind state.
 * The DAG `HumanAction` type is unchanged (DAG callers don't see
 * `restoreFromStep`); the graph runtime accepts a wider union.
 */
export type GraphHumanAction<S extends StateSchema> =
  | HumanAction
  | {
      readonly action: "graph-reroute";
      readonly targetNodeId: string;
      /**
       * Optional. If present, replay deltas [0, restoreFromStep) through
       * reducers from initial state and use that as the new canonical
       * state. If absent, current state is kept and only `currentNodeId`
       * changes. Bounded by current step.
       */
      readonly restoreFromStep?: number;
    }
  | { readonly action: "graph-edit-state"; readonly newState: z.infer<S> };

export type GraphEvent<S extends StateSchema = StateSchema> =
  | { readonly type: "start"; readonly initialState: z.infer<S> }
  | { readonly type: "step-done"; readonly nodeId: string; readonly delta: Partial<z.infer<S>> }
  | { readonly type: "node-failed"; readonly nodeId: string; readonly error: FrameworkError }
  | { readonly type: "human-responded"; readonly nodeId: string; readonly action: GraphHumanAction<S> }
  | { readonly type: "abort"; readonly reason: string }
  | { readonly type: "ERROR"; readonly retriable: boolean; readonly error: string };

/**
 * Machine context for a graph run. Mirrors the role of `DagMachineContext`
 * in `dag-runtime/types.ts:98-104`.
 */
export interface GraphMachineContext<S extends StateSchema = StateSchema> {
  readonly graph: GraphDef<S>;
  /** Current canonical state. Folded from deltas. */
  readonly state: Readonly<z.infer<S>>;
  /** Per-node retry counter. */
  readonly retries: ReadonlyMap<string, number>;
  /** Number of `step-done` events folded so far. Drives `maxSteps` check. */
  readonly stepCount: number;
  /** Initial state captured at run start — needed for replay-from-step in HITL graph-reroute. */
  readonly initialState: Readonly<z.infer<S>>;
  /**
   * Append-only log of deltas in the order they were folded. NOT used by
   * the kernel (replay reads the event log); held in context only to
   * support `graph-reroute { restoreFromStep }` without re-reading the
   * durable log mid-run. Capped by `maxSteps`.
   */
  readonly deltaLog: readonly { readonly nodeId: string; readonly delta: unknown }[];
}
```

### 3. Shared kernel reuse

```ts
export const compileGraphToMachine = <S extends StateSchema>(
  graph: GraphDef<S>,
  initialState: z.infer<S>,
): Result<CompiledGraphMachine<S>, FrameworkError>;

export const runGraph = <S extends StateSchema>(
  graph: GraphDef<S>,
  initialState: z.infer<S>,
  options: RunGraphOptions<S>,
): Promise<Result<z.infer<S>, FrameworkError>>;
```

Initial state is **required** at run start, not optional. Reasons:

- Zod schemas can have defaults but those defaults are not always
  serializable (e.g. `() => Date.now()`); requiring an explicit
  starting state makes the run reproducible.
- Replay re-uses the same `initialState` (recorded in the
  `start` event); without an explicit value, replay is ambiguous.
- The schema validates `initialState` at compile-machine time;
  invalid initial state fails fast with a typed
  `validation` error.

`compileGraphToMachine` returns `Machine<GraphPhase<S>, GraphEvent<S>,
GraphMachineContext<S>>` consumed by the same `runStateMachine`
runner (`packages/framework/src/state-machine/runner.ts`). The
generic is preserved through the entry point and erased at the
kernel boundary the same way `Machine<S, E, C>` already erases its
parameters at the runner.

What's shared:

- `Machine<S, E, C>` kernel + `runStateMachine` driver.
- `JobLike` durable adapter (BullMQ, in-memory).
- `RecordedEvent<E>` envelope, replay, replay-to-timestamp.
- `Checkpointer` (Redis + fingerprint).
- `Observer` + `Tracer`.
- `LlmClient` + `sendWithTools` (used inside graph nodes' `run`).
- `NodeContext` shape.
- `FrameworkError` taxonomy (with new state-graph-specific kinds).
- HITL — `awaiting-human` semantics; `HumanAction` shape; reroute
  becomes "set current node to X, optionally rewind state to a
  snapshot."

What's distinct:

- `GraphDef` vs `DagDef` — different shape, different validator.
- Step scheduler vs wave scheduler.
- Shared state with reducers vs node-keyed outputs.
- No topo sort; no `optionalDeps`; no `activeNodeIds`.
- Replay folds state deltas, not output maps.

### 4. State and reducers

State is a single typed object. Default reducer per field is
"overwrite if the delta has the field." Authors can override per
field for accumulation:

```ts
const graph: GraphDef<typeof StateSchema> = {
  stateSchema: StateSchema, // { messages: Message[], scratchpad: string, draft: string | null }
  reducers: {
    messages: (prev, delta) => [...prev, ...delta], // append
    scratchpad: (prev, delta) => prev + "\n" + delta, // concatenate
    // draft: defaults to overwrite
  },
  // ...
};
```

This is the LangGraph reducer model. It's the right shape for
agentic flows because:

- A "scratchpad" / "messages" / "tool history" naturally accumulates;
  authors should not write `[...state.scratchpad, newEntry]` boilerplate.
- The reducer is the only place that writes state; it's pure and
  testable in isolation.
- Replay folds deltas through reducers deterministically.

### 5. Termination

Three ways to terminate:

1. **Edge to `END` fires.** Normal exit. Transition to
   `succeeded { state }`.
2. **`maxSteps` exceeded.** Transition to
   `failed { kind: "step-limit-exceeded", steps, maxSteps }`. This is
   the safety net; authors should design exit edges so this rarely
   fires.
3. **Node returns terminal error.** Same as DAG — transition to
   `failed`. Retries apply per node config.

Validator enforces every node has at least one path to `END` along
unconditional + guard-could-fire edges (best-effort static check;
not full reachability since guards are runtime).

### 6. HITL

`awaiting-human` works the same as in the DAG: a node with
`humanReview` config pauses the run after producing its delta. Human
returns `HumanAction`:

- `approve` → apply delta, advance to next node.
- `approve-with-edit` → use the edited delta, advance.
- `reject` → transition to `failed { kind: "rejected" }`.
- `reroute { targetNodeId, restoreFromStep? }` → set `currentNodeId`
  to target. Optionally rewind state to the snapshot at the given
  step (replay deltas from 0 to `restoreFromStep`). This is the
  graph-runtime analogue of DAG reroute; it's strictly more
  powerful because the graph already supports cycles.

### 7. Replay

Each `step-done` event carries `{ nodeId, delta }`. Replay folds
deltas through the reducer in order; the final state matches the
live state byte-for-byte (assuming pure reducers + pure guards).

The event envelope is unchanged (ADR 0014's `RecordedEvent`); we
get replay-to-timestamp for free.

Property test: random graph + random reducers + random node runs →
`replayEvents(log) === liveState` for every prefix of the log.

### 8. Validator

`validateGraphShape(graph) → Result<void, FrameworkError>`:

1. Non-empty `nodes`. No duplicate node ids. `entryNodeId` exists.
2. `maxSteps ≥ 1`.
3. For every edge: `from` exists; `to` is `END` or an existing node.
4. **At least one path to `END`** from every node along edges that
   are unconditional or whose guards aren't trivially `() => false`.
   (Best-effort. The runtime safety net is `maxSteps`.)
5. **Priority required** when ≥ 2 guarded edges share a `from`.
6. **No edge to `entryNodeId`** unless it's a deliberate restart loop;
   warn but allow. (Documented as advanced usage.)
7. Reducer schema: every key in `reducers` must be a key of
   `z.infer<stateSchema>`.

### 9. Errors added

`packages/framework/src/types/errors.ts`:

```ts
| { readonly kind: "step-limit-exceeded"; readonly steps: number; readonly maxSteps: number }
| { readonly kind: "no-outgoing-edge"; readonly nodeId: string }
| { readonly kind: "ambiguous-edge-priority"; readonly fromNodeId: string }
| { readonly kind: "graph-guard-threw"; readonly fromNodeId: string; readonly message: string }
| { readonly kind: "reducer-threw"; readonly field: string; readonly message: string }
| { readonly kind: "unreachable-end"; readonly fromNodeId: string }
```

### 10. Observer events

- `step-start` — `{ runId, graphId, nodeId, step, timestamp }`
- `step-end` — `{ runId, graphId, nodeId, step, deltaKeys, timestamp }`
  (delta keys, not values, by default — content gating same as
  DAG span content gating)
- `edge-decided` — `{ runId, graphId, fromNodeId, toNodeId, step, timestamp }`
- `state-graph-end` — `{ runId, graphId, terminal: "succeeded" | "failed" | "step-limit", finalState, timestamp }`

### 11. Public API

```ts
// packages/framework/src/index.ts (new exports)

export {
  type GraphDef,
  type GraphNodeDef,
  type GraphEdgeDef,
  END,
} from "./state-graph-runtime/types.js";

export { runGraph } from "./state-graph-runtime/run-graph.js";
```

`runGraph` mirrors `runDag` exactly: same options, same return
shape, same `JobLike` integration, same observer.

---

## Soundness audit

### Type safety

| Claim | How preserved |
| --- | --- |
| State is a typed object across the entire surface. | `GraphDef<S extends StateSchema>` constrains `S` to `z.ZodObject<z.ZodRawShape>`. Primitive / array states are rejected by the type system. Reducers can `keyof z.infer<S>` safely. |
| Guards are not `unknown`. | `GraphEdgeDef<S>.when: (state: z.infer<S>) => boolean`. Guard authors get autocomplete and compile-time field access. Fixes a real gap from the original sketch. |
| `END` cannot be confused with a string. | `EndSentinel` is a branded string; the only inhabitant is the exported `END` constant. `to: "end"` (typo) is a compile error. |
| Reducer authors can't accidentally write a field that isn't in the schema. | `reducers?: Partial<{ [K in keyof z.infer<S>]: Reducer<z.infer<S>[K]> }>` — keys constrained to schema fields; values constrained to `Reducer<value-type-of-field>`. Adding a typo'd key fails to compile. |
| `GraphPhase` and `GraphEvent` are typed by `S`. | Both carry the `S` generic so `awaiting-human.state`, `succeeded.state`, `step-done.delta` are all schema-typed at the surface. Erased only at the kernel boundary, same as `Machine<S, E, C>`. |
| `HumanAction` for graphs doesn't leak DAG-only variants. | `GraphHumanAction<S>` is a wider union than `HumanAction`; the graph runtime accepts both, the DAG runtime only sees the narrower one. Existing DAG callers don't see `graph-reroute` / `graph-edit-state`. |
| `FrameworkError` discrimination stays exhaustive. | Six new variants are additive. Every match site uses `ts-pattern.match(…).exhaustive()`. (See "Cross-runtime error union" risk.) |
| Initial state is validated against the schema. | `compileGraphToMachine` runs `stateSchema.parse(initialState)` at the same point the DAG runtime validates inputs. Type-error at runtime if mismatched, with a typed `validation` `FrameworkError`. |
| Reducer is called only when delta has the field. | Specified in `Reducer<V>` doc — `delta` is the value-type, not `value-or-undefined`. Runtime checks `field in delta` before calling. Tested. |

### Architectural soundness

| Claim | How preserved |
| --- | --- |
| One node runs at a time — no concurrent state writes. | Step scheduler runs node, applies reducer, then advances. The kernel runs one transition at a time per `JobLike`. No racing reducers possible. |
| Reducer ordering is deterministic. | Per-field reducers run in `Object.keys(delta)` iteration order, but field order doesn't affect semantics because each reducer only touches its own field. Order-independent by construction. |
| Reducer-throw cannot leave indeterminate state in the log. | Specified in §2 step ordering: reducer runs **before** `step-done` is emitted. If reducer throws, no `step-done` is appended; the run transitions to `failed` with `reducer-threw`. Replay sees no inconsistent state. |
| `step-done` events are sufficient for replay. | Each event carries `{ nodeId, delta }`. State reconstructs by folding deltas through reducers from `initialState` (carried by the `start` event). Property test pins this. |
| `maxSteps` ceiling is enforced. | Required field on `GraphDef`; checked after every `step-done` fold. No implicit infinity. Catches authoring bugs (reducer doesn't terminate) and runtime drift (guards never reach `END`). |
| `END` is reachable from every node (best-effort). | Validator does a static reachability check ignoring guards (treating every guarded edge as fireable). Real termination depends on guards; `maxSteps` is the runtime bound. Honest about the limit. |
| Cross-runtime composition is bounded. | A graph node calling `runDag` (or vice versa) runs as a nested run with its own `runId`; trace context propagates via `NodeContext.tracer`; abort propagates via `signal`. No shared state, no shared retry budget. v1 supports this naturally; cross-runtime HITL coordination is documented as v2. |
| Same `JobLike` durability semantics as DAG. | Identical adapter; envelope; entry-ID-pinned timestamps; legacy fallback path. Replay-to-timestamp works for graph runs out of the box. |

### Replay determinism

| Claim | How preserved |
| --- | --- |
| Same event log → same final state. | Reducers are pure; guards are pure; reducer ordering is deterministic. Property test: random graph + random pure reducers + random pure guards → `replayEvents(log) === liveState` for every prefix. |
| Same event log → same routing decisions. | Edge guards are pure functions of state; same state → same decision. |
| `restoreFromStep` in `graph-reroute` is deterministic. | Replays deltas `[0, restoreFromStep)` through reducers from `initialState`. Pure ⇒ same input ⇒ same output. |
| Impure reducers / guards are out of contract. | Documented in non-goals. Property tests cannot catch impurity (false negative). Same limitation as the DAG runtime's pure-guard rule. |

### Validator completeness

| Check | Purpose |
| --- | --- |
| Non-empty nodes, no duplicate ids, `entryNodeId` exists. | Same as DAG. |
| `maxSteps ≥ 1`. | Prevents trivial misconfiguration. |
| Every edge `from`/`to` exists (or is `END`). | Edge well-formedness. |
| At least one path to `END` from every reachable node. | Best-effort static termination. Docs make this explicit. |
| `priority` required when ≥2 guarded edges share a `from`. | Avoids ambiguous routing. Error `ambiguous-edge-priority`. |
| `reducers` keys ⊆ schema fields. | Caught at compile by the `Partial<{ [K in keyof …] }>` type, but the validator rechecks at runtime in case the schema and reducers diverge across module boundaries. |

### Runtime invariants preserved

| Invariant | Status |
| --- | --- |
| One human review at a time. | Same `awaiting-human` semantics — kernel-level, single-step. |
| Per-node retry budget. | Same `NodeRetryConfig` shape; `retries` map in `GraphMachineContext`. |
| Aborted from any non-terminal state. | Same `abort` event; transitions to `failed { kind: "aborted" }`. |
| `compileGraphToMachine` fail-fast. | Validator → schema parse → context build, in that order. Same fail-fast contract as `compileDagToMachine`. |

### What this plan does NOT achieve

- **Static termination.** Halting problem applies. `maxSteps` is the
  runtime bound; the validator only catches trivially-unreachable
  `END`s.
- **Reducer / guard purity at runtime.** Same as DAG: documentation
  + property tests, no runtime check.
- **State serialisability check at compile.** A schema validates
  shape but not "every value is JSON-serializable" (a `Date` field
  serialises to a string and back, but a `Function` field does not
  round-trip). Documented as author discipline; runtime persistence
  failure surfaces as a `checkpoint-corrupt` error.
- **Cross-runtime atomic HITL.** A DAG and a graph paused for review
  on the same logical request need application-level coordination.
- **Type-erased generic at the kernel boundary.** `GraphPhase<S>`
  becomes `GraphPhase<StateSchema>` once it crosses into the
  `Machine` interface. Surface API preserves the type; internal
  kernel code does not. Acceptable; same pattern as everywhere else.

### Risks specific to type safety

1. **Cross-runtime error union.** Adding six graph-runtime error
   kinds to the shared `FrameworkError` union means DAG-runtime
   exhaustive matches now have to handle graph kinds (and vice versa).
   For v1, accept this — `ts-pattern.exhaustive()` enforces handling
   so it's a compile error not a silent miss. v2 may split into
   `DagFrameworkError | GraphFrameworkError | KernelFrameworkError`.
2. **Generic erasure at the kernel.** The `Machine<GraphPhase,
   GraphEvent, GraphMachineContext>` interface erases the `S`
   parameter. Internal kernel code sees `unknown` for state /
   delta. The risk is internal code accidentally trusting the
   shape. Mitigation: kernel code does not inspect state; it only
   passes it through `transition` and `executor`. Discipline + tests.
3. **Reducer as an open extension point.** Authors can write any
   `Reducer<V>`. A buggy reducer (non-pure, non-associative) silently
   diverges replay. Mitigation: docs, property tests in the
   framework, optional runtime "double-fold check" in dev mode that
   re-folds and asserts equality (defer; not v1).

---

## File layout

```
packages/framework/src/
  state-graph-runtime/         (new, parallel to dag-runtime/)
    types.ts                    — GraphDef, GraphPhase, GraphEvent, GraphMachineContext
    machine.ts                  — compileGraphToMachine
    transition.ts               — pure transition function
    transition-helpers.ts       — handleStepDone, handleNodeFailed, etc.
    executor.ts                 — buildGraphExecutor (single-step)
    reducers.ts                 — applyReducers helper
    validate-graph.ts           — validateGraphShape
    run-graph.ts                — top-level runGraph entry
    __tests__/                  — full test suite
  types/
    errors.ts                   — adds 6 new error kinds
  state-machine/                — UNCHANGED (kernel is shared)
  dag-runtime/                  — UNCHANGED
```

Roughly **1500-2000 lines new code + 1000-1500 lines tests**. The
DAG runtime is ~1200 lines without tests; the state-graph runtime
is comparable in size because it doesn't share much beyond the
kernel.

---

## When to build

**Trigger conditions:**

1. A concrete consumer (chatbot Phase 4, customer-summary self-critique,
   or a new app) commits to using the runtime.
2. We have at least two distinct flows we want to express, so the
   API isn't designed for one workload.
3. The DAG runtime's conditional-edges plan (Phase A) has shipped
   and stabilised, so we can amortise the validator + observer
   patterns.

**Stop conditions** (reasons to NOT build):

1. The candidate workload turns out to be expressible as
   "DAG-with-application-level-while-loop" (run DAG, check guard,
   re-run with new input). Many "agentic" flows are.
2. Shared state with reducers turns out to be a bad fit for the
   workload — e.g. the workload wants per-step branching that LLMs
   produce as messages rather than state objects (then we need a
   different surface again).
3. The cost of two runtimes (docs, tests, discovery, "which one do I
   pick" UX) outweighs the benefit, given how few real consumers
   exist.

---

## Risks

1. **Two-runtime UX.** "Which one do I pick?" needs a clear
   decision tree in `library-ux.md`. Default rule: if your flow has
   a topological order, use DAG; if it has cycles or accumulating
   state, use state-graph. If unsure, start with DAG.
2. **Reducer correctness.** Authors writing buggy reducers (non-pure,
   non-associative, accidentally mutating prev) is a class of
   replay-divergence bug we don't have today. Mitigation: property
   tests in framework code; documented constraints; runtime
   `validateOutput`-style checks would help (compare reduced result
   to schema).
3. **Conceptual sprawl.** Every new feature now has to ask "DAG,
   state-graph, or both?" Mitigation: design new features for the
   kernel where possible (replay, observer, retry); only add to
   runtime surfaces when the runtime actually needs it.
4. **Cross-runtime composition.** A DAG node calling `runGraph` and
   vice versa needs careful thought re: HITL, abort propagation,
   trace context. Out of scope for v1 — graphs and DAGs run as
   separate top-level workloads. Cross-composition is a v2 concern.
5. **Graph definitions become unreadable.** With cycles + guards +
   reducers, `GraphDef` instances can become impossible to reason
   about. Mitigation: convention of small, named, single-purpose
   nodes; ASCII-art comments in tests; defer real visualisation
   to a later concern.

---

## Open questions (resolve before building, not now)

1. **Is `END` a sentinel string or a distinct type?** String is
   simpler; distinct type prevents typos. Lean string with a brand
   (`type EndSentinel = "__end__" & { readonly __brand: unique symbol }`).
2. **Are reducers per-field or one big reducer?** Per-field is what
   LangGraph does and is more ergonomic. One big reducer is more
   flexible. Lean per-field with a `__root__` escape hatch.
3. **Step events: include full delta or just keys?** Full delta is
   useful for replay and forensics but blows up event-log size for
   large states. Lean: full delta, with the same content-gating as
   DAG node spans (`includeContent` flag).
4. **Snapshot interval for reroute restore-from-step?** Every step
   captures full state would be expensive; folding from `0` for
   reroute is O(steps). Lean: fold from 0; if it becomes a hotspot,
   add periodic snapshots in a follow-up.
5. **Does a graph node read the whole state, or only declared
   fields?** Whole state is simpler; declared fields enable static
   dep analysis and partial replay. Lean whole state for v1.
6. **HITL with state**: when human approves, do they edit a delta
   or the whole state? Edit delta — keeps the reducer in the
   write-path.
7. **Cross-runtime HITL queue**: if a DAG and a graph both pause for
   human review, do they share the queue? Probably yes; the queue
   is keyed by `runId`. Verify when building.

---

## Comparison: DAG runtime vs state-graph runtime

| Concern | DAG runtime | State-graph runtime |
| --- | --- | --- |
| Topology | Static, acyclic | Dynamic, cyclic allowed |
| Scheduling | Wave parallelism | One step per turn |
| State model | Node-keyed outputs | Shared state with reducers |
| Termination | All waves complete | Edge to `END` or `maxSteps` |
| Routing | Conditional edges (after Phase A) | Conditional edges + cycles |
| HITL | `awaiting-human` per node | `awaiting-human` per step |
| Reroute | Wave-targeted, resets later waves | Node-targeted, optional state restore |
| Replay | Fold `wave-done` events | Fold `step-done` deltas through reducers |
| Best for | Eval runners, summary pipelines, retrieval | Agent loops, critic-regenerate, plan-revise |
| Author cognitive load | Lower (data-flow shape) | Higher (state design + reducer correctness) |

---

## What this plan replaces

This plan replaces the "Phase B: bounded back-edges" portion of the
earlier draft `2026-05-10-conditional-edges-and-bounded-loops.md`
(deleted). The conditional-edges portion of that draft survives as
`2026-05-10-conditional-edges.md`. The two together represent the
full answer to "fugue + branching + loops":

- **Conditional routing in DAGs** → ship as Phase A on the DAG runtime.
- **Loops + cycles + agentic flows** → ship as a separate runtime, when
  there's pull for it.

No middle ground; no hybrid; no leaky abstraction.
