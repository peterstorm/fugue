# Plan: Conditional Edges (DAG runtime)

**Created:** 2026-05-10
**Status:** Draft
**Goal:** Add LLM-outcome-conditional branching to the DAG runtime
without breaking acyclicity, the static topo plan, or replay
determinism. Conditional edges are a **runtime filter on a static
plan** — they prune unreachable subgraphs, they do not introduce
cycles. Cycles / loops are explicitly out of scope here and are the
subject of a separate runtime (see
`2026-05-10-state-graph-runtime.md`).

**Touches:**
- `packages/framework/src/types/dag.ts` — `EdgeDef` becomes a discriminated union (still acyclic)
- `packages/framework/src/types/node.ts` — `optionalDeps` on `NodeDef`
- `packages/framework/src/types/errors.ts` — new error kinds
- `packages/framework/src/dag-runtime/types.ts` — `activeNodeIds` on `DagMachineContext`
- `packages/framework/src/dag-runtime/transition-helpers.ts` — guard evaluation in `handleWaveDone`
- `packages/framework/src/dag-runtime/executor.ts` — `runWave` filters by active set
- `packages/framework/src/executor/validate-dag.ts` — optional-dep relaxation; output reachability under guards; edge uniqueness; else-totality
- New: `packages/framework/src/dag-runtime/conditional.ts` — guard evaluation + transitive reachability helpers
- `docs/library-ux.md` — new "Conditional edges" section
- New ADR: `docs/adr/0015-conditional-edges.md`

---

## Problem

The DAG runtime is **strictly acyclic with static, unconditional
edges**. `EdgeDef` has only `{ from, to }` (no condition); the wave
plan is computed once at compile and embedded in
`DagMachineContext.waves` (`packages/framework/src/dag-runtime/machine.ts:80-88`);
every successor of a node always runs.

This blocks LLM-outcome-conditional branching. A router LLM that
should pick between "summarise" / "translate" / "skip" today forces
either:

1. **N-way `skipWhen` guards** — every branch pays a no-op pass through
   the framework on every execution.
2. **God-dispatcher node** — routing logic lives inside one node's
   `run`, losing per-branch observability and wave-level parallelism.

Both work; both are workarounds. We want first-class outcome routing
as edge metadata so:

- Per-branch spans + observer events are framework-native.
- Pruned branches incur **zero** per-node cost (no validation, no
  span emission, no cache lookup).
- The graph topology itself describes the routing policy.

A concrete consumer: the dotslash chatbot's Phase 4 agentic
enrichment (see
`../../web/chatbot/docs/plans/2026-05-10-fugue-integration-evaluation.md`)
needs routing — but it specifically needs *routing*, not loops. Loops
go to the state-graph runtime.

---

## Non-goals

- **Cycles / back-edges / loops.** Out of scope. Belongs in the
  state-graph runtime (`2026-05-10-state-graph-runtime.md`). The
  DAG runtime stays an honest DAG; conditional edges do not break
  acyclicity (they are static edges with a runtime predicate).
- **Guarded multi-fan-out.** First matching guard wins (exclusive
  routing). Multi-edge "fire all guards true" is `skipWhen` already.
- **Side-effecting guards.** Guards must be **pure functions of node
  output**. Side-effecting guards make replay non-deterministic and
  would force a `branch_taken` field in the event envelope (ADR 0014)
  which we explicitly avoid.
- **Per-branch outputs.** `outputNodeId` reachability is verified
  along unconditional + default edges only — guards may bypass nodes,
  never the output. If you want a branch to reach its own terminal,
  rejoin first.
- **Backwards-compat shims.** Existing DAGs without conditional edges
  remain bit-for-bit unchanged. New variants are opt-in by edge
  shape; no migration flags.
- **Streaming outputs.** Already a non-goal of the framework.

---

## Design

### 1. API surface

`packages/framework/src/types/dag.ts`:

```ts
export type Guard = (output: unknown) => boolean;

// Existing unconditional edge keeps its exact shape — backwards compatible.
// New variants are detected by the presence/value of `when` / `kind`.
export type EdgeDef =
  | { readonly from: string; readonly to: string }
  | { readonly from: string; readonly to: string; readonly when: Guard }
  | { readonly from: string; readonly to: string; readonly kind: "default" };

// Centralised type guards — the only place code should branch on edge shape.
export const isUnconditionalEdge = (e: EdgeDef): e is { from: string; to: string } =>
  !("when" in e) && !("kind" in e);
export const isConditionalEdge = (e: EdgeDef): e is Extract<EdgeDef, { when: Guard }> =>
  "when" in e;
export const isDefaultEdge = (e: EdgeDef): e is Extract<EdgeDef, { kind: "default" }> =>
  "kind" in e && e.kind === "default";
```

