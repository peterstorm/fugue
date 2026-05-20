# Deepening Opportunities — Framework Architecture Improvement

**Date:** 2026-05-15
**Branch:** feat/initial-setup
**Status:** Proposed — ready for implementation

## Overview

Five deepening opportunities identified via proactive architecture review. Each turns shallow modules into deeper ones — increasing leverage at the interface, improving locality of change, and tightening type-level enforcement. Ordered from least to most disruptive.

Vocabulary: **module** (anything with an interface and implementation), **depth** (leverage at the interface), **seam** (where behaviour can be altered without editing in place), **locality** (change concentrates in one place), **deletion test** (imagine deleting the module — does complexity vanish or reappear across callers?).

---

## §1 — `formatFrameworkError` locality

**Priority:** 1st (smallest, standalone)
**Estimated effort:** Trivial
**Breaking change:** No

### Files

- `types/errors.ts` (target)
- `executor/define-dag.ts` (source — `formatDetail` function)

### Problem

`formatDetail` in `executor/define-dag.ts` handles all 16+ `FrameworkError` variants via a switch with an exhaustive `never` guard. But it lives in a file concerned with DAG *definition validation*, not error presentation. Adding a new `FrameworkError` kind requires updating a function whose file name gives no hint it formats errors. The exhaustive guard catches the omission at compile time, but **locality** is poor — the error type and its human-readable formatting are in different directories.

**Deletion test:** if you deleted `formatDetail`, you'd rebuild it next to `FrameworkError`. No caller outside `define-dag.ts` uses it today, but the pattern of "format any FrameworkError" is useful beyond that single consumer.

### Deepening

Move `formatDetail` to `types/errors.ts`, rename to `formatFrameworkError`, and export it. `DagDefinitionError` imports from the canonical location. Future consumers (API error responses, CLI output, log sinks) get the formatter from where the type lives.

### Interface

```ts
// types/errors.ts (appended)

/**
 * Human-readable single-line summary of a FrameworkError. Exhaustive —
 * adding a new `kind` without a case is a compile error.
 */
export const formatFrameworkError = (e: FrameworkError): string => {
  switch (e.kind) {
    case "validation":
      return `${e.message} (node '${e.nodeId}')`;
    case "missing-default-edge":
      return `node '${e.nodeId}' has conditional out-edges but no default edge`;
    case "output-unreachable-under-routing":
      return `outputNodeId '${e.outputNodeId}' is not reachable along unconditional + default edges (frontier at '${e.missedFromNode}')`;
    case "duplicate-edge":
      return `duplicate edge '${e.fromNodeId}' -> '${e.toNodeId}'`;
    case "predicate-malformed":
      return `${e.message} (node '${e.nodeId}')`;
    case "cycle-detected":
      return `cycle detected: ${e.nodeIds.join(" -> ")}`;
    case "retry-exhausted":
    case "checkpoint-missing":
    case "checkpoint-expired":
    case "checkpoint-corrupt":
    case "checkpoint-version-mismatch":
    case "checkpoint-write-failed":
    case "prompt-not-found":
    case "cache-error":
    case "node-crash":
    case "aborted":
    case "rejected":
    case "invalid-reroute":
    case "transient":
    case "missing-capability":
      return JSON.stringify(e);
    default: {
      const _exhaustive: never = e;
      return `unhandled error kind: ${JSON.stringify(_exhaustive)}`;
    }
  }
};
```

`executor/define-dag.ts` changes:

```diff
-const formatDetail = (e: FrameworkError): string => { ... }; // ~30 LOC deleted
+import { formatFrameworkError } from "../types/errors.js";

 constructor(dagId: string, detail: FrameworkError) {
-  super(`[defineDag] DAG '${dagId}' is unsound: ${formatDetail(detail)}`);
+  super(`[defineDag] DAG '${dagId}' is unsound: ${formatFrameworkError(detail)}`);
 }
```

### Testing strategy

- **Survive:** All existing tests — `formatDetail` is exercised through `DagDefinitionError`.
- **New:** Unit tests on `formatFrameworkError` covering each variant's output shape. Live next to `types/errors.ts`.

### ADR conflicts

None.

---

## §2 — LLM node factories: extract shared call pipeline

**Priority:** 2nd
**Estimated effort:** Medium
**Breaking change:** No (internal extraction)

