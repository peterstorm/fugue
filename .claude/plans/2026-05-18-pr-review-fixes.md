# PR Review Fix Plan — 2026-05-18

All findings from the comprehensive review. No backwards-compat needed (greenfield).

---

## Wave 1 — Critical: Silent Failure in Freshness Emission

### Fix 1.1: `freshness-emission.ts` — match result not propagated

**Problem:** `await match(se)...exhaustive()` returns `err(fwError)` from the "writes" branch callback, but the return value is never captured. The loop continues and the function returns `ok(undefined)` even on `recordWrite` failure. This violates the documented fail-closed invariant.

**Root cause:** ts-pattern's `match().with().exhaustive()` is an expression, but the async callbacks' return values flow through it. When the "writes" callback returns `err(fwError)`, that becomes the resolved value of `await match(...)`. Since there's no assignment, it's discarded.

**Fix approach:** Replace the side-effect-only `await match(...)` with a captured result. Each branch should return `Result<void, FrameworkError>`. Check the result after the match, propagate errors immediately.

**File:** `packages/framework/src/dag-runtime/freshness-emission.ts`

```typescript
// BEFORE (lines 51–211):
    await match(se)
      .with({ kind: "reads" }, async (se) => {
        // ... no return on success path, implicit void
      })
      .with({ kind: "writes" }, async (se) => {
        // ... returns err(fwError) on recordWrite failure
        // ... returns undefined (void) implicitly on success
      })
      .with({ kind: "none" }, () => { })
      .with({ kind: "external-call" }, () => { })
      .exhaustive();

// AFTER:
    const branchResult: Result<void, FrameworkError> | void = await match(se)
      .with({ kind: "reads" }, async (se): Promise<void> => {
        // ... unchanged body — reads failures are non-fatal (emit event, continue)
      })
      .with({ kind: "writes" }, async (se): Promise<Result<void, FrameworkError>> => {
        // ... early returns become `return ok(undefined)` instead of bare `return`
        // ... final success path gets explicit `return ok(undefined)`
        // ... recordWrite failure still returns `return err(fwError)`
      })
      .with({ kind: "none" }, (): void => undefined)
      .with({ kind: "external-call" }, (): void => undefined)
      .exhaustive();

    // Propagate any error from the writes branch
    if (branchResult && typeof branchResult === "object" && "ok" in branchResult && !branchResult.ok) {
      return branchResult;
    }
```

**Cleaner alternative** (preferred — keep the types uniform across all branches):

Make ALL branches return `Result<void, FrameworkError>`:

```typescript
    const branchResult = await match(se)
      .returnType<Promise<Result<void, FrameworkError>>>()
      .with({ kind: "reads" }, async (se) => {
        if (!se.extractWitness) return ok(undefined);
        try {
          // ... emit witness-captured ...
          return ok(undefined);
        } catch (e) {
          // ... emit node-error, reads failures are non-fatal ...
          return ok(undefined); // intentional: reads failures don't halt the DAG
        }
      })
      .with({ kind: "writes" }, async (se) => {
        if (!se.extractConditionedOn || !se.extractNewWitness) return ok(undefined);
        // ... Step 1 early-return becomes: return ok(undefined)
        // ... Step 2 early-return becomes: return ok(undefined)  [fail-closed: skip recording]
        // ... wait, these currently return bare `return;` which means "don't record" 
        //     They should actually return err() since they represent fail-closed behavior
        //     BUT reading the comments: "fail-closed: skip write recording" — the intent
        //     is to skip recording but NOT halt the DAG. Only recordWrite failure halts.
        //     So the early returns in steps 1 and 2 remain ok(undefined).
        // ... recordWrite failure: return err(fwError)
        return ok(undefined);
      })
      .with({ kind: "none" }, async () => ok(undefined))
      .with({ kind: "external-call" }, async () => ok(undefined))
      .exhaustive();

    if (!branchResult.ok) return branchResult;
```

**Important nuance on "fail-closed" semantics:**
- Steps 1 & 2 (input reconstruction / extractor failures): emit `node-error`, then `return ok(undefined)` — these are config/authoring bugs (non-retriable). The node-error event is the signal. The DAG run continues because the node already succeeded; we just can't record its witness. The observer event surfaces this for post-mortem.
- Step 3 `recordWrite` failure: `return err(fwError)` — this IS a DAG-halting failure because the freshness index is degraded and future conflict detection would be unreliable.

