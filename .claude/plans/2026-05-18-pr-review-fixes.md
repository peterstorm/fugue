# PR Review Fix Plan — 2026-05-18

All 20 advisories from the comprehensive PR review. No backwards-compat concerns (greenfield). Ordered by dependency and severity.

---

## Phase 1: Silent Failure Fixes (HIGH priority)

### 1.1 — `sendWithTools` non-null assertion → proper guard with Result error

**File:** `packages/framework/src/nodes/llm-with-tools.ts:136`

**Problem:** `llmClient.sendWithTools!(req, ctx)` will throw `TypeError` if a custom `LlmClient` implementation omits `sendWithTools`. The non-null assertion bypasses the Result contract.

**Fix:** `LlmClient.sendWithTools` is NOT optional on the interface — it's required (confirmed from `types/llm.ts`). The `!` is a leftover from when it was optional. Since we have no backwards compat, simply remove the `!` — TypeScript already guarantees the method exists via the interface.

```ts
// Before
return llmClient.sendWithTools!(req, ctx);

// After
return llmClient.sendWithTools(req, ctx);
```

---

### 1.2 — `OBSERVER_STRICT` async rejection: `setTimeout` → `queueMicrotask` + richer message

**File:** `packages/framework/src/observer/dispatch.ts:30-34`

**Problem:** `setTimeout(() => { throw error }, 0)` defers the throw to the next macrotask tick, making it uncatchable by the test harness and producing confusing stack traces.

**Fix:** Use `queueMicrotask` for tighter temporal coupling, but more importantly, enrich the error message so it names the event type AND throw synchronously via a stored-error pattern that Bun's test runner can catch. Best approach: accumulate the error and rethrow it in a way the test can observe. Actually, the simplest correct fix: throw synchronously inside the `.catch` handler itself — the catch handler IS asynchronous (it runs when the promise rejects), so we can't throw synchronously from it. Instead, use `process.emit('uncaughtException', error)` which Bun test captures, OR better: just use `setImmediate`/`queueMicrotask` with a descriptive error.

**Chosen approach:** Enrich the error message and use `queueMicrotask` (fires before I/O, before next test assertion):

```ts
if (OBSERVER_STRICT) {
  const error = e instanceof Error ? e : new Error(String(e));
  error.message = `[OBSERVER_STRICT] Observer.observe() returned a rejected Promise for event '${event.type}'. ` +
    `Observer.observe MUST be synchronous. Original: ${error.message}`;
  queueMicrotask(() => { throw error; });
}
```

---

### 1.3 — Bootstrap: log on eval-rubric prompt load failure

**File:** `apps/customer-summary/src/bootstrap.ts:153-156`

**Problem:** Silently ignores `summary-eval-rubric` load failure — no else branch, no log.

**Fix:** Add else branch with `log.warn(...)` matching the pattern of the other two prompts:

```ts
const evalRubricPrompt = await promptRegistry.load("summary-eval-rubric");
if (evalRubricPrompt.ok) {
  prompts.set("summary-eval-rubric", evalRubricPrompt.value.text);
} else {
  log.warn("Failed to load summary-eval-rubric prompt:", evalRubricPrompt.error);
}
```

---

### 1.4 — Bootstrap: MLflow health check — log failure context

**File:** `apps/customer-summary/src/bootstrap.ts:239`

**Problem:** `catch { return false; }` discards all failure context.

**Fix:**
```ts
checkMlflow: async () => {
  try {
    const res = await fetch(`${config.MLFLOW_TRACKING_URI}/health`);
    return res.ok;
  } catch (e) {
    log.debug(`[health] MLflow unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
},
```

---

### 1.5 — Scheduler: track in-flight promises, await on `stop()`

**File:** `packages/framework/src/scheduler/scheduler.ts`

**Problem:** `void handleFire(...)` creates fire-and-forget promises. `stop()` clears timers but doesn't await in-flight fires — mid-flight work is silently abandoned on shutdown.

**Fix:** Add a `Set<Promise<void>>` for in-flight handles. Register each `handleFire` promise, remove on settlement. In `stop()`, await them via `Promise.allSettled`.

```ts
// Add near top of createCronScheduler body:
const inFlight = new Set<Promise<void>>();

