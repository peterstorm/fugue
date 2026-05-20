# PR Review Fix Plan — Important Issues

**Date:** 2026-05-19  
**Branch:** feat/initial-setup  
**Scope:** 6 important issues from comprehensive PR review

---

## Fix 1: Observer isolation gap in eval-judge.ts

**Problem:** `emitJudgeSkipped` calls `ctx.observer.observe()` directly, bypassing
the error-isolating `dispatchEvent` wrapper. A throwing observer crashes eval-judge runs.

**File:** `packages/framework/src/nodes/eval-judge.ts`

**Fix:**
```typescript
// Add import:
import { dispatchEvent } from "../observer/dispatch.js";

// Replace direct observer.observe() call (~line 48-60) with:
const emitJudgeSkipped = (ctx: NodeContext, judgeId: string, reason: string): void => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer, {
      type: "sub-span",
      // ... rest unchanged
    });
  }
};
```

**Verify:** Search for any other direct `observer.observe()` calls outside dispatch.ts:
```bash
grep -rn "observer\.observe(" packages/framework/src/ --include="*.ts" | grep -v dispatch.ts | grep -v observer.ts | grep -v "__tests__"
```

---

## Fix 2: deserializeValue context in queue-bullmq/job.ts

**Problem:** `deserializeValue(bullJob.data)` in the `get data()` accessor throws
without queue/job context — a corrupt `__date__` value crashes the worker with an
unhelpful error message.

**File:** `packages/framework/src/queue-bullmq/job.ts` (~line 135)

**Fix:** Wrap `deserializeValue` in try/catch with contextual re-throw:
```typescript
get data(): { state: S; context: C } {
  let raw: unknown;
  try {
    raw = deserializeValue(bullJob.data);
  } catch (e) {
    throw new Error(
      `[adaptBullMQJob] deserializeValue failed for queue "${queueName}" job "${bullJob.id}": ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (validateData) {
    const result = validateData(raw);
    if (!result.ok) {
      throw new Error(
        `[adaptBullMQJob] data validation failed for queue "${queueName}" job "${bullJob.id}": ${result.error.kind === "checkpoint-corrupt" ? result.error.message : String(result.error)}`,
        { cause: result.error },
      );
    }
    return result.value as { state: S; context: C };
  }
  return raw as { state: S; context: C };
},
```

---

## Fix 3: Jitter formula comments (2 locations)

**Problem:** Comments say `baseDelay * (1 + jitterRatio * random)` (additive-only,
range `[1, 1+ratio]`), but `applyJitter` uses symmetric jitter:
`delayMs * (1 + (random()*2 - 1) * jitterRatio)` (range `[1-ratio, 1+ratio]`).

**File 1:** `packages/framework/src/dag-runtime/executor.ts` (~line 249)

**Fix:**
```typescript
// FR-027: delay = nextDelayMs * (1 ± jitterRatio) — symmetric jitter via applyJitter
```

**File 2:** `packages/framework/src/dag-runtime/retry-policy.ts` (~line 20)

**Fix:**
```typescript
/**
 * Returns the base delay; the DAG executor applies symmetric jitter via
 * `applyJitter`: `baseDelay * (1 + (2·random()-1) * jitterRatio)`.
 */
```

---

## Fix 4: wave-resolution.ts misleading comment

**Problem:** Comment says "When omitted... the transition falls back to recomputing
decisions on the fly" — this is false. The code `continue`s without recomputation.
ADR-0029 makes decisions mandatory.

**File:** `packages/framework/src/dag-runtime/wave-resolution.ts` (~line 67-68)

**Fix:** Replace the misleading comment block:
```typescript
/**
 * Called when the executor reports `wave-done` from a `running` state.
 *
 * Precedence:
 * 1. Merge new outputs into context.
 * 2. If there are humanReview nodes, enter `awaiting-human` for the first one.
 * 3. Otherwise advance to next wave or `succeeded`.
 *
 * `routingDecisions` is the per-source-node routing decision computed once
 * during wave execution (ADR-0029: mandatory, never re-evaluate predicates).
 * The transition reads `chosenTargets` to expand `activeNodeIds`. Nodes
 * without conditional out-edges simply have no entry — expansion is a no-op.
 */
