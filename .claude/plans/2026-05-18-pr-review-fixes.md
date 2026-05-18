# PR Review Remediation Plan — 2026-05-18

All 31 findings organized into 6 execution waves. No backwards compat needed (greenfield).

---

## Wave 1: Critical — Silent Failures & Data Leakage

### 1.1 `bootstrap.ts` writeCheckpoint must throw on failure (Critical #1)

**File:** `apps/customer-summary/src/bootstrap.ts:113-121`

The adapter swallows `Err` from `cp.saveNode()`. The framework's `run-node.ts` expects `writeCheckpoint` to throw so it can emit `checkpoint-write-failed` and abort the node.

**Fix:** Throw on failure:

```typescript
writeCheckpoint: async (runId: string, nodeId: string, value: unknown) => {
  const r = await cp.saveNode(brandRunId(runId), nodeId, {
    nodeId,
    output: value,
    completedAt: new Date(),
  });
  if (!r.ok) {
    throw new Error(
      `checkpoint write failed for run=${runId} node=${nodeId}: ${r.error.kind}${
        r.error.kind === "cache-error" ? ` — ${r.error.message}` : ""
      }`,
    );
  }
},
```

### 1.2 OpenAI client: truncate API response body in error messages (Critical #2)

**File:** `packages/framework/src/llm/openai-client.ts`

API response bodies can contain sensitive data. Truncate before embedding in `FrameworkError.message`.

**Fix:** Add a helper at module scope:

```typescript
/** Safely truncate API error body to prevent data leakage through error propagation. */
const truncateErrorBody = (body: string, maxLen = 200): string =>
  body.length > maxLen ? body.slice(0, maxLen) + "…[truncated]" : body;
```

Then replace all `${httpResult.status} ${httpResult.bodyText}` patterns (4 occurrences in `sendStructured` and `sendWithTools`) with:

```typescript
message: `HTTP ${httpResult.status}: ${truncateErrorBody(httpResult.bodyText)}`,
```

### 1.3 Move bullmq/ioredis to peerDependencies (Critical #3)

**File:** `packages/framework/package.json`

The `exports` map already isolates `./bullmq`. The dependencies should match.

**Fix:**

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.91.1",
    "@opentelemetry/api": "^1.9.1",
    "@opentelemetry/core": "^2.7.0",
    "@opentelemetry/exporter-trace-otlp-proto": "^0.216.0",
    "@opentelemetry/sdk-node": "^0.215.0",
    "@opentelemetry/sdk-trace-base": "^2.7.0",
    "cron-parser": "^4.9.0",
    "openai": "^6.35.0",
    "ts-pattern": "^5.9.0",
    "zod": "^4.3.6"
  },
  "peerDependencies": {
    "bullmq": "^5.76.6",
    "ioredis": "^5.10.1"
  },
  "peerDependenciesMeta": {
    "bullmq": { "optional": true },
    "ioredis": { "optional": true }
  }
}
```

Update `apps/customer-summary/package.json` to add `bullmq` and `ioredis` as direct dependencies there.

### 1.4 Type-narrow `dagTransition`'s ctx param to prevent closure leakage (Critical #4)

**File:** `packages/framework/src/dag-runtime/transition.ts`

The transition function is pure — it should never access `dag`, `outgoingByNode`, or `nodeById`. Create a narrowed type.

**Fix:** In `types.ts`, add a new type for the transition's read-only view:

```typescript
/**
 * Subset of DagMachineContext visible to the pure transition layer.
 * Excludes live closure-carrying fields (dag, nodeById, outgoingByNode)
 * that must never leak into serialized state.
 */
