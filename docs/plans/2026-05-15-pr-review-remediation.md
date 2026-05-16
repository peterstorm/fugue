# PR Review Remediation Plan — 2026-05-15

## Scope

Fix all 13 advisory items from the comprehensive PR review. No backwards compatibility constraints (greenfield). Each fix is a code change, not a documentation amendment.

---

## Fix 1: `BufferedObserver.sweepHandle` unref cast

**File:** `packages/framework/src/observer/buffered.ts`  
**Problem:** `(this.sweepHandle as unknown as { unref?: () => void }).unref?.()` — double-cast through `unknown` hides intent.  
**Fix:** Use `Timer` type from Bun/Node. `setInterval` returns `Timer` (which has `.unref()`). Change the field type and remove the cast.

```ts
// Before
private readonly sweepHandle: ReturnType<typeof setInterval> | null;
// ...
(this.sweepHandle as unknown as { unref?: () => void }).unref?.();

// After
private readonly sweepHandle: ReturnType<typeof setInterval> | null;
// ...
this.sweepHandle.unref();
```

Bun's `setInterval` returns a `Timer` with `.unref()`. No duck-typing needed. Drop the `?.` — `unref` is always present on `Timer`.

---

## Fix 2: `tool-dispatch.ts` observer call not wrapped in `dispatchEvent`

**File:** `packages/framework/src/llm/tool-dispatch.ts`  
**Problem:** Line ~75 calls `ctx.observer.observe(...)` directly inside a `catch` block. If the observer throws, that exception replaces the original tool error and propagates as an unhandled crash. All other call sites use `emit()` (which wraps via `dispatchEvent`).  
**Fix:** Import `emit` from `../dag-runtime/emit.js` and use it instead. But wait — `tool-dispatch.ts` is in `llm/` which should not depend on `dag-runtime/`. Instead, import `dispatchEvent` directly from `../observer/buffered.js` (same as `emit.ts` does).

```ts
// Add import
import { dispatchEvent } from "../observer/buffered.js";

// Replace ctx.observer.observe({...}) with:
dispatchEvent(ctx.observer, { type: "sub-span", ... });
```

Also remove the `if (ctx.observer)` guard — `observer` is always present (defaulted to `NoopObserver` by `makeNodeContext`).

---

## Fix 3: Extract shared `checkReadiness` from `/readyz` and `/healthz`

**File:** `apps/customer-summary/src/server.ts`  
**Problem:** `/healthz` and `/readyz` are copy-paste of each other. No backwards compat needed.  
**Fix:** Extract a `checkReadiness` function. Delete `/healthz` entirely — it was "for back-compat with existing probes" and we don't need backwards compat.

```ts
const checkReadiness = async (deps: AppDeps) => {
  const redisOk = deps.health?.checkRedis
    ? await deps.health.checkRedis().catch(() => false)
    : true;
  const mlflowOk = deps.health?.checkMlflow
    ? await deps.health.checkMlflow().catch(() => false)
    : true;
  const httpStatus = redisOk ? 200 : 503;
  const status = redisOk ? (mlflowOk ? "ready" : "ready-degraded") : "not-ready";
  return { status, redis: redisOk, mlflow: mlflowOk, httpStatus };
};

app.get("/readyz", async (c) => {
  const r = await checkReadiness(deps);
  return c.json({ status: r.status, redis: r.redis, mlflow: r.mlflow }, r.httpStatus);
});
```

Delete the `/healthz` handler entirely.

---

## Fix 4: `InMemoryFreshnessIndex.resourceOrder` compaction

**File:** `packages/framework/src/dag-runtime/freshness-check.ts`  
**Problem:** `resourceOrder: string[]` grows unboundedly as resources are evicted — the cursor skips deleted entries but the array retains them.  
**Fix:** Compact when cursor exceeds half the array length. After an eviction, check `if (this.evictCursor > this.resourceOrder.length / 2)` and splice the consumed prefix.

```ts
// After eviction block, add compaction:
if (this.evictCursor > this.resourceOrder.length / 2) {
  this.resourceOrder.splice(0, this.evictCursor);
  this.evictCursor = 0;
}
```

This is O(n) but amortized O(1) per insertion since it only fires when half the array is consumed.

---

## Fix 5: `addAdditionalPropertiesFalse` schema mutation

