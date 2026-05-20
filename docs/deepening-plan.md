# Deepening Plan — DAG Runtime Architecture

**Date:** 2026-05-19  
**Branch:** feat/initial-setup  
**Scope:** `packages/framework/src/dag-runtime/` and surrounding modules  
**Type:** Pure refactors — zero behavioral change, all tests must pass green at every step

---

## Motivation

The DAG runtime layer has grown through feature accretion (conditional edges, freshness witnesses, human-review gates, confidence routing, eval judges). Each feature was well-designed in isolation, but the cumulative effect has created:

- **Wide internal interfaces** — functions with 7–10 positional parameters
- **Duplicated logic** — human-review handling copied across executor match arms
- **Mixed concerns** — topology algorithms and routing business logic in one 448-line file
- **Monotonically growing context** — 13 fields on `DagMachineContextPersisted`, each added per-feature
- **God orchestrator** — `runDagStateful` at 349 lines mixing 6 distinct responsibilities

These are depth/locality problems, not correctness problems. The framework works. This plan concentrates change, narrows internal interfaces, and makes each module earn its keep through leverage rather than surface area.

---

## Vocabulary

| Term | Meaning |
|------|---------|
| **Module** | Anything with an interface and an implementation (file, function, type) |
| **Depth** | Leverage at the interface — rich behaviour behind a small surface |
| **Seam** | Where an interface lives; a place behaviour can be altered without editing in place |
| **Locality** | Change, bugs, knowledge concentrate in one place |
| **Deletion test** | Imagine deleting the module. If complexity reappears across N callers, it was earning its keep |

---

## Dependency Graph

```
Step 1: conditional.ts split (topology + routing)
   │
   │  clarifies topology vs routing boundary
   ▼
Step 2: executor human-gate extraction  ←── independent, can parallel with Step 1
   │
   ▼
Step 3: wave pipeline encapsulation
   │   routing module now separate, emission internals clear
   ▼
Step 4: runDagStateful decomposition
   │
   ▼
Step 5: context interface narrowing (widest blast radius, benefits from all prior clarity)
```

---

## Step 1: Split `conditional.ts` → `topology.ts` + `routing.ts`

**Risk:** Low  
**Blast radius:** Import path updates across ~8 files  
**Estimated effort:** 30 min

### Problem

`dag-runtime/conditional.ts` (448 lines) serves two distinct audiences at different rates of change:

- **Topology helpers** — static graph analysis, called once at compile time, consumed by the transition layer and `machine.ts`.
- **Routing decision logic** — business-rule evaluation with confidence gating, called every wave, consumed by `route-emission.ts` and `reroute.ts`.

Understanding "how the DAG routes" requires parsing 448 lines that are 50% topology plumbing. The module's 10 exported symbols are never co-consumed by a single caller.

### Actions

1. **Create `dag-runtime/topology.ts`** — move:
   - `buildOutgoing`, `buildIncoming` (private helpers)
   - `seedInitialActiveSet` (both overloads)
   - `expandActive`
   - `outgoingOf`
   - `computeOutgoingByNode`
   - `computeUnconditionalAdj`
   - `computeIncomingByNode`
   - `incomingSources`, `incomingSourcesFor` (private)
   - Type re-export: `IncomingSources` (from `../shared/incoming.js`)

2. **Create `dag-runtime/routing.ts`** — move:
   - `evaluatePredicate`
   - `decideRoute`
   - Type: `Decision`
   - Imports `EdgeDef`, `Predicate`, `isConditionalEdge`, etc. from `../types/dag.js`
   - Imports `Confidence`, `meetsConfidence` from `../types/confidence.js`
   - Imports `RouteEvidence` from `../types/events.js`

3. **Delete `conditional.ts`**.

4. **Update imports:**

   | File | Was importing from | Now imports from |
   |------|--------------------|------------------|
   | `wave-resolution.ts` | `./conditional.js` | `./topology.js` |
   | `route-emission.ts` | `./conditional.js` | `./routing.js` |
   | `machine.ts` | `./conditional.js` | `./topology.js` |
   | `reroute.ts` | `./conditional.js` | `./routing.js` + `./topology.js` |
   | `run-dag-stateful.ts` | (no direct import) | unchanged |
   | `executor.ts` | `./conditional.js` | `./routing.js` (for `Decision` type only) |
   | `dag-runtime/index.ts` | `./conditional.js` | `./topology.js` + `./routing.js` |

