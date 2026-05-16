# PR Review Remediation Plan — 2026-05-16

**Branch:** `feat/initial-setup`  
**Scope:** 27 fixes across 4 waves, ordered by dependency  
**Principle:** Code fixes over documentation workarounds. No backwards compat needed.

---

## Wave 1 — Critical: Silent failures + correctness bugs

### Fix 1: Freshness extractor throw → fail-closed with observer event
**File:** `packages/framework/src/dag-runtime/freshness-emission.ts:105-115`  
**Problem:** `extractConditionedOn`/`extractNewWitness` throw → catch logs at warn → returns silently. No observer event. Write proceeds without conflict detection, silently bypassing ADR-0024.  
**Fix:** Mirror the `extractWitness` catch pattern (lines 72-85) and the `findConflict` failure pattern (lines 131-145): emit `node-error` event with `retriability: "non-retriable"`, then return (fail-closed — skip the write recording).

```typescript
// Replace the bare catch block (lines 105-115)
} catch (e) {
  const msg = `extractConditionedOn/extractNewWitness failed for node '${nodeId}': ${e instanceof Error ? e.message : e}`;
  fwLogger().warn(`[emitFreshnessWitnessEvents] ${msg}`);
  emit(nodeCtx, {
    type: "node-error",
    runId: nodeCtx.runId,
    dagId,
    nodeId,
    sideEffects: nodeMap.get(nodeId)?.sideEffects,
    timestamp: stamp(),
    error: `freshness extractor failed: ${msg}`,
    frameworkError: { kind: "node-crash", nodeId, retriability: "non-retriable", message: `freshness extractor threw: ${msg}` },
  });
  return; // fail-closed: skip write recording to prevent undetectable stale writes
}
```

### Fix 2: Predicate fingerprint — add `version` field to `Predicate<T>`
**File:** `packages/framework/src/types/dag.ts` (Predicate interface)  
**File:** `packages/framework/src/checkpoint/fingerprint.ts` (edgeKey function)  
**Problem:** `stableJson(e.when)` drops the `check` function via JSON.stringify. Two predicates with same label but different logic produce identical fingerprints → stale checkpoint resumed against new routing logic.  
**Fix:** Add a required `version` field to `Predicate<T>`. Include it in the fingerprint. This is a greenfield — no backwards compat.

In `types/dag.ts`:
```typescript
export interface Predicate<T> {
  readonly label: string;
  /** Bump when check logic changes. Included in DAG fingerprint for resume safety. */
  readonly version: number;
  readonly check: (value: T, confidence: Confidence | null) => boolean;
  readonly minConfidence?: ConfidenceBucket;
}
```

In `checkpoint/fingerprint.ts`, replace the `edgeKey` conditional branch:
```typescript
const edgeKey = (e: EdgeDef): string => {
  if (isConditionalEdge(e)) return `${e.from}->${e.to}|when:${e.when.label}:${e.when.version}`;
  if (isDefaultEdge(e)) return `${e.from}->${e.to}|default`;
  return `${e.from}->${e.to}`;
};
```

Then fix all call sites that construct `Predicate` values — add `version: 1`. There are 29 predicate literals in test files (all use `as any` casts) across ~8 test files. No production code constructs predicates (customer-summary has no conditional edges). Also update `evaluatePredicate` return type to include `version` in the evidence.

Test files to update:
- `conditional-edges-routing.test.ts` (6 predicates)
- `conditional-edges-validator.test.ts` (6 predicates)
- `evaluate-predicate-property.test.ts` (6 predicates)
- `predicate-malformed-event-sequence.test.ts` (2 predicates)
- `dag-transition-property.test.ts` (check for arbitraries)
- `conditional-edges-replay.test.ts`, `conditional-edges-reroute.test.ts` (check)
- `route-decided-evidence.test.ts`, `route-emission.test.ts` (check)
- `dag-runtime-stateful.test.ts` (check for conditional edge tests)

### Fix 3: Remove HITL bidirectional rejection for unused hook
**File:** `packages/framework/src/executor/executor.ts:73-80`  
**Problem:** `runDag` hard-errors when `onHumanReview` is supplied but no node needs it. Generic runners can't always know upfront.  
**Fix:** Delete the `!dagDeclaresHITL && opts?.onHumanReview` error branch entirely. The inverse (HITL declared, no hook) correctly stays an error.

