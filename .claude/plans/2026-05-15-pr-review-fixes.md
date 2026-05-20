# PR Review Fix Plan

All 15 findings from the comprehensive review, ordered by dependency.  
No backwards compat needed (greenfield branch).

**Dropped findings (false positives on deeper inspection):**
- **#7 (two observer dispatch paths):** `emit.ts` already routes through `dispatchEvent` with error isolation. No fix needed.
- **#8 (void handleFire):** The `.then()/.catch()` chain is complete — standard fire-and-forget from `setTimeout`. No fix needed.
- **#13 (ADR numbering CI):** Not a code fix. Out of scope.

---

## Wave 1 — Type & Interface Changes

These change signatures that cascade to implementations and tests. Do all of Wave 1 before touching implementations.

### 1.1 Define `FrameworkAugmentedError` (Critical #1)

**File:** `packages/framework/src/types/errors.ts`

Add a typed error class to replace the `as any` casts in `runDagAsWorkerJob`:

```ts
/**
 * Error subclass thrown by `runDagAsWorkerJob` so queue adapters (BullMQ)
 * can access the structured framework error after serialization round-trips.
 */
export class FrameworkAugmentedError extends Error {
  readonly frameworkErrorKind: FrameworkError["kind"];
  readonly frameworkErrorJson: string;

  constructor(message: string, error: FrameworkError) {
    super(message, { cause: error });
    this.name = "FrameworkAugmentedError";
    this.frameworkErrorKind = error.kind;
    this.frameworkErrorJson = JSON.stringify(error);
  }
}
```

Export from `types/index.ts` barrel.

### 1.2 Change `FreshnessIndex` port to return `Result` (Critical #2, #3)

**File:** `packages/framework/src/dag-runtime/freshness-check.ts`

Change the `FreshnessIndex` interface:

```ts
export interface FreshnessIndex {
  recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>>;
  findConflict(
    resource: string,
    conditionedOnValue: string,
    sinceMs: number,
  ): Promise<Result<WriteEntry | null, FrameworkError>>;
}
```

Import `Result`, `FrameworkError`, `ok`, `err` at the top of the file.

### 1.3 Make `computeRunSummary.totalCostUsd` honest (Suggestion #12)

**File:** `packages/framework/src/observer/buffered.ts`

The observer-event data plane doesn't carry cost data. The OTel `TailSamplingProcessor` computes it separately from span attributes. Fix: make `totalCostUsd` optional on `RunSummary` and stop lying with `0`:

```ts
export interface RunSummary {
  // ... existing fields ...
  /** 
   * Sum of LLM cost from OTel spans. Present only when computed by
   * TailSamplingProcessor; undefined in the BufferedObserver path 
   * (observer events don't carry cost).
   */
  readonly totalCostUsd?: number;
  // ...
}
```

In `computeRunSummary`: remove the `totalCostUsd: 0` line entirely (field left `undefined`).

In `TailSamplingProcessor`: already computes it — no change needed.

Update `PersistencePolicy` consumers and tests that read `totalCostUsd` to handle `undefined`.

---

## Wave 2 — Implementations

### 2.1 `InMemoryFreshnessIndex` — return `Result` (Critical #2, #3 cont.)

**File:** `packages/framework/src/dag-runtime/freshness-check.ts`

Wrap return values:

```ts
async recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>> {
  // ... existing logic ...
  return ok(undefined);
}

async findConflict(...): Promise<Result<WriteEntry | null, FrameworkError>> {
  // ... existing logic ...
  return ok(latest);  // or ok(null)
}
```

The in-memory impl never errors — every path returns `ok(...)`.

### 2.2 `RedisFreshnessIndex` — propagate errors via `Result` (Critical #2, #3 cont.)

**File:** `packages/framework/src/checkpoint/redis-freshness-index.ts`

**`recordWrite`**: Replace swallowed catch with `err(...)` return:

```ts
async recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>> {
  try {
    // ... existing ZADD + EXPIRE logic ...
    this.onSuccess();
    return ok(undefined);
  } catch (e) {
    this.onFailure(e);
    return err({
      kind: "cache-error",
      operation: "freshness:recordWrite",
      message: `resource '${event.newWitness.resource}': ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
