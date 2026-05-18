# PR Review Fix Plan — 2026-05-17

All fixes target `feat/initial-setup`. No backwards compat needed (greenfield).
Ordered by dependency — later fixes may touch files already changed by earlier ones.

---

## Fix 1: `waveNodeIds[0]` undefined when wave is empty (C1)

**File:** `packages/framework/src/dag-runtime/executor.ts:537`

**Problem:** When all nodes in a wave are pruned, `waveNodeIds` is empty and `waveNodeIds[0]` is `undefined`. This undefined value flows into a `node-failed` event's `nodeId`, violating the branded `NodeId` contract.

**Fix:** Replace `waveNodeIds[0]` fallback with `EXECUTOR_NODE_ID`:

```ts
// Before
nodeId: freshnessResult.error.kind === "node-crash" ? freshnessResult.error.nodeId : waveNodeIds[0],

// After
nodeId: freshnessResult.error.kind === "node-crash" ? freshnessResult.error.nodeId : (waveNodeIds[0] ?? EXECUTOR_NODE_ID),
```

**Test:** Add test in `packages/framework/src/__tests__/freshness-emission.test.ts` that exercises the empty-wave path.

---

## Fix 2: Formalize `crash` on `EvalJudgeResult`, remove `as any` (C2)

**File:** `packages/framework/src/types/eval-judge.ts`  
**File:** `packages/framework/src/dag-runtime/eval-judges.ts:143`

**Problem:** `EvalJudgeResult` already has `crash?: { kind: "judge-crash"; message: string }` on the type — it was added to the type but the consumer in `eval-judges.ts` still uses `(r as any).crash` instead of accessing the typed field.

**Fix:** Replace the `as any` cast with the typed property access:

```ts
// Before
judgesCrashed: meta.evalJudgeResults?.some((r) => !!(r as any).crash) ?? false,

// After
judgesCrashed: meta.evalJudgeResults?.some((r) => r.crash !== undefined) ?? false,
```

---

## Fix 3: Runtime guard on `setFrameworkLogger` (C3)

**File:** `packages/framework/src/logger.ts`

**Problem:** JSDoc says undefined is rejected but there's no runtime check. A `setFrameworkLogger(undefined!)` call nulls out the logger, causing `fwLogger().error()` to throw at call sites.

**Fix:**

```ts
export const setFrameworkLogger = (logger: FrameworkLogger): void => {
  if (logger == null) {
    throw new TypeError("setFrameworkLogger: logger must not be null or undefined");
  }
  _logger = logger;
};
```

**Test:** Add a test in a new `packages/framework/src/__tests__/logger.test.ts` asserting `setFrameworkLogger(null as any)` throws `TypeError`.

---

## Fix 4: Rethrow async observer rejections under `OBSERVER_STRICT` (I1)

**File:** `packages/framework/src/observer/buffered.ts`

**Problem:** `dispatchEvent` catches synchronous throws and rethrows under `OBSERVER_STRICT`, but the thenable guard only logs async rejections — it never rethrows. A buggy async observer in test mode silently drops errors.

**Fix:** In the thenable guard, rethrow the rejection when `OBSERVER_STRICT` is enabled:

```ts
// Before
if (result !== null && result !== undefined && typeof (result as { catch?: unknown }).catch === "function") {
  (result as Promise<void>).catch((e) => {
    fwLogger().error(
      `[observer] async observe() rejected for ${event.type} — Observer.observe must be synchronous:`,
      e instanceof Error ? e.message : e,
    );
  });
}

// After
if (result !== null && result !== undefined && typeof (result as { catch?: unknown }).catch === "function") {
  (result as Promise<void>).catch((e) => {
    fwLogger().error(
      `[observer] async observe() rejected for ${event.type} — Observer.observe must be synchronous:`,
      e instanceof Error ? e.message : e,
    );
    if (OBSERVER_STRICT) {
      // Re-throw as unhandled rejection so tests surface the async bug.
      // In strict mode, async observers are programming errors that must not be swallowed.
      throw e instanceof Error ? e : new Error(String(e));
    }
  });
}
```

**Test:** Add test in `packages/framework/src/__tests__/buffered-observer.test.ts` under `OBSERVER_STRICT=1` confirming an async observer's rejection surfaces.

---

## Fix 5: Bound `InMemoryFreshnessIndex` LRU eviction scan (I2)

**File:** `packages/framework/src/dag-runtime/freshness-check.ts`