```typescript
// DELETE this block (lines 73-80):
if (!dagDeclaresHITL && opts?.onHumanReview !== undefined) {
  return err({
    kind: "node-crash",
    retriability: "retriable",
    nodeId: EXECUTOR_NODE_ID,
    message: "[runDag] `onHumanReview` hook supplied but no node declares `humanReview`",
  });
}
```

### Fix 4: ADR-0016 → superseded, write ADR-0028 for function-based predicates
**File:** `docs/adr/0016-structural-match-predicates.md` (amend status)  
**File:** `docs/adr/0028-function-based-predicates.md` (new)  
**Problem:** ADR-0016 describes a pure-data structural-match model that doesn't exist. The actual code uses function-based `Predicate<T>` with `{ label, version, check, minConfidence }`.  
**Fix:** 
- Update ADR-0016 status to `**Status:** Superseded by ADR 0028`
- Write ADR-0028 documenting the function-based predicate design: the `check` closure, confidence gating, `version` for fingerprinting, `evaluatePredicate` total evaluation, `RouteEvidence` with `predicateResults`. Reference the tradeoffs: closures lose serializability/inspectability but gain full expressivity and confidence gating.

---

## Wave 2 — Important: Error handling + contract fixes

### Fix 5: Guardrail node → use `emit()` instead of direct `ctx.observer.observe()`
**File:** `packages/framework/src/nodes/guardrail.ts:114-131`  
**Problem:** Direct `ctx.observer.observe()` call bypasses `dispatchEvent` error-isolation. Observer throw masquerades as node-crash.  
**Fix:** Import `emit` from `../dag-runtime/emit.js` and replace `ctx.observer.observe(...)` with `emit(ctx, ...)`.

```typescript
import { emit } from "../dag-runtime/emit.js";

// Replace ctx.observer.observe({...}) with:
if (!result.passed) {
  emit(ctx, {
    type: "sub-span",
    runId: ctx.runId,
    dagId: ctx.dagId,
    nodeId: id,
    parentSpanId: config.id,
    kind: "GUARDRAIL",
    timestamp: new Date(),
    duration: 0,
    attributes: {
      "guardrail.passed": result.passed,
      "guardrail.checks_total": result.checks.length,
      "guardrail.checks_passed": result.checks.filter((c) => c.passed).length,
      "guardrail.warnings": JSON.stringify(result.warnings),
    },
  });
}
```

Remove the `if (ctx.observer && ...)` null guard — `emit()` handles dispatch safely via `dispatchEvent`.