### Files

- `nodes/llm.ts` (172 LOC)
- `nodes/llm-with-tools.ts` (215 LOC)
- `nodes/llm-pipeline.ts` (new — the deep module)

### Problem

`createLlmNode` and `createLlmWithToolsNode` share ~80% of their implementation body: skip check → prompt resolution → cache read → LLM call → validation retry → span enrichment → cache write. The single variation is the call: `llm.sendStructured` vs `llm.sendWithTools`. Both are 170+ LOC functions with identical error handling, cache key computation, and retry logic duplicated line-for-line.

**Deletion test:** delete either factory — its callers need the same pipeline the other already has. Both earn their keep, but they're copy-pasted rather than shared.

### Deepening

Extract a shared `runLlmCallPipeline` function parameterized by the call strategy. Both factories become thin wrappers (~30–40 LOC each) that resolve prompts, compute the cache key, and delegate to the pipeline. A future third LLM node type (streaming, multi-turn) composes the same pipeline.

### Interface

```ts
// nodes/llm-pipeline.ts

interface LlmPipelineConfig<O> {
  readonly nodeId: NodeId;
  readonly model: string;
  readonly outputSchema: z.ZodType<O>;
  readonly prompts: { readonly system: string; readonly user: string };
  readonly cacheKey: string;
  readonly disableValidationRetry?: boolean;
  readonly promptName?: string;
  readonly thinking?: { type: "enabled"; budgetTokens: number };
}

/**
 * The call-strategy seam. `sendStructured` and `sendWithTools` have different
 * request shapes — the pipeline doesn't care which; it passes the resolved
 * prompts and receives a `Result<LlmResponse<O>, FrameworkError>`.
 */
type LlmCallFn<O> = (
  client: LlmClient,
  prompts: { readonly system: string; readonly user: string },
  ctx: NodeContext,
) => Promise<Result<LlmResponse<O>, FrameworkError>>;

/**
 * Shared pipeline: cache-read → call → validate+retry → enrich → cache-write.
 *
 * Deep module: callers learn one function; the pipeline hides cache error
 * handling, validation retry (FR-021), span enrichment, and cache-write
 * best-effort semantics behind a single invocation.
 */
export const runLlmCallPipeline = async <O>(
  config: LlmPipelineConfig<O>,
  callFn: LlmCallFn<O>,
  ctx: NodeContext,
): Promise<Result<O, FrameworkError>>;
```

`createLlmNode` narrows to:

```ts
run: async (input, ctx) => {
  if (config.skipWhen?.(input)) return ok(config.skipDefault as O);

  const promptTemplate = ctx.prompts.get(config.promptName);
  if (!promptTemplate) return err({ kind: "prompt-not-found", ... });
  const vars = config.buildInput(input);
  const user = interpolatePrompt(promptTemplate, vars);
  const system = config.system ?? "You are an AI assistant...";
  const cacheKey = config.computeCacheKey?.(input) ?? `${config.id}:${stableHash(input)}`;

  return runLlmCallPipeline(
    { nodeId: config.id, model: config.model, outputSchema: config.outputSchema,
      prompts: { system, user }, cacheKey, promptName: config.promptName,
      disableValidationRetry: config.disableValidationRetry, thinking: config.thinking },
    (client, prompts) => client.sendStructured({ ...prompts, model: config.model,
      schema: config.outputSchema, nodeId: config.id, ...(config.thinking ? { thinking: config.thinking } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}) }),
    ctx,
  );
},
```

`createLlmWithToolsNode` follows the same pattern with `sendWithTools` as the call function.

### Testing strategy

- **Survive:** `llm-with-tools-factory.test.ts`, any test asserting cache behaviour, validation retry, skip-when — these exercise end-to-end node behaviour and are unchanged.
- **New:** Unit tests on `runLlmCallPipeline` directly:
  - Cache miss → call → validate → cache-write
  - Cache hit → skip call, return cached value
  - Validation failure + retry → second attempt succeeds
  - Validation failure + retry → second attempt fails → `retry-exhausted`
  - Cache write failure → log + still return ok
  - `disableValidationRetry: true` → no retry on validation failure
