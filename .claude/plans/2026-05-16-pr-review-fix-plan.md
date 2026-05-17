# PR Review Fix Plan

**Branch:** feat/initial-setup  
**Date:** 2026-05-16  
**Scope:** All critical + important issues from comprehensive review  

---

## Wave 1: Silent Failure Fixes

### T1. `RedisCache.get` — return `err()` on schema mismatch

**File:** `packages/framework/src/cache/redis-cache.ts`

**Change:** Replace `ok(null)` with `err(cacheError("get-schema-mismatch", ...))`. The caller already handles `Result<T | null, FrameworkError>` — a schema mismatch is a framework concern, not a "miss." Callers who want fall-through-to-recompute can match on `error.kind === "cache-error" && error.operation === "get-schema-mismatch"` and treat it as a miss at their level.

```typescript
// Before:
if (!validated.success) {
  fwLogger().warn(...);
  return ok(null); // WRONG: indistinguishable from miss
}

// After:
if (!validated.success) {
  return err(cacheError("get-schema-mismatch", `key="${key}": ${validated.error.message}`));
}
```

**Impact:** Any caller that does `if (!result.ok) { /* handle error */ }` will now see the mismatch. The LLM node cache path should treat this specific error as a miss (re-compute and re-cache), but it's now an explicit choice, not invisible.

**Also update:** `packages/framework/src/nodes/llm.ts` (or wherever cache reads happen) — add a `mapErr` or pattern match that falls through on `get-schema-mismatch` specifically. This makes the "treat drift as miss" decision visible and auditable.

---

### T2. Scheduler `catch {}` → bind error, log details

**File:** `packages/framework/src/scheduler/scheduler.ts`

**Change:** All three bare `catch {}` blocks get `(e)` binding and log the error.

```typescript
// Line ~284
} catch (e) {
  fwLogger().error(
    `[CronScheduler] markers.set(completed) permanently failed for task "${taskId}" after 3 attempts — dependent chain abandoned:`,
    e,
  );
  return;
}

// Line ~320
} catch (e) {
  fwLogger().error(`[CronScheduler] enqueue permanently failed for dependent "${dep.id}":`, e);
  continue;
}
```

Trivial fix, high diagnostic value.

---

### T3. Server `catch {}` → bind error, log it

**File:** `apps/customer-summary/src/server.ts`

```typescript
// Before:
try {
  body = await c.req.json();
} catch {
  return c.json({ error: "Invalid JSON body" }, 400);
}

// After:
try {
  body = await c.req.json();
} catch (e) {
  log.warn(`[/summarize] Request body parse failed: ${e instanceof Error ? e.message : String(e)}`);
  return c.json({ error: "Invalid JSON body" }, 400);
}
```

---

### T4. Server timeout race — check result before abort signal

**File:** `apps/customer-summary/src/server.ts`

**Change:** Restructure the post-`runDag` logic so a valid `ok()` result is always returned, regardless of timer state. The abort check only applies when the result is `err()`.

```typescript
// After runDag returns:
} finally {
  clearTimeout(timeout);
}

// Result-first logic:
if (result.ok) {
  return c.json(result.value, 200);
}

// Only reach here on err — check if it was timeout-caused:
if (abortController.signal.aborted) {
  log.warn(`[/summarize] Request timed out after ${timeoutMs}ms for customer=${customer_id} run=${runId}`);
  return c.json({ error: "Request timeout", requestId: runId }, 504);
}

log.error("[/summarize] DAG error:", JSON.stringify(result.error));
return c.json({ error: "Internal server error", requestId: runId }, 500);
```

Also: pass a reason to `abort()`:
```typescript
const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);
```

---

## Wave 2: Test Coverage

### T5. Add `llm-errors.test.ts`

**File:** `packages/framework/src/__tests__/llm-errors.test.ts`

Test all 5 classification branches:
1. Timeout-induced abort (`timedOut: true, callerAborted: false`) → `transient`
2. Timeout via `Error.cause === "timeout"` → `transient`  
3. Caller abort (`signal.aborted`) → `aborted`
4. Rate limit (status 429) → `transient`
5. Generic error → `node-crash` with retriability `"retriable"`
6. Custom `isAbortOverride` predicate
7. Non-Error values (strings, objects)

---

### T6. Add `with-timeout.test.ts`

**File:** `packages/framework/src/__tests__/with-timeout.test.ts`

Test:
1. `timedOut()` returns false before timeout
2. `timedOut()` returns true after timeout fires
3. `cleanup()` clears the timer (no leak)
4. Caller signal abort propagates to combined signal
5. Timeout abort propagates to combined signal
6. `cleanup()` removes event listeners from caller signal
7. No caller signal provided — works standalone

---

## Wave 3: Type Safety

### T7. Restrict `package.json` exports — block `__brand*` path imports

