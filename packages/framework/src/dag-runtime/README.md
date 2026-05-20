# dag-runtime/ — DAG state machine layer

This directory contains both the **functional core** (pure transition logic)
and the **imperative shell** (I/O, side effects). The boundary is enforced
by `scripts/check-imports.ts` — core modules cannot import OTel or perform I/O.

## Functional Core (pure, no I/O)

| File | Responsibility |
|------|---------------|
| `types.ts` | DagPhase, DagEvent, DagMachineContext, HumanAction |
| `transition.ts` | Pure state transition: `(phase, event, ctx) → (phase, ctx)` |
| `wave-resolution.ts` | Wave advancement, human-review queue collection |
| `retry-policy.ts` | Retry budget checks, backoff computation |
| `human-resolution.ts` | Approve/reject/reroute resolution (pure) |
| `routing.ts` | Predicate evaluation, route decision logic |
| `conditional.ts` | `evaluatePredicate` — confidence gating + error isolation |
| `topology.ts` | Active-set computation, outgoing-edge helpers |
| `machine.ts` | `compileDagToMachine` — DagDef → Machine<S,E,C> |

## Imperative Shell (I/O, side effects)

| File | Responsibility |
|------|---------------|
| `executor.ts` | `buildDagExecutor` — wave dispatch, human hooks, sleep/jitter |
| `wave-execution.ts` | `executeWave` — parallel node dispatch, freshness, routing |
| `run-dag-stateful.ts` | `runDagStateful` — orchestrates compilation → kernel → terminal |
| `run-node.ts` | Individual node execution with retry, checkpoint, spans |
| `run-telemetry.ts` | Root span lifecycle, run-start/run-end observer events |
| `node-span.ts` | Per-node OTel span management |
| `emit.ts` | Observer event dispatch helpers |
| `freshness-emission.ts` | Post-wave freshness witness emission |
| `freshness-check.ts` | `InMemoryFreshnessIndex` + conflict detection |
| `human-emission.ts` | `HumanInterventionEvent` emission |
| `route-emission.ts` | `RouteDecidedEvent` emission |
| `reroute.ts` | Active-set recomputation for reroute actions |
| `eval-judges.ts` | Post-run eval-judge finalization |
| `persistence.ts` | `wrapDagJobLike` — fingerprint verification on resume |