```

**`findConflict`**: Replace swallowed catch with `err(...)` return. Remove `degradedChecks` counter (the error is now surfaced to callers who decide policy):

```ts
async findConflict(...): Promise<Result<WriteEntry | null, FrameworkError>> {
  try {
    // ... existing ZREVRANGEBYSCORE logic ...
    this.onSuccess();
    return ok(conflict ?? null);
  } catch (e) {
    this.onFailure(e);
    return err({
      kind: "cache-error",
      operation: "freshness:findConflict",
      message: `resource '${resource}': ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
```

Remove `_degradedChecks` field and its getter (no longer needed — callers see the error directly).

### 2.3 `freshness-emission.ts` — handle `Result` from index calls

**File:** `packages/framework/src/dag-runtime/freshness-emission.ts`

Current code already has try/catch around `freshnessIndex.findConflict` and `recordWrite` calls with fail-closed semantics. Replace with Result unwrapping:

```ts
// findConflict
const conflictResult = await freshnessIndex.findConflict(
  conditionedOn.resource,
  conditionedOn.value,
  0,
);
if (!conflictResult.ok) {
  fwLogger().error(`[emitFreshnessWitnessEvents] findConflict failed: ${conflictResult.error.message}`);
  emit(nodeCtx, { /* existing node-error event */ });
  // Fail-closed: synthetic conflict
  conflict = { runId: nodeCtx.runId, nodeId, newWitness: conditionedOn, succeededAtMs: 0 };
} else {
  conflict = conflictResult.value;
}

// recordWrite
const writeResult = await freshnessIndex.recordWrite(writeEvent);
if (!writeResult.ok) {
  fwLogger().error(`[emitFreshnessWitnessEvents] recordWrite failed: ${writeResult.error.message}`);
  emit(nodeCtx, { /* existing node-error event */ });
}
```

Remove the surrounding try/catch blocks for those calls since the index now returns `Result` instead of throwing.

### 2.4 `runDagAsWorkerJob` — use `FrameworkAugmentedError` (Critical #1 cont.)

**File:** `packages/framework/src/dag-runtime/run-dag-stateful.ts`

Replace:
```ts
const thrownError = new Error(`runDagAsWorkerJob: DAG '${dag.id}' failed: ${detail}`, {
  cause: result.error,
});
(thrownError as any).frameworkErrorKind = result.error.kind;
(thrownError as any).frameworkError = JSON.stringify(result.error);
throw thrownError;
```

With:
```ts
throw new FrameworkAugmentedError(
  `runDagAsWorkerJob: DAG '${dag.id}' failed: ${detail}`,
  result.error,
);
```

Import `FrameworkAugmentedError` from `../types/errors.js`.

### 2.5 `normalizeEdge` — use `__brandNodeId` (Important #6)

**File:** `packages/framework/src/types/dag.ts`

Replace raw casts with branded constructors:

```ts
import { __brandNodeId } from "./ids.js";

export const normalizeEdge = (e: EdgeDefRawInput): EdgeDef => {
  if ("kind" in e && e.kind === "default") {
    return { from: __brandNodeId(e.from), to: __brandNodeId(e.to), kind: "default" };
  }
  if ("when" in e) {
    return { from: __brandNodeId(e.from), to: __brandNodeId(e.to), kind: "conditional", when: e.when };
  }
  return { from: __brandNodeId(e.from), to: __brandNodeId(e.to), kind: "unconditional" };
};
```

`__brandNodeId` is the right choice (not `nodeId()`) because callers validated the string upstream via `defineDag`.

### 2.6 `evaluatePredicate` — log on caught exception (Suggestion #10)

**File:** `packages/framework/src/types/dag.ts`

The `types/` layer must not depend on `logger.ts` (wrong layer direction). Instead, return the exception message in the `reason` field (already done: `reason: "threw: ${msg}"`). The caller (`route-emission.ts`) should log it.

**File:** `packages/framework/src/dag-runtime/route-emission.ts`

After calling `evaluatePredicate`, when `result.reason?.startsWith("threw:")`:

```ts
fwLogger().warn(`[route-emission] predicate '${result.predicateLabel}' threw for node '${nodeId}': ${result.reason}`);
```

### 2.7 Fix `sleep()` abort propagation (Suggestion #14)

**File:** `packages/framework/src/dag-runtime/executor.ts`

The `sleep` function already resolves immediately on pre-aborted signal. The issue is the retry loop doesn't check abort *after* sleep. Fix: in the `retrying` branch, after `sleep()`, check abort before calling `runWave`:

```ts
.with({ kind: "retrying" }, async (p) => {
  // ... sleep logic ...
  await sleep(delayWithJitter, nodeCtx.signal);
  if (nodeCtx.signal?.aborted) {
    return { type: "abort", reason: "signal" } satisfies DagEvent;
  }
  return runWave(p.wave, machineCtx, waveConfig);
})
```

Same for `retrying-hook`:

```ts
.with({ kind: "retrying-hook" }, async (p) => {
  // ... sleep logic ...
  await sleep(delayWithJitter, nodeCtx.signal);
  if (nodeCtx.signal?.aborted) {
    return { type: "abort", reason: "signal" } satisfies DagEvent;
  }
  // ... continue with hook call ...
})
```

### 2.8 Fix `InMemoryFreshnessIndex` O(n) eviction (Important #9)

**File:** `packages/framework/src/dag-runtime/freshness-check.ts`

Replace the `string[]` + `shift()` pattern with a cursor-based ring approach:

```ts
private readonly resourceOrder: string[] = [];
private evictCursor = 0;
```

Replace `this.resourceOrder.shift()` with:

```ts
if (this.writes.size >= this.maxResources) {
  // Find the next valid key to evict (oldest insertion order)
  while (this.evictCursor < this.resourceOrder.length) {
    const candidate = this.resourceOrder[this.evictCursor]!;
    this.evictCursor++;
    if (this.writes.has(candidate)) {
      this.writes.delete(candidate);
      this.latest.delete(candidate);
      break;
    }
  }
}
```

On `clear()`, also reset `this.evictCursor = 0`.

This gives O(1) amortized eviction without shifting the array.

### 2.9 `Cache.get` — accept Zod schema for validation (Suggestion #11)

**File:** `packages/framework/src/cache/cache.ts`  
**File:** `packages/framework/src/cache/redis-cache.ts`

**Low priority** — no callers currently pass the `validate` param. `InMemoryCache.get` doesn't even accept it in its implementation despite the interface declaring it.

When a caller needs it: change from `(v: unknown) => boolean` to `z.ZodType<T>` so rejection reasons are structured. For now, remove the unused `validate` parameter from the `Cache` interface to stop lying about capabilities:

```ts
export interface Cache {
  get<T>(key: string): Promise<Result<T | null, FrameworkError>>;
  set<T>(key: string, value: T, ttlSec: number): Promise<Result<void, FrameworkError>>;
}
```

Remove the `validate` param from `RedisCache.get` and the dead validation branch.

### 2.10 Replace `console.*` in app with structured logger (Important #4)

**File:** `apps/customer-summary/src/bootstrap.ts`  
**File:** `apps/customer-summary/src/server.ts`  
**File:** `apps/customer-summary/src/index.ts`  
**File:** `apps/customer-summary/src/dag/nodes/assemble-response.ts`

The framework already exports `setFrameworkLogger` and `fwLogger`. The app should:

1. In `bootstrap.ts`, create a structured logger (or use the framework's `consoleLogger`):

```ts
import { setFrameworkLogger, fwLogger } from "@ai-summary/framework";

// At bootstrap start:
const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(msg, ...args),  
  warn: (msg: string, ...args: unknown[]) => console.warn(msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(msg, ...args),
};
```

Wait — the framework `FrameworkLogger` type is `{ warn, error }`. The app needs an app-level logger with `info` too. 

Better approach: define an `AppLogger` type in the app and thread it through `AppDeps`:

```ts
// apps/customer-summary/src/logger.ts (new file)
export interface AppLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export const consoleAppLogger: AppLogger = {
  info: (msg, ...args) => console.log(msg, ...args),
  warn: (msg, ...args) => console.warn(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
};
```

Then in `AppDeps`:
```ts
readonly logger: AppLogger;
```

Thread through `createApp`, `bootstrap`, replace all `console.*` with `deps.logger.*` / `logger.*`. This makes the app testable (inject a recording logger in tests) and swappable to a structured JSON logger for production.

---

## Wave 3 — Tests

### 3.1 Property tests for `evaluatePredicate` with confidence gating (Suggestion #15)

**File:** `packages/framework/src/__tests__/evaluate-predicate-property.test.ts` (new)

```ts
import { fc } from "@fast-check/vitest";
import { evaluatePredicate } from "../types/dag.js";

// Arbitraries:
const arbBucket = fc.constantFrom("high", "medium", "low", "unknown");
const arbSource = fc.constantFrom("self-reported-bucket", "logprob", "heuristic", ...);
const arbConfidence = fc.record({ bucket: arbBucket, source: arbSource });
const arbConfidenceOrNull = fc.option(arbConfidence, { nil: null });

// Properties:
// 1. When minConfidence is set and confidence is null → matched: false, reason: "below-min-confidence"
// 2. When minConfidence is set and bucket < minConfidence → matched: false
// 3. When check throws → matched: false, reason starts with "threw:"
// 4. When check returns true → matched: true
// 5. predicateLabel is always preserved in output
```

### 3.2 Unit tests for untested critical files (Important #5)

Priority order (highest impact first):

**3.2a** `packages/framework/src/__tests__/wave-resolution.test.ts` (new)
- `handleWaveDone`: merge outputs, routing decisions, HITL queue ordering
- `advanceToNextWave`: next wave, terminal success, output-missing fallback
- `collectHumanReviewQueue`: deterministic ascending sort

**3.2b** `packages/framework/src/__tests__/retry-policy.test.ts` (new)
- `handleNodeFailed`: budget tracking, retry vs exhaust, co-failed siblings
- `handleHookCrash`: hook retry budget, escalation to failed

**3.2c** `packages/framework/src/__tests__/human-resolution.test.ts` (new)
- `handleHumanResponse`: approve, reject, reroute, approve-with-edit
- Pending review queue advancement
- Invalid reroute target handling

**3.2d** `packages/framework/src/__tests__/capabilities-validation.test.ts` (new)
- Single missing capability → Err with all missing pairs
- Multiple missing capabilities → all surfaced in one pass
- All present → Ok with ValidatedNodeContext brand
- Empty requires → always Ok

**3.2e** `packages/framework/src/__tests__/build-input.test.ts` (new)
- Required sources present → merged input
- Optional sources missing → undefined in merged
- No upstream outputs → dag input only

**3.2f** `packages/framework/src/__tests__/json-patch.test.ts` (new)
- Object diff: added/removed/changed keys
- Array diff
- Nested objects
- Identical inputs → empty patch

**3.2g** `packages/framework/src/__tests__/confidence-buckets.test.ts` (new)  
(Note: `confidence-bucket-ordering.test.ts` exists — this covers the `sugar/confidence-buckets.ts` helpers)
- Bucket construction helpers
- Round-trip from raw → bucket → comparison

**3.2h** `packages/framework/src/__tests__/error-factories.test.ts` (new)
- Each factory function produces correct `kind`
- `formatFrameworkError` is exhaustive (already tested in `format-framework-error.test.ts` but factories aren't)

### 3.3 Tests for the FreshnessIndex `Result` changes

**File:** `packages/framework/src/__tests__/freshness-check.test.ts` (update)

Add cases:
- `InMemoryFreshnessIndex.recordWrite` returns `ok(undefined)`
- `InMemoryFreshnessIndex.findConflict` returns `ok(null)` / `ok(entry)`

**File:** `packages/framework/src/__tests__/redis-freshness-index.test.ts` (update)

Add cases:
- `recordWrite` returns `err(cache-error)` on Redis failure
- `findConflict` returns `err(cache-error)` on Redis failure
- Verify `degradedChecks` field is removed

### 3.4 Test for `FrameworkAugmentedError`

**File:** `packages/framework/src/__tests__/format-framework-error.test.ts` (update)

Add:
- `FrameworkAugmentedError` preserves `kind`, `cause`, and JSON serialization
- BullMQ-style `JSON.parse(err.frameworkErrorJson)` round-trips

---

## Execution Order

```
Wave 1 (types/interfaces — 3 changes):
  1.1  FrameworkAugmentedError type
  1.2  FreshnessIndex port → Result
  1.3  RunSummary.totalCostUsd → optional

Wave 2 (implementations — 10 changes):
  2.1  InMemoryFreshnessIndex → Result returns
  2.2  RedisFreshnessIndex → Result returns
  2.3  freshness-emission.ts → handle Results
  2.4  runDagAsWorkerJob → FrameworkAugmentedError
  2.5  normalizeEdge → __brandNodeId
  2.6  route-emission.ts → log predicate throws
  2.7  executor.ts → abort check after sleep
  2.8  InMemoryFreshnessIndex → O(1) eviction
  2.9  RedisCache.get → Zod schema validator
  2.10 App console.* → structured AppLogger

Wave 3 (tests — 12 files):
  3.1  evaluatePredicate property tests
  3.2a wave-resolution unit tests
  3.2b retry-policy unit tests
  3.2c human-resolution unit tests
  3.2d capabilities-validation unit tests
  3.2e build-input unit tests
  3.2f json-patch unit tests
  3.2g confidence-buckets unit tests
  3.2h error-factories unit tests
  3.3  freshness-check Result tests
  3.4  FrameworkAugmentedError tests
```

**Estimated scope:** ~25 files touched, ~15 new test files, ~600-800 lines of new test code.

**Verification after each wave:**
```bash
bun run typecheck   # must pass after Wave 1 + 2
bun test            # must pass after each wave (1088+ pass, 0 fail)
```