**File:** `packages/framework/package.json`

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./advanced": "./src/advanced.ts",
    "./bullmq": "./src/bullmq.ts"
  }
}
```

This already exists! The fix is to ensure Bun/TypeScript resolves workspace imports through the `exports` map. Verify with a test:

**File:** `apps/customer-summary/src/__tests__/no-deep-imports.test.ts`

```typescript
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("deep import prevention", () => {
  it("app code does not import __brand escapes", () => {
    // grep app source for __brand imports
    const appDir = join(import.meta.dir, "../../");
    // ... scan for forbidden import patterns
  });
});
```

Actually — the real fix is `tsconfig.json` in `apps/customer-summary/`:

```json
{
  "compilerOptions": {
    "paths": {
      "@ai-summary/framework": ["../../packages/framework/src/index.ts"],
      "@ai-summary/framework/advanced": ["../../packages/framework/src/advanced.ts"],
      "@ai-summary/framework/bullmq": ["../../packages/framework/src/bullmq.ts"]
    }
  }
}
```

With strict `moduleResolution: "bundler"` + the `exports` map, path imports like `@ai-summary/framework/types/ids.js` will fail to resolve.

---

### T8. Predicate runtime validation — validate output against node's `outputSchema`

**File:** `packages/framework/src/dag-runtime/route-emission.ts`

In `emitRoutingDecisions`, before calling `evaluatePredicate`, validate `output` against the source node's `outputSchema`:

```typescript
// Before evaluating predicates for a node's conditional edges:
const outputValidation = sourceNode.outputSchema.safeParse(output);
if (!outputValidation.success) {
  // This is a framework bug (output already validated in run-node),
  // but guards against wiring errors.
  return {
    predicateLabel: pred.label,
    predicateVersion: pred.version,
    matched: false,
    evaluatedConfidence: confidence,
    reason: `output-schema-mismatch: ${outputValidation.error.message}`,
  };
}
```

This makes the type widening (`Predicate<unknown>`) safe at runtime — the Zod schema re-narrows.

---

## Wave 4: Important Code Fixes

### T9. OpenAI `withAdditionalPropertiesFalse` — handle composition keywords

**File:** `packages/framework/src/llm/openai-client.ts`

```typescript
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
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map(withAdditionalPropertiesFalse);
    }
  }
  if (result.$defs && typeof result.$defs === "object") {
    result.$defs = Object.fromEntries(
      Object.entries(result.$defs as Record<string, Record<string, unknown>>)
        .map(([k, v]) => [k, withAdditionalPropertiesFalse(v)]),
    );
  }
  return result;
}
```

Add a test in `__tests__/openai-client.test.ts` or a new `__tests__/openai-schema.test.ts` covering `z.discriminatedUnion`, `z.union`, `z.optional()` schemas.

---

### T10. `dispatchEvent` — handle async observers

**File:** `packages/framework/src/observer/buffered.ts`

The `Observer` interface declares `observe(event: ObserverEvent): void`. Make this contract explicit — a void return means synchronous. If someone returns a Promise from `void`, it's a violation. Guard it:

```typescript
export function dispatchEvent(observer: Observer, event: ObserverEvent): void {
  try {
    const result = observer.observe(event);
    // Guard: if observe() returns a thenable despite void signature, catch its rejection.
    if (result !== undefined && typeof (result as any)?.catch === "function") {
      (result as Promise<void>).catch((e) => {
        fwLogger().error(
          `[observer] async observe() rejected for ${event.type} — Observer.observe must be synchronous:`,
          e instanceof Error ? e.message : e,
        );
      });
    }
  } catch (e) {
    fwLogger().error(
      `[observer] dispatchEvent failed for ${event.type}:`,
      e instanceof Error && e.stack ? e.stack : e,
    );
    if (OBSERVER_STRICT) throw e;
  }
}
```

---

### T11. `runWave` — per-node try-catch in `Promise.all`

**File:** `packages/framework/src/dag-runtime/executor.ts`

Wrap each node execution inside the `Promise.all` map to prevent an unexpected throw from losing all sibling results:

```typescript
const settled = await Promise.all(
  waveNodeIds.map(async (nodeId) => {
    try {
      // ... existing skip-if-already-completed logic ...
      // ... existing runNodeShared call ...
      return { nodeId, result, outcome };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const crash: FrameworkError = {
        kind: "node-crash",
        nodeId,
        message: `unexpected executor error: ${message}`,
        retriability: "retriable",
        stack: e instanceof Error ? e.stack : undefined,
      };
      emit(nodeCtx, {
        type: "node-error",
        runId: nodeCtx.runId,
        dagId: dag.id,
        nodeId,
        timestamp: stamp(),
        error: message,
        frameworkError: crash,
      });
      return { nodeId, result: err(crash) as Result<unknown, FrameworkError>, outcome: EMPTY_OUTCOME };
    }
  }),
);
```

---

### T12. OTel boundary check — make structural, add `conditional.ts`

**File:** `packages/framework/src/scripts/check-imports.ts`

Change the OTel rule for dag-runtime from an explicit file list to a wildcard scope with an **allowlist** for the imperative-shell files:

```typescript
{
  scope: ["dag-runtime"],
  scopeExcludes: [
    // These are the imperative shell — they legitimately use OTel:
    "dag-runtime/executor.ts",
    "dag-runtime/run-dag-stateful.ts",
    "dag-runtime/run-telemetry.ts",
    "dag-runtime/node-span.ts",
    "dag-runtime/eval-judges.ts",
    "dag-runtime/freshness-emission.ts",
    "dag-runtime/human-emission.ts",
    "dag-runtime/route-emission.ts",
  ],
  forbiddenModules: ["@opentelemetry/"],
  reason: "Pure dag-runtime modules must not depend on OTel. Only shell files (executor, telemetry, emission) may import it.",
},
```

This automatically catches any new file in `dag-runtime/` that imports OTel without being explicitly listed as a shell file. `conditional.ts`, `transition.ts`, `wave-resolution.ts`, `retry-policy.ts`, `human-resolution.ts`, `machine.ts`, `types.ts`, `persistence.ts` are all now protected by default.

Remove the old explicit-file-list rule that overlaps with this new one.

---

### T13. Extract `RetryConfig` into `DagMachineContextPersisted`

**File:** `packages/framework/src/dag-runtime/types.ts`

Add a serializable retry config map to the persisted context:

```typescript
export interface DagMachineContextPersisted {
  // ... existing fields ...
  /** Per-node retry config (backoffMs, jitterRatio). Plain data, serializable. */
  readonly retryConfigs: ReadonlyMap<NodeId, { backoffMs: readonly number[]; jitterRatio: number }>;
}
```

**File:** `packages/framework/src/dag-runtime/retry-policy.ts`

Change `handleNodeFailed` to read retry config from `ctx.retryConfigs.get(nodeId)` instead of `ctx.nodeById?.get(nodeId)?.retry`. The pure core no longer reaches into live `NodeDef` objects.

**File:** `packages/framework/src/dag-runtime/machine.ts` (`compileDagToMachine`)

Populate `retryConfigs` from `dag.nodes` at compile time:

```typescript
const retryConfigs = new Map(
  dag.nodes
    .filter(n => n.retry)
    .map(n => [n.id, { backoffMs: n.retry!.backoffMs ?? [1000, 2000, 4000], jitterRatio: n.retry!.jitterRatio ?? 0.2 }]),
);
```

---

### T14. Complete `frameworkError` factories for all 20 kinds

**File:** `packages/framework/src/types/error-factories.ts`

Add the remaining 15 factories. Each factory brands the NodeId/RunId internally, so consumer code never hand-constructs branded fields:

```typescript
export const frameworkError = {
  // Existing 5:
  validation: (...) => ...,
  nodeCrash: (...) => ...,
  transient: (...) => ...,
  rejected: (...) => ...,
  invalidReroute: (...) => ...,

  // New 15:
  retryExhausted: (nid: string | NodeId, attempts: number, lastError: string, rootErrorKind: FrameworkError["kind"]): FrameworkError => ({
    kind: "retry-exhausted", nodeId: toNodeId(nid), attempts, lastError, rootErrorKind,
  }),
  checkpointMissing: (rid: string | RunId): FrameworkError => ({
    kind: "checkpoint-missing", runId: toRunId(rid),
  }),
  checkpointExpired: (rid: string | RunId, expiredAt: Date): FrameworkError => ({
    kind: "checkpoint-expired", runId: toRunId(rid), expiredAt,
  }),
  checkpointCorrupt: (rid: string | RunId, message: string, nid?: string | NodeId): FrameworkError => ({
    kind: "checkpoint-corrupt", runId: toRunId(rid), message, ...(nid ? { nodeId: toNodeId(nid) } : {}),
  }),
  checkpointVersionMismatch: (rid: string | RunId, expected: string, actual: string | undefined): FrameworkError => ({
    kind: "checkpoint-version-mismatch", runId: toRunId(rid), expected, actual,
  }),
  checkpointWriteFailed: (rid: string | RunId, nid: string | NodeId, message: string): FrameworkError => ({
    kind: "checkpoint-write-failed", runId: toRunId(rid), nodeId: toNodeId(nid), message,
  }),
  promptNotFound: (promptName: string, reason: string): FrameworkError => ({
    kind: "prompt-not-found", promptName, reason,
  }),
  cacheError: (operation: string, message: string): FrameworkError => ({
    kind: "cache-error", operation, message,
  }),
  cycleDetected: (nodeIds: readonly (string | NodeId)[]): FrameworkError => ({
    kind: "cycle-detected", nodeIds: nodeIds.map(n => toNodeId(n as string)),
  }),
  aborted: (reason: string): FrameworkError => ({
    kind: "aborted", reason,
  }),
  missingDefaultEdge: (nid: string | NodeId): FrameworkError => ({
    kind: "missing-default-edge", nodeId: toNodeId(nid),
  }),
  outputUnreachable: (outputNodeId: string | NodeId, missedFromNode: string | NodeId): FrameworkError => ({
    kind: "output-unreachable-under-routing", outputNodeId: toNodeId(outputNodeId), missedFromNode: toNodeId(missedFromNode),
  }),
  predicateMalformed: (nid: string | NodeId, message: string): FrameworkError => ({
    kind: "predicate-malformed", nodeId: toNodeId(nid), message,
  }),
  duplicateEdge: (fromNodeId: string | NodeId, toNodeId_: string | NodeId): FrameworkError => ({
    kind: "duplicate-edge", fromNodeId: toNodeId(fromNodeId), toNodeId: toNodeId(toNodeId_),
  }),
  missingCapability: (nid: string | NodeId, capability: Capability, missing: readonly { nodeId: string | NodeId; capability: Capability }[]): FrameworkError => ({
    kind: "missing-capability",
    nodeId: toNodeId(nid),
    capability,
    missing: missing.map(m => ({ nodeId: toNodeId(m.nodeId as string), capability: m.capability })),
  }),
} as const;
```

Also add the helper:
```typescript
const toRunId = (rid: string | RunId): RunId => runId(rid as string);
```

Then **grep the codebase** for inline `FrameworkError` object literals and replace with factory calls. This gives a single point of construction with validated branding.

---

### T15. Rename `DagEvent` type `"ERROR"` → `"executor-error"`

**Files:** Multiple (shotgun surgery, but one-time greenfield):
- `packages/framework/src/dag-runtime/types.ts` — rename the variant
- `packages/framework/src/dag-runtime/transition.ts` — update all match arms
- `packages/framework/src/dag-runtime/run-dag-stateful.ts` — update `errorEventOf`
- `packages/framework/src/state-machine/runner.ts` — if it references the type name
- All test files matching `"ERROR"` in dag-runtime contexts

```typescript
// types.ts:
| { readonly type: "executor-error"; readonly retriable: boolean; readonly error: string }