Wait — re-reading the existing code more carefully: the "writes" branch Step 1 and Step 2 failures use bare `return;` which returns `undefined` from the callback. If we use `.returnType<Promise<Result<void, FrameworkError>>>()`, those need to be `return ok(undefined)`. That's the correct semantics:
- Extractor failure → node-error event emitted → continue DAG (the node itself succeeded, only the witness tracking failed)
- `recordWrite` failure → propagate as DAG-halting error

### Fix 1.2: Add test for the previously-silent failure

**File:** `packages/framework/src/__tests__/freshness-emission.test.ts`

Add test: "recordWrite failure propagates as Err to caller"

```typescript
it("returns Err when freshnessIndex.recordWrite fails", async () => {
  const obs = new RecordingObserver();
  const writeNode = makeNodeDef("write-node", {
    sideEffects: {
      kind: "writes",
      resource: "pg:orders",
      extractConditionedOn: () => ({ kind: "version", resource: "pg:orders", value: "1" }),
      extractNewWitness: () => ({ kind: "version", resource: "pg:orders", value: "2" }),
    },
  });
  const nodeMap = new Map([[NID_WRITE, writeNode]]);
  const newOutputs = new Map([[NID_WRITE, {}]]);

  // Failing freshness index
  const failingIndex: FreshnessIndex = {
    recordWrite: async () => err({ kind: "cache-error", operation: "recordWrite", message: "Redis down" }),
    findConflict: async () => ok(null),
  };

  const result = await emitFreshnessWitnessEvents(
    [NID_WRITE], newOutputs, nodeMap as any, makeMachineCtx(),
    makeCtx(obs) as any, DID, Date.now, failingIndex, new Set(),
  );

  expect(result.ok).toBe(false);
  expect(obs.events.some((e) => e.type === "node-error")).toBe(true);
});
```

---

## Wave 2 — Result type: Add `tap`/`tapErr` + tests for `tryCatch`/`tryCatchAsync`

### Fix 2.1: Add `tap` and `tapErr` combinators

**File:** `packages/framework/src/types/result.ts`

```typescript
/** Execute a side effect on Ok values without breaking the chain. */
export const tap = <T, E>(r: Result<T, E>, fn: (value: T) => void): Result<T, E> => {
  if (r.ok) fn(r.value);
  return r;
};

/** Execute a side effect on Err values without breaking the chain. */
export const tapErr = <T, E>(r: Result<T, E>, fn: (error: E) => void): Result<T, E> => {
  if (!r.ok) fn(r.error);
  return r;
};
```

Export from the barrel (already exports `*` from types/index.ts which re-exports result.ts).

### Fix 2.2: Add `tryCatch` / `tryCatchAsync` unit tests

**File:** `packages/framework/src/__tests__/result.test.ts` — append:

```typescript
describe("tryCatch", () => {
  it("wraps successful computation as Ok", () => {
    const r = tryCatch(() => 42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("catches thrown Error as Err<Error>", () => {
    const r = tryCatch(() => { throw new Error("boom"); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(Error);
  });

  it("catches non-Error throws as wrapped Error", () => {
    const r = tryCatch(() => { throw "string-error"; });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("string-error");
  });

  it("applies mapError when provided", () => {
    const r = tryCatch(
      () => { throw new Error("raw"); },
      (e) => `mapped: ${(e as Error).message}`,
    );
    expect(r).toEqual({ ok: false, error: "mapped: raw" });
  });
});

describe("tryCatchAsync", () => {
  it("wraps resolved promise as Ok", async () => {
    const r = await tryCatchAsync(async () => 99);
    expect(r).toEqual({ ok: true, value: 99 });
  });

  it("catches rejected promise as Err", async () => {
    const r = await tryCatchAsync(async () => { throw new Error("async-boom"); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("async-boom");
  });

  it("applies mapError for async failures", async () => {
    const r = await tryCatchAsync(
      async () => { throw new Error("raw"); },
      (e) => ({ code: "FAIL", msg: (e as Error).message }),
    );
    expect(r).toEqual({ ok: false, error: { code: "FAIL", msg: "raw" } });
  });
});

describe("tap / tapErr", () => {
  it("tap calls fn on Ok and returns same Result", () => {
    const calls: number[] = [];
    const r = tap(ok(5), (v) => calls.push(v));
    expect(r).toEqual(ok(5));
    expect(calls).toEqual([5]);
  });

  it("tap skips fn on Err", () => {
    const calls: number[] = [];
    const r = tap(err("x") as Result<number, string>, (v) => calls.push(v));
    expect(r).toEqual(err("x"));
    expect(calls).toEqual([]);
  });

  it("tapErr calls fn on Err and returns same Result", () => {
    const calls: string[] = [];
    const r = tapErr(err("oops"), (e) => calls.push(e));
    expect(r).toEqual(err("oops"));
    expect(calls).toEqual(["oops"]);
  });

  it("tapErr skips fn on Ok", () => {
    const calls: string[] = [];
    const r = tapErr(ok(1) as Result<number, string>, (e) => calls.push(e));
    expect(r).toEqual(ok(1));
    expect(calls).toEqual([]);
  });
});
```

---

## Wave 3 — Observer: Fix OBSERVER_STRICT unhandled rejection

### Fix 3.1: `observer/buffered.ts` — don't throw inside `.catch()` in OBSERVER_STRICT