The `kind: "default"` variant is the **else edge**. A node that emits
any conditional out-edges MUST also emit exactly one
`kind: "default"` out-edge. This keeps routing total without forcing
guards to be statically proven exhaustive.

**Discriminant rationale.** Field-presence (not an explicit `kind`
on every variant) keeps the existing `{ from, to }` shape working
without code changes. Cost: narrowing requires the helpers above; we
do **not** allow ad-hoc `"when" in e` checks elsewhere — a unit test
greps `dag-runtime/` for direct field inspection.

`packages/framework/src/types/node.ts`:

```ts
export interface NodeDef<I, O, E> {
  readonly deps: readonly string[];           // always-active inputs
  readonly optionalDeps?: readonly string[];   // may-be-pruned inputs (conditional joins)
  // … rest unchanged …
}
```

**Node-input shape (the bit `runWave` builds at `executor.ts:60-65`).**
Existing rules:

| `deps.length` | `nodeInput` |
| --- | --- |
| 0 | `dagInput` |
| 1 | bare `outputs.get(deps[0])` |
| ≥ 2 | object `{ [d]: outputs.get(d) }` |

Extension: **if `optionalDeps` is non-empty, `nodeInput` is always
an object** keyed by `deps ∪ optionalDeps`, regardless of
`deps.length`. Optional deps absent from `outputs` (because their
branch was pruned) appear as `undefined`.

`inputSchema` for nodes with `optionalDeps` MUST mark those fields
as `z.optional()`. Author discipline; runtime `validateInput` is the
safety net.

### 2. Routing model: exclusive, first-match-wins

When wave `W` completes, for each node `N` in `W` that has guarded
out-edges, evaluate guards in **declaration order** against `N`'s
output. First `true` wins; that edge fires; all other guarded edges
from `N` are inactive; the `default` edge fires only if no guard
matched.

`packages/framework/src/dag-runtime/conditional.ts`:

```ts
export type Decision = { readonly chosenTargets: ReadonlySet<string> };

export const decideRoute = (
  fromNodeId: string,
  output: unknown,
  outgoing: readonly EdgeDef[],
): Decision => {
  const guarded = outgoing.filter(isConditionalEdge);
  const defaultEdge = outgoing.find(isDefaultEdge);
  const unconditional = outgoing.filter(isUnconditionalEdge);

  if (guarded.length === 0) {
    return { chosenTargets: new Set(unconditional.map(e => e.to)) };
  }
  for (const e of guarded) {
    if (e.when(output)) {
      return { chosenTargets: new Set([...unconditional.map(u => u.to), e.to]) };
    }
  }
  // Validator guarantees defaultEdge exists.
  return { chosenTargets: new Set([...unconditional.map(u => u.to), defaultEdge!.to]) };
};
```

**Crash-on-throwing-guard:** if `e.when(output)` throws, surface a
`guard-threw` error for the upstream node. We do not retry guards.

### 3. `activeNodeIds` in context

`packages/framework/src/dag-runtime/types.ts`:

```ts
export interface DagMachineContext {
  readonly dag: DagDef;
  readonly waves: readonly (readonly string[])[];
  readonly outputs: ReadonlyMap<string, unknown>;
  readonly retries: ReadonlyMap<string, number>;
  readonly initialInput: unknown;
  /** Subset of all node ids that should still run. Seeded at compile; shrinks as branches decide. */
  readonly activeNodeIds: ReadonlySet<string>;
}
```

Initial seed in `compileDagToMachine` (`machine.ts:82-88`): every
node forward-reachable from wave 0 along **only unconditional**
edges. Conditional and default edges' targets get added on guard
fire. (Pre-expansion is faster per-wave than lazy expansion;
property test asserts equivalence.)

After each wave: `handleWaveDone` calls `decideRoute` for each
completed node and updates the active set:

```
newActive = activeNodeIds ∪ chosenTargets(currentWave)
                          ∪ forward-reachable(chosenTargets, active edges)
                          ∖ transitively-only-reachable-via-losing-edges
```