// In onTimerFire, replace the `void handleFire(...)` block:
const p = handleFire(current, triggeredAt)
  .then(() => {
    consecutiveFailures.delete(current.id);
    const stillActive = activeRegistry.get(current.id);
    if (stillActive !== undefined) rescheduleTask(stillActive, triggeredAt);
  })
  .catch((err) => {
    fwLogger().error(`[CronScheduler] timer callback failed for "${current.id}":`, err);
    const n = (consecutiveFailures.get(current.id) ?? 0) + 1;
    consecutiveFailures.set(current.id, n);
    const stillActive = activeRegistry.get(current.id);
    if (stillActive !== undefined) rescheduleTaskWithBackoff(stillActive, n);
  })
  .finally(() => { inFlight.delete(p); });
inFlight.add(p);

// Change stop() to async:
async function stop(): Promise<void> {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
  await Promise.allSettled([...inFlight]);
  consecutiveFailures.clear();
  inMemoryFiredFallback.clear();
  activeRegistry = new Map();
}
```

Also update `CronScheduler.stop` interface signature to `stop(): Promise<void>`.

---

### 1.6 — OTel span failures: add debug logging

**File:** `packages/framework/src/dag-runtime/node-span.ts:130-131`

**Problem:** Empty catch blocks absorb OTel failures without any trace. If the SDK is broken, operators have no evidence.

**Fix:**
```ts
try { span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) }); }
catch (spanErr) { fwLogger().debug("[withNodeSpan] span.setStatus failed:", spanErr); }
try { span.end(); }
catch (spanErr) { fwLogger().debug("[withNodeSpan] span.end failed — span may leak:", spanErr); }
```

---

## Phase 2: Correctness Fixes

### 2.1 — `handleWaveDone` fallback: pass upstream confidence to `decideRoute`

**File:** `packages/framework/src/dag-runtime/wave-resolution.ts:~95`

**Problem:** When `routingDecisions` is absent (legacy replay), the fallback calls `decideRoute(nodeId, output, outgoing)` without `upstreamConfidence`, silently disabling confidence gating.

**Context:** The pure transition layer has `DagTransitionContext` which currently has no access to `NodeDef` closures. But `DagTransitionContext` CAN carry a precomputed confidence map without closures — we extract confidence at node completion time and persist the **value** (not the extractor closure).

**Fix — Option A (minimal, correct for the transition layer):** Add `confidenceByNode: ReadonlyMap<NodeId, Confidence | null>` to `DagTransitionContext`. The executor populates it when emitting `wave-done` events. The fallback path reads from this map.

This is the correct architectural fix because:
- No closures leak into the pure transition layer
- Confidence values ARE serializable (branded POJOs)
- The executor already has the extracted confidence in `route-emission.ts`

**Changes needed:**

1. **`dag-runtime/types.ts`** — Add to `DagTransitionContext`:
   ```ts
   /** Per-node extracted confidence. Populated by executor when wave-done fires. */
   readonly confidenceByNode: ReadonlyMap<NodeId, Confidence | null>;
   ```

2. **`dag-runtime/machine.ts`** — Initialize `confidenceByNode: new Map()` in `compileDagToMachine`.

3. **`dag-runtime/executor.ts`** — When building the `wave-done` event, also pass extracted confidence values into the event payload or context update.

4. **`dag-runtime/wave-resolution.ts`** — In the fallback path:
   ```ts
   const upstreamConfidence = ctx.confidenceByNode.get(nodeId) ?? null;
   const decision = decideRoute(nodeId, newOutputs.get(nodeId), outgoing, upstreamConfidence);
   ```

5. **`dag-runtime/human-resolution.ts`** — Same pattern in `handleReroute`:
   ```ts
   const upstreamConfidence = ctx.confidenceByNode.get(nodeId) ?? null;
   const decision = decideRoute(nodeId, survivingOutputs.get(nodeId), outgoing, upstreamConfidence);
   ```

---

### 2.2 — `buildNodeInput` invariant violation → `non-retriable` classification

**File:** `packages/framework/src/shared/build-input.ts`

**Problem:** `throw new Error("BUG: required source '...' has no output")` is caught by the executor and classified as `retriability: "retriable"`. But this is a framework invariant violation — retrying produces the same error.

**Fix:** Return a Result instead of throwing. The executor already handles Result errors correctly.

```ts
import type { Result } from "../types/result.js";
import { ok, err } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import { __brandNodeId } from "../types/ids.js";