5. **Update barrel** (`dag-runtime/index.ts`):
   ```ts
   export { decideRoute, evaluatePredicate, type Decision } from "./routing.js";
   export { expandActive, outgoingOf, seedInitialActiveSet, topoSort } from "./topology.js";
   export type { IncomingSources } from "./topology.js";
   ```

### Test checkpoint

- `bun test` passes with zero functional changes
- `boundary-imports.test.ts` still passes
- `conditional-edges-*.test.ts` tests unchanged
- `evaluate-predicate-property.test.ts` unchanged

### Benefits

- **Locality** — routing logic changes stay in `routing.ts`; topology algorithm changes stay in `topology.ts`
- **Testability** — routing tests don't pull in topology fixtures and vice versa
- **Leverage** — `decideRoute` is the clear entry point for "what route fires" without 250 lines of graph traversal diluting the reader's model

---

## Step 2: Extract `handleHumanGate` in `executor.ts`

**Risk:** Low  
**Blast radius:** `executor.ts` only  
**Estimated effort:** 20 min

### Problem

The executor's `awaiting-human` and `retrying-hook` match arms duplicate significant logic:
- Both call `callHumanReviewHook`
- Both call `enrichHumanRespondedEvent`
- Both conditionally call `emitHumanIntervention`
- `retrying-hook` additionally sleeps with jitter + checks signal abort

A bug in human-review emission must be fixed in two places. The `retrying` and `retrying-hook` branches also share the same sleep→signal-check→early-return pattern.

### Actions

1. **Extract `handleHumanGate`:**
   ```ts
   interface HumanGateInput {
     readonly phaseKind: "awaiting-human" | "retrying-hook";
     readonly nodeId: NodeId;
     readonly output: unknown;
     readonly prompt: string;
     readonly pendingReviews: readonly NodeId[];
     readonly wave: number;
     /** Present only for retrying-hook — triggers sleep before hook call. */
     readonly delayMs?: number;
   }

   /**
    * Unified human-gate handler. Owns the full lifecycle:
    * 1. Optional sleep with jitter (retrying-hook only)
    * 2. Signal abort check
    * 3. Call onHumanReview hook
    * 4. Enrich the responded event with reroute active-set
    * 5. Emit HumanInterventionEvent telemetry
    * 6. Return the DagEvent for the state machine
    */
   const handleHumanGate = async (
     input: HumanGateInput,
     deps: { hooks, nodeMap, nodeCtx, dagId, nowFn, random, capturedWitnesses, machineCtx },
   ): Promise<DagEvent>
   ```

2. **Both match arms become one-liners:**
   ```ts
   .with({ kind: "awaiting-human" }, (p) =>
     handleHumanGate({ phaseKind: "awaiting-human", ...p }, deps))
   .with({ kind: "retrying-hook" }, (p) =>
     handleHumanGate({ phaseKind: "retrying-hook", delayMs: p.nextDelayMs, ...p }, deps))
   ```

3. **Extract `sleepWithAbortCheck`** (shared by `retrying` and `retrying-hook`):
   ```ts
   /** Sleep with jitter; returns abort event if signal fires, null to proceed. */
   const sleepWithAbortCheck = async (
     delayMs: number, nodeId: NodeId, nodeMap, random, signal
   ): Promise<DagEvent | null>
   ```

### Test checkpoint

- All `human-*` tests pass (emission, resolution, intervention-diff, intervention-event)
- `dag-runtime-stateful.test.ts` observer event sequences identical
- `observer-property.test.ts` passes

### Benefits

- **Locality** — human-gate behaviour changes in one function, not two match arms + a helper
- **Testability** — `handleHumanGate` can be tested at its internal seam without running the full executor match
- **Leverage** — executor match arms now communicate "what phase am I in" without burying "how to handle it" inline

---

## Step 3: Encapsulate wave pipeline internals

**Risk:** Medium  
**Blast radius:** `wave-execution.ts`, `freshness-emission.ts`, `route-emission.ts`, `dag-runtime/index.ts`  
**Estimated effort:** 40 min