Helper in `conditional.ts`: `updateActiveSet(dag, prev, fromNodeId,
decision)`. Iterative fixed-point; bounded by node count.

### 4. `runWave` filters by `activeNodeIds`

`packages/framework/src/dag-runtime/executor.ts:354` — change
`waveNodeIds.map(...)` to filter by active set. Pruned nodes are NOT
written to outputs. Downstream `optionalDeps` see `undefined`;
downstream `deps` are themselves pruned (validator guarantees this).

### 5. `handleWaveDone` changes

`packages/framework/src/dag-runtime/transition-helpers.ts:86-128` —
after merging new outputs, iterate completed nodes; for each with
guarded out-edges, call `decideRoute` and `updateActiveSet`. New
context flows forward to next wave.

### 6. Validator changes

`packages/framework/src/executor/validate-dag.ts:46-69`:

1. **Optional-deps recognition.** Edges partition into
   "always-incoming" (unconditional + default) and
   "conditional-incoming" (guarded). Always-incoming must match
   `deps`; conditional-incoming must match `deps ∪ optionalDeps`. A
   `deps` entry whose only incoming edge is conditional is an error
   (`'X' declares dep 'D' but the only edge from 'D' is conditional — use optionalDeps`).
2. **Else-totality.** Every node with at least one `when` out-edge
   must have exactly one `kind: "default"` out-edge. Error
   `missing-default-edge`.
3. **Output reachability under guards.** `outputNodeId` (and the
   fallback last-node-of-last-wave) must be reachable along
   unconditional + default edges only — guards may bypass nodes,
   never the output. Error `output-unreachable-under-routing`.
4. **Edge uniqueness.** At most one `EdgeDef` per `(from, to)` pair
   across all variants. Error `duplicate-edge`.

### 7. Reroute interaction

`transition-helpers.ts:412-432` — when reroute backs up to a target
wave, recompute `activeNodeIds` from that wave: clear membership for
nodes in waves `≥ targetWave`, re-seed from the target wave, re-run
unconditional-forward expansion. Guard evaluation happens when waves
complete, not at reroute time.

### 8. Replay determinism

No envelope changes. Guards are pure; same `wave-done` event →
same routing decision → same active set. Property test asserts:

> For any DAG with conditional edges and any sequence of `DagEvent`s,
> `replayEvents` and live execution produce identical
> `(state, context.outputs, context.activeNodeIds)` triples.

### 9. Error kinds added

`packages/framework/src/types/errors.ts`:

```ts
| { readonly kind: "missing-default-edge"; readonly nodeId: string }
| { readonly kind: "output-unreachable-under-routing"; readonly outputNodeId: string; readonly missedFromNode: string }
| { readonly kind: "guard-threw"; readonly nodeId: string; readonly message: string }
| { readonly kind: "duplicate-edge"; readonly fromNodeId: string; readonly toNodeId: string }
```

### 10. Observer events

- `route-decided` — `{ runId, dagId, fromNodeId, chosenTargets, prunedTargets, timestamp }`
- `node-pruned` — `{ runId, dagId, nodeId, reason: "branch-not-taken", timestamp }` per pruned node

---

## Test plan

In `packages/framework/src/__tests__/`:

- `conditional-edges-routing.test.ts` — 2-way, 3-way, default fires,
  nested branches, branch-then-rejoin via `optionalDeps`.
- `conditional-edges-validator.test.ts` — missing-default,
  unreachable-output, optional-dep mismatches, duplicate-edge,
  deps-vs-optionalDeps partitioning.
- `conditional-edges-replay.test.ts` — property test: random DAG
  with random pure guards, assert replay equivalence.
- `conditional-edges-reroute.test.ts` — reroute back to before a
  branch; verify activeNodeIds resets and re-decides.
- `conditional-edges-guard-throws.test.ts` — guard throws → run
  fails with `guard-threw`.
- `conditional-edges-active-set-pre-expansion.test.ts` — property
  test: pre-expanded vs lazy `activeNodeIds` seed are equivalent.

---

## ADR 0015 — Conditional edges

- Context: gap analysis from the outcome-branching note + chatbot
  Phase 4 dependency. Loops are explicitly *not* covered here — they
  belong in the state-graph runtime.