export const buildNodeInput = (
  dagInput: unknown,
  outputs: ReadonlyMap<string, unknown>,
  incoming: IncomingSources,
  nodeId?: string, // for error attribution
): Result<unknown, FrameworkError> => {
  const { required, optional } = incoming;

  for (const dep of required) {
    if (!outputs.has(dep)) {
      return err({
        kind: "node-crash" as const,
        nodeId: __brandNodeId(nodeId ?? "__unknown__"),
        retriability: "non-retriable" as const,
        message: `BUG: required source '${dep}' has no output in the outputs map. ` +
          `This indicates checkpoint corruption or a framework ordering bug.`,
      });
    }
  }

  if (optional.length > 0) {
    return ok(Object.fromEntries(
      [...required, ...optional].map((d) => [d, outputs.get(d)]),
    ));
  }
  if (required.length === 0) return ok(dagInput);
  if (required.length === 1) return ok(outputs.get(required[0]!));
  return ok(Object.fromEntries(required.map((d) => [d, outputs.get(d)])));
};
```

Then update callers (`dag-runtime/run-node.ts`, `dag-runtime/freshness-emission.ts`) to handle the Result:

```ts
const inputResult = buildNodeInput(dagInput, outputs, incoming, nodeId);
if (!inputResult.ok) return { result: inputResult, outcome: EMPTY_OUTCOME };
const input = inputResult.value;
```

---

## Phase 3: Type Safety Improvements

### 3.1 — Export `FrameworkErrorKind` type alias

**File:** `packages/framework/src/types/errors.ts`

**Fix:** Add at the end of the type declarations:
```ts
/** Discriminant union of all error kinds — use for consumer-side exhaustive switches. */
export type FrameworkErrorKind = FrameworkError["kind"];
```

**Also add to barrel:** `packages/framework/src/types/index.ts`
```ts
export type { FrameworkError, FrameworkErrorKind } from "./errors.js";
```

---

### 3.2 — Add `tryRunId`, `tryNodeId`, `tryDagId` returning Result

**File:** `packages/framework/src/types/ids.ts`

**Fix:** Add alongside existing smart constructors:
```ts
import type { Result } from "./result.js";
import { ok, err } from "./result.js";

/** Parse a string into a RunId, returning a Result instead of throwing. */
export const tryRunId = (s: string): Result<RunId, string> =>
  typeof s === "string" && ID_REGEX.test(s)
    ? ok(s as RunId)
    : err(`Invalid runId "${s}": must match ${ID_REGEX.source}`);

/** Parse a string into a NodeId, returning a Result instead of throwing. */
export const tryNodeId = (s: string): Result<NodeId, string> =>
  typeof s === "string" && ID_REGEX.test(s)
    ? ok(s as NodeId)
    : err(`Invalid nodeId "${s}": must match ${ID_REGEX.source}`);

/** Parse a string into a DagId, returning a Result instead of throwing. */
export const tryDagId = (s: string): Result<DagId, string> =>
  typeof s === "string" && ID_REGEX.test(s)
    ? ok(s as DagId)
    : err(`Invalid dagId "${s}": must match ${ID_REGEX.source}`);