- **Simplified:** Factory-level tests narrow to: correct prompt resolution, correct `callFn` wiring, correct `requires` declaration. The heavy pipeline behaviour is tested once at the pipeline boundary.

### ADR conflicts

None. ADR-0012 documents the tool-call surface and `sendWithTools` contract; this deepening preserves both. The internal extraction is invisible to the public API.

---

## §3 — Extract routing-decision computation from `runWave`

**Priority:** 3rd
**Estimated effort:** Medium
**Breaking change:** No (internal extraction)

### Files

- `dag-runtime/executor.ts` — `runWave` function (~200 LOC, total file 607 LOC)
- `dag-runtime/route-emission.ts` (new)

### Problem

`runWave` handles five distinct responsibilities in sequence:

1. **Wave dispatch** — filter active nodes, run via `Promise.all`
2. **Failure collection** — gather partial outputs, identify co-failed siblings
3. **Freshness emission** — call `emitFreshnessWitnessEvents` (already extracted)
4. **Routing decisions** — evaluate predicates, extract confidence, emit route-decided/node-pruned observer events
5. **Event assembly** — construct the `wave-done` or `node-failed` DagEvent

The routing-decision phase (~50 LOC) has a dual obligation: emit observer events AND attach decisions to the returned `wave-done` event. Testing routing behaviour in isolation (confidence extraction failure, predicate-malformed handling, observer event emission) requires running a full wave.

The 9-field `RunWaveConfig` signals the problem: the function needs all those fields because it does all those things.

### Deepening

Extract the routing-decision phase into `dag-runtime/route-emission.ts`. `runWave` becomes a clear pipeline: dispatch → collect failures → freshness → routing → assemble event. Each phase has a testable seam.

### Interface

```ts
// dag-runtime/route-emission.ts

import type { Decision } from "./conditional.js";
import type { DagEvent } from "./types.js";

interface RoutingPhaseResult {
  /** Per-source-node routing decisions. Empty map when no conditional edges fired. */
  readonly decisions: ReadonlyMap<NodeId, Decision>;
  /** When a predicate is malformed, short-circuit wave with this node-failed event. */
  readonly earlyFailure?: DagEvent;
}

/**
 * Compute routing decisions for all wave nodes that have conditional out-edges.
 * Extracts confidence, evaluates predicates, emits route-decided and node-pruned
 * observer events. Returns decisions for the wave-done event and an optional
 * early-failure if a predicate is malformed.
 */
export const emitRoutingDecisions = (
  waveNodeIds: readonly NodeId[],
  newOutputs: ReadonlyMap<NodeId, unknown>,
  nodeMap: ReadonlyMap<NodeId, NodeDef<unknown, unknown>>,
  machineCtx: DagMachineContext,
  nodeCtx: NodeContext,
  dagId: DagId,
  nowFn: () => number,
): RoutingPhaseResult;
```

`runWave` simplifies to:

```ts
// ... dispatch nodes via Promise.all → settled ...
// ... fold outcomes ...
// ... collect failures → return node-failed if any ...
// ... emit freshness witness events ...

const routing = emitRoutingDecisions(
  waveNodeIds, newOutputs, nodeMap, machineCtx, nodeCtx, dag.id, nowFn,
);
if (routing.earlyFailure) return routing.earlyFailure;

return {
  type: "wave-done",
  wave: waveIndex,
  outputs: newOutputs,
  routingDecisions: routing.decisions.size > 0 ? routing.decisions : undefined,
};
```

This cuts `runWave` from ~200 LOC to ~130 LOC. The phased structure is explicit.

### Testing strategy

- **Survive:** All `conditional-edges-*.test.ts` tests, `route-decided-evidence.test.ts` — full-pipeline behaviour is unchanged.
- **New:** Unit tests on `emitRoutingDecisions` directly:
  - Confidence extraction failure → logs warning, `null` confidence, still decides route
  - `predicate-malformed` → returns `{ earlyFailure: { type: "node-failed", ... } }`
  - Mixed conditional/unconditional edges → correct `decisions` map
  - Observer events emitted: `route-decided` with correct evidence, `node-pruned` per pruned target
  - No conditional edges in wave → empty map, no observer events
- **Unchanged:** `decideRoute` in `conditional.ts` retains its own unit tests — the extraction tests the wrapping layer (confidence extraction + observer emission + error short-circuit).