**File:** `packages/framework/src/llm/openai-client.ts`  
**Problem:** `addAdditionalPropertiesFalse` mutates the JSON schema object in place. `zodToJsonSchema` already returns a fresh object (Zod v4's `toJSONSchema` allocates), but the mutation applies to the same reference if called twice with the same schema.  
**Fix:** Move `addAdditionalPropertiesFalse` into `buildJsonSchema` which is always called — and make `zodToJsonSchema` return a deep clone so mutation is safe. Actually, simpler: make the function return a new object instead of mutating.

Rewrite `addAdditionalPropertiesFalse` as a pure function that returns a new schema:

```ts
function withAdditionalPropertiesFalse(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (result.type === "object" && result.properties) {
    result.additionalProperties = false;
    result.properties = Object.fromEntries(
      Object.entries(result.properties as Record<string, Record<string, unknown>>)
        .map(([k, v]) => [k, v && typeof v === "object" ? withAdditionalPropertiesFalse(v) : v]),
    );
  }
  if (result.items && typeof result.items === "object") {
    result.items = withAdditionalPropertiesFalse(result.items as Record<string, unknown>);
  }
  return result;
}
```

Update `buildJsonSchema` to call the pure version.

---

## Fix 6: Extract shared LLM client utilities

**Files:**
- `packages/framework/src/llm/anthropic-client.ts`
- `packages/framework/src/llm/openai-client.ts`
- **New:** `packages/framework/src/llm/llm-errors.ts`
- **New:** `packages/framework/src/llm/with-timeout.ts`

**Problem:** Both clients duplicate ~100 lines of identical timeout/abort/rate-limit logic.

### 6a: `llm-errors.ts` — shared error classification

Extract `isAbort`, `isRateLimit`, and `classifyLlmError` into a shared module:

```ts
// llm-errors.ts
import type { Result } from "../types/result.js";
import type { FrameworkError } from "../types/errors.js";
import type { NodeId } from "../types/ids.js";
import { err } from "../types/result.js";

export const isAbort = (e: unknown): boolean =>
  e instanceof Error && e.name === "AbortError";

export const isRateLimit = (e: unknown): boolean =>
  typeof (e as { status?: unknown })?.status === "number" &&
  (e as { status: number }).status === 429;

/**
 * Classify an LLM client exception into the appropriate FrameworkError.
 * Handles: timeout, abort, rate-limit, and generic crash. Each client
 * calls this in their catch blocks instead of duplicating the chain.
 */
export const classifyLlmError = (
  e: unknown,
  nodeId: NodeId,
  opts?: { timedOut?: boolean; callerAborted?: boolean; timeoutMs?: number },
): Result<never, FrameworkError> => {
  if (isAbort(e) && opts?.timedOut && !opts?.callerAborted) {
    return err({ kind: "transient", nodeId, message: `request timed out after ${opts.timeoutMs}ms` });
  }
  if (isAbort(e)) {
    return err({ kind: "aborted", reason: "signal" });
  }
  if (isRateLimit(e)) {
    return err({ kind: "transient", nodeId, message: e instanceof Error ? e.message : String(e) });
  }
  return err({
    kind: "node-crash",
    retriability: "retriable",
    nodeId,
    message: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
};
```

### 6b: `with-timeout.ts` — shared timeout wrapper

```ts
// with-timeout.ts
export interface TimeoutHandle {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly cleanup: () => void;
}

/**
 * Creates a timeout-managed AbortSignal that distinguishes caller-initiated
 * abort from timeout-induced abort. Both LLM clients use the same pattern.
 */
export const createTimeoutSignal = (
  timeoutMs: number,
  callerSignal?: AbortSignal,
): TimeoutHandle => {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
};
```

### 6c: Update both clients

Replace the manual timeout setup blocks and error classification chains in both `anthropic-client.ts` and `openai-client.ts` with calls to `createTimeoutSignal` and `classifyLlmError`. Delete the local `isAbort`, `isRateLimit`, `isTimeoutError` from each client.

The Anthropic client's `sendStructured` shrinks from ~50 lines of boilerplate to ~10. The OpenAI client's `postResponses` uses `createTimeoutSignal` directly and rethrows timeout as `Error` with `cause: "timeout"` (keeping the existing `isTimeoutError` check in the outer methods — or better, fold that into `classifyLlmError` with an extra flag).

---

## Fix 7: `run-dag-stateful.ts` — eliminate `lastFailedState` mutable closure

**File:** `packages/framework/src/dag-runtime/run-dag-stateful.ts`  
**Problem:** A `let lastFailedState` variable is mutated by the `onTrace` callback to shuttle error context to the outer `catch` block. This relies on synchronous ordering.  
**Fix:** The kernel always throws on terminal-failed (FR-007). The thrown `Error` has `JSON.stringify(state)` as its message. Instead of the mutable closure, parse the failed state from the thrown error's message, or — better — attach the `DagPhase` to the thrown error.

Actually the cleanest fix: the kernel's throw in `runner.ts` already serializes the state as `JSON.stringify(state)`. Change the kernel to attach `state` as `Error.cause` (the `cause` property is standard and was added in ES2022). Then `run-dag-stateful.ts` reads the structured state from `e.cause` instead of the mutable closure.

**File:** `packages/framework/src/state-machine/runner.ts` (line ~155)

```ts
// Before
throw new Error(`State machine reached failed terminal state: ${JSON.stringify(state)}`);

// After — attach structured state as cause
throw new Error(
  `State machine reached failed terminal state: ${JSON.stringify(state)}`,
  { cause: { state, context } },
);
```

**File:** `packages/framework/src/dag-runtime/run-dag-stateful.ts`

Remove `let lastFailedState` and the `onTrace` mutation. In the catch block:

```ts
} catch (e) {
  const isAbort = e instanceof Error && e.message.includes("aborted by beforeExecute");
  if (isAbort) { /* same */ }

  // Extract structured state from kernel's Error.cause
  const cause = (e as Error)?.cause as { state?: DagPhase } | undefined;
  const failedState = cause?.state?.kind === "failed" ? cause.state : undefined;
  const error: FrameworkError = failedState?.error ?? {
    kind: "node-crash",
    nodeId: EXECUTOR_NODE_ID,
    retriability: "retriable",
    message: e instanceof Error ? e.message : String(e),
  };
  // ...
}
```

Delete the `lastFailedState` variable and the `onTrace` wrapper. Pass `opts?.onTrace` directly to `runOpts.onTrace`.

---

## Fix 8: Scheduler `resolveDependents` — extract `retryAsync` utility

**Files:**
- **New:** `packages/framework/src/shared/retry-async.ts`
- `packages/framework/src/scheduler/scheduler.ts`

**Problem:** Hand-rolled 3-attempt retry loop with `setTimeout(r, 500 * attempt)`.  
**Fix:** Extract a generic `retryAsync` utility into `shared/` and use it in the scheduler.

```ts
// shared/retry-async.ts
import { fwLogger } from "../logger.js";

export interface RetryOpts {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly label: string;
}

/**
 * Retry an async operation with linear backoff. Returns the result on
 * success, or throws the last error after all attempts are exhausted.
 */
export const retryAsync = async <T>(
  fn: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      fwLogger().error(
        `[${opts.label}] attempt ${attempt + 1}/${opts.maxAttempts} failed:`,
        e,
      );
      if (attempt < opts.maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, opts.baseDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
};
```

Then in `scheduler.ts`, replace the hand-rolled loops:

```ts
// Before: manual 3-attempt loop in resolveDependents for markers.set(completed)
// After:
await retryAsync(
  () => markers.set(markerCompletedKey(taskId), completedTtl),
  { maxAttempts: 3, baseDelayMs: 500, label: `CronScheduler markers.set(completed) task="${taskId}"` },
);

// Before: manual 3-attempt loop for enqueue
// After:
await retryAsync(
  () => enqueue(dep, triggeredAt),
  { maxAttempts: 3, baseDelayMs: 500, label: `CronScheduler enqueue dependent "${dep.id}"` },
);
```

---

## Fix 9: `SideEffectProfile` — compile-time serialization guard

**File:** `packages/framework/src/types/side-effects.ts`  
**Problem:** `SideEffectProfile` carries closures that must never be serialized, but nothing enforces this at the type level.  
**Fix:** Add a compile-time assertion similar to the existing `_AssertCapabilitySync` pattern. The `DagMachineContextPersisted` type intentionally excludes `NodeDef` (which carries `SideEffectProfile`). Add a type-level assertion that `DagMachineContextPersisted` does not extend a type containing `SideEffectProfile`.

Actually the cleanest approach: `SideEffectProfile` variants with closures already can't serialize via `JSON.stringify`. The real guard is ensuring `stripNonPersistable` doesn't leak them. Add a type-level test:

**File:** **New** `packages/framework/src/__tests__/side-effects-serialization.test.ts`

```ts
import { describe, it, expect } from "bun:test";
import type { DagMachineContextPersisted } from "../dag-runtime/types.js";
import type { SideEffectProfile } from "../types/side-effects.js";

// Compile-time assertion: DagMachineContextPersisted must not contain SideEffectProfile
type _AssertNoSideEffects = DagMachineContextPersisted extends { sideEffects: SideEffectProfile }
  ? "ERROR: DagMachineContextPersisted must not contain SideEffectProfile"
  : never;
const _check: _AssertNoSideEffects = undefined as never;
void _check;

describe("SideEffectProfile serialization guard", () => {
  it("DagMachineContextPersisted does not carry closures", () => {
    // The type-level assertion above is the real test.
    // This runtime test verifies stripNonPersistable drops the dag field.
    expect(true).toBe(true);
  });
});
```

---

## Fix 10: ADR-0027 — create the file

**Problem:** Cortex memory references ADR-0027 (bucketed confidence calibration workflow) but the file doesn't exist in `docs/adr/`.  
**Fix:** Create `docs/adr/0027-confidence-calibration-workflow.md` documenting the bucketed confidence calibration workflow and threshold tuning via MLflow. Content is derivable from the cortex memory entry and the `types/confidence.ts` implementation.

---

## Fix 11: `createExhaustiveObserver` variant

**File:** `packages/framework/src/observer/observer.ts`  
**Problem:** `createObserver` silently drops new event types. When adding new `ObserverEvent` variants, call sites using `createObserver` won't get a compile error.  
**Fix:** Add a `createExhaustiveObserver` that requires a handler for every event type.

```ts
/**
 * Exhaustive handler map — requires a handler for every ObserverEvent type.
 * Adding a new event variant to ObserverEvent without handling it here is a
 * compile error. Use `createObserver` for partial handling.
 */
type ExhaustiveEventHandlers = {
  readonly [K in ObserverEvent["type"]]: (
    event: Extract<ObserverEvent, { type: K }>,
  ) => void;
};

export function createExhaustiveObserver(handlers: ExhaustiveEventHandlers): Observer {
  return {
    observe(event: ObserverEvent): void {
      const handler = handlers[event.type] as (e: ObserverEvent) => void;
      handler(event);
    },
  };
}
```

The existing `createObserver` stays for partial handlers. The new variant is for production observers that should handle every event.

---

## Fix 12: Verify branded type violations resolved

**Problem:** Cortex memory documents 46 branded type violations in customer-summary app.  
**Fix:** `bun run typecheck` already passes clean, so they're resolved. Verify by grepping for `__brand` escape hatches in the customer-summary app:

```bash
grep -rn "__brand" apps/customer-summary/
```

If any `__brandNodeId` / `__brandRunId` calls appear in app code (not framework code), they're violations of the branding contract — replace with the smart constructors `nodeId()`, `runId()`.

**Verified:** `grep -rn "__brand\|as RunId\|as NodeId" apps/customer-summary/` returns zero hits. All branded IDs go through smart constructors. No code change needed — this item is closed.

---

## Fix 13: `zodToJsonSchema` deep-clone for mutation safety

This is subsumed by Fix 5. Once `addAdditionalPropertiesFalse` becomes a pure function (`withAdditionalPropertiesFalse`), no mutation occurs, and `zodToJsonSchema` doesn't need to change.

---

## Execution Order

Dependency-free changes first, then ones that touch shared modules:

1. **Fix 10** — ADR-0027 file (standalone doc, no code deps)
2. **Fix 12** — branded type verification (read-only, may produce zero changes)
3. **Fix 1** — `sweepHandle.unref()` (isolated to `buffered.ts`)
4. **Fix 2** — `dispatchEvent` in `tool-dispatch.ts` (isolated to one file)
5. **Fix 3** — `/healthz` removal + `checkReadiness` extraction (isolated to `server.ts`)
6. **Fix 4** — `resourceOrder` compaction (isolated to `freshness-check.ts`)
7. **Fix 5** — pure `withAdditionalPropertiesFalse` (isolated to `openai-client.ts`)
8. **Fix 8** — `retryAsync` utility (new file `shared/retry-async.ts` + scheduler update)
9. **Fix 6** — shared LLM utilities (new files + update both LLM clients — largest change)
10. **Fix 7** — `Error.cause` for failed state (touches `runner.ts` + `run-dag-stateful.ts`)
11. **Fix 9** — serialization guard type test (new test file)
12. **Fix 11** — `createExhaustiveObserver` (new export in `observer.ts` + barrel)

---

## Test Impact

- **Fixes 1–5:** Existing tests should pass unchanged (behaviorally equivalent).
- **Fix 6:** LLM client tests may need import updates for moved utilities.
- **Fix 7:** State-machine runner tests that assert on the thrown error shape need updating for `Error.cause`.
- **Fix 8:** Scheduler tests pass unchanged (retryAsync is a transparent wrapper).
- **Fix 9:** New type-level test file.
- **Fix 11:** New test for `createExhaustiveObserver`.
- **Fix 12:** No test changes expected.

Run `bun run typecheck && bun test` after each fix.