export type TransitionContext = DagMachineContextPersisted & {
  readonly incomingByNode: ReadonlyMap<NodeId, IncomingSources>;
  readonly outgoingByNode: ReadonlyMap<NodeId, readonly EdgeDef[]>;
};
```

Wait — transition needs `outgoingByNode` for `handleWaveDone` and `handleHumanResponse` (reroute). Let me check what it actually accesses…

Actually, looking at the code: `dagTransition` delegates to `handleWaveDone`, `handleNodeFailed`, `handleHumanResponse`, `handleHookCrash`. These use:
- `ctx.waves` ✓ (persisted)
- `ctx.outputs` ✓ (persisted)
- `ctx.retries` ✓ (persisted)
- `ctx.retryConfigs` ✓ (persisted)
- `ctx.activeNodeIds` ✓ (persisted)
- `ctx.outgoingByNode` ← used by `handleWaveDone` and `handleHumanResponse`
- `ctx.incomingByNode` ← used by `waveNodes`/`advanceToNextWave`

It does NOT need `ctx.dag` or `ctx.nodeById`.

**Fix:** Create `DagTransitionContext` that extends `DagMachineContextPersisted` with only the two precomputed maps it needs:

```typescript
/** Context visible to the pure transition layer. Excludes `dag` and `nodeById` (closures). */
export type DagTransitionContext = DagMachineContextPersisted & {
  readonly incomingByNode: ReadonlyMap<NodeId, IncomingSources>;
  readonly outgoingByNode: ReadonlyMap<NodeId, readonly EdgeDef[]>;
};
```

Change `dagTransition` signature:

```typescript
export const dagTransition = (
  phase: DagPhase,
  event: DagEvent,
  ctx: DagTransitionContext,
): TransitionResult =>
```

And update `TransitionResult`:

```typescript
type TransitionResult = { state: DagPhase; context: DagTransitionContext };
```

The callers pass `DagMachineContext` (which satisfies the narrower type via structural subtyping). The transition can no longer accidentally access `ctx.dag`.

Also update `handleWaveDone`, `handleNodeFailed`, `handleHumanResponse`, `handleHookCrash` to accept `DagTransitionContext`.

### 1.5 Make `evaluatePredicate` return a `predicate-malformed` error instead of swallowing (Critical #5 / Important #9)

**File:** `packages/framework/src/types/dag.ts:77-92`

Currently returns `matched: false` on exception. This hides bugs.

**Fix:** Change return type to include an explicit `threw` discriminant:

```typescript
export type PredicateResult = {
  readonly predicateLabel: string;
  readonly predicateVersion: number;
  readonly evaluatedConfidence: Confidence | null;
} & (
  | { readonly outcome: "matched" }
  | { readonly outcome: "not-matched" }
  | { readonly outcome: "below-min-confidence" }
  | { readonly outcome: "threw"; readonly message: string }
);
```

Then the caller (`route-emission.ts` or wherever routes are decided) can surface a `predicate-malformed` `FrameworkError` and **fail the run** instead of silently taking the default edge:

```typescript
export const evaluatePredicate = <T>(
  pred: Predicate<T>,
  output: T,
  confidence: Confidence | null,
): PredicateResult => {
  if (pred.minConfidence !== undefined) {
    if (confidence === null || !meetsConfidence(confidence.bucket, pred.minConfidence)) {
      return {
        predicateLabel: pred.label,
        predicateVersion: pred.version,
        evaluatedConfidence: confidence,
        outcome: "below-min-confidence",
      };
    }
  }

  try {
    const matched = pred.check(output, confidence);
    return {
      predicateLabel: pred.label,
      predicateVersion: pred.version,
      evaluatedConfidence: confidence,
      outcome: matched ? "matched" : "not-matched",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      predicateLabel: pred.label,
      predicateVersion: pred.version,
      evaluatedConfidence: confidence,
      outcome: "threw",
      message: msg,
    };
  }
};
```

Then in `route-emission.ts` (or `conditional.ts` `decideRoute`), when any predicate has `outcome: "threw"`, return `err({ kind: "predicate-malformed", nodeId, message })` instead of treating it as unmatched. The transition layer already handles this error kind.

---

## Wave 2: Important — Error Handling & Resilience

### 2.1 `scheduler.ts` — Log `markers.exists()` failure (Important #6)

**File:** `packages/framework/src/scheduler/scheduler.ts:323`

**Fix:**

```typescript
const alreadyFired = await markers.exists(markerFiredKey(dep.id))
  .catch((e) => {
    fwLogger().warn(
      `[CronScheduler] markers.exists(fired) failed for "${dep.id}" — treating as not-fired (enqueue is idempotent):`,
      e instanceof Error ? e.message : e,
    );
    return false;
  })
  || inMemoryFiredFallback.has(dep.id);
