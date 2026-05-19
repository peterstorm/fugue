# ADR-0029: Mandatory Routing Decisions on wave-done Events

## Status

Accepted

## Context

The `wave-done` DagEvent previously carried `routingDecisions` as an optional field.
When absent, the pure transition layer fell back to calling `decideRoute` inline —
which evaluates predicate functions (closures). This made the transition layer
impure on the fallback path and required `outgoingByNode` (containing predicate
closures) to live on an intermediate `DagTransitionContext` type between the
serializable `DagMachineContextPersisted` and the full `DagMachineContext`.

The three-layer context hierarchy (`Persisted → TransitionContext → MachineContext`)
added cognitive overhead for every developer reading the transition code, without
providing proportional safety — the single extra field (`outgoingByNode`) was only
needed because the transition might evaluate predicates on the fallback path.

Similarly, the `handleReroute` path in `human-resolution.ts` re-evaluated predicates
for prior waves to reconstruct the active-node set after a backward reroute.

## Decision

1. **`routingDecisions` is now mandatory on `wave-done` events.** The executor always
   computes routing decisions before emitting `wave-done`. The transition layer reads
   precomputed decisions — it never calls `decideRoute` itself.

2. **Reroute active-set computation moves to the executor.** The `human-responded`
   event carries a precomputed `rerouteActiveSet` for reroute actions, computed by
   the executor which has access to the live DAG (with predicate closures).

3. **`DagTransitionContext` is eliminated.** The transition function operates directly
   on `DagMachineContextPersisted`. A new `unconditionalAdj` field (closure-free,
   serializable) provides the forward-reachability information that `expandActive`
   needs without carrying predicate closures.

4. **The type hierarchy collapses to two layers:**
   - `DagMachineContextPersisted` — serializable plain data (transition layer)
   - `DagMachineContext extends DagMachineContextPersisted` — adds live closures (executor)

## Consequences

- The pure transition layer is genuinely pure — no closure invocations, no predicate
  evaluation, no dependency on the live DAG.
- One fewer type for developers to learn and thread through function boundaries.
- Event-log replay of historical events from before this change (which lacked
  `routingDecisions`) is no longer supported by the transition layer directly.
  Since this is a greenfield project with no production event logs, this is acceptable.
- `expandActive` now takes `unconditionalAdj: ReadonlyMap<NodeId, readonly NodeId[]>`
  (closure-free) instead of the full `outgoingByNode` (which carries predicates).
- The executor is responsible for all predicate evaluation — it's the only module
  that imports `decideRoute` for routing purposes.
