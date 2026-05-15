# PR Review Remediation Plan — 2026-05-15

Fixes all issues from the comprehensive review of `packages/framework/`.
No backwards compatibility constraints (greenfield, no external consumers).

---

## Wave 1 — Fix type layer inversions (I-2, I-3)

**Goal:** `types/` imports nothing from `observer/`, `tracing/`, `nodes/`, or `shared/`. Every upward dependency edge becomes a downward one.

### 1a. Move `Observer` interface to `types/observer.ts`

**Current:** `types/node.ts` → `import type { Observer } from "../observer/observer.js"`
**Problem:** `types/` depends on `observer/` — layer inversion.

Create `types/observer.ts`:
```ts
// types/observer.ts — Observer interface (type-only, no runtime deps)
import type { ObserverEvent subtypes... } from "./events.js";

export interface Observer {
  onRunStart(e: RunStartEvent): void;
  // ... all 13 methods
}
```

Then `observer/observer.ts` imports the interface from `types/observer.ts` and adds the runtime implementations (`NoopObserver`, `RecordingObserver`, `createObserver`). `types/node.ts` imports `Observer` from `./observer.js` (within `types/`).

**Files changed:**
- NEW: `types/observer.ts` — interface definition only
- EDIT: `observer/observer.ts` — `import type { Observer } from "../types/observer.js"`, re-export interface, keep impls
- EDIT: `types/node.ts` — `import type { Observer } from "./observer.js"`
- EDIT: `types/index.ts` — add `export type { Observer } from "./observer.js"`
- EDIT: `observer/index.ts` — still re-exports `Observer` (consumers see no change)

### 1b. Move `Tracer` interface to `types/tracer.ts`

**Current:** `tracing/tracer.ts` defines the `Tracer` interface. `types/node.ts` imports from `../tracing/tracer.js`.

Create `types/tracer.ts` with the `Tracer` interface. `tracing/tracer.ts` becomes a re-export from `types/tracer.ts` for any existing imports.

**Files changed:**
- NEW: `types/tracer.ts` — interface definition
- EDIT: `tracing/tracer.ts` — `export type { Tracer } from "../types/tracer.js"`
- EDIT: `types/node.ts` — `import type { Tracer } from "./tracer.js"`

### 1c. Move `ContentFilter` type to `types/content-filter.ts`

**Current:** `tracing/content-filter.ts` defines the `ContentFilter` type + runtime helpers. `types/node.ts` imports the type from there.

Create `types/content-filter.ts` with just the type alias:
```ts
export type ContentFilter = (content: string) => string;
```

`tracing/content-filter.ts` imports the type from `types/content-filter.ts` and keeps `piiScrubber`, `IDENTITY_FILTER`, `composeFilters`, `resolveContentFilter`.

**Files changed:**
- NEW: `types/content-filter.ts` — type alias only
- EDIT: `tracing/content-filter.ts` — `import type { ContentFilter } from "../types/content-filter.js"`, re-export type
- EDIT: `types/node.ts` — `import type { ContentFilter } from "./content-filter.js"`

### 1d. Move `EvalJudgeNodeDef` interface to `types/eval-judge.ts`

**Current:** `types/dag.ts` → `import type { EvalJudgeNodeDef } from "../nodes/eval-judge.js"`

The `EvalJudgeNodeDef` interface depends on `NodeId`, `NodeContext`, and `EvalJudgeResult`. `EvalJudgeResult` is defined in `nodes/eval-judge.ts` alongside the config. The interface is small — move it and `EvalJudgeResult` to `types/eval-judge.ts`.

**Files changed:**
- NEW: `types/eval-judge.ts` — `EvalJudgeNodeDef` interface + `EvalJudgeResult` type
- EDIT: `types/dag.ts` — `import type { EvalJudgeNodeDef } from "./eval-judge.js"`
- EDIT: `nodes/eval-judge.ts` — import types from `../types/eval-judge.js`, keep factory + runtime

### 1e. Move `JsonPatchOp` / `JsonPatch` types to `types/json-patch.ts`

**Current:** `types/events.ts` → `import type { JsonPatch } from "../shared/json-patch.js"`

Create `types/json-patch.ts` with just the type definitions. `shared/json-patch.ts` imports them from `types/` and keeps `computeJsonPatch` (the runtime helper).