### ADR conflicts

None. ADR-0015 (conditional edges) and ADR-0019 (runtime routing predicate) document the routing contract; this deepening preserves it and makes it more testable.

---

## §4 — Freshness extractors colocated on `SideEffectProfile`

**Priority:** 4th
**Estimated effort:** Medium — touches types, dag-runtime, and node factories
**Breaking change:** Yes (public `NodeDef` shape changes, `SideEffectProfile` shape changes)

### Files

- `types/side-effects.ts` — `SideEffectProfile` type
- `types/node.ts` — `NodeDef` type (remove 3 fields)
- `dag-runtime/freshness-emission.ts` — reads extractors from `sideEffects` instead of `nodeDef`
- `dag-runtime/node-span.ts` — `idempotencyKey` access unchanged (already on `sideEffects`)
- `nodes/*.ts` — update node factory `sideEffects` declarations
- `__tests__/freshness-*.test.ts` — mechanical field relocation

### Problem

`NodeDef` carries three optional freshness extractors (`extractWitness`, `extractConditionedOn`, `extractNewWitness`) as top-level fields. These are semantically coupled to `sideEffects.kind` but the coupling is documented in comments, not in the type system. A `reads` node that forgets `extractWitness` gets no compile-time error and no runtime warning — freshness tracking is "silently skipped". A `writes` node that accidentally sets `extractWitness` (a reads-only extractor) gets no type error.

The **interface is wide**: 12+ fields on `NodeDef`, three of which belong on the side-effect declaration. `SideEffectProfile` already carries closures (`idempotencyKey`) and appears on observer events — those events are in-process objects, never serialized to the durable event log (`DagEvent` is the serialized shape).

### Deepening

Colocate freshness extractors on the `SideEffectProfile` discriminated union variants where they belong. `NodeDef` loses 3 top-level fields. The type system prevents `reads` extractors on `writes` nodes and vice versa.

### Interface

```ts
// types/side-effects.ts

export type SideEffectKind = "none" | "reads" | "writes" | "external-call";

export type SideEffectProfile =
  | { readonly kind: "none"; readonly resource?: undefined }
  | {
      readonly kind: "reads";
      readonly resource: string;
      /** Extract a freshness witness from the node's output (Phase 3). Optional — when absent, freshness tracking is skipped. */
      readonly extractWitness?: (output: unknown) => Witness;
    }
  | {
      readonly kind: "writes";
      readonly resource: string;
      readonly idempotencyKey?: (input: unknown) => string;
      /** Declare which witness this write is conditioned on. Called with the node's assembled input before execution. */
      readonly extractConditionedOn?: (input: unknown) => Witness;
      /** Extract the new witness after a successful write. Captures the new resource version. */
      readonly extractNewWitness?: (output: unknown) => Witness;
    }
  | {
      readonly kind: "external-call";
      readonly resource: string;
      readonly idempotencyKey?: (input: unknown) => string;
    };
```

`NodeDef` diff:

```diff
 interface NodeDef<I, O, E, R> {
   readonly sideEffects: SideEffectProfile;
   readonly confidence: ConfidenceMode<O>;
   readonly humanReview?: NodeHumanReviewConfig;
   readonly retry?: NodeRetryConfig;
-  readonly extractWitness?: (output: O) => Witness;
-  readonly extractConditionedOn?: (input: I) => Witness;
-  readonly extractNewWitness?: (output: O) => Witness;
 }
```

`freshness-emission.ts` simplifies — matched variants carry their extractors directly:

```ts
await match(se)
  .with({ kind: "reads" }, async (se) => {
    if (!se.extractWitness) return;
    const witness = se.extractWitness(output);
    emit(nodeCtx, { type: "witness-captured", ... });
    witnessAccumulator?.set(witness.resource, witness);
  })
  .with({ kind: "writes" }, async (se) => {
    if (!se.extractConditionedOn || !se.extractNewWitness) return;
    const conditionedOn = se.extractConditionedOn(nodeInput);
    const newWitness = se.extractNewWitness(output);
    // ... conflict check + emit ...
  })
  .with({ kind: "none" }, () => {})
  .with({ kind: "external-call" }, () => {})
  .exhaustive();
```

### Type-level wins