// run-dag-stateful.ts:
const errorEventOf = (classified: { retriable: boolean; message: string }): DagEvent => ({
  type: "executor-error",
  retriable: classified.retriable,
  error: classified.message,
});

// transition.ts: all `.with([..., { type: "ERROR" }], ...)` → `.with([..., { type: "executor-error" }], ...)`
```

---

## Wave 5: Advisory Fixes (lower priority, do after Waves 1-4)

### T16. MLflow exporter — count/log inner export failures

**File:** `packages/framework/src/tracing/mlflow-otlp-exporter.ts`

Add a `failedExportCount` counter and log when the inner exporter's `resultCallback` returns failure.

---

### T17. Scheduler `markers.set(fired)` failure — add in-memory fallback marker

**File:** `packages/framework/src/scheduler/scheduler.ts`

After the logged error for marker-set-after-enqueue failure, set an in-memory `Set<string>` fallback so `alreadyFired` check prevents same-process duplicate enqueue on the next `resolveDependents` cycle.

---

### T18. Add test for `apps/customer-summary/src/config.ts`

**File:** `apps/customer-summary/src/__tests__/config.test.ts`

Test defaults, coercions, range validation.

---

### T19. Add test for `llm/spans.ts` `stringifyOrTruncate`

**File:** `packages/framework/src/__tests__/llm-spans.test.ts`

Test truncation threshold, non-serializable fallback.

---

## Execution Order

```
Wave 1 (T1-T4):  Silent failures — quick fixes, highest value
Wave 2 (T5-T6):  Test coverage for untested critical paths
Wave 3 (T7-T8):  Type safety enforcement
Wave 4 (T9-T15): Important code fixes
Wave 5 (T16-T19): Advisory/polish
```

Each wave should pass `bun run typecheck` and `bun test` before moving to the next.

---

## Verification

After all waves:
1. `bun run typecheck` — must pass
2. `bun test` — must pass (excluding Redis-dependent tests)
3. `bun test packages/framework/src/__tests__/boundary-imports.test.ts` — must pass
4. Grep for remaining bare `catch {` — should be zero outside test fixtures
5. Grep for `ok(null)` in cache paths — should only appear for genuine misses (key not found)
6. Grep for inline `FrameworkError` object literals outside test files — should be minimal (factories preferred)