- Decision: extend `EdgeDef` with `when` and `default` variants;
  exclusive routing; pure guards; no envelope changes; the DAG
  remains acyclic.
- Consequences: validator complexity (output-reachability check),
  `optionalDeps` introduced as new API surface, observer gains
  `route-decided` / `node-pruned`. Existing DAGs unaffected.

---

## Soundness audit

### Type safety

| Claim | How preserved |
| --- | --- |
| `EdgeDef` narrowing is exhaustive. | Centralised type-guard helpers; unit test forbids ad-hoc field-presence checks elsewhere. |
| Existing `{ from, to }` callers compile unchanged. | Unconditional variant keeps its exact shape; new variants add fields, never remove. |
| Node-input shape is sound under `optionalDeps`. | Single deterministic rule: `optionalDeps` non-empty ⇒ object input. Validator pairs with `inputSchema` discipline. |
| `FrameworkError` discriminated union stays sound. | Four new variants are additive; every match site uses `ts-pattern.match(…).exhaustive()`. |

### Topo-sort soundness

| Claim | How preserved |
| --- | --- |
| Topo sort remains a valid topological order. | Conditional edges are still forward edges (target in a later wave than source). They participate in topo sort exactly like unconditional edges. The graph remains acyclic; `cycle-detected` still fires for any forward cycle. |
| Wave plan is still computable in O(N + E). | No change to `topoSort`. |
| Wave indices used by reroute are consistent. | `waveIndexOf` reads `ctx.waves` — unchanged source of truth. |

### Validator completeness

| Existing invariant | Treatment |
| --- | --- |
| No empty DAG. | Unchanged. |
| No duplicate node IDs. | Unchanged. |
| `deps` ↔ incoming edges symmetry. | Generalised to `deps ∪ optionalDeps` ↔ incoming edges, partitioned by edge variant. |
| `outputNodeId` exists. | Unchanged. |
| `outputNodeId` reachable. | Strengthened to "reachable along unconditional + default edges only" — sufficient under exclusive routing. |
| (new) Else-totality. | Every node with guarded out-edges has exactly one default. |
| (new) Edge uniqueness. | One edge per `(from, to)` pair. |

### Replay determinism

| Claim | How preserved |
| --- | --- |
| Same event log → same final state, including `activeNodeIds`. | Guards are pure; `handleWaveDone` is pure; same `wave-done` event → same routing → same active set. Property-tested. |
| No silent divergence on impure guards. | Property tests use random pure guards — an impure guard would still pass them (false negative). Mitigation is documentation + the explicit non-goal. |

### Runtime invariants preserved

| Invariant | Status |
| --- | --- |
| One human review at a time (FR-028). | Unchanged. |
| Per-node retry budget (FR-026). | Unchanged. |
| Co-failed-sibling pre-increment. | Naturally correct under pruning — `runWave` filters by `activeNodeIds` before dispatching, so co-failures only span active nodes. |
| Aborted from any non-terminal state. | Unchanged. |
| `compileDagToMachine` fail-fast. | Unchanged — new validator checks slot into the existing `validateDagShape` pipeline. |

### What this plan does NOT achieve

- **Static guard exhaustiveness.** We require a `default` instead of
  proving guards cover the output domain.
- **Type-level checking that `optionalDeps` schema fields are optional.**
  Author discipline + runtime `validateInput`. Could be a follow-up
  via `inputSchema._def` inspection.
- **Replay catching impure guards.** Property tests use pure guards
  by construction.

---

## Risks

1. **Validator complexity.** Output reachability under guard
   assignments is bounded by requiring unconditional + default
   reachability. UX concession: no per-branch outputs. Documented.
2. **Pure-guard discipline.** Closures over external state break
   replay silently. Mitigated by docs + property tests; no runtime
   check.
3. **`optionalDeps` discoverability.** New API; authors will forget
   to use it. Validator catches the deps-vs-optionalDeps mismatch
   with a clear error.

---

## Open questions

1. `default` as `{ kind: "default" }` discriminator (recommended) vs
   sentinel `when: () => true` placed last? Lean discriminator.
2. Pre-expanded vs lazy `activeNodeIds` seed? Lean pre-expanded with
   property-test equivalence.
3. Guard evaluation order: declaration vs lexicographic by `to`?
   Lean declaration; document explicitly.
4. Expose `decideRoute` publicly? Yes, in a `/dag-runtime` sub-export
   (not from package root).