### Problem

`emitFreshnessWitnessEvents` takes **10 parameters**. `emitRoutingDecisions` takes **7 parameters**. Both are "extracted from executor.ts for readability" — shaped by file extraction, not interface design. They're deep (complex logic, pass the deletion test) but their interfaces are wide. Callers must know everything to invoke them.

### Actions

1. **Define `WaveContext`** in `wave-execution.ts`:
   ```ts
   /** All state a wave's post-dispatch pipeline needs. Constructed once per wave invocation. */
   interface WaveContext {
     readonly dag: DagDef;
     readonly dagId: DagId;
     readonly nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>;
     readonly nodeCtx: ValidatedNodeContext;
     readonly machineCtx: DagMachineContext;
     readonly waveNodeIds: readonly NodeId[];
     readonly priorOutputs: ReadonlyMap<NodeId, unknown>;
     readonly freshnessIndex: FreshnessIndex;
     readonly witnessAccumulator?: Map<string, Witness>;
     readonly resumeCheckpoint?: Map<string, unknown>;
     readonly nowFn: () => number;
     readonly stamp: () => Date;
   }
   ```

2. **Refactor `emitFreshnessWitnessEvents` signature:**
   ```ts
   // Before: 10 positional params
   emitFreshnessWitnessEvents(waveNodeIds, newOutputs, nodeMap, machineCtx, nodeCtx, dagId, nowFn, freshnessIndex, skippedNodeIds, witnessAccumulator)

   // After: focused interface
   emitFreshnessWitnessEvents(waveCtx: WaveContext, newOutputs: ReadonlyMap<NodeId, unknown>, skippedNodeIds: ReadonlySet<NodeId>)
   ```

3. **Refactor `emitRoutingDecisions` signature:**
   ```ts
   // Before: 7 positional params
   emitRoutingDecisions(waveNodeIds, newOutputs, nodeMap, machineCtx, nodeCtx, dagId, nowFn)

   // After: focused interface
   emitRoutingDecisions(waveCtx: WaveContext, newOutputs: ReadonlyMap<NodeId, unknown>)
   ```

4. **Remove from barrel:** `emitFreshnessWitnessEvents` and `emitRoutingDecisions` are not currently exported from `dag-runtime/index.ts` — verify this stays true. They're module-internal (reachable via direct path for tests).

5. **Construct `WaveContext`** at the top of `executeWave` and thread through.