```

### 2.2 `node-span.ts` — Isolate OTel in catch block (Important #7)

**File:** `packages/framework/src/dag-runtime/node-span.ts:129-139`

**Fix:** Wrap span operations:

```typescript
} catch (e) {
  try { span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) }); } catch { /* OTel failure must not mask node error */ }
  try { span.end(); } catch { /* same */ }
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  return {
    result: err({
      kind: "node-crash" as const,
      nodeId: __brandNodeId(nodeId),
      retriability: "retriable" as const,
      message,
      ...(stack ? { stack } : {}),
    }),
    outcome: EMPTY_OUTCOME,
  };
}
```

### 2.3 `llm-pipeline.ts` — Use `formatFrameworkError` for `lastError` (Important #8)

**File:** `packages/framework/src/nodes/llm-pipeline.ts:73`

**Fix:**

```typescript
import { formatFrameworkError } from "../types/errors.js";

// ...inside the retry-exhausted branch:
return err({
  kind: "retry-exhausted" as const,
  nodeId: config.nodeId,
  attempts: 2,
  lastError: formatFrameworkError(result.error),
  rootErrorKind: result.error.kind,
});
```

### 2.4 `InMemoryFreshnessIndex` — Deduplicate resource entries (Important #10)

**File:** `packages/framework/src/dag-runtime/freshness-check.ts:179-202`

The `resourceOrder` pushes duplicates. Fix: track whether a resource is already in the list.

**Fix:** Add a `resourceSet` for O(1) membership:

```typescript
private readonly resourceSet = new Set<string>();
```

In `recordWrite`, before pushing to `resourceOrder`:

```typescript
if (!this.writes.has(resource)) {
  // ... eviction logic ...
  if (!this.resourceSet.has(resource)) {
    this.resourceOrder.push(resource);
    this.resourceSet.add(resource);
  }
}
```

In the eviction path, when deleting a resource:

```typescript
this.writes.delete(candidate);
this.latest.delete(candidate);
this.resourceSet.delete(candidate);
```

And in the compaction splice:

```typescript
// resourceSet already correct — items were deleted at eviction time
this.resourceOrder.splice(0, this.evictCursor);
this.evictCursor = 0;
```

### 2.5 `server.ts` — Pass fingerprint to `checkpointer.load()` (Important #11)

**File:** `apps/customer-summary/src/server.ts:82-84`

**Fix:** Compute fingerprint before loading, pass as option:

```typescript
const fingerprint = dagFingerprint(dag);
const loaded = await checkpointer.load(brandRunId(resume_run_id), {
  expectedDagFingerprint: fingerprint,
});
```

Remove the subsequent manual fingerprint comparison block (now redundant).

### 2.6 Restrict deep imports via `package.json` exports (Important #12)

**File:** `packages/framework/package.json`

The existing `exports` field already has `.`, `./advanced`, `./bullmq`. These already block deep imports in bundlers/runtimes that respect exports maps. But add a wildcard deny:

```json
"exports": {
  ".": "./src/index.ts",
  "./advanced": "./src/advanced.ts",
  "./bullmq": "./src/bullmq.ts",
  "./package.json": "./package.json"
}
```

No `"./*"` entry = deep imports are denied by default. Bun + Node both respect this. Done — this is actually already correct! The `package.json` I saw already has the right `exports` shape without a wildcard. Verify this blocks `import { __brandNodeId } from "@ai-summary/framework/src/types/ids.js"`.

If Bun doesn't enforce exports-map blocking for workspace links, add a `check-imports.ts` test assertion that verifies `__brandNodeId` is not reachable from the public surface.

### 2.7 Add `orElse` and `andThenAsync` to Result (Important #13)

**File:** `packages/framework/src/types/result.ts`

**Fix:** Add:

```typescript
/** Error recovery: on Err, try an alternative computation. */
export const orElse = <T, E, F>(
  r: Result<T, E>,
  fn: (error: E) => Result<T, F>,
): Result<T, F> => (r.ok ? r : fn(r.error));