**Problem:** The eviction loop `while (evictCursor < resourceOrder.length)` can scan the full array if every candidate has been deleted, degrading to O(n) under high churn.

**Fix:** Cap the eviction scan to a bounded number of iterations (e.g. 100). If no live candidate is found within the budget, fall back to the first entry in the `writes` Map (which is the oldest insertion-order key):

```ts
async recordWrite(event: WriteAttemptedEvent): Promise<Result<void, FrameworkError>> {
  const resource = event.newWitness.resource;
  const entry: WriteEntry = { ... };
  if (!this.writes.has(resource)) {
    if (this.writes.size >= this.maxResources) {
      // Bounded scan: try up to 100 candidates before falling back to Map iteration order
      const MAX_SCAN = 100;
      let evicted = false;
      for (let i = 0; i < MAX_SCAN && this.evictCursor < this.resourceOrder.length; i++) {
        const candidate = this.resourceOrder[this.evictCursor]!;
        this.evictCursor++;
        if (this.writes.has(candidate)) {
          this.writes.delete(candidate);
          this.latest.delete(candidate);
          evicted = true;
          break;
        }
      }
      // Fallback: if scan budget exhausted, evict the first live key via Map iteration
      if (!evicted) {
        const firstKey = this.writes.keys().next().value;
        if (firstKey !== undefined) {
          this.writes.delete(firstKey);
          this.latest.delete(firstKey);
        }
      }
      // Compact when cursor has consumed more than half
      if (this.evictCursor > this.resourceOrder.length / 2) {
        this.resourceOrder.splice(0, this.evictCursor);
        this.evictCursor = 0;
      }
    }
    this.resourceOrder.push(resource);
  }
  // ... rest unchanged
}
```

**Test:** Add property test in `packages/framework/src/__tests__/freshness-check-property.test.ts` confirming that after `maxResources + 1000` writes to unique resources, size never exceeds `maxResources`.

---

## Fix 6: Validate `__date__` strings in `deserializeValue` (I3)

**File:** `packages/framework/src/state-machine/serialize.ts`

**Problem:** A malformed date string like `"not-a-date"` produces `Invalid Date` silently. This can propagate through checkpoint-resume.

**Fix:**

```ts
// Before
if (DATE_TAG in obj && typeof obj[DATE_TAG] === "string") {
  return new Date(obj[DATE_TAG] as string);
}

// After
if (DATE_TAG in obj && typeof obj[DATE_TAG] === "string") {
  const d = new Date(obj[DATE_TAG] as string);
  if (isNaN(d.getTime())) {
    throw new Error(`deserializeValue: invalid date string "${obj[DATE_TAG]}"`);
  }
  return d;
}
```

**Test:** Add test in `packages/framework/src/__tests__/serialize-roundtrip.test.ts` asserting `fromJson('{"__date__":"not-a-date"}')` throws.

---

## Fix 7: Inject clock into `RedisCheckpointer.load()` (I4)

**File:** `packages/framework/src/checkpoint/redis-checkpointer.ts`

**Problem:** The TTL expiry check uses `new Date()` instead of an injectable clock, inconsistent with the rest of the framework and untestable.

**Fix:** Add a `now` option to the constructor (matching `InMemoryCheckpointer`):

```ts
export class RedisCheckpointer implements Checkpointer {
  private saveNodeSha: string | null = null;
  private readonly now: () => number;

  constructor(private readonly redis: Redis, opts?: { readonly now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  async load(...): Promise<Result<RunState | null, FrameworkError>> {
    // ...
    // Before:
    // const now = new Date();
    // if (now.getTime() - createdAt.getTime() > TTL_SECONDS * 1000) {

    // After:
    const nowMs = this.now();
    if (nowMs - createdAt.getTime() > TTL_SECONDS * 1000) {
    // ...
  }
}
```

**Test:** Existing Redis checkpointer tests already skip in CI. The injectable clock makes the expiry path testable without Redis — add a unit test for the expiry logic in the existing `redis-checkpointer.test.ts`.

---

## Fix 8: Guard `onTimerFire` against synchronous throws (I5)

**File:** `packages/framework/src/scheduler/scheduler.ts`

**Problem:** If `now()` (or `activeRegistry.get`) throws synchronously inside `onTimerFire`, the error escapes the `void handleFire(...)` chain's `.catch()` because the throw happens before the Promise is created.

**Fix:** Wrap the body of `onTimerFire` in a try-catch:

