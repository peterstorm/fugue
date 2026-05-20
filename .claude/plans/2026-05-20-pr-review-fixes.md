# PR Review Fix Plan — 2026-05-20

## Summary

14 issues from comprehensive PR review. Grouped by dependency order — later fixes
may touch files edited by earlier ones.

---

## Phase 1: Critical — Failing Tests (3 items)

### Fix 1.1: Server resume tests expect 404 but get 409

**Root cause:** `InMemoryCheckpointer.load()` checks `meta.frameworkVersion !== FRAMEWORK_VERSION`
BEFORE the server gets to check `meta.subject`. Tests seed metas without `dagFingerprint` or
`frameworkVersion`, so the checkpointer rejects them as `checkpoint-version-mismatch` (→ 409)
before the server reaches the subject comparison (→ 404).

**Files:**
- `apps/customer-summary/src/__tests__/server.test.ts` (lines ~125, ~275)

**Fix:** The test fixtures need to supply `frameworkVersion` and `dagFingerprint` that match
the current runtime values, so `load()` succeeds and the server reaches the subject check.

```typescript
import { FRAMEWORK_VERSION, dagFingerprint } from "@ai-summary/framework/checkpoint";
// ... in test setup:
await cp.setMeta(victimRunId, {
  dagId: "customer-summary",
  startedAt: new Date(),
  nodeCount: dag.nodes.length,  // must match current dag
  subject: "cust-001",
  dagFingerprint: dagFingerprint(dag),  // match current shape
  frameworkVersion: FRAMEWORK_VERSION,  // match running framework
});
```

Same pattern for the "legacy meta (no subject)" test — use `__testRawMetas()` to insert a meta
that has the correct fingerprint/version but NO subject field, so `load()` passes but
`meta.subject !== customer_id` triggers the 404.

**Verify:** `bun test apps/customer-summary/src/__tests__/server.test.ts`

---

### Fix 1.2: Resume test — checkpoints never written

**Root cause:** Test at `observability-resume.test.ts:266-272` creates a `cache` object with
a `writeCheckpoint` method, but `run-node.ts` uses `ctx.checkpointWriter.write(runId, nodeId, output)`.
The `cache` field is a `ContextCacheAdapter` (get/set), not a `CheckpointWriter`.

**File:** `apps/customer-summary/src/__tests__/observability-resume.test.ts` (lines ~266-280)

**Fix:** Wire a proper `checkpointWriter` on the NodeContext:

```typescript
const checkpoints: Map<string, unknown> = new Map();
const checkpointWriter: CheckpointWriter = {
  write: async (_runId, nodeId, output) => {
    checkpoints.set(nodeId, output);
  },
};

const ctx1: NodeContext = makeNodeContext({
  runId: runId("run-1"),
  dagId: "resume-3node",
  checkpointWriter,   // ← this is what run-node.ts reads
});
```

Remove the orphaned `cache.writeCheckpoint` method.

**Verify:** `bun test apps/customer-summary/src/__tests__/observability-resume.test.ts`

---

## Phase 2: Safety — Silent Failure Paths (3 items)

### Fix 2.1: Guard `defaultEdge!` in routing.ts

**File:** `packages/framework/src/dag-runtime/routing.ts:181`

**Fix:** Replace non-null assertion with explicit guard:

```typescript
// Before:
chosenTargets: new Set([...unconditionalTargets, defaultEdge!.to]),

// After:
if (!defaultEdge) {
  return {
    kind: "predicate-malformed",
    fromNodeId,
    message: `No default edge found for node '${fromNodeId}' when no predicate matched`,
  };
}
return {
  kind: "decided",
  chosenTargets: new Set([...unconditionalTargets, defaultEdge.to]),
  prunedTargets: pruned,
  defaultTaken: true,
  predicateResults,
};
```

**Verify:** `bun test packages/framework/src/__tests__/conditional-edges-routing.test.ts`

---

### Fix 2.2: Tighten error object check in run-node.ts

**File:** `packages/framework/src/dag-runtime/run-node.ts:155-159`

**Fix:**