**Files changed:**
- NEW: `types/json-patch.ts` — type definitions only
- EDIT: `shared/json-patch.ts` — `import type { JsonPatchOp, JsonPatch } from "../types/json-patch.js"`, re-export types
- EDIT: `types/events.ts` — `import type { JsonPatch } from "./json-patch.js"`
- EDIT: `types/index.ts` — re-export from `"./json-patch.js"` for types, `"../shared/json-patch.js"` for `computeJsonPatch`

### 1f. Verify with `check-imports.ts`

After all moves, run the existing boundary-import checker and the `boundary-imports.test.ts` to confirm no `types/ → observer|tracing|nodes|shared` edges remain.

---

## Wave 2 — Extract shared helpers (I-6, S-1, S-3)

### 2a. Extract `buildNodeInput` to `shared/build-input.ts`

**Current:** `run-node.ts` defines `buildNodeInput` as a module-private function. `freshness-emission.ts` has a duplicated copy inline.

Create `shared/build-input.ts` with the canonical implementation. Both files import from it.

**Files changed:**
- NEW: `shared/build-input.ts` — `export const buildNodeInput = (...)`
- EDIT: `dag-runtime/run-node.ts` — delete local `buildNodeInput`, import from `../shared/build-input.js`
- EDIT: `dag-runtime/freshness-emission.ts` — delete inline reconstruction, import from `../shared/build-input.js`

### 2b. Extract `emit` helper to `shared/emit.ts`

**Current:** Four files define identical `const emit = (ctx, event) => { ... dispatchEvent ... }`:
- `dag-runtime/executor.ts`
- `dag-runtime/run-node.ts`
- `dag-runtime/freshness-emission.ts`
- `dag-runtime/human-emission.ts`

Create `shared/emit.ts`:
```ts
import type { NodeContext } from "../types/node.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../types/observer.js";
import { dispatchEvent } from "../observer/buffered.js";

export const emit = (ctx: NodeContext, event: ObserverEvent): void => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};
```

Remove the local `emit` from all four files and import from `../shared/emit.js`.

**Files changed:**
- NEW: `shared/emit.ts`
- EDIT: `dag-runtime/executor.ts` — delete local `emit`, add import
- EDIT: `dag-runtime/run-node.ts` — delete local `emit`, add import
- EDIT: `dag-runtime/freshness-emission.ts` — delete local `emit`, add import
- EDIT: `dag-runtime/human-emission.ts` — delete local `emit`, add import

### 2c. Fix `sleep()` timer leak on abort

**Current:** `dag-runtime/executor.ts` `sleep()` — abort handler calls `resolve()` but doesn't clear the timer.

```ts
// BEFORE
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
```

Wait — it already does `clearTimeout(timer)` in the abort handler. Let me re-check.

Actually, re-reading the code: the `onAbort` handler does have `clearTimeout(timer)`. But when the timer fires normally (not aborted), the `onAbort` listener leaks on the signal until GC. Fix: remove the listener after the timer fires.

```ts
// AFTER
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
```

**Files changed:**
- EDIT: `dag-runtime/executor.ts` — fix `sleep()`

---

## Wave 3 — Barrel / public surface fixes (C-2, I-1, I-4, S-5)

### 3a. Rename kernel `RunOptions` → `KernelRunOpts`

**Current:** `state-machine/types.ts` exports `RunOptions<S, E, C>`. `executor/executor.ts` exports `RunOptions`. Both reach the barrel.

Rename the kernel-level one. It's the internal/advanced type — consumers building custom state machines reach for it deliberately. The DAG-level `RunOptions` (used with `runDag`) keeps its name since it's the primary public API.

**Files changed:**
- EDIT: `state-machine/types.ts` — `RunOptions<S,E,C>` → `KernelRunOpts<S,E,C>`
- EDIT: `state-machine/runner.ts` — update import/usage
- EDIT: `dag-runtime/run-dag-stateful.ts` — update import/usage (both the `Omit<KernelRunOpts<...>, "errorEventOf">` and `const runOpts: KernelRunOpts<...>`)
- EDIT: `index.ts` — `export type { ..., KernelRunOpts, ... } from "./state-machine/types.js"`

### 3b. Export `OpenAILlmClientOpts` from barrel