/** Async andThen — for chaining async Result-producing functions. */
export const andThenAsync = async <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> => (r.ok ? fn(r.value) : r);

/** Async map — for chaining async transformations on Ok values. */
export const mapAsync = async <T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Promise<U>,
): Promise<Result<U, E>> => (r.ok ? ok(await fn(r.value)) : r);
```

Export from `types/index.ts`:

```typescript
export {
  ok, err, isOk, isErr, andThen, andThenAsync,
  map, mapAsync, mapErr, unwrapOr, fold, orElse,
  tryCatch, tryCatchAsync, sequenceFirst, sequenceAll,
  tap, tapErr,
} from "./result.js";
```

Note: also export `tap`/`tapErr` (fixing Suggestion #25 — they were defined but not exported).

---

## Wave 3: Important — Architecture & Naming

### 3.1 Extract `dispatchEvent` to standalone module (Important #14)

**File:** Create `packages/framework/src/observer/dispatch.ts`

```typescript
import type { Observer } from "./observer.js";
import type { ObserverEvent } from "../types/events.js";
import { fwLogger } from "../logger.js";

const OBSERVER_STRICT =
  typeof process !== "undefined" && process.env?.OBSERVER_STRICT === "1";

/**
 * Error-isolating dispatch wrapper. Production observers MUST be failure-tolerant.
 * Under OBSERVER_STRICT=1 the error is re-thrown for test surfacing.
 */