```typescript
// Before:
const frameworkError: FrameworkError =
  runResult.error !== null &&
  typeof runResult.error === "object" &&
  "kind" in (runResult.error as object)
    ? (runResult.error as FrameworkError)
    : { kind: "node-crash" as const, nodeId, retriability: "retriable" as const, message: String(runResult.error) };

// After:
const frameworkError: FrameworkError =
  runResult.error !== null &&
  typeof runResult.error === "object" &&
  "kind" in runResult.error &&
  typeof (runResult.error as Record<string, unknown>).kind === "string"
    ? (runResult.error as FrameworkError)
    : { kind: "node-crash" as const, nodeId, retriability: "retriable" as const, message: String(runResult.error) };
```

Remove the `as object` widening cast; the `typeof === "object" && !== null` check already narrows.

**Verify:** `bun test packages/framework/src/__tests__/executor.test.ts`

---

### Fix 2.3: BufferedObserver — let policy errors propagate

**File:** `packages/framework/src/observer/buffered.ts` in `handleRunEnd()`

**Fix:** Move `policy.shouldFlush(summary)` outside the try block, or catch policy exceptions
separately and propagate them (since a broken policy is a programmer error, not a transient
failure that should be silenced):

```typescript
private handleRunEnd(e: RunEndEvent): void {
  const buf = this.buffers.get(e.runId);
  if (!buf) {
    fwLogger().warn(`[BufferedObserver] onRunEnd for unknown runId=${e.runId}`);
  }
  const events = buf?.events ?? [];
  const summary = computeRunSummary(events, e);
  this.aggregates.runCount++;

  // Policy evaluation is programmer-provided — let bugs surface.
  let shouldFlush: boolean;
  try {
    shouldFlush = this.policy.shouldFlush(summary);
  } catch (policyErr) {
    fwLogger().error(`[BufferedObserver] PersistencePolicy.shouldFlush threw — flushing to avoid data loss:`, policyErr);
    shouldFlush = true; // fail-open: flush on policy error
  }

  try {
    if (shouldFlush) {
      // ... replay + dispatch ...
    } else {
      fwLogger().warn(...);
    }
  } finally {
    this.buffers.delete(e.runId);
  }
}
```

**Verify:** `bun test packages/framework/src/__tests__/buffered-observer.test.ts`

---

## Phase 3: Type Safety (2 items)

### Fix 3.1: In-memory queue double-cast

**File:** `packages/framework/src/queue/in-memory.ts:163`

**Fix:** The `processFn` parameter type should accept the concrete in-memory job type.
The generic constraint on `createWorker` already binds `S` and `C`. The cast is needed
because `InMemoryJob` doesn't exactly match `JobLike<S, unknown, C>` (the `E` slot).
Add a private adapter function:

```typescript
// Before:
await processFn(job as unknown as JobLike<unknown, unknown, unknown>);

// After:
await processFn(job as JobLike<S, unknown, C>);
```

The single `as` is safe because `InMemoryJob` implements `JobLike` with `E = unknown`.
The double cast through `unknown` is unnecessary.

**Verify:** `bun test packages/framework/src/__tests__/queue-memory.test.ts`

---

### Fix 3.2: Add `tryConfidence` public Result-returning constructor

**File:** `packages/framework/src/types/confidence.ts`

**Fix:** Add alongside existing `confidence()`:

```typescript
/** Result-returning variant for parse boundaries. Never throws. */
export const tryConfidence = (
  bucket: string,
  source: string,
  raw?: number | string,
): Result<Confidence, string> => {
  if (!(bucket in CONFIDENCE_ORDER)) {
    return err(`unknown confidence bucket '${bucket}'`);
  }
  if (!(CONFIDENCE_SOURCES as readonly string[]).includes(source)) {
    return err(`unknown confidence source '${source}'`);
  }
  if (source === "self-reported-numeric" && typeof raw === "number" && (raw < 0 || raw > 1)) {
    return err(`confidence raw value for "self-reported-numeric" must be in [0, 1], got ${raw}`);
  }
  if (source === "logprob" && (raw === undefined || typeof raw !== "number")) {
    return err(`confidence source "logprob" requires a numeric raw value`);
  }
  return ok({
    bucket: bucket as ConfidenceBucket,
    source: source as ConfidenceSource,
    ...(raw !== undefined ? { raw } : {}),
  } as Confidence);
};
```

Export from `packages/framework/src/types/index.ts`.

**Verify:** Add a unit test in `packages/framework/src/__tests__/confidence-buckets.test.ts`.

---

## Phase 4: Architecture (2 items)