```ts
function onTimerFire(taskId: string): void {
  try {
    const current = activeRegistry.get(taskId);
    if (current === undefined) return;
    const triggeredAt = now();
    void handleFire(current, triggeredAt)
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
      });
  } catch (e) {
    fwLogger().error(`[CronScheduler] onTimerFire threw synchronously for "${taskId}":`, e);
    // Attempt backoff scheduling even on sync throw
    const n = (consecutiveFailures.get(taskId) ?? 0) + 1;
    consecutiveFailures.set(taskId, n);
    const stillActive = activeRegistry.get(taskId);
    if (stillActive !== undefined) rescheduleTaskWithBackoff(stillActive, n);
  }
}
```

---

## Fix 9: Log thrown predicates via `fwLogger()` (S1)

**File:** `packages/framework/src/types/dag.ts` — `evaluatePredicate`

**Problem:** A throwing predicate `check` is silently classified as `matched: false` with `reason: "threw: ..."`. Operators can miss buggy predicates because the error only appears in the routing evidence, not in structured logs.

**Fix:** Add `fwLogger()` import and log the error:

```ts
// In the catch block of evaluatePredicate:
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  fwLogger().warn(`[evaluatePredicate] Predicate "${pred.label}" (v${pred.version}) threw: ${msg}`);
  return {
    predicateLabel: pred.label,
    predicateVersion: pred.version,
    matched: false,
    evaluatedConfidence: confidence,
    reason: `threw: ${msg}`,
  };
}
```

Note: `types/dag.ts` currently has zero runtime imports from non-type modules. Adding `fwLogger` from `../logger.js` is acceptable because `evaluatePredicate` is already a runtime function (not a pure type). The alternative — passing a logger as parameter — would change every call site for marginal benefit.

---

## Fix 10: Add `Disposable` to `InMemoryMarkerStore` (S7)

**File:** `packages/framework/src/queue/in-memory.ts`

**Problem:** `InMemoryMarkerStore` creates `setTimeout` handles that leak if the store is discarded without clearing all keys.

**Fix:** Return a `Disposable` object with a `close()` method that clears all timers:

```ts
export interface InMemoryMarkerStoreHandle extends MarkerStore, Disposable {
  /** Cancel all pending TTL timers. Call when discarding the store. */
  close(): void;
}

export function createInMemoryMarkerStore(): InMemoryMarkerStoreHandle {
  const markers = new Map<string, ReturnType<typeof setTimeout>>();

  const close = (): void => {
    for (const handle of markers.values()) clearTimeout(handle);
    markers.clear();
  };

  return {
    async set(key: string, ttlSeconds: number): Promise<void> {
      // ... existing logic unchanged ...
    },
    async exists(key: string): Promise<boolean> {
      return markers.has(key);
    },
    async delete(key: string): Promise<void> {
      // ... existing logic unchanged ...
    },
    close,
    [Symbol.dispose](): void {
      close();
    },
  };
}
```

Update exports in `packages/framework/src/queue/index.ts` and `packages/framework/src/index.ts` to include `InMemoryMarkerStoreHandle` type.

---

## Fix 11: Cheaper `stateKey` derivation (S4)

**File:** `packages/framework/src/dag-runtime/machine.ts`

**Problem:** `stateKey` calls `JSON.stringify(phase)` on every transition. For `awaiting-human` phases that carry `output: unknown`, this serializes the entire node output on every transition — expensive in the hot retry loop.

**Fix:** Replace with a discriminant-based key that captures enough to distinguish states without serializing payloads:

```ts
stateKey: (phase) => {
  switch (phase.kind) {
    case "pending":
      return "pending";
    case "running":
      return `running:${phase.wave}`;
    case "retrying":
      return `retrying:${phase.wave}:${phase.nodeId}:${phase.attempt}`;
    case "retrying-hook":
      return `retrying-hook:${phase.nodeId}:${phase.attempt}`;
    case "awaiting-human":
      return `awaiting-human:${phase.nodeId}:${phase.wave}`;
    case "succeeded":
      return "succeeded";
    case "failed":
      return `failed:${phase.error.kind}`;
  }
},
```

This is exhaustive (same DagPhase variants as the switch in `stateProgress`). The runner uses `stateKey` for dedup-key derivation and self-loop detection — both only need to distinguish *which* state we're in, not what data it carries.

**Test:** Verify the existing `dag-transition-property.test.ts` and `dag-runtime-stateful.test.ts` still pass. The dedup-key tests should verify that distinct transitions produce distinct keys.

---