```

**Also export `ID_REGEX` as a named constant:**
```ts
/** The regex used to validate all framework identifiers. Exported for client-side validation reuse. */
export const ID_PATTERN = ID_REGEX;
```

**Update barrel** (`types/index.ts`):
```ts
export { runId, nodeId, dagId, tryRunId, tryNodeId, tryDagId, ID_PATTERN } from "./ids.js";
```

---

### 3.3 — Confidence: require `raw` for numeric/logprob sources

**File:** `packages/framework/src/types/confidence.ts`

**Fix:** Overloaded smart constructor:
```ts
/** Smart constructor — the only sanctioned way to create a Confidence value. */
export function confidence(
  bucket: ConfidenceBucket,
  source: "self-reported-numeric" | "logprob",
  raw: number,
): Confidence;
export function confidence(
  bucket: ConfidenceBucket,
  source: Exclude<ConfidenceSource, "self-reported-numeric" | "logprob">,
  raw?: number | string,
): Confidence;
export function confidence(
  bucket: ConfidenceBucket,
  source: ConfidenceSource,
  raw?: number | string,
): Confidence {
  if (source === "self-reported-numeric" && typeof raw === "number" && (raw < 0 || raw > 1)) {
    throw new RangeError(
      `confidence raw value for "self-reported-numeric" must be in [0, 1], got ${raw}`,
    );
  }
  return ({ bucket, source, ...(raw !== undefined ? { raw } : {}) }) as Confidence;
}
```

---

### 3.4 — Observer event: remove hardcoded "13" count

**File:** `packages/framework/src/observer/observer.ts:86`

**Fix:**
```ts
// Before
 *   // ... all 13 event types required

// After
 *   // ... handler required for every ObserverEvent type (compiler-enforced)
```

---

## Phase 4: Comment Fixes & Documentation

### 4.1 — Add ADR cross-references to key type files

**File:** `packages/framework/src/types/confidence.ts` — add after the module JSDoc:
```ts
// @see docs/adr/0027-confidence-calibration-workflow.md
```

**File:** `packages/framework/src/types/freshness.ts` — add after module JSDoc:
```ts
// @see docs/adr/0025-freshness-witness-contract.md
```

**File:** `packages/framework/src/types/events.ts` — add near `HumanInterventionEvent`:
```ts
// @see docs/adr/0026-human-intervention-telemetry.md
```

---

### 4.2 — Fix FR-021 reference ambiguity

**File:** `packages/framework/src/nodes/llm-with-tools.ts:19`
Change "FR-021 single-shot validation retry" → "FR-021a: single-shot validation retry (tool-call variant)"

**File:** `packages/framework/src/dag-runtime/transition.ts:28`
This one says "FR-021: pure, no side effects" — verify the actual FR number. If it's a different requirement, correct it. If same spec, disambiguate with section reference.

---

### 4.3 — Add JSDoc to `createFetchNode` and `createTransformNode`

**File:** `packages/framework/src/nodes/fetch.ts`
```ts
/** Create a fetch node that retrieves external state. Defaults to `sideEffects: { kind: "reads", resource: id }`. */
```

**File:** `packages/framework/src/nodes/transform.ts`
```ts
/** Create a pure transformation node with no side effects. Maps input → output without I/O. */
```

---

### 4.4 — Add class-level JSDoc to `BufferedObserver`

**File:** `packages/framework/src/observer/buffered.ts`

Add above the class declaration:
```ts
/**
 * Buffered observer that accumulates per-run events and flushes them according
 * to a persistence policy (tail-based sampling). Implements `Observer` for event
 * ingestion and `Disposable` for resource cleanup.
 *
 * Lifecycle: construct → observe(events) → close()/[Symbol.dispose]()
 *
 * Events are buffered by runId. On `run-end`, the persistence policy decides
 * whether to flush the run's events to the downstream exporter. Stale runs
 * (no events for `staleSweepMs`) are evicted to bound memory.
 */