**Problem:** When `OBSERVER_STRICT` is true and an observer returns a thenable that rejects, the `throw` inside `.catch()` creates an unhandled rejection (it's in a microtask context, not synchronous).

**Fix:** Instead of throwing inside `.catch()`, use `queueMicrotask` or just synchronously flag and rethrow on next dispatch. But the simplest correct fix: schedule the throw on the same event loop turn so it becomes an uncaught exception (which Node/Bun will surface), OR store and rethrow synchronously on the next `dispatchEvent` call.

Actually, the cleanest fix for test ergonomics: surface the error via `process.emit("uncaughtException")` which is the standard Node way to surface "this should crash in strict mode." But that's heavy.

**Simplest correct approach:** Replace the throw with `setTimeout(() => { throw ... }, 0)` which surfaces as an uncaught exception rather than an unhandled rejection. This makes it kill the process in both Node and Bun, which is the intent of OBSERVER_STRICT.

```typescript
// BEFORE:
if (OBSERVER_STRICT) {
  throw e instanceof Error ? e : new Error(String(e));
}

// AFTER:
if (OBSERVER_STRICT) {
  const error = e instanceof Error ? e : new Error(String(e));
  // Schedule as uncaught exception — a throw inside .catch() would be
  // an unhandled rejection, not an exception, confusing error handlers.
  setTimeout(() => { throw error; }, 0);
}
```

---

## Wave 4 — validate-dag.ts: Replace `as NodeId` casts with `__brandNodeId`

### Fix 4.1: Replace unsafe casts

**File:** `packages/framework/src/executor/validate-dag.ts`

The function already imports `__brandNodeId`. Replace `as NodeId` casts:

```typescript
// Line 90:
const nodeIds = new Set(entries.map(([id]) => __brandNodeId(id)));

// Line 197:
return err({ kind: "missing-default-edge", nodeId: __brandNodeId(id) });

// Lines 201, 204:
if (input.outputNodeId !== undefined && !nodeIds.has(__brandNodeId(input.outputNodeId))) {
  return err(
    validationErr(
      __brandNodeId(input.outputNodeId),
      ...
    ),
  );
}

// Lines 265, 296, 297:
if (!reachable.has(__brandNodeId(input.outputNodeId))) {
  ...
  outputNodeId: __brandNodeId(input.outputNodeId),
  missedFromNode: __brandNodeId(frontier),
}

// Line 311:
...(input.outputNodeId !== undefined ? { outputNodeId: __brandNodeId(input.outputNodeId) } : {}),
```

---

## Wave 5 — Bootstrap: Fix `as any` on Anthropic SDK

### Fix 5.1: Properly type the Anthropic client construction

**File:** `apps/customer-summary/src/bootstrap.ts`

**Problem:** `new AnthropicLlmClient(raw as any)` — the CJS/ESM interop issue.

**Fix:** Check the `AnthropicLlmClient` constructor signature and cast to the expected type, not `any`.

```typescript
// Check what AnthropicLlmClient expects:
// packages/framework/src/llm/anthropic-client.ts constructor takes Anthropic instance
// The issue is the default import might be wrapped in .default for CJS.

// BEFORE:
const raw = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
llm = new AnthropicLlmClient(raw as any);

// AFTER:
const AnthropicSdk = (Anthropic as any).default ?? Anthropic;
const raw = new AnthropicSdk({ apiKey: config.ANTHROPIC_API_KEY });
llm = new AnthropicLlmClient(raw);
```

Or better — update the `AnthropicLlmClient` constructor to accept `InstanceType<typeof Anthropic>` and handle the interop there:

```typescript
// If AnthropicLlmClient constructor already accepts `Anthropic`:
import type Anthropic from "@anthropic-ai/sdk";

// The correct approach for ESM:
const raw: InstanceType<typeof Anthropic> = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
llm = new AnthropicLlmClient(raw);
```

Need to check what the actual type mismatch is. Likely the `Anthropic` default export in ESM has the class directly, no interop needed. The `as any` may be a vestige.

---

## Wave 6 — Tests: Scheduler recovery + Observer crash isolation

### Fix 6.1: Scheduler restart-recovery test

**File:** `packages/framework/src/__tests__/scheduler-recovery.test.ts` (new)

Test that when the scheduler starts with existing markers (simulating restart), it correctly reconciles missed windows via `decideCatchUp`.

```typescript
describe("CronScheduler — recovery on restart", () => {
  it("fires catch-up for missed windows on reconcile after restart", async () => {
    // 1. Create scheduler with a marker store pre-seeded with stale "last-fired" marker
    // 2. Register a task whose cron has elapsed since the marker
    // 3. Call reconcile()
    // 4. Assert the task fires catch-up (calls enqueue with the task)
  });

  it("does not double-fire when marker is current", async () => {
    // 1. Marker is within the cron interval
    // 2. reconcile() should NOT fire
  });
});
```

### Fix 6.2: Observer crash isolation during `runDagStateful`

**File:** `packages/framework/src/__tests__/observer-crash-isolation.test.ts` (new)

```typescript
describe("runDagStateful — observer crash isolation", () => {
  it("completes DAG run despite observer throwing on every event", async () => {
    const throwingObserver: Observer = {
      observe: () => { throw new Error("observer exploded"); },
    };
    // Wire throwing observer into a full runDagStateful invocation
    // Assert the run still produces a Result (not an uncaught exception)
  });
});
```

---

## Wave 7 — MLflow exporter: Surface degraded health

### Fix 7.1: Add `degraded` flag to `MlflowOtlpExporter`

**File:** `packages/framework/src/tracing/mlflow-otlp-exporter.ts`

```typescript
// Add a public readonly field:
get isDegraded(): boolean {
  return this.failedPermanently !== null;
}

// Also expose the failure reason for health check consumers:
get permanentFailure(): Error | null {
  return this.failedPermanently;
}
```

This allows the health check in `bootstrap.ts` to report `"tracing-degraded"` with a reason instead of relying only on the MLflow HTTP health endpoint.

---

## Summary — Execution Order

| Wave | Files Modified | Risk | Description |
|------|---------------|------|-------------|
| 1 | `freshness-emission.ts`, `freshness-emission.test.ts` | **High** | Fix silent failure (CRITICAL) |
| 2 | `result.ts`, `result.test.ts` | Low | Add `tap`/`tapErr` + test coverage |
| 3 | `observer/buffered.ts` | Medium | Fix OBSERVER_STRICT unhandled rejection |
| 4 | `validate-dag.ts` | Low | Replace `as NodeId` with `__brandNodeId` |
| 5 | `bootstrap.ts` | Low | Fix `as any` Anthropic interop |
| 6 | New test files | Low | Scheduler recovery + observer isolation tests |
| 7 | `mlflow-otlp-exporter.ts` | Low | Expose degraded flag |

Run `bun run typecheck && bun test` after each wave.