```

---

## Fix 5: README inaccuracies (3 sub-fixes)

**File:** `packages/framework/README.md`

### 5a: Remove `unwrap` from public API list

`unwrap` is intentionally NOT exported from the barrel. Replace the Result line:

```markdown
- `Result`, `Ok`, `Err`, `ok`, `err`, `isOk`, `isErr`, `andThen`, `andThenAsync`, `map`, `mapAsync`, `mapErr`, `unwrapOr`, `fold`, `orElse`, `tryCatch`, `tryCatchAsync`, `sequenceFirst`, `sequenceAll`, `tap`, `tapErr`, `fromNullable` — the `Either` shape used everywhere errors are returned (no exceptions across module boundaries). (`unwrap` is available via direct path import for tests but is intentionally excluded from the barrel.)
```

### 5b: Add missing ObserverEvent types

Replace the event list line:
```markdown
- `ObserverEvent` (and the per-event types `RunStartEvent`, `NodeStartEvent`, `NodeEndEvent`, `NodeSkippedEvent`, `NodeErrorEvent`, `SubSpanEvent`, `RunEndEvent`, `RouteDecidedEvent`, `NodePrunedEvent`, `WitnessCapturedEvent`, `WriteAttemptedEvent`, `FreshnessViolationEvent`, `HumanInterventionEvent`), `SpanKind` — the typed event envelope flowing through the `Observer` interface (which lives under `observer/`).
```

### 5c: Fix `onTrace` placement note

Replace:
```markdown
(`onTrace` is on `DagRunOpts` for the advanced kernel-mode entries — see below.)
```
With:
```markdown
(`onTrace` is available on `RunOptions`.)
```

---

## Fix 6: Reduce __brandNodeId escape-hatch surface

**Problem:** 30+ `__brandNodeId` usages erode the ID validation guarantee. Three
categories need attention:

### 6a: Pre-validate sentinel constants

**File:** `packages/framework/src/dag-runtime/types.ts`

Currently:
```typescript
export const EXECUTOR_NODE_ID = __brandNodeId("__executor__");
```

The string `"__executor__"` matches `ID_REGEX` (alphanumeric + underscore), so use
the validating smart constructor instead:

```typescript
import { nodeId } from "../types/ids.js";
export const EXECUTOR_NODE_ID = nodeId("__executor__");
```

**File:** `packages/framework/src/dag-runtime/wave-execution.ts`

Replace inline `__brandNodeId("__wave__")` with a module-level constant:
```typescript
import { nodeId } from "../types/ids.js";
const WAVE_NODE_ID = nodeId("__wave__");
```

### 6b: Validate record keys in validate-dag.ts

**File:** `packages/framework/src/executor/validate-dag.ts`

The node IDs come from `Object.entries(input.nodes)` where keys are user-supplied.
Instead of `__brandNodeId(id)`, use the validating constructor — this catches
malformed user input at the DAG definition boundary:

```typescript
import { nodeId as validateNodeId, tryNodeId } from "../types/ids.js";

// In the node loop, replace:
//   const nodeIds = new Set(entries.map(([id]) => __brandNodeId(id)));
// With:
for (const [id] of entries) {
  const parsed = tryNodeId(id);
  if (!parsed.ok) {
    return err(validationErr(__brandNodeId("__dag__"), `Invalid node id "${id}": ${parsed.error}`));
  }
}
const nodeIds = new Set(entries.map(([id]) => nodeId(id)));
```

Similarly for edge `from`/`to` in `normalizeEdge`:
```typescript
const fromResult = tryNodeId(e.from);
if (!fromResult.ok) return err(validationErr(nodeId("__dag__"), `Invalid edge from id "${e.from}": ${fromResult.error}`));
// etc.
```

### 6c: Node factories — acceptable as-is

The `createLlmNode`, `createFetchNode`, etc. use `__brandNodeId(config.id)` where
`config.id` is author-supplied. These are borderline: the author controls the string
and invalid IDs would fail later at `defineDag`. However, for consistency, switching
to `nodeId(config.id)` would surface invalid IDs immediately at factory call time
rather than deferring to `defineDag`:

```typescript
// In each node factory, replace:
const id = __brandNodeId(config.id);
// With:
const id = nodeId(config.id);
```

This is a minor behavior change (throws at factory time vs. at defineDag time) but
gives better error locality. Apply to: `llm.ts`, `llm-with-tools.ts`, `fetch.ts`,
`transform.ts`, `guardrail.ts`, `eval-judge.ts`.

---

## Execution Order

1. **Fix 1** (eval-judge observer isolation) — smallest, most critical safety fix
2. **Fix 2** (deserialize context) — small, improves operability 
3. **Fix 3** (jitter comments) — trivial text fix
4. **Fix 4** (wave-resolution comment) — trivial text fix
5. **Fix 5** (README) — documentation accuracy
6. **Fix 6** (brand escapes) — largest change, most tests to verify

## Verification

After all fixes:
```bash
bun test
bun run packages/framework/src/scripts/check-imports.ts
```

Ensure no new `__brandNodeId` imports appear in files that previously had none.