### Fix 4.1: Extract `validateApproveEdit` to shared/

**Files:**
- `packages/framework/src/dag-runtime/executor.ts` (move function OUT)
- `packages/framework/src/shared/validate.ts` (move function IN)

**Fix:** Move `validateApproveEdit` from executor.ts to shared/validate.ts. It's a pure
function (no I/O, no async, no observer interaction). The executor imports and calls it.

```typescript
// shared/validate.ts — add:
export const validateApproveEdit = (
  action: { kind: string; newOutput?: unknown },
  nodeId: NodeId,
  nodeMap: ReadonlyMap<NodeId, { outputSchema: z.ZodType<unknown> }>,
): string | null => {
  if (action.kind !== "approve-with-edit") return null;
  const nodeDef = nodeMap.get(nodeId);
  if (!nodeDef) return `approve-with-edit: node '${nodeId}' not found in DAG`;
  const parsed = nodeDef.outputSchema.safeParse((action as { newOutput: unknown }).newOutput);
  if (!parsed.success) return `approve-with-edit output failed schema for node '${nodeId}': ${parsed.error.message}`;
  return null;
};
```

**Verify:** `bun test packages/framework/src/__tests__/human-resolution.test.ts`

---

### Fix 4.2: Extract OpenAI Responses API types

**Files:**
- Create `packages/framework/src/llm/openai-types.ts` (new)
- `packages/framework/src/llm/openai-client.ts` (trim)

**Fix:** Move `FunctionCallBlock`, `MessageBlock`, `ReasoningBlock`, `ResponsesOutputItem`,
`FunctionCallOutputItem`, `ConversationItem`, `ResponsesUsage`, `ResponsesApiResponse`,
and the type-guard functions (`isFunctionCallBlock`, `isMessageBlock`, `isOutputTextPart`,
`isReasoningBlock`) into `openai-types.ts`. Import in `openai-client.ts`.

**Verify:** `bun test packages/framework/src/__tests__/openai-client.test.ts`

---

## Phase 5: Documentation (3 items)

### Fix 5.1: Add FRAMEWORK_VERSION to CONTEXT.md

**File:** `CONTEXT.md`

**Fix:** Add to "State Machine Kernel" table:

```markdown
| **FrameworkVersion** | Content-hash of the framework's checkpoint format. Resume rejects checkpoints from a different version to prevent semantic drift. |
```

---

### Fix 5.2: Add FR-XXX → ADR cross-reference comment

**File:** `packages/framework/src/dag-runtime/executor.ts` (top-of-file comment)

**Fix:** Add a mapping comment:

```typescript
// Requirement references:
//   FR-005 → ADR-0003 (event sourcing)
//   FR-006 → ADR-0005 (retry layering)
//   FR-007 → ADR-0005 (retry layering)
//   FR-011 → ADR-0005 (retry layering)
//   FR-012 → ADR-0006 (joblike minimal write side)
//   FR-021 → ADR-0021 (single-path runtime)
//   FR-026..FR-033 → ADR-0013, ADR-0015, ADR-0029
//   FR-027 → ADR-0005 (retry backoff)
//   FR-029a → ADR-0013 (onHumanReview hook crash retry)
```

---

### Fix 5.3: Document skipped tests rationale

**File:** Create `packages/framework/src/__tests__/REDIS_TESTS.md`

**Fix:**

```markdown
# Redis/BullMQ Integration Tests

## Why they're skipped

These 34 tests require a running Redis instance. They are guarded by:
- `describe.skipIf(!process.env.REDIS_URL)` or similar

## Running locally

```bash
docker compose -f infra/compose.yaml up redis -d
export REDIS_URL=redis://localhost:6379
bun test --filter redis
bun test --filter bullmq
```

## CI Coverage

TODO: Add Redis service to CI workflow once infra pipeline is established.
```

---

## Phase 6: Final Polish

### Fix 6.1: Run full test suite, confirm 0 failures

```bash
bun test
```

Expected: 1348 pass, 34 skip (Redis), 0 fail.

---

## Execution Order

```
Phase 1 (critical tests) → Phase 2 (safety) → Phase 3 (types) → Phase 4 (architecture) → Phase 5 (docs) → Phase 6 (verify)
```

Each phase is independently verifiable with targeted `bun test` runs.
Total estimated changes: ~15 files, ~150 lines added/modified.