export function dispatchEvent(observer: Observer, event: ObserverEvent): void {
  try {
    const result: unknown = observer.observe(event);
    if (result !== null && result !== undefined && typeof (result as { catch?: unknown }).catch === "function") {
      (result as Promise<void>).catch((e) => {
        fwLogger().error(
          `[observer] async observe() rejected for ${event.type} — Observer.observe must be synchronous:`,
          e instanceof Error ? e.message : e,
        );
        if (OBSERVER_STRICT) {
          const error = e instanceof Error ? e : new Error(String(e));
          setTimeout(() => { throw error; }, 0);
        }
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

Update `observer/buffered.ts` — remove `dispatchEvent` from it, import from `./dispatch.js`.
Update `observer/index.ts` — re-export from `./dispatch.js`.
Update `dag-runtime/emit.ts` — import from `../observer/dispatch.js` (not `buffered.js`).

### 3.2 Rename `executor/executor.ts` → `executor/run-dag.ts` (Important #15)

**File:** `packages/framework/src/executor/executor.ts` → `packages/framework/src/executor/run-dag.ts`

Update `executor/index.ts` to import from `./run-dag.js`.

### 3.3 Split `ContextCacheAdapter` into `CacheAdapter` + `CheckpointWriter` (Important #16)

**File:** `packages/framework/src/types/node.ts`

**Fix:**

```typescript
export interface CacheAdapter {
  readonly get: (key: string) => Promise<CacheLookup>;
  readonly set: (key: string, value: unknown, ttlSec?: number) => Promise<Result<void, FrameworkError>>;
}

export interface CheckpointWriter {
  readonly write: (runId: RunId, nodeId: NodeId, value: unknown) => Promise<void>;
}
```

On `NodeContext`:

```typescript
readonly cache?: CacheAdapter | null;
readonly checkpointWriter?: CheckpointWriter | null;
```

Update `run-node.ts` to use `ctx.checkpointWriter?.write(...)` instead of `ctx.cache?.writeCheckpoint(...)`.
Update `bootstrap.ts` to construct them separately.
Update `makeNodeContext` defaults.

### 3.4 Fix ADR-0019 cross-references (Important #17)

**File:** `packages/framework/src/executor/run-dag.ts` (after rename)

**Fix:** Remove the ADR-0019 citations. The durability advisory doesn't have its own ADR. Replace with inline explanation:

```typescript
// runDag — public runtime entry point. All DAG runs flow through
// `runDagStateful` (ADR-0021). Responsibilities:
//   1. Bidirectional HITL contract — reject if the DAG declares `humanReview`
//      without an `onHumanReview` hook, and reject the inverse.
//   2. Durability advisory — warn when the DAG declares retries or conditional
//      edges but the caller did not provide a durable jobLike.
//   3. Translate the public `resume: { runId, checkpoint }` shape into
//      `runDagStateful`'s `resumeCheckpoint`.
```

Remove `(ADR-0019)` from the `suppressRoutingWarnings` JSDoc and the inline comment.

### 3.5 Fix ADR-0007 reference in runner.ts (Important #18)

**File:** `packages/framework/src/state-machine/runner.ts:181`

**Fix:** Change:
```
// See ADR 0005 + ADR 0007 for the full two-layer retry rationale.
```
to:
```
// See ADR 0005 for the two-layer retry rationale.
```

---

## Wave 4: Tests — Redis Failure & Tool Execution

### 4.1 Add Redis connection failure unit tests (Important #19)

**File:** Create `packages/framework/src/__tests__/redis-checkpointer-failure.test.ts`

Create a mock ioredis that throws `ECONNREFUSED`:

```typescript
import { describe, test, expect } from "bun:test";
import { RedisCheckpointer } from "../checkpoint/redis-checkpointer.js";
import { runId } from "../types/ids.js";

const makeFailingRedis = (errorMsg: string) => ({
  get: () => { throw new Error(errorMsg); },
  set: () => { throw new Error(errorMsg); },
  hgetall: () => { throw new Error(errorMsg); },
  hset: () => { throw new Error(errorMsg); },
  hmset: () => { throw new Error(errorMsg); },
  evalsha: () => { throw new Error(errorMsg); },
  eval: () => { throw new Error(errorMsg); },
  scriptLoad: () => { throw new Error(errorMsg); },
  expire: () => { throw new Error(errorMsg); },
  del: () => { throw new Error(errorMsg); },
});

describe("RedisCheckpointer — connection failure paths", () => {
  test("load() returns cache-error on connection failure", async () => {
    const cp = new RedisCheckpointer(makeFailingRedis("ECONNREFUSED") as any);
    const result = await cp.load(runId("run-test-123"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });

  test("saveNode() returns cache-error on connection failure", async () => {
    const cp = new RedisCheckpointer(makeFailingRedis("ETIMEDOUT") as any);
    const result = await cp.saveNode(runId("run-test-123"), "node-1", {
      nodeId: "node-1",
      output: { data: "test" },
      completedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });

  test("setMeta() returns cache-error on connection failure", async () => {
    const cp = new RedisCheckpointer(makeFailingRedis("ECONNREFUSED") as any);
    const result = await cp.setMeta(runId("run-test-123"), {
      dagFingerprint: "abc123",
      dagId: "test-dag",
      startedAt: new Date(),
      subject: "cust-001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("cache-error");
    }
  });
});
```

Similarly for `RedisCache`:

**File:** Create `packages/framework/src/__tests__/redis-cache-failure.test.ts`

### 4.2 Add tool execution failure test (Important #20)

**File:** Add to `packages/framework/src/__tests__/openai-client.test.ts`

```typescript
test("sendWithTools: tool.run throwing surfaces as node-crash", async () => {
  // Mock postResponses to return a tool call
  // Register a tool whose run() throws
  // Verify the error surfaces correctly (not swallowed)
});
```

Do the same for `anthropic-client.test.ts`.

---

## Wave 5: Suggestions — Hardening & Polish

### 5.1 Add total timeout for sendWithTools (Suggestion #21)

**File:** `packages/framework/src/llm/openai-client.ts` and `anthropic-client.ts`

**Fix:** Add `deadlineMs` to `SendWithToolsRequest`:

```typescript
// In types/llm.ts
export interface SendWithToolsRequest<O> {
  // ... existing fields ...
  /** Total wall-clock deadline across all turns (ms). Default: unlimited. */
  readonly deadlineMs?: number;
}
```

At top of `sendWithTools` loop:

```typescript
const deadline = req.deadlineMs ? Date.now() + req.deadlineMs : Infinity;

for (let turn = 0; turn < maxIterations; turn++) {
  if (Date.now() >= deadline) {
    return err({
      kind: "transient",
      nodeId: resolveNodeId(req),
      message: `Total deadline of ${req.deadlineMs}ms exceeded after ${turn} turns`,
    });
  }
  // ...existing abort check...
}
```

### 5.2 Separate pre-flight from I/O in sendStructured (Suggestion #22)

**File:** `packages/framework/src/llm/openai-client.ts`

**Fix:** Build schema before the try/catch:

```typescript
async sendStructured<O>(req: LlmRequest<O>): Promise<Result<LlmResponse<O>, FrameworkError>> {
  // Pre-flight: schema construction is deterministic — non-retriable on failure
  let schema: Record<string, unknown>;
  try {
    schema = buildJsonSchema(req.schema as z.ZodType<any>);
  } catch (e) {
    return err({
      kind: "validation",
      nodeId: resolveNodeId(req),
      message: `Schema construction failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  try {
    // ... rest of method using `schema` ...
```

### 5.3 Tracing init failure → `log.error` (Suggestion #23)

**File:** `apps/customer-summary/src/bootstrap.ts:67`

**Fix:** `log.warn(...)` → `log.error(...)`

### 5.4 Validate `raw` bounds in `confidence()` constructor (Suggestion #24)

**File:** `packages/framework/src/types/confidence.ts:26-28`

**Fix:**

```typescript
export const confidence = (
  bucket: ConfidenceBucket,
  source: ConfidenceSource,
  raw?: number | string,
): Confidence => {
  if (source === "self-reported-numeric" && typeof raw === "number") {
    if (raw < 0 || raw > 1) {
      throw new RangeError(
        `confidence raw value for "self-reported-numeric" must be in [0, 1], got ${raw}`,
      );
    }
  }
  return ({ bucket, source, ...(raw !== undefined ? { raw } : {}) }) as Confidence;
};
```

Also clamp in `bucketFromProbability`:

```typescript
export const bucketFromProbability = (
  p: number,
  thresholds: { high: number; medium: number } = { high: 0.85, medium: 0.6 },
): ConfidenceBucket => {
  if (p < 0 || p > 1) {
    throw new RangeError(`bucketFromProbability: p must be in [0, 1], got ${p}`);
  }
  return p >= thresholds.high ? "high" : p >= thresholds.medium ? "medium" : "low";
};
```

### 5.5 Export `tap`/`tapErr` from types barrel (Suggestion #25)

Already addressed in Wave 2.7 — include in the `types/index.ts` export list.

### 5.6 Add `@ai-summary/framework/testing` subpath (Suggestion #26)

**File:** `packages/framework/package.json`

```json
"exports": {
  ".": "./src/index.ts",
  "./advanced": "./src/advanced.ts",
  "./bullmq": "./src/bullmq.ts",
  "./testing": "./src/testing.ts"
}
```

Create `packages/framework/src/testing.ts`:

```typescript
// @ai-summary/framework/testing — helpers for test consumers
export { FakeLlmClient } from "./llm/fake-client.js";
```

Remove `FakeLlmClient` from the main `llm/index.ts` barrel export.

### 5.7 Memoize DagDef per topology (Suggestion #27)

**File:** `apps/customer-summary/src/dag/summary-dag.ts`

If the DAG topology is static (same nodes/edges regardless of input), factor `defineDag` call out of the per-request path. Pass customer-specific data through `initialInput` rather than closing over it in the `NodeDef`.

This depends on the current structure — likely a small refactor:
- Extract the DagDef definition to module scope (computed once)  
- Make `fetch-customer`'s `run()` read `customer_id` from `input` rather than a closure

---

## Wave 6: Comments & Documentation Cleanup

### 6.1 Remove stale comments (Suggestion #28)

**File:** `packages/framework/src/observer/index.ts:17`
Remove: `// coldCache removed — was deprecated, always returned true`

**File:** `packages/framework/src/dag-runtime/index.ts:23`
Change: `// Gap-2 fix: re-export topoSort (already returns Result on cycle) for consumers who need it`
To: `// Re-export topoSort for consumers building custom static analyses (returns Result on cycle)`

**File:** `packages/framework/src/types/llm.ts:2-4`
Remove the "Pre-ADR-0024" historical paragraph (lines 2-7). Keep line 1 and the remaining description.

### 6.2 Add JSDoc to `topoSort` in advanced.ts (Suggestion #29)

**File:** `packages/framework/src/advanced.ts:17`

```typescript
/**
 * Topological sort into parallel-executable waves. Returns `Result` on cycle.
 * Use when building custom schedulers or static DAG analyses.
 */
export { topoSort } from "./shared/topo.js";
```

### 6.3 Add paper title to citation (Suggestion #30)

**File:** `packages/framework/src/types/confidence.ts:7`

Change:
```
// well-documented to be miscalibrated (Tian et al. 2023)
```
To:
```
// well-documented to be miscalibrated (Tian et al., "Just Ask for Calibration", NeurIPS 2023)
```

### 6.4 Add BufferedObserver sweep test for unbounded growth (Suggestion #31)

**File:** Create `packages/framework/src/__tests__/buffered-observer-stale-sweep.test.ts`

Test that the sweep mechanism eventually clears buffers for runs that never emit `run-end`.

---

## Execution Order & Dependencies

```
Wave 1 (Critical)  ──────────── No dependencies
  ├── 1.1 bootstrap.ts writeCheckpoint
  ├── 1.2 OpenAI truncate error body
  ├── 1.3 bullmq/ioredis → peerDeps
  ├── 1.4 dagTransition type narrowing
  └── 1.5 evaluatePredicate → fail on throw

Wave 2 (Error handling) ──────── Depends on Wave 1.5 (predicate type change)
  ├── 2.1 scheduler markers.exists logging
  ├── 2.2 node-span OTel isolation
  ├── 2.3 llm-pipeline formatFrameworkError
  ├── 2.4 InMemoryFreshnessIndex dedup
  ├── 2.5 server.ts fingerprint in load()
  ├── 2.6 exports map enforcement
  └── 2.7 Result combinators (orElse, andThenAsync, mapAsync, tap/tapErr export)

Wave 3 (Architecture) ──────── Depends on Wave 2.7 (types/index.ts)
  ├── 3.1 Extract dispatchEvent
  ├── 3.2 Rename executor/executor.ts
  ├── 3.3 Split ContextCacheAdapter    ← depends on 1.1 (bootstrap writeCheckpoint)
  ├── 3.4 Fix ADR-0019 refs            ← depends on 3.2 (rename)
  └── 3.5 Fix ADR-0007 ref

Wave 4 (Tests) ──────────────── Depends on Waves 1-3 (interfaces changed)
  ├── 4.1 Redis failure tests
  └── 4.2 Tool execution failure tests

Wave 5 (Suggestions) ─────────── Depends on Wave 3.3 (cache split)
  ├── 5.1 deadlineMs on sendWithTools
  ├── 5.2 Pre-flight schema separation
  ├── 5.3 Tracing log.error
  ├── 5.4 confidence raw validation
  ├── 5.5 (done in 2.7)
  ├── 5.6 testing subpath
  └── 5.7 Memoize DagDef

Wave 6 (Comments) ────────────── Independent, run any time
  ├── 6.1 Remove stale comments
  ├── 6.2 topoSort JSDoc
  ├── 6.3 Citation fix
  └── 6.4 Sweep test
```

---

## Summary

| Wave | Items | Risk | Effort |
|------|-------|------|--------|
| 1 | 5 critical | High — fixing silent data loss + leakage | Medium |
| 2 | 7 important | Medium — error handling hardening | Small-Medium |
| 3 | 5 architecture | Medium — renames, splits, cleanup | Medium |
| 4 | 2 tests | Low — additive | Small |
| 5 | 7 suggestions | Low — polish | Small-Medium |
| 6 | 4 comments | None — cosmetic | Trivial |

**Total: 30 items across 6 waves.**