**Files changed:**
- EDIT: `llm/index.ts` — add `export type { OpenAILlmClientOpts } from "./openai-client.js"`

### 3c. Replace `export *` for semantic conventions

**Current:** `tracing/index.ts` has `export * from "./semantic-conventions.js"`, leaking ~30 constants onto the main barrel.

Replace with named exports of only the framework-owned `AI_*` constants (the ones consumers building custom observers/exporters actually need). The `GEN_AI_*` OTel semconv constants are internal — call sites already import them directly from `./semantic-conventions.js`.

```ts
// BEFORE
export * from "./semantic-conventions.js";

// AFTER
export {
  // Framework-owned constants consumers may need for custom exporters
  AI_NODE_ID,
  AI_NODE_KIND,
  AI_SPAN_TYPE,
  AI_DAG_ID,
  AI_RUN_ID,
  AI_LLM_COST_USD,
  AI_GUARDRAIL_PASSED,
  AI_NODE_SIDE_EFFECTS_KIND,
  AI_ROUTE_CONFIDENCE_BUCKET,
  AI_ROUTE_CONFIDENCE_SOURCE,
  AI_FRESHNESS_VIOLATION,
  AI_HUMAN_ACTION,
  AI_HUMAN_ACTOR,
  NODE_KIND_TO_SPAN_TYPE,
} from "./semantic-conventions.js";
```

Internal consumers (`mlflow-otlp-exporter.ts`, `span-enrich.ts`, `llm/spans.ts`, etc.) keep their direct imports from `./semantic-conventions.js` unchanged.

**Files changed:**
- EDIT: `tracing/index.ts` — replace `export *` with named exports

### 3d. Remove `bun.lockb`, add to `.gitignore`

Bun v1.1+ generates the text-based `bun.lock` by default. The binary `bun.lockb` is redundant.

**Files changed:**
- DELETE: `bun.lockb` (via `git rm`)
- EDIT: `.gitignore` — add `bun.lockb`

---

## Wave 4 — Error handling improvements (I-5, I-7, I-8)

### 4a. Confidence extraction: emit observer event on failure

**Current:** `dag-runtime/executor.ts` line ~475 — `confidence.extract()` failures are logged at `warn` and silently return `null`.

Fix: emit a `node-error` observer event so the failure appears in the event stream. Keep `upstreamConfidence = null` as fallback so routing doesn't crash, but the failure is now visible to observers and telemetry.

```ts
// AFTER
if (nodeDef && nodeDef.confidence.mode === "value") {
  try {
    upstreamConfidence = nodeDef.confidence.extract(newOutputs.get(nodeId));
  } catch (e) {
    const message = `confidence.extract failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`;
    fwLogger().warn(`[runWave] ${message}`);
    emit(nodeCtx, {
      type: "node-error",
      runId: nodeCtx.runId,
      dagId: dag.id,
      nodeId,
      sideEffects: nodeMap.get(nodeId)?.sideEffects,
      timestamp: stamp(),
      error: message,
      frameworkError: { kind: "node-crash", nodeId, retriability: "non-retriable", message },
    });
    upstreamConfidence = null;
  }
}
```

**Files changed:**
- EDIT: `dag-runtime/executor.ts` — confidence extraction catch block

### 4b. BufferedObserver: expose `dispatchErrors` counter

**Current:** `dispatchEvent` catches and logs observer errors. Persistent failures are invisible to callers.

Add a `dispatchErrors` counter to `BufferedObserver` and increment it in the `onRunEnd` replay loop's catch block. Callers can poll this for alerting.

```ts
export class BufferedObserver implements Observer, Disposable {
  // ...existing fields...
  /** Count of events lost to dispatch failures. Useful for monitoring. */
  dispatchErrors = 0;
  // ...
```

In the replay loop in `onRunEnd`:
```ts
} catch (err) {
  replayFailures++;
  this.dispatchErrors++;
  // ...existing handling...
}
```

**Files changed:**
- EDIT: `observer/buffered.ts` — add `dispatchErrors` counter, increment on replay failure

### 4c. Predicate result: rename `errorKind` → `reason`

**Current:** `RouteEvidence.predicateResults[n].errorKind` has values `"malformed" | "threw" | "below-min-confidence"`. The name `errorKind` is misleading because `below-min-confidence` is a legitimate gating decision, not an error.

