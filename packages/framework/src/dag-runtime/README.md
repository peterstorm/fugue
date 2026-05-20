# dag-runtime/ — Module Decomposition

The DAG runtime is the state-machine–driven execution engine for directed
acyclic graphs. It compiles a `DagDef` into a `Machine`, pairs it with an
`Executor`, and drives the loop via `runStateMachine`.

## Core Loop

| File | Responsibility | I/O? |
|------|---------------|------|
| `machine.ts` | Compile `DagDef` → `Machine` (topology, retry config) | Pure |
| `transition.ts` | `dagTransition(phase, event, ctx)` — pure state transition | Pure |
| `executor.ts` | Imperative executor: sleep, hooks, wave dispatch | Shell |
| `run-dag-stateful.ts` | Orchestrator: compose kernel + executor + telemetry | Shell |

## Wave Execution

| File | Responsibility | I/O? |
|------|---------------|------|
| `wave-execution.ts` | Dispatch all nodes in a wave concurrently | Shell |
| `run-node.ts` | Single node lifecycle: validate → run → checkpoint | Shell |

## Routing & Conditional Logic

| File | Responsibility | I/O? |
|------|---------------|------|
| `routing.ts` | Predicate evaluation, `decideRoute()` | Pure |
| `conditional.ts` | Re-exports `evaluatePredicate` from routing.ts | Pure |
| `route-emission.ts` | Emit `route-decided` / `node-pruned` observer events | Shell |
| `reroute.ts` | Human-reroute enrichment, active-set reseeding | Pure |
| `topology.ts` | Static graph analysis: adjacency, incoming sources | Pure |

## Freshness

| File | Responsibility | I/O? |
|------|---------------|------|
| `freshness-check.ts` | `InMemoryFreshnessIndex`, conflict detection algorithm | Pure |
| `freshness-emission.ts` | Emit witness/write events per wave; invoke index | Shell |

## Human-in-the-Loop

| File | Responsibility | I/O? |
|------|---------------|------|
| `human-emission.ts` | Emit `HumanInterventionEvent` telemetry | Shell |
| `human-resolution.ts` | Transition helper for human responses (approve/reject/reroute) | Pure |

## Retry & Resolution

| File | Responsibility | I/O? |
|------|---------------|------|
| `retry-policy.ts` | Retry budget, backoff computation, hook-crash handling | Pure |
| `wave-resolution.ts` | Post-wave: advance to next wave / human-gate / succeeded | Pure |

## Eval Judges

| File | Responsibility | I/O? |
|------|---------------|------|
| `eval-judges.ts` | Post-run quality gates (background or inline) | Shell |

## Telemetry

| File | Responsibility | I/O? |
|------|---------------|------|
| `run-telemetry.ts` | OTel root span, run-start/run-end events | Shell |
| `node-span.ts` | Per-node OTel spans, outcome accumulation | Shell |
| `emit.ts` | Thin wrapper: `ctx.observer` → `dispatchEvent` | Shell |

## Infrastructure

| File | Responsibility | I/O? |
|------|---------------|------|
| `persistence.ts` | `wrapDagJobLike` — live ↔ persisted context bridge | Shell |
| `types.ts` | `DagPhase`, `DagEvent`, `DagMachineContext` unions | Types |
| `index.ts` | Internal barrel (not the public surface) | Barrel |

## Layering Rules

- **Pure modules** (transition, routing, retry-policy, wave-resolution, topology,
  human-resolution, reroute) import ONLY from `../types/` and `../shared/`.
- **Shell modules** (executor, wave-execution, run-node, run-dag-stateful,
  freshness-emission, eval-judges) may import from pure modules and infra.
- **No module in this directory** may import from `../executor/` (enforced by
  `boundary-imports.test.ts`). The `executor/` package is the _public_ entry
  point; `dag-runtime/` is the _internal_ engine.