| Before | After |
|--------|-------|
| `{ kind: "none", extractWitness: fn }` — compiles ❌ (no error) | `{ kind: "none", extractWitness: fn }` — type error ✅ |
| `{ kind: "writes", extractWitness: fn }` — compiles ❌ | `{ kind: "writes", extractWitness: fn }` — type error ✅ |
| `{ kind: "reads", extractConditionedOn: fn }` — compiles ❌ | `{ kind: "reads", extractConditionedOn: fn }` — type error ✅ |

### Testing strategy

- **Survive (with mechanical update):** All `freshness-*.test.ts` — move `extractWitness` / `extractConditionedOn` / `extractNewWitness` from `NodeDef` to `sideEffects` in test fixtures.
- **New:** Type-level compilation tests:
  - `{ kind: "none", extractWitness: () => ... }` must not compile
  - `{ kind: "reads", extractConditionedOn: () => ... }` must not compile
  - `{ kind: "writes", extractWitness: () => ... }` must not compile
- **Deleted:** Any test that explicitly checks "extractors are optional on NodeDef" — the optionality now lives on the `SideEffectProfile` variant.

### ADR conflicts

None. ADR-0025 (freshness witness contract) specifies opt-in freshness; this preserves opt-in (extractors remain optional within each variant) while tightening type safety.

### Known concern

`SideEffectProfile` already carries closures (`idempotencyKey`) and is referenced on observer events. Observer events are in-process objects, never serialized to the durable event log. Any consumer that tries to `JSON.stringify` an observer event would fail on the closure fields — but this is a pre-existing concern (from `idempotencyKey`), not introduced by this deepening.

---

## §5 — Observer interface: 13 methods → single `observe(event)` method

**Priority:** 5th (most disruptive — breaking API change)
**Estimated effort:** Medium-large
**Breaking change:** Yes (public `Observer` interface changes)

### Files

- `types/observer.ts` — interface (13 methods → 1)
- `observer/observer.ts` — `NoopObserver`, `RecordingObserver`, `createObserver`
- `observer/buffered.ts` — `BufferedObserver`, `dispatchEvent`
- Every call site that calls `dispatchEvent` or constructs an `Observer` implementation

### Problem

The `Observer` interface has 13 separate methods, one per `ObserverEvent` variant. Every new event type triggers shotgun surgery across 6 locations: (a) the interface, (b) `NoopObserver`, (c) `RecordingObserver`, (d) `createObserver`, (e) `BufferedObserver`, (f) `dispatchEvent`. The interface is **shallow** — its surface nearly mirrors the event union 1:1 with no additional leverage.

Look at the three real implementations:

- `NoopObserver`: every method is `{}` — one method would be `observe() {}`
- `RecordingObserver`: every method is `this.events.push(e)` — one method
- `BufferedObserver`: 12 of 13 methods call `this.buffer(e.runId, e)` — only `onRunEnd` diverges

The exhaustiveness the 13-method interface buys is already enforced by `ts-pattern` in `dispatchEvent`. The per-method interface adds zero **leverage** — callers learn 13 methods that are structurally identical.

**Deletion test:** replace with `observe(event: ObserverEvent)` and exhaustive matching moves to the implementations. Compile-time safety is preserved by `ts-pattern`'s `.exhaustive()` in `BufferedObserver`.

### Constraints

- `createObserver(handlers: Partial<Observer>)` provides per-event handler ergonomics and must not lose this convenience.
- `dispatchEvent`'s error-isolation contract (catch + log, rethrow under `OBSERVER_STRICT`) must survive.
- External consumers implementing `Observer` exist (the type is exported).

### Deepening

Replace the 13-method `Observer` interface with a single `observe(event: ObserverEvent): void`. Move exhaustive dispatch into each implementation. `dispatchEvent` becomes a thin error-isolation wrapper around `observer.observe(event)`.

### Interface

```ts
// types/observer.ts

import type { ObserverEvent } from "./events.js";

/**
 * Observer contract — single entry point for all framework events.
 *
 * Implementations that need to branch on event type use
 * `match(event).with(...).exhaustive()` from ts-pattern — adding a new
 * event variant to `ObserverEvent` surfaces as a compile error inside
 * the implementation's match block, not across a 13-method interface.
 */
export interface Observer {
  observe(event: ObserverEvent): void;
}
```