Rename the field to `reason`. The values stay the same — they all explain why a predicate didn't match, whether due to error or intentional gating.

**Files changed:**
- EDIT: `types/events.ts` — rename field `errorKind` → `reason` on the `predicateResults` array element type
- EDIT: `types/dag.ts` — `evaluatePredicate` return type: `errorKind` → `reason`
- EDIT: `dag-runtime/conditional.ts` — any references to `errorKind` in predicate result construction → `reason`
- EDIT: tests that reference `errorKind` (`conditional-edges-routing.test.ts`, `conditional-edges-validator.test.ts`, `predicate-malformed-event-sequence.test.ts`, `route-decided-evidence.test.ts`, `confidence-bucket-ordering.test.ts`)

---

## Wave 5 — Small fixes (S-2, S-6)

### 5a. FakeLlmClient: replace `as any` with type guard

**Current:** `fake-client.ts` line 32: `typeof (value as any).kind === "string"`

Replace with a proper structural check:

```ts
const isFrameworkError = (value: unknown): value is FrameworkError =>
  value !== null &&
  typeof value === "object" &&
  "kind" in value &&
  typeof (value as Record<string, unknown>).kind === "string";
```

**Files changed:**
- EDIT: `llm/fake-client.ts` — replace `as any` check with type guard

### 5b. Scheduler: explicit `void` on fire-and-forget promise

**Current:** `scheduler/scheduler.ts` — `handleFire(current, triggeredAt).then(...).catch(...)` return value discarded from `setTimeout`.

Add `void` prefix to make intentionality explicit:

```ts
void handleFire(current, triggeredAt)
  .then(() => { ... })
  .catch((err) => { ... });
```

**Files changed:**
- EDIT: `scheduler/scheduler.ts` — add `void` prefix

---

## Wave 6 — Test improvements (S-4)

### 6a. Add abort-from-any-non-terminal property test

Add a `fast-check` property test to `dag-transition-property.test.ts` that asserts: for any non-terminal `DagPhase`, an abort event always transitions to `{ kind: "failed", error: { kind: "aborted" } }`. This is the first clause in `dagTransition` and the most critical safety invariant.

```ts
test("abort from any non-terminal phase yields failed+aborted", () => {
  fc.assert(
    fc.property(
      arbitraryNonTerminalPhase,
      arbitraryDagMachineContext,
      (phase, ctx) => {
        const result = dagTransition(phase, { type: "abort", reason: "test" }, ctx);
        expect(result.state.kind).toBe("failed");
        if (result.state.kind === "failed") {
          expect(result.state.error.kind).toBe("aborted");
        }
      },
    ),
  );
});
```

**Files changed:**
- EDIT: `__tests__/dag-transition-property.test.ts` — add abort property test

---

## Execution Order

| Wave | Items | Dependencies | Est. files |
|------|-------|-------------|-----------|
| 1 | I-2, I-3 (type layer) | None | ~15 new/edited |
| 2 | I-6, S-1, S-3 (shared helpers) | Wave 1 (emit uses types/observer.ts) | ~8 |
| 3 | C-2, I-1, I-4, S-5 (barrel) | Wave 1 (barrel re-exports moved types) | ~8 |
| 4 | I-5, I-7, I-8 (error handling) | Wave 2 (uses shared emit) | ~10 |
| 5 | S-2, S-6 (small fixes) | None | ~2 |
| 6 | S-4 (tests) | Wave 4 (tests verify new error behavior) | ~1 |

**Total:** ~44 file touches across 6 waves.

After each wave: `bun test packages/framework/` + `bun tsc --noEmit -p packages/framework/tsconfig.json`.

---

## Validation Criteria

1. `bun test` — 932+ pass, 0 fail
2. `tsc --noEmit` — clean
3. `boundary-imports.test.ts` — passes (no upward deps from `types/`)
4. `git diff --stat` shows `in-memory.ts` as text, not binary
5. No `export *` leaking internals onto main barrel
6. Single `RunOptions` type reachable via `import { RunOptions } from "@ai-summary/framework"`
7. `grep -rn 'import.*from.*"\.\./observer/\|from.*"\.\./tracing/\|from.*"\.\./nodes/' packages/framework/src/types/` returns empty
