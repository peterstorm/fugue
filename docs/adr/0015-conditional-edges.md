# ADR 0015: Conditional edges in the DAG runtime

**Status:** Accepted — `when` payload superseded by ADR 0016 (structural predicates)
**Date:** 2026-05-10
**Plan ref:** `docs/plans/2026-05-10-conditional-edges.md`
**Related:** ADR 0009 (runtime routing by node config), ADR 0007 (legacy fast path), **ADR 0016 (structural-match predicates)**.

> **Update (2026-05-10):** the `Guard = (output) => boolean` closure form
> described below was a discipline contract for purity, not a system
> guarantee. ADR 0016 replaces it with `Predicate<O>` — pure data, typed
> against the upstream output schema, serializable, hashable, and visible
> in observer events. The active-set runtime, else-totality, and
> `optionalDeps` rules below are unchanged; only the `when` payload type
> and the `guard-threw` error kind (renamed `predicate-malformed`) differ.

## Context

The DAG runtime was strictly acyclic with static, unconditional edges. Every successor of a node always ran. LLM-outcome routing (the dotslash chatbot's Phase 4 enrichment, e.g. "summarise / translate / skip") had two unappealing options:

1. **N-way `skipWhen` guards** — every branch pays a no-op pass through the framework on every execution.
2. **God-dispatcher node** — routing logic lives inside one node's `run`, losing per-branch observability and wave-level parallelism.

Both work; both are workarounds. We want first-class outcome routing as edge metadata so per-branch spans are framework-native, pruned branches incur zero per-node cost, and the graph topology itself describes the routing policy.

Loops are **out of scope**. Conditional edges are a runtime filter on a static plan — they prune unreachable subgraphs. They do not introduce cycles. Loops belong to a separate state-graph runtime.

## Decision

Extend `EdgeDef` to a discriminated union with three variants — unconditional, conditional (`when`), and default — kept compatible with the existing `{ from, to }` literal by field-presence. `NodeDef` gains `optionalDeps` for inputs that may be pruned.

```ts
export type Guard = (output: unknown) => boolean;
export type EdgeDef =
  | { from: string; to: string }
  | { from: string; to: string; when: Guard }
  | { from: string; to: string; kind: "default" };
```

Routing model: **exclusive, first-match-wins**. When a node with guarded out-edges produces output, guards fire in declaration order; the first `true` selects that branch; the `default` edge fires only if no guard matched. The validator requires every node with guarded out-edges to have exactly one default edge (else-totality).

Active-set runtime: `DagMachineContext.activeNodeIds` is seeded at compile time to every node forward-reachable from a wave-0 entry along unconditional edges. After each wave, `handleWaveDone` evaluates guards for completed nodes and expands the active set along the chosen branch (transitively, through unconditional descendants). `runWave` filters to the active subset before dispatching, so pruned nodes never run, never appear in `outputs`, and never emit spans.

Replay determinism is preserved by requiring **pure guards**: same `wave-done` event → same routing decision → same active set. No envelope changes; the event log is unchanged.

`optionalDeps` on a node signals "this input may be undefined at runtime because its source branch was pruned". Whenever `optionalDeps` is non-empty, `nodeInput` is always an object keyed by `deps ∪ optionalDeps`. The validator partitions incoming edges into always-incoming (unconditional + default) and conditional-incoming (guarded); a `deps` entry whose only incoming edge is conditional is rejected with the message "use optionalDeps".

A throwing guard surfaces a new `guard-threw` framework error for the upstream node and fails the run; guards are not retried.

Two new observer events — `route-decided` and `node-pruned` — make per-branch routing visible without changing the DAG event log.

## Consequences

**Positive:**

- Pruned branches incur **zero** per-node cost: no validation, no node-start/end span, no cache lookup, no observer node events.
- The graph topology describes the routing policy — readable, statically inspectable, fingerprinted.
- Replay determinism preserved without envelope changes.
- Existing DAGs without conditional edges remain bit-for-bit unchanged. New variants are opt-in by edge shape; no migration flags.

**Negative:**

- Validator complexity: output reachability under guard assignments is bounded by requiring unconditional + default reachability — guards may bypass nodes, never the explicit `outputNodeId`. UX concession: per-branch outputs require an explicit rejoin.
- Pure-guard discipline is enforced by docs + property tests, not by runtime checks. A closure over external state breaks replay silently.
- `optionalDeps` is new API surface authors will forget. The validator catches the mismatch with a clear error.
- Any DAG with conditional or default edges routes through the state-machine path (the legacy fast path doesn't support active-set filtering).

## Alternatives considered

1. **`default` as sentinel `when: () => true` placed last.** Rejected: makes the validator's else-totality check stringly-typed and obscures intent. Discriminator variant is more explicit.
2. **Lazy `activeNodeIds` (compute on demand).** Rejected in favour of pre-expanded seed + per-wave updates. The pre-expanded version is faster per-wave; equivalence is property-tested.
3. **Multi-fan-out guarded edges (fire all matching guards).** Rejected — that's `skipWhen` again. Routing is exclusive by design.
4. **Side-effecting guards.** Rejected. Side effects break replay and would force a `branch_taken` field in the event envelope.
5. **Guarded multi-output (per-branch terminals).** Rejected. `outputNodeId` is reachable along unconditional + default edges only. If you want a branch to reach its own terminal, rejoin first.

## Test coverage

- `conditional-edges-routing.test.ts` — 2-way, 3-way, default fires, branch-then-rejoin via `optionalDeps`, throwing guard.
- `conditional-edges-validator.test.ts` — missing-default, unreachable-output, optional-dep mismatches, duplicate-edge, deps-vs-optionalDeps partitioning.
- `conditional-edges-replay.test.ts` — replay equivalence: live `(state, outputs, activeNodeIds)` matches `replayEvents` over the recorded log.
- `conditional-edges-reroute.test.ts` — reroute back to before a routing node; verifies the active set re-decides on the next pass.

## Implementation notes

- `decideRoute` (in `dag-runtime/conditional.ts`) is called twice per routing node per wave: once in `runWave` for observer emission, once in `handleWaveDone` for active-set update. Both calls are deterministic — guards are pure — and the duplication keeps the transition layer free of observer I/O.
- Reroute clears outputs/retries for nodes in waves ≥ target wave and re-seeds `activeNodeIds` from the surviving outputs. Earlier guard decisions are deterministic over the same outputs and converge to the pre-reroute active set up through `targetWave - 1`.
- The fallback output (when `outputNodeId` is unset) walks back through waves picking the last active node with a recorded output, so a fully-pruned final wave doesn't strand the run.
