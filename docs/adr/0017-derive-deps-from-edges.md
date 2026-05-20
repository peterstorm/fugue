# ADR 0017: Derive per-node input wiring from edges

**Status:** Accepted
**Date:** 2026-05-10
**Plan ref:** `docs/plans/2026-05-10-derive-deps-from-edges.md`
**Related:** ADR 0015 (conditional edges), ADR 0016 (structural predicates).

## Context

`NodeDef` carried two topology-mirroring fields, `deps: readonly string[]` and `optionalDeps?: readonly string[]`. The DAG carried `edges: EdgeDef[]`. Both views had to agree; the validator caught drift at module load.

The duplication produced three concrete pains:

1. **`deps` typos.** `deps: ["fech"]` is a `string[]` — the type system can't tell the literal `"fech"` from a known node id. Edit-time cross-typing would have required a builder DSL (forced topo order) or a closure-scoped DSL (full API redesign); see `docs/dag-type-system.md` §6.1.
2. **`optionalDeps` mechanical rule.** Authors had to partition incoming sources by edge variant (conditional incoming → optionalDep; unconditional/default → dep) and keep the partition in sync with edge edits. The validator caught mistakes, but the rule was mechanical and authors kept forgetting it.
3. **Node anti-reusability.** `deps: ["fetch"]` anchored a node to a specific upstream id. Reusing a node across DAGs whose upstream had a different name required renaming or wrapping; in practice, nobody did.

Edges already express the topology. The `deps`/`optionalDeps` fields are read-only mirrors that the framework needs at runtime to build node input. The framework can compute that mirror from edges instead of asking the author to maintain it.

## Decision

Remove `deps` and `optionalDeps` from `NodeDef`. Edges become the single topological source of truth. The framework derives per-node input wiring at compile time via `incomingSources(dag, nodeId)`:

```ts
interface IncomingSources {
  readonly required: readonly string[];  // unconditional edge AND source is always-active
  readonly optional: readonly string[];  // conditional/default edge, OR source may be pruned
}
```

"Always-active" means the source is in `seedInitialActiveSet(dag)` — reachable from a wave-0 entry along unconditional edges only. The same input-shape rule applies as before (0 → DAG input; 1 required, 0 optional → bare; ≥2 required or any optional → object keyed by `required ∪ optional`).

Per-node `IncomingSources` is precomputed once per `compileDagToMachine` (and once per `runDagInner` for the legacy fast path) and stashed on `DagMachineContext.incomingByNode` so wave dispatch is O(1) per node.

Validator surface shrinks accordingly: deps↔edges symmetry checks are gone (nothing to check), as is the "deps wired only by conditional → use optionalDeps" error. The validator keeps the edge-only rules: endpoint references, uniqueness, else-totality, predicate shape, output reachability, and record-key consistency.

Fingerprint drops `deps` from the hashed payload (redundant with edges). `FRAMEWORK_VERSION` bumps to `"2"` so old checkpoints — written when reconstructed `NodeDef`s carried `deps` fields that no longer exist — are rejected on resume.

Every node-creator helper (`createTransformNode`, `createFetchNode`, `createLlmNode`, `createGuardrailNode`, `createLlmWithToolsNode`) drops the `deps` config arg.

## Consequences

**Wins**

- **Zero `deps` typos possible.** No field to typo.
- **Mechanical-classification mistake removed.** No `optionalDeps` partition for the author to keep in sync.
- **Nodes become genuinely reusable.** Their contract is `I → O`, not "wired to specific upstream ids" — the same `synthesize` node can be dropped into any DAG whose edges feed it the expected input.
- **Validator surface shrinks** by ~80 lines (one whole rule class gone).
- **Edges are the only topology authoring surface.** One place to look when reasoning about wiring; one place to edit when refactoring.

**Costs**

- **One-time migration.** Every node helper invocation in the codebase drops its `deps` arg. Most are caught by type-system extra-property errors after the helper-config rewrite; raw `NodeDef` literals in tests need manual edits.
- **Author-signal loss.** The inline `deps: [...]` field doubled as documentation ("this node consumes these upstreams") right next to the node. Without it, readers trace edges to understand wiring — usually via IDE "find references" or by reading the DAG's edges array.
- **`FRAMEWORK_VERSION` bump.** Existing checkpoints become un-resumable. Coordinated rollout: ship, drain in-flight workflows, then remove old code path. No production user has checkpoints at risk yet (no prod consumer of this framework).
- **`O(N²)` reads with `dag.edges.filter(...)`.** Iterating edges per-node at compile time is N² over edges; mitigated by computing `incomingByNode` once per compile via a single edge scan. Negligible at realistic DAG sizes.

**Out of scope**

- **Deriving `inputSchema` from upstream output schemas.** Authors still write `inputSchema` explicitly. Auto-derivation costs flexibility (custom merge shapes, projection, optional-fields nuance) and we don't need it. Revisit if it becomes a pain.
- **Simplifying the runtime input-shape rules to "always object."** The 0/1/many heuristic stays — it's convenient and changing it is a much larger blast radius than this refactor warrants.