6. **Simplify `WaveConfig`** — it now only carries the per-executor-lifetime fields (the subset that doesn't change per wave):
   ```ts
   export interface WaveConfig {
     readonly dag: DagDef;
     readonly nodeMap: Map<NodeId, NodeDef<unknown, unknown>>;
     readonly nodeCtx: ValidatedNodeContext;
     readonly resumeCheckpoint?: Map<string, unknown>;
     readonly nowFn: () => number;
     readonly freshnessIndex: FreshnessIndex;
     readonly witnessAccumulator?: Map<string, Witness>;
   }
   ```
   (This is unchanged — the `WaveContext` wraps it with per-invocation state.)

### Test checkpoint

- All `freshness-*`, `route-*`, `wave-*`, `dag-*` tests pass
- Tests that import directly from emission files still compile (direct path import unchanged)
- No observer event sequence changes

### Benefits

- **Interface narrowing** — callers deal with 1 config object, not 7–10 positional args
- **Encapsulation** — emission modules are implementation details behind `executeWave`'s clean interface
- **Locality** — changes to freshness or routing parameters don't ripple into `executeWave`'s call sites

---

## Step 4: Decompose `runDagStateful` into pipeline steps

**Risk:** Medium  
**Blast radius:** `run-dag-stateful.ts`, potentially `executor/run-dag.ts`  
**Estimated effort:** 45 min

### Problem

`runDagStateful` is 349 lines handling 6 distinct sequential responsibilities:
1. Retry-limit merging + telemetry start
2. Capability validation
3. Span creation
4. DAG compilation (topo sort, initial context)
5. Job resolution (supplied vs. in-memory, fingerprint verification)
6. State-machine kernel invocation + terminal state handling (success→judges, failure→error)

Each contributes 40–60 lines; none is individually complex, but together they obscure the pipeline shape. Understanding "what happens on a failed compilation?" requires reading past job-resolution code. `emitRunEnd` and `rootSpan` are threaded via closures, creating implicit ownership contracts.

### Actions

1. **Extract `prepareDagRun`:**
   ```ts
   interface PreparedRun {
     readonly effectiveDag: DagDef;
     readonly validatedCtx: ValidatedNodeContext;
     readonly emitRunEnd: (status: "ok" | "error") => void;
   }

   /** Pre-flight: merge retry limits, emit run-start, validate capabilities. */
   const prepareDagRun = (
     dag: DagDef,
     nodeCtx: NodeContext,
     opts?: Pick<DagRunOpts, 'retryLimits' | 'now'>,
   ): Result<PreparedRun, FrameworkError>
   ```

2. **Extract `resolveJob`:**
   ```ts
   /** Resolve the durable job handle — caller-supplied or fresh in-memory. */
   const resolveJob = (
     compiled: CompiledDagMachine,
     effectiveDag: DagDef,
     nodeCtx: NodeContext,
     opts?: Pick<DagRunOpts, 'jobLike'>,
   ): Result<JobLike<DagPhase, unknown, DagMachineContext>, FrameworkError>
   ```

3. **Extract `handleTerminalState`:**
   ```ts
   /** Pattern-match on terminal state: success→judges, failure→error, unexpected→invariant violation. */
   const handleTerminalState = <O>(
     state: DagPhase,
     context: DagMachineContext,
     deps: { rootSpan, dag, input, nodeCtx, meta, emitRunEnd, opts },
   ): Promise<Result<O, FrameworkError>>
   ```

4. **`runDagStateful` becomes a ~50-line pipeline:**
   ```ts
   export const runDagStateful = async <I, O>(dag, input, nodeCtx, opts?) => {
     // 1. Pre-flight
     const prepared = prepareDagRun(dag, nodeCtx, opts);
     if (!prepared.ok) return prepared;
     const { effectiveDag, validatedCtx, emitRunEnd } = prepared.value;

     // 2. Span + compile + resolve + execute
     return startRunSpan(dag, nodeCtx, async (rootSpan) => {
       const compiled = compileDagToMachine(effectiveDag, input);
       if (!compiled.ok) { /* close span, emit error */ return err(...); }

       const job = resolveJob(compiled.value, effectiveDag, nodeCtx, opts);
       if (!job.ok) { /* close span, emit error */ return err(...); }

       // 3. Build executor, run kernel
       let meta = createDagRunMeta();
       const executor = buildDagExecutor(effectiveDag, validatedCtx, { ... });
       const { state, context } = await runStateMachine(job.value, ...);

       // 4. Handle terminal
       return handleTerminalState<O>(state, context, { rootSpan, ... });
     });
   };
   ```

5. **Keep `runDagAsWorkerJob` unchanged** — it's already a thin wrapper.

### Test checkpoint

- All `run-dag-*`, `runner-*`, `dag-*` tests pass
- `onTrace` event sequence unchanged
- `run-telemetry-ordering.test.ts` passes
- Background judge tests pass

### Benefits

- **Locality** — "what can fail during preparation" is separate from "what can fail during execution"
- **Leverage** — inner execution logic is reusable for direct kernel testing without re-running validation/compilation
- **Readability** — the orchestrator's 50-line pipeline communicates the lifecycle at a glance

---

## Step 5: Narrow `DagMachineContextPersisted` with typed slices

**Risk:** High  
**Blast radius:** `types.ts`, `machine.ts`, `transition.ts`, `wave-resolution.ts`, `retry-policy.ts`, `human-resolution.ts`, `persistence.ts`, all context-constructing tests  
**Estimated effort:** 90 min

### Problem

`DagMachineContextPersisted` has 13 fields. Every new feature adds a field. The interface is the most-crossed seam in the framework — `machine.ts` writes it, transition helpers read it, `persistence.ts` serializes it. Its width means:

- Adding a feature touches 4+ files (compile, types, serialize, consumer)
- Test fixtures construct 13-field objects for every transition test
- The context conflates topology, retry state, routing state, and human-gate config — all read by different consumers

### Actions

1. **Define focused slice types** in `dag-runtime/types.ts`:
   ```ts
   /** Topology facts computed once at compile time. Immutable after construction. */
   export interface DagTopology {
     readonly waves: readonly (readonly NodeId[])[];
     readonly edges: readonly EdgeDef[];
     readonly unconditionalAdj: ReadonlyMap<NodeId, readonly NodeId[]>;
     readonly outputNodeId: NodeId | undefined;
   }

   /** Per-node retry configuration and accumulated attempt state. */
   export interface DagRetryState {
     readonly retries: ReadonlyMap<NodeId, number>;
     readonly retryConfigs: ReadonlyMap<NodeId, {
       readonly backoffMs: readonly number[];
       readonly jitterRatio: number;
     }>;
     readonly defaultRetryLimit: number | undefined;
     readonly retryLimits: Readonly<Record<string, number>> | undefined;
   }

   /** Human-review gate configuration (plain data, no closures). */
   export interface DagHumanGateConfig {
     readonly humanReviewNodeIds: ReadonlySet<NodeId>;
     readonly humanReviewPrompts: ReadonlyMap<NodeId, string>;
   }

   /** Routing/active-set state that evolves per wave. */
   export interface DagRoutingState {
     readonly activeNodeIds: ReadonlySet<NodeId>;
     readonly confidenceByNode: ReadonlyMap<NodeId, Confidence | null>;
   }
   ```

2. **Redefine `DagMachineContextPersisted` as intersection:**
   ```ts
   export interface DagMachineContextPersisted extends
     DagTopology, DagRetryState, DagHumanGateConfig, DagRoutingState {
     readonly outputs: ReadonlyMap<NodeId, unknown>;
     readonly initialInput: unknown;
   }
   ```
   
   > **Critical:** This is structurally identical to the current definition. All existing code that reads `ctx.waves`, `ctx.retries`, etc. compiles without changes. The benefit is downstream: transition helpers can declare narrow parameter types.

3. **Narrow transition helper signatures** (gradual — can be done incrementally):
   ```ts
   // retry-policy.ts
   export const handleNodeFailed = (
     wave: number,
     nodeId: NodeId,
     error: FrameworkError,
     retry: DagRetryState,       // was: full DagMachineContextPersisted
     topology: DagTopology,       // for wave lookup
     partialOutputs?: ...,
     coFailedNodeIds?: ...,
   ): { state: DagPhase; contextDelta: Partial<DagRetryState & { outputs: ... }> }

   // wave-resolution.ts
   export const handleWaveDone = (
     wave: number,
     outputs: ReadonlyMap<NodeId, unknown>,
     topology: DagTopology,
     routing: DagRoutingState,
     humanGate: DagHumanGateConfig,
     routingDecisions: ReadonlyMap<NodeId, Decision>,
   ): { state: DagPhase; context: DagMachineContextPersisted }

   // human-resolution.ts
   export const handleHumanResponse = (
     phase: Extract<DagPhase, { kind: "awaiting-human" }>,
     action: HumanAction,
     routing: DagRoutingState,
     humanGate: DagHumanGateConfig,
     topology: DagTopology,
     rerouteActiveSet?: ReadonlySet<NodeId>,
   ): { state: DagPhase; contextDelta: Partial<DagRoutingState> }
   ```

4. **Update `dagTransition`** to destructure context into slices before passing to helpers:
   ```ts
   export const dagTransition = (phase, event, ctx) => {
     const topology: DagTopology = ctx;    // structural subtype
     const retry: DagRetryState = ctx;     // structural subtype
     const routing: DagRoutingState = ctx;  // structural subtype
     const humanGate: DagHumanGateConfig = ctx;
     // ... match arms pass focused slices
   };
   ```

5. **Create test fixture factories:**
   ```ts
   // test-fixtures/context-factories.ts
   export const testTopology = (overrides?: Partial<DagTopology>): DagTopology => ({
     waves: [],
     edges: [],
     unconditionalAdj: new Map(),
     outputNodeId: undefined,
     ...overrides,
   });

   export const testRetryState = (overrides?: Partial<DagRetryState>): DagRetryState => ({
     retries: new Map(),
     retryConfigs: new Map(),
     defaultRetryLimit: undefined,
     retryLimits: undefined,
     ...overrides,
   });

   export const testHumanGateConfig = (overrides?: Partial<DagHumanGateConfig>): DagHumanGateConfig => ({
     humanReviewNodeIds: new Set(),
     humanReviewPrompts: new Map(),
     ...overrides,
   });

   export const testRoutingState = (overrides?: Partial<DagRoutingState>): DagRoutingState => ({
     activeNodeIds: new Set(),
     confidenceByNode: new Map(),
     ...overrides,
   });

   /** Full context from slices — for tests that need the complete shape. */
   export const testContext = (parts?: {
     topology?: Partial<DagTopology>;
     retry?: Partial<DagRetryState>;
     humanGate?: Partial<DagHumanGateConfig>;
     routing?: Partial<DagRoutingState>;
     outputs?: ReadonlyMap<NodeId, unknown>;
     initialInput?: unknown;
   }): DagMachineContextPersisted => ({
     ...testTopology(parts?.topology),
     ...testRetryState(parts?.retry),
     ...testHumanGateConfig(parts?.humanGate),
     ...testRoutingState(parts?.routing),
     outputs: parts?.outputs ?? new Map(),
     initialInput: parts?.initialInput ?? {},
   });
   ```

6. **Migrate tests incrementally** — existing tests that construct the full context still compile (structural subtyping). New tests and refactored tests use the factories. No big-bang rewrite of 100+ test files.

### Test checkpoint

- All 100+ test files compile and pass
- No behavioral change — transition outputs are identical
- `serialize-roundtrip-property.test.ts` passes (serialization shape unchanged)
- `dag-transition-property.test.ts` passes

### Benefits

- **Leverage** — new features add to a sub-record; consumers that don't care about the feature don't see the new field
- **Testability** — tests construct only the slice they exercise (4 fields instead of 13)
- **Locality** — retry-policy tests declare `DagRetryState` dependency; human-review state changes can't accidentally affect them
- **Documentation** — the slice names (`DagTopology`, `DagRetryState`, `DagRoutingState`, `DagHumanGateConfig`) tell the reader what each transition helper actually depends on

---

## Summary Table

| Step | What | Risk | Lines Changed | Key Metric |
|------|------|------|---------------|------------|
| 1 | `conditional.ts` → `topology.ts` + `routing.ts` | Low | ~50 (imports) | 448 lines → 220 + 180 |
| 2 | Extract `handleHumanGate` | Low | ~80 | 4 match arms → 2 delegations |
| 3 | Wave pipeline encapsulation | Medium | ~120 | 10-param → 2-param functions |
| 4 | `runDagStateful` decomposition | Medium | ~180 | 349 → ~50 line orchestrator |
| 5 | Context slice types | High | ~300 | 13-field mock → 4 focused factories |

**Total estimated effort:** ~4 hours across 5 PRs.

---

## Principles

1. **Each step is a separate commit/PR.** Tests pass green at every step.
2. **Zero behavioral change.** These are pure refactors. Observer event sequences, serialization formats, and public API shapes are unchanged.
3. **Structural subtyping is the migration strategy.** Narrowing parameter types from `DagMachineContextPersisted` to `DagRetryState` is non-breaking because the full context structurally satisfies every slice.
4. **If a step uncovers unexpected coupling, stop and reassess.** Don't push through — the coupling itself is signal.
5. **Tests that import via direct path stay valid.** Module-private means "not on the barrel" — direct imports remain the escape hatch for tests.

---

## What This Does NOT Change

- **Public API** (`index.ts`, `advanced.ts`) — unchanged
- **Serialization format** — `DagMachineContextPersisted` field names unchanged
- **Observer event types** — unchanged
- **ADR decisions** — this plan does not contradict any existing ADR
- **State machine kernel** — the deepest, best-designed module in the codebase; leave it alone
- **LlmClient port** — two real adapters + test fake; properly deep
- **Queue abstractions** — well-structured port with real + in-memory adapters

---

## Does This Warrant `/loom` Orchestration?

**No.** These are targeted refactors within a single package, not cross-bounded-context or multi-team work. Straightforward sequence of mechanical improvements. Execute serially in order.