### Fix 6: `confidence.extract` failure in `emitHumanIntervention` → emit node-error
**File:** `packages/framework/src/dag-runtime/human-emission.ts:55-63`  
**Problem:** `confidence.extract` throw silently sets null. Contrast: `route-emission.ts` correctly emits `node-error`.  
**Fix:** Keep `nodeConfidence = null` (don't fail the human intervention), but emit `node-error` for observability so calibration pipeline operators see the gap:

```typescript
} catch (e) {
  const msg = `confidence.extract failed for node '${phase.nodeId}': ${e instanceof Error ? e.message : e}`;
  fwLogger().warn(`[emitHumanIntervention] ${msg}`);
  emit(nodeCtx, {
    type: "node-error",
    runId: nodeCtx.runId,
    dagId,
    nodeId: phase.nodeId,
    sideEffects: nodeDef?.sideEffects,
    timestamp: stamp(),
    error: msg,
    frameworkError: { kind: "node-crash", nodeId: phase.nodeId, retriability: "non-retriable", message: msg },
  });
  nodeConfidence = null;
}
```

### Fix 7: Scheduler `markers.set(fired)` for dependents → wrap in `retryAsync`
**File:** `packages/framework/src/scheduler/scheduler.ts:325-330`  
**Problem:** After successful enqueue, `markers.set(fired)` failure → marker not set → next tick re-enqueues → duplicate execution.  
**Fix:** Wrap in `retryAsync` (already used 40 lines above for `markers.set(completed)`):

```typescript
try {
  await retryAsync(
    () => markers.set(markerFiredKey(dep.id), depFiredTtl),
    { maxAttempts: 3, baseDelayMs: 500, label: `CronScheduler markers.set(fired) dependent "${dep.id}"` },
  );
} catch (err) {
  fwLogger().error(
    `[CronScheduler] markers.set(fired) permanently failed for dependent "${dep.id}" (upstream "${taskId}", job already enqueued — risk of duplicate execution):`,
    err,
  );
}
```

### Fix 8: `withNodeSpan` throw path → catch and return Err instead of rethrowing
**File:** `packages/framework/src/dag-runtime/node-span.ts:120-155`  
**Problem:** When `fn()` throws, function rethrows — violating its `Promise<{ result, outcome }>` return contract.  
**Fix:** Catch, wrap in `err()`, return the contract shape:

```typescript
import { err } from "../types/result.js";

// Replace the catch block:
} catch (e) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
  span.end();
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  return {
    result: err({ kind: "node-crash", nodeId, retriability: "retriable", message, stack }),
    outcome: EMPTY_OUTCOME,
  };
}
```

Note: `nodeId` needs to be available as a `NodeId`. The function already receives `nodeId: string`. Import `__brandNodeId` and brand it, or change the parameter type. Since the caller (`runNodeShared`) already passes a `NodeId`, change the parameter type to `NodeId`:

```typescript
export const withNodeSpan = async (
  nodeId: NodeId,  // was: string
  ...
```

### Fix 9: `emitRunEnd` double `nowFn()` call → single capture
**File:** `packages/framework/src/dag-runtime/run-telemetry.ts:55-60`  
**Problem:** `nowFn()` called twice — timestamp and duration computed from different clock reads.  
**Fix:**

```typescript
const emitRunEnd = (status: "ok" | "error"): void => {
  const endMs = nowFn();
  dispatchEvent(nodeCtx.observer, {
    type: "run-end",
    runId: nodeCtx.runId,
    dagId: dag.id,
    timestamp: new Date(endMs),
    duration: endMs - runStart,
    status,
  });
};
```

### Fix 10: `handleHookCrash` retry-exhausted → increment retries map
**File:** `packages/framework/src/dag-runtime/retry-policy.ts:175-196`  
**Problem:** Exhausted branch returns original `ctx` with un-incremented retries, but `error.attempts` says +1.  
**Fix:** Apply the same increment to the context in the exhausted branch for both `handleNodeFailed` and `handleHookCrash`:

For `handleHookCrash` (exhausted path):
```typescript
const newRetries = new Map(ctx.retries);
newRetries.set(nodeId, currentAttempts + 1);
const newCtx: DagMachineContext = { ...ctx, retries: newRetries };

return {
  state: {
    kind: "failed",
    error: { kind: "retry-exhausted", nodeId, attempts: currentAttempts + 1, lastError, rootErrorKind: error.kind },
  },
  context: newCtx,  // was: ctx
};
```

For `handleNodeFailed` (exhausted path, ~line 127):
```typescript
const newRetries = new Map(ctxWithCoFailed.retries);
newRetries.set(nodeId, currentAttempts + 1);
const exhaustedCtx: DagMachineContext = { ...ctxWithCoFailed, retries: newRetries };

return {
  state: {
    kind: "failed",
    error: { kind: "retry-exhausted", nodeId, attempts: currentAttempts + 1, lastError, rootErrorKind: error.kind },
  },
  context: exhaustedCtx,  // was: ctxWithCoFailed
};
```

### Fix 11: `normalizeEdge` → make non-exported, move to validate-dag.ts
**File:** `packages/framework/src/types/dag.ts` (remove export)  
**File:** `packages/framework/src/executor/validate-dag.ts` (inline or import from types)  
**Problem:** `normalizeEdge` is exported and calls `__brandNodeId` on unvalidated strings.  
**Fix:** Since `normalizeEdge` is only called from `validateDagShape`, move it there as a private function. Remove it from `types/dag.ts`. Check for other importers first:

```bash
grep -rn 'normalizeEdge' packages/ apps/ --include='*.ts' | grep -v __tests__
```

If only `validate-dag.ts` imports it, move it. If tests import it, provide a test-only path.

---

## Wave 3 — Cleanup: Stale docs, dead code, type improvements

### Fix 12: Remove `isOneOfMatch` from barrel comment
**File:** `packages/framework/src/types/index.ts:2-3` and `:99`  
**Fix:** Remove `isOneOfMatch` from both comment blocks. Replace with actual internal helpers.

Line 2-3:
```typescript
// Types barrel — explicit named exports. Internal helpers (`brandAsDagDef`,
// `normalizeEdge`, `isUnconditionalEdge`) are reachable from their concrete
// file paths for any caller with a documented need, but the barrel mirrors
// the README "Authoring surface" section.
```

Line ~99:
```typescript
// `brandAsDagDef`, `isUnconditionalEdge`, `isConditionalEdge`,
// `isDefaultEdge`, and `DagDefShape` are internal — imported directly
// from `./types/dag.js` where needed.
```

### Fix 13: Fix stale validate-dag.ts comment
**File:** `packages/framework/src/executor/validate-dag.ts:36-37`  
**Fix:** Replace:
```
 *   - Conditional `when` must be a non-empty plain object (structural
 *     predicate — see ADR 0016).
```
With:
```
 *   - Conditional `when` must be a well-formed function-based predicate
 *     with `{ label: string, version: number, check: Function, minConfidence?: ConfidenceBucket }`.
```

### Fix 14: Fix ADR-0015 stale update note
**File:** `docs/adr/0015-conditional-edges.md:7-11`  
**Fix:** Replace the update block:
```markdown
> **Update (2026-05-10):** the `Guard = (output) => boolean` closure form
> described below was replaced by a function-based `Predicate<T>` with
> `{ label, version, check, minConfidence? }` — see `types/dag.ts` and
> ADR 0028. The active-set runtime, else-totality, and routing rules below
> are unchanged; only the `when` payload type and the `guard-threw` error
> kind (renamed `predicate-malformed`) differ.
```

### Fix 15: Fix ADR-0001 stale directory listing
**File:** `docs/adr/0001-single-package-layered-modules.md`  
**Fix:** Replace `queue-memory/     # in-process adapter for tests` with nothing (the in-memory adapter lives in `queue/in-memory.ts`). The directory listing should be:
```
  queue/            # Queue interface + shared types + in-memory adapter
  queue-bullmq/     # BullMQ adapter (only folder allowed to import bullmq/ioredis)
```

### Fix 16: Fix `dag-type-system.md` stale rows
**File:** `docs/dag-type-system.md:21-24`  
**Fix:** Remove the `Deps ↔ edges symmetry` and `` `deps` references known nodes `` rows from the table. Update "Guards are pure" to "Predicates — closures; version field ensures fingerprint changes on logic edits".

### Fix 17: Fix ADR-0015 stale `decideRoute` dual-call note
**File:** `docs/adr/0015-conditional-edges.md:84` (implementation notes)  
**Fix:** Add amendment that routing is now computed once per wave via precomputed `routingDecisions` passed through, with fallback to inline evaluation for legacy replay.

### Fix 18: Delete `coldCache()` deprecated dead code
**File:** `packages/framework/src/observer/policy.ts:35-38`  
**Fix:** Delete the function entirely. Greenfield repo, no consumers.

### Fix 19: Remove hardcoded "13" from observer comments
**Files:** `packages/framework/src/types/observer.ts:15`, `packages/framework/src/observer/observer.ts:86` (if present)  
**Fix:** Replace "13-method interface" with "multi-method interface" or "N-method interface" in any comment. The point stands without the number.

### Fix 20: Remove stale `FR-*` spec references from source comments
**Files:** Multiple files listed in review  
**Fix:** Replace `FR-XXX` references with brief English descriptions. Examples:
- `// Retry-policy helpers — FR-026 (retry budget) + FR-027 (backoff)` → `// Retry-policy helpers — retry budget + exponential backoff with jitter`
- `// Pure DAG transition function — FR-021` → `// Pure DAG transition function — no I/O, no side effects`
- `// FR-033: abort from any non-terminal state` → `// Abort from any non-terminal state`

Do a `grep -rn 'FR-' packages/framework/src/ --include='*.ts' | grep -v __tests__` and replace each.

### Fix 21: `Result.unwrap` error message → use JSON.stringify
**File:** `packages/framework/src/types/result.ts:33`  
**Fix:**
```typescript
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(
    `Called unwrap on Err: ${typeof r.error === "object" && r.error !== null ? JSON.stringify(r.error) : String(r.error)}`,
  );
};
```

### Fix 22: Add `tryCatch` to Result
**File:** `packages/framework/src/types/result.ts`  
**Fix:** Add at the end of the file:
```typescript
/** Wrap a throwing function in a Result. Catches synchronous exceptions. */
export const tryCatch = <T>(fn: () => T): Result<T, Error> => {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};

/** Wrap an async throwing function in a Result. */
export const tryCatchAsync = async <T>(fn: () => Promise<T>): Promise<Result<T, Error>> => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
};
```

Export `tryCatch` and `tryCatchAsync` from the types barrel (not `unwrap`).

### Fix 23: Fix duplicate Result re-export in `index.ts`
**File:** `packages/framework/src/index.ts:35`  
**Fix:** Remove the explicit `export { type Result, ... } from "./types/result.js"` line — it's already covered by `export * from "./types/index.js"`. The barrel comment about "kernel section" is misleading.

---

## Wave 4 — Tests + test hygiene

### Fix 24: Add `retry-policy.test.ts`
**File:** `packages/framework/src/__tests__/retry-policy.test.ts` (new)  
**Coverage:**
- Each of the 5 fast-fail kinds → always terminal, no retry
- Co-failed sibling pre-increment → siblings don't get limit+1 executions
- `handleHookCrash` retry within budget → retrying-hook state
- `handleHookCrash` budget exhausted → failed with retry-exhausted
- `computeBackoffMs` with per-node override vs DAG default vs hardcoded
- Property test: `handleNodeFailed(fast-fail-kind, any-ctx) => always terminal`

### Fix 25: Add `wave-resolution.test.ts`
**File:** `packages/framework/src/__tests__/wave-resolution.test.ts` (new)  
**Coverage:**
- Output merge from wave nodes
- Active-set expansion with routing decisions
- All-pruned final wave → fallback to last active node
- Missing nodeDef during review collection → defensive error
- `routingDecisions` omitted → fallback path (legacy replay compat)
- Human review queue collection

### Fix 26: Add `human-resolution.test.ts`
**File:** `packages/framework/src/__tests__/human-resolution.test.ts` (new)  
**Coverage:**
- Approve → output preserved, advance
- Approve-with-edit → output replaced
- Reject → failed with `rejected`
- Backward reroute → active-set reseeded, outputs/retries cleared for later waves
- Forward reroute → rejected as `invalid-reroute`
- `predicate-malformed` during reroute re-evaluation
- Pending reviews queue processing order
- Missing node definition defensive path

### Fix 27: Add `retry-async.test.ts`
**File:** `packages/framework/src/__tests__/retry-async.test.ts` (new)  
**Coverage:**
- Success on first attempt → no delay
- Success on second attempt → one delay
- All attempts fail → throws last error
- Linear backoff formula: delay = `baseDelayMs * (i + 1)`
- `maxAttempts: 1` → no retry

---

## Wave 4b — Test hygiene (can be parallel)

### Fix 28: Migrate `@ts-expect-error` branded ID annotations to `_id-helpers.ts`
**Files:** 17 test files with 37 `@ts-expect-error` annotations  
**Fix:** Replace `"some-id" as unknown as NodeId` / `// @ts-expect-error` patterns with `N("some-id")`, `R("some-id")`, `D("some-id")` from `_id-helpers.ts`.

### Fix 29: Split `pass-2-remediation.test.ts` and `pass-3-remediation.test.ts`
**Fix:** Move tests into properly-named files matching the module they test. Delete the catch-all files.

---

## Execution Order

```
Wave 1 (critical):  Fix 1, 2, 3, 4    — blocks merge
Wave 2 (important): Fix 5-11           — blocks merge  
Wave 3 (cleanup):   Fix 12-23          — should merge together
Wave 4 (tests):     Fix 24-29          — can run parallel with Wave 3
```

**Estimated total:** ~3 hours of focused work. Wave 1+2 are the must-haves.