```ts
// observer/observer.ts

export const noopObserver: Observer = { observe() {} };

export class RecordingObserver implements Observer {
  readonly events: ObserverEvent[] = [];
  observe(e: ObserverEvent): void {
    this.events.push(e);
  }
}

/**
 * Factory for creating an Observer from per-event-type handlers.
 * Unspecified event types are silently ignored (no-op).
 * Preserves the ergonomics of the old Partial<Observer> API.
 */
type EventHandlers = {
  readonly [K in ObserverEvent["type"]]?: (
    event: Extract<ObserverEvent, { type: K }>,
  ) => void;
};

export function createObserver(handlers: EventHandlers): Observer {
  return {
    observe(event: ObserverEvent): void {
      const handler = handlers[event.type as keyof typeof handlers];
      if (handler) (handler as (e: ObserverEvent) => void)(event);
    },
  };
}
```

```ts
// observer/buffered.ts — BufferedObserver

observe(event: ObserverEvent): void {
  match(event)
    .with({ type: "run-end" }, (e) => this.handleRunEnd(e))
    .otherwise((e) => this.buffer(e.runId, e));
}
```

`dispatchEvent` simplifies to:

```ts
export function dispatchEvent(observer: Observer, event: ObserverEvent): void {
  try {
    observer.observe(event);
  } catch (e) {
    fwLogger().error(
      `[observer] observe failed for ${event.type}:`,
      e instanceof Error && e.stack ? e.stack : e,
    );
    if (OBSERVER_STRICT) throw e;
  }
}
```

### Exhaustiveness tradeoff

External consumers who previously got a compile error for a missing method now don't — their `observe` method compiles with any event. Mitigations:

1. `createObserver` (the documented factory path) never forced exhaustiveness — handlers were already `Partial`.
2. Consumers who need exhaustiveness use `match(event).exhaustive()` in their implementation — the compiler error appears in *their* file with a stack trace, not in a distant interface they don't control.
3. `BufferedObserver` (the only implementation that branches on event type) uses `ts-pattern`'s `.otherwise()` — a new event type is silently buffered, which is the correct default.

### Testing strategy

- **Survive:** `buffered-observer.test.ts`, `buffered-observer-concurrent.test.ts` — all test flushing, filtering, event-count behaviour. Unchanged.
- **Die:** `observer-port-completeness.test.ts` — tests that every `ObserverEvent` type has a corresponding method on `Observer`. With a single method, this invariant is satisfied by construction. Delete it.
- **New:** Property test (fast-check): for all `ObserverEvent` variants, `RecordingObserver` records them (trivial — verify `events.length === N` after N calls).
- **Updated:** Any test that constructs a `NoopObserver` or `RecordingObserver` by class — update to new shape. `createObserver({ onRunEnd: ... })` callers update handler keys from method names to event types (`onRunEnd` → `"run-end"`).

---

## Implementation Order

| Order | Section | Depth gain | Disruption | Status |
|-------|---------|-----------|------------|--------|
| 1st | §1 `formatFrameworkError` | Small, clean locality | Minimal — move + rename | ✅ Done |
| 2nd | §2 LLM pipeline | High — eliminates ~170 LOC duplication | Contained to `nodes/` | ✅ Done |
| 3rd | §3 Routing extraction | Medium — clarifies `runWave` phases | Contained to `dag-runtime/` | ✅ Done |
| 4th | §4 Freshness on `SideEffectProfile` | Medium — type-level enforcement | Touches `types/` + `dag-runtime/` + node factories | ✅ Done |
| 5th | §5 Observer single-method | High — interface shrinks 13→1 | Touches observer + all dispatch sites | ✅ Done |

Each is a targeted refactor — individual PRs, each building on a green test suite from the prior. None requires cross-bounded-context coordination. §1–§3 are non-breaking internal extractions. §4–§5 are breaking changes appropriate for a pre-1.0 framework.

### Per-section implementation checklist

Each section follows this sequence:

1. Create the new module / move the function
2. Update the type definitions (if any)
3. Update all internal consumers (imports, field access)
4. Update test fixtures (mechanical field relocation)
5. Delete superseded code (old function, old tests)
6. Run `bun test` — green
7. Run `bun run typecheck` — green
8. Run `scripts/check-imports.ts` — green (layering preserved)