```

---

## Phase 5: Test Coverage

### 5.1 — Add tests for 5 missing Result combinators

**File:** `packages/framework/src/__tests__/result.test.ts` (append)

Tests to add for: `sequenceFirst`, `sequenceAll`, `orElse`, `andThenAsync`, `mapAsync`

Cover:
- `sequenceFirst` — all ok → ok(values[]), first err short-circuits, empty array → ok([])
- `sequenceAll` — all ok → ok(values[]), mixed → err(allErrors[]), empty → ok([])
- `orElse` — ok passes through, err triggers recovery fn
- `andThenAsync` — chains async on ok, short-circuits on err
- `mapAsync` — transforms async on ok, passes through err

---

## Phase 6: Architecture (rename, no code changes needed now)

### 6.1 — (Deferred) Rename `shared/` → `pure/`

Low priority. Track for a future cleanup pass. The name "shared" doesn't communicate the purity contract. All functions in this directory are pure (no I/O).

---

## Execution Order

1. **Phase 1** (1.1–1.6): Silent failure fixes — highest risk reduction
2. **Phase 2** (2.1–2.2): Correctness — confidence gating + build-input Result
3. **Phase 3** (3.1–3.4): Type exports + overloads
4. **Phase 4** (4.1–4.4): Comments and JSDoc
5. **Phase 5** (5.1): Test coverage for Result combinators

Phases 1–2 are the "must do" before merge. Phases 3–5 are quality improvements.

---

## Files Modified (summary)

| File | Changes |
|------|---------|
| `packages/framework/src/nodes/llm-with-tools.ts` | Remove `!` assertion |
| `packages/framework/src/observer/dispatch.ts` | `setTimeout` → `queueMicrotask` + enriched message |
| `packages/framework/src/observer/observer.ts` | Remove "13" hardcoded count |
| `packages/framework/src/scheduler/scheduler.ts` | Track in-flight promises, async `stop()` |
| `packages/framework/src/dag-runtime/node-span.ts` | Add debug logging to catch blocks |
| `packages/framework/src/dag-runtime/types.ts` | Add `confidenceByNode` to `DagTransitionContext` |
| `packages/framework/src/dag-runtime/wave-resolution.ts` | Pass `upstreamConfidence` in fallback |
| `packages/framework/src/dag-runtime/human-resolution.ts` | Pass `upstreamConfidence` in reroute |
| `packages/framework/src/dag-runtime/machine.ts` | Initialize `confidenceByNode` |
| `packages/framework/src/dag-runtime/executor.ts` | Populate `confidenceByNode` on wave completion |
| `packages/framework/src/shared/build-input.ts` | Return `Result` instead of throwing |
| `packages/framework/src/dag-runtime/run-node.ts` | Handle `Result` from `buildNodeInput` |
| `packages/framework/src/dag-runtime/freshness-emission.ts` | Handle `Result` from `buildNodeInput` |
| `packages/framework/src/types/errors.ts` | Export `FrameworkErrorKind` |
| `packages/framework/src/types/ids.ts` | Add `tryRunId/tryNodeId/tryDagId`, export `ID_PATTERN` |
| `packages/framework/src/types/confidence.ts` | Overloaded `confidence()` constructor |
| `packages/framework/src/types/index.ts` | Barrel updates |
| `packages/framework/src/types/events.ts` | ADR cross-reference comment |
| `packages/framework/src/types/freshness.ts` | ADR cross-reference comment |
| `packages/framework/src/nodes/fetch.ts` | JSDoc |
| `packages/framework/src/nodes/transform.ts` | JSDoc |
| `packages/framework/src/observer/buffered.ts` | Class-level JSDoc |
| `apps/customer-summary/src/bootstrap.ts` | Log eval-rubric failure + MLflow context |
| `packages/framework/src/__tests__/result.test.ts` | 5 combinator test suites |