## Fix 12: Type-safe OpenAI conversation array (S3)

**File:** `packages/framework/src/llm/openai-client.ts`

**Problem:** The conversation array is `Array<Record<string, unknown>>` — any shape can be pushed, risking silent malformation.

**Fix:** Define local discriminated message types and type the array:

```ts
type ConversationItem =
  | { readonly role: "developer"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | ResponsesOutputItem
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string };

// In sendWithTools:
const conversation: ConversationItem[] = [
  { role: "developer", content: req.system },
  { role: "user", content: req.user },
];
```

Then update the `body` construction to cast `conversation` to the body's `input` field:

```ts
input: conversation as unknown as Record<string, unknown>[],
```

The single cast at the serialization boundary is safer than having every `.push()` untyped. The `for (const item of output) conversation.push(item)` and `buildToolResultItems` pushes will now be type-checked.

Update `buildToolResultItems` return type to match `ConversationItem`:

```ts
const buildToolResultItems = (
  results: readonly ToolDispatchResult[],
): Array<{ type: "function_call_output"; call_id: string; output: string }> =>
  results.map((r) => ({
    type: "function_call_output" as const,
    call_id: r.id,
    output: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
  }));
```

---

## Fix 13: Rename `sequence` / `collectAll` for clarity (S2)

**File:** `packages/framework/src/types/result.ts`  
**File:** `packages/framework/src/types/index.ts`

**Problem:** `sequence` short-circuits on first error → `Err<E>`, while `collectAll` accumulates → `Err<E[]>`. The names don't convey the difference.

**Fix:** Since no backwards compat needed, rename:
- `sequence` → `sequenceFirst` (returns first error)
- `collectAll` → `sequenceAll` (returns all errors)

Search-and-replace across all consumers:

```bash
rg 'sequence\b' packages/ apps/ --type ts -l  # find all usages
rg 'collectAll' packages/ apps/ --type ts -l
```

Update the barrel export in `types/index.ts` accordingly.

---

## Fix 14: Generic `tryCatch` / `tryCatchAsync` (S6)

**File:** `packages/framework/src/types/result.ts`

**Problem:** These always erase the specific error type to `Error`. Framework code should use `FrameworkError`-aware patterns, but the general combinators lose the error type identity.

**Fix:** Add generic overloads that let the caller narrow the error type:

```ts
/** Wrap a throwing function in a Result. Catches synchronous exceptions. */
export function tryCatch<T>(fn: () => T): Result<T, Error>;
export function tryCatch<T, E>(fn: () => T, mapError: (e: unknown) => E): Result<T, E>;
export function tryCatch<T, E = Error>(fn: () => T, mapError?: (e: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (e) {
    if (mapError) return err(mapError(e));
    return err((e instanceof Error ? e : new Error(String(e))) as E);
  }
}

/** Wrap an async throwing function in a Result. */
export function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>>;
export function tryCatchAsync<T, E>(fn: () => Promise<T>, mapError: (e: unknown) => E): Promise<Result<T, E>>;
export async function tryCatchAsync<T, E = Error>(fn: () => Promise<T>, mapError?: (e: unknown) => E): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (mapError) return err(mapError(e));
    return err((e instanceof Error ? e : new Error(String(e))) as E);
  }
}
```

This is backwards-compatible (no second arg = same behavior as before) but since we don't need compat, the overloads are just for ergonomics.

---

## Execution Order

Fixes are independent and can be done in any order, but grouping by file minimizes merge conflicts:

1. **Fix 2** (eval-judges.ts — one-line `as any` removal)
2. **Fix 1** (executor.ts — one-line fallback)
3. **Fix 3** (logger.ts — add guard)
4. **Fix 4** (buffered.ts — async strict rethrow)
5. **Fix 5** (freshness-check.ts — bounded eviction)
6. **Fix 6** (serialize.ts — date validation)
7. **Fix 7** (redis-checkpointer.ts — inject clock)
8. **Fix 8** (scheduler.ts — sync throw guard)
9. **Fix 9** (types/dag.ts — log predicates)
10. **Fix 10** (queue/in-memory.ts — Disposable marker store)
11. **Fix 11** (dag-runtime/machine.ts — cheaper stateKey)
12. **Fix 12** (llm/openai-client.ts — typed conversation)
13. **Fix 13** (types/result.ts + barrel — rename sequence/collectAll)
14. **Fix 14** (types/result.ts — generic tryCatch)

After all fixes: `bun run typecheck && bun test`
